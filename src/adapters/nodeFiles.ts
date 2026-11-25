import { invoke } from '@tauri-apps/api/core'
export interface InternalEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
}
export const nodeFiles = {
  copy: (token: string, pairs: [string, string][]) =>
    invoke<void>('copy_node_files', { token, pairs }),
  importFolder: (token: string, nodeId: string, relative = '') =>
    invoke<boolean>('import_node_folder', { token, nodeId, relative }),
  rename: (token: string, nodeId: string, relative: string, name: string) =>
    invoke<void>('rename_node_file', { token, nodeId, relative, name }),
  delete: (token: string, nodeId: string, relative: string) =>
    invoke<void>('delete_node_file', { token, nodeId, relative }),
  list: (token: string, nodeId: string, relative = '') =>
    invoke<InternalEntry[]>('list_node_files', { token, nodeId, relative }),
  create: (token: string, nodeId: string, relative: string, name: string) =>
    invoke<void>('create_node_file', { token, nodeId, relative, name }),
  import: (token: string, nodeId: string, relative: string) =>
    invoke<boolean>('import_node_file', { token, nodeId, relative }),
  read: (token: string, nodeId: string, relative: string) =>
    invoke<string>('read_node_file', { token, nodeId, relative }),
  check: (token: string, ids: string[], descendants: boolean) =>
    invoke<void>('check_node_files', { token, ids, descendants }),
}
