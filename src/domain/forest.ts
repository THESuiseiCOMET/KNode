import { retainViewNodes, moveViewNodes, setViewViewport, addToGraph } from './views'
import { CARD_WIDTH, CARD_HEIGHT, CARD_GAP } from './geometry'
import { DEFAULT_NODE_COLOR } from './color'
import {
  ensure,
  MAX_COORDINATE,
  validateProject,
  type ForestNode,
  type Point,
  type ProjectDocument,
  type ViewName,
  type Viewport,
} from './model'

function getNode(p: ProjectDocument, id: string): ForestNode {
  const node = p.nodes.find((n) => n.id === id)
  ensure(node, '节点不存在')
  return node
}
function commit(p: ProjectDocument, nodes: ForestNode[]): ProjectDocument {
  const ids = new Set(nodes.map((n) => n.id))
  const views = p.nodes.some((n) => !ids.has(n.id)) ? retainViewNodes(p.views, ids) : p.views
  const next = { ...p, nodes, views }
  validateProject(next)
  return next
}
function update(p: ProjectDocument, id: string, patch: Partial<ForestNode>): ProjectDocument {
  getNode(p, id)
  return commit(
    p,
    p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  )
}
export function createRoot(
  p: ProjectDocument,
  id: string,
  title: string,
  position: Point,
  weight = 1,
): ProjectDocument {
  return commit(
    {
      ...p,
      views: {
        ...p.views,
        tree: { ...p.views.tree, positions: { ...p.views.tree.positions, [id]: { ...position } } },
      },
    },
    [
      ...p.nodes,
      {
        id,
        title: title.trim(),
        parentId: null,
        progress: 0,
        weight,
        color: DEFAULT_NODE_COLOR,
      },
    ],
  )
}
export function createChild(
  p: ProjectDocument,
  parentId: string,
  id: string,
  title: string,
  position: Point,
  weight = 1,
): ProjectDocument {
  getNode(p, parentId)
  const next = createRoot(p, id, title, position, weight)
  return reparent(next, id, parentId)
}
export function reparent(p: ProjectDocument, id: string, parentId: string | null): ProjectDocument {
  return update(p, id, { parentId })
}
export function renameNode(p: ProjectDocument, id: string, title: string): ProjectDocument {
  return update(p, id, { title: title.trim() })
}
export function setWeight(p: ProjectDocument, id: string, weight: number): ProjectDocument {
  return update(p, id, { weight })
}
export function setManualProgress(
  p: ProjectDocument,
  id: string,
  progress: number,
): ProjectDocument {
  return update(p, id, { progress })
}
export function moveNodes(
  p: ProjectDocument,
  positions: ReadonlyMap<string, Point>,
): ProjectDocument {
  return moveViewNodes(p, 'tree', positions)
}
export function setViewport(p: ProjectDocument, viewport: Viewport): ProjectDocument {
  return setViewViewport(p, 'tree', viewport)
}
/** New graph nodes are real tree roots, with independently owned coordinates. */
export function createGraphNode(
  p: ProjectDocument,
  id: string,
  title: string,
  position: Point,
  weight = 1,
): ProjectDocument {
  return addToGraph(createRoot(p, id, title, freePosition(p, position), weight), id, position)
}
export function removeNodeOnly(p: ProjectDocument, id: string): ProjectDocument {
  getNode(p, id)
  return commit(
    p,
    p.nodes
      .filter((n) => n.id !== id)
      .map((n) => (n.parentId === id ? { ...n, parentId: null } : n)),
  )
}
export function removeSubtree(p: ProjectDocument, id: string): ProjectDocument {
  getNode(p, id)
  const removed = new Set([id])
  const children = childIndex(p)
  const queue = [id]
  while (queue.length)
    for (const child of children.get(queue.pop()!) ?? []) {
      removed.add(child.id)
      queue.push(child.id)
    }
  return commit(
    p,
    p.nodes.filter((n) => !removed.has(n.id)),
  )
}
export function childIndex(p: ProjectDocument): Map<string, ForestNode[]> {
  const result = new Map<string, ForestNode[]>()
  for (const n of p.nodes)
    if (n.parentId !== null) {
      const list = result.get(n.parentId) ?? []
      list.push(n)
      result.set(n.parentId, list)
    }
  return result
}
/** Iterative postorder avoids stack overflow on deeply nested valid forests. */
export function computeProgress(p: ProjectDocument): Map<string, number> {
  validateProject(p)
  const children = childIndex(p),
    result = new Map<string, number>()
  const stack: [ForestNode, boolean][] = p.nodes
    .filter((n) => n.parentId === null)
    .map((n) => [n, false])
  while (stack.length) {
    const [node, visited] = stack.pop()!
    const list = children.get(node.id) ?? []
    if (!visited && list.length) {
      stack.push([node, true])
      for (const c of list) stack.push([c, false])
      continue
    }
    if (!list.length) {
      result.set(node.id, node.progress)
      continue
    }
    let max = 0
    for (const c of list) max = Math.max(max, c.weight)
    let numerator = 0,
      denominator = 0
    if (max > 0)
      for (const c of list) {
        const normalized = c.weight / max
        numerator += result.get(c.id)! * normalized
        denominator += normalized
      }
    result.set(
      node.id,
      denominator ? Math.min(100, Math.max(0, numerator / denominator)) : node.progress,
    )
  }
  return result
}
/** Find a free position without moving any existing node. */
export function freePosition(p: ProjectDocument, preferred: Point, view: ViewName = 'tree'): Point {
  const positions = Object.values(p.views[view].positions)
  const step = CARD_HEIGHT + CARD_GAP
  if (view === 'graph') {
    const clamp = (value: number) => Math.max(-MAX_COORDINATE, Math.min(MAX_COORDINATE, value))
    const x = clamp(preferred.x),
      y = clamp(preferred.y)
    // One card can block two slots when it is between grid positions.
    const direction = y > MAX_COORDINATE - positions.length * 2 * step ? -1 : 1
    const blockers = positions
      .filter((point) => Math.abs(point.x - x) < CARD_WIDTH + CARD_GAP)
      .map((point) => (point.y - y) * direction)
      .sort((a, b) => a - b)
    let offset = 0
    for (const blocker of blockers) {
      if (blocker - offset >= step) break
      if (offset - blocker < step) offset = Math.ceil((blocker + step) / step) * step
    }
    return { x, y: y + offset * direction }
  }
  let candidate = { ...preferred }
  for (let i = 0; i <= positions.length; i++) {
    if (
      !positions.some(
        (point) =>
          Math.abs(point.x - candidate.x) < CARD_WIDTH + CARD_GAP &&
          Math.abs(point.y - candidate.y) < step,
      )
    )
      return candidate
    candidate = { x: preferred.x, y: candidate.y + step }
  }
  return candidate
}

/** Fill missing Graph coordinates on open and when a Tree command introduces a node. */
export function withAllGraphNodes(p: ProjectDocument): ProjectDocument {
  const missing = p.nodes.filter((node) => !Object.hasOwn(p.views.graph.positions, node.id))
  if (!missing.length) return p
  const positions = { ...p.views.graph.positions }
  const next = { ...p, views: { ...p.views, graph: { ...p.views.graph, positions } } }
  for (const { id } of missing) {
    Object.defineProperty(positions, id, {
      value: freePosition(next, p.views.tree.positions[id], 'graph'),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return next
}
