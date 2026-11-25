import { describe, expect, it } from 'vitest'
import { getBezierPath, Position } from '@vue-flow/core'
import { alignedConnectorSides, selfLoopSides, type NodeBounds } from '../src/domain/connections'
import { connectorSides, type Side } from '../src/domain/canvas'
import { calculateLayout, LAYOUT_DIRECTIONS, type LayoutInput } from '../src/domain/layout'
import { graphRoutePath, routeGraphEdges } from '../src/domain/graphRouting'
import type { Point } from '../src/domain/model'

describe('排列与连接点协同', () => {
  it.each(LAYOUT_DIRECTIONS)('%s 大量分支不因横向偏移改用错误侧面，重开仍可推导', (direction) => {
    const input: LayoutInput = {
      view: 'tree',
      direction,
      nodes: [
        { id: 'root', parentId: null, width: 340, height: 152 },
        ...Array.from({ length: 15 }, (_, i) => ({
          id: 'c' + String(i).padStart(2, '0'),
          parentId: 'root',
          width: 340,
          height: i === 2 ? 480 : 152,
        })),
      ],
      edges: [],
    }
    const positions = calculateLayout(input)
    const bounds = new Map(
      input.nodes.map((n) => [n.id, { ...positions[n.id], width: n.width, height: n.height }]),
    )
    const links = input.nodes.slice(1).map((n) => ({ source: 'root', target: n.id }))
    const expected: [Side, Side] =
      direction === 'LR'
        ? ['right', 'left']
        : direction === 'RL'
          ? ['left', 'right']
          : direction === 'TB'
            ? ['bottom', 'top']
            : ['top', 'bottom']
    expect(alignedConnectorSides(bounds, links).get('root')).toEqual(expected)
    expect(
      alignedConnectorSides(new Map(JSON.parse(JSON.stringify([...bounds]))), links).get('root'),
    ).toEqual(expected)
    // Reproduce the old failure: distance alone flips several extreme branches.
    expect(
      input.nodes
        .slice(1)
        .some(
          (n) =>
            JSON.stringify(
              connectorSides(positions.root, positions[n.id], undefined, 152, n.height),
            ) !== JSON.stringify(expected),
        ),
    ).toBe(true)
  })
  it('自由摆放、分居两侧和重叠不强锁方向；平行边及自环不伪造兄弟分组', () => {
    const bounds = new Map<string, NodeBounds>([
      ['a', { x: 0, y: 0, width: 340, height: 152 }],
      ['b', { x: 436, y: 200, width: 340, height: 152 }],
      ['c', { x: -436, y: -200, width: 340, height: 152 }],
    ])
    expect(
      alignedConnectorSides(bounds, [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ]).size,
    ).toBe(0)
    expect(
      alignedConnectorSides(bounds, [
        { source: 'a', target: 'a' },
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ]).size,
    ).toBe(0)
    bounds.set('c', { ...bounds.get('b')! })
    expect(
      alignedConnectorSides(bounds, [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ]).size,
    ).toBe(0)
    expect(connectorSides({ x: 0, y: 0 }, { x: 0, y: -500 }, undefined, 152, 152)).toEqual([
      'top',
      'bottom',
    ])
  })
  it('同列树分支统一端口；不在原层级时不再推断对齐', () => {
    const bounds = new Map<string, NodeBounds>([
      ['a', { x: 0, y: 1000, width: 340, height: 152 }],
      ['b', { x: 436, y: 0, width: 340, height: 152 }],
      ['c', { x: 436, y: 2000, width: 340, height: 152 }],
    ])
    const links = [
      { source: 'a', target: 'a' },
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'a' },
    ]
    const old = JSON.stringify([...bounds])
    expect(alignedConnectorSides(bounds, links).get('a')).toEqual(['right', 'left'])
    expect(JSON.stringify([...bounds])).toBe(old)
    bounds.set('c', { ...bounds.get('c')!, x: 20 })
    expect(alignedConnectorSides(bounds, links).has('a')).toBe(false)
  })
  it('横向整理的贝塞尔整段位于列间走廊，不绕过源节点上下边或穿入同列卡片', () => {
    const sourceX = 340,
      targetX = 436,
      sourceY = 1000
    for (const targetY of [76, 276, 1076, 2076, 3076]) {
      const path = getBezierPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        curvature: 0.5,
      })[0]
      const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
      expect(coordinates).toHaveLength(8)
      const [x0, y0, x1, y1, x2, y2, x3, y3] = coordinates
      for (let t = 0; t <= 1; t += 0.05) {
        const x =
          (1 - t) ** 3 * x0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3 * x3
        const y =
          (1 - t) ** 3 * y0 + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3 * y3
        expect(x).toBeGreaterThanOrEqual(sourceX - 0.001)
        expect(x).toBeLessThanOrEqual(targetX + 0.001)
        expect(y).toBeGreaterThanOrEqual(Math.min(sourceY, targetY) - 0.001)
        expect(y).toBeLessThanOrEqual(Math.max(sourceY, targetY) + 0.001)
      }
    }
  })
})

function entersCard(points: Point[], box: NodeBounds): boolean {
  return points.slice(1).some((to, index) => {
    const from = points[index]
    if (from.x === to.x)
      return (
        from.x > box.x &&
        from.x < box.x + box.width &&
        Math.min(from.y, to.y) < box.y + box.height &&
        Math.max(from.y, to.y) > box.y
      )
    return (
      from.y > box.y &&
      from.y < box.y + box.height &&
      Math.min(from.x, to.x) < box.x + box.width &&
      Math.max(from.x, to.x) > box.x
    )
  })
}

describe('图视图正交连线', () => {
  const triangle: LayoutInput['edges'] = [
    { id: 'ab', source: 'a', target: 'b', direction: 'forward' },
    { id: 'ac', source: 'a', target: 'c', direction: 'forward' },
    { id: 'bc', source: 'b', target: 'c', direction: 'forward' },
  ]
  it.each(LAYOUT_DIRECTIONS)('%s 中间卡片不遮挡 A–C，三条边各自显示', (direction) => {
    const nodes = [113, 480, 152].map((height, i) => ({
      id: ['a', 'b', 'c'][i],
      parentId: null,
      width: 340,
      height,
    }))
    const bounds = new Map(
      nodes.map((n, index) => {
        const delta = index * 620
        const { x, y } = {
          LR: { x: delta, y: 0 },
          RL: { x: -delta, y: 0 },
          TB: { x: 0, y: delta },
          BT: { x: 0, y: -delta },
        }[direction]
        return [n.id, { ...n, x, y }]
      }),
    )
    const routes = routeGraphEdges(bounds, triangle)
    expect([...routes.keys()]).toEqual(['ab', 'ac', 'bc'])
    expect(routeGraphEdges(bounds, [...triangle].reverse())).toEqual(routes)
    expect(entersCard(routes.get('ac')!.points, bounds.get('b')!)).toBe(false)
    const paths = [...routes.values()].map(graphRoutePath)
    expect(new Set(paths).size).toBe(3)
    expect(graphRoutePath(routes.get('ac')!)).toContain(' A ')
    for (const { points } of routes.values())
      expect(points.slice(1).every((p, i) => p.x === points[i].x || p.y === points[i].y)).toBe(true)
    for (const path of paths) expect(path).not.toMatch(/[CQ]/)
  })
  it('同侧平行与反向边分配独立端点，多条自环也不重合', () => {
    const bounds = new Map([
      ['a', { x: 0, y: 0, width: 340, height: 113 }],
      ['b', { x: 500, y: 0, width: 340, height: 152 }],
    ])
    const links: LayoutInput['edges'] = [
      triangle[0],
      { ...triangle[0], id: 'copy' },
      { id: 'reverse', source: 'b', target: 'a', direction: 'forward' },
      { id: 'loop', source: 'a', target: 'a', direction: 'forward' },
      { id: 'loop2', source: 'a', target: 'a', direction: 'forward' },
    ]
    const routes = routeGraphEdges(bounds, links)
    expect(new Set([...routes.values()].map(graphRoutePath)).size).toBe(links.length)
    const aPorts = ['ab', 'copy', 'reverse'].map((id) => {
      const route = routes.get(id)!
      expect(route.points).toHaveLength(2)
      return id === 'reverse' ? route.points.at(-1)!.y : route.points[0].y
    })
    expect(new Set(aPorts).size).toBe(3)
    expect(routes.get('loop')?.loop).toBe(0)
    expect(routes.get('loop2')?.loop).toBe(1)
  })
  it('不同高度卡片的端点滑到无障碍直线，轻微拖动保留朝向', () => {
    const a = { x: 0, y: 0, width: 340, height: 113 }
    const b = { x: 510, y: -183, width: 340, height: 480 }
    const c = { x: 400, y: -80, width: 90, height: 110 }
    const bounds = new Map([
      ['a', a],
      ['b', b],
      ['c', c],
    ])
    const routes = routeGraphEdges(bounds, [triangle[0]])
    expect(routes.get('ab')?.handles).toEqual(['right', 'left'])
    expect(routes.get('ab')?.points).toHaveLength(2)
    bounds.set('b', { ...b, y: b.y + 5 })
    const moved = routeGraphEdges(bounds, [triangle[0]], routes).get('ab')!
    expect(moved.handles).toEqual(['right', 'left'])
    expect(moved.points).toHaveLength(2)
    expect(moved.points).not.toEqual(routes.get('ab')?.points)
    expect(entersCard(moved.points, c)).toBe(false)
  })
  it('无共同直线通道时优先选一个转角的 L 形', () => {
    const bounds = new Map([
      ['a', { x: 0, y: 0, width: 340, height: 113 }],
      ['b', { x: 520, y: 320, width: 340, height: 152 }],
    ])
    const route = routeGraphEdges(bounds, [triangle[0]]).get('ab')!
    expect(route.points).toHaveLength(3)
    expect(graphRoutePath(route).match(/ A /g)).toHaveLength(1)
  })
  it('多块中间障碍中选择更近且可用的通道', () => {
    const boxes = [
      { x: 0, y: 0, width: 340, height: 113 },
      { x: 500, y: -40, width: 340, height: 152 },
      { x: 1000, y: 0, width: 340, height: 113 },
      { x: 450, y: -190, width: 340, height: 113 },
    ]
    const bounds = new Map(boxes.map((box, i) => [['a', 'b', 'c', 'd'][i], box]))
    const route = routeGraphEdges(bounds, [triangle[1]]).get('ac')!
    expect(entersCard(route.points, boxes[1])).toBe(false)
    expect(entersCard(route.points, boxes[3])).toBe(false)
    expect(Math.min(...route.points.map((p) => p.y))).toBeGreaterThan(-190)
    for (let i = 2; i < route.points.length; i++) {
      const [a, b, c] = route.points.slice(i - 2, i + 1)
      expect((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)).toBe(false)
    }
  })
})

describe('图视图自环', () => {
  it.each([113, 152, 480])('高度%i紧贴可用转角，平移后保持路径', (height) => {
    const card = { x: 0, y: 0, width: 340, height }
    const edges: LayoutInput['edges'] = [
      { id: 'loop', source: 'a', target: 'a', direction: 'both' },
    ]
    const route = routeGraphEdges(new Map([['a', card]]), edges).get('loop')!
    expect(route.points).toHaveLength(5)
    expect(entersCard(route.points, card)).toBe(false)
    expect(Math.max(...route.points.map((p) => p.x))).toBeLessThanOrEqual(360)
    expect(Math.min(...route.points.map((p) => p.y))).toBeGreaterThanOrEqual(-20)
    expect(graphRoutePath(route)).toMatch(/ A /)
    const moved = routeGraphEdges(new Map([['a', { ...card, x: 25, y: -40 }]]), edges).get('loop')!
    expect(moved.points).toEqual(route.points.map((p) => ({ x: p.x + 25, y: p.y - 40 })))
  })
  it('优先使用空闲转角；无空角时仍稳定', () => {
    expect(selfLoopSides(new Set())).toEqual(['right', 'top'])
    expect(selfLoopSides(new Set(['right']))).toEqual(['left', 'top'])
    expect(selfLoopSides(new Set(['top']))).toEqual(['right', 'bottom'])
    expect(selfLoopSides(new Set(['right', 'top']))).toEqual(['left', 'bottom'])
    expect(selfLoopSides(new Set(['left', 'right', 'top', 'bottom']))).toEqual(['right', 'top'])
  })
})
