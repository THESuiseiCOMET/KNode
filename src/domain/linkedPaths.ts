import {
  ensure,
  validateProject,
  validLinkedPath,
  linkedPathKey,
  type ProjectDocument,
} from './model'
export { validLinkedPath, linkedPathKey } from './model'

export function setLinkedPaths(
  p: ProjectDocument,
  id: string,
  paths: readonly string[],
): ProjectDocument {
  ensure(
    p.nodes.some((n) => n.id === id),
    '节点不存在',
  )
  ensure(paths.every(validLinkedPath), '外部关联路径格式无效')
  const seen = new Set<string>()
  const unique = paths.filter((path) => {
    const key = linkedPathKey(path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const next = {
    ...p,
    nodes: p.nodes.map((n) => {
      if (n.id !== id) return n
      const { linkedPaths: _old, ...node } = n
      return unique.length ? { ...node, linkedPaths: [...unique] } : node
    }),
  }
  validateProject(next)
  return next
}
