import { language } from '../application/i18n'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

export interface OpenedProject {
  token: string
  path: string
  directory: string
  json: string
}
export const desktopAvailable = isTauri()
export const projectIO = {
  rename: (token: string, name: string) => invoke<OpenedProject>('rename_project', { token, name }),
  create: (json: string) =>
    invoke<OpenedProject | null>('create_project', { json, language: language.value }),
  open: (path?: string) =>
    invoke<OpenedProject | null>('open_project', {
      language: language.value,
      ...(path ? { path } : {}),
    }),
  save: (token: string, json: string) => invoke<void>('save_project', { token, json }),
  openFolder: (token: string) => invoke<void>('open_project_folder', { token }),
  release: (token: string) => invoke<void>('release_project', { token }),
}
export async function installCloseGuard(
  flush: () => Promise<void>,
  setClosing: (closing: boolean) => void,
  report: (message: string) => void,
): Promise<() => void> {
  if (!desktopAvailable) return () => {}
  let closing = false
  const window = getCurrentWindow()
  return window.onCloseRequested(async (event) => {
    event.preventDefault()
    if (closing) return
    closing = true
    try {
      const pending = flush()
      setClosing(true)
      await pending
      await invoke('save_window_state')
      await window.destroy()
    } catch (e) {
      closing = false
      setClosing(false)
      report(`关闭已取消，内存草稿仍在。保存失败：${String(e)}`)
    }
  })
}
