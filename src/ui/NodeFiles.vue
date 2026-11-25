<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { nodeFiles, type InternalEntry } from '../adapters/nodeFiles'
import { cardServices } from '../application/cardContext'
import { fileTreeRows } from '../application/fileTree'
import type { FileTarget } from '../adapters/fileActions'
import FileSection, { type CardFileRow } from './FileSection.vue'
import FileActions from './FileActions.vue'
import ExternalLinks from './ExternalLinks.vue'
const props = defineProps<{
  nodeId: string
  token: string
  linkedPaths: string[]
  disabled: boolean
}>()
const service = inject(cardServices)!
const directories = shallowRef<Record<string, InternalEntry[]>>({}),
  expanded = shallowRef(new Set<string>()),
  errors = shallowRef<Record<string, string>>({}),
  loading = ref(false),
  message = ref(''),
  selected = shallowRef<CardFileRow | null>(null)
const external = ref<InstanceType<typeof ExternalLinks>>(),
  actions = ref<InstanceType<typeof FileActions>>()
const dialog = ref<{ kind: 'txt' | 'md' | 'rename' | 'delete'; path: string; name: string } | null>(
    null,
  ),
  input = ref('')
const requests = new Map<string, symbol>()
const nameInput = ref<HTMLInputElement>()
watch(dialog, async (value) => {
  if (value) {
    await nextTick()
    nameInput.value?.focus()
    nameInput.value?.select()
  }
})
let alive = true,
  revision = 0
const rows = computed<CardFileRow[]>(() =>
  fileTreeRows(directories.value, expanded.value).map(({ entry, depth }) => ({
    key: entry.path,
    name: entry.name,
    depth,
    isDirectory: entry.isDirectory,
    expanded: expanded.value.has(entry.path),
    target: { source: 'internal', relative: entry.path },
    status: errors.value[entry.path] ? 'unavailable' : undefined,
    message: errors.value[entry.path],
  })),
)
const relative = computed(() => {
  const row = selected.value
  if (!row || row.target.source !== 'internal') return ''
  return row.isDirectory
    ? row.target.relative
    : row.target.relative.split('/').slice(0, -1).join('/')
})
async function load(path: string, force = false) {
  if (!force && (Object.hasOwn(directories.value, path) || requests.has(path))) return
  const ticket = Symbol(path)
  requests.set(path, ticket)
  const rev = revision
  loading.value = true
  try {
    await service.prepare()
    const entries = await nodeFiles.list(props.token, props.nodeId, path)
    if (alive && rev === revision && requests.get(path) === ticket) {
      directories.value = { ...directories.value, [path]: entries }
      const next = { ...errors.value }
      delete next[path]
      errors.value = next
    }
  } catch (e) {
    if (alive && rev === revision && requests.get(path) === ticket)
      errors.value = { ...errors.value, [path]: String(e) }
  } finally {
    if (requests.get(path) === ticket) requests.delete(path)
    if (alive) loading.value = requests.size > 0
  }
}
void load('')
function activate(row: CardFileRow) {
  if (!row.isDirectory) {
    void actions.value?.open(row.target)
    return
  }
  const path = row.target.relative,
    next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else {
    next.add(path)
    void load(path)
  }
  expanded.value = next
}
function menu(e: MouseEvent, row: CardFileRow) {
  actions.value?.show(e, row.target, row.isDirectory)
}
async function refresh() {
  revision++
  directories.value = {}
  errors.value = {}
  expanded.value = new Set()
  selected.value = null
  requests.clear()
  await load('', true)
}
async function operation(task: () => Promise<unknown>, path: string) {
  message.value = ''
  try {
    await service.operation(async () => {
      await service.prepare()
      return task()
    })
    if (alive) {
      await load(path, true)
      message.value = ''
    }
  } catch (e) {
    if (alive) message.value = String(e)
  }
}
function action(a: 'txt' | 'md' | 'file' | 'folder') {
  if (a === 'txt' || a === 'md') {
    dialog.value = { kind: a, path: relative.value, name: '' }
    input.value = ''
    return
  }
  void operation(
    () =>
      a === 'folder'
        ? nodeFiles.importFolder(props.token, props.nodeId, relative.value)
        : nodeFiles.import(props.token, props.nodeId, relative.value),
    relative.value,
  )
}
function manage(kind: string, target: FileTarget) {
  if (target.source === 'external') {
    if (kind === 'unlink') external.value?.unlink(target.linked)
    else void external.value?.relocate(kind === 'relocate-folder', target.linked)
    return
  }
  dialog.value = {
    kind: kind as 'rename' | 'delete',
    path: target.relative,
    name: target.relative.split('/').at(-1)!,
  }
  input.value = dialog.value.name
}
async function submit() {
  const d = dialog.value
  if (!d) return
  dialog.value = null
  const parent = d.path.split('/').slice(0, -1).join('/')
  await operation(
    () =>
      d.kind === 'delete'
        ? nodeFiles.delete(props.token, props.nodeId, d.path)
        : d.kind === 'rename'
          ? nodeFiles.rename(props.token, props.nodeId, d.path, input.value)
          : nodeFiles.create(props.token, props.nodeId, d.path, input.value.trim() + '.' + d.kind),
    d.kind === 'txt' || d.kind === 'md' ? d.path : parent,
  )
}
onBeforeUnmount(() => {
  alive = false
  revision++
})
</script>
<template>
  <div class="card-files nodrag nopan">
    <FileSection
      :title="t('节点文件')"
      :rows="rows"
      :disabled="disabled"
      :loading="loading"
      :error="errors['']"
      @action="action"
      @select="selected = $event"
      @activate="activate"
      @menu="menu"
      @refresh="refresh"
    />
    <ExternalLinks
      ref="external"
      :token="token"
      :node-id="nodeId"
      :paths="linkedPaths"
      :disabled="disabled"
      @menu="menu"
      @open="actions?.open($event.target)"
    />
    <div class="card-notice">
      <p v-if="message" role="alert">{{ message }}<button @click="message = ''">×</button></p>
      <FileActions
        ref="actions"
        :token="token"
        :node-id="nodeId"
        :prepare="service.prepare"
        :disabled="disabled"
        @manage="manage"
      />
    </div>
    <form
      v-if="dialog"
      class="card-file-dialog"
      @submit.prevent="submit"
      @keydown.esc.stop.prevent="dialog = null"
    >
      <b>{{
        dialog.kind === 'delete'
          ? t('删除内部文件')
          : dialog.kind === 'rename'
            ? t('重命名内部文件')
            : t('新建文件') + ' ' + dialog.kind.toUpperCase()
      }}</b>
      <p v-if="dialog.kind === 'delete'">
        {{ dialog.name }}{{ t('将由 Windows 确认并放入回收站。该文件操作不进入画布撤销历史。') }}
      </p>
      <label v-else
        >{{ t('文件名称')
        }}<input
          ref="nameInput"
          v-model="input"
          maxlength="220"
          :placeholder="dialog.kind === 'rename' ? t('包含扩展名') : t('不含扩展名')"
      /></label>
      <div>
        <button type="button" @click="dialog = null">{{ t('取消') }}</button><button
          :disabled="dialog.kind !== 'delete' && !input.trim()"
        >
          {{ t('确认') }}
        </button>
      </div>
    </form>
  </div>
</template>
