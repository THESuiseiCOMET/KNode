import { getCurrentWindow } from '@tauri-apps/api/window'
export const desktopWindow = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  // close() requests the existing guarded path; destroy() is only used after flush.
  close: () => getCurrentWindow().close(),
  async watchMaximized(update: (value: boolean) => void): Promise<() => void> {
    const current = getCurrentWindow()
    let active = true
    const refresh = async () => {
      const value = await current.isMaximized()
      if (active) update(value)
    }
    const off = await current.onResized(() => void refresh().catch(() => {}))
    try {
      await refresh()
    } catch (error) {
      off()
      throw error
    }
    return () => {
      active = false
      off()
    }
  },
}
