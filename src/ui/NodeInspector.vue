<script setup lang="ts">
import { t } from '../application/i18n'
import { inject, ref, watch } from 'vue'
import type { ForestNode } from '../domain/model'
import { cardServices } from '../application/cardContext'
import ColorDisk from './ColorDisk.vue'
import { contentWheel } from './contentWheel'
const props = defineProps<{ node: ForestNode; color: string; disabled: boolean }>()
const service = inject(cardServices)!
const title = ref(props.node.title),
  weight = ref(props.node.weight)
watch(
  () => props.node.title,
  (v) => (title.value = v),
)
watch(
  () => props.node.weight,
  (v) => (weight.value = v),
)
function changeTitle() {
  service.attribute(props.node.id, { title: title.value })
  title.value = props.node.title
}
function setWeight() {
  service.attribute(props.node.id, {
    weight: Math.max(0, Math.min(10, Math.round(Number(weight.value)))),
  })
  weight.value = props.node.weight
}
</script>
<template>
  <section class="card-properties nodrag nopan" @wheel="contentWheel" :aria-label="t('节点属性')">
    <label
      >{{ t('节点名称')
      }}<input
        v-model="title"
        maxlength="200"
        :disabled="disabled"
        @change="changeTitle"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
    /></label>
    <label
      >{{ t('节点权重') }}
      <div class="weight-editor slider-row">
        <div class="weight-control capsule-control nodrag nopan nowheel">
          <span class="capsule-rail" aria-hidden="true"
            ><span class="capsule-fill" :style="{ width: `${weight * 10}%` }"
          /></span>
          <input
            type="range"
            min="0"
            max="10"
            step="1"
            :aria-label="t('节点权重')"
            v-model.number="weight"
            :style="{ '--range-fill': `${weight * 10}%` }"
            :disabled="disabled"
            @change="setWeight"
          />
          <span class="weight-ticks" aria-hidden="true"><i v-for="tick in 11" :key="tick" /></span>
        </div>
        <b class="weight-value" aria-live="polite">{{ weight }}</b>
      </div></label
    >
    <ColorDisk
      :value="color"
      :disabled="disabled"
      @preview="service.previewColor(node.id, $event)"
      @commit="service.commitColor(node.id, $event)"
      @cancel="service.cancelColor()"
    />
  </section>
</template>
