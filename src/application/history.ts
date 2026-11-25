import {
  validateProject,
  type ForestNode,
  type GraphEdge,
  type Point,
  type ProjectDocument,
} from '../domain/model'
type Delta<T> = Map<string, { before: T | undefined; after: T | undefined }>
type Entry = {
  nodes: Delta<ForestNode>
  tree: Delta<Point>
  graph: Delta<Point>
  edges: Delta<GraphEdge>
  collapsed: Delta<boolean>
  beforeOrder: string[]
  afterOrder: string[]
  beforeEdgeOrder: string[]
  afterEdgeOrder: string[]
  beforeFoldOrder: string[]
  afterFoldOrder: string[]
}
function diff<T>(before: Map<string, T>, after: Map<string, T>): Delta<T> {
  const result: Delta<T> = new Map()
  for (const id of new Set([...before.keys(), ...after.keys()]))
    if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)))
      result.set(id, { before: before.get(id), after: after.get(id) })
  return result
}
function apply<T>(current: Map<string, T>, delta: Delta<T>, redo: boolean): Map<string, T> {
  for (const [id, change] of delta) {
    const value = redo ? change.after : change.before
    if (value === undefined) current.delete(id)
    else current.set(id, value)
  }
  return current
}
const indexed = <T extends { id: string }>(items: T[]) => new Map(items.map((n) => [n.id, n]))
/** Bounded entity deltas. Navigation in either view never rolls back with editing. */
export class CanvasHistory {
  private undoStack: Entry[] = []
  private redoStack: Entry[] = []
  constructor(readonly limit = 100) {}
  get canUndo() {
    return this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  record(before: ProjectDocument, after: ProjectDocument): void {
    const entry: Entry = {
      nodes: diff(indexed(before.nodes), indexed(after.nodes)),
      tree: diff(
        new Map(Object.entries(before.views.tree.positions)),
        new Map(Object.entries(after.views.tree.positions)),
      ),
      graph: diff(
        new Map(Object.entries(before.views.graph.positions)),
        new Map(Object.entries(after.views.graph.positions)),
      ),
      edges: diff(indexed(before.views.graph.edges), indexed(after.views.graph.edges)),
      collapsed: diff(
        new Map(before.views.tree.collapsedIds.map((id) => [id, true])),
        new Map(after.views.tree.collapsedIds.map((id) => [id, true])),
      ),
      beforeOrder: before.nodes.map((n) => n.id),
      afterOrder: after.nodes.map((n) => n.id),
      beforeEdgeOrder: before.views.graph.edges.map((e) => e.id),
      afterEdgeOrder: after.views.graph.edges.map((e) => e.id),
      beforeFoldOrder: [...before.views.tree.collapsedIds],
      afterFoldOrder: [...after.views.tree.collapsedIds],
    }
    if (
      ![entry.nodes, entry.tree, entry.graph, entry.edges, entry.collapsed].some((d) => d.size) &&
      JSON.stringify([entry.beforeOrder, entry.beforeEdgeOrder, entry.beforeFoldOrder]) ===
        JSON.stringify([entry.afterOrder, entry.afterEdgeOrder, entry.afterFoldOrder])
    )
      return
    this.undoStack.push(entry)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }
  private apply(p: ProjectDocument, entry: Entry, redo: boolean): ProjectDocument {
    const nodes = apply(indexed(p.nodes), entry.nodes, redo)
    const edges = apply(indexed(p.views.graph.edges), entry.edges, redo)
    const collapsed = apply(
      new Map(p.views.tree.collapsedIds.map((id) => [id, true])),
      entry.collapsed,
      redo,
    )
    const next: ProjectDocument = {
      ...p,
      nodes: (redo ? entry.afterOrder : entry.beforeOrder).map((id) => nodes.get(id)!),
      views: {
        tree: {
          ...p.views.tree,
          positions: Object.fromEntries(
            apply(new Map(Object.entries(p.views.tree.positions)), entry.tree, redo),
          ),
          collapsedIds: (redo ? entry.afterFoldOrder : entry.beforeFoldOrder).filter((id) =>
            collapsed.has(id),
          ),
        },
        graph: {
          ...p.views.graph,
          positions: Object.fromEntries(
            apply(new Map(Object.entries(p.views.graph.positions)), entry.graph, redo),
          ),
          edges: (redo ? entry.afterEdgeOrder : entry.beforeEdgeOrder).map((id) => edges.get(id)!),
        },
      },
    }
    validateProject(next)
    return next
  }
  preview(p: ProjectDocument, redo = false): ProjectDocument {
    const entry = (redo ? this.redoStack : this.undoStack).at(-1)
    return entry ? this.apply(p, entry, redo) : p
  }
  undo(p: ProjectDocument): ProjectDocument {
    const next = this.preview(p)
    const entry = this.undoStack.pop()
    if (entry) this.redoStack.push(entry)
    return next
  }
  redo(p: ProjectDocument): ProjectDocument {
    const next = this.preview(p, true)
    const entry = this.redoStack.pop()
    if (entry) this.undoStack.push(entry)
    return next
  }
}
