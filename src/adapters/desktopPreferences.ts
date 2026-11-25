import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Language } from '../application/i18n'

export interface StartupStatus {
  enabled: boolean
  supported: boolean
}
export const desktopPreferences = {
  startup: (): Promise<StartupStatus> =>
    isTauri() ? invoke('get_startup') : Promise.resolve({ enabled: false, supported: false }),
  setStartup: (enabled: boolean): Promise<StartupStatus> => invoke('set_startup', { enabled }),
  trayLanguage: (language: Language): Promise<void> =>
    isTauri() ? invoke('set_tray_language', { language }) : Promise.resolve(),
}
