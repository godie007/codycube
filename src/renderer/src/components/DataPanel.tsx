import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { KubeObject, ResourceType } from '../../../shared/types'
import { invoke } from '../lib/api'
import {
  base64Size,
  bytesToBase64,
  diffEntries,
  dockerConfigJson,
  entriesOf,
  entriesProblem,
  missingKeys,
  newEntry,
  parseEnv,
  payloadOf,
  SECRET_TYPES,
  type DataEntry
} from '../lib/config-data'
import { useUi } from './ui'

export type DataMode = { kind: 'edit'; object: KubeObject; resource: ResourceType } | { kind: 'create'; resource: ResourceType; namespace?: string }

/** Lee un archivo como texto si es UTF-8 y, si no, como binario en base64 */
async function readFile(file: File): Promise<{ value: string; binary: boolean }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false }
  } catch {
    return { value: bytesToBase64(bytes), binary: true }
  }
}

const KIB = 1024
const size = (bytes: number): string => (bytes < KIB ? `${bytes} B` : bytes < KIB * KIB ? `${(bytes / KIB).toFixed(1)} KiB` : `${(bytes / KIB / KIB).toFixed(1)} MiB`)

/**
 * Edita las claves de un ConfigMap o un Secret sin tocar YAML ni base64. Al guardar enseña qué cambia y,
 * como los pods solo leen las variables al arrancar, ofrece reiniciar las cargas que las usan.
 */
export function DataPanel({
  contextId,
  mode,
  readOnly,
  onCreated,
  onUseYaml
}: {
  contextId: string
  mode: DataMode
  readOnly: boolean
  onCreated(object: KubeObject, resource: ResourceType): void
  /** Al crear: cambiar al editor YAML, p. ej. para pegar varios documentos */
  onUseYaml(): void
}): ReactNode {
  const { ask, run, toast } = useUi()
  const kind = mode.resource.kind as 'ConfigMap' | 'Secret'
  const secret = kind === 'Secret'
  const creating = mode.kind === 'create'

  const [object, setObject] = useState<KubeObject | null>(mode.kind === 'edit' ? mode.object : null)
  const [baseline, setBaseline] = useState<DataEntry[]>(() => (mode.kind === 'edit' ? entriesOf(mode.object) : []))
  const [entries, setEntries] = useState<DataEntry[]>(baseline)
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)

  // Solo al crear
  const [name, setName] = useState('')
  const [namespace, setNamespace] = useState(mode.kind === 'create' ? (mode.namespace ?? 'default') : '')
  const [type, setType] = useState('Opaque')
  const [immutable, setImmutable] = useState(false)
  const [registry, setRegistry] = useState({ server: 'https://index.docker.io/v1/', username: '', password: '', email: '' })

  const filePick = useRef<HTMLInputElement>(null)
  const fileTarget = useRef<number | 'new' | null>(null)

  // Lo que escribe la persona no debe perderse si la primera lectura llega tarde
  const touched = useRef(false)
  const load = async (initial = false): Promise<void> => {
    if (mode.kind !== 'edit') return
    const latest = await run(() => invoke('resource:get', contextId, { resource: mode.resource, namespace: mode.object.metadata.namespace, name: mode.object.metadata.name }))
    // Si ya editó, se sigue con la versión que vio: al guardar, un cambio ajeno dará conflicto
    if (!latest || (initial && touched.current)) return
    touched.current = false
    const fresh = entriesOf(latest)
    setObject(latest)
    setBaseline(fresh)
    // Las filas que siguen conservan su id: una pulsación en curso sigue encontrando su fila
    setEntries((current) => fresh.map((entry) => ({ ...entry, id: current.find((c) => c.key === entry.key)?.id ?? entry.id })))
    if (!initial) setRevealed(new Set())
  }

  useEffect(() => {
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const edit: typeof setEntries = (value) => {
    touched.current = true
    setEntries(value)
  }
  const update = (id: number, change: Partial<DataEntry>): void => edit((current) => current.map((e) => (e.id === id ? { ...e, ...change } : e)))
  const reveal = (id: number): void => setRevealed((current) => new Set(current).add(id))
  const add = (key = '', value = '', binary = false): void => {
    const entry = newEntry(key, value, binary)
    edit((current) => [...current, entry])
    reveal(entry.id)
  }

  // Al elegir un tipo de Secret aparecen sus claves obligatorias
  useEffect(() => {
    if (!creating || !secret || type === 'kubernetes.io/dockerconfigjson') return
    const required = SECRET_TYPES.find((t) => t.type === type)?.keys ?? []
    setEntries((current) => [...current, ...required.filter((key) => !current.some((e) => e.key === key)).map((key) => newEntry(key))])
  }, [creating, secret, type])

  const registryMode = creating && secret && type === 'kubernetes.io/dockerconfigjson'
  const finalEntries = useMemo(
    () => (registryMode ? [newEntry('.dockerconfigjson', dockerConfigJson(registry.server, registry.username, registry.password, registry.email || undefined))] : entries),
    [registryMode, registry, entries]
  )
  const changes = diffEntries(baseline, finalEntries)
  const dirty = creating || changes.added.length + changes.changed.length + changes.removed.length > 0
  const problem =
    (creating && !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(name) ? 'Escribe un nombre válido: minúsculas, números, «-» y «.»' : null) ??
    (registryMode && (!registry.server || !registry.username || !registry.password) ? 'Faltan el servidor, el usuario o la contraseña del registro' : null) ??
    entriesProblem(finalEntries) ??
    (secret && creating && missingKeys(type, finalEntries).length ? `Este tipo de Secret necesita: ${missingKeys(type, finalEntries).join(', ')}` : null)
  const locked = Boolean(object?.immutable)

  const pickFile = (target: number | 'new'): void => {
    fileTarget.current = target
    filePick.current?.click()
  }

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return
    if (file.size > 1024 * 1024) {
      toast(`${file.name} pesa ${size(file.size)}: un ConfigMap o un Secret admite como mucho 1 MiB en total`, 'bad')
      return
    }
    const { value, binary } = await readFile(file)
    const target = fileTarget.current
    if (target === 'new') add(file.name.replace(/[^-._a-zA-Z0-9]/g, '_'), value, binary)
    else if (typeof target === 'number') update(target, { value, binary })
  }

  const importEnv = async (): Promise<void> => {
    const answer = await ask({
      title: 'Importar variables',
      confirm: 'Importar',
      body: 'Pega líneas CLAVE=valor, como en un archivo .env. Las claves que ya existen se sustituyen.',
      fields: [{ name: 'text', label: 'Contenido', type: 'textarea', placeholder: 'DATABASE_URL=postgres://…\nLOG_LEVEL=info' }]
    })
    if (!answer) return
    const { pairs, invalid } = parseEnv(String(answer.text))
    edit((current) => {
      const next = [...current]
      for (const [key, value] of pairs) {
        const existing = next.findIndex((e) => e.key === key)
        if (existing >= 0) next[existing] = { ...next[existing], value, binary: false }
        else next.push(newEntry(key, value))
      }
      return next
    })
    toast(`${pairs.length} variables importadas${invalid.length ? `; se ignoraron las líneas ${invalid.join(', ')}` : ''}`, invalid.length ? 'bad' : 'ok')
  }

  const offerRestart = async (target: KubeObject): Promise<void> => {
    const users = await run(() => invoke('resource:config-users', contextId, kind, target.metadata.namespace!, target.metadata.name))
    const restartable = (users ?? []).filter((u) => u.restartable)
    if (restartable.length === 0) return
    const answer = await ask({
      title: 'Aplicar el cambio en los pods',
      confirm: 'Reiniciar seleccionadas',
      body: 'Las variables de entorno solo se leen al arrancar el pod. Los volúmenes se actualizan solos en un minuto, salvo los montados con subPath. Reiniciar recrea los pods de forma progresiva.',
      fields: restartable.map((user, index) => ({
        name: String(index),
        label: `${user.resource.kind} ${user.name} — ${user.references.join(', ')}`,
        type: 'checkbox' as const,
        value: user.references.some((r) => !r.startsWith('volumen'))
      }))
    })
    if (!answer) return
    const chosen = restartable.filter((_, index) => answer[String(index)])
    for (const user of chosen) await run(() => invoke('resource:restart', contextId, { resource: user.resource, namespace: target.metadata.namespace, name: user.name }))
    if (chosen.length) toast(`Reinicio en curso: ${chosen.map((u) => u.name).join(', ')}`)
  }

  const save = async (): Promise<void> => {
    if (problem || saving) return
    if (mode.kind === 'edit' && object) {
      const lines = [
        changes.added.length ? `Añadidas: ${changes.added.join(', ')}` : '',
        changes.changed.length ? `Cambiadas: ${changes.changed.join(', ')}` : '',
        changes.removed.length ? `Eliminadas: ${changes.removed.join(', ')}` : ''
      ].filter(Boolean)
      const confirmed = await ask({
        title: `Guardar ${kind} ${object.metadata.name}`,
        confirm: 'Guardar',
        danger: changes.removed.length > 0,
        body: (
          <div className="data-diff">
            {lines.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        )
      })
      if (!confirmed) return
      setSaving(true)
      try {
        const ref = { resource: mode.resource, namespace: object.metadata.namespace, name: object.metadata.name }
        const saved = await run(() => invoke('resource:set-data', contextId, ref, object.metadata.resourceVersion!, payloadOf(kind, finalEntries)), `${object.metadata.name} guardado`)
        if (!saved) return
        const fresh = entriesOf({ ...saved, kind })
        setObject({ ...saved, kind })
        touched.current = false
        setBaseline(fresh)
        setEntries(fresh)
        setRevealed(new Set())
        await offerRestart(saved)
      } finally {
        setSaving(false)
      }
      return
    }
    setSaving(true)
    try {
      const payload = payloadOf(kind, finalEntries)
      const body: KubeObject = {
        apiVersion: 'v1',
        kind,
        metadata: { name, namespace },
        ...(secret ? { type } : {}),
        data: payload.data,
        ...(payload.binaryData && Object.keys(payload.binaryData).length ? { binaryData: payload.binaryData } : {}),
        ...(immutable ? { immutable: true } : {})
      } as KubeObject
      const created = await run(() => invoke('resource:create', contextId, body), `${kind} ${name} creado`)
      if (created) onCreated({ ...created, kind, apiVersion: 'v1' }, mode.resource)
    } finally {
      setSaving(false)
    }
  }

  const needle = filter.trim().toLowerCase()
  const shown = entries.filter((e) => !needle || e.key.toLowerCase().includes(needle))
  const editable = !readOnly && !locked
  const total = finalEntries.reduce((sum, e) => sum + (e.binary ? base64Size(e.value) : new TextEncoder().encode(e.value).length), 0)

  return (
    <div className="data-panel" data-testid="data-panel">
      <div className="logs-bar">
        <input className="data-filter" aria-label="Filtrar claves" placeholder="Filtrar claves" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="dim small">
          {finalEntries.length} {finalEntries.length === 1 ? 'clave' : 'claves'} · {size(total)}
        </span>
        <div className="spacer" />
        {!registryMode && (
          <>
            <button className="btn" disabled={!editable} onClick={() => add()}>Añadir clave</button>
            <button className="btn" disabled={!editable} onClick={() => pickFile('new')}>Desde archivo</button>
            <button className="btn" disabled={!editable} onClick={() => void importEnv()}>Importar .env</button>
          </>
        )}
        {!creating && <button className="btn" onClick={() => void load()}>Recargar</button>}
        {creating && <button className="btn" onClick={onUseYaml}>Usar YAML</button>}
        <button className="btn primary" disabled={!editable || !dirty || Boolean(problem) || saving} title={problem ?? undefined} onClick={() => void save()}>
          {creating ? 'Crear' : 'Guardar'}
        </button>
      </div>
      <input ref={filePick} type="file" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
      <div className="data-body">
        {locked && <div className="notice warn">Este {kind} es inmutable: Kubernetes no deja cambiar sus datos. Crea uno nuevo con otro nombre.</div>}
        {readOnly && <div className="notice">Modo solo lectura: puedes ver los datos, no guardarlos.</div>}
        {creating && (
          <div className="data-form">
            <label>
              <span>Nombre</span>
              <input aria-label="Nombre" value={name} onChange={(e) => setName(e.target.value.trim())} placeholder={secret ? 'credenciales-app' : 'config-app'} autoFocus />
            </label>
            <label>
              <span>Namespace</span>
              <input aria-label="Namespace del objeto" value={namespace} onChange={(e) => setNamespace(e.target.value.trim())} />
            </label>
            {secret && (
              <label>
                <span>Tipo</span>
                <select aria-label="Tipo de Secret" value={type} onChange={(e) => setType(e.target.value)}>
                  {SECRET_TYPES.map((t) => (
                    <option key={t.type} value={t.type}>{t.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={immutable} onChange={(e) => setImmutable(e.target.checked)} />
              <span>Inmutable</span>
            </label>
          </div>
        )}
        {registryMode ? (
          <div className="data-form registry">
            {(
              [
                ['server', 'Servidor del registro', 'text'],
                ['username', 'Usuario', 'text'],
                ['password', 'Contraseña o token', 'password'],
                ['email', 'Email (opcional)', 'text']
              ] as const
            ).map(([field, label, inputType]) => (
              <label key={field}>
                <span>{label}</span>
                <input aria-label={label} type={inputType} value={registry[field]} onChange={(e) => setRegistry({ ...registry, [field]: e.target.value })} />
              </label>
            ))}
            <p className="dim small">Se guarda como «.dockerconfigjson». Úsalo en imagePullSecrets del pod o de su ServiceAccount.</p>
          </div>
        ) : (
          <div className="data-rows">
            {shown.length === 0 && <div className="dim small data-empty">{entries.length ? 'Ninguna clave coincide con el filtro' : 'Sin claves. Añade una, cárgala desde un archivo o importa un .env.'}</div>}
            {shown.map((entry) => {
              const masked = secret && !revealed.has(entry.id)
              const original = baseline.find((b) => b.key === entry.key)
              const state = !original ? 'nueva' : original.value !== entry.value || original.binary !== entry.binary ? 'cambiada' : ''
              const lines = entry.binary ? 1 : entry.value.split('\n').length
              return (
                <div key={entry.id} className={`data-row ${state ? 'dirty' : ''}`} data-key={entry.key}>
                  <div className="data-row-key">
                    <input aria-label="Clave" value={entry.key} placeholder="CLAVE" disabled={!editable} onChange={(e) => update(entry.id, { key: e.target.value.trim() })} />
                    {state && <span className="data-state">{state}</span>}
                  </div>
                  <div className="data-row-value">
                    {entry.binary ? (
                      <div className="data-binary dim small">
                        Binario, {size(base64Size(entry.value))}. Se conserva tal cual; cárgalo desde un archivo para sustituirlo.
                      </div>
                    ) : masked ? (
                      <button className="data-masked" aria-label={`Mostrar ${entry.key}`} onClick={() => reveal(entry.id)}>
                        {'•'.repeat(Math.min(12, Math.max(6, entry.value.length)))} <span className="dim small">mostrar</span>
                      </button>
                    ) : (
                      <textarea
                        aria-label={`Valor de ${entry.key || 'la clave nueva'}`}
                        value={entry.value}
                        rows={Math.min(14, Math.max(1, lines))}
                        spellCheck={false}
                        disabled={!editable}
                        onChange={(e) => update(entry.id, { value: e.target.value })}
                      />
                    )}
                  </div>
                  <div className="data-row-actions">
                    {secret && !entry.binary && revealed.has(entry.id) && (
                      <button className="link" onClick={() => setRevealed((current) => { const next = new Set(current); next.delete(entry.id); return next })}>Ocultar</button>
                    )}
                    {!entry.binary && (
                      <button className="link" onClick={() => void navigator.clipboard.writeText(entry.value).then(() => toast(`${entry.key} copiado`))}>Copiar</button>
                    )}
                    <button className="link" disabled={!editable} onClick={() => pickFile(entry.id)}>Archivo</button>
                    <button className="link danger" aria-label={`Quitar ${entry.key}`} disabled={!editable} onClick={() => edit((current) => current.filter((e) => e.id !== entry.id))}>Quitar</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {problem && dirty && <div className="notice warn" role="status">{problem}</div>}
      </div>
    </div>
  )
}
