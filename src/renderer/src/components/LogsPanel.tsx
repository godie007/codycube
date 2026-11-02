import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { KubeObject, LogLine, LogMessage } from '../../../shared/types'
import { bridge, invoke } from '../lib/api'
import { useUi } from './ui'

const MAX_LINES = 50_000
const LINE_HEIGHT = 18
// Secuencias de color de la terminal: en una tabla de texto plano solo ensucian
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

const POD_COLORS = ['#6fd3c7', '#e8b35a', '#9ab8f5', '#e58fb1', '#a6d189', '#d4a5f0', '#7cc7e8', '#f0a58c']

const containersOf = (pod: KubeObject): string[] =>
  [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].map((c: { name: string }) => c.name)

export function LogsPanel({ contextId, object, active }: { contextId: string; object: KubeObject; active: boolean }): ReactNode {
  const { toast, run } = useUi()
  const [pods, setPods] = useState<KubeObject[]>([])
  const [podFilter, setPodFilter] = useState('*')
  const [containerFilter, setContainerFilter] = useState('*')
  const [tailLines, setTailLines] = useState(500)
  const [previous, setPrevious] = useState(false)
  const [showTime, setShowTime] = useState(false)
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [generation, setGeneration] = useState(0)
  const [problems, setProblems] = useState<string[]>([])
  const [ended, setEnded] = useState(0)
  const [revision, setRevision] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(300)
  const lines = useRef<LogLine[]>([])
  const scroller = useRef<HTMLDivElement>(null)

  const namespace = object.metadata.namespace!

  useEffect(() => {
    let cancelled = false
    invoke('resource:pods-for', contextId, object).then(
      (list) => {
        if (cancelled) return
        setPods(list)
        if (list.length === 0) setProblems(['No hay pods para este objeto'])
      },
      (error: Error) => !cancelled && setProblems([error.message])
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextId, object.metadata.uid, generation])

  const allContainers = useMemo(() => [...new Set(pods.flatMap(containersOf))], [pods])
  const defaultContainers = useCallback(
    (pod: KubeObject): string[] => {
      const running = (pod.spec?.containers ?? []).map((c: { name: string }) => c.name)
      if (containerFilter === '*') return running
      return containersOf(pod).filter((c) => c === containerFilter)
    },
    [containerFilter]
  )

  useEffect(() => {
    if (pods.length === 0) return
    lines.current = []
    setProblems([])
    setEnded(0)
    setRevision((value) => value + 1)
    const selection = pods
      .filter((pod) => podFilter === '*' || pod.metadata.name === podFilter)
      .map((pod) => ({ name: pod.metadata.name, containers: defaultContainers(pod) }))
      .filter((pod) => pod.containers.length > 0)
    let streamId: string | undefined
    let cancelled = false
    const early: LogMessage[] = []
    const handle = (message: LogMessage): void => {
      if (message.kind === 'lines') {
        lines.current.push(...message.lines)
        if (lines.current.length > MAX_LINES) lines.current = lines.current.slice(-MAX_LINES)
        setRevision((value) => value + 1)
      } else {
        setEnded((value) => value + 1)
        if (message.error) setProblems((list) => [...list, `${message.source}: ${message.error}`])
      }
    }
    const unsubscribe = bridge.onLogs((message) => {
      if (streamId === undefined) early.push(message)
      else if (message.streamId === streamId) handle(message)
    })
    invoke('logs:start', contextId, { namespace, pods: selection, tailLines, previous }).then(
      (id) => {
        if (cancelled) {
          void invoke('logs:stop', id)
          return
        }
        streamId = id
        for (const message of early.splice(0)) if (message.streamId === id) handle(message)
      },
      (error: Error) => setProblems([error.message])
    )
    return () => {
      cancelled = true
      unsubscribe()
      if (streamId) void invoke('logs:stop', streamId)
    }
  }, [contextId, namespace, pods, podFilter, defaultContainers, tailLines, previous])

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewport(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const multiPod = pods.length > 1 && podFilter === '*'
  const colorOf = useMemo(() => new Map(pods.map((pod, index) => [pod.metadata.name, POD_COLORS[index % POD_COLORS.length]])), [pods])

  const visibleLines = useMemo(() => {
    // Con varias fuentes los lotes llegan intercalados: la marca de tiempo da el orden real
    const sorted = multiPod || containerFilter === '*' ? [...lines.current].sort((a, b) => ((a.time ?? '') < (b.time ?? '') ? -1 : (a.time ?? '') > (b.time ?? '') ? 1 : 0)) : lines.current
    if (!filter) return sorted
    const needle = filter.toLowerCase()
    return sorted.filter((line) => line.text.toLowerCase().includes(needle))
    // `revision` cambia cada vez que llegan líneas, que viven en una referencia
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, filter, multiPod, containerFilter])

  useEffect(() => {
    if (follow && active && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [visibleLines, follow, active])

  const save = async (): Promise<void> => {
    const content = visibleLines.map((line) => `${line.time ?? ''} ${multiPod ? `[${line.pod}] ` : ''}${line.text}`).join('\n')
    const path = await run(() => invoke('logs:save', `${object.metadata.name}.log`, content))
    if (path) toast(`Guardado en ${path}`)
  }

  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - 20)
  const slice = visibleLines.slice(start, start + Math.ceil(viewport / LINE_HEIGHT) + 40)

  return (
    <div className="logs">
      <div className="logs-bar">
        {pods.length > 1 && (
          <select aria-label="Pod" value={podFilter} onChange={(e) => setPodFilter(e.target.value)}>
            <option value="*">Todos los pods ({pods.length})</option>
            {pods.map((pod) => (
              <option key={pod.metadata.name} value={pod.metadata.name}>{pod.metadata.name}</option>
            ))}
          </select>
        )}
        <select aria-label="Contenedor" value={containerFilter} onChange={(e) => setContainerFilter(e.target.value)}>
          <option value="*">Todos los contenedores</option>
          {allContainers.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <select aria-label="Líneas previas" value={tailLines} onChange={(e) => setTailLines(Number(e.target.value))}>
          {[100, 500, 1000, 5000, 20000].map((n) => (
            <option key={n} value={n}>Últimas {n}</option>
          ))}
        </select>
        <label className="check"><input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> Ejecución anterior</label>
        <label className="check"><input type="checkbox" checked={showTime} onChange={(e) => setShowTime(e.target.checked)} /> Hora</label>
        <input className="search" aria-label="Filtrar registros" placeholder="Filtrar líneas" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="dim small" data-testid="log-count">{visibleLines.length} líneas</span>
        <div className="spacer" />
        <button className={follow ? 'btn primary' : 'btn'} onClick={() => setFollow(!follow)}>{follow ? 'Siguiendo' : 'Seguir'}</button>
        {ended > 0 && !previous && <button className="btn" onClick={() => setGeneration((g) => g + 1)}>Reanudar</button>}
        <button className="btn" onClick={() => void save()}>Descargar</button>
      </div>
      {problems.length > 0 && <div className="logs-problems">{problems.slice(0, 4).map((p) => <div key={p}>{p}</div>)}</div>}
      <div
        className="logs-body"
        ref={scroller}
        data-testid="log-body"
        onScroll={(e) => {
          const element = e.currentTarget
          setScrollTop(element.scrollTop)
          // Subir para leer pausa el seguimiento; volver al final lo reanuda
          setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < LINE_HEIGHT * 2)
        }}
      >
        <div style={{ height: visibleLines.length * LINE_HEIGHT, position: 'relative', minWidth: 'max-content' }}>
          {slice.map((line, index) => (
            <div key={start + index} className="log-line" style={{ top: (start + index) * LINE_HEIGHT, height: LINE_HEIGHT }}>
              {showTime && line.time && <span className="log-time">{line.time.slice(0, 23).replace('T', ' ')} </span>}
              {multiPod && <span style={{ color: colorOf.get(line.pod) }}>{line.pod} </span>}
              {line.text.replace(ANSI, '')}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
