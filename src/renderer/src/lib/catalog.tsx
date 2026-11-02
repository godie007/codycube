import type { KubeObject, ResourceType } from '../../../shared/types'
import { age, formatBytes, formatCpu, podStatus, readyCount, restarts, statusTone } from './format'

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

export interface Column {
  title: string
  value: (object: KubeObject) => string | number | undefined
  tone?: (object: KubeObject) => Tone | undefined
  /** Valor para ordenar cuando el texto no sirve (p. ej. edades) */
  sort?: (object: KubeObject) => number | string
  width?: string
  mono?: boolean
}

const AGE: Column = {
  title: 'Edad',
  value: (o) => age(o.metadata.creationTimestamp),
  sort: (o) => -(Date.parse(o.metadata.creationTimestamp ?? '') || 0),
  width: '80px'
}

const replicas = (o: KubeObject): string => `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}`
const replicasTone = (o: KubeObject): Tone => {
  const want = o.spec?.replicas ?? 0
  if (want === 0) return 'muted'
  return (o.status?.readyReplicas ?? 0) >= want ? 'ok' : 'warn'
}
const conditionTrue = (o: KubeObject, type: string): boolean =>
  (o.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === type && c.status === 'True')

const nodeRoles = (o: KubeObject): string =>
  Object.keys(o.metadata.labels ?? {})
    .filter((label) => label.startsWith('node-role.kubernetes.io/'))
    .map((label) => label.split('/')[1])
    .join(', ') || 'worker'

const nodeStatus = (o: KubeObject): string =>
  (conditionTrue(o, 'Ready') ? 'Ready' : 'NotReady') + (o.spec?.unschedulable ? ', SchedulingDisabled' : '')

const servicePorts = (o: KubeObject): string =>
  (o.spec?.ports ?? [])
    .map((p: { port: number; protocol?: string; nodePort?: number }) =>
      `${p.port}${p.nodePort ? `:${p.nodePort}` : ''}/${p.protocol ?? 'TCP'}`)
    .join(', ')

const externalIp = (o: KubeObject): string =>
  (o.status?.loadBalancer?.ingress ?? [])
    .map((i: { ip?: string; hostname?: string }) => i.ip ?? i.hostname)
    .join(', ') || (o.spec?.externalIPs ?? []).join(', ') || '—'

const count = (value: unknown): number => (value && typeof value === 'object' ? Object.keys(value).length : 0)

/** Columnas por tipo. Los tipos no listados y los recursos personalizados usan las genéricas */
const COLUMNS: Record<string, Column[]> = {
  Pod: [
    { title: 'Listos', value: readyCount, width: '70px' },
    { title: 'Estado', value: podStatus, tone: (o) => statusTone(podStatus(o)), width: '170px' },
    { title: 'Reinicios', value: restarts, sort: restarts, width: '80px', tone: (o) => (restarts(o) > 0 ? 'warn' : undefined) },
    { title: 'Nodo', value: (o) => o.spec?.nodeName, mono: false },
    { title: 'IP', value: (o) => o.status?.podIP, width: '120px', mono: true },
    AGE
  ],
  Deployment: [
    { title: 'Listos', value: replicas, tone: replicasTone, width: '80px' },
    { title: 'Actualizados', value: (o) => o.status?.updatedReplicas ?? 0, width: '100px' },
    { title: 'Disponibles', value: (o) => o.status?.availableReplicas ?? 0, width: '90px' },
    { title: 'Estrategia', value: (o) => o.spec?.strategy?.type },
    AGE
  ],
  StatefulSet: [
    { title: 'Listos', value: replicas, tone: replicasTone, width: '80px' },
    { title: 'Servicio', value: (o) => o.spec?.serviceName },
    AGE
  ],
  DaemonSet: [
    { title: 'Deseados', value: (o) => o.status?.desiredNumberScheduled ?? 0, width: '80px' },
    {
      title: 'Listos',
      value: (o) => o.status?.numberReady ?? 0,
      width: '70px',
      tone: (o) => ((o.status?.numberReady ?? 0) >= (o.status?.desiredNumberScheduled ?? 0) ? 'ok' : 'warn')
    },
    { title: 'Selector de nodos', value: (o) => Object.entries(o.spec?.template?.spec?.nodeSelector ?? {}).map(([k, v]) => `${k}=${v}`).join(', ') },
    AGE
  ],
  ReplicaSet: [{ title: 'Listos', value: replicas, tone: replicasTone, width: '80px' }, { title: 'Dueño', value: (o) => o.metadata.ownerReferences?.[0]?.name }, AGE],
  ReplicationController: [{ title: 'Listos', value: replicas, tone: replicasTone, width: '80px' }, AGE],
  Job: [
    { title: 'Completados', value: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}`, width: '100px' },
    {
      title: 'Estado',
      value: (o) => (conditionTrue(o, 'Complete') ? 'Completo' : conditionTrue(o, 'Failed') ? 'Fallido' : o.status?.active ? 'Activo' : 'Pendiente'),
      tone: (o) => (conditionTrue(o, 'Complete') ? 'ok' : conditionTrue(o, 'Failed') ? 'bad' : 'warn'),
      width: '100px'
    },
    AGE
  ],
  CronJob: [
    { title: 'Programación', value: (o) => o.spec?.schedule, mono: true },
    { title: 'Suspendido', value: (o) => (o.spec?.suspend ? 'Sí' : 'No'), tone: (o) => (o.spec?.suspend ? 'warn' : undefined), width: '90px' },
    { title: 'Activos', value: (o) => (o.status?.active ?? []).length, width: '70px' },
    { title: 'Última ejecución', value: (o) => age(o.status?.lastScheduleTime), width: '120px' },
    AGE
  ],
  Node: [
    { title: 'Estado', value: nodeStatus, tone: (o) => (o.spec?.unschedulable ? 'warn' : conditionTrue(o, 'Ready') ? 'ok' : 'bad'), width: '200px' },
    { title: 'Roles', value: nodeRoles },
    { title: 'Versión', value: (o) => o.status?.nodeInfo?.kubeletVersion, width: '130px' },
    { title: 'CPU', value: (o) => formatCpu(o.status?.capacity?.cpu), width: '80px' },
    { title: 'Memoria', value: (o) => formatBytes(o.status?.capacity?.memory), width: '100px' },
    AGE
  ],
  Namespace: [{ title: 'Estado', value: (o) => o.status?.phase, tone: (o) => (o.status?.phase === 'Active' ? 'ok' : 'warn'), width: '120px' }, AGE],
  Service: [
    { title: 'Tipo', value: (o) => o.spec?.type, width: '120px' },
    { title: 'IP de clúster', value: (o) => o.spec?.clusterIP, mono: true, width: '130px' },
    { title: 'IP externa', value: externalIp, mono: true },
    { title: 'Puertos', value: servicePorts, mono: true },
    AGE
  ],
  Ingress: [
    { title: 'Clase', value: (o) => o.spec?.ingressClassName, width: '120px' },
    { title: 'Hosts', value: (o) => (o.spec?.rules ?? []).map((r: { host?: string }) => r.host ?? '*').join(', ') },
    { title: 'Dirección', value: externalIp, mono: true },
    AGE
  ],
  ConfigMap: [{ title: 'Claves', value: (o) => count(o.data) + count(o.binaryData), width: '80px' }, AGE],
  Secret: [{ title: 'Tipo', value: (o) => o.type }, { title: 'Claves', value: (o) => count(o.data), width: '80px' }, AGE],
  PersistentVolumeClaim: [
    { title: 'Estado', value: (o) => o.status?.phase, tone: (o) => (o.status?.phase === 'Bound' ? 'ok' : 'warn'), width: '100px' },
    { title: 'Volumen', value: (o) => o.spec?.volumeName },
    { title: 'Capacidad', value: (o) => o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage, width: '100px' },
    { title: 'Clase', value: (o) => o.spec?.storageClassName, width: '140px' },
    AGE
  ],
  PersistentVolume: [
    { title: 'Capacidad', value: (o) => o.spec?.capacity?.storage, width: '100px' },
    { title: 'Estado', value: (o) => o.status?.phase, tone: (o) => (o.status?.phase === 'Bound' ? 'ok' : 'warn'), width: '100px' },
    { title: 'Reclamo', value: (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : '—') },
    { title: 'Clase', value: (o) => o.spec?.storageClassName, width: '140px' },
    AGE
  ],
  StorageClass: [{ title: 'Provisionador', value: (o) => o.provisioner }, { title: 'Retención', value: (o) => o.reclaimPolicy, width: '100px' }, AGE],
  Event: [
    { title: 'Tipo', value: (o) => o.type, tone: (o) => (o.type === 'Warning' ? 'warn' : undefined), width: '90px' },
    { title: 'Motivo', value: (o) => o.reason, width: '140px' },
    { title: 'Objeto', value: (o) => `${o.involvedObject?.kind}/${o.involvedObject?.name}` },
    { title: 'Mensaje', value: (o) => o.message },
    {
      title: 'Última vez',
      value: (o) => age(o.lastTimestamp ?? o.eventTime),
      sort: (o) => -(Date.parse(o.lastTimestamp ?? o.eventTime ?? '') || 0),
      width: '90px'
    }
  ],
  HorizontalPodAutoscaler: [
    { title: 'Objetivo', value: (o) => `${o.spec?.scaleTargetRef?.kind}/${o.spec?.scaleTargetRef?.name}` },
    { title: 'Mín', value: (o) => o.spec?.minReplicas, width: '60px' },
    { title: 'Máx', value: (o) => o.spec?.maxReplicas, width: '60px' },
    { title: 'Réplicas', value: (o) => o.status?.currentReplicas, width: '80px' },
    AGE
  ],
  PodDisruptionBudget: [
    { title: 'Mín disp.', value: (o) => o.spec?.minAvailable, width: '90px' },
    { title: 'Máx no disp.', value: (o) => o.spec?.maxUnavailable, width: '100px' },
    { title: 'Permitidas', value: (o) => o.status?.disruptionsAllowed, width: '90px' },
    AGE
  ],
  ServiceAccount: [{ title: 'Secretos', value: (o) => (o.secrets ?? []).length, width: '80px' }, AGE],
  RoleBinding: [{ title: 'Rol', value: (o) => `${o.roleRef?.kind}/${o.roleRef?.name}` }, { title: 'Sujetos', value: (o) => (o.subjects ?? []).map((s: { name: string }) => s.name).join(', ') }, AGE],
  ClusterRoleBinding: [{ title: 'Rol', value: (o) => `${o.roleRef?.kind}/${o.roleRef?.name}` }, { title: 'Sujetos', value: (o) => (o.subjects ?? []).map((s: { name: string }) => s.name).join(', ') }, AGE],
  CustomResourceDefinition: [
    { title: 'Grupo', value: (o) => o.spec?.group },
    { title: 'Tipo', value: (o) => o.spec?.names?.kind },
    { title: 'Alcance', value: (o) => o.spec?.scope, width: '110px' },
    AGE
  ]
}

export const columnsFor = (kind: string): Column[] => COLUMNS[kind] ?? [AGE]

export interface SidebarEntry {
  kind?: string
  group?: string
  label: string
  /** Página propia en lugar de una tabla de recursos */
  page?: 'overview' | 'architecture' | 'helm' | 'forwards'
}

export interface SidebarSection {
  title: string
  entries: SidebarEntry[]
}

export const SIDEBAR: SidebarSection[] = [
  { title: 'Clúster', entries: [{ label: 'Resumen', page: 'overview' }, { label: 'Arquitectura', page: 'architecture' }, { label: 'Nodos', kind: 'Node' }, { label: 'Namespaces', kind: 'Namespace' }, { label: 'Eventos', kind: 'Event' }] },
  {
    title: 'Cargas de trabajo',
    entries: [
      { label: 'Pods', kind: 'Pod' },
      { label: 'Deployments', kind: 'Deployment' },
      { label: 'StatefulSets', kind: 'StatefulSet' },
      { label: 'DaemonSets', kind: 'DaemonSet' },
      { label: 'ReplicaSets', kind: 'ReplicaSet' },
      { label: 'ReplicationControllers', kind: 'ReplicationController' },
      { label: 'Jobs', kind: 'Job' },
      { label: 'CronJobs', kind: 'CronJob' }
    ]
  },
  {
    title: 'Configuración',
    entries: [
      { label: 'ConfigMaps', kind: 'ConfigMap' },
      { label: 'Secrets', kind: 'Secret' },
      { label: 'ResourceQuotas', kind: 'ResourceQuota' },
      { label: 'LimitRanges', kind: 'LimitRange' },
      { label: 'HPA', kind: 'HorizontalPodAutoscaler' },
      { label: 'VPA', kind: 'VerticalPodAutoscaler' },
      { label: 'PodDisruptionBudgets', kind: 'PodDisruptionBudget' },
      { label: 'PriorityClasses', kind: 'PriorityClass' },
      { label: 'RuntimeClasses', kind: 'RuntimeClass' },
      { label: 'Leases', kind: 'Lease' },
      { label: 'MutatingWebhooks', kind: 'MutatingWebhookConfiguration' },
      { label: 'ValidatingWebhooks', kind: 'ValidatingWebhookConfiguration' },
      { label: 'ValidatingAdmissionPolicies', kind: 'ValidatingAdmissionPolicy' }
    ]
  },
  {
    title: 'Red',
    entries: [
      { label: 'Services', kind: 'Service' },
      { label: 'Endpoints', kind: 'Endpoints' },
      { label: 'EndpointSlices', kind: 'EndpointSlice' },
      { label: 'Ingresses', kind: 'Ingress' },
      { label: 'IngressClasses', kind: 'IngressClass' },
      { label: 'NetworkPolicies', kind: 'NetworkPolicy' },
      { label: 'Reenvío de puertos', page: 'forwards' }
    ]
  },
  {
    title: 'Almacenamiento',
    entries: [
      { label: 'PersistentVolumeClaims', kind: 'PersistentVolumeClaim' },
      { label: 'PersistentVolumes', kind: 'PersistentVolume' },
      { label: 'StorageClasses', kind: 'StorageClass' },
      { label: 'VolumeAttachments', kind: 'VolumeAttachment' },
      { label: 'CSIDrivers', kind: 'CSIDriver' },
      { label: 'CSINodes', kind: 'CSINode' }
    ]
  },
  {
    title: 'Control de acceso',
    entries: [
      { label: 'ServiceAccounts', kind: 'ServiceAccount' },
      { label: 'Roles', kind: 'Role' },
      { label: 'RoleBindings', kind: 'RoleBinding' },
      { label: 'ClusterRoles', kind: 'ClusterRole' },
      { label: 'ClusterRoleBindings', kind: 'ClusterRoleBinding' }
    ]
  },
  { title: 'Helm', entries: [{ label: 'Releases', page: 'helm' }] }
]

const LISTED_KINDS = new Set(SIDEBAR.flatMap((section) => section.entries.map((entry) => entry.kind)))

/** Grupos que trae Kubernetes de fábrica: lo demás viene de CRD o de un APIService de terceros */
const BUILTIN_GROUP = /(^$|\.k8s\.io$|^(apps|batch|autoscaling|policy|extensions)$)/

/** Resuelve la entrada de la barra lateral contra lo que de verdad sirve el clúster */
export function findResource(resources: ResourceType[], entry: SidebarEntry): ResourceType | undefined {
  return resources.find((r) => r.kind === entry.kind && (entry.group === undefined || r.group === entry.group))
}

/** Recursos sin sitio en las secciones fijas, agrupados por grupo de API */
export function customResourceGroups(resources: ResourceType[]): { group: string; resources: ResourceType[] }[] {
  const groups = new Map<string, ResourceType[]>()
  for (const resource of resources) {
    if (LISTED_KINDS.has(resource.kind)) continue
    if (BUILTIN_GROUP.test(resource.group) && resource.kind !== 'CustomResourceDefinition') continue
    if (resource.group === 'metrics.k8s.io') continue
    groups.set(resource.group, [...(groups.get(resource.group) ?? []), resource])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({ group, resources: list.sort((a, b) => a.kind.localeCompare(b.kind)) }))
}

const LOG_KINDS = new Set(['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'ReplicationController', 'Job', 'CronJob', 'Service'])
const RESTART_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet'])

export const supportsLogs = (kind: string): boolean => LOG_KINDS.has(kind)
export const supportsRestart = (kind: string): boolean => RESTART_KINDS.has(kind)
