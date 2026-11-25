import { retainViewNodes, setCollapsed } from './views'
import { CARD_WIDTH, CARD_HEIGHT, CARD_GAP } from './geometry'
import { childIndex } from './forest'
import { DEFAULT_NODE_COLOR } from './color'
import {
  validateProject,
  type ForestNode,
  type GraphEdge,
  type Point,
  type ProjectDocument,
  type ViewName,
} from './model'

export function descendants(p: ProjectDocument, ids: readonly string[]): Set<string> {
  const children = childIndex(p),
    result = new Set(ids),
    queue = [...ids]
  while (queue.length)
    for (const n of children.get(queue.pop()!) ?? [])
      if (!result.has(n.id)) {
        result.add(n.id)
        queue.push(n.id)
      }
  return result
}
export function hiddenIds(p: ProjectDocument): Set<string> {
  const folded = p.views.tree.collapsedIds
  // A collapsed node can itself have a collapsed ancestor.
  const children = childIndex(p),
    hidden = new Set<string>(),
    queue = [...folded]
  while (queue.length)
    for (const n of children.get(queue.pop()!) ?? [])
      if (!hidden.has(n.id)) {
        hidden.add(n.id)
        queue.push(n.id)
      }
  return hidden
}
export function patchNodes(
  p: ProjectDocument,
  ids: readonly string[],
  patch: { color: string },
): ProjectDocument {
  const chosen = new Set(ids)
  const next = { ...p, nodes: p.nodes.map((n) => (chosen.has(n.id) ? { ...n, ...patch } : n)) }
  validateProject(next)
  return next
}
export function reveal(p: ProjectDocument, target: string | readonly string[]): ProjectDocument {
  if (!p.views.tree.collapsedIds.length) return p
  const parents = new Map(p.nodes.map((n) => [n.id, n.parentId])),
    ancestors = new Set<string>()
  for (const id of typeof target === 'string' ? [target] : target) {
    let parent = parents.get(id)
    while (parent && !ancestors.has(parent)) {
      ancestors.add(parent)
      parent = parents.get(parent)
    }
  }
  if (!p.views.tree.collapsedIds.some((id) => ancestors.has(id))) return p
  return setCollapsed(p, [...ancestors], false)
}
/** Clipboard layout is separate from the canonical node business record. */
export interface CopiedNode {
  node: ForestNode
  position: Point
  collapsed: boolean
  edges?: GraphEdge[]
}
export function copyNodes(
  p: ProjectDocument,
  ids: readonly string[],
  subtree = false,
  view: ViewName = 'tree',
): CopiedNode[] {
  const chosen = subtree && view === 'tree' ? descendants(p, ids) : new Set(ids)
  const members = p.views[view].positions
  return p.nodes
    .filter((n) => chosen.has(n.id) && Object.hasOwn(members, n.id))
    .map((n) => ({
      node: {
        ...n,
        ...(n.linkedPaths ? { linkedPaths: [...n.linkedPaths] } : {}),
        parentId: view === 'tree' && n.parentId && chosen.has(n.parentId) ? n.parentId : null,
      },
      position: { ...members[n.id] },
      collapsed: view === 'tree' && p.views.tree.collapsedIds.includes(n.id),
      ...(view === 'graph'
        ? {
            edges: p.views.graph.edges
              .filter((e) => e.source === n.id && chosen.has(e.target))
              .map((e) => ({ ...e })),
          }
        : {}),
    }))
}
export function pasteNodes(
  p: ProjectDocument,
  copied: readonly CopiedNode[],
  point: Point,
  newId: () => string,
  view: ViewName = 'tree',
  newEdgeId: () => string = () => crypto.randomUUID(),
): ProjectDocument {
  if (!copied.length) return p
  const ids = new Map(copied.map((n) => [n.node.id, newId()]))
  const minX = Math.min(...copied.map((n) => n.position.x)),
    minY = Math.min(...copied.map((n) => n.position.y))
  const dx = point.x - minX
  let dy = point.y - minY
  while (
    copied.some((n) =>
      Object.values(p.views[view].positions).some(
        (old) =>
          Math.abs(old.x - n.position.x - dx) < CARD_WIDTH + CARD_GAP &&
          Math.abs(old.y - n.position.y - dy) < CARD_HEIGHT + CARD_GAP,
      ),
    )
  )
    dy += CARD_HEIGHT + CARD_GAP
  const next: ProjectDocument = {
    ...p,
    nodes: [
      ...p.nodes,
      ...copied.map(({ node }) => ({
        ...node,
        ...(node.linkedPaths ? { linkedPaths: [...node.linkedPaths] } : {}),
        id: ids.get(node.id)!,
        parentId: node.parentId ? (ids.get(node.parentId) ?? null) : null,
      })),
    ],
    views: {
      ...p.views,
      tree: {
        ...p.views.tree,
        positions: {
          ...p.views.tree.positions,
          ...Object.fromEntries(
            copied.map((n) => [
              ids.get(n.node.id)!,
              { x: n.position.x + dx, y: n.position.y + dy },
            ]),
          ),
        },
        collapsedIds: [
          ...p.views.tree.collapsedIds,
          ...copied.filter((n) => n.collapsed).map((n) => ids.get(n.node.id)!),
        ],
      },
    },
  }
  if (view === 'graph') {
    next.views = {
      ...next.views,
      graph: {
        ...p.views.graph,
        positions: {
          ...p.views.graph.positions,
          ...Object.fromEntries(
            copied.map((n) => [
              ids.get(n.node.id)!,
              { x: n.position.x + dx, y: n.position.y + dy },
            ]),
          ),
        },
        edges: [
          ...p.views.graph.edges,
          ...copied.flatMap((n) =>
            (n.edges ?? []).map((e) => ({
              ...e,
              id: newEdgeId(),
              source: ids.get(e.source)!,
              target: ids.get(e.target)!,
            })),
          ),
        ],
      },
    }
  }
  validateProject(next)
  return next
}
export function deleteNodes(
  p: ProjectDocument,
  ids: readonly string[],
  subtree: boolean,
): ProjectDocument {
  const removed = subtree ? descendants(p, ids) : new Set(ids)
  const nodes = p.nodes
    .filter((n) => !removed.has(n.id))
    .map((n) => (n.parentId && removed.has(n.parentId) ? { ...n, parentId: null } : n))
  const next = { ...p, nodes, views: retainViewNodes(p.views, new Set(nodes.map((n) => n.id))) }
  validateProject(next)
  return next
}
export function fuzzyMatch(title: string, query: string): boolean {
  const text = title.normalize('NFKC').toLocaleLowerCase(),
    chars = [...query.normalize('NFKC').trim().toLocaleLowerCase()]
  if (!chars.length) return false
  let start = 0
  return chars.every((c) => {
    const at = text.indexOf(c, start)
    start = at + 1
    return at >= 0
  })
}
export type Side = 'left' | 'right' | 'top' | 'bottom'
export function connectorSides(
  from: Point,
  to: Point,
  previous?: [Side, Side],
  fromHeight = CARD_HEIGHT,
  toHeight = CARD_HEIGHT,
): [Side, Side] {
  const dx = to.x - from.x,
    dy = to.y + toHeight / 2 - from.y - fromHeight / 2
  const horizontal = Math.abs(dx) / CARD_WIDTH,
    vertical = Math.abs(dy) / ((fromHeight + toHeight) / 2)
  let axis = horizontal >= vertical ? 'x' : 'y'
  if (previous && Math.abs(horizontal - vertical) < 0.18)
    axis = previous[0] === 'left' || previous[0] === 'right' ? 'x' : 'y'
  return axis === 'x'
    ? dx >= 0
      ? ['right', 'left']
      : ['left', 'right']
    : dy >= 0
      ? ['bottom', 'top']
      : ['top', 'bottom']
}
export interface ColorPreview {
  ids: readonly string[]
  color: string
}
export function nodeColors(p: ProjectDocument, preview?: ColorPreview | null): Map<string, string> {
  const previewIds = new Set(preview?.ids)
  return new Map(
    p.nodes.map((n) => [
      n.id,
      preview && previewIds.has(n.id) ? preview.color : (n.color ?? DEFAULT_NODE_COLOR),
    ]),
  )
}

/** Capture what older V3 projects showed before edits can change any parent colors. */
export function materializeLegacyColors(p: ProjectDocument): ProjectDocument {
  if (p.nodes.every((n) => n.color !== null)) return p
  const children = childIndex(p),
    colors = new Map<string, string>(),
    queue = p.nodes.filter((n) => !n.parentId)
  while (queue.length) {
    const n = queue.pop()!
    colors.set(n.id, n.color ?? colors.get(n.parentId ?? '') ?? DEFAULT_NODE_COLOR)
    for (const child of children.get(n.id) ?? []) queue.push(child)
  }
  return {
    ...p,
    nodes: p.nodes.map((n) => (n.color === null ? { ...n, color: colors.get(n.id)! } : n)),
  }
}
