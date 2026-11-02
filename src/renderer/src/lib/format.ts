import type { KubeObject } from '../../../shared/types'

/** Edad compacta, como la de kubectl: 45s, 12m, 3h, 5d */
export function age(timestamp: string | undefined, now = Date.now()): string {
  const then = timestamp ? Date.parse(timestamp) : NaN
  if (Number.isNaN(then)) return '—'
  const seconds = Math.max(0, Math.floor((now - then) / 1000))
  if (seconds < 120) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 120) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface ContainerStatus {
  ready?: boolean
  restartCount?: number
  state?: {
    waiting?: { reason?: string }
    terminated?: { reason?: string; exitCode?: number; signal?: number }
    running?: unknown
  }
}

/** Estado de un pod con la misma lógica de la columna STATUS de `kubectl get pods` */
export function podStatus(pod: KubeObject): string {
  if (pod.metadata.deletionTimestamp) return 'Terminating'
  const statuses: ContainerStatus[] = pod.status?.containerStatuses ?? []
  const inits: ContainerStatus[] = pod.status?.initContainerStatuses ?? []
  for (const [index, init] of inits.entries()) {
    const terminated = init.state?.terminated
    if (terminated && terminated.exitCode === 0) continue
    if (terminated) return `Init:${terminated.reason ?? 'Error'}`
    if (init.state?.waiting?.reason && init.state.waiting.reason !== 'PodInitializing') return `Init:${init.state.waiting.reason}`
    return `Init:${index}/${inits.length}`
  }
  for (const status of statuses) {
    if (status.state?.waiting?.reason) return status.state.waiting.reason
    if (status.state?.terminated?.reason && pod.status?.phase !== 'Succeeded') return status.state.terminated.reason
  }
  return pod.status?.reason ?? pod.status?.phase ?? 'Unknown'
}

export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (['Running', 'Active', 'Bound', 'Ready'].includes(status)) return 'ok'
  if (['Succeeded', 'Completed'].includes(status)) return 'muted'
  if (/Err|Error|Fail|BackOff|OOM|Invalid|Evicted/i.test(status)) return 'bad'
  return 'warn'
}

export function readyCount(pod: KubeObject): string {
  const statuses: ContainerStatus[] = pod.status?.containerStatuses ?? []
  const total = pod.spec?.containers?.length ?? statuses.length
  return `${statuses.filter((s) => s.ready).length}/${total}`
}

export function restarts(pod: KubeObject): number {
  return ((pod.status?.containerStatuses ?? []) as ContainerStatus[]).reduce((sum, s) => sum + (s.restartCount ?? 0), 0)
}

/** Núcleos a partir de una cantidad de Kubernetes */
export function formatCpu(value: string | number | undefined): string {
  if (value === undefined) return '—'
  const millis = typeof value === 'number' ? value : parseCpuQuantity(value)
  return millis < 1000 ? `${Math.round(millis)}m` : `${(millis / 1000).toFixed(millis % 1000 === 0 ? 0 : 2)}`
}

export function parseCpuQuantity(value: string): number {
  const match = /^([\d.]+)([numk]?)$/.exec(value)
  if (!match) return 0
  return Number(match[1]) * ({ n: 1e-6, u: 1e-3, m: 1, '': 1000, k: 1e6 }[match[2]] ?? 0)
}

export function parseMemoryQuantity(value: string): number {
  const match = /^([\d.]+)([A-Za-z]*)$/.exec(value)
  if (!match) return 0
  const units: Record<string, number> = {
    '': 1, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15,
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50
  }
  return Number(match[1]) * (units[match[2]] ?? 0)
}

export function formatBytes(value: string | number | undefined): string {
  if (value === undefined) return '—'
  let bytes = typeof value === 'number' ? value : parseMemoryQuantity(value)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let unit = 0
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024
    unit++
  }
  return `${bytes.toFixed(unit === 0 || bytes >= 100 ? 0 : 1)} ${units[unit]}`
}

/** base64 a texto, respetando UTF-8. Si no es texto válido devuelve null */
export function decodeBase64(value: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function apiVersionOf(object: KubeObject): string {
  return object.apiVersion ?? 'v1'
}
