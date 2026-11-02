import { useEffect, useRef, useState } from 'react'
import type { Bridge, KubeObject, ResourceType, WatchEvent, WatchMessage } from '../../../shared/types'

declare global {
  interface Window {
    codycube: Bridge
  }
}

export const bridge = window.codycube
export const invoke = bridge.invoke

const keyOf = (object: KubeObject): string =>
  object.metadata.uid ?? `${object.metadata.namespace ?? ''}/${object.metadata.name}`

/** Aplica un lote de eventos sobre la lista actual, sin duplicar ni resucitar objetos */
export function applyWatchEvents(items: KubeObject[], events: WatchEvent[]): KubeObject[] {
  const map = new Map(items.map((item) => [keyOf(item), item]))
  for (const event of events) {
    if (event.type === 'DELETED') map.delete(keyOf(event.object))
    else map.set(keyOf(event.object), event.object)
  }
  return [...map.values()]
}

export interface WatchState {
  items: KubeObject[]
  loading: boolean
  /** Reconectando: los datos visibles pueden estar desactualizados */
  stale: string | null
  error: string | null
}

/**
 * Lista en vivo de un tipo de recurso. El proceso principal hace el list + watch. Con varios
 * namespaces abre una lista por cada uno, porque la API no admite pedir varios a la vez: así basta con
 * tener permiso en esos namespaces, en lugar de leer el clúster entero y filtrar.
 */
export function useWatch(contextId: string, resource: ResourceType | undefined, namespaces?: string | string[]): WatchState {
  const [state, setState] = useState<WatchState>({ items: [], loading: true, stale: null, error: null })
  const key = resource ? `${resource.group}/${resource.version}/${resource.plural}` : ''
  const requested = namespaces === undefined ? [] : typeof namespaces === 'string' ? (namespaces ? [namespaces] : []) : namespaces
  // Sin namespaces, o un tipo sin namespace, es una única lista de todo
  const scopes: (string | undefined)[] = resource?.namespaced === false || requested.length === 0 ? [undefined] : [...new Set(requested)].sort()
  const scopeKey = JSON.stringify(scopes)
  const resourceRef = useRef(resource)
  resourceRef.current = resource

  useEffect(() => {
    const target = resourceRef.current
    if (!target) {
      setState({ items: [], loading: false, stale: null, error: null })
      return
    }
    const targets = JSON.parse(scopeKey) as (string | null)[]
    const parts: WatchState[] = targets.map(() => ({ items: [], loading: true, stale: null, error: null }))
    const label = (index: number, text: string): string => (targets.length > 1 ? `${targets[index]}: ${text}` : text)
    const publish = (): void => {
      const failed = parts.map((part, index) => (part.error ? label(index, part.error) : null)).filter(Boolean) as string[]
      const stale = parts.map((part, index) => (part.stale ? label(index, part.stale) : null)).filter(Boolean) as string[]
      // Si solo fallan algunos namespaces, se muestra lo demás con un aviso, no una pantalla de error
      const allFailed = failed.length === parts.length
      setState({
        items: parts.length === 1 ? parts[0].items : parts.flatMap((part) => part.items),
        loading: parts.some((part) => part.loading && !part.error),
        stale: [...stale, ...(allFailed ? [] : failed)].join(' · ') || null,
        error: allFailed ? failed.join(' · ') : null
      })
    }
    publish()
    let cancelled = false
    const ids: (string | undefined)[] = targets.map(() => undefined)
    // Lo que llegue antes de conocer el id se guarda: la respuesta del IPC puede ir detrás del primer mensaje
    const early: WatchMessage[] = []
    const handle = (index: number, message: WatchMessage): void => {
      const part = parts[index]
      if (message.kind === 'snapshot') parts[index] = { items: message.items, loading: false, stale: null, error: null }
      else if (message.kind === 'events') parts[index] = { ...part, items: applyWatchEvents(part.items, message.events) }
      else if (message.kind === 'status') parts[index] = { ...part, stale: message.state === 'reconnecting' ? (message.error ?? 'Reconectando') : null }
      else parts[index] = { ...part, loading: false, error: message.error }
      publish()
    }
    const unsubscribe = bridge.onWatch((message) => {
      const index = ids.indexOf(message.watchId)
      if (index >= 0) handle(index, message)
      else if (ids.includes(undefined)) early.push(message)
    })
    targets.forEach((namespace, index) => {
      invoke('resource:watch', contextId, target, namespace ?? undefined).then(
        (id) => {
          if (cancelled) {
            void invoke('resource:unwatch', id)
            return
          }
          ids[index] = id
          for (const message of early.filter((m) => m.watchId === id)) handle(index, message)
        },
        (error: Error) => {
          if (cancelled) return
          parts[index] = { ...parts[index], loading: false, error: error.message }
          publish()
        }
      )
    })
    return () => {
      cancelled = true
      unsubscribe()
      for (const id of ids) if (id) void invoke('resource:unwatch', id)
    }
  }, [contextId, key, scopeKey])

  return state
}

/** Fuerza un repintado periódico para que las edades avancen sin eventos nuevos */
export function useTick(ms: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
}
