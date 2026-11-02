import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ClusterMetrics, KubeObject, ResourceType } from '../../../shared/types'
import { invoke, useTick, useWatch } from '../lib/api'
import { columnsFor, type Column } from '../lib/catalog'
import { formatBytes, formatCpu } from '../lib/format'
import { Empty, useUi } from './ui'

const ROW_HEIGHT = 32

interface PrinterColumn {
  name: string
  jsonPath: string
}

/** Subconjunto de JSONPath de las columnas de un CRD: `.status.phase`, `.spec.items[0].name` */
export function readJsonPath(object: unknown, path: string): unknown {
  let current: unknown = object
  for (const segment of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

const CRD: ResourceType = {
  group: 'apiextensions.k8s.io',
  version: 'v1',
  plural: 'customresourcedefinitions',
  kind: 'CustomResourceDefinition',
  namespaced: false,
  verbs: [],
  shortNames: [],
  scalable: false
}

function usePrinterColumns(contextId: string, resource: ResourceType): Column[] {
  const [columns, setColumns] = useState<Column[]>([])
  const isCustom = !columnsFor(resource.kind).some((c) => c.title !== 'Edad') && resource.group.includes('.')
  useEffect(() => {
    setColumns([])
    if (!isCustom) return
    let cancelled = false
    invoke('resource:get', contextId, { resource: CRD, name: `${resource.plural}.${resource.group}` }).then(
      (crd) => {
        if (cancelled) return
        const version = (crd.spec?.versions ?? []).find((v: { name: string }) => v.name === resource.version)
        const printer: PrinterColumn[] = (version?.additionalPrinterColumns ?? []).filter((c: PrinterColumn) => c.name !== 'Age')
        setColumns(
          printer.map((c) => ({
            title: c.name,
            value: (object) => {
              const value = readJsonPath(object, c.jsonPath)
              return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
            }
          }))
        )
      },
      // Un APIService que no viene de un CRD no tiene definición que leer: se queda con las columnas genéricas
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [contextId, resource.group, resource.plural, resource.version, isCustom])
  return columns
}

function useMetricColumns(contextId: string, kind: string): Column[] {
  const [metrics, setMetrics] = useState<ClusterMetrics | null>(null)
  const wanted = kind === 'Pod' || kind === 'Node'
  useEffect(() => {
    if (!wanted) return
    let cancelled = false
    const load = (): void => {
      invoke('cluster:metrics', contextId).then((m) => !cancelled && setMetrics(m), () => undefined)
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [contextId, wanted])
  return useMemo(() => {
    if (!metrics?.available || !wanted) return []
    const usage =
      kind === 'Pod'
        ? new Map(metrics.pods.map((p) => [`${p.namespace}/${p.name}`, p]))
        : new Map(metrics.nodes.map((n) => [`/${n.name}`, n]))
    const of = (o: KubeObject) => usage.get(`${o.metadata.namespace ?? ''}/${o.metadata.name}`)
    return [
      { title: 'Uso CPU', value: (o) => { const m = of(o); return m ? formatCpu(m.cpuMillis) : '—' }, sort: (o) => of(o)?.cpuMillis ?? -1, width: '80px' },
      { title: 'Uso mem.', value: (o) => { const m = of(o); return m ? formatBytes(m.memoryBytes) : '—' }, sort: (o) => of(o)?.memoryBytes ?? -1, width: '90px' }
    ] satisfies Column[]
  }, [metrics, kind, wanted])
}

function matches(object: KubeObject, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  const { name, namespace, labels } = object.metadata
  return (
    name.toLowerCase().includes(needle) ||
    (namespace ?? '').toLowerCase().includes(needle) ||
    Object.entries(labels ?? {}).some(([k, v]) => `${k}=${v}`.toLowerCase().includes(needle))
  )
}

export function ResourceTable({
  contextId,
  resource,
  namespaces,
  readOnly,
  selected,
  onSelect,
  onCreate
}: {
  contextId: string
  resource: ResourceType
  /** Vacío: todos */
  namespaces: string[]
  readOnly: boolean
  selected?: KubeObject
  onSelect(object: KubeObject): void
  onCreate(): void
}): ReactNode {
  const { items, loading, stale, error } = useWatch(contextId, resource, namespaces)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ title: string; descending: boolean } | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(800)
  const scroller = useRef<HTMLDivElement>(null)
  const printer = usePrinterColumns(contextId, resource)
  const metricColumns = useMetricColumns(contextId, resource.kind)
  const { ask, toast } = useUi()
  useTick(15_000)

  useEffect(() => {
    setChecked(new Set())
    setQuery('')
    setSort(null)
    setScrollTop(0)
    scroller.current?.scrollTo(0, 0)
  }, [resource.plural, resource.group, namespaces.join()])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const columns = useMemo<Column[]>(() => {
    const base = columnsFor(resource.kind)
    const withPrinter = printer.length ? [...printer, base[base.length - 1]] : base
    if (metricColumns.length === 0) return withPrinter
    // El uso va justo antes de la edad, que siempre es la última columna
    return [...withPrinter.slice(0, -1), ...metricColumns, withPrinter[withPrinter.length - 1]]
  }, [resource.kind, printer, metricColumns])

  // Con varios namespaces la columna es imprescindible: es lo único que distingue dos objetos homónimos
  const showNamespace = resource.namespaced && namespaces.length !== 1
  const key = (o: KubeObject): string => o.metadata.uid ?? `${o.metadata.namespace}/${o.metadata.name}`

  const rows = useMemo(() => {
    const filtered = items.filter((o) => matches(o, query))
    const column = sort && columns.find((c) => c.title === sort.title)
    const value = (o: KubeObject): string | number => {
      if (sort?.title === 'Namespace') return o.metadata.namespace ?? ''
      if (!column) return o.metadata.name
      return column.sort?.(o) ?? column.value(o) ?? ''
    }
    const ordered = filtered.sort((a, b) => {
      const [x, y] = [value(a), value(b)]
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
      return order || a.metadata.name.localeCompare(b.metadata.name)
    })
    return sort?.descending ? ordered.reverse() : ordered
  }, [items, query, sort, columns])

  const toggleSort = (title: string): void =>
    setSort((current) => (current?.title === title ? { title, descending: !current.descending } : { title, descending: false }))

  const template = [
    '34px',
    'minmax(220px, 2fr)',
    ...(showNamespace ? ['160px'] : []),
    ...columns.map((c) => c.width ?? 'minmax(100px, 1fr)')
  ].join(' ')

  // Con el panel de detalles abierto las columnas no caben: la tabla se desplaza en vez de recortarlas
  const minWidth = 34 + 220 + (showNamespace ? 160 : 0) + columns.reduce((sum, c) => sum + (c.width ? parseInt(c.width, 10) : 100), 0) + (columns.length + 2) * 10 + 24

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 10)
  const visible = rows.slice(start, start + Math.ceil(viewport / ROW_HEIGHT) + 20)
  const canDelete = resource.verbs.includes('delete') && !readOnly

  const deleteChecked = async (): Promise<void> => {
    const targets = rows.filter((o) => checked.has(key(o)))
    if (targets.length === 0) return
    const word = `${targets.length} ${resource.plural}`
    const answer = await ask({
      title: `Eliminar ${word}`,
      danger: true,
      confirm: 'Eliminar',
      typeToConfirm: word,
      body: (
        <ul className="plain">
          {targets.slice(0, 12).map((o) => (
            <li key={key(o)}>
              <code>{o.metadata.namespace ? `${o.metadata.namespace}/` : ''}{o.metadata.name}</code>
            </li>
          ))}
          {targets.length > 12 && <li>y {targets.length - 12} más…</li>}
        </ul>
      )
    })
    if (!answer) return
    const results = await Promise.allSettled(
      targets.map((o) => invoke('resource:delete', contextId, { resource, namespace: o.metadata.namespace, name: o.metadata.name }, {}))
    )
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    setChecked(new Set())
    if (failed.length) toast(`${failed.length} no se pudieron eliminar: ${failed[0].reason.message}`, 'bad')
    else toast(`${targets.length} eliminados`)
  }

  return (
    <section className="table-page">
      <header className="toolbar">
        <h1>{resource.kind}</h1>
        <span className="count" data-testid="row-count">{rows.length}{rows.length !== items.length ? ` de ${items.length}` : ''}</span>
        {stale && <span className="badge warn" title={stale}>Reconectando…</span>}
        <input className="search" placeholder="Buscar por nombre, namespace o etiqueta" aria-label="Buscar" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="spacer" />
        {checked.size > 0 && canDelete && (
          <button className="btn danger" onClick={() => void deleteChecked()}>
            Eliminar {checked.size}
          </button>
        )}
        {resource.verbs.includes('create') && (
          <button className="btn primary" disabled={readOnly} onClick={onCreate}>
            Crear
          </button>
        )}
      </header>
      {error ? (
        <Empty title="No se pudo cargar">{error}</Empty>
      ) : loading ? (
        <Empty title="Cargando…" />
      ) : rows.length === 0 ? (
        <Empty title={items.length ? 'Sin coincidencias' : `No hay ${resource.plural}`}>
          {items.length === 0 && namespaces.length ? `en ${namespaces.length === 1 ? 'el namespace' : 'los namespaces'} ${namespaces.join(', ')}` : ''}
        </Empty>
      ) : null}
      <div className="grid-wrap" style={{ display: rows.length && !error ? undefined : 'none' }}>
      <div className="grid-head" style={{ gridTemplateColumns: template, minWidth }}>
        <span />
        <button onClick={() => toggleSort('')}>Nombre{(sort?.title ?? '') === '' && sort ? (sort.descending ? ' ↓' : ' ↑') : ''}</button>
        {showNamespace && <button onClick={() => toggleSort('Namespace')}>Namespace{sort?.title === 'Namespace' ? (sort.descending ? ' ↓' : ' ↑') : ''}</button>}
        {columns.map((c) => (
          <button key={c.title} onClick={() => toggleSort(c.title)}>
            {c.title}{sort?.title === c.title ? (sort.descending ? ' ↓' : ' ↑') : ''}
          </button>
        ))}
      </div>
      <div className="grid-body" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} style={{ minWidth }}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {visible.map((object, index) => {
            const id = key(object)
            return (
              <div
                key={id}
                role="row"
                className={`grid-row ${selected && key(selected) === id ? 'selected' : ''}`}
                style={{ gridTemplateColumns: template, top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={() => onSelect(object)}
              >
                <span onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar ${object.metadata.name}`}
                    checked={checked.has(id)}
                    onChange={(e) =>
                      setChecked((current) => {
                        const next = new Set(current)
                        if (e.target.checked) next.add(id)
                        else next.delete(id)
                        return next
                      })
                    }
                  />
                </span>
                <span className="cell name" title={object.metadata.name}>{object.metadata.name}</span>
                {showNamespace && <span className="cell dim">{object.metadata.namespace}</span>}
                {columns.map((c) => {
                  const value = c.value(object)
                  return (
                    <span key={c.title} className={`cell ${c.mono ? 'mono' : ''} ${c.tone?.(object) ?? ''}`} title={value === undefined ? '' : String(value)}>
                      {value === undefined || value === '' ? '—' : value}
                    </span>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      </div>
    </section>
  )
}
