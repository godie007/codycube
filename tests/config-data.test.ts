import { describe, expect, it } from 'vitest'
import { configReferences, podSpecOf, validateDataKeys } from '../src/main/actions'
import {
  base64Size,
  base64ToText,
  diffEntries,
  dockerConfigJson,
  entriesOf,
  entriesProblem,
  formatTaints,
  missingKeys,
  newEntry,
  parseEnv,
  parsePairs,
  parseTaints,
  payloadOf,
  textToBase64
} from '../src/renderer/src/lib/config-data'
import type { KubeObject } from '../src/shared/types'

const meta = { name: 'x', namespace: 'n' }

describe('datos de ConfigMaps y Secrets', () => {
  it('codifica y descodifica UTF-8 sin perder caracteres', () => {
    const text = 'contraseña: ñandú 🚀\nlínea 2'
    expect(base64ToText(textToBase64(text))).toBe(text)
    expect(base64Size(textToBase64('abcd'))).toBe(4)
    expect(base64Size(textToBase64('abcde'))).toBe(5)
  })

  it('un Secret se edita descodificado y un binario se conserva tal cual', () => {
    const binary = btoa(String.fromCharCode(0xff, 0xfe, 0x00))
    const secret = { kind: 'Secret', metadata: meta, data: { user: textToBase64('admin'), blob: binary } } as unknown as KubeObject
    const entries = entriesOf(secret)
    expect(entries.map((e) => [e.key, e.value, e.binary])).toEqual([
      ['user', 'admin', false],
      ['blob', binary, true]
    ])
    expect(payloadOf('Secret', entries)).toEqual({ data: { user: textToBase64('admin'), blob: binary } })
  })

  it('un ConfigMap separa texto y binaryData', () => {
    const cm = { kind: 'ConfigMap', metadata: meta, data: { a: '1' }, binaryData: { b: 'AAE=' } } as unknown as KubeObject
    const entries = entriesOf(cm)
    expect(payloadOf('ConfigMap', entries)).toEqual({ data: { a: '1' }, binaryData: { b: 'AAE=' } })
  })

  it('detecta claves vacías, repetidas o con caracteres no válidos', () => {
    expect(entriesProblem([newEntry('A_b.c-1', 'x')])).toBeNull()
    expect(entriesProblem([newEntry('', 'x')])).toMatch(/vacía/)
    expect(entriesProblem([newEntry('a', '1'), newEntry('a', '2')])).toMatch(/repetida/)
    expect(entriesProblem([newEntry('con espacio', '1')])).toMatch(/no válida/)
    expect(() => validateDataKeys(['a/b'])).toThrow(/no válida/)
    expect(() => validateDataKeys(['a', 'a'])).toThrow(/repetida/)
  })

  it('resume qué se añade, cambia y elimina', () => {
    const before = [newEntry('a', '1'), newEntry('b', '2'), newEntry('c', '3')]
    const after = [newEntry('a', '1'), newEntry('b', '20'), newEntry('d', '4')]
    expect(diffEntries(before, after)).toEqual({ added: ['d'], changed: ['b'], removed: ['c'] })
  })

  it('lee un .env con comentarios, export y comillas, y señala lo que no entiende', () => {
    const { pairs, invalid } = parseEnv('# comentario\nexport A=1\nB = "dos\\nlíneas"\nC=\'literal\\n\'\nesto no vale\n\nD=a=b')
    expect(pairs).toEqual([
      ['A', '1'],
      ['B', 'dos\nlíneas'],
      ['C', 'literal\\n'],
      ['D', 'a=b']
    ])
    expect(invalid).toEqual([5])
  })

  it('genera un .dockerconfigjson como kubectl', () => {
    const json = JSON.parse(dockerConfigJson('ghcr.io', 'yo', 's3cr3t'))
    expect(json.auths['ghcr.io']).toEqual({ username: 'yo', password: 's3cr3t', auth: btoa('yo:s3cr3t') })
  })

  it('exige las claves de cada tipo de Secret', () => {
    expect(missingKeys('kubernetes.io/tls', [newEntry('tls.crt', 'x'), newEntry('tls.key', '')])).toEqual(['tls.key'])
    expect(missingKeys('Opaque', [])).toEqual([])
  })

  it('etiquetas y taints con la sintaxis de kubectl', () => {
    expect(parsePairs('app=web\n\nnivel = alto\nvacía=', 'Etiquetas')).toEqual({ app: 'web', nivel: 'alto', 'vacía': '' })
    expect(() => parsePairs('sinigual', 'Etiquetas')).toThrow(/línea 1/)
    const taints = parseTaints('dedicado=gpu:NoSchedule\nmantenimiento:NoExecute')
    expect(taints).toEqual([
      { key: 'dedicado', value: 'gpu', effect: 'NoSchedule' },
      { key: 'mantenimiento', effect: 'NoExecute' }
    ])
    expect(formatTaints(taints)).toBe('dedicado=gpu:NoSchedule\nmantenimiento:NoExecute')
    expect(() => parseTaints('a=b:Nada')).toThrow(/Efecto/)
  })
})

describe('quién usa un ConfigMap o un Secret', () => {
  const spec = {
    volumes: [
      { name: 'conf', configMap: { name: 'app' } },
      { name: 'todo', projected: { sources: [{ secret: { name: 'claves' } }] } }
    ],
    imagePullSecrets: [{ name: 'registro' }],
    initContainers: [{ name: 'init', envFrom: [{ configMapRef: { name: 'app' } }] }],
    containers: [{ name: 'web', env: [{ name: 'PASS', valueFrom: { secretKeyRef: { name: 'claves', key: 'p' } } }] }]
  }

  it('encuentra volúmenes, variables, envFrom y credenciales de registro', () => {
    expect(configReferences(spec, 'ConfigMap', 'app')).toEqual(['volumen conf', 'todas sus claves como variables (init)'])
    expect(configReferences(spec, 'Secret', 'claves')).toEqual(['volumen todo', 'variable PASS (web)'])
    expect(configReferences(spec, 'Secret', 'registro')).toEqual(['credenciales del registro'])
    expect(configReferences(spec, 'ConfigMap', 'otro')).toEqual([])
  })

  it('sabe dónde está la plantilla de pod en cada tipo', () => {
    const template = { spec: { containers: [{ name: 'c' }] } }
    expect(podSpecOf({ kind: 'Deployment', metadata: meta, spec: { template } } as unknown as KubeObject)).toBe(template.spec)
    expect(podSpecOf({ kind: 'CronJob', metadata: meta, spec: { jobTemplate: { spec: { template } } } } as unknown as KubeObject)).toBe(template.spec)
    expect(podSpecOf({ kind: 'Pod', metadata: meta, spec: template.spec } as unknown as KubeObject)).toBe(template.spec)
  })
})
