import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Bridge } from '../shared/types'

function listen<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: Bridge = {
  invoke: async (method, ...args) => {
    const result = await ipcRenderer.invoke('codycube:api', method, args)
    if (!result.ok) throw new Error(result.error)
    return result.value
  },
  onWatch: (callback) => listen('codycube:watch', callback),
  onLogs: (callback) => listen('codycube:logs', callback),
  onTerminal: (callback) => listen('codycube:terminal', callback),
  onForwards: (callback) => listen('codycube:forwards', callback),
  onTraffic: (callback) => listen('codycube:traffic', callback),
  onConfigChanged: (callback) => listen('codycube:config-changed', callback),
  pathForFile: (file) => webUtils.getPathForFile(file),
  platform: process.platform
}

contextBridge.exposeInMainWorld('codycube', bridge)
