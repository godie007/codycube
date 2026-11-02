import ELK from 'elkjs/lib/elk.bundled.js'
import type { TopologyEdge, TopologyNode } from '../../../shared/types'

export type GraphDirection = 'RIGHT' | 'DOWN'

export const NODE_WIDTH = 196
export const NODE_HEIGHT = 62
export const TOPIC_WIDTH = 160
export const TOPIC_HEIGHT = 36
const CONTAINER_TOP = 36

export interface PlacedNode {
  node: TopologyNode
  x: number
  y: number
  width: number
  height: number
  /** Tiene hijos: se dibuja como contenedor */
  container: boolean
}

export interface PlacedGroup {
  label: string
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedEdge {
  edge: TopologyEdge
  /** Trazado SVG con esquinas redondeadas */
  path: string
  /** Punto medio del tramo más largo: ahí va la etiqueta */
  labelX: number
  labelY: number
}

export interface PlacedGraph {
  nodes: PlacedNode[]
  groups: PlacedGroup[]
  edges: PlacedEdge[]
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/** Convierte un recorrido ortogonal en un trazado con esquinas redondeadas */
export function roundedPath(points: Point[], radius = 9): string {
  if (points.length < 2) return ''
  let path = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [previous, corner, next] = [points[i - 1], points[i], points[i + 1]]
    const before = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const after = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, before / 2, after / 2)
    if (r < 0.5) {
      path += ` L ${corner.x} ${corner.y}`
      continue
    }
    const start = { x: corner.x + ((previous.x - corner.x) / before) * r, y: corner.y + ((previous.y - corner.y) / before) * r }
    const end = { x: corner.x + ((next.x - corner.x) / after) * r, y: corner.y + ((next.y - corner.y) / after) * r }
    path += ` L ${start.x} ${start.y} Q ${corner.x} ${corner.y} ${end.x} ${end.y}`
  }
  const last = points[points.length - 1]
  return `${path} L ${last.x} ${last.y}`
}

/** Punto medio del tramo más largo: el lugar con más aire para una etiqueta */
export function longestSegmentMiddle(points: Point[]): Point {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0 }
  let longest = -1
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (length > longest) {
      longest = length
      best = { x: (points[i].x + points[i - 1].x) / 2, y: (points[i].y + points[i - 1].y) / 2 }
    }
  }
  return best
}

/** Cambia solo si cambia lo que se dibuja: con ella se decide si hay que recalcular la distribución */
export function layoutKey(nodes: TopologyNode[], edges: TopologyEdge[]): string {
  return JSON.stringify([nodes.map((node) => node.id).sort(), edges.map((edge) => edge.id).sort()])
}

interface ElkNode {
  id: string
  width?: number
  height?: number
  x?: number
  y?: number
  children?: ElkNode[]
  layoutOptions?: Record<string, string>
  labels?: { text: string }[]
}

const elk = new ELK()

/** Distribuye por capas siguiendo el sentido en que viaja el tráfico: a lo ancho, o hacia abajo si no cabe */
export async function layoutGraph(nodes: TopologyNode[], edges: TopologyEdge[], direction: GraphDirection = 'RIGHT'): Promise<PlacedGraph> {
  // Orden fijo de entrada: mismo grafo, misma distribución
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id))
  const sortedEdges = [...edges].sort((a, b) => a.id.localeCompare(b.id))
  const namespaces = [...new Set(sorted.map((node) => node.namespace ?? ''))]
  const grouped = namespaces.length > 1
  const childrenOf = new Map<string, TopologyNode[]>()
  for (const node of sorted) if (node.parent) childrenOf.set(node.parent, [...(childrenOf.get(node.parent) ?? []), node])

  const containerOptions = {
    'elk.padding': `[top=${CONTAINER_TOP},left=12,bottom=12,right=12]`,
    // Debe caber el título aunque dentro solo haya un tema
    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
    'elk.nodeSize.minimum': `(${NODE_WIDTH + 24},60)`
  }
  const toElk = (node: TopologyNode): ElkNode => {
    const children = childrenOf.get(node.id)
    if (children?.length) return { id: node.id, children: children.map(toElk), layoutOptions: containerOptions }
    return node.kind === 'topic' ? { id: node.id, width: TOPIC_WIDTH, height: TOPIC_HEIGHT } : { id: node.id, width: NODE_WIDTH, height: NODE_HEIGHT }
  }
  const topLevel = sorted.filter((node) => !node.parent || !sorted.some((other) => other.id === node.parent))
  const children: ElkNode[] = grouped
    ? namespaces.map((namespace) => ({
        id: `ns:${namespace}`,
        layoutOptions: containerOptions,
        children: topLevel.filter((node) => (node.namespace ?? '') === namespace).map(toElk)
      }))
    : topLevel.map(toElk)

  const result = (await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      // Entre columnas debe caber la etiqueta de la conexión
      'elk.layered.spacing.nodeNodeBetweenLayers': direction === 'RIGHT' ? '130' : '74',
      'elk.spacing.nodeNode': '26',
      'elk.spacing.edgeEdge': '14',
      'elk.spacing.edgeNode': '22',
      'elk.layered.spacing.edgeNodeBetweenLayers': '26',
      'elk.spacing.componentComponent': '48',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.semiInteractive': 'false',
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
      'elk.padding': '[top=16,left=16,bottom=16,right=16]'
    },
    children,
    edges: sortedEdges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as any

  const byId = new Map(sorted.map((node) => [node.id, node]))
  const placed: PlacedNode[] = []
  const groups: PlacedGroup[] = []
  const visit = (elkNode: ElkNode): void => {
    const node = byId.get(elkNode.id)
    if (node) {
      placed.push({
        node,
        x: elkNode.x ?? 0,
        y: elkNode.y ?? 0,
        width: elkNode.width ?? NODE_WIDTH,
        height: elkNode.height ?? NODE_HEIGHT,
        container: Boolean(elkNode.children?.length)
      })
    } else if (elkNode.id.startsWith('ns:')) {
      groups.push({ label: elkNode.id.slice(3), x: elkNode.x ?? 0, y: elkNode.y ?? 0, width: elkNode.width ?? 0, height: elkNode.height ?? 0 })
    }
    elkNode.children?.forEach(visit)
  }
  result.children?.forEach(visit)

  const edgeById = new Map(sortedEdges.map((edge) => [edge.id, edge]))
  const placedEdges: PlacedEdge[] = []
  const collect = (container: { edges?: { id: string; sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[] }[]; children?: unknown[] }): void => {
    for (const elkEdge of container.edges ?? []) {
      const edge = edgeById.get(elkEdge.id)
      const section = elkEdge.sections?.[0]
      if (!edge || !section) continue
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
      const middle = longestSegmentMiddle(points)
      placedEdges.push({ edge, path: roundedPath(points), labelX: middle.x, labelY: middle.y })
    }
    for (const child of (container.children ?? []) as (typeof container)[]) collect(child)
  }
  collect(result)

  return { nodes: placed, groups, edges: placedEdges, width: result.width ?? 0, height: result.height ?? 0 }
}
