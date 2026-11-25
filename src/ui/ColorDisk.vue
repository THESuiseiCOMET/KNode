<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { colorSlots, saveColorSlot } from '../application/colorSlots'
import { diskHS, hexToHsv, hsvToHex, type HSV } from '../domain/color'
import { suppressBrowserMenu } from './contextMenu'
const props = defineProps<{ value: string; disabled: boolean }>()
const emit = defineEmits<{ preview: [color: string]; commit: [color: string]; cancel: [] }>()
const hsv = ref(hexToHsv(props.value)),
  disk = ref<HTMLElement>(),
  pointer = ref<number | null>(null),
  previewStart = shallowRef<HSV | null>(null)
const selectedSlot = ref<number | null>(null)
const paletteError = ref('')
function rememberSlot(c: string) {
  if (selectedSlot.value !== null)
    paletteError.value = saveColorSlot(selectedSlot.value, c)
      ? ''
      : '自定义色槽无法保存到本机；节点颜色仍按项目保存。'
}
const color = computed(() => hsvToHex(hsv.value))
watch(
  () => props.value,
  (value) => {
    if (pointer.value === null) {
      // A preview echoed as hex loses hue and saturation at black.
      if (value.toLowerCase() !== color.value) hsv.value = hexToHsv(value)
    }
  },
)
const marker = computed(() => ({
  left: `${50 + 50 * hsv.value.s * Math.cos((hsv.value.h * Math.PI) / 180)}%`,
  top: `${50 + 50 * hsv.value.s * Math.sin((hsv.value.h * Math.PI) / 180)}%`,
}))
function preview() {
  emit('preview', color.value)
}
function update(event: PointerEvent) {
  previewStart.value ??= { ...hsv.value }
  const r = disk.value!.getBoundingClientRect()
  Object.assign(
    hsv.value,
    diskHS(
      (event.clientX - r.left - r.width / 2) / (r.width / 2),
      (event.clientY - r.top - r.height / 2) / (r.height / 2),
    ),
  )
  preview()
}
function down(e: PointerEvent) {
  if (props.disabled || e.button !== 0) return
  e.preventDefault()
  pointer.value = e.pointerId
  disk.value?.setPointerCapture?.(e.pointerId)
  update(e)
}
function up(e: PointerEvent) {
  if (pointer.value !== e.pointerId) return
  update(e)
  pointer.value = null
  commit()
}
function commit() {
  previewStart.value = null
  rememberSlot(color.value)
  emit('commit', color.value)
}
function cancel() {
  if (previewStart.value) {
    pointer.value = null
    hsv.value = previewStart.value
    previewStart.value = null
    emit('cancel')
  }
}
function selectSlot(index: number) {
  selectedSlot.value = index
  hsv.value = hexToHsv(colorSlots.value[index])
  commit()
}
function valueInput(e: Event) {
  previewStart.value ??= { ...hsv.value }
  hsv.value.v = Number((e.target as HTMLInputElement).value) / 100
  preview()
}
onMounted(() => window.addEventListener('blur', cancel))
onBeforeUnmount(() => {
  cancel()
  window.removeEventListener('blur', cancel)
})
</script>
<template>
  <section class="color-control" @contextmenu.stop="suppressBrowserMenu">
    <div class="color-heading">
      <span class="color-label">{{ t('节点颜色') }}</span>
      <span class="color-hex">{{ color }}</span>
      <span class="color-swatch" :style="{ background: color }" aria-hidden="true" />
    </div>
    <div class="color-body">
      <div
        ref="disk"
        class="hsv-disk"
        role="group"
        :aria-label="t('HSV 色相饱和度圆盘')"
        @pointerdown="down"
        @pointermove.prevent="pointer === $event.pointerId && update($event)"
        @pointerup.prevent="up"
        @pointercancel="cancel"
        @lostpointercapture="cancel"
        @keydown.esc.prevent="cancel"
      >
        <div class="disk-paint" :style="{ filter: `brightness(${hsv.v})` }" />
        <i :style="marker" />
      </div>
      <div class="color-side">
        <div class="color-presets">
          <button
            v-for="(p, index) in colorSlots"
            :key="index"
            :title="`${t('色槽')} ${index + 1}: ${selectedSlot === index ? color : p}`"
            :aria-label="`${t('预设颜色')} ${p}`"
            :aria-pressed="selectedSlot === index"
            :disabled="disabled"
            :style="{ background: selectedSlot === index && previewStart ? color : p }"
            @click="selectSlot(index)"
          />
        </div>
      </div>
    </div>
    <div class="color-value-row slider-row">
      <div
        class="brightness-control capsule-control nodrag nopan nowheel"
        :style="{ '--brightness-color': hsvToHex({ ...hsv, v: 1 }) }"
      >
        <span class="capsule-rail brightness-rail" aria-hidden="true" />
        <input
          type="range"
          :style="{ '--brightness-color': hsvToHex({ ...hsv, v: 1 }) }"
          :aria-label="t('颜色明度')"
          min="0"
          max="100"
          :value="hsv.v * 100"
          :disabled="disabled"
          @input="valueInput"
          @change="commit"
          @pointercancel="cancel"
        />
      </div>
    </div>
    <span v-if="paletteError" class="palette-error" role="alert">{{ paletteError }}</span>
  </section>
</template>
