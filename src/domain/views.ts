import {
  ensure,
  validateProject,
  type GraphEdge,
  type Point,
  type ProjectDocument,
  type ProjectViews,
  type ViewName,
  type Viewport,
} from './model'

/** Remove references only when a real node is deleted. Internal files are untouched. */
export function retainViewNodes(views: ProjectViews, ids: ReadonlySet<string>): ProjectViews {
  const positions = (items: Record<string, Point>) =>
    Object.fromEntries(Object.entries(items).filter(([id]) => ids.has(id)))
  return {
    tree: {
      ...views.tree,
      positions: positions(views.tree.positions),
      collapsedIds: views.tree.collapsedIds.filter((id) => ids.has(id)),
    },
    graph: {
      ...views.graph,
      positions: positions(views.graph.positions),
      edges: views.graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    },
  }
}
function commit(p: ProjectDocument, views: ProjectViews): ProjectDocument {
  const next = { ...p, views }
  validateProject(next)
  return next
}
export function moveViewNodes(
  p: ProjectDocument,
  mode: ViewName,
  positions: ReadonlyMap<string, Point>,
): ProjectDocument {
  for (const id of positions.keys())
    ensure(Object.hasOwn(p.views[mode].positions, id), '节点不属于当前视图')
  return commit(p, {
    ...p.views,
    [mode]: {
      ...p.views[mode],
      positions: {
        ...p.views[mode].positions,
        ...Object.fromEntries([...positions].map(([id, point]) => [id, { ...point }])),
      },
    },
  })
}
export function setViewViewport(
  p: ProjectDocument,
  mode: ViewName,
  viewport: Viewport,
): ProjectDocument {
  return commit(p, { ...p.views, [mode]: { ...p.views[mode], viewport: { ...viewport } } })
}
export function setCollapsed(
  p: ProjectDocument,
  ids: readonly string[],
  collapsed: boolean,
): ProjectDocument {
  const all = new Set(p.nodes.map((n) => n.id))
  const folded = new Set(p.views.tree.collapsedIds)
  for (const id of ids) {
    ensure(all.has(id), '节点不存在')
    if (collapsed) folded.add(id)
    else folded.delete(id)
  }
  return commit(p, { ...p.views, tree: { ...p.views.tree, collapsedIds: [...folded] } })
}
export function addToGraph(p: ProjectDocument, id: string, position: Point): ProjectDocument {
  ensure(
    p.nodes.some((n) => n.id === id),
    '节点不存在',
  )
  ensure(!Object.hasOwn(p.views.graph.positions, id), '节点已在图中')
  return commit(p, {
    ...p.views,
    graph: { ...p.views.graph, positions: { ...p.views.graph.positions, [id]: { ...position } } },
  })
}
/** IDs are supplied by the command caller (crypto.randomUUID in the desktop app). */
export function addGraphEdge(p: ProjectDocument, edge: GraphEdge): ProjectDocument {
  return commit(p, {
    ...p.views,
    graph: { ...p.views.graph, edges: [...p.views.graph.edges, { ...edge }] },
  })
}
export function updateGraphEdge(
  p: ProjectDocument,
  id: string,
  patch: Partial<Omit<GraphEdge, 'id'>>,
): ProjectDocument {
  ensure(
    p.views.graph.edges.some((e) => e.id === id),
    '图边不存在',
  )
  return commit(p, {
    ...p.views,
    graph: {
      ...p.views.graph,
      edges: p.views.graph.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    },
  })
}
export function removeGraphEdge(p: ProjectDocument, id: string): ProjectDocument {
  ensure(
    p.views.graph.edges.some((e) => e.id === id),
    '图边不存在',
  )
  return commit(p, {
    ...p.views,
    graph: { ...p.views.graph, edges: p.views.graph.edges.filter((e) => e.id !== id) },
  })
}
