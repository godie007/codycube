import type { KubeObject, ResourceType, WatchEvent, WatchMessage } from '../shared/types'
import { KubeApiError, type KubeClient, resourcePath, slim } from './kube-client'

const BATCH_MS = 150
const MAX_BACKOFF_MS = 30_000

/** Corta un flujo de bytes en objetos JSON, uno por línea, conservando el resto incompleto */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void } {
  const decoder = new TextDecoder()
  let rest = ''
  return {
    push(chunk) {
      rest += decoder.decode(chunk, { stream: true })
      let index = rest.indexOf('\n')
      while (index >= 0) {
        const line = rest.slice(0, index)
        rest = rest.slice(index + 1)
        if (line) onLine(line)
        index = rest.indexOf('\n')
      }
    }
  }
}

interface RawEvent {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
  object: KubeObject & { code?: number; message?: string }
}

/**
 * Lista y observa un tipo de recurso: patrón list + watch desde `resourceVersion`, con eventos en
 * lotes para no saturar la interfaz, relistado al recibir 410 Gone y reconexión con espera creciente.
 */
export function watchResource(
  client: KubeClient,
  resource: ResourceType,
  namespace: string | undefined,
  watchId: string,
  send: (message: WatchMessage) => void
): () => void {
  const controller = new AbortController()
  const { signal } = controller
  const apiVersion = resource.group ? `${resource.group}/${resource.version}` : resource.version
  let pending: WatchEvent[] = []
  let timer: NodeJS.Timeout | undefined

  const flush = (): void => {
    timer = undefined
    if (signal.aborted || pending.length === 0) return
    send({ watchId, kind: 'events', events: pending })
    pending = []
  }

  const run = async (): Promise<void> => {
    let backoff = 1000
    let reported = false
    while (!signal.aborted) {
      try {
        const list = await client.json<{ items: KubeObject[]; metadata: { resourceVersion: string } }>(
          resourcePath(resource, namespace),
          { signal, timeoutMs: 60_000 }
        )
        if (signal.aborted) return
        send({
          watchId,
          kind: 'snapshot',
          items: list.items.map((item) => slim({ ...item, kind: resource.kind, apiVersion }))
        })
        send({ watchId, kind: 'status', state: 'live' })
        reported = false
        backoff = 1000
        let version = list.metadata.resourceVersion
        // Cada watch expira en el servidor: se reabre desde la última versión vista sin relistar.
        while (!signal.aborted) {
          let gone = false
          const splitter = lineSplitter((line) => {
            const event = JSON.parse(line) as RawEvent
            if (event.type === 'ERROR') {
              if (event.object.code === 410) gone = true
              else throw new KubeApiError(event.object.message ?? 'Error de watch', event.object.code ?? 500)
              return
            }
            if (event.object.metadata?.resourceVersion) version = event.object.metadata.resourceVersion
            if (event.type === 'BOOKMARK') return
            pending.push({ type: event.type, object: slim({ ...event.object, kind: resource.kind, apiVersion }) })
            timer ??= setTimeout(flush, BATCH_MS)
          })
          await client.stream(
            resourcePath(resource, namespace),
            {
              query: {
                watch: true,
                allowWatchBookmarks: true,
                resourceVersion: version,
                timeoutSeconds: 300 + Math.floor(Math.random() * 60)
              },
              signal
            },
            (chunk) => splitter.push(chunk)
          )
          if (gone) break
        }
      } catch (error) {
        if (signal.aborted) return
        const message = error instanceof Error ? error.message : String(error)
        // Sin permiso o tipo inexistente: reintentar no cambiará nada
        if (error instanceof KubeApiError && [401, 403, 404, 405].includes(error.status)) {
          send({ watchId, kind: 'error', error: message })
          return
        }
        if (error instanceof KubeApiError && error.status === 410) continue
        if (!reported) send({ watchId, kind: 'status', state: 'reconnecting', error: message })
        reported = true
        await new Promise((done) => setTimeout(done, backoff))
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  void run()
  return () => {
    controller.abort()
    if (timer) clearTimeout(timer)
  }
}
