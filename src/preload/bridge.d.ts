import type { PreloadBridge } from '@shared/ipc'

declare global {
  interface Window {
    sshtool: PreloadBridge
  }
}

export {}
