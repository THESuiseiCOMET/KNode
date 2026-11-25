import type { InternalEntry } from '../adapters/nodeFiles'

export interface FileTreeRow {
  entry: InternalEntry
  depth: number
  empty: boolean
}
/** Projection of directories explicitly requested by the user; never performs I/O. */
export function fileTreeRows(
  directories: Readonly<Record<string, readonly InternalEntry[]>>,
  expanded: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = []
  const children = (path: string) => (Object.hasOwn(directories, path) ? directories[path]! : [])
  const stack = [...children('')].reverse().map((entry) => ({ entry, depth: 0 }))
  while (stack.length) {
    const row = stack.pop()!
    rows.push({
      ...row,
      empty:
        row.entry.isDirectory &&
        Object.hasOwn(directories, row.entry.path) &&
        children(row.entry.path).length === 0,
    })
    if (row.entry.isDirectory && expanded.has(row.entry.path)) {
      for (const entry of [...children(row.entry.path)].reverse())
        stack.push({ entry, depth: row.depth + 1 })
    }
  }
  return rows
}
