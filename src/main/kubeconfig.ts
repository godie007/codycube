import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { KubeConfig } from '@kubernetes/client-node'
import type { ClusterContext, KubeconfigFileInfo } from '../shared/types'

/** Lo que Codycube recuerda. Solo rutas y preferencias: nunca el contenido de los kubeconfig */
export interface StoredState {
  files: { path: string; managed: boolean }[]
  /** Comandos aceptados, por `<id de contexto>|<comando>`: otro comando vuelve a pedir permiso */
  trustedExec: string[]
  readOnly: string[]
  initialized: boolean
}

export const fileIdOf = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 12)

export function parseContextId(id: string): { fileId: string; name: string } {
  const slash = id.indexOf('/')
  if (slash < 0) throw new Error(`Contexto no válido: ${id}`)
  return { fileId: id.slice(0, slash), name: id.slice(slash + 1) }
}

/** Rutas por defecto de kubectl: $KUBECONFIG o ~/.kube/config */
export function defaultKubeconfigPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const fromEnv = (env.KUBECONFIG ?? '').split(delimiter).filter(Boolean)
  const paths = fromEnv.length ? fromEnv : [join(home, '.kube', 'config')]
  return paths.filter((path) => existsSync(path))
}

export class KubeconfigStore {
  private state: StoredState

  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'kubeconfigs'), { recursive: true, mode: 0o700 })
    this.state = this.load()
    if (!this.state.initialized) {
      this.state.initialized = true
      for (const path of defaultKubeconfigPaths()) this.state.files.push({ path, managed: false })
      this.save()
    }
  }

  private get statePath(): string {
    return join(this.dir, 'state.json')
  }

  private load(): StoredState {
    const empty: StoredState = { files: [], trustedExec: [], readOnly: [], initialized: false }
    try {
      return { ...empty, ...JSON.parse(readFileSync(this.statePath, 'utf8')) }
    } catch {
      return empty
    }
  }

  private save(): void {
    const temp = `${this.statePath}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    renameSync(temp, this.statePath)
  }

  get paths(): string[] {
    return this.state.files.map((file) => file.path)
  }

  /** Lanza si el archivo no es un kubeconfig utilizable */
  addPath(rawPath: string): void {
    const path = resolve(rawPath)
    const config = new KubeConfig()
    config.loadFromFile(path)
    if (config.getContexts().length === 0) throw new Error('El archivo no define ningún contexto')
    if (!this.state.files.some((file) => file.path === path)) {
      this.state.files.push({ path, managed: false })
      this.save()
    }
  }

  /** Kubeconfig pegado como texto: se guarda en los datos de la app, solo legible por el usuario */
  addText(text: string): void {
    const config = new KubeConfig()
    config.loadFromString(text)
    if (config.getContexts().length === 0) throw new Error('El texto no define ningún contexto')
    const path = join(this.dir, 'kubeconfigs', `${randomUUID()}.yaml`)
    writeFileSync(path, text, { mode: 0o600 })
    this.state.files.push({ path, managed: true })
    this.save()
  }

  remove(fileId: string): void {
    this.state.files = this.state.files.filter((file) => fileIdOf(file.path) !== fileId)
    this.save()
  }

  list(): { files: KubeconfigFileInfo[]; contexts: ClusterContext[] } {
    const files: KubeconfigFileInfo[] = []
    const contexts: ClusterContext[] = []
    for (const stored of this.state.files) {
      const id = fileIdOf(stored.path)
      const info: KubeconfigFileInfo = { id, path: stored.path, managed: stored.managed }
      files.push(info)
      try {
        const config = new KubeConfig()
        config.loadFromFile(stored.path)
        if (config.getContexts().length === 0) info.error = 'El archivo no define ningún contexto'
        for (const context of config.getContexts()) {
          const contextId = `${id}/${context.name}`
          const execCommand = config.getUser(context.user)?.exec?.command as string | undefined
          contexts.push({
            id: contextId,
            fileId: id,
            filePath: stored.path,
            name: context.name,
            cluster: context.cluster,
            user: context.user,
            server: config.getCluster(context.cluster)?.server ?? '',
            namespace: context.namespace,
            isCurrent: config.getCurrentContext() === context.name,
            execCommand,
            execTrusted: !execCommand || this.state.trustedExec.includes(`${contextId}|${execCommand}`),
            readOnly: this.state.readOnly.includes(contextId)
          })
        }
      } catch (error) {
        info.error = error instanceof Error ? error.message : String(error)
      }
    }
    return { files, contexts }
  }

  context(contextId: string): ClusterContext {
    const context = this.list().contexts.find((c) => c.id === contextId)
    if (!context) throw new Error('El contexto ya no existe en el kubeconfig')
    return context
  }

  /** KubeConfig listo para usar. Se relee cada vez que se conecta: el archivo es la fuente de verdad */
  configFor(contextId: string): KubeConfig {
    const context = this.context(contextId)
    if (!context.execTrusted) {
      throw new Error(`Falta autorizar el comando de autenticación «${context.execCommand}»`)
    }
    const config = new KubeConfig()
    config.loadFromFile(context.filePath)
    config.setCurrentContext(context.name)
    return config
  }

  trustExec(contextId: string): void {
    const command = this.context(contextId).execCommand
    if (!command) return
    const key = `${contextId}|${command}`
    if (!this.state.trustedExec.includes(key)) {
      this.state.trustedExec.push(key)
      this.save()
    }
  }

  setReadOnly(contextId: string, readOnly: boolean): void {
    this.state.readOnly = this.state.readOnly.filter((id) => id !== contextId)
    if (readOnly) this.state.readOnly.push(contextId)
    this.save()
  }

  isReadOnly(contextId: string): boolean {
    return this.state.readOnly.includes(contextId)
  }
}
