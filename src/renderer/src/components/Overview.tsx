import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ClusterInfo, ClusterMetrics, KubeObject, ResourceType } from '../../../shared/types'
import { invoke, useWatch } from '../lib/api'
import { age, formatBytes, formatCpu, parseCpuQuantity, parseMemoryQuantity, podStatus, statusTone } from '../lib/format'

function Meter({ label, used, reserved, total, format }: { label: string; used?: number; reserved: number; total: number; format(value: number): string }): ReactNode {
  const pct = (value: number): number => (total > 0 ? Math.min(100, (value / total) * 100) : 0)
  return (
    <div className="card meter">
      <div className="card-title">{label}</div>
      <div className="card-value">
        {used !== undefined ? `${format(used)} ` : ''}
        <small>{used !== undefined ? 'de ' : 'capacidad '}{format(total)}</small>
      </div>
      <div className="bar">
        <div className="bar-reserved" style={{ width: `${pct(reserved)}%` }} />
        {used !== undefined && <div className="bar-used" style={{ width: `${pct(used)}%` }} />}
      </div>
      <div className="dim small">Reservado: {format(reserved)} ({pct(reserved).toFixed(0)}%){used !== undefined ? ` · Uso: ${pct(used).toFixed(0)}%` : ''}</div>
    </div>
  )
}

/** Suma lo que piden los contenedores de pods vivos, como hace `kubectl describe node` */
function requested(pods: KubeObject[], key: 'cpu' | 'memory', parse: (value: string) => number): number {
  let total = 0
  for (const pod of pods) {
    if (pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') continue
    for (const container of pod.spec?.containers ?? []) {
      const value = container.resources?.requests?.[key]
      if (value) total += parse(value)
    }
  }
  return total
}

export function Overview({
  contextId,
  info,
  namespaces,
  resources,
  onOpen
}: {
  contextId: string
  info: ClusterInfo
  namespaces: string[]
  resources: ResourceType[]
  onOpen(kind: string, object: KubeObject): void
}): ReactNode {
  const find = (kind: string): ResourceType | undefined => resources.find((r) => r.kind === kind)
  const nodes = useWatch(contextId, find('Node'))
  const pods = useWatch(contextId, find('Pod'), namespaces)
  const events = useWatch(contextId, find('Event'), namespaces)
  const [metrics, setMetrics] = useState<ClusterMetrics | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      invoke('cluster:metrics', contextId).then((m) => !cancelled && setMetrics(m), () => undefined)
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [contextId])

  const summary = useMemo(() => {
    const states = new Map<string, number>()
    for (const pod of pods.items) {
      const status = podStatus(pod)
      states.set(status, (states.get(status) ?? 0) + 1)
    }
    return [...states.entries()].sort((a, b) => b[1] - a[1])
  }, [pods.items])

  const problemPods = useMemo(() => pods.items.filter((pod) => ['bad', 'warn'].includes(statusTone(podStatus(pod)))), [pods.items])
  const warnings = useMemo(
    () =>
      events.items
        .filter((event) => event.type === 'Warning')
        .sort((a, b) => Date.parse(b.lastTimestamp ?? b.eventTime ?? '') - Date.parse(a.lastTimestamp ?? a.eventTime ?? ''))
        .slice(0, 30),
    [events.items]
  )
  const capacity = (key: 'cpu' | 'memory', parse: (value: string) => number): number =>
    nodes.items.reduce((sum, node) => sum + parse(node.status?.allocatable?.[key] ?? '0'), 0)
  const readyNodes = nodes.items.filter((node) =>
    (node.status?.conditions ?? []).some((c: { type: string; status: string }) => c.type === 'Ready' && c.status === 'True')
  ).length
  const usage = (select: (value: { cpuMillis: number; memoryBytes: number }) => number): number | undefined => {
    if (!metrics?.available) return undefined
    return namespaces.length
      ? metrics.pods.filter((p) => namespaces.includes(p.namespace)).reduce((sum, p) => sum + select(p), 0)
      : metrics.nodes.reduce((sum, n) => sum + select(n), 0)
  }

  return (
    <section className="overview">
      <header className="toolbar">
        <h1>Resumen</h1>
        <span className="count">{info.version} · {info.platform}</span>
        {namespaces.length > 0 && <span className="badge">{namespaces.length === 1 ? 'namespace' : 'namespaces'}: {namespaces.join(', ')}</span>}
      </header>
      <div className="overview-body">
        <div className="cards">
          <div className="card">
            <div className="card-title">Nodos</div>
            <div className="card-value" data-testid="nodes-ready">{readyNodes}<small> de {nodes.items.length} listos</small></div>
          </div>
          <div className="card">
            <div className="card-title">Pods</div>
            <div className="card-value" data-testid="pods-total">{pods.items.length}</div>
            <div className="chips">
              {summary.map(([status, count]) => (
                <span key={status} className={`chip ${statusTone(status)}`}>{status}: {count}</span>
              ))}
            </div>
          </div>
          <Meter label="CPU" used={usage((v) => v.cpuMillis)} reserved={requested(pods.items, 'cpu', parseCpuQuantity)} total={capacity('cpu', parseCpuQuantity)} format={formatCpu} />
          <Meter label="Memoria" used={usage((v) => v.memoryBytes)} reserved={requested(pods.items, 'memory', parseMemoryQuantity)} total={capacity('memory', parseMemoryQuantity)} format={formatBytes} />
        </div>
        {metrics && !metrics.available && <p className="dim small">Sin datos de uso: el clúster no tiene metrics-server. Se muestra solo lo reservado.</p>}
        <div className="overview-columns">
          <div>
            <h2>Pods con problemas ({problemPods.length})</h2>
            {problemPods.length === 0 ? <p className="dim">Ninguno.</p> : (
              <table className="mini">
                <tbody>
                  {problemPods.slice(0, 30).map((pod) => (
                    <tr key={pod.metadata.uid} onClick={() => onOpen('Pod', pod)}>
                      <td className="name">{pod.metadata.namespace}/{pod.metadata.name}</td>
                      <td className={statusTone(podStatus(pod))}>{podStatus(pod)}</td>
                      <td>{age(pod.metadata.creationTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h2>Advertencias recientes ({warnings.length})</h2>
            {warnings.length === 0 ? <p className="dim">Ninguna.</p> : warnings.map((event) => (
              <div key={event.metadata.uid} className="event warn">
                <div><strong>{event.reason}</strong> <span className="dim small">{event.involvedObject?.kind}/{event.involvedObject?.name} · hace {age(event.lastTimestamp ?? event.eventTime)}</span></div>
                <div className="small">{event.message}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
