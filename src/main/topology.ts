import type { KubeObject, TopologyEdge, TopologyNode } from '../shared/types'

/** Objetos del clúster de los que se deduce la arquitectura declarada */
export interface TopologyInput {
  deployments: KubeObject[]
  statefulSets: KubeObject[]
  daemonSets: KubeObject[]
  pods: KubeObject[]
  replicaSets: KubeObject[]
  services: KubeObject[]
  ingresses: KubeObject[]
  components: KubeObject[]
  subscriptions: KubeObject[]
}

export interface Topology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  /** `<namespace>/<app-id>` → id del nodo, para colocar el tráfico observado */
  apps: Map<string, string>
}

export const workloadId = (namespace: string, kind: string, name: string): string => `workload:${namespace}/${kind}/${name}`
export const serviceId = (namespace: string, name: string): string => `service:${namespace}/${name}`
export const componentId = (namespace: string, name: string): string => `component:${namespace}/${name}`
export const topicId = (namespace: string, component: string, topic: string): string => `topic:${namespace}/${component}/${topic}`

const DAPR_ENABLED = 'dapr.io/enabled'
const DAPR_APP_ID = 'dapr.io/app-id'

/** Un Service selecciona un pod si todas las etiquetas del selector coinciden */
export function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  const entries = Object.entries(selector ?? {})
  return entries.length > 0 && entries.every(([key, value]) => labels?.[key] === value)
}

/**
 * Dirección de un Service dentro de un valor de configuración. Una palabra suelta como `orders` no
 * cuenta: sería un falso positivo en casi cualquier variable. Exige esquema, puerto o sufijo `.svc`.
 */
export function serviceHostIn(value: string, namespace: string): { name: string; namespace: string } | null {
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^@/\s]*@)?([a-z0-9][a-z0-9.-]*)(?::(\d+))?(?:[/?#]\S*)?$/.exec(value.trim())
  if (!match) return null
  const [, scheme, host, port] = match
  const parts = host.split('.')
  if (parts.length >= 3 && parts[2] === 'svc') return { name: parts[0], namespace: parts[1] }
  if (!scheme && !port) return null
  if (parts.length === 1) return { name: parts[0], namespace }
  // `nombre.namespace:puerto`. Algo como `api.ejemplo.com` es externo
  if (parts.length === 2 && !/^(com|net|org|io|dev|co|local|app)$/.test(parts[1])) return { name: parts[0], namespace: parts[1] }
  return null
}

/** Los Service `<app>-dapr` los crea Dapr para sus sidecars: mostrarlos solo duplicaría cada app */
function isDaprInternalService(service: KubeObject): boolean {
  return service.metadata.annotations?.[DAPR_ENABLED] === 'true' || service.metadata.labels?.[DAPR_ENABLED] === 'true'
}

const readyPods = (pods: KubeObject[]): number =>
  pods.filter((pod) => (pod.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === 'Ready' && c.status === 'True')).length

const liveRows = (pods: KubeObject[]): KubeObject[] =>
  pods.filter((pod) => pod.status?.phase !== 'Succeeded' && pod.status?.phase !== 'Failed')

/** Arquitectura declarada: lo que dicen los objetos, sin afirmar nada sobre el tráfico real */
export function buildTopology(input: TopologyInput): Topology {
  const nodes = new Map<string, TopologyNode>()
  const edges = new Map<string, TopologyEdge>()
  const apps = new Map<string, string>()

  const addEdge = (edge: Omit<TopologyEdge, 'id' | 'observed'>): void => {
    if (edge.source === edge.target) return
    const id = `${edge.kind}|${edge.source}|${edge.target}`
    if (!edges.has(id)) edges.set(id, { ...edge, id, observed: false })
  }

  // Dueño final de cada pod: Pod → ReplicaSet → Deployment
  const replicaOwner = new Map(input.replicaSets.map((rs) => [rs.metadata.uid, rs.metadata.ownerReferences?.find((o) => o.controller)]))
  const podsByWorkload = new Map<string, KubeObject[]>()
  const standalone: KubeObject[] = []
  for (const pod of liveRows(input.pods)) {
    const namespace = pod.metadata.namespace!
    const owner = pod.metadata.ownerReferences?.find((o) => o.controller)
    const top = owner?.kind === 'ReplicaSet' ? (replicaOwner.get(owner.uid) ?? owner) : owner
    if (top && ['Deployment', 'StatefulSet', 'DaemonSet'].includes(top.kind)) {
      const id = workloadId(namespace, top.kind, top.name)
      podsByWorkload.set(id, [...(podsByWorkload.get(id) ?? []), pod])
    } else if (pod.metadata.annotations?.[DAPR_ENABLED] === 'true' || !owner) {
      standalone.push(pod)
    }
  }

  const workloadTemplates: { id: string; labels?: Record<string, string>; namespace: string; containers: { env?: { name: string; value?: string }[] }[] }[] = []
  const addWorkload = (object: KubeObject, kind: string): void => {
    const { name } = object.metadata
    const namespace = object.metadata.namespace!
    const id = workloadId(namespace, kind, name)
    const annotations = object.spec?.template?.metadata?.annotations ?? {}
    const pods = podsByWorkload.get(id) ?? []
    const dapr = annotations[DAPR_ENABLED] === 'true'
    const appId: string | undefined = dapr ? (annotations[DAPR_APP_ID] ?? name) : undefined
    nodes.set(id, {
      id,
      kind: 'workload',
      name,
      namespace,
      subtitle: kind,
      ref: { kind, namespace, name },
      daprAppId: appId,
      pods: { ready: readyPods(pods), total: pods.length, desired: object.spec?.replicas ?? pods.length }
    })
    if (appId) apps.set(`${namespace}/${appId}`, id)
    workloadTemplates.push({ id, namespace, labels: object.spec?.template?.metadata?.labels, containers: object.spec?.template?.spec?.containers ?? [] })
  }
  for (const object of input.deployments) addWorkload(object, 'Deployment')
  for (const object of input.statefulSets) addWorkload(object, 'StatefulSet')
  for (const object of input.daemonSets) addWorkload(object, 'DaemonSet')
  for (const pod of standalone) {
    const { name } = pod.metadata
    const namespace = pod.metadata.namespace!
    const id = workloadId(namespace, 'Pod', name)
    const dapr = pod.metadata.annotations?.[DAPR_ENABLED] === 'true'
    const appId = dapr ? (pod.metadata.annotations?.[DAPR_APP_ID] ?? name) : undefined
    nodes.set(id, { id, kind: 'workload', name, namespace, subtitle: 'Pod', ref: { kind: 'Pod', namespace, name }, daprAppId: appId, pods: { ready: readyPods([pod]), total: 1, desired: 1 } })
    if (appId) apps.set(`${namespace}/${appId}`, id)
    workloadTemplates.push({ id, namespace, labels: pod.metadata.labels, containers: pod.spec?.containers ?? [] })
  }

  // Services y a qué cargas dirigen
  const knownServices = new Set<string>()
  for (const service of input.services) {
    const { name } = service.metadata
    const namespace = service.metadata.namespace!
    if (isDaprInternalService(service)) continue
    // `kubernetes` y similares: sin selector no apuntan a una carga que se pueda dibujar
    if (!service.spec?.selector) continue
    const id = serviceId(namespace, name)
    knownServices.add(id)
    nodes.set(id, {
      id,
      kind: 'service',
      name,
      namespace,
      subtitle: service.spec?.type ?? 'ClusterIP',
      ref: { kind: 'Service', namespace, name }
    })
    for (const workload of workloadTemplates) {
      if (workload.namespace === namespace && selectorMatches(service.spec.selector, workload.labels)) {
        addEdge({ source: id, target: workload.id, kind: 'selects', evidence: 'selector del Service' })
      }
    }
  }

  // Ingress → Service
  for (const ingress of input.ingresses) {
    const { name } = ingress.metadata
    const namespace = ingress.metadata.namespace!
    const id = `ingress:${namespace}/${name}`
    const rules: { host?: string; http?: { paths?: { backend?: { service?: { name: string } } }[] } }[] = ingress.spec?.rules ?? []
    const hosts = [...new Set(rules.map((rule) => rule.host).filter(Boolean))] as string[]
    nodes.set(id, { id, kind: 'ingress', name, namespace, subtitle: hosts.join(', ') || 'Ingress', ref: { kind: 'Ingress', namespace, name } })
    const backends = rules.flatMap((rule) => (rule.http?.paths ?? []).map((path) => path.backend?.service?.name))
    if (ingress.spec?.defaultBackend?.service?.name) backends.push(ingress.spec.defaultBackend.service.name)
    for (const backend of backends) {
      if (backend && knownServices.has(serviceId(namespace, backend))) {
        addEdge({ source: id, target: serviceId(namespace, backend), kind: 'route', evidence: 'regla del Ingress' })
      }
    }
  }

  // Direcciones de otros Services en variables de entorno: una dependencia declarada, no tráfico
  for (const workload of workloadTemplates) {
    for (const container of workload.containers) {
      for (const env of container.env ?? []) {
        if (!env.value) continue
        const target = serviceHostIn(env.value, workload.namespace)
        if (!target) continue
        const id = serviceId(target.namespace, target.name)
        if (knownServices.has(id)) addEdge({ source: workload.id, target: id, kind: 'declared', evidence: `variable ${env.name}` })
      }
    }
  }

  // Componentes de Dapr
  for (const component of input.components) {
    const { name } = component.metadata
    const namespace = component.metadata.namespace!
    const id = componentId(namespace, name)
    const type: string = component.spec?.type ?? ''
    const category = type.split('.')[0]
    nodes.set(id, { id, kind: 'component', name, namespace, subtitle: type, category, ref: { kind: 'Component', namespace, name } })
    for (const appId of (component.scopes ?? []) as string[]) {
      const app = apps.get(`${namespace}/${appId}`)
      if (app && category !== 'pubsub') addEdge({ source: app, target: id, kind: 'declared', evidence: 'scopes del componente' })
    }
    // El servicio real que hay detrás del componente, solo con valores literales: nunca secretos
    for (const entry of (component.spec?.metadata ?? []) as { name: string; value?: string }[]) {
      if (typeof entry.value !== 'string') continue
      const target = serviceHostIn(entry.value, namespace)
      if (!target) continue
      const service = serviceId(target.namespace, target.name)
      if (knownServices.has(service)) addEdge({ source: id, target: service, kind: 'declared', evidence: `metadata ${entry.name}` })
    }
  }

  // Suscripciones: temas dentro de su broker y a quién entregan
  for (const subscription of input.subscriptions) {
    const namespace = subscription.metadata.namespace!
    const pubsub: string | undefined = subscription.spec?.pubsubname
    const topic: string | undefined = subscription.spec?.topic
    if (!pubsub || !topic) continue
    const id = ensureTopic(nodes, namespace, pubsub, topic)
    for (const appId of (subscription.scopes ?? []) as string[]) {
      const app = apps.get(`${namespace}/${appId}`)
      if (app) addEdge({ source: id, target: app, kind: 'deliver', evidence: `Subscription ${subscription.metadata.name}` })
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], apps }
}

/** Nodo de un tema, hijo de su broker. También lo crea el tráfico si no hay Subscription declarativa */
export function ensureTopic(nodes: Map<string, TopologyNode>, namespace: string, pubsub: string, topic: string): string {
  const id = topicId(namespace, pubsub, topic)
  if (!nodes.has(id)) {
    const parent = componentId(namespace, pubsub)
    nodes.set(id, { id, kind: 'topic', name: topic, namespace, subtitle: 'tema', parent: nodes.has(parent) ? parent : undefined })
  }
  return id
}
