import { spawn } from 'node:child_process'
import type { ClusterContext, HelmRelease, HelmRevision } from '../shared/types'

/** Helm guarda las releases en su propio formato: usar su CLI evita reimplementarlo */
function run(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Argumentos como lista y sin shell: un nombre no puede inyectar comandos
    const child = spawn('helm', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'ENOENT' ? new Error('No se encontró helm en el PATH. Instálalo para usar esta sección.') : error)
    )
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `helm salió con código ${code}`))))
    child.stdin.end(input)
  })
}

const scope = (context: ClusterContext): string[] => ['--kubeconfig', context.filePath, '--kube-context', context.name]

const DNS_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/

function assertName(value: string, what: string): void {
  if (!DNS_NAME.test(value)) throw new Error(`${what} no válido: ${value}`)
}

export async function helmVersion(): Promise<string | null> {
  try {
    return (await run(['version', '--short'])).trim()
  } catch {
    return null
  }
}

export async function helmList(context: ClusterContext, namespace?: string): Promise<HelmRelease[]> {
  const where = namespace ? ['--namespace', namespace] : ['--all-namespaces']
  return JSON.parse((await run(['list', '--output', 'json', '--max', '0', ...where, ...scope(context)])) || '[]')
}

export async function helmHistory(context: ClusterContext, namespace: string, name: string): Promise<HelmRevision[]> {
  assertName(name, 'Nombre')
  const output = await run(['history', name, '--output', 'json', '--namespace', namespace, ...scope(context)])
  return (JSON.parse(output) as HelmRevision[]).reverse()
}

export async function helmValues(context: ClusterContext, namespace: string, name: string): Promise<string> {
  assertName(name, 'Nombre')
  return run(['get', 'values', name, '--all', '--output', 'yaml', '--namespace', namespace, ...scope(context)])
}

export async function helmManifest(context: ClusterContext, namespace: string, name: string): Promise<string> {
  assertName(name, 'Nombre')
  return run(['get', 'manifest', name, '--namespace', namespace, ...scope(context)])
}

export async function helmRollback(context: ClusterContext, namespace: string, name: string, revision: number): Promise<void> {
  assertName(name, 'Nombre')
  if (!Number.isInteger(revision) || revision <= 0) throw new Error('Revisión no válida')
  await run(['rollback', name, String(revision), '--namespace', namespace, ...scope(context)])
}

export async function helmUninstall(context: ClusterContext, namespace: string, name: string): Promise<void> {
  assertName(name, 'Nombre')
  await run(['uninstall', name, '--namespace', namespace, ...scope(context)])
}

/** Instala o actualiza una release. Los valores van por stdin: no quedan en disco ni en la línea de comandos */
export async function helmInstall(context: ClusterContext, namespace: string, name: string, chart: string, values: string): Promise<void> {
  assertName(name, 'Nombre')
  assertName(namespace, 'Namespace')
  if (!chart.trim() || chart.startsWith('-')) throw new Error('Chart no válido')
  await run(
    ['upgrade', name, chart.trim(), '--install', '--create-namespace', '--namespace', namespace, '--values', '-', ...scope(context)],
    values
  )
}
