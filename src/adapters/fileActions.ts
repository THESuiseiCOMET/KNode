import { invoke } from '@tauri-apps/api/core'
export type FileTarget =
  | { source: 'internal'; relative: string }
  | { source: 'external'; linked: string; relative: string }
export type FileAction = 'path' | 'open' | 'reveal'
export const fileActions = {
  doubleClickMs: () => invoke<number>('file_double_click_ms'),
  run: (token: string, nodeId: string, target: FileTarget, action: FileAction) =>
    invoke<string>('file_action', { token, nodeId, target, action }),
}
