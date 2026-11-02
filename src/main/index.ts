import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain, session, shell, type WebContents } from 'electron'
import type { Api, ApiMethod } from '../shared/types'
import * as actions from './actions'
import * as helm from './helm'
import { KubeClient } from './kube-client'
import { KubeconfigStore } from './kubeconfig'
import { PortForwards, startTerminal, streamLogs, type TerminalSession } from './streams'
import { startTraffic } from './traffic'
import { watchResource } from './watch'

if (!app.isPackaged && process.env.CODYCUBE_USER_DATA) app.setPath('userData', process.env.CODYCUBE_USER_DATA)

let mainWindow: BrowserWindow | null = null
let store: KubeconfigStore

const clients = new Map<string, KubeClient>()
const stoppers = new Map<string, () => void>()
const terminals = new Map<string, TerminalSession>()

const emit = (channel: string, payload?: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}
const forwards = new PortForwards((list) => emit('codycube:forwards', list))

function clientFor(contextId: string): KubeClient {
  let client = clients.get(contextId)
  if (!client) {
    client = new KubeClient(store.configFor(contextId))
    clients.set(contextId, client)
  }
  return client
}

/** El modo solo lectura se aplica aquí, no en la interfaz: ninguna ruta de código puede saltárselo */
function writable(contextId: string): KubeClient {
  if (store.isReadOnly(contextId)) throw new Error('Este clúster está en modo solo lectura')
  return clientFor(contextId)
}
const writableContext = (contextId: string) => {
  writable(contextId)
  return store.context(contextId)
}
const readableContext = (contextId: string) => {
  clientFor(contextId)
  return store.context(contextId)
}

function stopStream(id: string): void {
  stoppers.get(id)?.()
  stoppers.delete(id)
}

function stopAllSessions(): void {
  for (const id of [...stoppers.keys()]) stopStream(id)
  for (const terminal of terminals.values()) terminal.stop()
  terminals.clear()
}

const handlers: { [M in ApiMethod]: (...args: Parameters<Api[M]>) => ReturnType<Api[M]> | Promise<ReturnType<Api[M]>> } = {
  'config:list': () => store.list(),
  'config:pick': async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Cargar kubeconfig',
      properties: ['openFile', 'showHiddenFiles', 'multiSelections']
    })
    if (result.canceled) return null
    for (const path of result.filePaths) store.addPath(path)
    watchConfigFiles()
    return store.list()
  },
  'config:add-path': (path) => {
    store.addPath(path)
    watchConfigFiles()
    return store.list()
  },
  'config:add-text': (text) => {
    store.addText(text)
    watchConfigFiles()
    return store.list()
  },
  'config:remove': (fileId) => {
    store.remove(fileId)
    for (const id of [...clients.keys()]) if (id.startsWith(`${fileId}/`)) clients.delete(id)
    watchConfigFiles()
    return store.list()
  },
  'config:trust-exec': (contextId) => store.trustExec(contextId),
  'config:set-read-only': (contextId, readOnly) => store.setReadOnly(contextId, readOnly),

  'cluster:connect': async (contextId) => {
    // Cliente nuevo: el kubeconfig pudo cambiar desde la última vez
    clients.delete(contextId)
    return clientFor(contextId).clusterInfo()
  },
  'cluster:disconnect': (contextId) => {
    forwards.stopFor(contextId)
    clients.delete(contextId)
  },
  'cluster:metrics': (contextId) => actions.clusterMetrics(clientFor(contextId)),
  'resource:list': (contextId, resource, namespace) => clientFor(contextId).listItems(resource, namespace),
  'resource:get': (contextId, ref) => actions.getObject(clientFor(contextId), ref),
  'resource:watch': (contextId, resource, namespace) => {
    const watchId = randomUUID()
    const stop = watchResource(clientFor(contextId), resource, namespace, watchId, (message) => emit('codycube:watch', message))
    stoppers.set(watchId, stop)
    return watchId
  },
  'resource:unwatch': (watchId) => stopStream(watchId),
  'resource:events-for': (contextId, object) => actions.eventsFor(clientFor(contextId), object),
  'resource:pods-for': (contextId, object) => actions.podsFor(clientFor(contextId), object),

  'resource:update': (contextId, ref, text) => actions.updateFromYaml(writable(contextId), ref, text),
  // Una simulación no persiste nada: también se permite en solo lectura
  'resource:apply': (contextId, text, namespace, dryRun) =>
    actions.applyYaml(dryRun ? clientFor(contextId) : writable(contextId), text, namespace, dryRun),
  'resource:delete': (contextId, ref, options) => actions.deleteObject(writable(contextId), ref, options),
  'resource:scale': (contextId, ref, replicas) => actions.scale(writable(contextId), ref, replicas),
  'resource:restart': (contextId, ref) => actions.restart(writable(contextId), ref),
  'deployment:revisions': (contextId, namespace, name) => actions.deploymentRevisions(clientFor(contextId), namespace, name),
  'deployment:rollback': (contextId, namespace, name, revision) => actions.rollback(writable(contextId), namespace, name, revision),
  'node:cordon': (contextId, name, unschedulable) => actions.cordon(writable(contextId), name, unschedulable),
  'node:drain': (contextId, name, options) => actions.drain(writable(contextId), name, options),
  'resource:set-data': (contextId, ref, resourceVersion, payload) => actions.replaceData(writable(contextId), ref, resourceVersion, payload),
  'resource:set-metadata': (contextId, ref, resourceVersion, labels, annotations) =>
    actions.setMetadata(writable(contextId), ref, resourceVersion, labels, annotations),
  'resource:create': (contextId, object) => actions.createObject(writable(contextId), object),
  'resource:set-images': (contextId, ref, changes) => actions.setImages(writable(contextId), ref, changes),
  'resource:config-users': (contextId, kind, namespace, name) => actions.configUsers(clientFor(contextId), kind, namespace, name),
  'deployment:pause': (contextId, namespace, name, paused) => actions.pauseDeployment(writable(contextId), namespace, name, paused),
  'node:taints': (contextId, name, resourceVersion, taints) => actions.setTaints(writable(contextId), name, resourceVersion, taints),
  'cronjob:suspend': (contextId, namespace, name, suspend) => actions.suspendCronJob(writable(contextId), namespace, name, suspend),
  'cronjob:trigger': (contextId, namespace, name) => actions.triggerCronJob(writable(contextId), namespace, name),

  'logs:start': (contextId, options) => {
    const streamId = randomUUID()
    stoppers.set(streamId, streamLogs(clientFor(contextId), options, streamId, (message) => emit('codycube:logs', message)))
    return streamId
  },
  'logs:stop': (streamId) => stopStream(streamId),
  'traffic:start': (contextId, namespaces, intervalSeconds) => {
    if (!Array.isArray(namespaces) || namespaces.some((n) => typeof n !== 'string')) throw new Error('Lista de namespaces no válida')
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 300) throw new Error('Frecuencia de lectura no válida')
    const sessionId = randomUUID()
    stoppers.set(sessionId, startTraffic(clientFor(contextId), namespaces, sessionId, intervalSeconds, (snapshot) => emit('codycube:traffic', snapshot)))
    return sessionId
  },
  'traffic:stop': (sessionId) => stopStream(sessionId),
  'logs:save': async (fileName, content) => {
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: basename(fileName) })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, content)
    return result.filePath
  },

  // Una terminal permite cambiar lo que sea dentro del contenedor: cuenta como escritura
  'exec:start': async (contextId, namespace, pod, container, cols, rows) => {
    const terminalId = randomUUID()
    const terminal = await startTerminal(writable(contextId), namespace, pod, container, cols, rows, terminalId, (message) => {
      if (message.kind === 'exit') terminals.delete(terminalId)
      emit('codycube:terminal', message)
    })
    terminals.set(terminalId, terminal)
    return terminalId
  },
  'exec:input': (terminalId, data) => terminals.get(terminalId)?.input(data),
  'exec:resize': (terminalId, cols, rows) => terminals.get(terminalId)?.resize(cols, rows),
  'exec:stop': (terminalId) => {
    terminals.get(terminalId)?.stop()
    terminals.delete(terminalId)
  },

  'forward:list': () => forwards.list(),
  'forward:start': (contextId, namespace, kind, name, remotePort, localPort) =>
    forwards.start(clientFor(contextId), contextId, namespace, kind, name, remotePort, localPort),
  'forward:stop': (id) => forwards.stop(id),
  'forward:open': (id) => {
    const info = forwards.get(id)
    if (info) void shell.openExternal(`http://127.0.0.1:${info.localPort}/`)
  },

  'helm:available': () => helm.helmVersion(),
  'helm:list': (contextId, namespace) => helm.helmList(readableContext(contextId), namespace),
  'helm:history': (contextId, namespace, name) => helm.helmHistory(readableContext(contextId), namespace, name),
  'helm:values': (contextId, namespace, name) => helm.helmValues(readableContext(contextId), namespace, name),
  'helm:manifest': (contextId, namespace, name) => helm.helmManifest(readableContext(contextId), namespace, name),
  'helm:rollback': (contextId, namespace, name, revision) => helm.helmRollback(writableContext(contextId), namespace, name, revision),
  'helm:uninstall': (contextId, namespace, name) => helm.helmUninstall(writableContext(contextId), namespace, name),
  'helm:install': (contextId, namespace, name, chart, values) => helm.helmInstall(writableContext(contextId), namespace, name, chart, values)
}

let configWatchers: FSWatcher[] = []
let configTimer: NodeJS.Timeout | undefined

/**
 * Se vigila la carpeta y no el archivo: kubectl y gcloud reemplazan el kubeconfig renombrando, lo
 * que dejaría sin efecto un watcher puesto sobre el archivo original.
 */
function watchConfigFiles(): void {
  for (const watcher of configWatchers) watcher.close()
  configWatchers = []
  const names = new Map<string, Set<string>>()
  for (const path of store.paths) {
    const set = names.get(dirname(path)) ?? new Set()
    set.add(basename(path))
    names.set(dirname(path), set)
  }
  for (const [dir, files] of names) {
    try {
      configWatchers.push(
        watch(dir, (_event, file) => {
          if (file && !files.has(file.toString())) return
          clearTimeout(configTimer)
          configTimer = setTimeout(() => emit('codycube:config-changed'), 300)
        })
      )
    } catch {
      // Carpeta no accesible: la lista se puede recargar a mano
    }
  }
}

/** Una app abierta desde Finder no hereda el PATH de la terminal, y sin él no aparecen gcloud, aws ni helm */
function inheritShellPath(): Promise<void> {
  if (process.platform === 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__CODYCUBE__%s__CODYCUBE__" "$PATH"'], { timeout: 4000 }, (_error, stdout) => {
      const match = /__CODYCUBE__(.*)__CODYCUBE__/.exec(stdout ?? '')
      if (match?.[1]) process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':'), ...match[1].split(':')])].filter(Boolean).join(':')
      resolve()
    })
  })
}

function isOwnFrame(sender: WebContents, url: string | undefined): boolean {
  if (sender !== mainWindow?.webContents || !url) return false
  const dev = process.env.ELECTRON_RENDERER_URL
  return url.startsWith('file://') || (!app.isPackaged && !!dev && url.startsWith(dev))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#14171c',
    title: 'Codycube',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const contents = mainWindow.webContents
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isOwnFrame(contents, url)) event.preventDefault()
  })
  // Al recargar, la interfaz pierde el rastro de sus flujos: se cierran para que no queden huérfanos
  contents.on('did-start-loading', stopAllSessions)
  mainWindow.on('closed', () => {
    stopAllSessions()
    mainWindow = null
  })
  if (process.env.ELECTRON_RENDERER_URL && !app.isPackaged) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  await inheritShellPath()
  store = new KubeconfigStore(app.getPath('userData'))
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ipcMain.handle('codycube:api', async (event, method: ApiMethod, args: unknown[]) => {
    if (!isOwnFrame(event.sender, event.senderFrame?.url)) throw new Error('Origen no autorizado')
    const handler = handlers[method] as ((...params: unknown[]) => unknown) | undefined
    if (!handler) return { ok: false, error: `Método desconocido: ${method}` }
    try {
      return { ok: true, value: await handler(...args) }
    } catch (error) {
      // Se envuelve porque Electron antepone su propio texto a las excepciones que cruzan el IPC
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  watchConfigFiles()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopAllSessions()
  forwards.stopAll()
})
