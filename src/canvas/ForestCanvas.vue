<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useId,
  watch,
} from 'vue'
import {
  VueFlow,
  ConnectionMode,
  SelectionMode,
  useVueFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeDragEvent,
  type NodeMouseEvent,
  type EdgeMouseEvent,
  type EdgeUpdateEvent,
  type ViewportTransform,
} from '@vue-flow/core'
import ForestNodeView from './ForestNode.vue'
import { cardServices } from '../application/cardContext'
import { CARD_WIDTH, cardHeight } from '../domain/geometry'
import ForestEdge, { EDGE_ARROW_POINTS, EDGE_ARROW_TIP } from './ForestEdge.vue'
import { reserveCardSpace } from '../domain/cardSpacing'
import {
  alignedConnectorSides,
  isFacingTarget,
  layoutConnectorSides,
  type NodeBounds,
} from '../domain/connections'
import { offsetPort, routeGraphEdges, type GraphRoute } from '../domain/graphRouting'
import type { LayoutDirection } from '../domain/layout'
import { isTextMenuTarget } from '../ui/contextMenu'
import { previewProgress, type ProgressPreview } from '../domain/progress'
import { childIndex, computeProgress } from '../domain/forest'
import {
  connectorSides,
  hiddenIds,
  nodeColors,
  type ColorPreview,
  type Side,
} from '../domain/canvas'
import { DEFAULT_NODE_COLOR } from '../domain/color'
import type { GraphEdge, Point, ProjectDocument, ViewName } from '../domain/model'
const props = withDefaults(
  defineProps<{
    project: ProjectDocument
    view?: ViewName
    appliedTreeDirection?: LayoutDirection
    selectedId: string | null
    selectedIds?: string[]
    locked: boolean
    reduced?: boolean
    focusId?: string | null
    progressPreview?: ProgressPreview | null
    colorPreview?: ColorPreview | null
    foldAnimation?: boolean
  }>(),
  { foldAnimation: true, view: 'tree' },
)
const layout = computed(() => props.project.views[props.view])
const memberNodes = computed(() =>
  props.project.nodes.filter((n) => Object.hasOwn(layout.value.positions, n.id)),
)
const cardService = inject(cardServices, undefined)
const foldReduced = computed(() => !!props.reduced || props.foldAnimation === false)
const emit = defineEmits<{
  files: [id: string]
  select: [id: string | null]
  selection: [ids: string[]]
  move: [positions: Map<string, Point>]
  viewport: [viewport: ViewportTransform, view: ViewName]
  connect: [child: string, parent: string]
  graphConnect: [source: string, target: string, direction: GraphEdge['direction']]
  graphReconnect: [id: string, source: string, target: string]
  collapse: [id: string]
  progressStart: [id: string]
  progressPreview: [id: string, value: number]
  progressCommit: [id: string, value: number]
  progressCancel: [id: string]
  context: [
    menu: {
      x: number
      y: number
      point: Point
      nodeId: string | null
      edgeChild?: string
      graphEdgeId?: string
    },
  ]
}>()
const {
  screenToFlowCoordinate,
  setCenter,
  viewport,
  fitView,
  fitBounds,
  findNode,
  connectionStartHandle,
} = useVueFlow('forest')
const nodes = shallowRef<Node[]>([]),
  space = ref(false),
  fading = ref(new Set<string>()),
  highlighted = ref<string | null>(null)
const graphDragDirection = ref<'forward' | 'undirected' | null>(null)
const graphArrow = `knode-graph-arrow-${useId()}`
const graphArrowUrl = `url(#${graphArrow})`
const connectionLineOptions = computed(() =>
  graphDragDirection.value === 'forward' ? { style: { markerEnd: graphArrowUrl } } : {},
)
let fadeTimer: ReturnType<typeof setTimeout> | undefined,
  highlightTimer: ReturnType<typeof setTimeout> | undefined
const progressKey = computed(() =>
  JSON.stringify(props.project.nodes.map((n) => [n.id, n.parentId, n.progress, n.weight])),
)
const progress = shallowRef(new Map<string, number>())
watch(
  progressKey,
  () => {
    progress.value = computeProgress(props.project)
  },
  { immediate: true },
)
const displayProgress = computed(() =>
  props.progressPreview
    ? previewProgress(props.project, progress.value, props.progressPreview)
    : progress.value,
)
const children = computed(() => childIndex(props.project)),
  hidden = computed(() => (props.view === 'tree' ? hiddenIds(props.project) : new Set<string>())),
  colors = computed(() => nodeColors(props.project, props.colorPreview))
const counts = computed(() => {
  const result = new Map<string, number>(),
    stack = props.project.nodes
      .filter((n) => !n.parentId)
      .map((n) => [n.id, false] as [string, boolean])
  while (stack.length) {
    const [id, visited] = stack.pop()!
    const list = children.value.get(id) ?? []
    if (!visited) {
      stack.push([id, true])
      for (const n of list) stack.push([n.id, false])
    } else
      result.set(
        id,
        list.reduce((sum, n) => sum + 1 + (result.get(n.id) ?? 0), 0),
      )
  }
  return result
})
// Keep the space until the existing 225ms height animation has finished.
const closingPanels = shallowRef(new Set<string>())
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>()
let dragging = false
function dragStart() {
  dragging = true
}
function releasePanel(id: string) {
  if (dragging) {
    closeTimers.set(
      id,
      setTimeout(() => releasePanel(id), 50),
    )
    return
  }
  closeTimers.delete(id)
  const remaining = new Set(closingPanels.value)
  remaining.delete(id)
  closingPanels.value = remaining
}
const openPanels = computed(
  () => new Set(memberNodes.value.filter((n) => cardService?.ui(n.id).page).map((n) => n.id)),
)
const cardHeights = computed(
  () =>
    new Map(memberNodes.value.map((n) => [n.id, cardHeight(n.weight, openPanels.value.has(n.id))])),
)
watch(
  [openPanels, foldReduced, () => props.view],
  ([current, reduced, view], [previous, , oldView]) => {
    const memberIds = new Set(memberNodes.value.map((n) => n.id)),
      held = new Set(closingPanels.value)
    for (const [id, timer] of closeTimers) {
      if (reduced || view !== oldView || current.has(id) || !memberIds.has(id)) {
        clearTimeout(timer)
        closeTimers.delete(id)
        held.delete(id)
      }
    }
    if (!reduced && view === oldView)
      for (const id of previous) {
        if (!current.has(id) && memberIds.has(id) && !closeTimers.has(id)) {
          held.add(id)
          closeTimers.set(
            id,
            setTimeout(() => releasePanel(id), 225),
          )
        }
      }
    closingPanels.value = held
  },
  { flush: 'sync' },
)
const panelPositions = computed(() =>
  reserveCardSpace(
    memberNodes.value
      .filter((n) => !hidden.value.has(n.id))
      .map((n) => ({
        id: n.id,
        position: layout.value.positions[n.id],
        weight: n.weight,
        expanded: !!cardService?.ui(n.id).page || closingPanels.value.has(n.id),
      })),
  ),
)
const panelOrder = computed(() => memberNodes.value.map((n) => cardService?.ui(n.id).order ?? 0))
watch(
  [
    () => props.project,
    () => props.view,
    () => props.selectedIds,
    () => props.selectedId,
    () => foldReduced.value,
    highlighted,
    () => props.colorPreview,
    panelPositions,
    panelOrder,
    closingPanels,
  ],
  () => {
    const positions = layout.value.positions
    const old = new Map(nodes.value.map((n) => [n.id, n])),
      selected = new Set(props.selectedIds ?? (props.selectedId ? [props.selectedId] : []))
    const leaving = new Set(
      memberNodes.value.filter((n) => hidden.value.has(n.id) && old.has(n.id)).map((n) => n.id),
    )
    clearTimeout(fadeTimer)
    fading.value = foldReduced.value ? new Set() : leaving
    nodes.value = memberNodes.value
      .filter((n) => !hidden.value.has(n.id) || fading.value.has(n.id))
      .map((n) => ({
        id: n.id,
        type: 'forest',
        dragHandle: '.card-titlebar',
        zIndex:
          cardService?.ui(n.id).page || closingPanels.value.has(n.id)
            ? 1000 + (cardService?.ui(n.id).order ?? 0)
            : selected.has(n.id)
              ? 100
              : 0,
        style: {
          width: `${CARD_WIDTH}px`,
          '--fold-x': `${Math.sign((positions[n.parentId ?? '']?.x ?? positions[n.id].x) - positions[n.id].x) * 6}px`,
          '--fold-y': `${Math.sign((positions[n.parentId ?? '']?.y ?? positions[n.id].y) - positions[n.id].y) * 6}px`,
        },
        position: { ...(panelPositions.value[n.id] ?? positions[n.id]) },
        selected: selected.has(n.id) && !hidden.value.has(n.id),
        draggable: !hidden.value.has(n.id),
        class: hidden.value.has(n.id) ? 'fold-leaving' : old.has(n.id) ? '' : 'fold-entering',
        data: {
          title: n.title,
          weight: n.weight,
          progress: displayProgress.value.get(n.id) ?? n.progress,
          automatic: children.value.get(n.id)?.some((child) => child.weight > 0) ?? false,
          collapsed: props.view === 'tree' && props.project.views.tree.collapsedIds.includes(n.id),
          count: props.view === 'tree' ? (counts.value.get(n.id) ?? 0) : 0,
          color: colors.value.get(n.id),
          highlight: n.id === highlighted.value,
        },
      }))
    if (leaving.size)
      fadeTimer = setTimeout(
        () => {
          fading.value = new Set()
          nodes.value = nodes.value.filter((n) => !hidden.value.has(n.id))
        },
        foldReduced.value ? 0 : 225,
      )
  },
  { immediate: true },
)
watch(displayProgress, (values) => {
  nodes.value = nodes.value.map((n) =>
    n.data.progress === values.get(n.id)
      ? n
      : { ...n, data: { ...n.data, progress: values.get(n.id) } },
  )
})
const treeSides = new Map<string, [Side, Side]>()
const treeBranchSides = new Map<string, [Side, Side]>()
const nodeBounds = computed<Map<string, NodeBounds>>((previous) => {
  const next = new Map<string, NodeBounds>()
  let changed = previous?.size !== nodes.value.length
  for (const n of nodes.value) {
    const measured = findNode?.(n.id)?.dimensions
    const bounds = {
      ...n.position,
      width: measured?.width || CARD_WIDTH,
      height: measured?.height || cardHeights.value.get(n.id)!,
    }
    const old = previous?.get(n.id)
    changed ||=
      !old ||
      old.x !== bounds.x ||
      old.y !== bounds.y ||
      old.width !== bounds.width ||
      old.height !== bounds.height
    next.set(n.id, bounds)
  }
  return changed || !previous ? next : previous
})
const graphRoutes = computed<ReadonlyMap<string, GraphRoute>>((previous) =>
  routeGraphEdges(nodeBounds.value, props.project.views.graph.edges, previous),
)
const graphEdges = computed<Edge[]>(() => {
  return props.project.views.graph.edges.flatMap((edge) => {
    const route = graphRoutes.value.get(edge.id)
    if (!route) return []
    const color = colors.value.get(edge.source) ?? DEFAULT_NODE_COLOR
    const sourceOffset = offsetPort({ x: 0, y: 0 }, route.handles[0], route.offsets[0])
    const targetOffset = offsetPort({ x: 0, y: 0 }, route.handles[1], route.offsets[1])
    const domAttributes: NonNullable<Edge['domAttributes']> &
      Record<`data-graph-${string}`, number> = {
      'data-graph-source-x': sourceOffset.x,
      'data-graph-source-y': sourceOffset.y,
      'data-graph-target-x': targetOffset.x,
      'data-graph-target-y': targetOffset.y,
    }
    return [
      {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: route.handles[0],
        targetHandle: route.handles[1],
        type: 'forest',
        label: edge.label,
        data: {
          color,
          graphRoute: route,
          graphArrows: {
            start: edge.direction === 'both' ? graphArrowUrl : undefined,
            end: edge.direction !== 'undirected' ? graphArrowUrl : undefined,
          },
        },
        class: 'knode-graph-edge',
        domAttributes,
        updatable: true,
        selectable: false,
        interactionWidth: 12,
      },
    ]
  })
})
const treeEdges = computed<Edge[]>(() => {
  const bounds = nodeBounds.value
  const layoutSides = props.appliedTreeDirection && layoutConnectorSides[props.appliedTreeDirection]
  if (!layoutSides) {
    const links = props.project.nodes.flatMap(({ id, parentId }) =>
      parentId === null ? [] : [{ source: parentId, target: id }],
    )
    // Keep inferred ranks after moving a child in a previously saved arrangement.
    for (const [source, pair] of alignedConnectorSides(bounds, links))
      treeBranchSides.set(source, pair)
  }
  return props.project.nodes
    .filter((n) => n.parentId && bounds.has(n.id) && bounds.has(n.parentId))
    .map((n) => {
      const source = n.parentId!,
        from = bounds.get(source)!,
        to = bounds.get(n.id)!,
        preferred = layoutSides || treeBranchSides.get(source),
        aligned = !!preferred && isFacingTarget(from, to, preferred[0])
      const pair = aligned
        ? preferred
        : connectorSides(from, to, treeSides.get(n.id), from.height, to.height)
      treeSides.set(n.id, pair)
      return {
        id: `edge-${n.id}`,
        source,
        target: n.id,
        sourceHandle: pair[0],
        targetHandle: pair[1],
        type: 'forest',
        data: {
          color: colors.value.get(n.id) ?? DEFAULT_NODE_COLOR,
          aligned,
          midpointArrow: true,
        },
        updatable: 'target',
        selectable: false,
        interactionWidth: 12,
        class: hidden.value.has(n.id) ? 'fold-leaving' : '',
      }
    })
})
const edges = computed(() => (props.view === 'tree' ? treeEdges.value : graphEdges.value))
function nodeContext({ event, node }: NodeMouseEvent) {
  if (!(event instanceof MouseEvent) || isTextMenuTarget(event.target)) return
  event.preventDefault()
  if (props.locked) return
  emit('context', {
    x: event.clientX,
    y: event.clientY,
    point: { ...node.position },
    nodeId: node.id,
  })
}
function selectionContext({
  event,
  nodes: selected,
}: {
  event: MouseEvent
  nodes: NodeMouseEvent['node'][]
}) {
  event.preventDefault()
  event.stopPropagation()
  if (props.locked) return
  const members = selected.filter((node) => Object.hasOwn(layout.value.positions, node.id))
  const current = members.filter((node) => props.selectedIds?.includes(node.id))
  const candidates = current.length ? current : members
  const anchor = candidates.find((node) => node.id === props.selectedId) ?? candidates[0]
  if (!anchor) return paneContext(event)
  if (!current.length)
    emit(
      'selection',
      candidates.map((node) => node.id),
    )
  nodeContext({ event, node: anchor })
}
function paneContext(event: MouseEvent) {
  event.preventDefault()
  if (!props.locked)
    emit('context', {
      x: event.clientX,
      y: event.clientY,
      point: screenToFlowCoordinate({ x: event.clientX, y: event.clientY }),
      nodeId: null,
    })
}
function edgeContext({ event, edge }: EdgeMouseEvent) {
  event.preventDefault()
  if (event instanceof MouseEvent && !props.locked)
    emit('context', {
      x: event.clientX,
      y: event.clientY,
      point: screenToFlowCoordinate({ x: event.clientX, y: event.clientY }),
      nodeId: null,
      ...(props.view === 'tree' ? { edgeChild: edge.target } : { graphEdgeId: edge.id }),
    })
}
function dragStop(event: NodeDragEvent) {
  dragging = false
  if (props.locked) return
  const originals = new Map(Object.entries(panelPositions.value))
  const positions = new Map(
    event.nodes
      .filter((n) => {
        const old = originals.get(n.id)
        return old && (old.x !== n.position.x || old.y !== n.position.y)
      })
      .map((n) => [n.id, { ...n.position }]),
  )
  if (positions.size) emit('move', positions)
}
function startConnection({ event }: { event?: MouseEvent }) {
  if (props.view !== 'graph') return
  const reconnecting =
    event?.target instanceof Element && event.target.closest('.vue-flow__edgeupdater')
  graphDragDirection.value = reconnecting ? null : event?.altKey ? 'undirected' : 'forward'
}
function endConnection() {
  graphDragDirection.value = null
}
function connect(connection: Connection) {
  if (props.locked) return
  if (props.view === 'graph')
    emit(
      'graphConnect',
      connection.source,
      connection.target,
      graphDragDirection.value ?? 'forward',
    )
  else emit('connect', connection.target, connection.source)
}
// Dragging the child endpoint keeps the old child/subtree and assigns the drop node as its parent.
function reconnect({ edge, connection }: EdgeUpdateEvent) {
  if (props.locked) return
  if (props.view === 'graph') emit('graphReconnect', edge.id, connection.source, connection.target)
  else emit('connect', edge.target, connection.target)
}
function changes(list: NodeChange[]) {
  if (list.some((c) => c.type === 'select'))
    void nextTick(() =>
      emit(
        'selection',
        nodes.value
          .filter((n) => (n as Node & { selected?: boolean }).selected && !hidden.value.has(n.id))
          .map((n) => n.id),
      ),
    )
}
watch(
  () => props.focusId,
  async (id) => {
    if (!id) return
    await nextTick()
    const point = panelPositions.value[id]
    const height = cardHeights.value.get(id)
    if (point && height !== undefined) {
      highlighted.value = id
      await setCenter(point.x + CARD_WIDTH / 2, point.y + height / 2, {
        zoom: viewport.value.zoom,
        duration: props.reduced ? 0 : 225,
      })
      clearTimeout(highlightTimer)
      highlightTimer = setTimeout(() => {
        highlighted.value = null
      }, 1800)
    }
  },
)
function down(event: KeyboardEvent) {
  if (
    event.code === 'Space' &&
    !(
      event.target instanceof HTMLElement &&
      event.target.closest('input,textarea,select,button,[contenteditable],[role=slider]')
    )
  ) {
    event.preventDefault()
    space.value = true
  }
}
function up(event: KeyboardEvent) {
  if (event.code === 'Space') space.value = false
}
function blur() {
  space.value = false
}
onMounted(() => {
  window.addEventListener('keydown', down)
  window.addEventListener('keyup', up)
  window.addEventListener('blur', blur)
})
onBeforeUnmount(() => {
  clearTimeout(fadeTimer)
  for (const timer of closeTimers.values()) clearTimeout(timer)
  closeTimers.clear()
  clearTimeout(highlightTimer)
  window.removeEventListener('keydown', down)
  window.removeEventListener('keyup', up)
  window.removeEventListener('blur', blur)
})
function fit(ids?: readonly string[]) {
  const duration = props.reduced ? 0 : 225
  if (!ids) return fitView({ duration })
  // Use final panel geometry even while cards are opening or outside the viewport.
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity
  for (const id of ids) {
    const point = panelPositions.value[id]
    const height = cardHeights.value.get(id)
    if (!point || height === undefined) continue
    left = Math.min(left, point.x)
    top = Math.min(top, point.y)
    right = Math.max(right, point.x + CARD_WIDTH)
    bottom = Math.max(bottom, point.y + height)
  }
  if (left < Infinity)
    return fitBounds({ x: left, y: top, width: right - left, height: bottom - top }, { duration })
}
defineExpose({
  fit,
  center: () => screenToFlowCoordinate({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
  graphNodeSizes: () =>
    new Map(
      memberNodes.value.map((node) => {
        const measured = nodeBounds.value.get(node.id)
        const height = cardHeights.value.get(node.id)!
        // Expanded and weighted cards have a specified height. Compact unweighted cards size to content.
        return [
          node.id,
          {
            width: measured?.width ?? CARD_WIDTH,
            height:
              node.weight > 0 || openPanels.value.has(node.id) || closingPanels.value.has(node.id)
                ? height
                : (measured?.height ?? height),
          },
        ]
      }),
    ),
})
</script>
<template>
  <VueFlow
    :key="view"
    id="forest"
    v-model:nodes="nodes"
    :edges="edges"
    :class="{
      'reduce-motion': reduced,
      'static-folds': foldAnimation === false,
      'static-controls': foldAnimation === false,
    }"
    :default-viewport="layout.viewport"
    :min-zoom="0.2"
    :max-zoom="2.5"
    :elevate-nodes-on-select="false"
    :nodes-draggable="!locked && !space && !progressPreview"
    :node-drag-threshold="0"
    :nodes-connectable="!locked && !progressPreview"
    :connection-mode="ConnectionMode.Loose"
    :connection-line-options="view === 'graph' ? connectionLineOptions : undefined"
    :pan-on-drag="progressPreview ? false : space ? [0, 1] : [1]"
    :selection-key-code="space || progressPreview ? null : true"
    :selection-mode="SelectionMode.Partial"
    :multi-selection-key-code="['Control', 'Shift']"
    :delete-key-code="null"
    :zoom-on-double-click="false"
    :only-render-visible-elements="true"
    :fit-view-on-init="false"
    @nodes-change="changes"
    @node-context-menu="nodeContext"
    @pane-context-menu="paneContext"
    @edge-click="() => undefined"
    @edge-context-menu="edgeContext"
    @pane-click="emit('select', null)"
    @node-drag-start="dragStart"
    @selection-drag-start="dragStart"
    @node-drag-stop="dragStop"
    @selection-drag-stop="dragStop"
    @selection-context-menu="selectionContext"
    @connect-start="startConnection"
    @connect="connect"
    @connect-end="endConnection"
    @edge-update="reconnect"
    @move-end="emit('viewport', $event.flowTransform, view)"
  >
    <template #node-forest="nodeProps"
      ><ForestNodeView
        :id="nodeProps.id"
        :data="nodeProps.data"
        :selected="nodeProps.selected"
        :disabled="locked"
        :edge-drop-active="!!connectionStartHandle && connectionStartHandle.nodeId !== nodeProps.id"
        :graph-connect-hint="view === 'graph'"
        @progress-start="emit('progressStart', nodeProps.id)"
        @progress-preview="emit('progressPreview', nodeProps.id, $event)"
        @progress-commit="emit('progressCommit', nodeProps.id, $event)"
        @progress-cancel="emit('progressCancel', nodeProps.id)"
        @collapse="emit('collapse', nodeProps.id)"
    /></template>
    <template #edge-forest="edgeProps"><ForestEdge v-bind="edgeProps" /></template>
    <svg v-if="view === 'graph'" width="0" height="0" aria-hidden="true" style="position: absolute">
      <defs>
        <marker
          :id="graphArrow"
          viewBox="-6 -8 12 16"
          markerWidth="12"
          markerHeight="16"
          markerUnits="userSpaceOnUse"
          :refX="EDGE_ARROW_TIP"
          refY="0"
          orient="auto-start-reverse"
        >
          <polygon :points="EDGE_ARROW_POINTS" fill="context-stroke" />
        </marker>
      </defs>
    </svg>
  </VueFlow>
</template>
