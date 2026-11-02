import http from 'node:http'
import https from 'node:https'
import type { KubeConfig } from '@kubernetes/client-node'
import WebSocket from 'ws'
import type { ClusterInfo, KubeObject, ResourceType } from '../shared/types'

export class KubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message)
    this.name = 'KubeApiError'
  }
}

export interface RequestOptions {
  method?: string
  query?: Record<string, string | number | boolean | string[] | undefined>
  body?: unknown
  contentType?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Corta la lectura si la respuesta supera este tamaño */
  maxBytes?: number
}

/** Mensaje comprensible a partir del error crudo de red o del objeto Status de Kubernetes */
function explainNetworkError(error: NodeJS.ErrnoException, server: string): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return `El servidor ${server} rechazó la conexión`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `No se encontró el servidor ${server} (DNS)`
    case 'ETIMEDOUT':
      return `Se agotó el tiempo al conectar con ${server}`
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
      return `Certificado TLS no válido en ${server}: ${error.message}`
    default:
      return error.message
  }
}

export function buildQuery(query: RequestOptions['query']): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) params.append(key, item)
    else params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** Ruta REST de un tipo de recurso, opcionalmente dentro de un namespace y de un objeto */
export function resourcePath(resource: ResourceType, namespace?: string, name?: string, subresource?: string): string {
  const base = resource.group ? `/apis/${resource.group}/${resource.version}` : `/api/${resource.version}`
  const ns = resource.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
  const obj = name ? `/${encodeURIComponent(name)}` : ''
  return `${base}${ns}/${resource.plural}${obj}${subresource ? `/${subresource}` : ''}`
}

/** Un mismo tipo aparece una vez por versión servida: se conserva el primero, el de la versión preferida */
export function uniqueKinds(resources: ResourceType[]): ResourceType[] {
  const seen = new Set<string>()
  return resources.filter((resource) => {
    const key = `${resource.group}/${resource.kind}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Campos enormes que nadie lee en la interfaz y encarecen cada evento */
export function slim<T extends KubeObject>(object: T): T {
  if (object.metadata?.managedFields) delete object.metadata.managedFields
  return object
}

/**
 * Cliente REST mínimo sobre un contexto. KubeConfig resuelve la autenticación (token, certificado,
 * plugins exec, proxy) y este cliente habla HTTP directo: así un único camino sirve para todos los
 * tipos de recursos, incluidos los personalizados, sin clases generadas por tipo.
 */
export class KubeClient {
  private resources: ResourceType[] | undefined

  constructor(readonly config: KubeConfig) {}

  get server(): string {
    const cluster = this.config.getCurrentCluster()
    if (!cluster) throw new Error('El contexto no tiene clúster')
    return cluster.server.replace(/\/+$/, '')
  }

  private async open(path: string, options: RequestOptions): Promise<http.IncomingMessage> {
    const url = new URL(this.server + path + buildQuery(options.query))
    const request: https.RequestOptions = {
      method: options.method ?? 'GET',
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers: { Accept: 'application/json' },
      signal: options.signal
    }
    await this.config.applyToHTTPSOptions(request)
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? options.body
          : JSON.stringify(options.body)
    if (body !== undefined) {
      request.headers = {
        ...request.headers,
        'Content-Type': options.contentType ?? 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'http:' ? http : https
      const req = client.request(request, resolve)
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.name === 'AbortError') reject(error)
        else reject(new Error(explainNetworkError(error, this.server)))
      })
      if (options.timeoutMs) {
        req.setTimeout(options.timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
      }
      req.end(body)
    })
  }

  private async fail(response: http.IncomingMessage): Promise<never> {
    const chunks: Buffer[] = []
    for await (const chunk of response) chunks.push(chunk as Buffer)
    const text = Buffer.concat(chunks).toString('utf8')
    let message = text.trim() || `HTTP ${response.statusCode}`
    let reason: string | undefined
    try {
      const status = JSON.parse(text)
      if (status.message) message = status.message
      reason = status.reason
    } catch {
      // No era JSON: se deja el texto tal cual
    }
    throw new KubeApiError(message, response.statusCode ?? 0, reason)
  }

  async text(path: string, options: RequestOptions = {}): Promise<string> {
    const response = await this.open(path, { timeoutMs: 30_000, ...options })
    if ((response.statusCode ?? 500) >= 400) return this.fail(response)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response) {
      size += (chunk as Buffer).length
      if (options.maxBytes && size > options.maxBytes) {
        response.destroy()
        throw new Error(`la respuesta supera ${Math.round(options.maxBytes / 1048576)} MB`)
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async json<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const text = await this.text(path, options)
    return (text ? JSON.parse(text) : undefined) as T
  }

  /** Respuesta larga (watch, follow): entrega fragmentos hasta que el servidor cierre o se aborte */
  async stream(path: string, options: RequestOptions, onChunk: (chunk: Buffer) => void): Promise<void> {
    const response = await this.open(path, options)
    if ((response.statusCode ?? 500) >= 400) return this.fail(response)
    for await (const chunk of response) onChunk(chunk as Buffer)
  }

  /** WebSocket autenticado, para exec y port-forward */
  async webSocket(path: string, query: RequestOptions['query'], protocols: string[]): Promise<WebSocket> {
    const url = this.server.replace(/^http/, 'ws') + path + buildQuery(query)
    const options: WebSocket.ClientOptions = {}
    await this.config.applyToHTTPSOptions(options)
    return new WebSocket(url, protocols, options)
  }

  async listItems(resource: ResourceType, namespace?: string): Promise<KubeObject[]> {
    const list = await this.json<{ items: KubeObject[]; kind: string }>(resourcePath(resource, namespace))
    const kind = resource.kind
    const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version
    return list.items.map((item) => slim({ ...item, kind, apiVersion }))
  }

  /** Descubrimiento: qué tipos de recurso sirve este clúster, en la versión preferida de cada grupo */
  async discover(force = false): Promise<ResourceType[]> {
    if (this.resources && !force) return this.resources
    const collect = async (group: string, version: string, base: string): Promise<ResourceType[]> => {
      const list = await this.json<{
        resources: {
          name: string
          kind: string
          namespaced: boolean
          verbs: string[]
          shortNames?: string[]
        }[]
      }>(base)
      const names = new Set(list.resources.map((r) => r.name))
      return list.resources
        .filter((r) => !r.name.includes('/') && r.verbs.includes('list'))
        .map((r) => ({
          group,
          version,
          plural: r.name,
          kind: r.kind,
          namespaced: r.namespaced,
          verbs: r.verbs,
          shortNames: r.shortNames ?? [],
          scalable: names.has(`${r.name}/scale`)
        }))
    }
    const groups = await this.json<{
      groups: { name: string; versions: { version: string }[]; preferredVersion: { version: string } }[]
    }>('/apis')
    // Cada versión puede servir tipos distintos: en dapr.io la preferida es v2alpha1, que solo tiene
    // Subscription, mientras Component vive en v1alpha1. Por eso se leen todas, la preferida primero
    const versions = groups.groups.flatMap((g) =>
      [g.preferredVersion.version, ...g.versions.map((v) => v.version).filter((v) => v !== g.preferredVersion.version)].map((version) => ({ group: g.name, version }))
    )
    // Un grupo que falla (p. ej. un APIService caído) no debe tumbar la conexión entera
    const settled = await Promise.allSettled([
      collect('', 'v1', '/api/v1'),
      ...versions.map(({ group, version }) => collect(group, version, `/apis/${group}/${version}`))
    ])
    if (settled[0].status === 'rejected') throw settled[0].reason
    this.resources = uniqueKinds(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))
    return this.resources
  }

  async clusterInfo(): Promise<ClusterInfo> {
    const version = await this.json<{ gitVersion: string; platform: string }>('/version', { timeoutMs: 10_000 })
    return { version: version.gitVersion, platform: version.platform, resources: await this.discover(true) }
  }

  async findKind(apiVersion: string, kind: string): Promise<ResourceType> {
    const find = (list: ResourceType[]): ResourceType | undefined => {
      const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion]
      return list.find((r) => r.group === group && r.kind === kind && r.version === version)
        ?? list.find((r) => r.group === group && r.kind === kind)
    }
    // Un CRD recién creado no está en la caché: se reintenta con descubrimiento fresco
    const resource = find(await this.discover()) ?? find(await this.discover(true))
    if (!resource) throw new Error(`El clúster no conoce ${kind} (${apiVersion})`)
    return resource
  }
}
