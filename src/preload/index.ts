import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PreloadBridge, SendChannels } from '@shared/ipc'

const SEND_CHANNELS = new Set<keyof SendChannels>(['session.write', 'session.resize', 'session.ack'])
const listeners = new Map<string, Set<(payload: unknown) => void>>()
const dataListeners = new Set<(id: string, data: string) => void>()

ipcRenderer.on('evt', (_e, name: string, payload: unknown) => {
  const set = listeners.get(name)
  if (set) for (const l of set) l(payload)
})

ipcRenderer.on('session.data', (_e, id: string, data: string) => {
  for (const l of dataListeners) l(id, data)
})

const bridge: PreloadBridge = {
  platform: process.platform,
  invoke: (method, ...args) => ipcRenderer.invoke('rpc', method, ...args),
  send: (channel, ...args) => {
    if (SEND_CHANNELS.has(channel)) ipcRenderer.send(channel, ...args)
  },
  on: (event, listener) => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(listener)
    return () => set!.delete(listener)
  },
  onSessionData: (listener) => {
    dataListeners.add(listener)
    return () => dataListeners.delete(listener)
  },
  getPathForFile: (file) => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('sshtool', bridge)
