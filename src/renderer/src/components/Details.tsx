import { useEffect, useState, type ReactNode } from 'react'
import type { ConfigUser, DeploymentRevision, KubeObject, ResourceType } from '../../../shared/types'
import { invoke } from '../lib/api'
import { formatPairs, formatTaints, parsePairs, parseTaints } from '../lib/config-data'
import { supportsLogs, supportsRestart } from '../lib/catalog'
import { age, decodeBase64, podStatus, readyCount, restarts, statusTone } from '../lib/format'
import { Badge, useUi } from './ui'

export interface DetailActions {
  logs(object: KubeObject): void
  shell(pod: KubeObject, container: string): void
  edit(object: KubeObject, resource: ResourceType): void
  editData(object: KubeObject, resource: ResourceType): void
  navigate(kind: string, namespace: string | undefined, name: string): void
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? '—'}</dd>
    </>
  )
}

/** kubectl guarda aquí el objeto entero: en un Secret, sus valores en claro */
const HIDDEN_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration'

function Chips({ values }: { values?: Record<string, string> }): ReactNode {
  const entries = Object.entries(values ?? {}).filter(([key]) => key !== HIDDEN_ANNOTATION)
  if (entries.length === 0) return <span className="dim">—</span>
  return (
    <div className="chips">
      {entries.map(([key, value]) => (
        <span key={key} className="chip" title={`${key}=${value}`}>
          {key}={value}
        </span>
      ))}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Conditions({ object }: { object: KubeObject }): ReactNode {
  const conditions: { type: string; status: string; reason?: string; message?: string }[] = object.status?.conditions ?? []
  if (conditions.length === 0) return null
  return (
    <Section title="Condiciones">
      <div className="chips">
        {conditions.map((c) => {
          const good = c.status === 'True' ? !/Pressure|Unavailable|Failed/.test(c.type) : /Pressure|Unavailable/.test(c.type)
          return (
            <span key={c.type} className={`chip ${good ? 'ok' : 'warn'}`} title={[c.reason, c.message].filter(Boolean).join(': ')}>
              {c.type}: {c.status}
            </span>
          )
        })}
      </div>
    </Section>
  )
}

function DataEntries({ object }: { object: KubeObject }): ReactNode {
  const { toast } = useUi()
  const secret = object.kind === 'Secret'
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const entries = Object.entries((object.data ?? {}) as Record<string, string>)
  if (entries.length === 0) return null
  return (
    <Section title={secret ? 'Datos (en base64: codificados, no cifrados)' : 'Datos'}>
      {entries.map(([key, value]) => {
        const shown = !secret || revealed.has(key)
        const decoded = secret && shown ? (decodeBase64(value) ?? '(binario)') : value
        return (
          <div key={key} className="data-entry">
            <div className="data-key">
              <code>{key}</code>
              <span className="spacer" />
              {secret && (
                <button
                  className="link"
                  onClick={() =>
                    setRevealed((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                >
                  {shown ? 'Ocultar' : 'Mostrar'}
                </button>
              )}
              {decoded !== null && (
                <button className="link" onClick={() => void navigator.clipboard.writeText(secret ? (decodeBase64(value) ?? value) : value).then(() => toast(`${key} copiado`))}>
                  Copiar
                </button>
              )}
            </div>
            <pre>{shown ? decoded : '••••••••'}</pre>
          </div>
        )
      })}
    </Section>
  )
}

/** Qué cargas leen este ConfigMap o Secret: antes de cambiarlo o borrarlo conviene saberlo */
function ConfigUsers({ contextId, object, onOpen }: { contextId: string; object: KubeObject; onOpen(kind: string, name: string): void }): ReactNode {
  const [users, setUsers] = useState<ConfigUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const kind = object.kind as 'ConfigMap' | 'Secret'
  useEffect(() => {
    let alive = true
    invoke('resource:config-users', contextId, kind, object.metadata.namespace!, object.metadata.name).then(
      (found) => alive && setUsers(found),
      (e: Error) => alive && setError(e.message)
    )
    return () => {
      alive = false
    }
  }, [contextId, kind, object.metadata.namespace, object.metadata.name, object.metadata.resourceVersion])
  return (
    <Section title="Usado por">
      {error ? (
        <span className="dim small">{error}</span>
      ) : users === null ? (
        <span className="dim small">Buscando…</span>
      ) : users.length === 0 ? (
        <span className="dim small">Ninguna Deployment, StatefulSet, DaemonSet ni CronJob de este namespace lo usa.</span>
      ) : (
        <ul className="config-users" data-testid="config-users">
          {users.map((user) => (
            <li key={`${user.resource.kind}/${user.name}`}>
              <button className="link" onClick={() => onOpen(user.resource.kind, user.name)}>
                {user.resource.kind}/{user.name}
              </button>
              <span className="dim small"> {user.references.join(', ')}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function PodContainers({ pod, onShell, readOnly }: { pod: KubeObject; onShell(container: string): void; readOnly: boolean }): ReactNode {
  const statuses = new Map<string, { ready?: boolean; restartCount?: number; state?: Record<string, { reason?: string; message?: string }> }>(
    (pod.status?.containerStatuses ?? []).map((s: { name: string }) => [s.name, s])
  )
  return (
    <Section title="Contenedores">
      {(pod.spec?.containers ?? []).map((c: { name: string; image: string; ports?: { containerPort: number; protocol?: string }[]; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }) => {
        const status = statuses.get(c.name)
        const state = status?.state ? Object.keys(status.state)[0] : 'desconocido'
        const reason = status?.state ? Object.values(status.state)[0]?.reason : undefined
        return (
          <div key={c.name} className="container-card">
            <div className="container-head">
              <strong>{c.name}</strong>
              <Badge tone={status?.ready ? 'ok' : 'warn'}>{reason ?? state}</Badge>
              <div className="spacer" />
              <button className="link" disabled={readOnly || state !== 'running'} onClick={() => onShell(c.name)}>
                Terminal
              </button>
            </div>
            <code className="image">{c.image}</code>
            <div className="dim small">
              Reinicios: {status?.restartCount ?? 0}
              {c.ports?.length ? ` · Puertos: ${c.ports.map((p) => p.containerPort).join(', ')}` : ''}
              {c.resources?.requests ? ` · Pide: ${Object.entries(c.resources.requests).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}
              {c.resources?.limits ? ` · Límite: ${Object.entries(c.resources.limits).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}
            </div>
          </div>
        )
      })}
    </Section>
  )
}

function RelatedPods({ contextId, object, onOpen }: { contextId: string; object: KubeObject; onOpen(pod: KubeObject): void }): ReactNode {
  const [pods, setPods] = useState<KubeObject[] | null>(null)
  const version = object.metadata.resourceVersion
  useEffect(() => {
    let cancelled = false
    invoke('resource:pods-for', contextId, object).then((list) => !cancelled && setPods(list), () => !cancelled && setPods([]))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextId, object.metadata.uid, version])
  if (!pods || pods.length === 0) return null
  return (
    <Section title={`Pods (${pods.length})`}>
      <table className="mini">
        <tbody>
          {pods.slice(0, 50).map((pod) => (
            <tr key={pod.metadata.uid} onClick={() => onOpen(pod)}>
              <td className="name">{pod.metadata.name}</td>
              <td>{readyCount(pod)}</td>
              <td className={statusTone(podStatus(pod))}>{podStatus(pod)}</td>
              <td>{restarts(pod)}</td>
              <td>{age(pod.metadata.creationTimestamp)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

function Events({ contextId, object }: { contextId: string; object: KubeObject }): ReactNode {
  const [events, setEvents] = useState<KubeObject[]>([])
  const version = object.metadata.resourceVersion
  useEffect(() => {
    let cancelled = false
    invoke('resource:events-for', contextId, object).then((list) => !cancelled && setEvents(list), () => undefined)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextId, object.metadata.uid, version])
  if (events.length === 0) return null
  return (
    <Section title="Eventos">
      {events.slice(0, 30).map((event) => (
        <div key={event.metadata.uid} className={`event ${event.type === 'Warning' ? 'warn' : ''}`}>
          <div>
            <strong>{event.reason}</strong> <span className="dim small">hace {age(event.lastTimestamp ?? event.eventTime)}{event.count > 1 ? ` · ×${event.count}` : ''}</span>
          </div>
          <div className="small">{event.message}</div>
        </div>
      ))}
    </Section>
  )
}

function ServiceInfo({ object }: { object: KubeObject }): ReactNode {
  return (
    <Section title="Servicio">
      <dl className="props">
        <Row label="Tipo">{object.spec?.type}</Row>
        <Row label="IP de clúster"><code>{object.spec?.clusterIP}</code></Row>
        <Row label="Puertos">
          {(object.spec?.ports ?? []).map((p: { port: number; targetPort?: unknown; protocol?: string; name?: string }) => (
            <div key={p.port}><code>{p.name ? `${p.name}: ` : ''}{p.port} → {String(p.targetPort ?? p.port)}/{p.protocol ?? 'TCP'}</code></div>
          ))}
        </Row>
        <Row label="Selector"><Chips values={object.spec?.selector} /></Row>
      </dl>
    </Section>
  )
}

function NodeInfo({ object }: { object: KubeObject }): ReactNode {
  const info = object.status?.nodeInfo ?? {}
  return (
    <Section title="Nodo">
      <dl className="props">
        <Row label="Kubelet">{info.kubeletVersion}</Row>
        <Row label="Sistema">{info.osImage}</Row>
        <Row label="Runtime">{info.containerRuntimeVersion}</Row>
        <Row label="Arquitectura">{info.architecture}</Row>
        <Row label="Direcciones">
          {(object.status?.addresses ?? []).map((a: { type: string; address: string }) => (
            <div key={a.type}>{a.type}: <code>{a.address}</code></div>
          ))}
        </Row>
        <Row label="Capacidad">CPU {object.status?.capacity?.cpu}, memoria {object.status?.capacity?.memory}, pods {object.status?.capacity?.pods}</Row>
        <Row label="Taints">
          {(object.spec?.taints ?? []).length === 0 ? '—' : (object.spec.taints as { key: string; value?: string; effect: string }[]).map((t) => (
            <div key={t.key + t.effect}><code>{t.key}{t.value ? `=${t.value}` : ''}:{t.effect}</code></div>
          ))}
        </Row>
      </dl>
    </Section>
  )
}

export function Details({
  contextId,
  object,
  resource,
  readOnly,
  actions,
  onClose,
  onOpenPod
}: {
  contextId: string
  object: KubeObject
  resource: ResourceType
  readOnly: boolean
  actions: DetailActions
  onClose(): void
  onOpenPod(pod: KubeObject): void
}): ReactNode {
  const { ask, run, toast } = useUi()
  const { name, namespace } = object.metadata
  const ref = { resource, namespace, name }
  const kind = resource.kind

  const remove = async (): Promise<void> => {
    const fields = [
      {
        name: 'propagation',
        label: 'Objetos dependientes',
        type: 'select' as const,
        value: 'Background',
        options: [
          { value: 'Background', label: 'Eliminar en segundo plano' },
          { value: 'Foreground', label: 'Esperar a que se eliminen' },
          { value: 'Orphan', label: 'Conservarlos (huérfanos)' }
        ]
      },
      ...(kind === 'Pod' ? [{ name: 'force', label: 'Forzar (sin periodo de gracia)', type: 'checkbox' as const }] : [])
    ]
    const answer = await ask({ title: `Eliminar ${kind}`, danger: true, confirm: 'Eliminar', typeToConfirm: name, fields })
    if (!answer) return
    await run(
      async () => {
        await invoke('resource:delete', contextId, ref, {
          propagation: answer.propagation as 'Background',
          force: Boolean(answer.force)
        })
        onClose()
      },
      `${kind} ${name} eliminado`
    )
  }

  const scaleTo = async (): Promise<void> => {
    const answer = await ask({
      title: `Escalar ${name}`,
      confirm: 'Escalar',
      fields: [{ name: 'replicas', label: 'Réplicas', type: 'number', value: object.spec?.replicas ?? 0 }]
    })
    if (answer) await run(() => invoke('resource:scale', contextId, ref, Number(answer.replicas)), `${name} escalado a ${answer.replicas}`)
  }

  const restart = async (): Promise<void> => {
    const answer = await ask({ title: `Reiniciar ${name}`, confirm: 'Reiniciar', body: 'Recrea todos los pods de forma progresiva, como `kubectl rollout restart`.' })
    if (answer) await run(() => invoke('resource:restart', contextId, ref), `Reinicio de ${name} en curso`)
  }

  const rollback = async (): Promise<void> => {
    const revisions = await run<DeploymentRevision[]>(() => invoke('deployment:revisions', contextId, namespace!, name))
    if (!revisions) return
    const others = revisions.filter((r) => !r.current)
    if (others.length === 0) {
      toast('No hay revisiones anteriores a las que volver', 'bad')
      return
    }
    const answer = await ask({
      title: `Revertir ${name}`,
      confirm: 'Revertir',
      fields: [
        {
          name: 'revision',
          label: 'Volver a la revisión',
          type: 'select',
          value: String(others[0].revision),
          options: others.map((r) => ({ value: String(r.revision), label: `#${r.revision} — ${r.images.join(', ')}` }))
        }
      ]
    })
    if (answer) await run(() => invoke('deployment:rollback', contextId, namespace!, name, Number(answer.revision)), `${name} revertido a la revisión ${answer.revision}`)
  }

  const drain = async (): Promise<void> => {
    const answer = await ask({
      title: `Drenar ${name}`,
      danger: true,
      confirm: 'Drenar',
      typeToConfirm: name,
      body: 'Marca el nodo como no programable y desaloja sus pods, respetando los PodDisruptionBudget. Se omiten DaemonSets y pods estáticos.',
      fields: [{ name: 'force', label: 'Incluir pods sin controlador (se pierden definitivamente)', type: 'checkbox' }]
    })
    if (!answer) return
    const report = await run(() => invoke('node:drain', contextId, name, { force: Boolean(answer.force) }))
    if (!report) return
    if (report.failed.length) toast(`Drenado incompleto: ${report.failed.length} fallaron (${report.failed[0].pod}: ${report.failed[0].error})`, 'bad')
    else toast(`Nodo drenado: ${report.evicted.length} desalojados, ${report.skipped.length} omitidos`)
  }

  const forward = async (): Promise<void> => {
    const ports: number[] =
      kind === 'Service'
        ? (object.spec?.ports ?? []).map((p: { port: number }) => p.port)
        : (object.spec?.containers ?? []).flatMap((c: { ports?: { containerPort: number }[] }) => (c.ports ?? []).map((p) => p.containerPort))
    const answer = await ask({
      title: `Reenviar puerto de ${name}`,
      confirm: 'Iniciar',
      fields: [
        { name: 'remote', label: 'Puerto remoto', type: 'number', value: ports[0] ?? 80 },
        { name: 'local', label: 'Puerto local', type: 'number', value: 0, hint: '0 elige uno libre. Solo escucha en 127.0.0.1.' }
      ]
    })
    if (!answer) return
    const info = await run(() => invoke('forward:start', contextId, namespace!, kind as 'Pod', name, Number(answer.remote), Number(answer.local)))
    if (info) toast(`Reenvío activo en 127.0.0.1:${info.localPort}`)
  }

  const editMetadata = async (): Promise<void> => {
    const annotations = object.metadata.annotations ?? {}
    // Lo que no cabe en una línea, y la copia que guarda kubectl, se conservan tal cual
    const kept = Object.fromEntries(Object.entries(annotations).filter(([key, value]) => key === HIDDEN_ANNOTATION || value.includes('\n')))
    const editable = Object.fromEntries(Object.entries(annotations).filter(([key]) => !(key in kept)))
    const answer = await ask({
      title: `Etiquetas y anotaciones de ${name}`,
      confirm: 'Guardar',
      body: kind === 'Deployment' || kind === 'StatefulSet' || kind === 'DaemonSet' ? 'Son las del propio objeto. Las de sus pods están en la plantilla (Editar YAML).' : undefined,
      fields: [
        { name: 'labels', label: 'Etiquetas (clave=valor por línea)', type: 'textarea', value: formatPairs(object.metadata.labels ?? {}) },
        {
          name: 'annotations',
          label: 'Anotaciones (clave=valor por línea)',
          type: 'textarea',
          value: formatPairs(editable),
          hint: Object.keys(kept).length ? `Se conservan sin mostrar ${Object.keys(kept).length} anotaciones de varias líneas o de kubectl.` : undefined
        }
      ]
    })
    if (!answer) return
    await run(async () => {
      const labels = parsePairs(String(answer.labels), 'Etiquetas')
      const nextAnnotations = { ...parsePairs(String(answer.annotations), 'Anotaciones'), ...kept }
      await invoke('resource:set-metadata', contextId, ref, object.metadata.resourceVersion!, labels, nextAnnotations)
    }, 'Etiquetas y anotaciones guardadas')
  }

  const podSpec = kind === 'Pod' ? object.spec : kind === 'CronJob' ? object.spec?.jobTemplate?.spec?.template?.spec : object.spec?.template?.spec
  const imageTargets: { name: string; image: string; init: boolean }[] = [
    ...(podSpec?.initContainers ?? []).map((c: { name: string; image: string }) => ({ name: c.name, image: c.image, init: true })),
    ...(podSpec?.containers ?? []).map((c: { name: string; image: string }) => ({ name: c.name, image: c.image, init: false }))
  ]
  const setImage = async (): Promise<void> => {
    const answer = await ask({
      title: `Cambiar imagen de ${name}`,
      confirm: 'Aplicar',
      body: kind === 'Pod' ? 'En un pod suelto el contenedor se reinicia con la nueva imagen. Si lo gestiona un controlador, cambia mejor el controlador.' : 'Se despliega de forma progresiva, como `kubectl set image`.',
      fields: imageTargets.map((c) => ({ name: `${c.init ? 'init:' : ''}${c.name}`, label: `${c.init ? 'Init · ' : ''}${c.name}`, type: 'text' as const, value: c.image }))
    })
    if (!answer) return
    const changes = imageTargets
      .map((c) => ({ container: c.name, init: c.init, image: String(answer[`${c.init ? 'init:' : ''}${c.name}`]).trim() }))
      .filter((c, i) => c.image !== imageTargets[i].image)
    if (changes.length === 0) {
      toast('No cambiaste ninguna imagen', 'bad')
      return
    }
    await run(() => invoke('resource:set-images', contextId, ref, changes), `Imagen actualizada: ${changes.map((c) => `${c.container} → ${c.image}`).join(', ')}`)
  }

  const editTaints = async (): Promise<void> => {
    const answer = await ask({
      title: `Taints de ${name}`,
      confirm: 'Guardar',
      body: 'Un taint aparta del nodo los pods que no lo toleran. NoExecute además desaloja los que ya están.',
      fields: [{ name: 'taints', label: 'Uno por línea: clave=valor:Efecto', type: 'textarea', value: formatTaints(object.spec?.taints), placeholder: 'dedicado=gpu:NoSchedule' }]
    })
    if (!answer) return
    await run(async () => {
      await invoke('node:taints', contextId, name, object.metadata.resourceVersion!, parseTaints(String(answer.taints)))
    }, 'Taints guardados')
  }

  const canUpdate = resource.verbs.includes('update') && !readOnly
  const canDelete = resource.verbs.includes('delete') && !readOnly
  const firstContainer = object.spec?.containers?.[0]?.name as string | undefined
  const isConfig = resource.group === '' && (kind === 'ConfigMap' || kind === 'Secret')

  return (
    <aside className="details" aria-label={`Detalles de ${name}`}>
      <header className="details-head">
        <div>
          <div className="dim small">{kind}</div>
          <h2 title={name}>{name}</h2>
        </div>
        <button className="icon" aria-label="Cerrar detalles" onClick={onClose}>✕</button>
      </header>
      <div className="actions">
        {supportsLogs(kind) && <button className="btn" onClick={() => actions.logs(object)}>Registros</button>}
        {kind === 'Pod' && firstContainer && (
          <button className="btn" disabled={readOnly || object.status?.phase !== 'Running'} onClick={() => actions.shell(object, firstContainer)}>Terminal</button>
        )}
        {(kind === 'Pod' || kind === 'Service') && <button className="btn" onClick={() => void forward()}>Reenviar puerto</button>}
        {resource.scalable && <button className="btn" disabled={readOnly} onClick={() => void scaleTo()}>Escalar</button>}
        {supportsRestart(kind) && <button className="btn" disabled={readOnly} onClick={() => void restart()}>Reiniciar</button>}
        {kind === 'Deployment' && <button className="btn" disabled={readOnly} onClick={() => void rollback()}>Revertir</button>}
        {kind === 'Deployment' && (
          <button
            className="btn"
            disabled={readOnly}
            onClick={() => void run(() => invoke('deployment:pause', contextId, namespace!, name, !object.spec?.paused), object.spec?.paused ? 'Despliegue reanudado' : 'Despliegue en pausa')}
          >
            {object.spec?.paused ? 'Reanudar despliegue' : 'Pausar despliegue'}
          </button>
        )}
        {imageTargets.length > 0 && ['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'].includes(kind) && (
          <button className="btn" disabled={!canUpdate} onClick={() => void setImage()}>Cambiar imagen</button>
        )}
        {isConfig && <button className="btn" onClick={() => actions.editData(object, resource)}>{canUpdate ? 'Editar datos' : 'Ver datos'}</button>}
        {kind === 'Node' && (
          <>
            <button
              className="btn"
              disabled={readOnly}
              onClick={() => void run(() => invoke('node:cordon', contextId, name, !object.spec?.unschedulable), object.spec?.unschedulable ? 'Nodo habilitado' : 'Nodo acordonado')}
            >
              {object.spec?.unschedulable ? 'Habilitar' : 'Acordonar'}
            </button>
            <button className="btn" disabled={readOnly} onClick={() => void drain()}>Drenar</button>
            <button className="btn" disabled={!canUpdate} onClick={() => void editTaints()}>Taints</button>
          </>
        )}
        {kind === 'CronJob' && (
          <>
            <button
              className="btn"
              disabled={readOnly}
              onClick={() => void run(() => invoke('cronjob:suspend', contextId, namespace!, name, !object.spec?.suspend), object.spec?.suspend ? 'CronJob reanudado' : 'CronJob suspendido')}
            >
              {object.spec?.suspend ? 'Reanudar' : 'Suspender'}
            </button>
            <button
              className="btn"
              disabled={readOnly}
              onClick={() => void run(async () => toast(`Job ${await invoke('cronjob:trigger', contextId, namespace!, name)} creado`))}
            >
              Ejecutar ahora
            </button>
          </>
        )}
        <button className="btn" disabled={!canUpdate} onClick={() => void editMetadata()}>Etiquetas</button>
        <button className="btn" disabled={!canUpdate && !readOnly} onClick={() => actions.edit(object, resource)}>{canUpdate ? 'Editar YAML' : 'Ver YAML'}</button>
        <button className="btn danger" disabled={!canDelete} onClick={() => void remove()}>Eliminar</button>
      </div>
      <div className="details-body">
        <Section title="Metadatos">
          <dl className="props">
            {namespace && <Row label="Namespace">{namespace}</Row>}
            <Row label="Creado">{object.metadata.creationTimestamp ? `${new Date(object.metadata.creationTimestamp).toLocaleString('es')} (hace ${age(object.metadata.creationTimestamp)})` : '—'}</Row>
            <Row label="UID"><code>{object.metadata.uid}</code></Row>
            {object.metadata.deletionTimestamp && <Row label="Eliminándose"><Badge tone="warn">desde hace {age(object.metadata.deletionTimestamp)}</Badge></Row>}
            <Row label="Etiquetas"><Chips values={object.metadata.labels} /></Row>
            <Row label="Anotaciones"><Chips values={object.metadata.annotations} /></Row>
            {object.metadata.ownerReferences?.length ? (
              <Row label="Dueño">
                {object.metadata.ownerReferences.map((owner) => (
                  <button key={owner.uid} className="link" onClick={() => actions.navigate(owner.kind, namespace, owner.name)}>
                    {owner.kind}/{owner.name}
                  </button>
                ))}
              </Row>
            ) : null}
            {kind === 'Pod' && (
              <>
                <Row label="Estado"><Badge tone={statusTone(podStatus(object))}>{podStatus(object)}</Badge></Row>
                <Row label="Nodo">
                  {object.spec?.nodeName ? <button className="link" onClick={() => actions.navigate('Node', undefined, object.spec.nodeName)}>{object.spec.nodeName}</button> : '—'}
                </Row>
                <Row label="IP"><code>{object.status?.podIP}</code></Row>
              </>
            )}
            {object.spec?.replicas !== undefined && <Row label="Réplicas">{object.status?.readyReplicas ?? 0} listas de {object.spec.replicas}</Row>}
            {kind === 'CronJob' && <Row label="Programación"><code>{object.spec?.schedule}</code></Row>}
          </dl>
        </Section>
        <Conditions object={object} />
        {kind === 'Pod' && <PodContainers pod={object} readOnly={readOnly} onShell={(container) => actions.shell(object, container)} />}
        {kind === 'Service' && <ServiceInfo object={object} />}
        {kind === 'Node' && <NodeInfo object={object} />}
        <DataEntries object={object} />
        {isConfig && <ConfigUsers contextId={contextId} object={object} onOpen={(k, n) => actions.navigate(k, namespace, n)} />}
        {kind !== 'Pod' && <RelatedPods contextId={contextId} object={object} onOpen={onOpenPod} />}
        <Events contextId={contextId} object={object} />
      </div>
    </aside>
  )
}
