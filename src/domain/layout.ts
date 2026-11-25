import { CARD_WIDTH, cardHeight } from './geometry'
import { hiddenIds } from './canvas'
import type { GraphEdge, Point, ProjectDocument, ViewName } from './model'

export const LAYOUT_DIRECTIONS = ['TB', 'BT', 'LR', 'RL'] as const
export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number]
export interface LayoutNode {
  id: string
  parentId: string | null
  width: number
  height: number
}
export interface LayoutInput {
  view: ViewName
  direction: LayoutDirection
  nodes: LayoutNode[]
  edges: GraphEdge[]
}
interface Box {
  positions: Record<string, Point>
  width: number
  height: number
}
const TREE_GAP = 48,
  TREE_LAYER_GAP = 96,
  COMPONENT_GAP = 100,
  MARGIN = 40
export function isLayoutDirection(value: unknown): value is LayoutDirection {
  return LAYOUT_DIRECTIONS.includes(value as LayoutDirection)
}
/** Send geometry/relations only; files and node business data never enter the worker. */
export function makeLayoutInput(
  project: ProjectDocument,
  view: ViewName,
  direction: LayoutDirection,
  expanded: ReadonlySet<string>,
): LayoutInput {
  const hidden = view === 'tree' ? hiddenIds(project) : new Set<string>()
  return {
    view,
    direction,
    nodes: project.nodes
      .filter((n) => Object.hasOwn(project.views[view].positions, n.id) && !hidden.has(n.id))
      .map((n) => ({
        id: n.id,
        parentId: view === 'tree' ? n.parentId : null,
        width: CARD_WIDTH,
        height: cardHeight(n.weight, expanded.has(n.id)),
      })),
    edges: view === 'graph' ? project.views.graph.edges.map((e) => ({ ...e })) : [],
  }
}
const vertical = (d: LayoutDirection) => d === 'TB' || d === 'BT'
function size(n: LayoutNode, d: LayoutDirection) {
  return { cross: vertical(d) ? n.width : n.height, main: vertical(d) ? n.height : n.width }
}
function orient(
  logical: Map<string, { cross: number; main: number }>,
  nodes: Map<string, LayoutNode>,
  d: LayoutDirection,
  total: number,
): Box {
  const positions: Record<string, Point> = {}
  let width = 0,
    height = 0
  for (const [id, at] of logical) {
    const n = nodes.get(id)!
    const main = d === 'BT' || d === 'RL' ? total - at.main - size(n, d).main : at.main
    const point = vertical(d) ? { x: at.cross, y: main } : { x: main, y: at.cross }
    Object.defineProperty(positions, id, {
      value: point,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    width = Math.max(width, point.x + n.width)
    height = Math.max(height, point.y + n.height)
  }
  return { positions, width, height }
}
/** Deterministic shelf packing keeps isolated nodes/components from forming a huge strip. */
function pack(boxes: Box[]): Record<string, Point> {
  const target = Math.max(
    1,
    Math.sqrt(
      boxes.reduce((a, b) => a + (b.width + COMPONENT_GAP) * (b.height + COMPONENT_GAP), 0) * 1.6,
    ),
  )
  const entries: [string, Point][] = []
  let x = 0,
    y = 0,
    rowHeight = 0
  for (const box of boxes) {
    if (x && x + box.width > target) {
      x = 0
      y += rowHeight + COMPONENT_GAP
      rowHeight = 0
    }
    for (const [id, p] of Object.entries(box.positions))
      entries.push([id, { x: p.x + x + MARGIN, y: p.y + y + MARGIN }])
    x += box.width + COMPONENT_GAP
    rowHeight = Math.max(rowHeight, box.height)
  }
  return Object.fromEntries(entries)
}
/** Iterative subtree-span layout. Collapsed descendants are omitted by makeLayoutInput. */
function treeLayout(input: LayoutInput, nodes: Map<string, LayoutNode>): Record<string, Point> {
  const children = new Map<string, string[]>(),
    roots: string[] = []
  for (const n of nodes.values()) {
    if (n.parentId === null) roots.push(n.id)
    else {
      if (!nodes.has(n.parentId)) throw new Error('树布局的父节点缺失')
      const list = children.get(n.parentId) ?? []
      list.push(n.id)
      children.set(n.parentId, list)
    }
  }
  const boxes: Box[] = [],
    visited = new Set<string>()
  for (const root of roots) {
    const order: string[] = [],
      depths = new Map<string, number>(),
      layerSizes: number[] = [],
      stack: [string, number][] = [[root, 0]]
    while (stack.length) {
      const [id, depth] = stack.pop()!
      if (visited.has(id)) throw new Error('树布局不允许循环')
      visited.add(id)
      order.push(id)
      depths.set(id, depth)
      layerSizes[depth] = Math.max(
        layerSizes[depth] ?? 0,
        size(nodes.get(id)!, input.direction).main,
      )
      const list = children.get(id) ?? []
      for (let i = list.length - 1; i >= 0; i--) stack.push([list[i], depth + 1])
    }
    const spans = new Map<string, number>(),
      centers = new Map<string, number>()
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i],
        list = children.get(id) ?? []
      const childSpan =
        list.reduce((sum, child) => sum + spans.get(child)!, 0) +
        Math.max(0, list.length - 1) * TREE_GAP
      const half = size(nodes.get(id)!, input.direction).cross / 2
      const extent = Math.max(half * 2, childSpan)
      spans.set(id, extent)
      const first = list[0],
        last = list.at(-1)
      const center =
        first && last
          ? (extent - spans.get(last)! + centers.get(first)! + centers.get(last)!) / 2
          : extent / 2
      centers.set(id, Math.max(half, Math.min(extent - half, center)))
    }
    const layerStarts: number[] = []
    let total = 0
    for (const extent of layerSizes) {
      layerStarts.push(total)
      total += extent + TREE_LAYER_GAP
    }
    total -= TREE_LAYER_GAP
    const starts = new Map([[root, 0]]),
      logical = new Map<string, { cross: number; main: number }>()
    for (const id of order) {
      const n = nodes.get(id)!,
        extent = spans.get(id)!,
        left = starts.get(id)!,
        list = children.get(id) ?? []
      logical.set(id, {
        cross: left + centers.get(id)! - size(n, input.direction).cross / 2,
        main: layerStarts[depths.get(id)!],
      })
      const childSpan =
        list.reduce((sum, child) => sum + spans.get(child)!, 0) +
        Math.max(0, list.length - 1) * TREE_GAP
      let cursor = left + (extent - childSpan) / 2
      for (const child of list) {
        starts.set(child, cursor)
        cursor += spans.get(child)! + TREE_GAP
      }
    }
    boxes.push(orient(logical, nodes, input.direction, total))
  }
  if (visited.size !== nodes.size) throw new Error('树布局不允许循环')
  return pack(boxes)
}
/** Pure deterministic layout: no persistence, mutation, renderer or DOM access. */
export function sortedLayoutNodes(input: LayoutInput): LayoutNode[] {
  if (!isLayoutDirection(input.direction)) throw new Error('不支持的整理方向')
  const sorted = [...input.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const ids = new Set(sorted.map((n) => n.id))
  if (ids.size !== input.nodes.length) throw new Error('布局节点 ID 重复')
  for (const n of sorted)
    if (!Number.isFinite(n.width) || !Number.isFinite(n.height) || n.width <= 0 || n.height <= 0)
      throw new Error('节点尺寸无效')
  return sorted
}

export function calculateLayout(input: LayoutInput): Record<string, Point> {
  if (input.view !== 'tree') throw new Error('树布局不支持图视图')
  const nodes = sortedLayoutNodes(input)
  return nodes.length ? treeLayout(input, new Map(nodes.map((node) => [node.id, node]))) : {}
}
