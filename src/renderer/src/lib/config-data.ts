import type { KubeObject } from '../../../shared/types'

/** Una clave de un ConfigMap o un Secret tal como se edita: texto, o binario que se conserva en base64 */
export interface DataEntry {
  id: number
  key: string
  /** Texto si `binary` es falso; base64 si es verdadero */
  value: string
  binary: boolean
}

let nextId = 1
export const newEntry = (key = '', value = '', binary = false): DataEntry => ({ id: nextId++, key, value, binary })

export function bytesToBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

export const textToBase64 = (text: string): string => bytesToBase64(new TextEncoder().encode(text))

/** Descodifica base64 como UTF-8; null si no es texto */
export function base64ToText(value: string): string | null {
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export const base64Size = (value: string): number => Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)

/** Lo que hay en el objeto, listo para editar. Los Secrets se muestran descodificados */
export function entriesOf(object: KubeObject): DataEntry[] {
  const data = (object.data ?? {}) as Record<string, string>
  if (object.kind === 'Secret') {
    return Object.entries(data).map(([key, value]) => {
      const text = base64ToText(value)
      return text === null ? newEntry(key, value, true) : newEntry(key, text)
    })
  }
  const binary = (object.binaryData ?? {}) as Record<string, string>
  return [...Object.entries(data).map(([key, value]) => newEntry(key, value)), ...Object.entries(binary).map(([key, value]) => newEntry(key, value, true))]
}

/** Lo que espera la API: en un Secret todo en base64; en un ConfigMap texto en `data` y binarios en `binaryData` */
export function payloadOf(kind: string, entries: DataEntry[]): { data: Record<string, string>; binaryData?: Record<string, string> } {
  const data: Record<string, string> = {}
  const binaryData: Record<string, string> = {}
  for (const entry of entries) {
    if (kind === 'Secret') data[entry.key] = entry.binary ? entry.value : textToBase64(entry.value)
    else if (entry.binary) binaryData[entry.key] = entry.value
    else data[entry.key] = entry.value
  }
  return kind === 'Secret' ? { data } : { data, binaryData }
}

const KEY = /^[-._a-zA-Z0-9]+$/

/** El primer problema que impide guardar, o null */
export function entriesProblem(entries: DataEntry[]): string | null {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.key) return 'Hay una clave vacía'
    if (entry.key.length > 253 || !KEY.test(entry.key)) return `Clave no válida: «${entry.key}». Solo letras, números, «-», «_» y «.»`
    if (seen.has(entry.key)) return `Clave repetida: «${entry.key}»`
    seen.add(entry.key)
  }
  return null
}

/** Qué cambió respecto a lo guardado, para confirmarlo antes de escribir */
export function diffEntries(before: DataEntry[], after: DataEntry[]): { added: string[]; changed: string[]; removed: string[] } {
  const old = new Map(before.map((e) => [e.key, e]))
  const now = new Map(after.map((e) => [e.key, e]))
  return {
    added: after.filter((e) => !old.has(e.key)).map((e) => e.key),
    changed: after.filter((e) => old.has(e.key) && (old.get(e.key)!.value !== e.value || old.get(e.key)!.binary !== e.binary)).map((e) => e.key),
    removed: before.filter((e) => !now.has(e.key)).map((e) => e.key)
  }
}

/**
 * Lee líneas `CLAVE=valor` como un archivo .env: ignora comentarios y líneas vacías, admite `export` y
 * comillas. Devuelve también las líneas que no entendió, para avisar en lugar de perderlas en silencio.
 */
export function parseEnv(text: string): { pairs: [string, string][]; invalid: number[] } {
  const pairs: [string, string][] = []
  const invalid: number[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (!match) {
      invalid.push(index + 1)
      return
    }
    let value = match[2]
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted) value = quoted[1] === '"' ? quoted[2].replace(/\\n/g, '\n').replace(/\\"/g, '"') : quoted[2]
    pairs.push([match[1], value])
  })
  return { pairs, invalid }
}

/** `.dockerconfigjson` para descargar imágenes de un registro privado, como `kubectl create secret docker-registry` */
export function dockerConfigJson(server: string, username: string, password: string, email?: string): string {
  const auth = textToBase64(`${username}:${password}`)
  return JSON.stringify({ auths: { [server]: { username, password, ...(email ? { email } : {}), auth } } })
}

/** Claves que exige cada tipo de Secret */
export const SECRET_TYPES: { type: string; label: string; keys: string[] }[] = [
  { type: 'Opaque', label: 'Genérico (Opaque)', keys: [] },
  { type: 'kubernetes.io/dockerconfigjson', label: 'Credenciales de registro de imágenes', keys: ['.dockerconfigjson'] },
  { type: 'kubernetes.io/tls', label: 'Certificado TLS', keys: ['tls.crt', 'tls.key'] },
  { type: 'kubernetes.io/basic-auth', label: 'Usuario y contraseña', keys: ['username', 'password'] },
  { type: 'kubernetes.io/ssh-auth', label: 'Clave SSH', keys: ['ssh-privatekey'] }
]

/** Lo que falta para que el servidor acepte un Secret de ese tipo */
export function missingKeys(type: string, entries: DataEntry[]): string[] {
  const required = SECRET_TYPES.find((t) => t.type === type)?.keys ?? []
  const present = new Set(entries.filter((e) => e.value !== '').map((e) => e.key))
  return required.filter((key) => !present.has(key))
}

/** Pares `clave=valor` por línea, el formato de `kubectl label` */
export function parsePairs(text: string, what: string): Record<string, string> {
  const result: Record<string, string> = {}
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    const at = line.indexOf('=')
    if (at <= 0) throw new Error(`${what}, línea ${index + 1}: falta «clave=valor»`)
    const key = line.slice(0, at).trim()
    if (key in result) throw new Error(`${what}: clave repetida «${key}»`)
    result[key] = line.slice(at + 1).trim()
  })
  return result
}

export const formatPairs = (values: Record<string, string>): string =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

/** Taints con la sintaxis de `kubectl taint`: `clave=valor:Efecto` o `clave:Efecto` */
export function parseTaints(text: string): { key: string; value?: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = /^([^=:\s]+)(?:=([^:\s]*))?:(NoSchedule|PreferNoSchedule|NoExecute)$/.exec(line)
      if (!match) throw new Error(`Línea ${index + 1}: usa «clave=valor:Efecto», con Efecto NoSchedule, PreferNoSchedule o NoExecute`)
      return { key: match[1], ...(match[2] ? { value: match[2] } : {}), effect: match[3] as 'NoSchedule' }
    })
}

export const formatTaints = (taints: { key: string; value?: string; effect: string }[] = []): string =>
  taints.map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`).join('\n')
