import type { TopologyEdge, TopologyNode } from '../../../shared/types'

export interface GraphFilter {
  showDeclared: boolean
  onlyObserved: boolean
  showSystem: boolean
}

const SYSTEM_NAMESPACES = /^(kube-system|kube-public|kube-node-lease|dapr-system|local-path-storage|cert-manager|ingress-nginx|istio-system|linkerd)$/

/**
 * Un Service que selecciona una sola carga es su puerta de entrada, no otra pieza de la arquitectura:
 * se integra en ella. Dibujarlo aparte añade una columna por cada servicio y obliga a reducir todo el
 * diagrama hasta que no se lee. Los que reparten entre varias cargas o no tienen ninguna se conservan.
 */
export function collapseServices(nodes: TopologyNode[], edges: TopologyEdge[]): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const targets = new Map<string, string[]>()
  for (const edge of edges) if (edge.kind === 'selects') targets.set(edge.source, [...(targets.get(edge.source) ?? []), edge.target])
  const into = new Map([...targets].filter(([, list]) => list.length === 1).map(([service, list]) => [service, list[0]]))
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  const servicesOf = new Map<string, string[]>()
  for (const [service, workload] of into) {
    const name = nodeById.get(service)?.name
    if (name) servicesOf.set(workload, [...(servicesOf.get(workload) ?? []), name])
  }
  const remap = (id: string): string => into.get(id) ?? id
  const merged = new Map<string, TopologyEdge>()
  for (const edge of edges) {
    if (edge.kind === 'selects' && into.has(edge.source)) continue
    const [source, target] = [remap(edge.source), remap(edge.target)]
    if (source === target) continue
    const id = source === edge.source && target === edge.target ? edge.id : `${edge.kind}|${source}|${target}`
    if (!merged.has(id)) merged.set(id, { ...edge, id, source, target })
  }
  // Lo declarado sobra si ya se está midiendo esa misma comunicación
  const measured = new Set([...merged.values()].filter((edge) => edge.observed).map((edge) => `${edge.source}|${edge.target}`))
  return {
    nodes: nodes.filter((node) => !into.has(node.id)).map((node) => (servicesOf.has(node.id) ? { ...node, services: servicesOf.get(node.id) } : node)),
    edges: [...merged.values()].filter((edge) => edge.kind !== 'declared' || !measured.has(`${edge.source}|${edge.target}`))
  }
}

/** Qué se dibuja según los filtros. Nunca depende de las tasas: el grafo no debe saltar en cada lectura */
export function filterGraph(allNodes: TopologyNode[], allEdges: TopologyEdge[], filter: GraphFilter, chosen: string[] = []): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const { nodes, edges } = collapseServices(allNodes, allEdges)
  // Un namespace de sistema elegido a propósito en el filtro se muestra aunque «Sistema» esté desactivado
  const isHidden = (namespace = ''): boolean => !filter.showSystem && SYSTEM_NAMESPACES.test(namespace) && !chosen.includes(namespace)
  let visibleNodes = nodes.filter((node) => !isHidden(node.namespace))
  const ids = new Set(visibleNodes.map((node) => node.id))
  let visibleEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target))
  if (!filter.showDeclared) visibleEdges = visibleEdges.filter((edge) => edge.observed || edge.kind === 'route' || edge.kind === 'selects')
  if (filter.onlyObserved) {
    visibleEdges = visibleEdges.filter((edge) => edge.observed)
    const used = new Set(visibleEdges.flatMap((edge) => [edge.source, edge.target]))
    // Un broker se conserva si alguno de sus temas tiene tráfico: es su contenedor
    for (const node of visibleNodes) if (node.parent && used.has(node.id)) used.add(node.parent)
    visibleNodes = visibleNodes.filter((node) => used.has(node.id))
  }
  return { nodes: visibleNodes, edges: visibleEdges }
}
