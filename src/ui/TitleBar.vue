<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, LayoutDashboard } from 'lucide-vue-next'
import Icon from './Icon.vue'
import type { LayoutDirection } from '../domain/layout'
import type { ViewName } from '../domain/model'
import { t } from '../application/i18n'
import { theme, toggleTheme } from '../application/theme'
import brandIcon from '../../src-tauri/icons/32x32.png'
import { desktopWindow } from '../adapters/window'
const props = defineProps<{
  projectName?: string
  directory: string | null
  dirty: boolean
  desktop: boolean
  query?: string
  searchOpen?: boolean
  results?: { id: string; title: string }[]
  hasProject?: boolean
  view?: ViewName
  viewLocked?: boolean
  layoutDirection?: LayoutDirection
  arranging?: boolean
  arrangeDisabled?: boolean
  canUndo?: boolean
  canRedo?: boolean
  locked?: boolean
}>()
const emit = defineEmits<{
  query: [value: string]
  search: [open: boolean]
  find: [id: string]
  undo: []
  redo: []
  settings: []
  view: [view: ViewName]
  layoutDirection: [direction: LayoutDirection]
  arrange: []
  menu: []
  openFolder: []
  copyPath: []
  error: [error: unknown]
}>()
const directionLabels: Record<LayoutDirection, string> = {
  TB: '从上到下',
  BT: '从下到上',
  LR: '从左到右',
  RL: '从右到左',
}
const directionOrder: readonly LayoutDirection[] = ['LR', 'TB', 'RL', 'BT']
const directionIcons = { LR: ArrowRight, TB: ArrowDown, RL: ArrowLeft, BT: ArrowUp }
const direction = computed(() => props.layoutDirection ?? 'TB')
const directionTooltip = computed(() =>
  t('布局方向：{direction} · 点击切换').replace('{direction}', t(directionLabels[direction.value])),
)
function cycleDirection() {
  const index = directionOrder.indexOf(direction.value)
  emit('layoutDirection', directionOrder[(index + 1) % directionOrder.length])
}
const maximized = ref(false),
  pathMenu = ref(false)
let off: (() => void) | undefined,
  disposed = false
async function control(action: () => Promise<void>) {
  try {
    await action()
  } catch (e) {
    emit('error', e)
  }
}
function pathAction(action: 'copyPath' | 'openFolder') {
  pathMenu.value = false
  if (action === 'copyPath') emit('copyPath')
  else emit('openFolder')
}
function dismissMenus() {
  pathMenu.value = false
}
function dismiss(event: PointerEvent) {
  if (!(event.target instanceof Element) || !event.target.closest('.title-search,.search-trigger'))
    emit('search', false)
  if (!(event.target instanceof Element) || !event.target.closest('.project-location'))
    pathMenu.value = false
}
onMounted(async () => {
  window.addEventListener('pointerdown', dismiss)
  if (!props.desktop) return
  try {
    const stop = await desktopWindow.watchMaximized((value) => (maximized.value = value))
    if (disposed) stop()
    else off = stop
  } catch (e) {
    emit('error', e)
  }
})
onBeforeUnmount(() => {
  disposed = true
  off?.()
  window.removeEventListener('pointerdown', dismiss)
})

watch(
  () => props.searchOpen,
  async (open) => {
    if (open) {
      await nextTick()
      searchInput.value?.focus()
      searchInput.value?.select()
    }
  },
)
const searchInput = ref<HTMLInputElement>(),
  activeResult = ref(0)
watch(
  () => props.query,
  () => {
    activeResult.value = 0
  },
)
function closeSearch() {
  emit('search', false)
}
function chooseSearchResult(id: string) {
  emit('find', id)
  closeSearch()
}
function searchKey(event: KeyboardEvent) {
  if (event.isComposing) {
    event.stopPropagation()
    return
  }
  const list = props.results ?? []
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeSearch()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (list.length) {
      activeResult.value =
        (activeResult.value + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length
    }
  }
  if (event.key === 'Enter' && list.length) {
    event.preventDefault()
    chooseSearchResult(list[Math.min(activeResult.value, list.length - 1)].id)
  }
}
defineExpose({
  focusSearch: () => {
    searchInput.value?.focus()
    searchInput.value?.select()
  },
})
</script>
<template>
  <header
    v-bind="$attrs"
    class="titlebar"
    :class="{ 'has-layout-controls': hasProject, 'layout-running': arranging }"
    @keydown.esc="dismissMenus"
  >
    <button
      class="app-menu-trigger"
      :aria-label="t('KNode 应用菜单')"
      :title="t('应用菜单')"
      @click="(dismissMenus(), emit('menu'))"
    >
      <img :src="brandIcon" alt="" width="20" height="20" /><span>KNode</span>
    </button>

    <template v-if="directory">
      <div class="project-location" @contextmenu.prevent.stop="pathMenu = true">
        <button
          class="project-path"
          :title="directory"
          :aria-label="`${t('打开项目文件夹')}: ${directory}`"
          @click="emit('openFolder')"
          @keydown.shift.f10.prevent="pathMenu = true"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            aria-hidden="true"
          >
            <path
              d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"
            />
          </svg>
          <span class="project-name">{{ projectName }}</span>
        </button>
        <span
          v-if="dirty"
          class="unsaved-star"
          :aria-label="t('有未保存修改')"
          :title="t('有未保存修改')"
          >*</span
        >
        <nav v-if="pathMenu" class="path-menu" :aria-label="t('项目路径菜单')">
          <button @click="pathAction('copyPath')">{{ t('复制完整路径') }}</button>
          <button @click="pathAction('openFolder')">{{ t('打开项目文件夹') }}</button>
        </nav>
      </div>
    </template>
    <!-- Only this empty element is a native drag region. Buttons never inherit it. -->
    <div class="window-drag" data-tauri-drag-region aria-hidden="true" />
    <div v-if="hasProject" class="view-switch" role="group" :aria-label="t('视图切换')">
      <button
        type="button"
        :aria-pressed="(view ?? 'tree') === 'tree'"
        data-layout-lock
        :disabled="viewLocked"
        :title="t('树视图')"
        :aria-label="t('树视图')"
        @click="emit('view', 'tree')"
      >
        <Icon name="git-fork" />
      </button>
      <button
        type="button"
        :aria-pressed="view === 'graph'"
        data-layout-lock
        :disabled="viewLocked"
        :title="t('图视图')"
        :aria-label="t('图视图')"
        @click="emit('view', 'graph')"
      >
        <Icon name="waypoints" />
      </button>
    </div>
    <div
      v-if="hasProject"
      class="layout-controls"
      role="group"
      :aria-label="t('布局')"
      @contextmenu.prevent.stop
    >
      <button
        type="button"
        class="layout-direction-trigger"
        :aria-label="directionTooltip"
        :title="directionTooltip"
        :data-value="direction"
        data-layout-lock
        :disabled="locked || arranging"
        @click="cycleDirection"
      >
        <component :is="directionIcons[direction]" :stroke-width="1.75" aria-hidden="true" />
      </button>
      <button
        type="button"
        :aria-label="t('整理布局')"
        :title="t('整理布局')"
        :aria-busy="arranging || undefined"
        :disabled="arrangeDisabled"
        @click="emit('arrange')"
      >
        <LayoutDashboard :stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="title-tools">
      <button
        v-if="hasProject"
        :aria-label="t('撤销')"
        :title="t('撤销') + ' Ctrl+Z'"
        :data-layout-lock="canUndo || undefined"
        :disabled="!canUndo || locked"
        @click="emit('undo')"
      >
        <Icon name="undo-2" />
      </button>
      <button
        v-if="hasProject"
        :aria-label="t('重做')"
        :title="t('重做') + ' Ctrl+Y'"
        :data-layout-lock="canRedo || undefined"
        :disabled="!canRedo || locked"
        @click="emit('redo')"
      >
        <Icon name="undo-2" class="redo-mirror" />
      </button>
      <button
        v-if="hasProject"
        class="search-trigger"
        :aria-label="t('搜索节点')"
        :title="t('搜索节点') + ' Ctrl+F'"
        data-layout-lock
        :disabled="locked"
        :aria-expanded="!!searchOpen"
        @click="emit('search', true)"
      >
        <Icon name="search" />
      </button>
      <button
        class="theme-toggle"
        :aria-label="theme === 'dark' ? t('切换浅色模式') : t('切换深色模式')"
        :title="theme === 'dark' ? t('切换浅色模式') : t('切换深色模式')"
        @click="toggleTheme"
      >
        <Icon :name="theme === 'dark' ? 'moon' : 'sun'" />
      </button>
      <button :aria-label="t('设置')" :title="t('设置')" @click="emit('settings')">
        <Icon name="settings" />
      </button>
    </div>
    <div class="window-controls">
      <button
        :aria-label="t('最小化')"
        :title="t('最小化')"
        :disabled="!desktop"
        @click="control(desktopWindow.minimize)"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg>
      </button>
      <button
        :aria-label="maximized ? t('还原窗口') : t('最大化')"
        :title="maximized ? t('还原窗口') : t('最大化')"
        :disabled="!desktop"
        @click="control(desktopWindow.toggleMaximize)"
      >
        <svg v-if="maximized" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7Z" /></svg
        ><svg v-else viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5h9v9h-9Z" /></svg>
      </button>
      <button
        class="window-close"
        :aria-label="t('关闭窗口')"
        :title="t('关闭窗口')"
        :disabled="!desktop"
        @click="control(desktopWindow.close)"
      >
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>
  </header>
  <div v-if="hasProject && searchOpen" class="title-search" @keydown="searchKey">
    <Icon name="search" /><input
      ref="searchInput"
      :value="query ?? ''"
      :aria-label="t('搜索节点')"
      :disabled="!hasProject || locked"
      @input="emit('query', ($event.target as HTMLInputElement).value)"
    />
    <button
      v-if="query"
      :aria-label="t('清除搜索')"
      @click="(emit('query', ''), searchInput?.focus())"
    >
      <Icon name="close" />
    </button>
    <div v-if="query" class="title-search-results" :aria-label="t('搜索结果')">
      <button
        v-for="(hit, index) in results"
        :key="hit.id"
        :class="{ active: index === activeResult }"
        @click="chooseSearchResult(hit.id)"
      >
        {{ hit.title }}
      </button>
      <span v-if="!results?.length">{{ t('没有匹配节点') }}</span>
    </div>
  </div>
</template>
