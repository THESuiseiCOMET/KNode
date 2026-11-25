import { cardServices, type CardUI } from '../src/application/cardContext'
import { moveViewNodes } from '../src/domain/views'
import { addToGraph, addGraphEdge } from '../src/domain/views'
import { setCollapsed } from '../src/domain/views'
// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import ForestCanvas from '../src/canvas/ForestCanvas.vue'
import { createProject } from '../src/domain/model'
import { createRoot, createChild, setWeight, setManualProgress } from '../src/domain/forest'
import {
  calculateLayout,
  LAYOUT_DIRECTIONS,
  makeLayoutInput,
  type LayoutDirection,
} from '../src/domain/layout'
import type { Node } from '@vue-flow/core'
import type { GraphRoute } from '../src/domain/graphRouting'
const transport = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
  emit: undefined as undefined | ((event: string, ...args: any[]) => void),
}))
vi.mock('@vue-flow/core', async (original) => {
  const actual = await original<typeof import('@vue-flow/core')>()
  const { defineComponent, h, ref } = await import('vue')
  return {
    ...actual,
    VueFlow: defineComponent({
      props: ['nodes', 'edges', 'defaultViewport', 'elevateNodesOnSelect', 'connectionLineOptions'],
      setup(props, { emit }) {
        transport.emit = emit
        transport.props = props
        return () => h('div')
      },
    }),
    useVueFlow: () => ({
      screenToFlowCoordinate: (p: unknown) => p,
      setCenter: vi.fn(),
      viewport: ref({ x: 0, y: 0, zoom: 1 }),
      fitView: vi.fn(),
    }),
  }
})
let app: App | undefined, host: HTMLDivElement | undefined
let cardStates: Record<string, CardUI>
afterEach(() => {
  app?.unmount()
  host?.remove()
  vi.useRealTimers()
})
function mount(reduced = false, events: Record<string, unknown> = {}) {
  let project = createRoot(
    createProject('投影', 'c0e631c4-9154-4478-b7af-a2d166e62a36'),
    'root',
    '根',
    { x: 0, y: 0 },
  )
  project = createChild(project, 'root', 'child', '叶', { x: 400, y: 0 })
  const state = reactive({
    view: 'tree' as 'tree' | 'graph',
    appliedTreeDirection: undefined as LayoutDirection | undefined,
    project,
    selectedId: null as string | null,
    selectedIds: [] as string[],
    reduced,
    foldAnimation: true,
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({
    render: () => h(ForestCanvas, { ...state, ...events, locked: false }),
  })
  cardStates = reactive<Record<string, CardUI>>({})
  app.provide(cardServices, {
    token: 'projection-test',
    get project() {
      return state.project
    },
    locked: false,
    ui(id) {
      if (!cardStates[id]) cardStates[id] = { page: null, order: 0 }
      return cardStates[id]
    },
    bringForward(id) {
      cardStates[id].order = (cardStates[id].order ?? 0) + 1
    },
    async prepare() {},
    async operation(task) {
      return task()
    },
    attribute() {},
    links() {},
    previewColor() {},
    commitColor() {},
    cancelColor() {},
  })
  app.mount(host)
  return state
}
const edges = () =>
  transport.props!.edges as { class?: string; data: { midpointArrow?: boolean } }[]

it('图拖线在起点读取 Alt，预览随方向变化，松手后下一次恢复单向', async () => {
  const graph = vi.fn(),
    tree = vi.fn()
  const state = mount(true, { onGraphConnect: graph, onConnect: tree })
  const connection = { source: 'root', target: 'child' }
  state.view = 'graph'
  await nextTick()
  transport.emit!('connectStart', { event: new MouseEvent('mousedown', { altKey: true }) })
  await nextTick()
  expect(transport.props!.connectionLineOptions).toEqual({})
  transport.emit!('connect', connection)
  transport.emit!('connectEnd')
  expect(graph).toHaveBeenLastCalledWith('root', 'child', 'undirected')

  transport.emit!('connectStart', { event: new MouseEvent('mousedown') })
  await nextTick()
  expect(transport.props!.connectionLineOptions).toHaveProperty('style.markerEnd')
  transport.emit!('connect', connection)
  transport.emit!('connectEnd')
  expect(graph).toHaveBeenLastCalledWith('root', 'child', 'forward')

  state.view = 'tree'
  await nextTick()
  transport.emit!('connectStart', { event: new MouseEvent('mousedown', { altKey: true }) })
  transport.emit!('connect', connection)
  expect(tree).toHaveBeenCalledWith('child', 'root')
  expect(graph).toHaveBeenCalledTimes(2)
  expect(transport.props!.connectionLineOptions).toBeUndefined()
})
it('连线及静态箭头随折叠淡出，225ms 后移除边投影，原模型保留', async () => {
  vi.useFakeTimers()
  const state = mount()
  await nextTick()
  expect(edges()[0].data.midpointArrow).toBe(true)
  state.project = setCollapsed(state.project, ['root'], true)
  await nextTick()
  expect(edges()).toHaveLength(1)
  expect(edges()[0]).toMatchObject({ class: 'fold-leaving', data: { midpointArrow: true } })
  vi.advanceTimersByTime(225)
  await nextTick()
  expect(edges()).toHaveLength(0)
  expect(state.project.nodes).toHaveLength(2)
  expect(state.project.views.tree.positions.child).toEqual({ x: 400, y: 0 })
  state.project = setCollapsed(state.project, ['root'], false)
  await nextTick()
  expect(edges()[0].data.midpointArrow).toBe(true)
})
it('减少动画时折叠立即移除投影，展开状态仍有静态箭头', async () => {
  const state = mount(true)
  await nextTick()
  expect(edges()[0].data.midpointArrow).toBe(true)
  expect(state.project.nodes[1].parentId).toBe('root')
  state.project = setCollapsed(state.project, ['root'], true)
  await nextTick()
  expect(edges()).toHaveLength(0)
})

it('只在有带权子节点时将卡片设为自动，父自身权重0不改变计算模式', async () => {
  const state = mount()
  state.project = setWeight(setManualProgress(state.project, 'root', 73), 'root', 0)
  state.project = setWeight(setManualProgress(state.project, 'child', 40), 'child', 0)
  await nextTick()
  const nodes = () =>
    transport.props!.nodes as {
      id: string
      data: { automatic: boolean; progress: number; weight: number }
    }[]
  expect(nodes().find((n) => n.id === 'root')?.data).toMatchObject({
    automatic: false,
    progress: 73,
    weight: 0,
  })
  state.project = setWeight(state.project, 'child', 2)
  await nextTick()
  expect(nodes().find((n) => n.id === 'root')?.data).toMatchObject({
    automatic: true,
    progress: 40,
    weight: 0,
  })
  expect(state.project.nodes[0].progress).toBe(73)
})

it('外框宽度固定、高度由实际卡片测量和标题拖动区域，旧坐标保持；颜色预览不写项目', async () => {
  const state = mount()
  await nextTick()
  const nodes = transport.props!.nodes as {
    id: string
    style: { width: string; height: string }
    dragHandle: string
    position: { x: number; y: number }
  }[]
  expect(nodes.map((n) => [n.style.width, n.style.height, n.dragHandle])).toEqual([
    ['340px', undefined, '.card-titlebar'],
    ['340px', undefined, '.card-titlebar'],
  ])
  expect(nodes[1].position).toEqual({ x: 400, y: 0 })
  expect(state.project.views.tree.positions.child).toEqual({ x: 400, y: 0 })
})

it('中途关闭展开动画立即完成折叠，再展开时保留静态箭头', async () => {
  vi.useFakeTimers()
  const state = mount()
  state.project = setCollapsed(state.project, ['root'], true)
  await nextTick()
  expect(edges()).toHaveLength(1)
  state.foldAnimation = false
  await nextTick()
  expect(edges()).toHaveLength(0)
  state.project = setCollapsed(state.project, ['root'], false)
  await nextTick()
  expect(edges()[0].data.midpointArrow).toBe(true)
  expect(state.project.nodes[1].parentId).toBe('root')
})

it('Vue Flow框选层右键阻止默认菜单，保留隐藏选区并锚定到可见节点', async () => {
  const onContext = vi.fn(),
    onSelection = vi.fn()
  const state = mount(false, { onContext, onSelection })
  state.project = createChild(state.project, 'child', 'grandchild', '孙', { x: 800, y: 0 })
  state.project = setCollapsed(state.project, ['child'], true)
  state.selectedIds = ['root', 'child', 'grandchild']
  state.selectedId = 'child'
  await nextTick()
  const event = new MouseEvent('contextmenu', {
    clientX: 80,
    clientY: 100,
    bubbles: true,
    cancelable: true,
  })
  const nodes = transport.props!.nodes as { id: string; position: { x: number; y: number } }[]
  transport.emit!('selectionContextMenu', { event, nodes })
  await nextTick()
  expect(event.defaultPrevented).toBe(true)
  expect(onSelection).not.toHaveBeenCalled()
  expect(onContext).toHaveBeenCalledWith({
    nodeId: 'child',
    x: 80,
    y: 100,
    point: nodes[1].position,
  })
})

it('真实画布投影按视图取坐标、边和视口，图不受树折叠影响，连接事件不混用', async () => {
  const onGraphConnect = vi.fn(),
    onConnect = vi.fn(),
    onGraphReconnect = vi.fn(),
    onMove = vi.fn(),
    onContext = vi.fn()
  const state = mount(true, { onGraphConnect, onConnect, onGraphReconnect, onMove, onContext })
  state.project = addToGraph(addToGraph(state.project, 'root', { x: 1500, y: 600 }), 'child', {
    x: -800,
    y: -400,
  })
  state.project = addGraphEdge(state.project, {
    id: 'self',
    source: 'root',
    target: 'root',
    direction: 'both',
  })
  state.project = setCollapsed(state.project, ['root'], true)
  state.project.views.tree.viewport = { x: 12, y: 0, zoom: 0.6 }
  state.project.views.graph.viewport = { x: -90, y: 30, zoom: 1.8 }
  state.view = 'graph'
  await nextTick()
  expect(transport.props!.defaultViewport).toEqual({ x: -90, y: 30, zoom: 1.8 })
  const nodes = transport.props!.nodes as {
    id: string
    position: { x: number; y: number }
    data: { count: number }
  }[]
  expect(nodes).toHaveLength(2)
  expect(nodes.find((n) => n.id === 'root')!.position).toEqual({ x: 1500, y: 600 })
  expect(nodes.every((n) => n.data.count === 0)).toBe(true)
  const graphEdges = transport.props!.edges as {
    id: string
    source: string
    target: string
    data: { graphRoute: { loop?: number }; graphArrows: { start?: string; end?: string } }
  }[]
  expect(graphEdges).toHaveLength(1)
  expect(graphEdges[0]).toMatchObject({
    id: 'self',
    source: 'root',
    target: 'root',
    data: { graphRoute: { loop: 0 } },
  })
  expect(graphEdges[0].data.graphArrows.start).toMatch(/^url\(#knode-graph-arrow-/)
  expect(graphEdges[0].data.graphArrows.end).toBe(graphEdges[0].data.graphArrows.start)
  expect(edges()[0].data.midpointArrow).toBeUndefined()
  transport.emit!('connect', { source: 'root', target: 'root' })
  expect(onGraphConnect).toHaveBeenCalledWith('root', 'root', 'forward')
  expect(onConnect).not.toHaveBeenCalled()
  transport.emit!('edgeUpdate', {
    edge: graphEdges[0],
    connection: { source: 'child', target: 'root' },
  })
  expect(onGraphReconnect).toHaveBeenCalledWith('self', 'child', 'root')
  transport.emit!('nodeDragStop', { nodes: [{ id: 'root', position: { x: 1600, y: 600 } }] })
  expect(onMove).toHaveBeenCalledWith(new Map([['root', { x: 1600, y: 600 }]]))
  state.view = 'tree'
  await nextTick()
  expect(transport.props!.defaultViewport).toEqual({ x: 12, y: 0, zoom: 0.6 })
  expect(transport.props!.nodes as unknown[]).toHaveLength(1)
  expect(transport.props!.edges).toEqual([])
  expect(state.project.views.tree.positions.root).toEqual({ x: 0, y: 0 })
})

it('右键画布卡片控件打开节点菜单，文本输入保留系统菜单', async () => {
  const onContext = vi.fn()
  mount(true, { onContext })
  await nextTick()
  const node = (transport.props!.nodes as Node[])[0]
  for (const target of [document.createElement('input'), document.createElement('button')]) {
    const event = new MouseEvent('contextmenu', { clientX: 80, clientY: 100, cancelable: true })
    target.addEventListener('contextmenu', () =>
      transport.emit!('nodeContextMenu', { event, node }),
    )
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(target.tagName === 'BUTTON')
  }
  expect(onContext).toHaveBeenCalledExactlyOnceWith({
    x: 80,
    y: 100,
    point: node.position,
    nodeId: node.id,
  })
})

it('横向整理的大分支实际投影统一右出左入，不受节点上下距离影响；重开投影无需额外字段', async () => {
  const state = mount(true)
  state.project = createChild(state.project, 'root', 'far', '远处孩子', { x: 400, y: 2000 })
  state.project.views.tree.positions.child = { x: 400, y: -1800 }
  await nextTick()
  const projected = transport.props!.edges as {
    source: string
    sourceHandle: string
    targetHandle: string
    data: { aligned: boolean }
  }[]
  expect(projected).toHaveLength(2)
  expect(
    projected.every(
      (e) =>
        e.source === 'root' &&
        e.sourceHandle === 'right' &&
        e.targetHandle === 'left' &&
        e.data.aligned,
    ),
  ).toBe(true)
  state.project = JSON.parse(JSON.stringify(state.project))
  await nextTick()
  expect(
    (transport.props!.edges as typeof projected).every(
      (e) => e.sourceHandle === 'right' && e.targetHandle === 'left',
    ),
  ).toBe(true)
  state.project = moveViewNodes(state.project, 'tree', new Map([['far', { x: 420, y: 2100 }]]))
  await nextTick()
  expect(
    (transport.props!.edges as typeof projected).map((e) => [
      e.sourceHandle,
      e.targetHandle,
      e.data.aligned,
    ]),
  ).toEqual([
    ['right', 'left', true],
    ['right', 'left', true],
  ])
})

it.each(LAYOUT_DIRECTIONS)(
  '整理为 %s 后拖动单卡，其他树连线保留整理端口，只对越界边重新选边',
  async (direction) => {
    const state = mount(true)
    state.project = createChild(state.project, 'root', 'sibling', '兄弟', { x: 500, y: 500 })
    state.project = createChild(state.project, 'child', 'grandchild', '孙节点', { x: 900, y: 0 })
    const input = makeLayoutInput(state.project, 'tree', direction, new Set())
    const positions = calculateLayout(input)
    state.project = moveViewNodes(state.project, 'tree', new Map(Object.entries(positions)))
    state.appliedTreeDirection = direction
    await nextTick()
    const projected = () =>
      transport.props!.edges as {
        target: string
        sourceHandle: string
        targetHandle: string
        data: { aligned: boolean }
      }[]
    const side = { LR: 'right', RL: 'left', TB: 'bottom', BT: 'top' }[direction]
    const horizontal = direction === 'LR' || direction === 'RL'
    const forward = direction === 'LR' || direction === 'TB' ? 1 : -1
    expect(projected().every((e) => e.sourceHandle === side && e.data.aligned)).toBe(true)

    const { x, y } = positions.child
    const slightlyMoved = horizontal
      ? { x: x + forward * 10, y: y + 20 }
      : { x: x + 20, y: y + forward * 10 }
    const setLivePosition = async (position: { x: number; y: number }) => {
      transport.emit!(
        'update:nodes',
        (transport.props!.nodes as Node[]).map((n) => (n.id === 'child' ? { ...n, position } : n)),
      )
      await nextTick()
    }
    await setLivePosition(slightlyMoved)
    expect(projected().every((e) => e.sourceHandle === side && e.data.aligned)).toBe(true)
    const beyondParent = horizontal
      ? { x: positions.root.x - forward * 600, y }
      : { x, y: positions.root.y - forward * 600 }
    await setLivePosition(beyondParent)
    expect(projected().find((e) => e.target === 'child')?.data.aligned).toBe(false)
    expect(projected().find((e) => e.target === 'sibling')).toMatchObject({
      sourceHandle: side,
      data: { aligned: true },
    })
    state.project = moveViewNodes(state.project, 'tree', new Map([['child', beyondParent]]))
    await nextTick()
    expect(projected().find((e) => e.target === 'sibling')).toMatchObject({
      sourceHandle: side,
      data: { aligned: true },
    })
  },
)

it('图自动整理、实时拖动和尺寸变化都使用同一套路由', async () => {
  const state = mount(true)
  state.view = 'graph'
  state.project = addToGraph(addToGraph(state.project, 'root', { x: 40, y: 40 }), 'child', {
    x: 500,
    y: 40,
  })
  state.project = addGraphEdge(state.project, {
    id: 'link',
    source: 'root',
    target: 'child',
    direction: 'forward',
  })
  const projectedRoute = () =>
    (transport.props!.edges as { data: { graphRoute: GraphRoute } }[])[0].data.graphRoute
  await nextTick()
  const route = projectedRoute()
  expect(route.points.at(-1)?.x).toBe(500)

  transport.emit!('nodeDragStart')
  await nextTick()
  expect(projectedRoute()).toEqual(route)
  const position = { x: 680, y: 40 }
  const dragged = (transport.props!.nodes as Node[]).map((n) =>
    n.id === 'child' ? { ...n, position } : n,
  )
  transport.emit!('update:nodes', dragged)
  await nextTick()
  expect(projectedRoute().points.at(-1)?.x).toBe(position.x)
  transport.emit!('nodeDragStop', { nodes: dragged })
  state.project = moveViewNodes(state.project, 'graph', new Map([['child', position]]))
  await nextTick()
  expect(projectedRoute().points.at(-1)?.x).toBe(position.x)

  state.project = moveViewNodes(state.project, 'graph', new Map([['child', { x: 500, y: 40 }]]))
  await nextTick()
  expect(projectedRoute()).toEqual(route)
  state.project = setWeight(state.project, 'child', 0)
  await nextTick()
  expect(projectedRoute()).not.toEqual(route)
})

it('自环使用空闲转角，普通边保持既有端口；拖动后重新推导且不修改图关系', async () => {
  const state = mount(true)
  state.project = addToGraph(addToGraph(state.project, 'root', { x: 0, y: 0 }), 'child', {
    x: 500,
    y: 0,
  })
  state.project = addGraphEdge(state.project, {
    id: 'loop',
    source: 'root',
    target: 'root',
    direction: 'forward',
  })
  state.project = addGraphEdge(state.project, {
    id: 'branch',
    source: 'root',
    target: 'child',
    direction: 'forward',
  })
  const relations = JSON.stringify(state.project.views.graph.edges)
  state.view = 'graph'
  await nextTick()
  const edges = () =>
    transport.props!.edges as { id: string; sourceHandle: string; targetHandle: string }[]
  expect(edges().find((e) => e.id === 'branch')).toMatchObject({
    sourceHandle: 'right',
    targetHandle: 'left',
  })
  expect(edges().find((e) => e.id === 'loop')).toMatchObject({
    sourceHandle: 'left',
    targetHandle: 'top',
  })
  state.project = {
    ...state.project,
    views: {
      ...state.project.views,
      graph: {
        ...state.project.views.graph,
        positions: { root: { x: 0, y: 0 }, child: { x: -500, y: 0 } },
      },
    },
  }
  await nextTick()
  expect(edges().find((e) => e.id === 'loop')).toMatchObject({
    sourceHandle: 'right',
    targetHandle: 'top',
  })
  expect(JSON.stringify(state.project.views.graph.edges)).toBe(relations)
})

it('展开临时避让，切页不重复移动，收起和树图切换恢复；不产生位置命令或修改模型', async () => {
  const onMove = vi.fn(),
    state = mount(true, { onMove })
  state.project.views.tree.positions.child = { x: 0, y: 200 }
  state.project = addToGraph(addToGraph(state.project, 'root', { x: 800, y: 0 }), 'child', {
    x: 800,
    y: 220,
  })
  await nextTick()
  const before = JSON.stringify(state.project)
  const nodes = () =>
    transport.props!.nodes as { id: string; position: { x: number; y: number }; zIndex: number }[]
  const position = (id: string) => nodes().find((n) => n.id === id)!.position
  cardStates.root.page = 'files'
  cardStates.root.order = 1
  await nextTick()
  expect(position('child')).toEqual({ x: 0, y: 504 })
  expect(transport.props!.elevateNodesOnSelect).toBe(false)
  expect(nodes().find((n) => n.id === 'root')!.zIndex).toBeGreaterThan(100)
  cardStates.root.page = 'properties'
  await nextTick()
  expect(position('child').y).toBe(504)
  state.view = 'graph'
  await nextTick()
  expect(position('child')).toEqual({ x: 800, y: 504 })
  cardStates.root.page = null
  await nextTick()
  expect(position('child')).toEqual({ x: 800, y: 220 })
  state.view = 'tree'
  await nextTick()
  expect(position('child')).toEqual({ x: 0, y: 200 })
  expect(onMove).not.toHaveBeenCalled()
  expect(JSON.stringify(state.project)).toBe(before)
})

it('避让坐标不能被当成用户移动；手动拖到空位才提交，收起保留拖动位置', async () => {
  const onMove = vi.fn(),
    state = mount(true, { onMove })
  state.project.views.tree.positions.child = { x: 0, y: 200 }
  await nextTick()
  cardStates.root.page = 'properties'
  await nextTick()
  transport.emit!('nodeDragStop', { nodes: [{ id: 'child', position: { x: 0, y: 504 } }] })
  expect(onMove).not.toHaveBeenCalled()
  transport.emit!('nodeDragStop', { nodes: [{ id: 'child', position: { x: 500, y: 650 } }] })
  expect(onMove).toHaveBeenCalledWith(new Map([['child', { x: 500, y: 650 }]]))
  state.project = moveViewNodes(state.project, 'tree', onMove.mock.calls[0][0])
  cardStates.root.page = null
  await nextTick()
  expect(state.project.views.tree.positions.child).toEqual({ x: 500, y: 650 })
  expect((transport.props!.nodes as any[]).find((n) => n.id === 'child').position).toEqual({
    x: 500,
    y: 650,
  })
})

it('收起等225ms高度动画完成才撤回避让，快速重开不跳回；减少动画立即恢复', async () => {
  vi.useFakeTimers()
  const state = mount(false)
  state.project.views.tree.positions.child = { x: 0, y: 200 }
  await nextTick()
  const childY = () => (transport.props!.nodes as any[]).find((n) => n.id === 'child').position.y
  cardStates.root.page = 'files'
  await nextTick()
  expect(childY()).toBe(504)
  cardStates.root.page = null
  await nextTick()
  vi.advanceTimersByTime(224)
  await nextTick()
  expect(childY()).toBe(504)
  cardStates.root.page = 'properties'
  await nextTick()
  vi.advanceTimersByTime(100)
  await nextTick()
  expect(childY()).toBe(504)
  cardStates.root.page = null
  await nextTick()
  vi.advanceTimersByTime(225)
  await nextTick()
  expect(childY()).toBe(200)
  cardStates.root.page = 'files'
  await nextTick()
  state.reduced = true
  cardStates.root.page = null
  await nextTick()
  expect(childY()).toBe(200)
})

it('收起期间手动拖动不会被回弹打断，拖动结束后才释放临时空间', async () => {
  vi.useFakeTimers()
  const state = mount(false)
  state.project.views.tree.positions.child = { x: 0, y: 200 }
  await nextTick()
  cardStates.root.page = 'files'
  await nextTick()
  cardStates.root.page = null
  await nextTick()
  transport.emit!('nodeDragStart', {})
  vi.advanceTimersByTime(300)
  await nextTick()
  expect((transport.props!.nodes as any[]).find((n) => n.id === 'child').position.y).toBe(504)
  transport.emit!('nodeDragStop', { nodes: [{ id: 'child', position: { x: 0, y: 504 } }] })
  vi.advanceTimersByTime(50)
  await nextTick()
  expect((transport.props!.nodes as any[]).find((n) => n.id === 'child').position.y).toBe(200)
})
