import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EdgeTraffic, TopologyEdge, TopologyNode, TrafficPoint, TrafficSnapshot } from '../../../shared/types'
import { bridge, invoke } from '../lib/api'
import { filterGraph, type GraphFilter } from '../lib/graph-filter'
import { layoutGraph, layoutKey, type GraphDirection, type PlacedEdge, type PlacedGraph, type PlacedNode } from '../lib/graph-layout'
import { Empty } from './ui'

const number = new Intl.NumberFormat('es', { maximumFractionDigits: 1 })
const integer = new Intl.NumberFormat('es', { maximumFractionDigits: 0 })

export function formatRate(rate: number): string {
  if (rate === 0) return '0'
  if (rate < 0.1) return '<0,1'
  return number.format(rate)
}
export function formatPercent(ratio: number): string {
  const percent = ratio * 100
  if (percent === 0) return '0 %'
  if (percent < 0.1) return '<0,1 %'
  return `${number.format(percent)} %`
}
export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return ms >= 1000 ? `${number.format(ms / 1000)} s` : `${integer.format(ms)} ms`
}

const WARN_RATIO = 0.01
const BAD_RATIO = 0.05

export type Health = 'idle' | 'ok' | 'warn' | 'bad' | 'declared'

/** Salud de una conexión. El color nunca va solo: la etiqueta siempre muestra el porcentaje */
export function edgeHealth(edge: TopologyEdge): Health {
  if (!edge.observed) return 'declared'
  const traffic = edge.traffic
  if (!traffic || traffic.rate === 0) return 'idle'
  if (traffic.errorRatio >= BAD_RATIO) return 'bad'
  if (traffic.errorRatio >= WARN_RATIO) return 'warn'
  return 'ok'
}

/** Grosor según la tasa, en escala logarítmica: 0,1/s y 1000/s deben caber en el mismo dibujo */
const edgeWidth = (rate: number): number => (rate <= 0 ? 1.5 : Math.min(6, 2 + Math.log10(1 + rate * 10)))
/** Cuántas partículas y a qué ritmo. En escalones: cambiarlas reinicia la animación */
const particleCount = (rate: number): number => (rate <= 0 ? 0 : rate < 1 ? 1 : rate < 10 ? 2 : rate < 100 ? 3 : 4)
const particleDuration = (rate: number): number => (rate < 1 ? 4 : rate < 10 ? 2.8 : rate < 100 ? 2 : 1.4)

const KIND_LABEL: Record<TopologyEdge['kind'], string> = {
  route: 'Enrutamiento',
  selects: 'Selección de pods',
  declared: 'Dependencia declarada',
  invoke: 'Invocación de servicio',
  publish: 'Publicación',
  deliver: 'Entrega de eventos',
  component: 'Uso de componente'
}

const CATEGORY_LABEL: Record<string, string> = {
  pubsub: 'Broker de mensajes',
  state: 'Almacén de estado',
  bindings: 'Binding',
  secretstores: 'Almacén de secretos',
  configuration: 'Configuración',
  lock: 'Bloqueo distribuido',
  crypto: 'Criptografía',
  workflow: 'Workflow'
}

function NodeIcon({ node }: { node: TopologyNode }): ReactNode {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (node.kind) {
    case 'ingress':
      return <path {...common} d="M2 9h10M8.5 5.5 12 9l-3.5 3.5M15.5 3v12" />
    case 'service':
      return <g {...common}><circle cx="9" cy="9" r="2.4" /><circle cx="3.5" cy="4" r="1.5" /><circle cx="3.5" cy="14" r="1.5" /><circle cx="14.5" cy="9" r="1.5" /><path d="M4.7 5 7.2 7.4M4.7 13l2.5-2.4M11.4 9h1.6" /></g>
    case 'topic':
      return <path {...common} d="M6.5 3 5 15M13 3l-1.5 12M3 6.8h12.5M2.5 11.2H15" />
    case 'component':
      if (node.category === 'pubsub') return <g {...common}><circle cx="9" cy="9" r="1.6" /><path d="M5.3 12.7a5.2 5.2 0 0 1 0-7.4M12.7 5.3a5.2 5.2 0 0 1 0 7.4M3.1 14.9a8.4 8.4 0 0 1 0-11.8M14.9 3.1a8.4 8.4 0 0 1 0 11.8" /></g>
      if (node.category === 'state') return <g {...common}><ellipse cx="9" cy="4.5" rx="5.5" ry="2.2" /><path d="M3.5 4.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9M3.5 9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" /></g>
      return <path {...common} d="M6.5 2.5v4M11.5 2.5v4M4.5 6.5h9v3a4.5 4.5 0 0 1-9 0zM9 14v2" />
    default:
      return <path {...common} d="M9 2 15.2 5.5v7L9 16l-6.2-3.5v-7zM2.8 5.5 9 9l6.2-3.5M9 9v7" />
  }
}

/** Por debajo de este ancho, un diagrama de izquierda a derecha obligaría a reducirlo hasta no leerse */
const VERTICAL_BELOW_WIDTH = 820
/** Mejor desplazarse por el diagrama que no poder leerlo */
const MIN_FIT_SCALE = 0.55
const INSPECTOR_WIDTH = 350

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function GraphNodeView({
  placed,
  selected,
  dimmed,
  matched,
  throughput,
  onSelect,
  onHover
}: {
  placed: PlacedNode
  selected: boolean
  dimmed: boolean
  matched: boolean
  throughput?: number
  onSelect(): void
  onHover(hovering: boolean): void
}): ReactNode {
  const { node, x, y, width, height, container } = placed
  const unhealthy = node.pods && node.pods.desired > 0 && node.pods.ready < node.pods.desired
  const down = node.pods && node.pods.desired > 0 && node.pods.ready === 0
  const className = ['gnode', `gnode-${node.kind}`, selected ? 'selected' : '', dimmed ? 'dimmed' : '', matched ? 'matched' : '', container ? 'container' : ''].join(' ')
  const a11y = `${node.subtitle ?? node.kind} ${node.name}`
  const interaction = {
    role: 'button',
    tabIndex: 0,
    'aria-label': a11y,
    'data-node': node.name,
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      onSelect()
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect()
      }
    },
    onMouseEnter: () => onHover(true),
    onMouseLeave: () => onHover(false)
  }
  if (container) {
    // Medidas aproximadas de la fuente: mejor sin subtítulo (está en el panel) que pisando el nombre
    const subtitleFits = 35 + node.name.length * 8 + 12 + (node.subtitle?.length ?? 0) * 6.2 + 12 <= width
    return (
      <g className={className} transform={`translate(${x} ${y})`} {...interaction}>
        <title>{`${node.name} · ${node.subtitle ?? ''}`}</title>
        <rect className="gnode-box" width={width} height={height} rx={11} />
        <g className="gnode-icon" transform="translate(11 9)"><NodeIcon node={node} /></g>
        <text className="gnode-name" x={35} y={22}>{truncate(node.name, Math.floor((width - 50) / 8))}</text>
        {subtitleFits && <text className="gnode-sub" x={width - 12} y={22} textAnchor="end">{node.subtitle}</text>}
      </g>
    )
  }
  if (node.kind === 'topic') {
    return (
      <g className={className} transform={`translate(${x} ${y})`} {...interaction}>
        <title>{`Tema ${node.name}`}</title>
        <rect className="gnode-box" width={width} height={height} rx={18} />
        <g className="gnode-icon" transform="translate(10 9)"><NodeIcon node={node} /></g>
        <text className="gnode-name" x={33} y={23}>{truncate(node.name, 15)}</text>
      </g>
    )
  }
  return (
    <g className={className} transform={`translate(${x} ${y})`} {...interaction}>
      <title>{[node.name, node.subtitle, node.namespace && `namespace ${node.namespace}`].filter(Boolean).join(' · ')}</title>
      <rect className="gnode-box" width={width} height={height} rx={10} />
      <g className="gnode-icon" transform="translate(12 12)"><NodeIcon node={node} /></g>
      <text className="gnode-name" x={38} y={25}>{truncate(node.name, node.daprAppId ? 13 : 19)}</text>
      <text className="gnode-sub" x={38} y={45}>
        {truncate(
          [
            node.kind === 'component' ? (node.subtitle ?? '') : node.subtitle,
            node.pods ? `${node.pods.ready}/${node.pods.desired} pods` : undefined
          ].filter(Boolean).join(' · '),
          26
        )}
      </text>
      {node.daprAppId && (
        <g transform={`translate(${width - 48} 12)`}>
          <rect className="gnode-dapr" width={38} height={17} rx={8.5} />
          <text className="gnode-dapr-text" x={19} y={12.5} textAnchor="middle">dapr</text>
        </g>
      )}
      {unhealthy && (
        // Forma y texto además del color: el estado no depende solo del tono
        <g className={down ? 'gnode-alert bad' : 'gnode-alert warn'} transform={`translate(${width - 22} ${height - 22})`}>
          <path d="M8 1.5 15 14H1z" />
          <text x={8} y={12.2} textAnchor="middle">!</text>
          <title>{`${node.pods!.ready} de ${node.pods!.desired} pods listos`}</title>
        </g>
      )}
      {/* Con subtítulo largo no cabe, y la tasa ya está en cada conexión */}
      {throughput !== undefined && throughput > 0 && !unhealthy && !node.pods && (
        <text className="gnode-rate" x={width - 12} y={46} textAnchor="end">{formatRate(throughput)}/s</text>
      )}
    </g>
  )
}

function EdgeLabel({ placed, dimmed }: { placed: PlacedEdge; dimmed: boolean }): ReactNode {
  const traffic = placed.edge.traffic
  if (!traffic || traffic.rate === 0) return null
  const hasErrors = traffic.errorRatio >= WARN_RATIO
  // La marca, además del color: un error se reconoce sin distinguir tonos
  const text = `${hasErrors ? `▲ ${formatPercent(traffic.errorRatio)} · ` : ''}${formatRate(traffic.rate)}/s`
  const width = text.length * 6.3 + 14
  return (
    <g className={`edge-label ${dimmed ? 'dimmed' : ''}`} transform={`translate(${placed.labelX - width / 2} ${placed.labelY - 10})`} pointerEvents="none">
      <rect width={width} height={20} rx={10} />
      <text x={width / 2} y={14} textAnchor="middle">{text}</text>
    </g>
  )
}

function GraphEdgeView({ placed, selected, dimmed, animate, onSelect, onHover }: { placed: PlacedEdge; selected: boolean; dimmed: boolean; animate: boolean; onSelect(): void; onHover(hovering: boolean): void }): ReactNode {
  const { edge, path } = placed
  const health = edgeHealth(edge)
  const rate = edge.traffic?.rate ?? 0
  const width = edgeWidth(rate)
  const count = animate ? particleCount(rate) : 0
  const duration = particleDuration(rate)
  return (
    <g className={`gedge gedge-${health} ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''}`} data-edge={edge.id}>
      <path className="gedge-line" d={path} strokeWidth={selected ? width + 1 : width} markerEnd={`url(#arrow-${health})`} />
      {Array.from({ length: count }, (_, index) => (
        <circle key={index} className="gedge-particle" r={Math.max(2.5, width / 2 + 0.8)}>
          <animateMotion dur={`${duration}s`} repeatCount="indefinite" path={path} begin={`${-(index * duration) / count}s`} />
        </circle>
      ))}
      <path
        className="gedge-hit"
        d={path}
        role="button"
        tabIndex={0}
        aria-label={`${KIND_LABEL[edge.kind]}`}
        onClick={(event) => {
          event.stopPropagation()
          onSelect()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSelect()
        }}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
      />
    </g>
  )
}

const HEALTHS: Health[] = ['ok', 'warn', 'bad', 'idle', 'declared']

function GraphCanvas({
  graph,
  snapshotEdges,
  snapshotNodes,
  throughput,
  live,
  selectedId,
  search,
  onSelectNode,
  onSelectEdge,
  onClear
}: {
  graph: PlacedGraph
  snapshotEdges: Map<string, TopologyEdge>
  snapshotNodes: Map<string, TopologyNode>
  throughput: Map<string, number>
  /** En pausa no se anima: las partículas darían a entender que hay datos en vivo */
  live: boolean
  selectedId: string | null
  search: string
  onSelectNode(id: string): void
  onSelectEdge(id: string): void
  onClear(): void
}): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 })
  const [hover, setHover] = useState<string | null>(null)
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null)
  const reduced = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  /** El usuario movió la vista: a partir de ahí no se reencuadra sola */
  const touched = useRef(false)
  const dragged = useRef(false)

  const fit = useCallback(() => {
    const element = host.current
    // Una pestaña de clúster oculta mide cero
    if (!element || graph.width === 0 || element.clientWidth === 0) return
    const legend = element.querySelector<HTMLElement>('.graph-legend')?.offsetHeight ?? 0
    const [width, height] = [element.clientWidth - 32, element.clientHeight - legend - 40]
    const scale = Math.max(MIN_FIT_SCALE, Math.min(1.1, width / graph.width, height / graph.height))
    // Si no cabe ni al mínimo, se empieza por el principio del flujo, no por el medio
    const [drawnWidth, drawnHeight] = [graph.width * scale, graph.height * scale]
    setView({ scale, x: 16 + Math.max(0, (width - drawnWidth) / 2), y: 12 + Math.max(0, (height - drawnHeight) / 2) })
  }, [graph.width, graph.height])

  // Por separado del observador: este no entrega nada mientras la ventana no pinta
  useEffect(() => {
    if (!touched.current) fit()
  }, [fit])
  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [fit])
  useEffect(() => {
    const element = host.current
    if (!element) return
    // Pasiva por defecto en React: se registra a mano para poder impedir el desplazamiento de la página
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      touched.current = true
      const rect = element.getBoundingClientRect()
      const [px, py] = [event.clientX - rect.left, event.clientY - rect.top]
      setView((current) => {
        const scale = Math.min(2.5, Math.max(0.2, current.scale * Math.exp(-event.deltaY * 0.0015)))
        const ratio = scale / current.scale
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // El panel flota sobre el diagrama: lo seleccionado no debe quedar debajo
  useEffect(() => {
    const element = host.current
    if (!selectedId || !element) return
    const node = graph.nodes.find((placed) => placed.node.id === selectedId)
    const edge = graph.edges.find((placed) => placed.edge.id === selectedId)
    const x = node ? node.x + node.width / 2 : edge?.labelX
    if (x === undefined) return
    const limit = element.clientWidth - INSPECTOR_WIDTH - 30
    if (limit > 0) setView((current) => (current.x + x * current.scale > limit ? { ...current, x: limit - x * current.scale } : current))
    // Solo al cambiar la selección: después, la vista es del usuario
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const focus = hover ?? selectedId
  const neighbors = useMemo(() => {
    if (!focus) return null
    const ids = new Set<string>([focus])
    for (const { edge } of graph.edges) {
      if (edge.id === focus || edge.source === focus || edge.target === focus) {
        ids.add(edge.id)
        ids.add(edge.source)
        ids.add(edge.target)
      }
    }
    // Resaltar un broker incluye sus temas, y un tema, su broker
    for (const { node } of graph.nodes) {
      if (node.parent && ids.has(node.id)) ids.add(node.parent)
    }
    return ids
  }, [focus, graph])

  const needle = search.trim().toLowerCase()
  const zoomBy = (factor: number): void => {
    const element = host.current
    if (!element) return
    touched.current = true
    const [px, py] = [element.clientWidth / 2, element.clientHeight / 2]
    setView((current) => {
      const scale = Math.min(2.5, Math.max(0.2, current.scale * factor))
      const ratio = scale / current.scale
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
    })
  }

  // Los contenedores van detrás, para no tapar a sus hijos
  const ordered = graph.nodes
    .map((placed) => ({ ...placed, node: snapshotNodes.get(placed.node.id) ?? placed.node }))
    .sort((a, b) => Number(b.container) - Number(a.container))

  return (
    <div
      className="graph"
      ref={host}
      data-testid="graph"
      onMouseDown={(event) => {
        dragged.current = false
        drag.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y }
      }}
      onMouseMove={(event) => {
        const start = drag.current
        if (!start || event.buttons !== 1) return
        // Un clic con un temblor de ratón sigue siendo un clic
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4 && !dragged.current) return
        dragged.current = true
        touched.current = true
        setView((current) => ({ ...current, x: start.viewX + event.clientX - start.x, y: start.viewY + event.clientY - start.y }))
      }}
      onMouseUp={() => (drag.current = null)}
      onClickCapture={(event) => {
        // Soltar tras arrastrar no debe seleccionar ni deseleccionar
        if (dragged.current) {
          event.stopPropagation()
          dragged.current = false
        }
      }}
      onClick={onClear}
    >
      <svg width="100%" height="100%" role="img" aria-label="Mapa de comunicación entre microservicios">
        <defs>
          <pattern id="graph-dots" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <circle cx="1" cy="1" r="1" className="graph-dot" />
          </pattern>
          {HEALTHS.map((health) => (
            <marker key={health} id={`arrow-${health}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
              <path d="M1 1 9 5 1 9z" className={`arrow arrow-${health}`} />
            </marker>
          ))}
        </defs>
        <rect width="100%" height="100%" fill="url(#graph-dots)" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {graph.groups.map((group) => (
            <g key={group.label} className="ggroup">
              <rect x={group.x} y={group.y} width={group.width} height={group.height} rx={13} />
              <text x={group.x + 14} y={group.y + 22}>{group.label}</text>
            </g>
          ))}
          {ordered.filter((n) => n.container).map((placed) => (
            <GraphNodeView key={placed.node.id} placed={placed} selected={selectedId === placed.node.id} dimmed={Boolean(neighbors && !neighbors.has(placed.node.id))} matched={Boolean(needle && placed.node.name.toLowerCase().includes(needle))} onSelect={() => onSelectNode(placed.node.id)} onHover={(h) => setHover(h ? placed.node.id : null)} />
          ))}
          {graph.edges.map((placed) => {
            // La distribución se conserva entre lecturas; las métricas vienen de la última
            const edge = snapshotEdges.get(placed.edge.id) ?? placed.edge
            return <GraphEdgeView key={edge.id} placed={{ ...placed, edge }} selected={selectedId === edge.id} dimmed={Boolean(neighbors && !neighbors.has(edge.id))} animate={live && !reduced} onSelect={() => onSelectEdge(edge.id)} onHover={(h) => setHover(h ? edge.id : null)} />
          })}
          {ordered.filter((n) => !n.container).map((placed) => (
            <GraphNodeView key={placed.node.id} placed={placed} selected={selectedId === placed.node.id} dimmed={Boolean(neighbors && !neighbors.has(placed.node.id))} matched={Boolean(needle && placed.node.name.toLowerCase().includes(needle))} throughput={throughput.get(placed.node.id)} onSelect={() => onSelectNode(placed.node.id)} onHover={(h) => setHover(h ? placed.node.id : null)} />
          ))}
          {graph.edges.map((placed) => {
            const edge = snapshotEdges.get(placed.edge.id) ?? placed.edge
            return <EdgeLabel key={edge.id} placed={{ ...placed, edge }} dimmed={Boolean(neighbors && !neighbors.has(edge.id))} />
          })}
        </g>
      </svg>
      <div className="graph-zoom" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <button aria-label="Acercar" onClick={() => zoomBy(1.25)}>+</button>
        <button aria-label="Alejar" onClick={() => zoomBy(0.8)}>−</button>
        <button aria-label="Ajustar a la ventana" onClick={() => { touched.current = false; fit() }}>⤢</button>
      </div>
      <div className="graph-legend" aria-label="Leyenda">
        <span><i className="swatch swatch-ok" />Tráfico sano</span>
        <span><i className="swatch swatch-warn" />Errores ≥ 1 %</span>
        <span><i className="swatch swatch-bad" />Errores ≥ 5 %</span>
        <span><i className="swatch swatch-idle" />Medida, sin tráfico ahora</span>
        <span><i className="swatch swatch-declared" />Declarada, sin medir</span>
        <span className="dim legend-note">Grosor: peticiones por segundo</span>
      </div>
    </div>
  )
}

/** Línea de tasa con cruz de lectura. Una sola escala: total y errores miden lo mismo, peticiones por segundo */
export function RateChart({ history }: { history: TrafficPoint[] }): ReactNode {
  const [hover, setHover] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const [W, H, PAD] = [320, 88, 4]
  if (history.length < 2) return <p className="dim small">Reuniendo muestras…</p>
  const max = Math.max(...history.map((p) => p.rate), 0.1)
  const x = (i: number): number => (i / (history.length - 1)) * W
  const y = (value: number): number => H - PAD - (value / max) * (H - PAD * 2)
  const line = (select: (p: TrafficPoint) => number): string => history.map((p, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(select(p)).toFixed(1)}`).join(' ')
  const point = hover === null ? null : history[hover]
  const anyErrors = history.some((p) => p.errorRate > 0)
  return (
    <div className="rate-chart">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Tasa reciente: máximo ${formatRate(max)} por segundo`}
        onMouseMove={(event) => {
          const rect = ref.current!.getBoundingClientRect()
          setHover(Math.max(0, Math.min(history.length - 1, Math.round(((event.clientX - rect.left) / rect.width) * (history.length - 1)))))
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line className="chart-base" x1={0} x2={W} y1={H - PAD} y2={H - PAD} />
        <path className="chart-line" d={line((p) => p.rate)} />
        {anyErrors && <path className="chart-line errors" d={line((p) => p.errorRate)} />}
        {hover !== null && (
          <>
            <line className="chart-cross" x1={x(hover)} x2={x(hover)} y1={0} y2={H} />
            <circle className="chart-dot" cx={x(hover)} cy={y(history[hover].rate)} r={4} />
          </>
        )}
      </svg>
      <div className="chart-foot">
        {point ? (
          <span>{new Date(point.t * 1000).toLocaleTimeString('es')} · {formatRate(point.rate)}/s · {formatRate(point.errorRate)}/s con error</span>
        ) : (
          <>
            <span className="legend-item"><i className="line-key" />Total</span>
            {anyErrors && <span className="legend-item"><i className="line-key errors" />Errores</span>}
            <span className="dim">Máx. {formatRate(max)}/s</span>
          </>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }): ReactNode {
  return (
    <div className="stat">
      <div className="stat-value" data-tone={tone}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function TrafficDetails({ traffic }: { traffic: EdgeTraffic }): ReactNode {
  return (
    <>
      <div className="stats">
        <Stat label="por segundo" value={formatRate(traffic.rate)} />
        <Stat label="con error" value={formatPercent(traffic.errorRatio)} tone={traffic.errorRatio >= BAD_RATIO ? 'bad' : traffic.errorRatio >= WARN_RATIO ? 'warn' : undefined} />
        <Stat label="latencia p50" value={formatMs(traffic.p50Ms)} />
        <Stat label="latencia p95" value={formatMs(traffic.p95Ms)} />
      </div>
      <RateChart history={traffic.history} />
      {traffic.breakdown.length > 0 && (
        <table className="mini">
          <thead><tr><th>Resultado u operación</th><th className="right">por segundo</th></tr></thead>
          <tbody>
            {traffic.breakdown.map((row) => (
              <tr key={row.label}>
                <td>{row.error && <span className="warn-mark" aria-label="error">▲ </span>}{row.label}</td>
                <td className="right">{formatRate(row.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="dim small">Acumulado desde que arrancaron los sidecars: {integer.format(traffic.total)} ({integer.format(traffic.errors)} con error).</p>
    </>
  )
}

function Inspector({
  nodes,
  edges,
  selectedId,
  onSelect,
  onOpen,
  onClose
}: {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  selectedId: string
  onSelect(id: string): void
  onOpen(ref: NonNullable<TopologyNode['ref']>): void
  onClose(): void
}): ReactNode {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const nameOf = (id: string): string => nodeById.get(id)?.name ?? id
  const edge = edges.find((e) => e.id === selectedId)
  const node = nodeById.get(selectedId)
  if (!edge && !node) return null

  const head = (kicker: string, title: string): ReactNode => (
    <header className="details-head">
      <div>
        <div className="dim small">{kicker}</div>
        <h2>{title}</h2>
      </div>
      <button className="icon" aria-label="Cerrar panel" onClick={onClose}>✕</button>
    </header>
  )

  if (edge) {
    return (
      <aside className="inspector" aria-label="Detalle de la conexión" data-testid="inspector">
        {head(KIND_LABEL[edge.kind], `${nameOf(edge.source)} → ${nameOf(edge.target)}`)}
        <div className="inspector-body">
          {edge.traffic ? <TrafficDetails traffic={edge.traffic} /> : <p className="dim">Sin tráfico medido: esta conexión se conoce solo por la configuración.</p>}
          <dl className="props">
            <dt>Origen del dato</dt>
            <dd>{edge.observed ? 'Medido por los sidecars de Dapr' : 'Deducido de la configuración'}</dd>
            {edge.evidence && <><dt>Declarada en</dt><dd>{edge.evidence}</dd></>}
          </dl>
        </div>
      </aside>
    )
  }

  const incoming = edges.filter((e) => e.target === selectedId)
  const outgoing = edges.filter((e) => e.source === selectedId)
  const children = nodes.filter((n) => n.parent === selectedId)
  const links = (title: string, list: TopologyEdge[], other: (e: TopologyEdge) => string): ReactNode =>
    list.length > 0 && (
      <section className="detail-section">
        <h3>{title}</h3>
        <table className="mini">
          <tbody>
            {list.map((e) => (
              <tr key={e.id} onClick={() => onSelect(e.id)}>
                <td className="name">{nameOf(other(e))}</td>
                <td className="dim">{KIND_LABEL[e.kind]}</td>
                <td className="right">{e.traffic ? `${formatRate(e.traffic.rate)}/s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    )
  return (
    <aside className="inspector" aria-label="Detalle del nodo" data-testid="inspector">
      {head(node!.category ? (CATEGORY_LABEL[node!.category] ?? 'Componente de Dapr') : (node!.subtitle ?? ''), node!.name)}
      <div className="inspector-body">
        <dl className="props">
          {node!.namespace && <><dt>Namespace</dt><dd>{node!.namespace}</dd></>}
          {node!.daprAppId && <><dt>App ID de Dapr</dt><dd><code>{node!.daprAppId}</code></dd></>}
          {node!.category && <><dt>Tipo</dt><dd><code>{node!.subtitle}</code></dd></>}
          {node!.pods && <><dt>Pods</dt><dd>{node!.pods.ready} listos de {node!.pods.desired}</dd></>}
        </dl>
        {node!.ref && <button className="btn" onClick={() => onOpen(node!.ref!)}>Abrir {node!.ref.kind}</button>}
        {node!.services && (
          <section className="detail-section">
            <h3>Expuesto por</h3>
            <div className="chips">
              {node!.services.map((name) => <button key={name} className="chip chip-link" onClick={() => onOpen({ kind: 'Service', namespace: node!.namespace, name })}>{name}</button>)}
            </div>
          </section>
        )}
        {children.length > 0 && (
          <section className="detail-section">
            <h3>Temas</h3>
            <div className="chips">{children.map((c) => <button key={c.id} className="chip chip-link" onClick={() => onSelect(c.id)}>{c.name}</button>)}</div>
          </section>
        )}
        {links('Recibe de', incoming, (e) => e.source)}
        {links('Envía a', outgoing, (e) => e.target)}
      </div>
    </aside>
  )
}

function ConnectionsTable({ nodes, edges, onSelect }: { nodes: TopologyNode[]; edges: TopologyEdge[]; onSelect(id: string): void }): ReactNode {
  const nameOf = new Map(nodes.map((node) => [node.id, node.name]))
  const sorted = [...edges].sort((a, b) => (b.traffic?.rate ?? -1) - (a.traffic?.rate ?? -1) || a.id.localeCompare(b.id))
  return (
    <div className="plain-table connections" data-testid="connections">
      <table className="mini wide">
        <thead>
          <tr><th>Origen</th><th>Destino</th><th>Tipo</th><th className="right">por segundo</th><th className="right">Con error</th><th className="right">p50</th><th className="right">p95</th><th className="right">Acumulado</th></tr>
        </thead>
        <tbody>
          {sorted.map((edge) => (
            <tr key={edge.id} onClick={() => onSelect(edge.id)}>
              <td className="name">{nameOf.get(edge.source) ?? edge.source}</td>
              <td className="name">{nameOf.get(edge.target) ?? edge.target}</td>
              <td>{KIND_LABEL[edge.kind]}</td>
              <td className="right">{edge.traffic ? formatRate(edge.traffic.rate) : '—'}</td>
              <td className="right">{edge.traffic ? formatPercent(edge.traffic.errorRatio) : '—'}</td>
              <td className="right">{formatMs(edge.traffic?.p50Ms)}</td>
              <td className="right">{formatMs(edge.traffic?.p95Ms)}</td>
              <td className="right">{edge.traffic ? integer.format(edge.traffic.total) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ArchitecturePage({ contextId, namespaces, active, onOpen }: { contextId: string; namespaces: string[]; active: boolean; onOpen(ref: NonNullable<TopologyNode['ref']>): void }): ReactNode {
  const [snapshot, setSnapshot] = useState<TrafficSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [interval, setIntervalSeconds] = useState(10)
  const [paused, setPaused] = useState(false)
  const [mode, setMode] = useState<'graph' | 'table'>('graph')
  const [filter, setFilter] = useState<GraphFilter>({ showDeclared: true, onlyObserved: false, showSystem: false })
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graph, setGraph] = useState<PlacedGraph | null>(null)
  // Clave estable: un array nuevo con los mismos nombres no debe reiniciar la sesión de lectura
  const namespaceKey = JSON.stringify([...namespaces].sort())
  const [direction, setDirection] = useState<GraphDirection>('RIGHT')
  const mainArea = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = mainArea.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      // Oculta mide cero: se conserva la orientación que tenía
      if (element.clientWidth > 0) setDirection(element.clientWidth < VERTICAL_BELOW_WIDTH ? 'DOWN' : 'RIGHT')
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // Sin pantalla no hay lecturas: cada una pasa por el servidor de API del clúster
    if (paused || !active) return
    let cancelled = false
    let sessionId: string | undefined
    const early: TrafficSnapshot[] = []
    const unsubscribe = bridge.onTraffic((message) => {
      if (sessionId === undefined) early.push(message)
      else if (message.sessionId === sessionId) setSnapshot(message)
    })
    invoke('traffic:start', contextId, JSON.parse(namespaceKey) as string[], interval).then(
      (id) => {
        if (cancelled) {
          void invoke('traffic:stop', id)
          return
        }
        sessionId = id
        const pending = early.splice(0).filter((m) => m.sessionId === id).pop()
        if (pending) setSnapshot(pending)
      },
      (e: Error) => !cancelled && setError(e.message)
    )
    return () => {
      cancelled = true
      unsubscribe()
      if (sessionId) void invoke('traffic:stop', sessionId)
    }
  }, [contextId, namespaceKey, interval, paused, active])

  useEffect(() => {
    setSnapshot(null)
    setGraph(null)
    setSelectedId(null)
    setError(null)
  }, [contextId, namespaceKey])

  const visible = useMemo(() => (snapshot ? filterGraph(snapshot.nodes, snapshot.edges, filter, JSON.parse(namespaceKey) as string[]) : null), [snapshot, filter, namespaceKey])
  const key = visible ? layoutKey(visible.nodes, visible.edges) : ''
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  useEffect(() => {
    const current = visibleRef.current
    if (!current) return
    let cancelled = false
    layoutGraph(current.nodes, current.edges, direction).then(
      (placed) => !cancelled && setGraph(placed),
      (e: Error) => !cancelled && setError(`No se pudo calcular el diagrama: ${e.message}`)
    )
    return () => {
      cancelled = true
    }
  }, [key, direction])

  const edgeMap = useMemo(() => new Map((visible?.edges ?? []).map((edge) => [edge.id, edge])), [visible])
  const nodeMap = useMemo(() => new Map((visible?.nodes ?? []).map((node) => [node.id, node])), [visible])
  const throughput = useMemo(() => {
    const totals = new Map<string, number>()
    for (const edge of visible?.edges ?? []) {
      if (edge.traffic) totals.set(edge.target, (totals.get(edge.target) ?? 0) + edge.traffic.rate)
    }
    return totals
  }, [visible])

  const kpis = useMemo(() => {
    const edges = visible?.edges ?? []
    const rateOf = (kind: TopologyEdge['kind']): number => edges.filter((e) => e.kind === kind).reduce((sum, e) => sum + (e.traffic?.rate ?? 0), 0)
    const measured = edges.filter((e) => e.traffic)
    const rate = measured.reduce((sum, e) => sum + e.traffic!.rate, 0)
    const failing = measured.reduce((sum, e) => sum + e.traffic!.rate * e.traffic!.errorRatio, 0)
    return { invoke: rateOf('invoke'), publish: rateOf('publish'), ratio: rate > 0 ? failing / rate : 0, apps: (visible?.nodes ?? []).filter((n) => n.daprAppId).length }
  }, [visible])

  const coverage = snapshot?.coverage
  // Sin un solo sidecar leído no hay nada en vivo, aunque la arquitectura sí se actualice
  const measuring = (coverage?.scraped ?? 0) > 0
  return (
    <section className="architecture">
      <header className="toolbar">
        <h1>Arquitectura y tráfico</h1>
        {snapshot && (
          <span className={`live ${paused || !measuring ? 'paused' : ''}`} data-testid="live-state">
            <i />{paused ? 'En pausa' : !measuring ? 'Sin medición' : snapshot.warmingUp ? 'Midiendo…' : 'En vivo'}
          </span>
        )}
        <input className="search" aria-label="Buscar en el diagrama" placeholder="Buscar servicio" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="spacer" />
        <div className="segmented" role="group" aria-label="Vista">
          <button className={mode === 'graph' ? 'on' : ''} onClick={() => setMode('graph')}>Diagrama</button>
          <button className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Tabla</button>
        </div>
        <select aria-label="Frecuencia de lectura" value={interval} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
          <option value={5}>Cada 5 s</option>
          <option value={10}>Cada 10 s</option>
          <option value={30}>Cada 30 s</option>
        </select>
        <button className="btn" onClick={() => setPaused(!paused)}>{paused ? 'Reanudar' : 'Pausar'}</button>
      </header>
      <div className="arch-filters">
        <div className="stats inline" data-testid="kpis">
          <Stat label="invocaciones/s" value={formatRate(kpis.invoke)} />
          <Stat label="eventos publicados/s" value={formatRate(kpis.publish)} />
          <Stat label="con error" value={formatPercent(kpis.ratio)} tone={kpis.ratio >= BAD_RATIO ? 'bad' : kpis.ratio >= WARN_RATIO ? 'warn' : undefined} />
          <Stat label="apps con Dapr" value={String(kpis.apps)} />
          {coverage && coverage.sidecars > 0 && <Stat label="sidecars leídos" value={`${coverage.scraped}/${coverage.sidecars}`} tone={coverage.scraped < coverage.sidecars ? 'warn' : undefined} />}
        </div>
        <div className="spacer" />
        <label className="check"><input type="checkbox" checked={filter.onlyObserved} onChange={(e) => setFilter({ ...filter, onlyObserved: e.target.checked })} /> Solo con tráfico medido</label>
        <label className="check"><input type="checkbox" checked={filter.showDeclared} onChange={(e) => setFilter({ ...filter, showDeclared: e.target.checked })} /> Dependencias declaradas</label>
        <label className="check"><input type="checkbox" checked={filter.showSystem} onChange={(e) => setFilter({ ...filter, showSystem: e.target.checked })} /> Sistema</label>
      </div>
      {snapshot && !snapshot.daprInstalled && (
        <div className="arch-notice">Este clúster no tiene Dapr, así que el diagrama muestra solo la arquitectura declarada. El tráfico real se mide con los sidecars de Dapr.</div>
      )}
      {coverage && coverage.failures.length > 0 && (
        <div className="arch-notice warn" data-testid="coverage-warning">
          {measuring ? (
            <><strong>Lectura parcial:</strong> {coverage.failures.join(' · ')}. El tráfico mostrado puede estar por debajo del real.</>
          ) : (
            <><strong>No se puede medir el tráfico:</strong> {coverage.failures.join(' · ')}. Se muestra solo la arquitectura declarada.</>
          )}
        </div>
      )}
      {coverage?.truncated && <div className="arch-notice warn">Hay demasiados sidecars: solo se consultan {coverage.sidecars}. Filtra por namespace para ver el tráfico completo.</div>}
      {snapshot?.error && <div className="arch-notice warn">{snapshot.error}</div>}
      <div className="arch-main" ref={mainArea}>
        {error ? (
          <Empty title="No se pudo leer el clúster">{error}</Empty>
        ) : !snapshot || !graph ? (
          <Empty title="Leyendo la arquitectura…" />
        ) : graph.nodes.length === 0 ? (
          <Empty title="Nada que mostrar">{namespaces.length ? `${namespaces.length === 1 ? 'El namespace' : 'Los namespaces'} ${namespaces.join(', ')} no ${namespaces.length === 1 ? 'tiene' : 'tienen'} cargas de trabajo.` : 'Prueba a activar «Sistema» o cambia los filtros.'}</Empty>
        ) : mode === 'graph' ? (
          <GraphCanvas
            graph={graph}
            snapshotEdges={edgeMap}
            snapshotNodes={nodeMap}
            throughput={throughput}
            live={!paused && !snapshot.warmingUp}
            selectedId={selectedId}
            search={search}
            onSelectNode={setSelectedId}
            onSelectEdge={setSelectedId}
            onClear={() => setSelectedId(null)}
          />
        ) : (
          <ConnectionsTable nodes={visible?.nodes ?? []} edges={visible?.edges ?? []} onSelect={setSelectedId} />
        )}
        {visible && selectedId && <Inspector nodes={visible.nodes} edges={visible.edges} selectedId={selectedId} onSelect={setSelectedId} onOpen={onOpen} onClose={() => setSelectedId(null)} />}
      </div>
    </section>
  )
}
