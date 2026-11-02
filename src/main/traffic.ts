import type { EdgeTraffic, KubeObject, TopologyEdge, TopologyNode, TrafficCoverage, TrafficSnapshot } from '../shared/types'
import { KubeApiError, type KubeClient } from './kube-client'
import { counterDelta, histogramQuantile, parseMetrics, type Sample } from './prometheus'
import { buildTopology, componentId, ensureTopic, type Topology, type TopologyInput } from './topology'

/** Ventana de la tasa mostrada y de los percentiles: suaviza sin dejar de ser reciente */
const RATE_WINDOW_SECONDS = 30
const LATENCY_WINDOW_SECONDS = 60
const HISTORY_TICKS = 60
const TOPOLOGY_REFRESH_MS = 30_000
const MAX_SIDECARS = 200
const SCRAPE_CONCURRENCY = 8
const SCRAPE_TIMEOUT_MS = 8_000
const SCRAPE_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_METRICS_PORT = '9090'

/** Quién habla con quién, tal como lo cuenta el sidecar de quien inicia la comunicación */
export type ObservedRef =
  | { kind: 'invoke'; namespace: string; app: string; targetNamespace: string; target: string }
  | { kind: 'publish'; namespace: string; app: string; component: string; topic: string }
  | { kind: 'deliver'; namespace: string; app: string; component: string; topic: string }
  | { kind: 'component'; namespace: string; app: string; component: string; inbound: boolean; category: string }

export interface Observation {
  ref: ObservedRef
  /** Identifica la serie dentro del pod */
  series: string
  value: number
  outcome?: { label: string; error: boolean }
  le?: number
  /** Es una resta de dos contadores: puede bajar sin que nada se haya reiniciado */
  derived?: boolean
}

const seriesId = (sample: Sample): string => `${sample.name}${JSON.stringify(sample.labels)}`

export const refKey = (ref: ObservedRef): string => {
  switch (ref.kind) {
    case 'invoke':
      return `invoke|${ref.namespace}|${ref.app}|${ref.targetNamespace}|${ref.target}`
    case 'component':
      return `component|${ref.namespace}|${ref.app}|${ref.component}`
    default:
      return `${ref.kind}|${ref.namespace}|${ref.app}|${ref.component}|${ref.topic}`
  }
}

/** `app.namespace` invoca a otro namespace. Un id de app no puede llevar puntos */
export function parseInvokeTarget(value: string, namespace: string): { app: string; namespace: string } {
  const dot = value.lastIndexOf('.')
  return dot > 0 ? { app: value.slice(0, dot), namespace: value.slice(dot + 1) } : { app: value, namespace }
}

/**
 * Resultado de una invocación. Dapr informa el código HTTP o, con apps gRPC, el código gRPC.
 * Un 4xx es un error del cliente, no del servicio: se ve en el desglose pero no cuenta como fallo.
 */
export function invocationOutcome(status: string): { label: string; error: boolean } {
  const code = Number(status)
  // Number('') es 0, que en gRPC significa éxito: un estado vacío no puede pasar por bueno
  if (status.trim() === '' || !Number.isInteger(code) || code < 0) return { label: status || 'Desconocido', error: true }
  if (code >= 100) return { label: `HTTP ${code}`, error: code >= 500 }
  return { label: `gRPC ${code}`, error: code !== 0 }
}

const INVOKE_SENT = 'dapr_runtime_service_invocation_req_sent_total'
const INVOKE_RECEIVED = 'dapr_runtime_service_invocation_res_recv_total'
const INVOKE_LATENCY = 'dapr_runtime_service_invocation_res_recv_latency_ms_bucket'
const SIDECAR_HTTP_REQUESTS = 'dapr_http_server_request_count'
const INVOKE_PATH = /^\/v1\.0\/invoke\/([^/]+)\/method\//
const PUBLISH_COUNT = 'dapr_component_pubsub_egress_count'
const PUBLISH_LATENCY = 'dapr_component_pubsub_egress_latencies_bucket'
const DELIVER_COUNT = 'dapr_component_pubsub_ingress_count'
const DELIVER_LATENCY = 'dapr_component_pubsub_ingress_latencies_bucket'

/** Familias `dapr_component_<x>_count`: categoría del componente y sentido de la comunicación */
const COMPONENT_FAMILIES: Record<string, { category: string; inbound: boolean }> = {
  state: { category: 'state', inbound: false },
  output_binding: { category: 'bindings', inbound: false },
  input_binding: { category: 'bindings', inbound: true },
  secret: { category: 'secretstores', inbound: false },
  configuration: { category: 'configuration', inbound: false }
}
const COMPONENT_METRIC = /^dapr_component_(state|output_binding|input_binding|secret|configuration)_(count|latencies_bucket)$/

export const isTrafficMetric = (name: string): boolean =>
  name === INVOKE_SENT || name === INVOKE_RECEIVED || name === INVOKE_LATENCY || name === SIDECAR_HTTP_REQUESTS ||
  name === PUBLISH_COUNT || name === PUBLISH_LATENCY || name === DELIVER_COUNT || name === DELIVER_LATENCY ||
  COMPONENT_METRIC.test(name)

const successOutcome = (labels: Record<string, string>, ok: string, failed: string): { label: string; error: boolean } =>
  labels.success === 'false' ? { label: failed, error: true } : { label: ok, error: false }

/** Traduce las métricas de un sidecar. Los nombres y etiquetas están comprobados contra Dapr 1.19 */
export function readObservations(samples: Sample[], namespace: string): Observation[] {
  const observations: Observation[] = []
  const answered = new Set<string>()
  const failedAnswers = new Map<string, number>()
  const failedCalls = new Map<string, { ref: ObservedRef; value: number }>()
  const invokeRef = (app: string, targetValue: string): ObservedRef => {
    const target = parseInvokeTarget(targetValue, namespace)
    return { kind: 'invoke', namespace, app, targetNamespace: target.namespace, target: target.app }
  }

  for (const sample of samples) {
    const { name, labels, value } = sample
    const series = seriesId(sample)
    const app = labels.app_id
    if (!app) continue
    if (name === INVOKE_RECEIVED) {
      // En las respuestas, `src_app_id` es quien responde: el destino de la llamada
      const ref = invokeRef(app, labels.src_app_id)
      const outcome = invocationOutcome(labels.status)
      answered.add(refKey(ref))
      if (outcome.error) failedAnswers.set(refKey(ref), (failedAnswers.get(refKey(ref)) ?? 0) + value)
      observations.push({ ref, series, value, outcome })
    } else if (name === SIDECAR_HTTP_REQUESTS) {
      const target = INVOKE_PATH.exec(labels.path ?? '')?.[1]
      if (!target) continue
      const ref = invokeRef(app, target)
      const call = failedCalls.get(refKey(ref)) ?? { ref, value: 0 }
      if (Number(labels.status) >= 500) call.value += value
      failedCalls.set(refKey(ref), call)
    } else if (name === INVOKE_LATENCY) {
      observations.push({ ref: invokeRef(app, labels.src_app_id), series, value, le: Number(labels.le) })
    } else if (name === PUBLISH_COUNT || name === PUBLISH_LATENCY) {
      const ref: ObservedRef = { kind: 'publish', namespace, app, component: labels.component, topic: labels.topic }
      if (name === PUBLISH_COUNT) observations.push({ ref, series, value, outcome: successOutcome(labels, 'Publicado', 'Publicación fallida') })
      else observations.push({ ref, series, value, le: Number(labels.le) })
    } else if (name === DELIVER_COUNT || name === DELIVER_LATENCY) {
      const ref: ObservedRef = { kind: 'deliver', namespace, app, component: labels.component, topic: labels.topic }
      if (name === DELIVER_COUNT) {
        // `retry` y `drop` son eventos que la app no procesó
        const status = labels.process_status ?? ''
        const outcome = status === 'success' ? { label: 'Procesado', error: false } : { label: status === 'retry' ? 'Reintento' : status === 'drop' ? 'Descartado' : status || 'Desconocido', error: true }
        observations.push({ ref, series, value, outcome })
      } else {
        observations.push({ ref, series, value, le: Number(labels.le) })
      }
    } else {
      const match = COMPONENT_METRIC.exec(name)
      if (!match) continue
      const family = COMPONENT_FAMILIES[match[1]]
      const ref: ObservedRef = { kind: 'component', namespace, app, component: labels.component, inbound: family.inbound, category: family.category }
      if (match[2] === 'count') {
        const action = labels.operation ?? 'Operación'
        observations.push({ ref, series, value, outcome: successOutcome(labels, action, `${action} fallida`) })
      } else {
        observations.push({ ref, series, value, le: Number(labels.le) })
      }
    }
  }
  // Con el destino caído, Dapr falla antes de enviar: no cuenta ninguna respuesta y apenas envíos. Solo
  // se nota en lo que la app recibió de su sidecar. Lo que falló de más nunca llegó al destino
  for (const [key, { ref, value }] of failedCalls) {
    observations.push({ ref, series: `sin-entregar|${key}`, value: Math.max(0, value - (failedAnswers.get(key) ?? 0)), outcome: { label: 'No entregada', error: true }, derived: true })
  }
  // Apps que hablan gRPC con su sidecar: de ellas solo se sabe lo que se envió sin respuesta
  for (const sample of samples) {
    if (sample.name !== INVOKE_SENT || !sample.labels.app_id) continue
    const ref = invokeRef(sample.labels.app_id, sample.labels.dst_app_id)
    if (!answered.has(refKey(ref)) && !failedCalls.has(refKey(ref))) observations.push({ ref, series: seriesId(sample), value: sample.value, outcome: { label: 'Sin respuesta', error: true } })
  }
  return observations
}

interface Tick {
  t: number
  seconds: number
  outcomes: Map<string, { count: number; error: boolean }>
  /** Incremento por límite `le`: sigue siendo acumulado entre buckets */
  buckets: Map<number, number>
}

interface TrackedEdge {
  ref: ObservedRef
  ticks: Tick[]
  total: number
  errors: number
}

/**
 * Convierte contadores acumulados de cada pod en tasas por conexión. Los incrementos se calculan
 * por pod porque un pod que desaparece no debe contarse como una bajada del total.
 */
export class TrafficTracker {
  private previous = new Map<string, Map<string, number>>()
  private edges = new Map<string, TrackedEdge>()
  private lastAt: number | undefined

  private readings = 0

  /** Hacen falta dos lecturas para tener una tasa */
  get warmingUp(): boolean {
    return this.readings < 2
  }

  /** `pods` solo incluye las lecturas correctas. Quien falla pierde su base: no se inventa su tráfico */
  ingest(at: number, pods: { key: string; namespace: string; samples: Sample[] }[]): void {
    const seconds = this.lastAt === undefined ? 0 : (at - this.lastAt) / 1000
    const current = new Map<string, Tick>()
    const totals = new Map<string, { total: number; errors: number }>()
    const nextPrevious = new Map<string, Map<string, number>>()

    for (const pod of pods) {
      const before = this.previous.get(pod.key)
      const after = new Map<string, number>()
      for (const observation of readObservations(pod.samples, pod.namespace)) {
        const key = refKey(observation.ref)
        if (!this.edges.has(key)) this.edges.set(key, { ref: observation.ref, ticks: [], total: 0, errors: 0 })
        after.set(observation.series, observation.value)
        if (observation.outcome) {
          const sum = totals.get(key) ?? { total: 0, errors: 0 }
          sum.total += observation.value
          if (observation.outcome.error) sum.errors += observation.value
          totals.set(key, sum)
        }
        // Pod conocido y serie nueva: esa serie empezó en cero. Sin esto se perdería el primer error
        if (!before) continue
        const earlier = before.get(observation.series) ?? 0
        // Una resta puede bajar por una petición a medio contar: no es un reinicio ni un pico
        const delta = observation.derived ? Math.max(0, observation.value - earlier) : counterDelta(earlier, observation.value)
        const tick = current.get(key) ?? { t: at / 1000, seconds, outcomes: new Map(), buckets: new Map() }
        current.set(key, tick)
        if (observation.outcome) {
          const entry = tick.outcomes.get(observation.outcome.label) ?? { count: 0, error: observation.outcome.error }
          entry.count += delta
          tick.outcomes.set(observation.outcome.label, entry)
        } else if (observation.le !== undefined) {
          tick.buckets.set(observation.le, (tick.buckets.get(observation.le) ?? 0) + delta)
        }
      }
      nextPrevious.set(pod.key, after)
    }

    if (this.lastAt !== undefined) {
      for (const [key, edge] of this.edges) {
        edge.ticks.push(current.get(key) ?? { t: at / 1000, seconds, outcomes: new Map(), buckets: new Map() })
        if (edge.ticks.length > HISTORY_TICKS) edge.ticks.shift()
      }
    }
    for (const [key, edge] of this.edges) {
      const sum = totals.get(key)
      edge.total = sum?.total ?? 0
      edge.errors = sum?.errors ?? 0
    }
    this.previous = nextPrevious
    this.lastAt = at
    this.readings++
  }

  /** Conexiones vistas en esta sesión. Siguen listadas sin tráfico: el diagrama no debe parpadear */
  list(intervalSeconds: number): { ref: ObservedRef; traffic: EdgeTraffic }[] {
    const windowTicks = (seconds: number): number => Math.max(1, Math.ceil(seconds / intervalSeconds))
    return [...this.edges.values()].map((edge) => {
      const recent = edge.ticks.slice(-windowTicks(RATE_WINDOW_SECONDS))
      const seconds = recent.reduce((sum, tick) => sum + tick.seconds, 0)
      const outcomes = new Map<string, { count: number; error: boolean }>()
      for (const tick of recent) {
        for (const [label, entry] of tick.outcomes) {
          const sum = outcomes.get(label) ?? { count: 0, error: entry.error }
          sum.count += entry.count
          outcomes.set(label, sum)
        }
      }
      const count = [...outcomes.values()].reduce((sum, entry) => sum + entry.count, 0)
      const failed = [...outcomes.values()].filter((entry) => entry.error).reduce((sum, entry) => sum + entry.count, 0)

      const buckets = new Map<number, number>()
      for (const tick of edge.ticks.slice(-windowTicks(LATENCY_WINDOW_SECONDS))) {
        for (const [le, value] of tick.buckets) buckets.set(le, (buckets.get(le) ?? 0) + value)
      }
      const bucketList = [...buckets].map(([le, value]) => ({ le, count: value }))
      const traffic: EdgeTraffic = {
        rate: seconds > 0 ? count / seconds : 0,
        errorRatio: count > 0 ? failed / count : 0,
        total: edge.total,
        errors: edge.errors,
        p50Ms: histogramQuantile(0.5, bucketList),
        p95Ms: histogramQuantile(0.95, bucketList),
        breakdown: [...outcomes]
          .filter(([, entry]) => entry.count > 0)
          .map(([label, entry]) => ({ label, rate: seconds > 0 ? entry.count / seconds : 0, error: entry.error }))
          .sort((a, b) => b.rate - a.rate),
        history: edge.ticks.map((tick) => {
          const entries = [...tick.outcomes.values()]
          const perSecond = (value: number): number => (tick.seconds > 0 ? value / tick.seconds : 0)
          return {
            t: tick.t,
            rate: perSecond(entries.reduce((sum, entry) => sum + entry.count, 0)),
            errorRate: perSecond(entries.filter((entry) => entry.error).reduce((sum, entry) => sum + entry.count, 0))
          }
        })
      }
      return { ref: edge.ref, traffic }
    })
  }
}

/** Une lo declarado con lo medido. Una conexión medida sustituye a la misma conexión solo declarada */
export function mergeTraffic(topology: Topology, observed: { ref: ObservedRef; traffic: EdgeTraffic }[]): { nodes: TopologyNode[]; edges: TopologyEdge[] } {
  const nodes = new Map(topology.nodes.map((node) => [node.id, node]))
  const edges = new Map(topology.edges.map((edge) => [edge.id, edge]))

  const appNode = (namespace: string, app: string): string => {
    const known = topology.apps.get(`${namespace}/${app}`)
    if (known) return known
    // Una app que responde pero no está en la lista: otro namespace filtrado, o fuera del clúster
    const id = `external:${namespace}/${app}`
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'external', name: app, namespace, subtitle: 'App fuera de esta vista', daprAppId: app })
    return id
  }
  const componentNode = (namespace: string, name: string, category?: string): string => {
    const id = componentId(namespace, name)
    // Sin objeto Component: los almacenes integrados, como el de secretos de Kubernetes
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'component', name, namespace, subtitle: 'Integrado en Dapr', category })
    return id
  }

  for (const { ref, traffic } of observed) {
    let source: string
    let target: string
    if (ref.kind === 'invoke') {
      source = appNode(ref.namespace, ref.app)
      target = appNode(ref.targetNamespace, ref.target)
    } else if (ref.kind === 'publish') {
      componentNode(ref.namespace, ref.component, 'pubsub')
      source = appNode(ref.namespace, ref.app)
      target = ensureTopic(nodes, ref.namespace, ref.component, ref.topic)
    } else if (ref.kind === 'deliver') {
      componentNode(ref.namespace, ref.component, 'pubsub')
      source = ensureTopic(nodes, ref.namespace, ref.component, ref.topic)
      target = appNode(ref.namespace, ref.app)
    } else {
      const component = componentNode(ref.namespace, ref.component, ref.category)
      const app = appNode(ref.namespace, ref.app)
      ;[source, target] = ref.inbound ? [component, app] : [app, component]
    }
    const id = `${ref.kind}|${source}|${target}`
    const declaredId = `declared|${source}|${target}`
    const evidence = edges.get(id)?.evidence ?? edges.get(declaredId)?.evidence
    edges.delete(declaredId)
    edges.set(id, { id, source, target, kind: ref.kind, evidence, observed: true, traffic })
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

export interface Sidecar {
  key: string
  namespace: string
  pod: string
  port: string
}

/** Pods en marcha con el contenedor `daprd`, que es lo que añade el inyector de Dapr */
export function findSidecars(pods: KubeObject[]): { sidecars: Sidecar[]; disabled: number } {
  const sidecars: Sidecar[] = []
  let disabled = 0
  for (const pod of pods) {
    const hasSidecar = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])].some((c: { name: string }) => c.name === 'daprd')
    if (!hasSidecar || pod.status?.phase !== 'Running' || pod.metadata.deletionTimestamp) continue
    const annotations = pod.metadata.annotations ?? {}
    if (annotations['dapr.io/enable-metrics'] === 'false') {
      disabled++
      continue
    }
    sidecars.push({
      key: pod.metadata.uid ?? `${pod.metadata.namespace}/${pod.metadata.name}`,
      namespace: pod.metadata.namespace!,
      pod: pod.metadata.name,
      port: annotations['dapr.io/metrics-port'] ?? DEFAULT_METRICS_PORT
    })
  }
  sidecars.sort((a, b) => a.key.localeCompare(b.key))
  return { sidecars, disabled }
}

function scrapeFailure(error: Error): string {
  if (error instanceof KubeApiError) {
    if (error.status === 403) return 'Sin permiso para leer las métricas (hace falta pods/proxy)'
    if (error.status === 404) return 'Un pod ya no existe'
    if (error.status === 503) return 'Un sidecar no responde en su puerto de métricas'
  }
  return `Un sidecar no respondió: ${error.message}`
}

const EMPTY_INPUT: TopologyInput = { deployments: [], statefulSets: [], daemonSets: [], pods: [], replicaSets: [], services: [], ingresses: [], components: [], subscriptions: [] }

/** Lee los objetos de la arquitectura. Un tipo sin permiso deja un aviso, no un diagrama en blanco */
async function readTopologyInput(client: KubeClient, namespaces: string[], signal: AbortSignal): Promise<{ input: TopologyInput; daprInstalled: boolean; warnings: string[] }> {
  const warnings: string[] = []
  const list = async (apiVersion: string, kind: string, optional = false): Promise<KubeObject[]> => {
    try {
      const resource = await client.findKind(apiVersion, kind)
      signal.throwIfAborted()
      // Una lista por namespace elegido: la API no admite varios en una sola petición
      const scopes = namespaces.length ? namespaces : [undefined]
      return (await Promise.all(scopes.map((namespace) => client.listItems(resource, namespace)))).flat()
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
      if (!optional || error instanceof KubeApiError) warnings.push(`${kind}: ${(error as Error).message}`)
      return []
    }
  }
  const resources = await client.discover()
  const daprInstalled = resources.some((r) => r.group === 'dapr.io' && r.kind === 'Component')
  const [deployments, statefulSets, daemonSets, pods, replicaSets, services, ingresses, components, subscriptions] = await Promise.all([
    list('apps/v1', 'Deployment'),
    list('apps/v1', 'StatefulSet'),
    list('apps/v1', 'DaemonSet'),
    list('v1', 'Pod'),
    list('apps/v1', 'ReplicaSet'),
    list('v1', 'Service'),
    list('networking.k8s.io/v1', 'Ingress', true),
    daprInstalled ? list('dapr.io/v1alpha1', 'Component', true) : [],
    daprInstalled ? list('dapr.io/v2alpha1', 'Subscription', true) : []
  ])
  return { input: { deployments, statefulSets, daemonSets, pods, replicaSets, services, ingresses, components, subscriptions }, daprInstalled, warnings }
}

/**
 * Sesión de lectura periódica. Solo hace peticiones GET a través del servidor de API, así que
 * funciona sin Prometheus, sin abrir puertos y también en clústeres en modo solo lectura.
 */
export function startTraffic(client: KubeClient, namespaces: string[], sessionId: string, intervalSeconds: number, send: (snapshot: TrafficSnapshot) => void): () => void {
  const controller = new AbortController()
  const { signal } = controller
  const tracker = new TrafficTracker()
  let timer: NodeJS.Timeout | undefined
  let topology: Topology = buildTopology(EMPTY_INPUT)
  let pods: KubeObject[] = []
  let daprInstalled = false
  let warnings: string[] = []
  let topologyAt = 0

  const scrape = async (sidecars: Sidecar[], failures: Set<string>): Promise<{ key: string; namespace: string; samples: Sample[] }[]> => {
    const results: { key: string; namespace: string; samples: Sample[] }[] = []
    const queue = [...sidecars]
    const worker = async (): Promise<void> => {
      for (let sidecar = queue.shift(); sidecar && !signal.aborted; sidecar = queue.shift()) {
        const path = `/api/v1/namespaces/${encodeURIComponent(sidecar.namespace)}/pods/${encodeURIComponent(`${sidecar.pod}:${sidecar.port}`)}/proxy/metrics`
        try {
          const text = await client.text(path, { signal, timeoutMs: SCRAPE_TIMEOUT_MS, maxBytes: SCRAPE_MAX_BYTES })
          results.push({ key: sidecar.key, namespace: sidecar.namespace, samples: parseMetrics(text, isTrafficMetric) })
        } catch (error) {
          if ((error as Error).name !== 'AbortError') failures.add(scrapeFailure(error as Error))
        }
      }
    }
    await Promise.all(Array.from({ length: SCRAPE_CONCURRENCY }, worker))
    return results
  }

  const tick = async (): Promise<void> => {
    let error: string | undefined
    try {
      if (Date.now() - topologyAt >= TOPOLOGY_REFRESH_MS) {
        const read = await readTopologyInput(client, namespaces, signal)
        topology = buildTopology(read.input)
        pods = read.input.pods
        daprInstalled = read.daprInstalled
        warnings = read.warnings
        topologyAt = Date.now()
      }
    } catch (e) {
      // Se conserva lo último conocido y se reintenta en la próxima lectura
      if ((e as Error).name !== 'AbortError') error = `No se pudo actualizar la arquitectura: ${(e as Error).message}`
    }
    if (signal.aborted) return

    const found = findSidecars(pods)
    const truncated = found.sidecars.length > MAX_SIDECARS
    const sidecars = found.sidecars.slice(0, MAX_SIDECARS)
    const failures = new Set<string>()
    if (found.disabled > 0) failures.add(`${found.disabled} con métricas desactivadas (dapr.io/enable-metrics)`)
    const readings = await scrape(sidecars, failures)
    if (signal.aborted) return
    tracker.ingest(Date.now(), readings)

    const merged = mergeTraffic(topology, tracker.list(intervalSeconds))
    const coverage: TrafficCoverage = { sidecars: sidecars.length + found.disabled, scraped: readings.length, failures: [...failures], truncated }
    send({
      sessionId,
      at: Date.now(),
      intervalSeconds,
      nodes: merged.nodes,
      edges: merged.edges,
      coverage,
      daprInstalled,
      warmingUp: tracker.warmingUp,
      error: error ?? (warnings.length > 0 ? warnings.join(' · ') : undefined)
    })
  }

  const loop = (): void => {
    void tick()
      .catch((e: Error) => {
        if (e.name !== 'AbortError') console.error('Lectura de tráfico', e.message)
      })
      .finally(() => {
        // Se programa al terminar: una lectura lenta nunca se solapa con la siguiente
        if (!signal.aborted) timer = setTimeout(loop, intervalSeconds * 1000)
      })
  }
  loop()

  return () => {
    controller.abort()
    if (timer) clearTimeout(timer)
  }
}
