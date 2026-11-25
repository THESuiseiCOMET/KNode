<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fileActions, type FileAction, type FileTarget } from '../adapters/fileActions'
const props = defineProps<{
  token: string
  nodeId: string | null
  prepare: () => Promise<void>
  disabled: boolean
}>()
const emit = defineEmits<{ manage: [kind: string, target: FileTarget] }>()
const menu = ref<{ x: number; y: number; target: FileTarget; directory: boolean } | null>(null)
const menuElement = ref<HTMLElement>(),
  message = ref(''),
  failed = ref(false),
  working = ref(false)
let revision = 0,
  alive = true,
  previous: HTMLElement | null = null
watch(
  () => [props.token, props.nodeId],
  () => {
    revision++
    menu.value = null
    message.value = ''
    working.value = false
  },
)
const position = computed(() => ({
  left: `${Math.max(8, Math.min(menu.value?.x ?? 0, window.innerWidth - 220))}px`,
  top: `${Math.max(8, Math.min(menu.value?.y ?? 0, window.innerHeight - 230))}px`,
}))
function dismiss() {
  menu.value = null
  if (previous?.isConnected) previous.focus()
}
function manage(kind: string) {
  const target = menu.value?.target
  dismiss()
  if (target) emit('manage', kind, target)
}
function outside(event: PointerEvent) {
  if (menu.value && !menuElement.value?.contains(event.target as Node)) menu.value = null
}
function show(event: MouseEvent, target: FileTarget, directory = false) {
  if (props.disabled || working.value) return
  previous = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  const rect = previous?.getBoundingClientRect()
  menu.value = {
    target,
    directory,
    x: event.clientX || rect?.left || 8,
    y: event.clientY || rect?.bottom || 8,
  }
  void nextTick(() => menuElement.value?.querySelector<HTMLButtonElement>('button')?.focus())
}
async function run(action: FileAction, target: FileTarget) {
  if (!props.nodeId || props.disabled || working.value) return
  const token = props.token,
    id = props.nodeId,
    ticket = revision
  const current = () => alive && revision === ticket
  menu.value = null
  working.value = true
  message.value = ''
  failed.value = false
  try {
    await props.prepare()
    if (!current()) return
    const path = await fileActions.run(token, id, target, action)
    if (!current()) return
    if (action === 'path') {
      await navigator.clipboard.writeText(path)
      if (current()) message.value = t('完整路径已复制')
    }
  } catch (e) {
    if (current()) {
      message.value = t('文件操作失败：') + String(e)
      failed.value = true
    }
  } finally {
    if (current()) working.value = false
  }
}
defineExpose({ show, open: (target: FileTarget) => run('open', target) })
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => {
  alive = false
  revision++
  document.removeEventListener('pointerdown', outside)
})
</script>
<template>
  <p
    v-if="message"
    class="file-operation-message"
    :class="{ 'file-directory-error': failed }"
    :role="failed ? 'alert' : 'status'"
  >
    {{ message }}
  </p>
  <p v-if="working" role="status" class="file-operation-message">{{ t('正在执行文件操作…') }}</p>
  <Teleport to="body"
    ><nav
      v-if="menu"
      ref="menuElement"
      role="menu"
      :aria-label="t('文件操作')"
      class="context-menu file-context-menu"
      :style="position"
      @click.stop
      @pointerdown.stop
      @contextmenu.prevent.stop
      @keydown.esc.prevent.stop="dismiss"
    >
      <button role="menuitem" @click="run('path', menu!.target)">{{ t('复制完整路径') }}</button>
      <button role="menuitem" @click="run('reveal', menu!.target)">
        {{ t('在资源管理器中显示') }}
      </button>
      <template v-if="menu.target.source === 'internal' && !menu.directory"
        ><button role="menuitem" @click="manage('rename')">{{ t('重命名内部文件') }}</button
        ><button role="menuitem" @click="manage('delete')">
          {{ t('删除内部文件…') }}
        </button></template
      >
      <template v-if="menu.target.source === 'external'"
        ><button role="menuitem" @click="manage('unlink')">
          {{ menu.target.relative ? t('解除所属关联') : t('解除关联') }}</button
        ><button role="menuitem" @click="manage('relocate-file')">{{ t('重新关联文件…') }}</button
        ><button role="menuitem" @click="manage('relocate-folder')">
          {{ t('重新关联文件夹…') }}
        </button></template
      >
    </nav></Teleport
  >
</template>
