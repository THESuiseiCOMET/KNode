<script lang="ts">
// Match the rendered size of the graph's enlarged SVG marker.
export const EDGE_ARROW_TIP = 4.95
export const EDGE_ARROW_POINTS = `${EDGE_ARROW_TIP},0 ${-EDGE_ARROW_TIP},-7.425 ${-EDGE_ARROW_TIP},7.425`
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { graphRoutePath, type GraphRoute } from '../domain/graphRouting'
import { theme } from '../application/theme'
import { BaseEdge, getBezierPath, type EdgeProps } from '@vue-flow/core'
const props = defineProps<
  EdgeProps<{
    color: string
    midpointArrow?: boolean
    graphRoute?: GraphRoute
    graphArrows?: { start?: string; end?: string }
    aligned?: boolean
  }>
>()
const lineColor = computed(() =>
  theme.value === 'dark'
    ? `color-mix(in srgb, ${props.data.color} 45%, #e0e2e6)`
    : props.data.color,
)
const path = computed(() =>
  props.data.graphRoute
    ? graphRoutePath(props.data.graphRoute)
    : getBezierPath({
        curvature: props.data.aligned ? 0.5 : 0.25,
        sourceX: props.sourceX,
        sourceY: props.sourceY,
        targetX: props.targetX,
        targetY: props.targetY,
        sourcePosition: props.sourcePosition,
        targetPosition: props.targetPosition,
      })[0],
)
const baseline = ref<InstanceType<typeof BaseEdge>>()
const arrowTransform = ref('')
watch(
  [path, () => baseline.value?.pathEl, () => props.data.midpointArrow],
  ([, edgePath, midpointArrow]) => {
    const length = midpointArrow ? (edgePath?.getTotalLength?.() ?? 0) : 0
    if (!edgePath || length <= 0) {
      arrowTransform.value = ''
      return
    }
    const midpoint = length / 2
    const center = edgePath.getPointAtLength(midpoint)
    const before = edgePath.getPointAtLength(Math.max(0, midpoint - 1))
    const after = edgePath.getPointAtLength(Math.min(length, midpoint + 1))
    const angle = Math.atan2(after.y - before.y, after.x - before.x) * (180 / Math.PI)
    arrowTransform.value = `translate(${center.x} ${center.y}) rotate(${angle})`
  },
  { flush: 'post' },
)
</script>
<template>
  <BaseEdge
    ref="baseline"
    :id="id"
    :path="path"
    :marker-start="data.graphArrows?.start ?? markerStart"
    :marker-end="data.graphArrows?.end ?? markerEnd"
    :interaction-width="interactionWidth ?? 12"
    :style="
      data.graphRoute
        ? { stroke: lineColor, opacity: 0.8 }
        : { stroke: lineColor, strokeOpacity: 0.8 }
    "
  />
  <polygon
    v-if="arrowTransform"
    class="tree-edge-arrow"
    :points="EDGE_ARROW_POINTS"
    :transform="arrowTransform"
    :fill="lineColor"
    fill-opacity="0.8"
    pointer-events="none"
    aria-hidden="true"
  />
</template>
<style>
.knode-graph-edge {
  --graph-source-x: attr(data-graph-source-x px, 0px);
  --graph-source-y: attr(data-graph-source-y px, 0px);
  --graph-target-x: attr(data-graph-target-x px, 0px);
  --graph-target-y: attr(data-graph-target-y px, 0px);
}
.knode-graph-edge .vue-flow__edgeupdater-source {
  translate: var(--graph-source-x) var(--graph-source-y);
}
.knode-graph-edge .vue-flow__edgeupdater-target {
  translate: var(--graph-target-x) var(--graph-target-y);
}
</style>
