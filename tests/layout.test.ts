import { describe, expect, it } from 'vitest'
import { calculateGraphLayout } from '../src/domain/elkLayout'
import { graphRoutePath, routeGraphEdges } from '../src/domain/graphRouting'
import {
  calculateLayout,
  makeLayoutInput,
  LAYOUT_DIRECTIONS,
  type LayoutDirection,
  type LayoutInput,
  type LayoutNode,
} from '../src/domain/layout'
import { createProject, parseProject, serializeProject, type Point } from '../src/domain/model'
import { createRoot, createChild } from '../src/domain/forest'
import { addToGraph, addGraphEdge, moveViewNodes, setCollapsed } from '../src/domain/views'
import { CanvasHistory } from '../src/application/history'

const node = (id: string, parentId: string | null = null, height = 152): LayoutNode => ({
  id,
  parentId,
  width: 340,
  height,
})
const tree = (direction: LayoutDirection): LayoutInput => ({
  view: 'tree',
  direction,
  nodes: [node('a'), node('b', 'a'), node('c', 'a'), node('d', 'b', 480), node('root2')],
  edges: [],
})
function noOverlap(input: LayoutInput, positions: ReturnType<typeof calculateLayout>) {
  for (let i = 0; i < input.nodes.length; i++) {
    const a = input.nodes[i],
      p = positions[a.id]
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    for (let j = i + 1; j < input.nodes.length; j++) {
      const b = input.nodes[j],
        q = positions[b.id]
      if (!(
        p.x + a.width <= q.x ||
        q.x + b.width <= p.x ||
        p.y + a.height <= q.y ||
        q.y + b.height <= p.y
      ))
        throw new Error('重叠：' + a.id + ' / ' + b.id)
    }
  }
}
function follows(
  direction: LayoutDirection,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  if (direction === 'TB') expect(to.y).toBeGreaterThan(from.y)
  if (direction === 'BT') expect(to.y).toBeLessThan(from.y)
  if (direction === 'LR') expect(to.x).toBeGreaterThan(from.x)
  if (direction === 'RL') expect(to.x).toBeLessThan(from.x)
}
describe('树自动整理', () => {
  it.each(LAYOUT_DIRECTIONS)('%s 层级正确，多根及展开卡片不重叠，稳定且无输入修改', (direction) => {
    const input = tree(direction),
      before = structuredClone(input),
      positions = calculateLayout(input)
    for (const n of input.nodes)
      if (n.parentId) follows(direction, positions[n.parentId], positions[n.id])
    noOverlap(input, positions)
    expect(calculateLayout(input)).toEqual(positions)
    expect(input).toEqual(before)
    expect(calculateLayout({ ...input, nodes: [...input.nodes].reverse() })).toEqual(positions)
  })
  it('同级叶子等间隔、父节点居中', () => {
    const input: LayoutInput = {
      view: 'tree',
      direction: 'TB',
      nodes: [node('a'), node('b', 'a'), node('c', 'a'), node('d', 'a')],
      edges: [],
    }
    const p = calculateLayout(input)
    expect(p.b.y).toBe(p.c.y)
    expect(p.c.y).toBe(p.d.y)
    expect(p.c.x - p.b.x).toBe(p.d.x - p.c.x)
    expect(p.a.x + 170).toBe((p.b.x + p.d.x) / 2 + 170)
  })
  it('不同高度且大小不对称的子树按直属孩子端口居中', () => {
    const input: LayoutInput = {
      view: 'tree',
      direction: 'LR',
      edges: [],
      nodes: [
        node('a', null, 152),
        node('b', 'a', 113),
        node('c', 'a', 480),
        node('d', 'b', 480),
        node('e', 'b', 152),
        node('f', 'b', 441),
      ],
    }
    const p = calculateLayout(input)
    noOverlap(input, p)
    expect(p.a.y + 152 / 2).toBe((p.b.y + 113 / 2 + p.c.y + 480 / 2) / 2)
  })
  it('折叠只整理可见节点，保留全部后代坐标和折叠位；图仍包含折叠树的后代', () => {
    let p = createChild(
      createRoot(createProject('布局', 'c0e631c4-9154-4478-b7af-a2d166e62a36'), 'a', '根', {
        x: 0,
        y: 0,
      }),
      'a',
      'b',
      '子',
      { x: 500, y: 400 },
    )
    p = addToGraph(addToGraph(p, 'a', { x: 0, y: 0 }), 'b', { x: 0, y: 0 })
    p = setCollapsed(p, ['a'], true)
    const input = makeLayoutInput(p, 'tree', 'TB', new Set(['a']))
    expect(input.nodes.map((n) => n.id)).toEqual(['a'])
    expect(input.nodes[0].height).toBe(480)
    const next = moveViewNodes(p, 'tree', new Map(Object.entries(calculateLayout(input))))
    expect(next.views.tree.positions.b).toEqual(p.views.tree.positions.b)
    expect(next.views.tree.collapsedIds).toEqual(['a'])
    expect(next.views.graph).toEqual(p.views.graph)
    expect(makeLayoutInput(next, 'graph', 'LR', new Set()).nodes).toHaveLength(2)
    expect(next.nodes).toEqual(p.nodes)
  })
  it('5000层树不使用递归调用栈，非法树环明确失败', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) =>
      node('n' + String(i).padStart(5, '0'), i ? 'n' + String(i - 1).padStart(5, '0') : null),
    )
    const p = calculateLayout({ view: 'tree', direction: 'TB', nodes, edges: [] })
    expect(p.n04999.y).toBeGreaterThan(p.n00000.y)
    expect(() =>
      calculateLayout({
        view: 'tree',
        direction: 'TB',
        nodes: [node('a', 'b'), node('b', 'a')],
        edges: [],
      }),
    ).toThrow(/循环/)
  })
})

describe('ELK Stress 自由图自动整理', () => {
  type Box = Point & { width: number; height: number }
  function clearance(a: Box, b: Box): number {
    return Math.max(
      b.x - a.x - a.width,
      a.x - b.x - b.width,
      b.y - a.y - a.height,
      a.y - b.y - b.height,
    )
  }

  const fixture = (direction: LayoutDirection): LayoutInput => ({
    view: 'graph',
    direction,
    nodes: [node('a', null, 113), node('b', null, 480), node('c'), node('isolated')],
    edges: [
      { id: 'ab', source: 'a', target: 'b', direction: 'forward' },
      { id: 'bc', source: 'b', target: 'c', direction: 'forward' },
      { id: 'ac', source: 'a', target: 'c', direction: 'forward' },
      { id: 'parallel', source: 'a', target: 'b', direction: 'forward' },
      { id: 'loop', source: 'a', target: 'a', direction: 'forward' },
    ],
  })
  it.each(LAYOUT_DIRECTIONS)('%s 保持二维布局、矩形间距和稳定的节点顺序', async (direction) => {
    const input = fixture(direction)
    const original = structuredClone(input)
    const result = await calculateGraphLayout(input)
    const { positions } = result
    noOverlap(input, positions)
    const [a, b, c] = input.nodes.slice(0, 3).map(({ id, width, height }) => ({
      x: positions[id].x + width / 2,
      y: positions[id].y + height / 2,
    }))
    // The connected triangle occupies two axes, regardless of edge direction.
    expect(Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))).toBeGreaterThan(1_000)
    for (const [i, left] of input.nodes.entries()) {
      for (const right of input.nodes.slice(i + 1)) {
        expect(
          clearance({ ...left, ...positions[left.id] }, { ...right, ...positions[right.id] }),
        ).toBeGreaterThanOrEqual(right.id === 'isolated' ? 180 : 100)
      }
    }
    expect(
      await calculateGraphLayout({
        ...input,
        nodes: [...input.nodes].reverse(),
        edges: input.edges.map((e) => ({ ...e, source: e.target, target: e.source })).reverse(),
      }),
    ).toEqual(result)
    expect(input).toEqual(original)
  })

  it('期望边长根据两端卡片的实际宽高变化', async () => {
    const input: LayoutInput = {
      view: 'graph',
      direction: 'TB',
      nodes: [node('a', null, 112), node('b', null, 112)],
      edges: [{ id: 'ab', source: 'a', target: 'b', direction: 'forward' }],
    }
    const layout = async () => {
      const {
        positions: { a, b },
      } = await calculateGraphLayout(input)
      const [source, target] = input.nodes
      return Math.hypot(
        b.x - a.x + (target.width - source.width) / 2,
        b.y - a.y + (target.height - source.height) / 2,
      )
    }
    const compactDiagonal = Math.hypot(340, 112)
    expect(await layout()).toBeCloseTo(compactDiagonal + 100, 2)
    input.nodes[1] = node('b', null, 480)
    expect(await layout()).toBeCloseTo((compactDiagonal + Math.hypot(340, 480)) / 2 + 100, 2)
  })

  it('只对齐相近的相连节点，保留净距和自由布局', async () => {
    const nodes = [480, 441, 113, 152, 480].map((height, i) => node(`n${i}`, null, height))
    const edges = nodes.slice(1).map((target, i) => ({
      id: `edge-${i}`,
      source: nodes[i].id,
      target: target.id,
      direction: 'forward' as const,
    }))
    const input: LayoutInput = {
      view: 'graph',
      direction: 'BT',
      nodes,
      edges: [...edges, { id: 'loop', source: 'n0', target: 'n0', direction: 'forward' }],
    }
    const result = await calculateGraphLayout(input)
    const { n0, n1, n2, n3 } = result.positions
    expect(n2.x).toBe(n3.x)
    expect(Math.abs(n0.x - n1.x)).toBeGreaterThan(36)
    expect(Math.abs(n1.x - n2.x)).toBeGreaterThan(36)
    const cards = nodes.map((n) => ({ ...n, ...result.positions[n.id] }))
    for (const [index, card] of cards.entries()) {
      for (const other of cards.slice(index + 1))
        expect(clearance(card, other)).toBeGreaterThanOrEqual(100)
    }
    await expect(
      calculateGraphLayout({ ...input, edges: [...input.edges].reverse() }),
    ).resolves.toEqual(result)
  })

  it.each(LAYOUT_DIRECTIONS)(
    '%s 独立简单链沿箭头顺序排齐，保留 100px 卡片净距',
    async (direction) => {
      const chain = ['d', 'b', 'a', 'c'].map((id, i) => node(id, null, [112, 480, 152, 441][i]))
      const input: LayoutInput = {
        view: 'graph',
        direction,
        nodes: [...chain, node('isolated')],
        edges: chain.slice(1).map((target, i) => ({
          id: String(i),
          source: chain[i].id,
          target: target.id,
          direction: i === 1 ? 'undirected' : 'forward',
        })),
      }
      const { positions } = await calculateGraphLayout(input)
      const horizontal = direction === 'LR' || direction === 'RL'
      const centers = chain.map((n) => ({
        x: positions[n.id].x + n.width / 2,
        y: positions[n.id].y + n.height / 2,
      }))
      expect(new Set(centers.map((p) => (horizontal ? p.y : p.x))).size).toBe(1)
      noOverlap(input, positions)
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1],
          b = chain[i]
        follows(direction, centers[i - 1], centers[i])
        expect(
          clearance({ ...a, ...positions[a.id] }, { ...b, ...positions[b.id] }),
        ).toBeGreaterThanOrEqual(100)
      }
      await expect(
        calculateGraphLayout({
          ...input,
          nodes: [...input.nodes].reverse(),
          edges: [...input.edges].reverse(),
        }),
      ).resolves.toEqual({ positions })
    },
  )

  it('循环、双向边、平行边和自环仍由实时路由逐条绘制', async () => {
    const input = fixture('TB')
    input.edges.push(
      { id: 'ca', source: 'c', target: 'a', direction: 'both' },
      { id: 'free', source: 'c', target: 'b', direction: 'undirected' },
      { id: 'isolatedLoop', source: 'isolated', target: 'isolated', direction: 'forward' },
    )
    const { positions } = await calculateGraphLayout(input)
    const bounds = new Map(input.nodes.map((n) => [n.id, { ...n, ...positions[n.id] }]))
    const routes = routeGraphEdges(bounds, input.edges)
    expect(routes.size).toBe(input.edges.length)
    expect(new Set([...routes.values()].map(graphRoutePath)).size).toBe(input.edges.length)
    expect(graphRoutePath(routes.get('loop')!)).toContain(' A ')
    expect(positions).toEqual(
      (await calculateGraphLayout({ ...input, edges: input.edges.slice(0, 3) })).positions,
    )
  })

  it('密集的混合高度分量在避碰和打包后仍达到最小净距', async () => {
    const heights = [480, 112, 152, 441]
    const nodes = Array.from({ length: 100 }, (_, i) =>
      node(String(i).padStart(4, '0'), null, heights[i % heights.length]),
    )
    const components = [0, 1].map((parity) =>
      nodes.filter((_, i) => i % 7 !== 0 && i % 2 === parity),
    )
    const edges = components.flatMap((cards) =>
      cards.flatMap((source, index) =>
        cards
          .slice(index + 1)
          .filter((_, delta) => delta === 0 || (index + delta + 2) % 9 === 0)
          .map((target) => ({
            id: source.id + target.id,
            source: source.id,
            target: target.id,
            direction: 'forward' as const,
          })),
      ),
    )
    const { positions } = await calculateGraphLayout({
      view: 'graph',
      direction: 'RL',
      nodes,
      edges,
    })
    for (const [i, a] of nodes.entries()) {
      for (const [delta, b] of nodes.slice(i + 1).entries()) {
        const j = i + 1 + delta
        const sameComponent = i % 7 !== 0 && j % 7 !== 0 && i % 2 === j % 2
        expect(
          clearance({ ...a, ...positions[a.id] }, { ...b, ...positions[b.id] }),
        ).toBeGreaterThanOrEqual(sameComponent ? 100 : 180)
      }
    }
  })

  it('2,000 张卡片混合循环分量和孤立节点，打包保持卡片及分量净距', async () => {
    const input: LayoutInput = {
      view: 'graph',
      direction: 'TB',
      nodes: Array.from({ length: 2000 }, (_, index) =>
        node(String(index).padStart(4, '0'), null, index % 3 ? 152 : 480),
      ),
      edges: [],
    }
    input.edges = input.nodes.slice(0, 1000).map((n, index) => ({
      id: 'edge-' + index,
      source: n.id,
      target: input.nodes[Math.floor(index / 50) * 50 + ((index + 1) % 50)].id,
      direction: 'forward',
    }))
    const { positions } = await calculateGraphLayout(input)
    noOverlap(input, positions)
    expect(Object.keys(positions)).toHaveLength(input.nodes.length)
    const components: Box[] = []
    for (let start = 0; start < input.nodes.length;) {
      const end = start + (start < 1000 ? 50 : 1)
      const cards = input.nodes.slice(start, end).map((n) => ({ ...n, ...positions[n.id] }))
      for (const [index, card] of cards.entries()) {
        for (const other of cards.slice(index + 1)) {
          expect(clearance(card, other)).toBeGreaterThanOrEqual(100)
        }
      }
      const x = Math.min(...cards.map((n) => n.x))
      const y = Math.min(...cards.map((n) => n.y))
      components.push({
        x,
        y,
        width: Math.max(...cards.map((n) => n.x + n.width)) - x,
        height: Math.max(...cards.map((n) => n.y + n.height)) - y,
      })
      start = end
    }
    for (const [index, component] of components.entries()) {
      for (const other of components.slice(index + 1)) {
        const gap = clearance(component, other)
        if (gap < 180) throw new Error(`分量间距不足：${gap}px`)
      }
    }
  }, 20_000)
})
describe('布局命令隔离、历史与存储', () => {
  it.each(['tree', 'graph'] as const)(
    '%s 只修改当前坐标，一次整理一步历史，另一个视图、文件、业务数据及关系保留',
    async (view) => {
      let p = createRoot(createProject('布局', 'c0e631c4-9154-4478-b7af-a2d166e62a36'), 'a', '根', {
        x: -77,
        y: -90,
      })
      p = createChild(p, 'a', 'b', '子', { x: -77, y: -90 })
      p = addToGraph(addToGraph(p, 'a', { x: 3000, y: 0 }), 'b', { x: 3000, y: 0 })
      p = addGraphEdge(p, { id: 'ba', source: 'b', target: 'a', direction: 'both' })
      p.nodes[0].linkedPaths = ['../keep.txt']
      const before = serializeProject(p),
        h = new CanvasHistory(),
        other = view === 'tree' ? 'graph' : 'tree'
      const input = makeLayoutInput(p, view, 'RL', new Set(['b']))
      const positions =
        view === 'graph' ? (await calculateGraphLayout(input)).positions : calculateLayout(input)
      const next = moveViewNodes(p, view, new Map(Object.entries(positions)))
      h.record(p, next)
      expect(next.nodes).toEqual(p.nodes)
      expect(next.views[other]).toEqual(p.views[other])
      expect(next.views.graph.edges).toEqual(p.views.graph.edges)
      expect(next.views.tree.collapsedIds).toEqual(p.views.tree.collapsedIds)
      expect(next.views[view].viewport).toEqual(p.views[view].viewport)
      expect(parseProject(serializeProject(next))).toEqual(next)
      expect(serializeProject(h.undo(next))).toBe(before)
      expect(h.canUndo).toBe(false)
      expect(h.redo(p)).toEqual(next)
      expect(serializeProject(p)).toBe(before)
    },
  )
  it('空视图为空结果；非法方向和尺寸拒绝', async () => {
    await expect(
      calculateGraphLayout({ view: 'graph', direction: 'TB', nodes: [], edges: [] }),
    ).resolves.toEqual({ positions: {} })
    expect(() =>
      calculateLayout({ ...tree('TB'), direction: 'other' as LayoutDirection }),
    ).toThrow()
    expect(() =>
      calculateLayout({ ...tree('TB'), nodes: [{ ...node('a'), height: NaN }] }),
    ).toThrow()
  })
})
