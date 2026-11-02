import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ClusterContext, ClusterInfo, KubeObject, ResourceType } from '../../../shared/types'
import { invoke, useWatch } from '../lib/api'
import { SIDEBAR, customResourceGroups, findResource, type SidebarEntry } from '../lib/catalog'
import { ArchitecturePage } from './Architecture'
import { Details, type DetailActions } from './Details'
import { NamespacePicker } from './NamespacePicker'
import { ForwardsPage, HelmPage } from './ExtraPages'
import { LogsPanel } from './LogsPanel'
import { Overview } from './Overview'
import { ResourceTable } from './ResourceTable'
import { TerminalPanel } from './TerminalPanel'
import { Empty, useUi } from './ui'
import { ApplyPanel, EditPanel } from './YamlPanel'
import { DataPanel, type DataMode } from './DataPanel'

type Page = { page: 'overview' | 'architecture' | 'helm' | 'forwards' } | { resource: ResourceType }

type DockTab =
  | { id: string; title: string; type: 'logs'; object: KubeObject }
  | { id: string; title: string; type: 'terminal'; namespace: string; pod: string; container: string }
  | { id: string; title: string; type: 'edit'; object: KubeObject; resource: ResourceType }
  | { id: string; title: string; type: 'apply'; template?: string }
  | { id: string; title: string; type: 'data'; mode: DataMode }

/** Una pestaña por abrir: el id es opcional, y si se repite se reutiliza la pestaña existente */
type NewTab = DockTab extends infer T ? (T extends DockTab ? Omit<T, 'id'> & { id?: string } : never) : never

const NAMESPACE_KEY = (id: string): string => `codycube.namespace.${id}`

/** Antes se guardaba un único nombre; ahora una lista. Se aceptan los dos formatos */
function readNamespaces(contextId: string, fallback?: string): string[] {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(NAMESPACE_KEY(contextId))
  } catch {
    // Sin almacenamiento se empieza por el namespace del contexto
  }
  if (saved === null) return fallback ? [fallback] : []
  try {
    const parsed: unknown = JSON.parse(saved)
    if (Array.isArray(parsed)) return parsed.filter((n): n is string => typeof n === 'string')
  } catch {
    // Formato anterior: el nombre tal cual
  }
  return saved ? [saved] : []
}

export function ClusterView({ context, info, visible }: { context: ClusterContext; info: ClusterInfo; visible: boolean }): ReactNode {
  const resources = info.resources
  const [page, setPage] = useState<Page>({ page: 'overview' })
  const [namespaces, setNamespaces] = useState(() => readNamespaces(context.id, context.namespace))
  const [selected, setSelected] = useState<{ object: KubeObject; resource: ResourceType } | null>(null)
  const [tabs, setTabs] = useState<DockTab[]>([])
  const [activeTab, setActiveTab] = useState<string | null>(null)
  const [dockOpen, setDockOpen] = useState(true)
  const [dockHeight, setDockHeight] = useState(340)
  const [readOnly, setReadOnly] = useState(context.readOnly)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { run, toast } = useUi()
  const nextTab = useRef(1)

  const namespaceResource = resources.find((r) => r.kind === 'Namespace')
  const namespaceList = useWatch(context.id, namespaceResource)
  const custom = useMemo(() => customResourceGroups(resources), [resources])

  // Un solo namespace elegido sirve de valor por defecto al crear o instalar
  const single = namespaces.length === 1 ? namespaces[0] : undefined
  const toggle = (title: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })

  const openTab = useCallback((tab: NewTab) => {
    const id = tab.id ?? `tab-${nextTab.current++}`
    setTabs((current) => (current.some((t) => t.id === id) ? current : [...current, { ...tab, id } as DockTab]))
    setActiveTab(id)
    setDockOpen(true)
  }, [])

  /** Sustituye una pestaña por otra en el mismo sitio, p. ej. «Nuevo Secret» por la edición del creado */
  const replaceTab = (id: string, tab: DockTab): void => {
    setTabs((current) => (current.some((t) => t.id === tab.id) ? current.filter((t) => t.id !== id) : current.map((t) => (t.id === id ? tab : t))))
    setActiveTab(tab.id)
  }

  const closeTab = (id: string): void => {
    setTabs((current) => {
      const next = current.filter((t) => t.id !== id)
      if (activeTab === id) setActiveTab(next.length ? next[next.length - 1].id : null)
      return next
    })
  }

  const navigate = useCallback(
    async (kind: string, ns: string | undefined, name: string) => {
      const resource = resources.find((r) => r.kind === kind)
      if (!resource) {
        toast(`Este clúster no sirve el tipo ${kind}`, 'bad')
        return
      }
      const object = await run(() => invoke('resource:get', context.id, { resource, namespace: ns, name }))
      if (!object) return
      setPage({ resource })
      setSelected({ object, resource })
    },
    [context.id, resources, run, toast]
  )

  const actions: DetailActions = useMemo(
    () => ({
      logs: (object) => openTab({ id: `logs-${object.metadata.uid}`, type: 'logs', title: `Registros: ${object.metadata.name}`, object }),
      shell: (pod, container) =>
        openTab({ type: 'terminal', title: `Terminal: ${pod.metadata.name}`, namespace: pod.metadata.namespace!, pod: pod.metadata.name, container }),
      edit: (object, resource) => openTab({ id: `edit-${object.metadata.uid}`, type: 'edit', title: `YAML: ${object.metadata.name}`, object, resource }),
      editData: (object, resource) => openTab({ id: `data-${object.metadata.uid}`, type: 'data', title: `Datos: ${object.metadata.name}`, mode: { kind: 'edit', object, resource } }),
      navigate: (kind, ns, name) => void navigate(kind, ns, name)
    }),
    [navigate, openTab]
  )

  // Si el objeto seleccionado cambia en el clúster, los detalles deben reflejarlo
  const liveList = useWatch(context.id, selected?.resource, selected?.object.metadata.namespace)
  const seenUid = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!selected) {
      // Sin esto, reabrir el mismo objeto parecería una eliminación: ya «estuvo» y la lista aún está vacía
      seenUid.current = undefined
      return
    }
    if (liveList.loading) return
    const uid = selected.object.metadata.uid
    const fresh = liveList.items.find((item) => item.metadata.uid === uid)
    if (fresh) {
      seenUid.current = uid
      if (fresh.metadata.resourceVersion !== selected.object.metadata.resourceVersion) {
        setSelected({ object: fresh, resource: selected.resource })
      }
    } else if (seenUid.current === uid) {
      // Ya estuvo en la lista en vivo y desapareció: lo eliminaron
      setSelected(null)
    }
  }, [liveList.items, liveList.loading, selected])

  const activeEntry = (entry: SidebarEntry): boolean =>
    entry.page ? 'page' in page && page.page === entry.page : 'resource' in page && page.resource.kind === entry.kind

  const startResize = (event: React.MouseEvent): void => {
    const startY = event.clientY
    const startHeight = dockHeight
    const move = (e: MouseEvent): void => setDockHeight(Math.max(140, Math.min(window.innerHeight - 180, startHeight + startY - e.clientY)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const namesList = namespaceList.items.map((n) => n.metadata.name).sort()
  const createTemplate = 'resource' in page ? page.resource.kind : undefined

  return (
    <div className="cluster" style={{ display: visible ? undefined : 'none' }}>
      <nav className="sidebar" aria-label="Recursos">
        <div className="cluster-name" title={context.server}>{context.name}</div>
        <div className="namespace-select">
          <span>Namespaces</span>
          <NamespacePicker
            names={namesList}
            selected={namespaces}
            onChange={(next) => {
              setNamespaces(next)
              setSelected(null)
              try {
                localStorage.setItem(NAMESPACE_KEY(context.id), JSON.stringify(next))
              } catch {
                // Sin almacenamiento solo se pierde el recuerdo del filtro
              }
            }}
          />
        </div>
        <div className="sidebar-scroll">
          {SIDEBAR.map((section) => {
            const entries = section.entries.filter((entry) => entry.page || findResource(resources, entry))
            if (entries.length === 0) return null
            return (
              <div key={section.title} className="side-section">
                <button className="side-title" onClick={() => toggle(section.title)} aria-expanded={!collapsed.has(section.title)}>
                  {section.title}
                </button>
                {!collapsed.has(section.title) &&
                  entries.map((entry) => (
                    <button
                      key={entry.label}
                      className={`side-item ${activeEntry(entry) ? 'active' : ''}`}
                      onClick={() => {
                        setSelected(null)
                        if (entry.page) setPage({ page: entry.page })
                        else setPage({ resource: findResource(resources, entry)! })
                      }}
                    >
                      {entry.label}
                    </button>
                  ))}
              </div>
            )
          })}
          {custom.length > 0 && (
            <div className="side-section">
              <button className="side-title" onClick={() => toggle('custom')} aria-expanded={!collapsed.has('custom')}>
                Recursos personalizados
              </button>
              {!collapsed.has('custom') &&
                custom.map(({ group, resources: list }) => (
                  <div key={group} className="side-group">
                    <div className="side-group-name" title={group}>{group}</div>
                    {list.map((resource) => (
                      <button
                        key={resource.plural}
                        className={`side-item ${'resource' in page && page.resource.plural === resource.plural && page.resource.group === group ? 'active' : ''}`}
                        onClick={() => {
                          setSelected(null)
                          setPage({ resource })
                        }}
                      >
                        {resource.kind}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          )}
        </div>
        <label className="readonly-toggle" title="Bloquea desde el proceso principal cualquier cambio en este clúster">
          <input
            type="checkbox"
            checked={readOnly}
            onChange={(e) => {
              const value = e.target.checked
              setReadOnly(value)
              void run(() => invoke('config:set-read-only', context.id, value))
            }}
          />
          Solo lectura
        </label>
      </nav>

      <main className="workspace">
        <div className="content">
          <div className="content-main">
            {'page' in page && page.page === 'overview' && (
              <Overview
                contextId={context.id}
                info={info}
                namespaces={namespaces}
                resources={resources}
                onOpen={(kind, object) => {
                  const resource = resources.find((r) => r.kind === kind)!
                  setPage({ resource })
                  setSelected({ object, resource })
                }}
              />
            )}
            {'page' in page && page.page === 'architecture' && (
              <ArchitecturePage contextId={context.id} namespaces={namespaces} active={visible} onOpen={(ref) => void navigate(ref.kind, ref.namespace, ref.name)} />
            )}
            {'page' in page && page.page === 'helm' && <HelmPage contextId={context.id} namespaces={namespaces} readOnly={readOnly} />}
            {'page' in page && page.page === 'forwards' && <ForwardsPage contextId={context.id} />}
            {'resource' in page && (
              <ResourceTable
                contextId={context.id}
                resource={page.resource}
                namespaces={page.resource.namespaced ? namespaces : []}
                readOnly={readOnly}
                selected={selected?.object}
                onSelect={(object) => setSelected({ object, resource: page.resource })}
                onCreate={() =>
                  page.resource.group === '' && (page.resource.kind === 'Secret' || page.resource.kind === 'ConfigMap')
                    ? openTab({ id: `create-${page.resource.kind}`, type: 'data', title: `Nuevo ${page.resource.kind}`, mode: { kind: 'create', resource: page.resource, namespace: single } })
                    : openTab({ type: 'apply', title: 'Crear recurso', template: createTemplate })
                }
              />
            )}
          </div>
          {selected && (
            <Details
              key={selected.object.metadata.uid}
              contextId={context.id}
              object={selected.object}
              resource={selected.resource}
              readOnly={readOnly}
              actions={actions}
              onClose={() => setSelected(null)}
              onOpenPod={(pod) => {
                const resource = resources.find((r) => r.kind === 'Pod')!
                setSelected({ object: pod, resource })
              }}
            />
          )}
        </div>
        {tabs.length > 0 && (
          <div className="dock" style={{ height: dockOpen ? dockHeight : 34 }}>
            {dockOpen && <div className="dock-resizer" onMouseDown={startResize} />}
            <div className="dock-tabs" role="tablist">
              {tabs.map((tab) => (
                <div key={tab.id} role="tab" aria-selected={tab.id === activeTab} className={`dock-tab ${tab.id === activeTab ? 'active' : ''}`} onClick={() => { setActiveTab(tab.id); setDockOpen(true) }}>
                  <span>{tab.title}</span>
                  <button aria-label={`Cerrar ${tab.title}`} onClick={(e) => { e.stopPropagation(); closeTab(tab.id) }}>✕</button>
                </div>
              ))}
              <div className="spacer" />
              <button className="icon" aria-label={dockOpen ? 'Minimizar panel' : 'Abrir panel'} onClick={() => setDockOpen(!dockOpen)}>{dockOpen ? '▾' : '▴'}</button>
            </div>
            <div className="dock-body" style={{ display: dockOpen ? undefined : 'none' }}>
              {tabs.map((tab) => (
                <div key={tab.id} className="dock-pane" style={{ display: tab.id === activeTab ? undefined : 'none' }}>
                  {tab.type === 'logs' && <LogsPanel contextId={context.id} object={tab.object} active={tab.id === activeTab} />}
                  {tab.type === 'terminal' && (
                    <TerminalPanel contextId={context.id} namespace={tab.namespace} pod={tab.pod} container={tab.container} active={tab.id === activeTab && visible} />
                  )}
                  {tab.type === 'edit' && <EditPanel contextId={context.id} object={tab.object} resource={tab.resource} readOnly={readOnly} />}
                  {tab.type === 'apply' && <ApplyPanel contextId={context.id} namespace={single} initialTemplate={tab.template} readOnly={readOnly} />}
                  {tab.type === 'data' && (
                    <DataPanel
                      contextId={context.id}
                      mode={tab.mode}
                      readOnly={readOnly}
                      onUseYaml={() => replaceTab(tab.id, { id: `tab-${nextTab.current++}`, type: 'apply', title: 'Crear recurso', template: tab.mode.resource.kind })}
                      onCreated={(object, resource) => {
                        setSelected({ object, resource })
                        replaceTab(tab.id, { id: `data-${object.metadata.uid}`, type: 'data', title: `Datos: ${object.metadata.name}`, mode: { kind: 'edit', object, resource } })
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
      {resources.length === 0 && <Empty title="El clúster no anunció ningún recurso" />}
    </div>
  )
}
