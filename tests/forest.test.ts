import { describe, expect, it } from 'vitest'
import {
  createProject,
  MAX_COORDINATE,
  parseProject,
  serializeProject,
  validateProject,
  type ProjectDocument,
} from '../src/domain/model'
import {
  computeProgress,
  createChild,
  createRoot,
  freePosition,
  moveNodes,
  removeNodeOnly,
  removeSubtree,
  renameNode,
  reparent,
  setManualProgress,
  setViewport,
  setWeight,
} from '../src/domain/forest'
import { CARD_GAP, CARD_HEIGHT } from '../src/domain/geometry'
import { addToGraph } from '../src/domain/views'

const initial = () => createProject('测试森林', 'c0e631c4-9154-4478-b7af-a2d166e62a36')
function family(weights = [1, 3], values = [20, 80]): ProjectDocument {
  let p = createRoot(initial(), 'parent', '父', { x: 10, y: 20 })
  p = setManualProgress(p, 'parent', 73)
  for (let i = 0; i < weights.length; i++) {
    p = createChild(p, 'parent', `c${i}`, `子 ${i}`, { x: 350, y: i * 160 }, weights[i])
    p = setManualProgress(p, `c${i}`, values[i])
  }
  return p
}
describe('递归权重进度', () => {
  it('20/80 权重 1/3 得到 65%，父手动值一直保留', () => {
    const p = family()
    expect(computeProgress(p).get('parent')).toBeCloseTo(65, 12)
    expect(p.nodes[0].progress).toBe(73)
  })
  it('全部 0 权重的父节点回退保存的手动 73%', () => {
    expect(computeProgress(family([0, 0])).get('parent')).toBe(73)
  })
  it('部分 0 权重不参与平均，节点自身仍有进度', () => {
    const result = computeProgress(family([0, 4]))
    expect(result.get('parent')).toBe(80)
    expect(result.get('c0')).toBe(20)
  })
  it('递归计算，0 权重节点可有完整子树', () => {
    let p = family([0, 1], [10, 80])
    p = createChild(p, 'c0', 'grandchild', '孙', { x: 650, y: 20 })
    p = setManualProgress(p, 'grandchild', 50)
    expect(computeProgress(p).get('c0')).toBeCloseTo(50, 12)
    expect(computeProgress(p).get('parent')).toBe(80)
    p = setWeight(p, 'c0', 3)
    expect(computeProgress(p).get('parent')).toBeCloseTo(57.5, 12)
    expect(p.nodes.find((n) => n.id === 'c0')?.progress).toBe(10)
  })
  it('删除最后一个子节点后恢复父节点原始手动 73%', () => {
    const p = removeNodeOnly(removeNodeOnly(family(), 'c0'), 'c1')
    expect(computeProgress(p).get('parent')).toBe(73)
  })
  it('嫁接走最后子节点也恢复手动值，保留整棵子树和坐标', () => {
    let p = family([1], [40])
    p = createChild(p, 'c0', 'g', '孙', { x: 900, y: 30 })
    const before = p.nodes.map((n) => ({ ...p.views.tree.positions[n.id] }))
    p = reparent(p, 'c0', null)
    expect(computeProgress(p).get('parent')).toBe(73)
    expect(p.nodes.find((n) => n.id === 'g')?.parentId).toBe('c0')
    expect(p.nodes.map((n) => p.views.tree.positions[n.id])).toEqual(before)
  })
  it('多个最大安全整数权重归一化，不做不安全的整数求和', () => {
    expect(
      computeProgress(family([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])).get('parent'),
    ).toBeCloseTo(50, 12)
  })
  it('不逐层取整，保留内部小数精度', () => {
    let p = family([1, 2], [0, 100])
    p = createRoot(p, 'root2', '上层', { x: 0, y: 0 })
    p = reparent(p, 'parent', 'root2')
    expect(computeProgress(p).get('root2')).toBeCloseTo(200 / 3, 12)
  })
})
describe('森林命令', () => {
  it('可创建 3 根和多级子树；普通与无权重仅是默认权重不同', () => {
    let p = initial()
    for (let i = 0; i < 3; i++)
      p = createRoot(p, `r${i}`, `根${i}`, { x: i * 400, y: 0 }, i === 1 ? 0 : 1)
    p = createChild(p, 'r0', 'c', '子', { x: 0, y: 160 })
    p = createChild(p, 'c', 'g', '孙', { x: 0, y: 320 }, 0)
    expect(p.nodes.filter((n) => n.parentId === null)).toHaveLength(3)
    expect(p.nodes.find((n) => n.id === 'c')?.weight).toBe(1)
    expect(p.nodes.find((n) => n.id === 'g')?.weight).toBe(0)
    expect(parseProject(serializeProject(p))).toEqual(p)
  })
  it('禁止自连、回环，拒绝后旧状态不变', () => {
    const p = family(),
      before = serializeProject(p)
    expect(() => reparent(p, 'parent', 'parent')).toThrow()
    expect(() => reparent(p, 'parent', 'c1')).toThrow(/循环/)
    expect(serializeProject(p)).toBe(before)
  })
  it('缺失 parent 和重复 ID 不会被静默修复', () => {
    const p = family()
    expect(() => reparent(p, 'c0', 'missing')).toThrow(/缺失/)
    expect(() => createRoot(p, 'c0', '重复', { x: 0, y: 0 })).toThrow(/重复/)
    const raw = structuredClone(p)
    raw.nodes.push({ ...raw.nodes[0] })
    expect(() => validateProject(raw)).toThrow(/重复/)
  })
  it('仅删除节点使直接子节点成为根，不接到祖父', () => {
    let p = createChild(family(), 'c0', 'g', '孙', { x: 650, y: 0 })
    p = removeNodeOnly(p, 'c0')
    expect(p.nodes.find((n) => n.id === 'g')?.parentId).toBeNull()
    expect(p.nodes.find((n) => n.id === 'c1')?.parentId).toBe('parent')
  })
  it('删除子树只删除目标与后代', () => {
    const p = createChild(family(), 'c0', 'g', '孙', { x: 650, y: 0 })
    expect(removeSubtree(p, 'c0').nodes.map((n) => n.id)).toEqual(['parent', 'c1'])
  })
  it('移动父节点不移动子节点，重命名及视口可无损 roundtrip', () => {
    const p = family(),
      child = { ...p.nodes[1] }
    let next = moveNodes(p, new Map([['parent', { x: -35.5, y: 84.25 }]]))
    next = renameNode(next, 'parent', '新标题')
    next = setViewport(next, { x: 15, y: -72.25, zoom: 0.65 })
    expect(next.nodes[1]).toEqual(child)
    expect(p.nodes[0].title).toBe('父')
    expect(parseProject(serializeProject(next))).toEqual(next)
    expect(serializeProject(next)).not.toMatch(/computedProgress|selected|handleSide/)
  })
  it('寻找空位不改动已有坐标', () => {
    const p = family(),
      before = serializeProject(p)
    const point = freePosition(p, { ...p.views.tree.positions[p.nodes[0].id] })
    expect(point).not.toEqual(p.views.tree.positions[p.nodes[0].id])
    expect(serializeProject(p)).toBe(before)
  })
  it('Graph 寻位只检查图中的卡片，连续避开偏离网格的卡片并尊重坐标上限', () => {
    const p = family(),
      step = CARD_HEIGHT + CARD_GAP
    expect(freePosition(p, p.views.tree.positions.parent, 'graph')).toEqual(
      p.views.tree.positions.parent,
    )
    const nearby = addToGraph(addToGraph(p, 'c0', { x: 0, y: step / 2 }), 'c1', {
      x: 0,
      y: (5 * step) / 2,
    })
    expect(freePosition(nearby, { x: 0, y: 0 }, 'graph')).toEqual({ x: 0, y: 4 * step })

    const limit = { x: MAX_COORDINATE, y: MAX_COORDINATE }
    const atLimit = addToGraph(p, 'c0', limit)
    const position = freePosition(atLimit, { x: limit.x + 500, y: limit.y + 500 }, 'graph')
    expect(position).toEqual({ x: limit.x, y: limit.y - step })
    expect(addToGraph(atLimit, 'c1', position).views.tree).toEqual(p.views.tree)
  })
})
describe('项目入口严格验证', () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('拒绝非法 weight %s', (value) => {
    expect(() => setWeight(family(), 'c0', value)).toThrow()
  })
  it.each([-1, 101, Infinity, NaN])('拒绝非法 progress %s', (value) => {
    expect(() => setManualProgress(family(), 'c0', value)).toThrow()
  })
  it('拒绝损坏 JSON、未来 schema、派生字段、非法坐标、空标题与坏 UUID', () => {
    expect(() => parseProject('{')).toThrow(/损坏/)
    for (const mutate of [
      (p: Record<string, unknown>) => {
        p.version = 99
      },
      (p: Record<string, unknown>) => {
        p.edges = []
      },
      (p: Record<string, unknown>) => {
        p.name = '  '
      },
      (p: Record<string, unknown>) => {
        p.projectId = 'not-a-uuid'
      },
      (p: Record<string, unknown>) => {
        p.viewport = { x: Infinity, y: 0, zoom: 1 }
      },
    ]) {
      const p = structuredClone(initial()) as unknown as Record<string, unknown>
      mutate(p)
      expect(() => validateProject(p)).toThrow()
    }
    expect(() => renameNode(family(), 'c0', 'bad\nname')).toThrow()
  })
  it.each(['../a', 'a/b', 'a\\b', 'CON', 'a:ads', '', 'a.b', 'K'])('拒绝不安全节点 ID %s', (id) => {
    const p = family()
    p.nodes[0].id = id
    expect(() => validateProject(p)).toThrow()
  })
  it('不持久化内部清单；拒绝旧版本、旧 documents 和目录大小写冲突', () => {
    const p = family()
    expect(serializeProject(p)).not.toMatch(/documents|folderPath|linkedPaths/)
    expect(() =>
      parseProject(serializeProject(p).replace('"version": 3', '"version": 2')),
    ).toThrow()
    expect(() =>
      validateProject({ ...p, nodes: p.nodes.map((n) => ({ ...n, documents: [] })) }),
    ).toThrow()
    p.nodes[1].id = 'PARENT'
    expect(() => validateProject(p)).toThrow(/ID/)
  })
})

describe('有效带权子节点与手动进度回退', () => {
  it.each([0, 37.5, 100])('无子节点及全0子节点均使用自身手动值 %s', (value) => {
    let p = setManualProgress(family([0, 0]), 'parent', value)
    expect(computeProgress(p).get('parent')).toBe(value)
    p = removeSubtree(removeSubtree(p, 'c0'), 'c1')
    expect(computeProgress(p).get('parent')).toBe(value)
  })
  it('无权父节点仍递归计算带权孩子，仅从祖父的平均中排除', () => {
    let p = family([0, 2], [17, 80])
    p = createChild(p, 'c0', 'g1', '孙1', { x: 700, y: 0 }, 1)
    p = createChild(p, 'c0', 'g2', '孙2', { x: 700, y: 150 }, 3)
    p = setManualProgress(p, 'g1', 20)
    p = setManualProgress(p, 'g2', 60)
    expect(computeProgress(p).get('c0')).toBeCloseTo(50, 12)
    expect(computeProgress(p).get('parent')).toBe(80)
    p = setManualProgress(p, 'c0', 91)
    expect(computeProgress(p).get('c0')).toBeCloseTo(50, 12)
    expect(p.nodes.find((n) => n.id === 'c0')?.progress).toBe(91)
    p = setWeight(p, 'c0', 2)
    expect(computeProgress(p).get('parent')).toBe(65)
    expect(p.nodes.find((n) => n.id === 'c0')?.progress).toBe(91)
  })
  it('权重切换、添加及删除子节点不覆盖手动值，最后一个带权孩子消失立即回退', () => {
    let p = family([0, 0], [20, 80])
    p = setWeight(p, 'parent', 0)
    expect(computeProgress(p).get('parent')).toBe(73)
    p = setWeight(p, 'c1', 1)
    expect(computeProgress(p).get('parent')).toBe(80)
    p = removeNodeOnly(p, 'c1')
    expect(computeProgress(p).get('parent')).toBe(73)
    p = createChild(p, 'parent', 'new', '新孩子', { x: 900, y: 0 }, 0)
    expect(computeProgress(p).get('parent')).toBe(73)
    p = setWeight(p, 'parent', 1)
    expect(p.nodes[0].progress).toBe(73)
    expect(parseProject(serializeProject(p)).nodes[0].progress).toBe(73)
  })
  it('祖父使用带权子节点的回退值，忽略该子节点所有零权孩子的进度', () => {
    let p = family([1, 3], [25, 80])
    p = createChild(p, 'c0', 'zero', '零权孙', { x: 900, y: 0 }, 0)
    p = setManualProgress(p, 'zero', 99)
    const before = serializeProject(p)
    expect(computeProgress(p).get('c0')).toBe(25)
    expect(computeProgress(p).get('parent')).toBeCloseTo(66.25)
    expect(serializeProject(p)).toBe(before)
  })
})
