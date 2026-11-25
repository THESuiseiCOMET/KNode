import { invoke } from '@tauri-apps/api/core'
import type { InternalEntry } from './nodeFiles'
export interface ExternalEntry extends InternalEntry {
  status: 'ok' | 'missing' | 'unavailable' | 'blocked' | 'loading'
  message: string
}
export const externalFiles = {
  create: (token: string, nodeId: string, extension: 'txt' | 'md') =>
    invoke<string[] | null>('create_linked_file', { token, nodeId, extension }),
  pick: (token: string, nodeId: string, directory: boolean, replace?: string) =>
    invoke<string[] | null>('pick_linked_paths', {
      token,
      nodeId,
      directory,
      replace: replace ?? null,
    }),
  statuses: (token: string, nodeId: string) =>
    invoke<ExternalEntry[]>('linked_path_statuses', { token, nodeId }),
  list: (token: string, nodeId: string, linked: string, relative = '') =>
    invoke<ExternalEntry[]>('list_linked_directory', { token, nodeId, linked, relative }),
}
