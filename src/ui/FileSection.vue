<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { FileTarget } from '../adapters/fileActions'
import Icon from './Icon.vue'
import { contentWheel } from './contentWheel'
export interface CardFileRow {
  key: string
  name: string
  depth: number
  isDirectory: boolean
  expanded?: boolean
  target: FileTarget
  status?: string
  message?: string
  root?: boolean
}
const props = defineProps<{
  title: string
  external?: boolean
  rows: CardFileRow[]
  disabled: boolean
  loading?: boolean
  message?: string
  error?: string
}>()
const emit = defineEmits<{
  action: [action: 'txt' | 'md' | 'file' | 'folder']
  select: [row: CardFileRow]
  activate: [row: CardFileRow]
  menu: [event: MouseEvent, row: CardFileRow]
  refresh: []
}>()
function actionLabel(action: string) {
  return t(
    action === 'txt'
      ? props.external
        ? '新建外部 TXT 文件'
        : '新建内部 TXT 文件'
      : action === 'md'
        ? props.external
          ? '新建外部 Markdown 文件'
          : '新建内部 Markdown 文件'
        : action === 'file'
          ? props.external
            ? '关联已有文件'
            : '复制导入文件'
          : props.external
            ? '关联已有文件夹'
            : '复制导入文件夹',
  )
}
const selected = ref(''),
  list = ref<HTMLElement>(),
  scroll = ref(0),
  height = ref(180)
const rowHeight = 27
const windowed = computed(() => props.rows.length > 100)
const count = computed(() => Math.ceil(height.value / rowHeight) + 16)
const start = computed(() =>
  windowed.value
    ? Math.max(
        0,
        Math.min(props.rows.length - count.value, Math.floor(scroll.value / rowHeight) - 8),
      )
    : 0,
)
const visible = computed(() =>
  windowed.value ? props.rows.slice(start.value, start.value + count.value) : props.rows,
)
const after = computed(() =>
  windowed.value
    ? Math.max(0, props.rows.length - start.value - visible.value.length) * rowHeight
    : 0,
)
let observer: ResizeObserver | undefined
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      height.value = list.value?.clientHeight || 180
    })
    if (list.value) observer.observe(list.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
watch(
  () => props.rows,
  () => {
    const max = Math.max(0, props.rows.length * rowHeight - height.value)
    if (scroll.value > max) {
      scroll.value = max
      if (list.value) list.value.scrollTop = max
    }
  },
)
async function navigate(event: KeyboardEvent, row: CardFileRow) {
  const index = props.rows.findIndex((r) => r.key === row.key)
  const to =
    event.key === 'ArrowDown'
      ? index + 1
      : event.key === 'ArrowUp'
        ? index - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? props.rows.length - 1
            : null
  if (to === null) return
  event.preventDefault()
  const target = props.rows[Math.max(0, Math.min(props.rows.length - 1, to))]
  if (!target) return
  if (list.value) {
    list.value.scrollTop = Math.max(0, to * rowHeight - 40)
    scroll.value = list.value.scrollTop
  }
  select(target)
  await nextTick()
  list.value?.querySelectorAll<HTMLButtonElement>('[role=treeitem]').forEach((el) => {
    if (el.dataset.key === target.key) el.focus({ preventScroll: true })
  })
}
function select(row: CardFileRow) {
  selected.value = row.key
  emit('select', row)
}
function clickRow(row: CardFileRow) {
  select(row)
  // Every click toggles: click detail is a repetition count, not permission to ignore input.
  if (row.isDirectory) emit('activate', row)
}
function doubleRow(row: CardFileRow) {
  if (!row.isDirectory) emit('activate', row)
}
function showMenu(e: MouseEvent, row: CardFileRow) {
  select(row)
  emit('menu', e, row)
}
const actions = [
  ['file-text', 'txt'],
  ['file-code', 'md'],
  ['file-plus', 'file'],
  ['folder-plus', 'folder'],
] as const
</script>
<template>
  <section class="card-file-section" :aria-label="title">
    <header class="file-section-heading">
      <b class="file-section-title">{{ title }}</b>
      <div class="section-tools">
        <button
          v-for="[icon, action] in actions"
          :key="action"
          class="card-icon"
          :disabled="disabled"
          :title="actionLabel(action)"
          :aria-label="actionLabel(action)"
          @click="emit('action', action)"
        >
          <Icon :name="icon" />
        </button>
      </div>
    </header>
    <div
      ref="list"
      class="section-list"
      @scroll="scroll = ($event.target as HTMLElement).scrollTop"
      @wheel="contentWheel"
    >
      <p v-if="loading" class="card-file-status" role="status">{{ t('正在读取…') }}</p>
      <p v-if="message" class="card-file-status" role="status">{{ message }}</p>
      <p v-if="error" class="card-file-status error" role="alert">
        {{ error }} <button @click="emit('refresh')">{{ t('重试') }}</button>
      </p>
      <ul :aria-label="title + t('树')" role="tree">
        <li
          v-if="start"
          role="none"
          aria-hidden="true"
          :style="{ height: `${start * rowHeight}px` }"
        />
        <li v-for="row in visible" :key="row.key" role="none">
          <button
            role="treeitem"
            :data-key="row.key"
            :aria-level="row.depth + 1"
            @keydown="navigate($event, row)"
            class="card-file-row"
            :class="{ active: selected === row.key, invalid: row.status && row.status !== 'ok' }"
            :style="{ paddingLeft: `${4 + row.depth * 13}px` }"
            :aria-selected="selected === row.key"
            :aria-expanded="row.isDirectory ? row.expanded : undefined"
            :title="row.message || row.name"
            :disabled="disabled"
            @click="clickRow(row)"
            @dblclick.prevent="doubleRow(row)"
            @keydown.enter.prevent="emit('activate', row)"
            @contextmenu.prevent.stop="showMenu($event, row)"
          >
            <Icon v-if="row.isDirectory" :name="row.expanded ? 'down' : 'right'" /><Icon
              v-else
              name="file-text"
            /><span>{{ row.name }}</span
            ><small v-if="row.status && !['ok', 'loading'].includes(row.status)">{{
              t('失效')
            }}</small>
          </button>
        </li>
        <li v-if="after" role="none" aria-hidden="true" :style="{ height: `${after}px` }" />
      </ul>
    </div>
  </section>
</template>
