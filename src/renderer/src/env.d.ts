/// <reference types="vite/client" />

import type { SessionScribeApi } from '@shared/ipc'

declare global {
  interface Window {
    sessionScribe: SessionScribeApi
  }
}

export {}
