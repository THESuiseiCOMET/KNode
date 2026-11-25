<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, inject, reactive } from 'vue'
import ProgressSlider from './ProgressSlider.vue'
import { Handle, Position } from '@vue-flow/core'
import { CARD_PROGRESS_HEIGHT, CARD_SECTION_GAP, CARD_WIDTH, cardHeight } from '../domain/geometry'
import { cardServices, type CardUI } from '../application/cardContext'
import NodeFiles from '../ui/NodeFiles.vue'
import NodeInspector from '../ui/NodeInspector.vue'
import Icon from '../ui/Icon.vue'
const props = defineProps<{
  id: string
  data: {
    title: string
    weight: number
    progress: number
    automatic: boolean
    collapsed: boolean
    count: number
    color: string
    highlight: boolean
  }
  selected: boolean
  disabled?: boolean
  edgeDropActive?: boolean
  graphConnectHint?: boolean
}>()
const service = inject(cardServices, undefined)
const ui = service?.ui(props.id) ?? reactive<CardUI>({ page: null })
function panel(page: CardUI['page']) {
  if (props.disabled || service?.locked) return
  ui.page = ui.page === page ? null : page
  if (ui.page) service?.bringForward(props.id)
}
const node = computed(() => service?.project?.nodes.find((n) => n.id === props.id))
const emit = defineEmits<{
  collapse: []
  progressStart: []
  progressPreview: [value: number]
  progressCommit: [value: number]
  progressCancel: []
}>()
const positions = [Position.Top, Position.Right, Position.Bottom, Position.Left]
function activateCard(event: PointerEvent) {
  if (event.button === 0 && ui.page) service?.bringForward(props.id)
}
function cardPointer(e: MouseEvent) {
  if (e.button !== 1) e.stopPropagation()
}
function key(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') return
  e.stopPropagation()
}
</script>
<template>
  <article
    class="forest-node integrated-card"
    @pointerdown.capture="activateCard"
    :class="{
      selected,
      'search-highlight': data.highlight,
      'panel-open': !!ui.page,
      'without-progress': data.weight === 0,
      'edge-drop-active': edgeDropActive,
    }"
    :style="{
      '--node-color': data.color,
      '--card-progress-height': `${CARD_PROGRESS_HEIGHT}px`,
      '--card-section-gap': `${CARD_SECTION_GAP}px`,
      width: `${CARD_WIDTH}px`,
      height: ui.page || data.weight > 0 ? `${cardHeight(data.weight, !!ui.page)}px` : undefined,
    }"
  >
    <Handle
      v-for="side in positions"
      :id="side"
      :key="side"
      type="source"
      :position="side"
      :title="
        t('从卡片边缘拖动连接') + (graphConnectHint ? ' · ' + t('按住 Alt 拖动可创建无向连线') : '')
      "
    />
    <header class="card-titlebar">
      <strong class="node-title" :title="data.title">{{ data.title }}</strong>
    </header>
    <div v-if="data.weight > 0" class="card-progress-slot">
      <ProgressSlider
        :value="data.progress"
        :title="data.title"
        :readonly="data.automatic"
        :disabled="disabled"
        :color="data.color"
        @start="emit('progressStart')"
        @preview="emit('progressPreview', $event)"
        @commit="emit('progressCommit', $event)"
        @cancel="emit('progressCancel')"
      />
    </div>
    <div
      v-if="ui"
      class="card-editor nodrag nopan"
      @pointerdown="cardPointer"
      @mousedown="cardPointer"
      @click.stop
      @dblclick.stop
      @keydown="key"
    >
      <nav class="card-tabs" :aria-label="t('节点页面')">
        <button
          v-if="data.count"
          class="collapse-toggle"
          :disabled="disabled || service?.locked"
          :aria-label="data.collapsed ? t('展开子树') : t('折叠子树')"
          :title="`${data.collapsed ? t('展开') : t('折叠')} ${data.count} ${t('个后代')}`"
          @click="emit('collapse')"
        >
          <Icon :name="data.collapsed ? 'right' : 'down'" />
        </button>
        <button
          :aria-label="t('文件')"
          :title="ui.page === 'files' ? t('收起文件面板') : t('打开文件面板')"
          :aria-pressed="ui.page === 'files'"
          :disabled="disabled || service?.locked"
          @click="panel('files')"
        >
          <Icon name="folder" />
        </button>
        <button
          :aria-label="t('属性')"
          :title="ui.page === 'properties' ? t('收起属性面板') : t('打开属性面板')"
          :aria-pressed="ui.page === 'properties'"
          :disabled="disabled || service?.locked"
          @click="panel('properties')"
        >
          <Icon name="sliders" />
        </button>
      </nav>
      <div
        v-if="ui.page && node"
        :key="ui.page"
        class="card-content"
        :aria-label="ui.page === 'files' ? t('节点文件面板') : t('节点属性面板')"
      >
        <NodeFiles
          v-if="ui.page === 'files'"
          :node-id="id"
          :token="service!.token"
          :linked-paths="node.linkedPaths ?? []"
          :disabled="service!.locked"
        /><NodeInspector v-else :node="node" :color="data.color" :disabled="service!.locked" />
      </div>
    </div>
  </article>
</template>
