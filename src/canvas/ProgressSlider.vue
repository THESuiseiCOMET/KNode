<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { keyboardProgress, pointerProgress } from '../domain/progress'
const props = defineProps<{
  value: number
  title: string
  readonly: boolean
  disabled?: boolean
  color: string
}>()
const emit = defineEmits<{
  start: []
  preview: [value: number]
  commit: [value: number]
  cancel: []
}>()
const rail = ref<HTMLElement>()
const slider = ref<HTMLElement>(),
  pointer = ref<number | null>(null),
  draft = ref(props.value)
const display = computed(() => (pointer.value === null ? props.value : draft.value))
function update(event: PointerEvent): void {
  const rect = rail.value!.getBoundingClientRect()
  draft.value = pointerProgress(event.clientX, rect.left, rect.width)
  emit('preview', draft.value)
}
function cardPointer(e: MouseEvent) {
  if (e.button !== 1) e.stopPropagation()
}
function begin(e: PointerEvent) {
  if (e.button === 1) return
  e.stopPropagation()
  e.preventDefault()
  down(e)
}
function down(event: PointerEvent): void {
  if (props.readonly || props.disabled || event.button !== 0 || pointer.value !== null) return
  pointer.value = event.pointerId
  slider.value?.focus({ preventScroll: true })
  slider.value?.setPointerCapture?.(event.pointerId)
  emit('start')
  update(event)
}
function move(event: PointerEvent): void {
  if (pointer.value === event.pointerId) update(event)
}
function up(event: PointerEvent): void {
  if (pointer.value !== event.pointerId) return
  update(event)
  pointer.value = null
  emit('commit', draft.value)
  slider.value?.releasePointerCapture?.(event.pointerId)
}
function cancel(): void {
  if (pointer.value === null) return
  const id = pointer.value
  pointer.value = null
  emit('cancel')
  if (slider.value?.hasPointerCapture?.(id)) slider.value.releasePointerCapture(id)
}
function key(event: KeyboardEvent): void {
  if (event.key === 'Escape' && pointer.value !== null) {
    event.preventDefault()
    event.stopPropagation()
    cancel()
    return
  }
  if (props.readonly || props.disabled || pointer.value !== null || event.ctrlKey || event.metaKey)
    return
  const value = keyboardProgress(props.value, event.key)
  if (value !== null || event.code === 'Space') {
    event.preventDefault()
    event.stopPropagation()
  }
  if (value !== null) emit('commit', value)
}
watch(
  () => props.disabled,
  (value) => {
    if (value) cancel()
  },
)
onMounted(() => window.addEventListener('blur', cancel))
onBeforeUnmount(() => {
  cancel()
  window.removeEventListener('blur', cancel)
})
</script>
<template>
  <div class="node-progress slider-row">
    <div
      ref="slider"
      class="progress-slider capsule-control nodrag nopan nowheel"
      :class="{ readonly, disabled }"
      :role="readonly ? 'progressbar' : 'slider'"
      :tabindex="readonly || disabled ? -1 : 0"
      :aria-label="`${title}，${readonly ? t('自动进度，只读') : t('调整进度')}`"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="display"
      :aria-valuetext="`${Math.round(display)}%`"
      :aria-disabled="disabled || undefined"
      :title="
        readonly
          ? t('有效进度由带权子节点自动计算')
          : t('拖动调整进度；方向键 ±1%，PageUp/PageDown ±10%，Home/End 设为 0/100%')
      "
      @pointerdown="begin"
      @pointermove.stop.prevent="move"
      @pointerup.stop.prevent="up"
      @pointercancel.stop="cancel"
      @lostpointercapture="cancel"
      @mousedown="cardPointer"
      @touchstart.stop
      @click.stop
      @dblclick.stop
      @keydown="key"
    >
      <span ref="rail" class="capsule-rail" aria-hidden="true"
        ><span class="capsule-fill" :style="{ width: `${display}%` }" />
        <span
          v-if="!readonly"
          class="progress-thumb capsule-thumb"
          :style="{ left: `${display}%` }"
      /></span>
    </div>
    <b :title="`${display.toFixed(4)}%`">{{ Math.round(display) }}<small>%</small></b>
  </div>
</template>
