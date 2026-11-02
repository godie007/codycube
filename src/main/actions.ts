import yaml from 'js-yaml'
import type {
  ApplyResult,
  ClusterMetrics,
  DeleteOptions,
  DeploymentRevision,
  DrainReport,
  KubeObject,
  ObjectRef
} from '../shared/types'
import { KubeApiError, type KubeClient, resourcePath, slim } from './kube-client'

const FIELD_MANAGER = 'codycube'
const MERGE_PATCH = 'application/merge-patch+json'

const CORE = (plural: string, kind: string, namespaced = true) => ({
  group: '',
  version: 'v1',
  plural,
  kind,
  namespaced,
  verbs: [],
  shortNames: [],
  scalable: false
})
const PODS = CORE('pods', 'Pod')
const EVENTS = CORE('events', 'Event')
const NODES = CORE('nodes', 'Node', false)

export const apiGroup = (group: string, version: string, plural: string, kind: string, namespaced = true) => ({
  ...CORE(plural, kind, namespaced),
  group,
  version
})

export function parseDocuments(text: string): KubeObject[] {
  const docs: KubeObject[] = []
  yaml.loadAll(text, (doc) => {
    if (doc === null || doc === undefined) return
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Cada documento YAML debe ser un objeto')
    const object = doc as KubeObject
    if (object.kind === 'List' && Array.isArray(object.items)) docs.push(...(object.items as KubeObject[]))
    else docs.push(object)
  })
  for (const doc of docs) {
    if (!doc.apiVersion || !doc.kind) throw new Error('Falta apiVersion o kind en un documento')
    if (!doc.metadata?.name && !doc.metadata?.generateName) {
      throw new Error(`Falta metadata.name en un documento de tipo ${doc.kind}`)
    }
  }
  return docs
}

export async function getObject(client: KubeClient, ref: ObjectRef): Promise<KubeObject> {
  const object = await client.json<KubeObject>(resourcePath(ref.resource, ref.namespace, ref.name))
  const { resource } = ref
  return slim({ ...object, kind: resource.kind, apiVersion: resource.group ? `${resource.group}/${resource.version}` : resource.version })
}

/** Guarda una edición con PUT: conserva `resourceVersion`, así que un cambio concurrente da conflicto en vez de pisarlo */
export async function updateFromYaml(client: KubeClient, ref: ObjectRef, text: string): Promise<KubeObject> {
  const docs = parseDocuments(text)
  if (docs.length !== 1) throw new Error('Una edición debe contener exactamente un documento')
  const [object] = docs
  if (object.metadata.name !== ref.name) throw new Error('No se puede cambiar metadata.name al editar')
  if (ref.namespace && object.metadata.namespace !== ref.namespace) {
    throw new Error('No se puede cambiar metadata.namespace al editar')
  }
  const updated = await client.json<KubeObject>(resourcePath(ref.resource, ref.namespace, ref.name), {
    method: 'PUT',
    body: object,
    query: { fieldManager: FIELD_MANAGER }
  })
  return slim(updated)
}

/** Crea o actualiza varios documentos con server-side apply. `dryRun` los valida sin persistir nada */
export async function applyYaml(
  client: KubeClient,
  text: string,
  defaultNamespace: string | undefined,
  dryRun: boolean
): Promise<ApplyResult[]> {
  const docs = parseDocuments(text)
  if (docs.length === 0) throw new Error('El YAML está vacío')
  const results: ApplyResult[] = []
  for (const doc of docs) {
    const resource = await client.findKind(doc.apiVersion!, doc.kind!)
    const namespace = resource.namespaced ? (doc.metadata.namespace ?? defaultNamespace ?? 'default') : undefined
    const body = { ...doc, metadata: { ...doc.metadata, ...(namespace ? { namespace } : {}) } }
    const query = { fieldManager: FIELD_MANAGER, dryRun: dryRun ? 'All' : undefined }
    if (doc.metadata.name) {
      await client.json(resourcePath(resource, namespace, doc.metadata.name), {
        method: 'PATCH',
        contentType: 'application/apply-patch+yaml',
        body: JSON.stringify(body),
        query: { ...query, force: true }
      })
    } else {
      await client.json(resourcePath(resource, namespace), { method: 'POST', body, query })
    }
    results.push({
      kind: doc.kind!,
      name: doc.metadata.name ?? `${doc.metadata.generateName}*`,
      namespace,
      action: dryRun ? 'simulado' : 'aplicado'
    })
  }
  return results
}

export async function deleteObject(client: KubeClient, ref: ObjectRef, options: DeleteOptions): Promise<void> {
  await client.json(resourcePath(ref.resource, ref.namespace, ref.name), {
    method: 'DELETE',
    body: {
      kind: 'DeleteOptions',
      apiVersion: 'v1',
      ...(options.propagation ? { propagationPolicy: options.propagation } : {}),
      ...(options.force ? { gracePeriodSeconds: 0 } : {})
    }
  })
}

export async function scale(client: KubeClient, ref: ObjectRef, replicas: number): Promise<void> {
  if (!Number.isInteger(replicas) || replicas < 0) throw new Error('Las réplicas deben ser un entero no negativo')
  await client.json(resourcePath(ref.resource, ref.namespace, ref.name, 'scale'), {
    method: 'PATCH',
    contentType: MERGE_PATCH,
    body: { spec: { replicas } }
  })
}

/** Igual que `kubectl rollout restart`: cambia una anotación de la plantilla para recrear los pods */
export async function restart(client: KubeClient, ref: ObjectRef, now = new Date()): Promise<void> {
  await client.json(resourcePath(ref.resource, ref.namespace, ref.name), {
    method: 'PATCH',
    contentType: MERGE_PATCH,
    body: {
      spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': now.toISOString() } } } }
    }
  })
}

const REVISION = 'deployment.kubernetes.io/revision'
const DEPLOYMENTS = apiGroup('apps', 'v1', 'deployments', 'Deployment')
const REPLICASETS = apiGroup('apps', 'v1', 'replicasets', 'ReplicaSet')

async function revisionSets(client: KubeClient, namespace: string, name: string): Promise<{ deployment: KubeObject; sets: KubeObject[] }> {
  const deployment = await client.json<KubeObject>(resourcePath(DEPLOYMENTS, namespace, name))
  const sets = (await client.listItems(REPLICASETS, namespace)).filter((rs) =>
    rs.metadata.ownerReferences?.some((owner) => owner.uid === deployment.metadata.uid)
  )
  return { deployment, sets }
}

export async function deploymentRevisions(client: KubeClient, namespace: string, name: string): Promise<DeploymentRevision[]> {
  const { deployment, sets } = await revisionSets(client, namespace, name)
  const current = Number(deployment.metadata.annotations?.[REVISION] ?? 0)
  return sets
    .map((rs) => {
      const revision = Number(rs.metadata.annotations?.[REVISION] ?? 0)
      return {
        revision,
        replicaSet: rs.metadata.name,
        images: (rs.spec?.template?.spec?.containers ?? []).map((c: { image: string }) => c.image),
        created: rs.metadata.creationTimestamp,
        current: revision === current,
        changeCause: rs.metadata.annotations?.['kubernetes.io/change-cause']
      }
    })
    .sort((a, b) => b.revision - a.revision)
}

/** Vuelve a una revisión copiando su plantilla, como `kubectl rollout undo` */
export async function rollback(client: KubeClient, namespace: string, name: string, revision: number): Promise<void> {
  const { sets } = await revisionSets(client, namespace, name)
  const target = sets.find((rs) => Number(rs.metadata.annotations?.[REVISION]) === revision)
  if (!target) throw new Error(`No existe la revisión ${revision}`)
  const template = structuredClone(target.spec.template)
  // Esta etiqueta la gestiona el controlador; no forma parte de la plantilla de la Deployment
  delete template.metadata?.labels?.['pod-template-hash']
  await client.json(resourcePath(DEPLOYMENTS, namespace, name), {
    method: 'PATCH',
    contentType: 'application/json-patch+json',
    body: [{ op: 'replace', path: '/spec/template', value: template }]
  })
}

export async function cordon(client: KubeClient, name: string, unschedulable: boolean): Promise<void> {
  await client.json(resourcePath(NODES, undefined, name), {
    method: 'PATCH',
    contentType: MERGE_PATCH,
    body: { spec: { unschedulable } }
  })
}

/** Decide si un pod se puede desalojar, con las mismas reglas de `kubectl drain` */
export function drainDecision(pod: KubeObject, force: boolean): { evict: boolean; reason?: string } {
  const annotations = pod.metadata.annotations ?? {}
  if (annotations['kubernetes.io/config.mirror']) return { evict: false, reason: 'pod estático' }
  const controller = pod.metadata.ownerReferences?.find((owner) => owner.controller)
  if (controller?.kind === 'DaemonSet') return { evict: false, reason: 'DaemonSet' }
  const phase = pod.status?.phase
  if (phase === 'Succeeded' || phase === 'Failed') return { evict: true }
  if (!controller && !force) return { evict: false, reason: 'sin controlador: se perdería (usa forzar)' }
  return { evict: true }
}

export async function drain(client: KubeClient, name: string, options: { force: boolean }): Promise<DrainReport> {
  await cordon(client, name, true)
  const list = await client.json<{ items: KubeObject[] }>(resourcePath(PODS), {
    query: { fieldSelector: `spec.nodeName=${name}` }
  })
  const report: DrainReport = { evicted: [], skipped: [], failed: [] }
  for (const pod of list.items) {
    const label = `${pod.metadata.namespace}/${pod.metadata.name}`
    const decision = drainDecision(pod, options.force)
    if (!decision.evict) {
      report.skipped.push(`${label} (${decision.reason})`)
      continue
    }
    try {
      await evict(client, pod)
      report.evicted.push(label)
    } catch (error) {
      report.failed.push({ pod: label, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return report
}

/** Un PodDisruptionBudget responde 429 mientras no se pueda desalojar: se reintenta un tiempo acotado */
async function evict(client: KubeClient, pod: KubeObject, attempts = 12, delayMs = 5000): Promise<void> {
  const { name, namespace } = pod.metadata
  for (let attempt = 1; ; attempt++) {
    try {
      await client.json(resourcePath(PODS, namespace, name, 'eviction'), {
        method: 'POST',
        body: { apiVersion: 'policy/v1', kind: 'Eviction', metadata: { name, namespace } }
      })
      return
    } catch (error) {
      if (error instanceof KubeApiError && error.status === 404) return
      if (!(error instanceof KubeApiError && error.status === 429) || attempt >= attempts) throw error
      await new Promise((done) => setTimeout(done, delayMs))
    }
  }
}

const CRONJOBS = apiGroup('batch', 'v1', 'cronjobs', 'CronJob')
const JOBS = apiGroup('batch', 'v1', 'jobs', 'Job')

export async function suspendCronJob(client: KubeClient, namespace: string, name: string, suspend: boolean): Promise<void> {
  await client.json(resourcePath(CRONJOBS, namespace, name), {
    method: 'PATCH',
    contentType: MERGE_PATCH,
    body: { spec: { suspend } }
  })
}

/** Lanza una ejecución ahora, como `kubectl create job --from=cronjob/…`. Devuelve el nombre del Job */
export async function triggerCronJob(client: KubeClient, namespace: string, name: string, now = Date.now()): Promise<string> {
  const cron = await client.json<KubeObject>(resourcePath(CRONJOBS, namespace, name))
  const suffix = `-manual-${Math.floor(now / 1000).toString(36)}`
  const jobName = `${name.slice(0, 63 - suffix.length)}${suffix}`
  const template = cron.spec.jobTemplate
  await client.json(resourcePath(JOBS, namespace), {
    method: 'POST',
    query: { fieldManager: FIELD_MANAGER },
    body: {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace,
        labels: template.metadata?.labels,
        annotations: { ...template.metadata?.annotations, 'cronjob.kubernetes.io/instantiate': 'manual' },
        ownerReferences: [
          { apiVersion: 'batch/v1', kind: 'CronJob', name, uid: cron.metadata.uid, controller: true, blockOwnerDeletion: true }
        ]
      },
      spec: template.spec
    }
  })
  return jobName
}

/** Eventos del objeto, más recientes primero */
export async function eventsFor(client: KubeClient, object: KubeObject): Promise<KubeObject[]> {
  const { name, namespace, uid } = object.metadata
  const selector = [`involvedObject.name=${name}`, object.kind ? `involvedObject.kind=${object.kind}` : '', uid ? `involvedObject.uid=${uid}` : '']
    .filter(Boolean)
    .join(',')
  const list = await client.json<{ items: KubeObject[] }>(resourcePath(EVENTS, namespace), {
    query: { fieldSelector: selector }
  })
  const when = (event: KubeObject): number =>
    Date.parse(event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp ?? '') || 0
  return list.items.map(slim).sort((a, b) => when(b) - when(a))
}

type Selector = { matchLabels?: Record<string, string>; matchExpressions?: { key: string; operator: string; values?: string[] }[] }

export function labelSelector(selector: Selector | Record<string, string> | undefined): string | undefined {
  if (!selector) return undefined
  const structured = selector as Selector
  const isStructured = 'matchLabels' in selector || 'matchExpressions' in selector
  const labels = isStructured ? (structured.matchLabels ?? {}) : (selector as Record<string, string>)
  const parts = Object.entries(labels).map(([key, value]) => `${key}=${value}`)
  for (const { key, operator, values } of isStructured ? (structured.matchExpressions ?? []) : []) {
    if (operator === 'In') parts.push(`${key} in (${values?.join(',')})`)
    else if (operator === 'NotIn') parts.push(`${key} notin (${values?.join(',')})`)
    else if (operator === 'Exists') parts.push(key)
    else if (operator === 'DoesNotExist') parts.push(`!${key}`)
  }
  return parts.length ? parts.join(',') : undefined
}

/** Pods que gobierna un objeto, para sus detalles y sus registros */
export async function podsFor(client: KubeClient, object: KubeObject): Promise<KubeObject[]> {
  const { namespace, name } = object.metadata
  const list = async (query: Record<string, string>, ns = namespace): Promise<KubeObject[]> => {
    const result = await client.json<{ items: KubeObject[] }>(resourcePath(PODS, ns), { query })
    return result.items.map((pod) => slim({ ...pod, kind: 'Pod', apiVersion: 'v1' }))
  }
  switch (object.kind) {
    case 'Pod':
      return [object]
    case 'Node':
      return list({ fieldSelector: `spec.nodeName=${name}` }, undefined)
    case 'Namespace':
      return list({}, name)
    case 'CronJob': {
      const jobs = (await client.listItems(JOBS, namespace)).filter((job) =>
        job.metadata.ownerReferences?.some((owner) => owner.uid === object.metadata.uid)
      )
      return (await Promise.all(jobs.map((job) => list({ labelSelector: `job-name=${job.metadata.name}` })))).flat()
    }
    case 'Service': {
      const selector = labelSelector(object.spec?.selector)
      return selector ? list({ labelSelector: selector }) : []
    }
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'ReplicaSet':
    case 'ReplicationController':
    case 'Job': {
      const selector = labelSelector(object.spec?.selector)
      return selector ? list({ labelSelector: selector }) : []
    }
    default:
      return []
  }
}

/** Convierte `250m`, `1`, `1500u`, `2000000n` a milésimas de núcleo */
export function parseCpu(value: string | undefined): number {
  if (!value) return 0
  const match = /^([\d.]+)([numk]?)$/.exec(value)
  if (!match) return 0
  const factor = { n: 1e-6, u: 1e-3, m: 1, '': 1000, k: 1e6 }[match[2]] ?? 0
  return Number(match[1]) * factor
}

/** Convierte `128Mi`, `1Gi`, `1G`, `1000` a bytes */
export function parseMemory(value: string | undefined): number {
  if (!value) return 0
  const match = /^([\d.]+)([A-Za-z]*)$/.exec(value)
  if (!match) return 0
  const units: Record<string, number> = {
    '': 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50
  }
  return Number(match[1]) * (units[match[2]] ?? 0)
}

/** Consumo real desde metrics-server. Si no está instalado se informa como no disponible, sin error */
export async function clusterMetrics(client: KubeClient): Promise<ClusterMetrics> {
  try {
    const [nodes, pods] = await Promise.all([
      client.json<{ items: { metadata: { name: string }; usage: { cpu: string; memory: string } }[] }>('/apis/metrics.k8s.io/v1beta1/nodes'),
      client.json<{ items: { metadata: { name: string; namespace: string }; containers: { usage: { cpu: string; memory: string } }[] }[] }>('/apis/metrics.k8s.io/v1beta1/pods')
    ])
    return {
      available: true,
      nodes: nodes.items.map((n) => ({
        name: n.metadata.name,
        cpuMillis: parseCpu(n.usage.cpu),
        memoryBytes: parseMemory(n.usage.memory)
      })),
      pods: pods.items.map((p) => ({
        name: p.metadata.name,
        namespace: p.metadata.namespace,
        cpuMillis: p.containers.reduce((sum, c) => sum + parseCpu(c.usage.cpu), 0),
        memoryBytes: p.containers.reduce((sum, c) => sum + parseMemory(c.usage.memory), 0)
      }))
    }
  } catch (error) {
    if (error instanceof KubeApiError) return { available: false, nodes: [], pods: [] }
    throw error
  }
}

/**
 * Lee, cambia y guarda con PUT conservando la `resourceVersion` que vio la persona: si alguien cambió
 * el objeto entretanto, el servidor responde con conflicto y no se pisa su cambio.
 */
async function editObject(client: KubeClient, ref: ObjectRef, resourceVersion: string, change: (object: KubeObject) => void): Promise<KubeObject> {
  const path = resourcePath(ref.resource, ref.namespace, ref.name)
  const current = await client.json<KubeObject>(path)
  if (current.metadata.resourceVersion !== resourceVersion) {
    throw new Error(`${ref.name} cambió en el clúster desde que lo abriste. Recarga y vuelve a aplicar tu cambio.`)
  }
  change(current)
  try {
    return slim(await client.json<KubeObject>(path, { method: 'PUT', body: current, query: { fieldManager: FIELD_MANAGER } }))
  } catch (error) {
    if (error instanceof KubeApiError && error.status === 409) {
      throw new Error(`${ref.name} cambió en el clúster mientras guardabas. Recarga y vuelve a aplicar tu cambio.`)
    }
    throw error
  }
}

const DATA_KEY = /^[-._a-zA-Z0-9]+$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export function validateDataKeys(keys: string[]): void {
  const seen = new Set<string>()
  for (const key of keys) {
    if (!key) throw new Error('Hay una clave vacía')
    if (key.length > 253 || !DATA_KEY.test(key)) throw new Error(`Clave no válida: «${key}». Solo letras, números, «-», «_» y «.»`)
    if (seen.has(key)) throw new Error(`Clave repetida: «${key}»`)
    seen.add(key)
  }
}

/**
 * Sustituye los datos de un ConfigMap o un Secret. En un Secret los valores llegan ya en base64, como
 * los guarda la API; en un ConfigMap, `data` es texto y `binaryData` base64.
 */
export async function replaceData(
  client: KubeClient,
  ref: ObjectRef,
  resourceVersion: string,
  payload: { data: Record<string, string>; binaryData?: Record<string, string> }
): Promise<KubeObject> {
  const kind = ref.resource.kind
  if (kind !== 'ConfigMap' && kind !== 'Secret') throw new Error('Solo se editan así ConfigMaps y Secrets')
  const binary = kind === 'ConfigMap' ? (payload.binaryData ?? {}) : {}
  validateDataKeys([...Object.keys(payload.data), ...Object.keys(binary)])
  const base64Values = kind === 'Secret' ? Object.values(payload.data) : Object.values(binary)
  if (base64Values.some((value) => !BASE64.test(value) || value.length % 4 !== 0)) throw new Error('Un valor binario no está en base64 válido')
  return editObject(client, ref, resourceVersion, (object) => {
    if (object.immutable) throw new Error(`${ref.name} es inmutable: hay que crear uno nuevo con otro nombre`)
    object.data = payload.data
    if (kind === 'ConfigMap') {
      if (Object.keys(binary).length) object.binaryData = binary
      else delete object.binaryData
    }
    // stringData solo existe al escribir; si viniera, mezclaría valores antiguos con los nuevos
    delete object.stringData
  })
}

export async function setMetadata(
  client: KubeClient,
  ref: ObjectRef,
  resourceVersion: string,
  labels: Record<string, string>,
  annotations: Record<string, string>
): Promise<KubeObject> {
  return editObject(client, ref, resourceVersion, (object) => {
    object.metadata.labels = labels
    object.metadata.annotations = annotations
  })
}

export interface Taint {
  key: string
  value?: string
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'
}

export async function setTaints(client: KubeClient, name: string, resourceVersion: string, taints: Taint[]): Promise<KubeObject> {
  for (const taint of taints) {
    if (!taint.key) throw new Error('Un taint necesita clave')
    if (!['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(taint.effect)) throw new Error(`Efecto no válido: ${taint.effect}`)
  }
  return editObject(client, { resource: NODES, name }, resourceVersion, (node) => {
    // Se conservan las marcas de tiempo de los taints que siguen
    const previous: (Taint & { timeAdded?: string })[] = node.spec?.taints ?? []
    node.spec = {
      ...node.spec,
      taints: taints.map((taint) => {
        const same = previous.find((p) => p.key === taint.key && p.effect === taint.effect)
        return { key: taint.key, ...(taint.value ? { value: taint.value } : {}), effect: taint.effect, ...(same?.timeAdded ? { timeAdded: same.timeAdded } : {}) }
      })
    }
  })
}

/** Ruta de la plantilla de pod dentro de cada tipo de carga */
function podSpecPath(kind: string): string[] {
  if (kind === 'Pod') return ['spec']
  if (kind === 'CronJob') return ['spec', 'jobTemplate', 'spec', 'template', 'spec']
  return ['spec', 'template', 'spec']
}

export function podSpecOf(object: KubeObject): Record<string, any> | undefined {
  let node: any = object
  for (const key of podSpecPath(object.kind ?? '')) node = node?.[key]
  return node
}

export interface ImageChange {
  container: string
  image: string
  init?: boolean
}

/** Como `kubectl set image`: un parche estratégico que identifica cada contenedor por su nombre */
export async function setImages(client: KubeClient, ref: ObjectRef, changes: ImageChange[]): Promise<void> {
  if (changes.length === 0) throw new Error('No hay cambios de imagen')
  for (const change of changes) if (!change.image.trim() || /\s/.test(change.image.trim())) throw new Error(`Imagen no válida para ${change.container}`)
  const spec: Record<string, unknown> = {}
  const containers = changes.filter((c) => !c.init).map((c) => ({ name: c.container, image: c.image.trim() }))
  const initContainers = changes.filter((c) => c.init).map((c) => ({ name: c.container, image: c.image.trim() }))
  if (containers.length) spec.containers = containers
  if (initContainers.length) spec.initContainers = initContainers
  let body: Record<string, unknown> = spec
  for (const key of [...podSpecPath(ref.resource.kind)].reverse()) body = { [key]: body }
  await client.json(resourcePath(ref.resource, ref.namespace, ref.name), {
    method: 'PATCH',
    contentType: 'application/strategic-merge-patch+json',
    body,
    query: { fieldManager: FIELD_MANAGER }
  })
}

export async function pauseDeployment(client: KubeClient, namespace: string, name: string, paused: boolean): Promise<void> {
  await client.json(resourcePath(DEPLOYMENTS, namespace, name), { method: 'PATCH', contentType: MERGE_PATCH, body: { spec: { paused } } })
}

/** Crea un objeto nuevo. A diferencia de aplicar, falla si ya existe uno con ese nombre */
export async function createObject(client: KubeClient, object: KubeObject): Promise<KubeObject> {
  if (!object.apiVersion || !object.kind || !object.metadata?.name) throw new Error('Faltan apiVersion, kind o nombre')
  const resource = await client.findKind(object.apiVersion, object.kind)
  const namespace = resource.namespaced ? (object.metadata.namespace ?? 'default') : undefined
  try {
    return slim(await client.json<KubeObject>(resourcePath(resource, namespace), { method: 'POST', body: object, query: { fieldManager: FIELD_MANAGER } }))
  } catch (error) {
    if (error instanceof KubeApiError && error.status === 409) throw new Error(`Ya existe un ${object.kind} llamado ${object.metadata.name}`)
    throw error
  }
}

const WORKLOADS = [
  apiGroup('apps', 'v1', 'deployments', 'Deployment'),
  apiGroup('apps', 'v1', 'statefulsets', 'StatefulSet'),
  apiGroup('apps', 'v1', 'daemonsets', 'DaemonSet'),
  apiGroup('batch', 'v1', 'cronjobs', 'CronJob')
]

/** Dónde usa una plantilla de pod un ConfigMap o un Secret: volúmenes, variables y credenciales de registro */
export function configReferences(spec: Record<string, any> | undefined, kind: 'ConfigMap' | 'Secret', name: string): string[] {
  if (!spec) return []
  const found = new Set<string>()
  const isConfig = kind === 'ConfigMap'
  for (const volume of spec.volumes ?? []) {
    if (isConfig ? volume.configMap?.name === name : volume.secret?.secretName === name) found.add(`volumen ${volume.name}`)
    for (const source of volume.projected?.sources ?? []) {
      if ((isConfig ? source.configMap?.name : source.secret?.name) === name) found.add(`volumen ${volume.name}`)
    }
  }
  for (const container of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    for (const env of container.env ?? []) {
      const from = isConfig ? env.valueFrom?.configMapKeyRef : env.valueFrom?.secretKeyRef
      if (from?.name === name) found.add(`variable ${env.name} (${container.name})`)
    }
    for (const env of container.envFrom ?? []) {
      if ((isConfig ? env.configMapRef?.name : env.secretRef?.name) === name) found.add(`todas sus claves como variables (${container.name})`)
    }
  }
  if (!isConfig && (spec.imagePullSecrets ?? []).some((s: { name: string }) => s.name === name)) found.add('credenciales del registro')
  return [...found]
}

export interface ConfigUser {
  resource: ReturnType<typeof apiGroup>
  name: string
  references: string[]
  /** Los CronJobs leen la configuración al crear cada Job: no hace falta reiniciarlos */
  restartable: boolean
}

export async function configUsers(client: KubeClient, kind: 'ConfigMap' | 'Secret', namespace: string, name: string): Promise<ConfigUser[]> {
  const users: ConfigUser[] = []
  for (const resource of WORKLOADS) {
    let items: KubeObject[]
    try {
      items = await client.listItems(resource, namespace)
    } catch {
      continue // sin permiso para ese tipo: se informa de lo que sí se puede ver
    }
    for (const item of items) {
      const references = configReferences(podSpecOf({ ...item, kind: resource.kind }), kind, name)
      if (references.length) users.push({ resource, name: item.metadata.name, references, restartable: resource.kind !== 'CronJob' })
    }
  }
  return users
}
