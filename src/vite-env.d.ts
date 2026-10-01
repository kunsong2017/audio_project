/// <reference types="vite/client" />

declare module 'virtual:pwa-register/react' {
  import type { Dispatch, SetStateAction } from 'react'

  export function useRegisterSW(options?: {
    immediate?: boolean
    onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
    onOfflineReady?: () => void
  }): {
    needRefresh: [boolean, Dispatch<SetStateAction<boolean>>]
    offlineReady: [boolean, Dispatch<SetStateAction<boolean>>]
    updateServiceWorker: (reloadPage?: boolean) => Promise<void>
  }
}
