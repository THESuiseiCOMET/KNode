import { childIndex } from './forest'
import { ensure, type ProjectDocument } from './model'

export interface ProgressPreview {
  id: string
  value: number
}
export function pointerProgress(x: number, left: number, width: number): number {
  return Math.round(Math.max(0, Math.min(100, ((x - left) / Math.max(1, width)) * 100)))
}
export function keyboardProgress(value: number, key: string): number | null {
  if (key === 'Home') return 0
  if (key === 'End') return 100
  const delta = (
    {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 10,
      PageDown: -10,
    } as Record<string, number>
  )[key]
  return delta === undefined ? null : Math.max(0, Math.min(100, Math.round(value + delta)))
}
/** Preview only: update a manual node and its ancestor chain without mutating/saving the project. */
export function previewProgress(
  p: ProjectDocument,
  base: ReadonlyMap<string, number>,
  draft: ProgressPreview | null,
): Map<string, number> {
  const result = new Map(base)
  if (!draft) return result
  ensure(Number.isFinite(draft.value) && draft.value >= 0 && draft.value <= 100, '进度须在 0–100%')
  const index = new Map(p.nodes.map((n) => [n.id, n])),
    children = childIndex(p)
  const node = index.get(draft.id)
  ensure(
    node && !children.get(node.id)?.some((child) => child.weight > 0),
    '存在带权子节点时有效进度只读',
  )
  result.set(node.id, draft.value)
  let parent = node.parentId
  while (parent) {
    const list = children.get(parent) ?? [],
      max = Math.max(...list.map((n) => n.weight))
    let numerator = 0,
      denominator = 0
    if (max)
      for (const child of list) {
        const w = child.weight / max
        numerator += result.get(child.id)! * w
        denominator += w
      }
    result.set(
      parent,
      denominator
        ? Math.max(0, Math.min(100, numerator / denominator))
        : index.get(parent)!.progress,
    )
    parent = index.get(parent)!.parentId
  }
  return result
}
