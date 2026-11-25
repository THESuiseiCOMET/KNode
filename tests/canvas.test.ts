import { setCollapsed, setViewViewport } from '../src/domain/views'
import { describe, it, expect } from 'vitest'
import { createProject, serializeProject, parseProject } from '../src/domain/model'
import { createRoot, createChild, moveNodes, computeProgress, reparent } from '../src/domain/forest'
import {
  copyNodes,
  pasteNodes,
  deleteNodes,
  patchNodes,
  hiddenIds,
  reveal,
  fuzzyMatch,
  connectorSides,
  materializeLegacyColors,
  nodeColors,
} from '../src/domain/canvas'
import { DEFAULT_NODE_COLOR } from '../src/domain/color'
import { CanvasHistory } from '../src/application/history'
function sample() {
  let p = createProject('阶段2', 'c0e631c4-9154-4478-b7af-a2d166e62a36')
  p = createRoot(p, 'a', '森林计划', { x: 0, y: 0 })
  p = createChild(p, 'a', 'b', '第一项', { x: 350, y: 0 })
  return createChild(p, 'b', 'c', '隐藏目标', { x: 700, y: 0 })
}
describe('阶段 2 模型交互', () => {
  it('复制明确选区保留内部关系，外部父成为根，新 ID 与粘贴空位', () => {
    const p = sample(),
      copied = copyNodes(p, ['b', 'c'])
    let i = 0
    const next = pasteNodes(p, copied, { x: 350, y: 0 }, () => `copy${++i}`)
    expect(next.nodes[3].parentId).toBeNull()
    expect(next.nodes[4].parentId).toBe('copy1')
    expect(next.views.tree.positions[next.nodes[3].id].y).toBeGreaterThan(0)
    expect(p.nodes).toHaveLength(3)
  })
  it('复制子树包含全部后代，普通复制不包含未选节点', () => {
    const p = sample()
    expect(copyNodes(p, ['a'])).toHaveLength(1)
    expect(copyNodes(p, ['a'], true)).toHaveLength(3)
  })
  it('折叠持久化，隐藏全部后代，搜索展开祖先不改坐标与进度', () => {
    const p = sample(),
      folded = setCollapsed(p, ['a', 'b'], true)
    expect([...hiddenIds(folded)].sort()).toEqual(['b', 'c'])
    const reopened = parseProject(serializeProject(folded))
    const result = reveal(reopened, 'c')
    expect(hiddenIds(result).size).toBe(0)
    expect(result.nodes.map((n) => result.views.tree.positions[n.id])).toEqual(
      p.nodes.map((n) => p.views.tree.positions[n.id]),
    )
    expect(computeProgress(result)).toEqual(computeProgress(p))
  })
  it('动态四边与滞后区域稳定，不改变方向语义', () => {
    expect(connectorSides({ x: 0, y: 0 }, { x: 400, y: 0 })).toEqual(['right', 'left'])
    expect(connectorSides({ x: 0, y: 0 }, { x: -400, y: 0 })).toEqual(['left', 'right'])
    expect(connectorSides({ x: 0, y: 0 }, { x: 0, y: 400 })).toEqual(['bottom', 'top'])
    expect(connectorSides({ x: 0, y: 0 }, { x: 0, y: -400 })).toEqual(['top', 'bottom'])
    expect(connectorSides({ x: 0, y: 0 }, { x: 240, y: 123 }, ['right', 'left'])).toEqual([
      'right',
      'left',
    ])
  })
  it('模糊匹配连续或非连续字符、忽略英文大小写', () => {
    expect(fuzzyMatch('Forest Editor', 'frEd')).toBe(true)
    expect(fuzzyMatch('隐藏的目标', '隐目')).toBe(true)
    expect(fuzzyMatch('森林', '林森')).toBe(false)
    expect(fuzzyMatch('森林', '')).toBe(false)
  })
  it('删除多选仅节点使直接孩子为根，子树删除不留悬空关系', () => {
    const p = sample()
    expect(deleteNodes(p, ['b'], false).nodes.find((n) => n.id === 'c')?.parentId).toBeNull()
    expect(deleteNodes(p, ['a', 'b'], true).nodes).toHaveLength(0)
  })
  it('新节点用默认色，父子改色、预览与嫁接互不影响', () => {
    const p = patchNodes(sample(), ['a'], { color: '#123456' })
    expect(nodeColors(p).get('c')).toBe(DEFAULT_NODE_COLOR)
    const next = patchNodes(p, ['b'], { color: '#abcdef' })
    expect([...nodeColors(reparent(next, 'c', 'a')).values()]).toEqual([
      '#123456',
      '#abcdef',
      DEFAULT_NODE_COLOR,
    ])
    expect([...nodeColors(next, { ids: ['a'], color: '#5070a0' }).values()]).toEqual([
      '#5070a0',
      '#abcdef',
      DEFAULT_NODE_COLOR,
    ])
    expect(createChild(next, 'a', 'd', '新节点', { x: 100, y: 100 }).nodes.at(-1)?.color).toBe(
      DEFAULT_NODE_COLOR,
    )
  })
  it('旧 V3 按原先显示的颜色补齐多层节点，保留 V3 数据且再次读取无需转换', () => {
    const p = createRoot(sample(), 'other', '未设色的根', { x: 100, y: 900 })
    p.nodes[0].color = '#123456'
    p.nodes[1].color = null
    p.nodes[2].color = null
    p.nodes[3].color = null
    const loaded = materializeLegacyColors(p)
    expect(loaded.version).toBe(3)
    expect(loaded.views).toBe(p.views)
    expect(loaded.nodes.map((n) => n.color)).toEqual([
      '#123456',
      '#123456',
      '#123456',
      DEFAULT_NODE_COLOR,
    ])
    expect(p.nodes[1].color).toBeNull()
    const saved = parseProject(serializeProject(patchNodes(loaded, ['a'], { color: '#5070a0' })))
    expect(materializeLegacyColors(saved)).toBe(saved)
    expect(saved.nodes.map((n) => n.color)).toEqual([
      '#5070a0',
      '#123456',
      '#123456',
      DEFAULT_NODE_COLOR,
    ])
  })
  it('一次批量拖动一步，删除撤销恢复全部字段；新命令分叉且视口不回退', () => {
    const p = sample(),
      history = new CanvasHistory()
    const moved = moveNodes(
      p,
      new Map([
        ['a', { x: 30, y: 40 }],
        ['b', { x: 380, y: 40 }],
      ]),
    )
    history.record(p, moved)
    expect(history.undo(moved).nodes).toEqual(p.nodes)
    expect(history.redo(p).nodes).toEqual(moved.nodes)
    const removed = deleteNodes(moved, ['b'], true)
    history.record(moved, removed)
    expect(history.undo(removed).nodes).toEqual(moved.nodes)
    history.record(moved, setCollapsed(moved, ['a'], true))
    expect(history.canRedo).toBe(false)
  })
  it('历史上限100，视口导航不占用历史、不被撤销覆盖', () => {
    let p = sample()
    const history = new CanvasHistory()
    for (let i = 0; i < 101; i++) {
      const next = moveNodes(p, new Map([['a', { x: i + 1, y: 0 }]]))
      history.record(p, next)
      p = next
    }
    for (let i = 0; i < 100; i++) p = history.undo(p)
    expect(p.views.tree.positions[p.nodes[0].id].x).toBe(1)
    expect(history.canUndo).toBe(false)
    const h = new CanvasHistory(),
      next = setCollapsed(p, ['a'], true)
    h.record(p, next)
    expect(
      h.undo(setViewViewport(next, 'tree', { x: 15, y: 20, zoom: 1.5 })).views.tree.viewport.zoom,
    ).toBe(1.5)
  })
})

it('连接方向按紧凑/展开卡片的实际中心及高度计算，不改节点坐标', () => {
  const from = { x: 0, y: 0 },
    to = { x: 200, y: 160 }
  expect(connectorSides(from, to, undefined, 152, 152)).toEqual(['bottom', 'top'])
  expect(connectorSides(from, to, undefined, 480, 152)).toEqual(['right', 'left'])
  expect(from).toEqual({ x: 0, y: 0 })
  expect(to).toEqual({ x: 200, y: 160 })
})
