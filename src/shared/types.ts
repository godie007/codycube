// Contrato entre el proceso principal y la interfaz. Las credenciales nunca cruzan este límite:
// la interfaz solo conoce identificadores de contexto y objetos de Kubernetes.

export interface KubeObject {
  apiVersion?: string
  kind?: string
  metadata: {
    name: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    creationTimestamp?: string
    deletionTimestamp?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: { kind: string; name: string; uid: string; apiVersion: string; controller?: boolean }[]
    [key: string]: unknown
  }
  // Cada tipo tiene su propio spec/status; las columnas y detalles los leen de forma defensiva.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status?: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** Un tipo de recurso tal como lo anuncia el descubrimiento del servidor de API */
export interface ResourceType {
  group: string
  version: string
  /** Nombre plural de la API, p. ej. `deployments` */
  plural: string
  kind: string
  namespaced: boolean
  verbs: string[]
  shortNames: string[]
  /** Tiene subrecurso `/scale` */
  scalable: boolean
}

export interface KubeconfigFileInfo {
  id: string
  path: string
  /** Se cargó pegando texto: Codycube guarda la copia en sus datos */
  managed: boolean
  error?: string
}

export interface ClusterContext {
  /** `<id de archivo>/<nombre del contexto>` */
  id: string
  fileId: string
  filePath: string
  name: string
  cluster: string
  user: string
  server: string
  namespace?: string
  isCurrent: boolean
  /** Comando que el kubeconfig ejecutará para autenticarse */
  execCommand?: string
  /** El usuario ya aceptó ejecutar ese comando */
  execTrusted: boolean
  readOnly: boolean
}

export interface ClusterInfo {
  version: string
  platform: string
  resources: ResourceType[]
}

export interface WatchEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED'
  object: KubeObject
}

export type WatchMessage =
  | { watchId: string; kind: 'snapshot'; items: KubeObject[] }
  | { watchId: string; kind: 'events'; events: WatchEvent[] }
  | { watchId: string; kind: 'status'; state: 'live' | 'reconnecting'; error?: string }
  | { watchId: string; kind: 'error'; error: string }

export interface LogOptions {
  namespace: string
  pods: { name: string; containers: string[] }[]
  tailLines: number
  previous: boolean
  sinceSeconds?: number
}

export type LogMessage =
  | { streamId: string; kind: 'lines'; lines: LogLine[] }
  | { streamId: string; kind: 'end'; source: string; error?: string }

export interface LogLine {
  pod: string
  container: string
  /** ISO 8601 que entrega el servidor */
  time?: string
  text: string
}

export type TerminalMessage =
  | { terminalId: string; kind: 'data'; data: string }
  | { terminalId: string; kind: 'exit'; error?: string }

export interface PortForwardInfo {
  id: string
  contextId: string
  namespace: string
  resourceKind: 'Pod' | 'Service'
  resourceName: string
  targetPod: string
  remotePort: number
  localPort: number
  connections: number
}

export interface PodMetric {
  namespace: string
  name: string
  cpuMillis: number
  memoryBytes: number
}

export interface NodeMetric {
  name: string
  cpuMillis: number
  memoryBytes: number
}

export interface ClusterMetrics {
  available: boolean
  nodes: NodeMetric[]
  pods: PodMetric[]
}

export interface ApplyResult {
  kind: string
  name: string
  namespace?: string
  action: 'aplicado' | 'simulado'
}

export interface DeploymentRevision {
  revision: number
  replicaSet: string
  images: string[]
  created?: string
  current: boolean
  changeCause?: string
}

export interface DrainReport {
  evicted: string[]
  skipped: string[]
  failed: { pod: string; error: string }[]
}

export interface HelmRelease {
  name: string
  namespace: string
  revision: string
  updated: string
  status: string
  chart: string
  app_version: string
}

export interface HelmRevision {
  revision: number
  updated: string
  status: string
  chart: string
  app_version: string
  description: string
}

export type TopologyNodeKind = 'ingress' | 'service' | 'workload' | 'component' | 'topic' | 'external'

export interface TopologyNode {
  id: string
  kind: TopologyNodeKind
  name: string
  namespace?: string
  subtitle?: string
  /** Objeto de Kubernetes que representa, para abrirlo desde el grafo */
  ref?: { kind: string; namespace?: string; name: string }
  daprAppId?: string
  /** Tipo de componente de Dapr: `pubsub`, `state`, `bindings`… */
  category?: string
  /** Contenedor visual: un tema vive dentro de su broker */
  parent?: string
  pods?: { ready: number; total: number; desired: number }
  /** Services integrados en esta carga al dibujarla */
  services?: string[]
}

/**
 * `route`, `selects` y `declared` salen de la configuración; `invoke`, `publish`, `deliver`,
 * `component` pueden además tener tráfico medido. `observed` distingue siempre una cosa de la otra.
 */
export type TopologyEdgeKind = 'route' | 'selects' | 'declared' | 'invoke' | 'publish' | 'deliver' | 'component'

export interface TrafficPoint {
  /** Segundos desde la época */
  t: number
  rate: number
  errorRate: number
}

export interface EdgeTraffic {
  /** Peticiones por segundo en la ventana reciente */
  rate: number
  /** Fracción de 0 a 1 que falló en esa ventana */
  errorRatio: number
  /** Acumulados desde que arrancaron los sidecars actuales */
  total: number
  errors: number
  p50Ms?: number
  p95Ms?: number
  /** Estados u operaciones en la ventana reciente, por segundo */
  breakdown: { label: string; rate: number; error: boolean }[]
  history: TrafficPoint[]
}

export interface TopologyEdge {
  id: string
  source: string
  target: string
  kind: TopologyEdgeKind
  /** Qué objeto o campo la declara. Sin él, solo se conoce por el tráfico */
  evidence?: string
  /** El sidecar ha medido comunicación por aquí */
  observed: boolean
  traffic?: EdgeTraffic
}

export interface TrafficCoverage {
  /** Sidecars que deberían responder */
  sidecars: number
  scraped: number
  /** Motivo de los que fallaron, sin repetir */
  failures: string[]
  /** Se limitó el número de sidecars consultados */
  truncated: boolean
}

export interface TrafficSnapshot {
  sessionId: string
  at: number
  intervalSeconds: number
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  coverage: TrafficCoverage
  daprInstalled: boolean
  /** La primera lectura solo fija la base: todavía no hay tasas */
  warmingUp: boolean
  error?: string
}

export type DeleteOptions = { propagation?: 'Foreground' | 'Background' | 'Orphan'; force?: boolean }

/** Identifica un objeto concreto en el clúster */
export interface ObjectRef {
  resource: ResourceType
  namespace?: string
  name: string
}

export interface NodeTaint {
  key: string
  value?: string
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
}

/** Una carga que usa un ConfigMap o un Secret, y cómo */
export interface ConfigUser {
  resource: ResourceType
  name: string
  references: string[]
  restartable: boolean
}

export interface Api {
  // Kubeconfig
  'config:list': () => { files: KubeconfigFileInfo[]; contexts: ClusterContext[] }
  'config:pick': () => { files: KubeconfigFileInfo[]; contexts: ClusterContext[] } | null
  'config:add-path': (path: string) => { files: KubeconfigFileInfo[]; contexts: ClusterContext[] }
  'config:add-text': (text: string) => { files: KubeconfigFileInfo[]; contexts: ClusterContext[] }
  'config:remove': (fileId: string) => { files: KubeconfigFileInfo[]; contexts: ClusterContext[] }
  'config:trust-exec': (contextId: string) => void
  'config:set-read-only': (contextId: string, readOnly: boolean) => void

  // Conexión y lectura
  'cluster:connect': (contextId: string) => ClusterInfo
  'cluster:disconnect': (contextId: string) => void
  'cluster:metrics': (contextId: string) => ClusterMetrics
  'resource:list': (contextId: string, resource: ResourceType, namespace?: string) => KubeObject[]
  'resource:get': (contextId: string, ref: ObjectRef) => KubeObject
  'resource:watch': (contextId: string, resource: ResourceType, namespace?: string) => string
  'resource:unwatch': (watchId: string) => void
  'resource:events-for': (contextId: string, object: KubeObject) => KubeObject[]
  'resource:pods-for': (contextId: string, object: KubeObject) => KubeObject[]

  // Cambios
  'resource:update': (contextId: string, ref: ObjectRef, yamlText: string) => KubeObject
  'resource:apply': (contextId: string, yamlText: string, defaultNamespace: string | undefined, dryRun: boolean) => ApplyResult[]
  'resource:delete': (contextId: string, ref: ObjectRef, options: DeleteOptions) => void
  'resource:scale': (contextId: string, ref: ObjectRef, replicas: number) => void
  'resource:restart': (contextId: string, ref: ObjectRef) => void
  'deployment:revisions': (contextId: string, namespace: string, name: string) => DeploymentRevision[]
  'deployment:rollback': (contextId: string, namespace: string, name: string, revision: number) => void
  'node:cordon': (contextId: string, name: string, unschedulable: boolean) => void
  'node:drain': (contextId: string, name: string, options: { force: boolean }) => DrainReport
  /** Valores de Secret en base64; los de ConfigMap en `data` como texto y en `binaryData` en base64 */
  'resource:set-data': (contextId: string, ref: ObjectRef, resourceVersion: string, payload: { data: Record<string, string>; binaryData?: Record<string, string> }) => KubeObject
  'resource:set-metadata': (contextId: string, ref: ObjectRef, resourceVersion: string, labels: Record<string, string>, annotations: Record<string, string>) => KubeObject
  'resource:create': (contextId: string, object: KubeObject) => KubeObject
  'resource:set-images': (contextId: string, ref: ObjectRef, changes: { container: string; image: string; init?: boolean }[]) => void
  'resource:config-users': (contextId: string, kind: 'ConfigMap' | 'Secret', namespace: string, name: string) => ConfigUser[]
  'deployment:pause': (contextId: string, namespace: string, name: string, paused: boolean) => void
  'node:taints': (contextId: string, name: string, resourceVersion: string, taints: NodeTaint[]) => KubeObject
  'cronjob:suspend': (contextId: string, namespace: string, name: string, suspend: boolean) => void
  'cronjob:trigger': (contextId: string, namespace: string, name: string) => string

  // Registros
  'logs:start': (contextId: string, options: LogOptions) => string
  'logs:stop': (streamId: string) => void
  'logs:save': (fileName: string, content: string) => string | null

  // Terminal en el pod
  'exec:start': (contextId: string, namespace: string, pod: string, container: string, cols: number, rows: number) => string
  'exec:input': (terminalId: string, data: string) => void
  'exec:resize': (terminalId: string, cols: number, rows: number) => void
  'exec:stop': (terminalId: string) => void

  // Reenvío de puertos
  'forward:list': () => PortForwardInfo[]
  'forward:start': (
    contextId: string,
    namespace: string,
    kind: 'Pod' | 'Service',
    name: string,
    remotePort: number,
    localPort: number
  ) => PortForwardInfo
  'forward:stop': (id: string) => void
  'forward:open': (id: string) => void

  // Helm (usa la CLI de helm instalada)
  'helm:available': () => string | null
  'helm:list': (contextId: string, namespace?: string) => HelmRelease[]
  'helm:history': (contextId: string, namespace: string, name: string) => HelmRevision[]
  'helm:values': (contextId: string, namespace: string, name: string) => string
  'helm:manifest': (contextId: string, namespace: string, name: string) => string
  'helm:rollback': (contextId: string, namespace: string, name: string, revision: number) => void
  'helm:uninstall': (contextId: string, namespace: string, name: string) => void
  'helm:install': (contextId: string, namespace: string, name: string, chart: string, values: string) => void

  // Arquitectura y tráfico
  /** `namespaces` vacío: todos */
  'traffic:start': (contextId: string, namespaces: string[], intervalSeconds: number) => string
  'traffic:stop': (sessionId: string) => void
}

export type ApiMethod = keyof Api

export interface Bridge {
  invoke<M extends ApiMethod>(method: M, ...args: Parameters<Api[M]>): Promise<ReturnType<Api[M]>>
  onWatch(callback: (message: WatchMessage) => void): () => void
  onLogs(callback: (message: LogMessage) => void): () => void
  onTerminal(callback: (message: TerminalMessage) => void): () => void
  onForwards(callback: (forwards: PortForwardInfo[]) => void): () => void
  onTraffic(callback: (snapshot: TrafficSnapshot) => void): () => void
  onConfigChanged(callback: () => void): () => void
  /** Ruta real de un archivo soltado sobre la ventana */
  pathForFile(file: File): string
  platform: string
}
