import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createProject,
  parseProject,
  serializeProject,
  validateProject,
  type ProjectDocument,
} from '../src/domain/model'
import {
  createChild,
  createGraphNode,
  createRoot,
  moveNodes,
  reparent,
  setManualProgress,
  computeProgress,
  removeSubtree,
  withAllGraphNodes,
} from '../src/domain/forest'
import {
  addToGraph,
  addGraphEdge,
  updateGraphEdge,
  removeGraphEdge,
  moveViewNodes,
  setCollapsed,
  setViewViewport,
} from '../src/domain/views'
import { copyNodes, pasteNodes, deleteNodes, hiddenIds, reveal } from '../src/domain/canvas'
import { CanvasHistory } from '../src/application/history'

const initial = () => createProject('V3 森林', 'c0e631c4-9154-4478-b7af-a2d166e62a36')
function sample(): ProjectDocument {
  let p = createRoot(initial(), 'a', '父', { x: 10, y: 20 })
  p = createChild(p, 'a', 'b', '子', { x: 400, y: 30 })
  p = setManualProgress(p, 'b', 42)
  p = addToGraph(p, 'a', { x: -100, y: -200 })
  p = addToGraph(p, 'b', { x: 900, y: 1000 })
  p = addGraphEdge(p, { id: 'loop', source: 'a', target: 'a', direction: 'forward', label: '重试' })
  p = addGraphEdge(p, { id: 'ab', source: 'a', target: 'b', direction: 'both' })
  return addGraphEdge(p, { id: 'ba', source: 'b', target: 'a', direction: 'undirected' })
}
describe('V3 唯一持久化结构', () => {
  it('新建空项目生成两个独立视图，所有 JSON 往返无损，无旧字段', () => {
    const empty = initial()
    expect(empty.version).toBe(3)
    expect(empty.views.tree.positions).not.toBe(empty.views.graph.positions)
    expect(empty.views.tree.viewport).not.toBe(empty.views.graph.viewport)
    expect(parseProject(serializeProject(empty))).toEqual(empty)
    const p = sample()
    p.nodes[0].linkedPaths = ['../外部 文件/note.txt', 'C:/中文 空格/folder']
    expect(parseProject(serializeProject(p))).toEqual(p)
    const raw = JSON.parse(serializeProject(p))
    expect(Object.keys(raw).sort()).toEqual(
      ['format', 'version', 'projectId', 'name', 'nodes', 'views'].sort(),
    )
    for (const node of raw.nodes) {
      expect(node).not.toHaveProperty('position')
      expect(node).not.toHaveProperty('collapsed')
      expect(node).not.toHaveProperty('documents')
    }
  })
  it('与 Rust 共用的完整 V3 样例可无损加载及导出', () => {
    const json = readFileSync('tests/fixtures/project-v3.json', 'utf8')
    const p = parseProject(json)
    expect(parseProject(serializeProject(p))).toEqual(JSON.parse(json))
    expect(computeProgress(p).get('a')).toBe(42)
  })
  it.each([
    { format: 'forest-project', schemaVersion: 2 },
    { ...initial(), version: 2 },
    { ...initial(), version: 99 },
    { ...initial(), version: undefined },
  ])('明确拒绝旧版、未来版和缺失版本，不迁移或修改输入', (raw) => {
    const before = JSON.stringify(raw)
    expect(() => parseProject(before)).toThrow(/仅支持 V3/)
    expect(JSON.stringify(raw)).toBe(before)
  })
  it.each(['viewport', 'schemaVersion'])('即使 version3 也不接受旧根字段 %s', (key) => {
    expect(() =>
      validateProject({ ...sample(), [key]: key === 'viewport' ? { x: 0, y: 0, zoom: 1 } : 2 }),
    ).toThrow(/字段/)
  })
  it.each(['position', 'collapsed', 'documents', 'folderPath'])(
    '不保留旧节点字段 %s 的读取路径',
    (key) => {
      const p = sample()
      Object.assign(p.nodes[0], { [key]: key === 'collapsed' ? false : {} })
      expect(() => validateProject(p)).toThrow(/字段/)
    },
  )
  it.each([
    (p: ProjectDocument) => {
      delete p.views.tree.positions.a
    },
    (p: ProjectDocument) => {
      p.views.graph.positions.missing = { x: 0, y: 0 }
    },
    (p: ProjectDocument) => {
      p.views.tree.positions.a.x = Infinity
    },
    (p: ProjectDocument) => {
      p.views.graph.positions.a.y = NaN
    },
    (p: ProjectDocument) => {
      p.views.tree.collapsedIds = ['a', 'a']
    },
    (p: ProjectDocument) => {
      p.views.tree.collapsedIds = ['missing']
    },
    (p: ProjectDocument) => {
      p.views.graph.edges[0].target = 'missing'
    },
    (p: ProjectDocument) => {
      delete p.views.graph.positions.b
    },
    (p: ProjectDocument) => {
      p.views.graph.edges[1].id = 'loop'
    },
    (p: ProjectDocument) => {
      p.views.graph.viewport.zoom = 0
    },
  ])('严格校验视图成员、坐标、折叠、端点和视口 %#', (mutate) => {
    const p = sample()
    mutate(p)
    expect(() => validateProject(p)).toThrow()
  })
})
describe('树图完全独立的编辑语义', () => {
  it('分别移动、导航，位置互不影响；节点业务数据共享', () => {
    const original = sample()
    let p = moveNodes(original, new Map([['a', { x: 20, y: 30 }]]))
    p = moveViewNodes(p, 'graph', new Map([['a', { x: 800, y: 900 }]]))
    p = setViewViewport(p, 'tree', { x: 20, y: -30, zoom: 0.4 })
    p = setViewViewport(p, 'graph', { x: -70, y: 90, zoom: 2 })
    expect(p.views.tree.positions.a).toEqual({ x: 20, y: 30 })
    expect(p.views.graph.positions.a).toEqual({ x: 800, y: 900 })
    expect(p.views.tree.viewport.zoom).toBe(0.4)
    expect(p.views.graph.viewport.zoom).toBe(2)
    expect(original.views.tree.positions.a).toEqual({ x: 10, y: 20 })
    expect(original.views.graph.positions.a).toEqual({ x: -100, y: -200 })
    expect(p.nodes).toEqual(original.nodes)
    expect(computeProgress(p)).toEqual(computeProgress(original))
  })
  it('图允许自环、循环、平行连接、多入多出，完全不改变 parentId 或进度', () => {
    const before = sample()
    let p = addGraphEdge(before, { id: 'parallel', source: 'a', target: 'b', direction: 'forward' })
    p = updateGraphEdge(p, 'ab', { source: 'b', target: 'b', direction: 'both', label: '自身' })
    p = removeGraphEdge(p, 'ba')
    expect(p.nodes).toEqual(before.nodes)
    expect(p.views.tree).toEqual(before.views.tree)
    expect(computeProgress(p).get('a')).toBe(42)
    expect(parseProject(serializeProject(p)).views.graph.edges).toEqual(p.views.graph.edges)
    expect(() => reparent(p, 'a', 'b')).toThrow(/循环/)
    expect(reparent(p, 'b', null).views.graph).toEqual(p.views.graph)
  })
  it('树中新建不入图；图中新建为真实树根，折叠不影响图', () => {
    let p = createGraphNode(sample(), 'g', '图新增', { x: 1500, y: 600 }, 0)
    expect(p.nodes.find((n) => n.id === 'g')?.parentId).toBeNull()
    expect(p.views.tree.positions.g).toBeDefined()
    expect(p.views.graph.positions.g).toEqual({ x: 1500, y: 600 })
    p = createChild(p, 'a', 'tree-only', '只在树中', { x: 20, y: 1000 })
    expect(Object.hasOwn(p.views.graph.positions, 'tree-only')).toBe(false)
    const graph = serializeProject(p)
    p = setCollapsed(p, ['a'], true)
    expect(hiddenIds(p).has('b')).toBe(true)
    expect(p.views.graph).toEqual(parseProject(graph).views.graph)
    expect(reveal(p, 'b').views.tree.collapsedIds).toEqual([])
  })
  it('旧 V3 补齐图坐标，保留原节点、图边和位置，并避开已有卡片', () => {
    const original = sample()
    const point = original.views.graph.positions.a
    const before = createChild(original, 'a', '__proto__', '有文件的树节点', point)
    before.nodes[2].linkedPaths = ['../keep.txt']
    const p = withAllGraphNodes(before)
    expect(p.nodes).toEqual(before.nodes)
    expect(p.views.tree).toEqual(before.views.tree)
    expect(p.views.graph.positions).toMatchObject(before.views.graph.positions)
    expect(p.views.graph.edges).toEqual(before.views.graph.edges)
    expect(Object.hasOwn(before.views.graph.positions, '__proto__')).toBe(false)
    expect(Object.hasOwn(p.views.graph.positions, '__proto__')).toBe(true)
    expect(p.views.graph.positions['__proto__']).not.toEqual(point)
    expect(parseProject(serializeProject(p))).toEqual(p)
    expect(withAllGraphNodes(p)).toBe(p)
  })
  it('真实删除清理两视图引用，撤销完整恢复；磁盘文件不在命令处理范围', () => {
    const before = setCollapsed(sample(), ['a', 'b'], true)
    for (const next of [deleteNodes(before, ['a'], false), removeSubtree(before, 'a')]) {
      const h = new CanvasHistory()
      h.record(before, next)
      validateProject(next)
      expect(h.undo(next)).toEqual(before)
      expect(h.redo(before)).toEqual(next)
    }
  })
  it('树复制仅复制树布局，图复制保留选区内图边并新建 ID，原图不变', () => {
    const before = sample()
    let i = 0
    const treeCopy = pasteNodes(
      before,
      copyNodes(before, ['a', 'b']),
      { x: 2000, y: 0 },
      () => 't' + ++i,
    )
    expect(treeCopy.views.graph).toEqual(before.views.graph)
    expect(treeCopy.nodes.find((n) => n.id === 't2')?.parentId).toBe('t1')
    let e = 0
    const graphCopy = pasteNodes(
      before,
      copyNodes(before, ['a', 'b'], false, 'graph'),
      { x: 2000, y: 0 },
      () => 'g' + ++i,
      'graph',
      () => 'edge' + ++e,
    )
    expect(graphCopy.nodes.slice(2).every((n) => n.parentId === null)).toBe(true)
    expect(graphCopy.views.graph.edges).toHaveLength(6)
    expect(graphCopy.views.graph.edges.slice(3).map((e) => e.id)).toEqual([
      'edge1',
      'edge2',
      'edge3',
    ])
    expect(before.views.graph.edges).toHaveLength(3)
    expect(parseProject(serializeProject(graphCopy))).toEqual(graphCopy)
  })
})
describe('V3 跨视图命令历史', () => {
  it('图拖动、边修改、树拖动分组撤销重做，各自视口导航不回退', () => {
    const original = sample(),
      h = new CanvasHistory()
    let p = original
    const steps = [
      (p: ProjectDocument) =>
        moveViewNodes(
          p,
          'graph',
          new Map([
            ['a', { x: 300, y: 400 }],
            ['b', { x: 900, y: 0 }],
          ]),
        ),
      (p: ProjectDocument) => updateGraphEdge(p, 'ab', { direction: 'undirected' }),
      (p: ProjectDocument) => moveNodes(p, new Map([['b', { x: 500, y: 700 }]])),
      (p: ProjectDocument) => deleteNodes(p, ['a'], false),
    ]
    const states = [p]
    for (const edit of steps) {
      const next = edit(p)
      h.record(p, next)
      p = next
      states.push(p)
    }
    p = setViewViewport(setViewViewport(p, 'tree', { x: 12, y: 0, zoom: 0.8 }), 'graph', {
      x: -80,
      y: 0,
      zoom: 1.8,
    })
    for (let i = states.length - 2; i >= 0; i--) {
      p = h.undo(p)
      expect(p.nodes).toEqual(states[i].nodes)
      expect(p.views.tree.positions).toEqual(states[i].views.tree.positions)
      expect(p.views.graph.positions).toEqual(states[i].views.graph.positions)
      expect(p.views.graph.edges).toEqual(states[i].views.graph.edges)
      expect(p.views.tree.viewport.zoom).toBe(0.8)
      expect(p.views.graph.viewport.zoom).toBe(1.8)
    }
    expect(h.canUndo).toBe(false)
    for (let i = 1; i < states.length; i++) p = h.redo(p)
    expect(p.views.graph.edges).toEqual(states.at(-1)!.views.graph.edges)
    expect(p.views.tree.positions).toEqual(states.at(-1)!.views.tree.positions)
  })
  it('单纯视口变化不产生撤销记录', () => {
    const p = sample(),
      h = new CanvasHistory()
    h.record(p, setViewViewport(p, 'graph', { x: 30, y: 0, zoom: 0.8 }))
    expect(h.canUndo).toBe(false)
  })
})
