import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { drainDecision, labelSelector, parseCpu, parseDocuments, parseMemory } from '../src/main/actions'
import { collapseServices } from '../src/renderer/src/lib/graph-filter'
import { buildQuery, resourcePath, uniqueKinds } from '../src/main/kube-client'
import { KubeconfigStore, defaultKubeconfigPaths, parseContextId } from '../src/main/kubeconfig'
import { counterDelta, histogramQuantile, parseMetrics, type Sample } from '../src/main/prometheus'
import { isPodReady, parseLogLine, resolveTargetPort } from '../src/main/streams'
import { buildTopology, selectorMatches, serviceHostIn } from '../src/main/topology'
import { TrafficTracker, findSidecars, invocationOutcome, isTrafficMetric, mergeTraffic, parseInvokeTarget, readObservations, refKey } from '../src/main/traffic'
import { lineSplitter } from '../src/main/watch'
import type { KubeObject, ResourceType } from '../src/shared/types'

const resource = (over: Partial<ResourceType>): ResourceType => ({
  group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true, verbs: [], shortNames: [], scalable: false, ...over
})
const object = (over: Partial<KubeObject>): KubeObject => ({ metadata: { name: 'x' }, ...over })

const KUBECONFIG = (exec = false): string => `apiVersion: v1
kind: Config
current-context: uno
clusters:
  - name: c1
    cluster: { server: https://uno.example:6443 }
contexts:
  - name: uno
    context: { cluster: c1, user: u1, namespace: ventas }
  - name: dos/con-barra
    context: { cluster: c1, user: u1 }
users:
  - name: u1
    user: ${exec ? '{ exec: { apiVersion: client.authentication.k8s.io/v1, command: gke-plugin } }' : '{ token: abc }'}
`

describe('rutas de la API', () => {
  it('distingue grupo core, grupos con nombre, namespace y subrecurso', () => {
    expect(resourcePath(resource({}), 'demo', 'p1', 'log')).toBe('/api/v1/namespaces/demo/pods/p1/log')
    expect(resourcePath(resource({ group: 'apps', plural: 'deployments' }))).toBe('/apis/apps/v1/deployments')
    expect(resourcePath(resource({ plural: 'nodes', namespaced: false }), 'ignorado', 'n1')).toBe('/api/v1/nodes/n1')
  })
  it('escapa los nombres', () => {
    expect(resourcePath(resource({}), 'a/b', 'c d')).toBe('/api/v1/namespaces/a%2Fb/pods/c%20d')
  })
  it('repite parámetros de lista y omite los indefinidos', () => {
    expect(buildQuery({ command: ['a', 'b'], tty: true, nada: undefined })).toBe('?command=a&command=b&tty=true')
    expect(buildQuery(undefined)).toBe('')
  })
})

describe('flujos línea a línea', () => {
  it('une líneas partidas entre fragmentos y caracteres UTF-8 cortados', () => {
    const lines: string[] = []
    const splitter = lineSplitter((line) => lines.push(line))
    const text = Buffer.from('uno\nañ\ntres')
    splitter.push(text.subarray(0, 6)) // corta en medio de la ñ
    splitter.push(text.subarray(6))
    expect(lines).toEqual(['uno', 'añ'])
    splitter.push(Buffer.from('\n'))
    expect(lines).toEqual(['uno', 'añ', 'tres'])
  })
  it('separa la marca de tiempo de cada registro', () => {
    expect(parseLogLine('p', 'c', '2026-11-01T10:00:00.123456Z hola mundo')).toEqual({ pod: 'p', container: 'c', time: '2026-11-01T10:00:00.123456Z', text: 'hola mundo' })
    expect(parseLogLine('p', 'c', 'sin hora')).toEqual({ pod: 'p', container: 'c', text: 'sin hora' })
    expect(parseLogLine('p', 'c', '2026-11-01T10:00:00Z')).toEqual({ pod: 'p', container: 'c', time: '2026-11-01T10:00:00Z', text: '' })
  })
})

describe('YAML', () => {
  it('admite varios documentos, ignora los vacíos y expande List', () => {
    const docs = parseDocuments(`---
kind: ConfigMap
apiVersion: v1
metadata: { name: a }
---
---
kind: List
apiVersion: v1
items:
  - { kind: Secret, apiVersion: v1, metadata: { name: b } }
`)
    expect(docs.map((d) => d.metadata.name)).toEqual(['a', 'b'])
  })
  it('rechaza documentos incompletos', () => {
    expect(() => parseDocuments('kind: Pod\nmetadata: { name: a }')).toThrow(/apiVersion/)
    expect(() => parseDocuments('kind: Pod\napiVersion: v1\nmetadata: {}')).toThrow(/metadata.name/)
    expect(() => parseDocuments('- a\n- b')).toThrow(/objeto/)
  })
})

describe('cantidades', () => {
  it('convierte CPU a milésimas', () => {
    expect(parseCpu('250m')).toBe(250)
    expect(parseCpu('2')).toBe(2000)
    expect(parseCpu('2000000n')).toBeCloseTo(2)
    expect(parseCpu('basura')).toBe(0)
  })
  it('convierte memoria a bytes', () => {
    expect(parseMemory('1Ki')).toBe(1024)
    expect(parseMemory('128Mi')).toBe(134217728)
    expect(parseMemory('1G')).toBe(1e9)
    expect(parseMemory(undefined)).toBe(0)
  })
})

describe('selectores', () => {
  it('traduce matchLabels y matchExpressions', () => {
    expect(labelSelector({ matchLabels: { a: '1' }, matchExpressions: [{ key: 'b', operator: 'In', values: ['x', 'y'] }, { key: 'c', operator: 'Exists' }, { key: 'd', operator: 'DoesNotExist' }] })).toBe('a=1,b in (x,y),c,!d')
    expect(labelSelector({ app: 'web' })).toBe('app=web')
    expect(labelSelector(undefined)).toBeUndefined()
    expect(labelSelector({})).toBeUndefined()
  })
})

describe('drenado', () => {
  const owned = (kind: string): KubeObject['metadata'] => ({ name: 'p', ownerReferences: [{ kind, name: 'o', uid: '1', apiVersion: 'v1', controller: true }] })
  it('sigue las reglas de kubectl drain', () => {
    expect(drainDecision(object({ metadata: owned('ReplicaSet') }), false).evict).toBe(true)
    expect(drainDecision(object({ metadata: owned('DaemonSet') }), true).evict).toBe(false)
    expect(drainDecision(object({ metadata: { name: 'p', annotations: { 'kubernetes.io/config.mirror': 'x' } } }), true).evict).toBe(false)
    expect(drainDecision(object({}), false).evict).toBe(false)
    expect(drainDecision(object({}), true).evict).toBe(true)
    expect(drainDecision(object({ status: { phase: 'Succeeded' } }), false).evict).toBe(true)
  })
})

describe('reenvío de puertos', () => {
  const service = object({ spec: { ports: [{ port: 80, targetPort: 'http' }, { port: 81, targetPort: 9000 }, { port: 82 }] } })
  const pod = object({ spec: { containers: [{ ports: [{ name: 'http', containerPort: 8080 }] }] } })
  it('resuelve targetPort por número, por nombre o por defecto', () => {
    expect(resolveTargetPort(service, pod, 80)).toBe(8080)
    expect(resolveTargetPort(service, pod, 81)).toBe(9000)
    expect(resolveTargetPort(service, pod, 82)).toBe(82)
  })
  it('falla con un puerto inexistente o un nombre desconocido', () => {
    expect(() => resolveTargetPort(service, pod, 99)).toThrow(/no expone/)
    expect(() => resolveTargetPort(service, object({ spec: { containers: [] } }), 80)).toThrow(/http/)
  })
  it('solo considera listo un pod Running con condición Ready', () => {
    expect(isPodReady(object({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }))).toBe(true)
    expect(isPodReady(object({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } }))).toBe(false)
    expect(isPodReady(object({ status: { phase: 'Pending' } }))).toBe(false)
  })
})

describe('kubeconfig', () => {
  const dirs: string[] = []
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codycube-'))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    delete process.env.KUBECONFIG
  })
  /** Store vacío: KUBECONFIG apunta a nada para no leer el ~/.kube/config real */
  const store = (): KubeconfigStore => {
    process.env.KUBECONFIG = join(temp(), 'no-existe')
    return new KubeconfigStore(temp())
  }

  it('lee KUBECONFIG con varias rutas y descarta las inexistentes', () => {
    const dir = temp()
    const file = join(dir, 'a')
    writeFileSync(file, 'x')
    expect(defaultKubeconfigPaths({ KUBECONFIG: `${file}:${join(dir, 'b')}` }, dir)).toEqual([file])
    expect(defaultKubeconfigPaths({}, dir)).toEqual([])
  })

  it('carga archivos, lista contextos y persiste entre aperturas', () => {
    const data = temp()
    process.env.KUBECONFIG = join(data, 'no-existe')
    const file = join(temp(), 'config')
    writeFileSync(file, KUBECONFIG())
    const first = new KubeconfigStore(data)
    first.addPath(file)
    first.addPath(file) // duplicado
    const { files, contexts } = new KubeconfigStore(data).list()
    expect(files).toHaveLength(1)
    expect(contexts.map((c) => c.name)).toEqual(['uno', 'dos/con-barra'])
    expect(contexts[0]).toMatchObject({ server: 'https://uno.example:6443', namespace: 'ventas', isCurrent: true, execTrusted: true })
  })

  it('conserva barras en el nombre del contexto al separar el id', () => {
    expect(parseContextId('abc/dos/con-barra')).toEqual({ fileId: 'abc', name: 'dos/con-barra' })
  })

  it('rechaza un archivo que no es kubeconfig', () => {
    const file = join(temp(), 'malo')
    writeFileSync(file, 'esto: no\n')
    expect(() => store().addPath(file)).toThrow()
  })

  it('no conecta con un plugin exec sin autorizar, y otro comando vuelve a pedir permiso', () => {
    const s = store()
    const file = join(temp(), 'config')
    writeFileSync(file, KUBECONFIG(true))
    s.addPath(file)
    const context = s.list().contexts[0]
    expect(context).toMatchObject({ execCommand: 'gke-plugin', execTrusted: false })
    expect(() => s.configFor(context.id)).toThrow(/autorizar/)
    s.trustExec(context.id)
    expect(s.configFor(context.id).getCurrentContext()).toBe('uno')
    writeFileSync(file, KUBECONFIG(true).replace('gke-plugin', 'otro-comando'))
    expect(s.list().contexts[0].execTrusted).toBe(false)
  })

  it('un archivo que se dañó después se informa sin romper los demás', () => {
    const s = store()
    const good = join(temp(), 'bueno')
    const bad = join(temp(), 'malo')
    writeFileSync(good, KUBECONFIG())
    writeFileSync(bad, KUBECONFIG())
    s.addPath(good)
    s.addPath(bad)
    writeFileSync(bad, ': : :')
    const { files, contexts } = s.list()
    expect(files.find((f) => f.path === bad)?.error).toBeTruthy()
    expect(contexts).toHaveLength(2)
  })

  it('guarda el texto pegado solo legible por el usuario', async () => {
    const s = store()
    s.addText(KUBECONFIG())
    const { files } = s.list()
    expect(files[0].managed).toBe(true)
    const { statSync } = await import('node:fs')
    expect(statSync(files[0].path).mode & 0o777).toBe(0o600)
  })

  it('recuerda el modo solo lectura', () => {
    const s = store()
    s.addText(KUBECONFIG())
    const id = s.list().contexts[0].id
    expect(s.isReadOnly(id)).toBe(false)
    s.setReadOnly(id, true)
    expect(s.list().contexts[0].readOnly).toBe(true)
    s.setReadOnly(id, false)
    expect(s.isReadOnly(id)).toBe(false)
  })
})

describe('métricas de Prometheus', () => {
  it('lee etiquetas con comas y comillas, e ignora comentarios', () => {
    const samples = parseMetrics('# HELP x\nm{a="1,2",b="di\\"jo"} 3\nn 4\nmalo\n')
    expect(samples).toEqual([
      { name: 'm', labels: { a: '1,2', b: 'di"jo' }, value: 3 },
      { name: 'n', labels: {}, value: 4 }
    ])
  })
  it('un contador que baja significa reinicio', () => {
    expect(counterDelta(undefined, 5)).toBe(0)
    expect(counterDelta(5, 8)).toBe(3)
    expect(counterDelta(100, 7)).toBe(7)
  })
  it('calcula percentiles interpolando dentro del bucket', () => {
    const buckets = [{ le: 10, count: 50 }, { le: 20, count: 100 }, { le: Infinity, count: 100 }]
    expect(histogramQuantile(0.5, buckets)).toBe(10)
    expect(histogramQuantile(0.75, buckets)).toBe(15)
    expect(histogramQuantile(0.5, [{ le: 10, count: 0 }])).toBeUndefined()
    expect(histogramQuantile(0.99, [{ le: 10, count: 1 }, { le: Infinity, count: 100 }])).toBe(10)
  })
})

// Líneas copiadas de un sidecar real de Dapr 1.19.1
const sidecar = (sent: number, ok: number, bad: number): string => `
dapr_runtime_service_invocation_req_sent_total{app_id="gateway",dst_app_id="orders",type="unary"} ${sent}
dapr_runtime_service_invocation_res_recv_total{app_id="gateway",src_app_id="orders",status="200",type="unary"} ${ok}
${bad ? `dapr_runtime_service_invocation_res_recv_total{app_id="gateway",src_app_id="orders",status="502",type="unary"} ${bad}` : ''}
dapr_runtime_service_invocation_res_recv_latency_ms_bucket{app_id="gateway",src_app_id="orders",status="200",le="10"} ${ok}
dapr_runtime_service_invocation_res_recv_latency_ms_bucket{app_id="gateway",src_app_id="orders",status="200",le="+Inf"} ${ok}
dapr_http_server_request_count{app_id="gateway",method="GET",path="/v1.0/healthz",status="204"} 110
`
const read = (text: string): Sample[] => parseMetrics(text, isTrafficMetric)

describe('tráfico de Dapr', () => {
  it('reconoce quién llama a quién y el resultado', () => {
    const observations = readObservations(read(sidecar(10, 9, 1)), 'tienda')
    expect(new Set(observations.map((o) => refKey(o.ref)))).toEqual(new Set(['invoke|tienda|gateway|tienda|orders']))
    expect(observations.filter((o) => o.outcome).map((o) => o.outcome)).toEqual([
      { label: 'HTTP 200', error: false },
      { label: 'HTTP 502', error: true }
    ])
  })
  it('lee publicación, entrega y estado con sus etiquetas reales', () => {
    const observations = readObservations(read(`
dapr_component_pubsub_egress_count{app_id="orders",component="pubsub",namespace="tienda",success="true",topic="pedidos"} 102
dapr_component_pubsub_ingress_count{app_id="notifications",component="pubsub",namespace="tienda",process_status="success",status="success",topic="pedidos"} 732
dapr_component_pubsub_ingress_count{app_id="notifications",component="pubsub",namespace="tienda",process_status="retry",status="retry",topic="pedidos"} 2
dapr_component_state_count{app_id="orders",component="statestore",namespace="tienda",operation="set",success="false"} 110
`), 'tienda')
    expect(observations.map((o) => [o.ref.kind, o.outcome?.label, o.outcome?.error])).toEqual([
      ['publish', 'Publicado', false],
      ['deliver', 'Procesado', false],
      ['deliver', 'Reintento', true],
      ['component', 'set fallida', true]
    ])
  })
  it('distingue los resultados HTTP de los gRPC y no cuenta un 4xx como fallo', () => {
    expect(invocationOutcome('404').error).toBe(false)
    expect(invocationOutcome('503').error).toBe(true)
    expect(invocationOutcome('0')).toEqual({ label: 'gRPC 0', error: false })
    expect(invocationOutcome('14').error).toBe(true)
    expect(invocationOutcome('').error).toBe(true)
  })
  it('sin ninguna respuesta, las peticiones enviadas cuentan como fallidas', () => {
    const observations = readObservations(read('dapr_runtime_service_invocation_req_sent_total{app_id="a",dst_app_id="caido",type="unary"} 3'), 'x')
    expect(observations[0].outcome).toEqual({ label: 'Sin respuesta', error: true })
  })
  it('con el destino caído, cuenta como no entregado lo que falló sin respuesta', () => {
    // Números reales de un sidecar con el destino a cero réplicas
    const text = (failedCalls: number) => `
dapr_http_server_request_count{app_id="orders",method="POST",path="/v1.0/invoke/payments/method/charge",status="200"} 441
dapr_http_server_request_count{app_id="orders",method="POST",path="/v1.0/invoke/payments/method/charge",status="500"} ${failedCalls}
dapr_http_server_request_count{app_id="orders",method="GET",path="/v1.0/healthz",status="204"} 110
dapr_runtime_service_invocation_req_sent_total{app_id="orders",dst_app_id="payments",type="unary"} 502
dapr_runtime_service_invocation_res_recv_total{app_id="orders",src_app_id="payments",status="200",type="unary"} 441
dapr_runtime_service_invocation_res_recv_total{app_id="orders",src_app_id="payments",status="500",type="unary"} 49
`
    const undelivered = readObservations(read(text(169)), 'tienda').find((o) => o.outcome?.label === 'No entregada')
    expect(undelivered?.value).toBe(120)
    const tracker = new TrafficTracker()
    const pod = (failed: number) => ({ key: 'p', namespace: 'tienda', samples: read(text(failed)) })
    tracker.ingest(0, [pod(134)])
    tracker.ingest(10_000, [pod(169)])
    const { traffic } = tracker.list(10)[0]
    expect(traffic.rate).toBeCloseTo(3.5)
    expect(traffic.errorRatio).toBe(1)
    // Respuesta ya contada y petición aún sin contar: la resta baja, y eso no es un pico de fallos
    tracker.ingest(20_000, [pod(168)])
    expect(tracker.list(10)[0].traffic.history[1].rate).toBe(0)
  })
  it('un tipo repetido en varias versiones conserva la preferida', () => {
    const r = (group: string, version: string, kind: string) => ({ group, version, kind, plural: kind, namespaced: true, verbs: [], shortNames: [], scalable: false })
    expect(uniqueKinds([r('dapr.io', 'v2alpha1', 'Subscription'), r('dapr.io', 'v1alpha1', 'Subscription'), r('dapr.io', 'v1alpha1', 'Component')]).map((x) => `${x.version}/${x.kind}`)).toEqual(['v2alpha1/Subscription', 'v1alpha1/Component'])
  })
  it('interpreta el namespace del destino', () => {
    expect(parseInvokeTarget('orders.ventas', 'tienda')).toEqual({ app: 'orders', namespace: 'ventas' })
    expect(parseInvokeTarget('orders', 'tienda')).toEqual({ app: 'orders', namespace: 'tienda' })
  })
  it('calcula tasa, errores y latencia; la primera lectura solo fija la base', () => {
    const tracker = new TrafficTracker()
    const pod = (text: string, key = 'p1') => ({ key, namespace: 'tienda', samples: read(text) })
    tracker.ingest(0, [pod(sidecar(100, 100, 0))])
    expect(tracker.warmingUp).toBe(true)
    expect(tracker.list(10)[0].traffic.rate).toBe(0)
    tracker.ingest(10_000, [pod(sidecar(120, 118, 2))])
    expect(tracker.warmingUp).toBe(false)
    const { traffic } = tracker.list(10)[0]
    expect(traffic.rate).toBeCloseTo(2)
    // El 502 aparece por primera vez en esta lectura y aun así debe contar entero
    expect(traffic.errorRatio).toBeCloseTo(0.1)
    expect(traffic.p50Ms).toBeCloseTo(5)
    expect(traffic.total).toBe(120)
    expect(traffic.breakdown.map((b) => b.label)).toEqual(['HTTP 200', 'HTTP 502'])
    expect(traffic.history).toHaveLength(1)
  })
  it('suma réplicas y no toma la desaparición de un pod como una bajada', () => {
    const tracker = new TrafficTracker()
    const pod = (key: string, n: number) => ({ key, namespace: 'tienda', samples: read(sidecar(n, n, 0)) })
    tracker.ingest(0, [pod('a', 10), pod('b', 500)])
    tracker.ingest(10_000, [pod('a', 20), pod('b', 510)])
    expect(tracker.list(10)[0].traffic.history[0].rate).toBeCloseTo(2)
    tracker.ingest(20_000, [pod('a', 30)])
    expect(tracker.list(10)[0].traffic.history[1].rate).toBeCloseTo(1)
    // Un pod nuevo con contadores altos es su base, no un pico
    tracker.ingest(30_000, [pod('a', 40), pod('c', 9000)])
    expect(tracker.list(10)[0].traffic.history[2].rate).toBeCloseTo(1)
  })
  it('una conexión medida sustituye a la declarada y conserva de dónde sale', () => {
    const merged = mergeTraffic(
      {
        nodes: [
          { id: 'workload:n/Deployment/a', kind: 'workload', name: 'a' },
          { id: 'component:n/s', kind: 'component', name: 's' }
        ],
        edges: [{ id: 'declared|workload:n/Deployment/a|component:n/s', source: 'workload:n/Deployment/a', target: 'component:n/s', kind: 'declared', evidence: 'scopes', observed: false }],
        apps: new Map([['n/a', 'workload:n/Deployment/a']])
      },
      [{ ref: { kind: 'component', namespace: 'n', app: 'a', component: 's', inbound: false, category: 'state' }, traffic: { rate: 1, errorRatio: 0, total: 1, errors: 0, breakdown: [], history: [] } }]
    )
    expect(merged.edges).toHaveLength(1)
    expect(merged.edges[0]).toMatchObject({ kind: 'component', observed: true, evidence: 'scopes' })
  })
  it('marca como externa una app que no está en la vista y crea el tema de una publicación', () => {
    const merged = mergeTraffic({ nodes: [], edges: [], apps: new Map() }, [
      { ref: { kind: 'publish', namespace: 'n', app: 'a', component: 'bus', topic: 't' }, traffic: { rate: 0, errorRatio: 0, total: 0, errors: 0, breakdown: [], history: [] } }
    ])
    expect(merged.nodes.map((n) => n.kind).sort()).toEqual(['component', 'external', 'topic'])
    expect(merged.nodes.find((n) => n.kind === 'topic')?.parent).toBe('component:n/bus')
  })
  it('encuentra sidecars en marcha y respeta el puerto de métricas', () => {
    const pod = (name: string, extra: object): KubeObject => ({ metadata: { name, namespace: 'n', uid: name, annotations: {} }, spec: { containers: [{ name: 'app' }, { name: 'daprd' }] }, status: { phase: 'Running' }, ...extra })
    const result = findSidecars([
      pod('a', {}),
      pod('b', { metadata: { name: 'b', namespace: 'n', uid: 'b', annotations: { 'dapr.io/metrics-port': '9999' } } }),
      pod('c', { status: { phase: 'Pending' } }),
      pod('d', { spec: { containers: [{ name: 'app' }] } }),
      pod('e', { metadata: { name: 'e', namespace: 'n', uid: 'e', annotations: { 'dapr.io/enable-metrics': 'false' } } })
    ])
    expect(result.sidecars.map((s) => [s.pod, s.port])).toEqual([['a', '9090'], ['b', '9999']])
    expect(result.disabled).toBe(1)
  })
})

describe('arquitectura declarada', () => {
  it('reconoce direcciones de Services sin confundir palabras sueltas', () => {
    expect(serviceHostIn('http://orders.tienda.svc.cluster.local:8000/api', 'x')).toEqual({ name: 'orders', namespace: 'tienda' })
    expect(serviceHostIn('redis:6379', 'tienda')).toEqual({ name: 'redis', namespace: 'tienda' })
    expect(serviceHostIn('orders.ventas:80', 'x')).toEqual({ name: 'orders', namespace: 'ventas' })
    expect(serviceHostIn('orders', 'x')).toBeNull()
    expect(serviceHostIn('https://api.ejemplo.com/v1', 'x')).toBeNull()
    expect(serviceHostIn('una frase cualquiera', 'x')).toBeNull()
  })
  it('sigue Ingress → Service → carga, oculta los Services de Dapr y lee Dapr de la plantilla', () => {
    const meta = (name: string, extra: object = {}) => ({ name, namespace: 'n', uid: name, ...extra })
    const template = (app: string, annotations: object = {}) => ({ template: { metadata: { labels: { app }, annotations }, spec: { containers: [{ name: 'c', env: [{ name: 'DB', value: 'redis:6379' }, { name: 'SECRETO', valueFrom: {} }] }] } } })
    const { nodes, edges, apps } = buildTopology({
      deployments: [
        { metadata: meta('web'), spec: { replicas: 2, ...template('web', { 'dapr.io/enabled': 'true', 'dapr.io/app-id': 'portal' }) } },
        { metadata: meta('redis'), spec: { replicas: 1, ...template('redis') } }
      ],
      statefulSets: [],
      daemonSets: [],
      replicaSets: [{ metadata: meta('web-1', { ownerReferences: [{ kind: 'Deployment', name: 'web', uid: 'web', controller: true, apiVersion: 'apps/v1' }] }) }],
      pods: [{ metadata: meta('web-1-a', { ownerReferences: [{ kind: 'ReplicaSet', name: 'web-1', uid: 'web-1', controller: true, apiVersion: 'apps/v1' }] }), status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } }],
      services: [
        { metadata: meta('web'), spec: { selector: { app: 'web' } } },
        { metadata: meta('redis'), spec: { selector: { app: 'redis' } } },
        { metadata: meta('portal-dapr', { labels: { 'dapr.io/enabled': 'true' } }), spec: { selector: { app: 'web' } } },
        { metadata: meta('kubernetes'), spec: {} }
      ],
      ingresses: [{ metadata: meta('entrada'), spec: { rules: [{ host: 'a.b', http: { paths: [{ backend: { service: { name: 'web' } } }] } }] } }],
      components: [{ metadata: meta('bus'), spec: { type: 'pubsub.redis', metadata: [{ name: 'redisHost', value: 'redis:6379' }, { name: 'redisPassword', secretKeyRef: {} }] } }],
      subscriptions: [{ metadata: meta('s'), spec: { pubsubname: 'bus', topic: 't' }, scopes: ['portal'] }]
    })
    expect(nodes.some((n) => n.name === 'portal-dapr' || n.name === 'kubernetes')).toBe(false)
    expect(apps.get('n/portal')).toBe('workload:n/Deployment/web')
    expect(nodes.find((n) => n.name === 'web' && n.kind === 'workload')?.pods).toEqual({ ready: 1, total: 1, desired: 2 })
    const links = edges.map((e) => `${e.kind} ${e.source} ${e.target}`)
    expect(links).toContain('route ingress:n/entrada service:n/web')
    expect(links).toContain('selects service:n/web workload:n/Deployment/web')
    expect(links).toContain('declared workload:n/Deployment/web service:n/redis')
    expect(links).toContain('declared component:n/bus service:n/redis')
    expect(links).toContain('deliver topic:n/bus/t workload:n/Deployment/web')
    // Nunca el valor: solo cómo se llama la variable
    expect(edges.find((e) => e.kind === 'declared')?.evidence).toBe('variable DB')
    expect(selectorMatches({}, { app: 'x' })).toBe(false)
  })
})

describe('distribución del diagrama', () => {
  const node = (id: string, kind: 'service' | 'workload' | 'ingress', name = id) => ({ id, kind, name })
  const edge = (kind: 'selects' | 'route' | 'declared' | 'invoke', source: string, target: string, observed = false) => ({ id: `${kind}|${source}|${target}`, kind, source, target, observed })
  it('integra en su carga el Service que selecciona solo una y reconduce sus conexiones', () => {
    const { nodes, edges } = collapseServices(
      [node('ing', 'ingress'), node('svc', 'service', 'web'), node('web', 'workload'), node('otro', 'workload')],
      [edge('route', 'ing', 'svc'), edge('selects', 'svc', 'web'), edge('declared', 'otro', 'svc')]
    )
    expect(nodes.map((n) => n.id)).toEqual(['ing', 'web', 'otro'])
    expect(nodes.find((n) => n.id === 'web')?.services).toEqual(['web'])
    expect(edges.map((e) => e.id)).toEqual(['route|ing|web', 'declared|otro|web'])
  })
  it('conserva el Service que reparte entre varias cargas', () => {
    const { nodes, edges } = collapseServices(
      [node('svc', 'service'), node('a', 'workload'), node('b', 'workload')],
      [edge('selects', 'svc', 'a'), edge('selects', 'svc', 'b')]
    )
    expect(nodes).toHaveLength(3)
    expect(edges).toHaveLength(2)
  })
  it('no repite como declarada una comunicación que ya se mide', () => {
    const { edges } = collapseServices(
      [node('svc', 'service'), node('a', 'workload'), node('b', 'workload')],
      [edge('selects', 'svc', 'b'), edge('declared', 'a', 'svc'), edge('invoke', 'a', 'b', true)]
    )
    expect(edges.map((e) => e.kind)).toEqual(['invoke'])
  })
})
