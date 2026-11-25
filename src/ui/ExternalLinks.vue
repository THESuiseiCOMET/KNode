<script setup lang="ts">
import { t } from '../application/i18n'
import { computed, inject, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { externalFiles, type ExternalEntry } from '../adapters/externalFiles'
import { cardServices } from '../application/cardContext'
import { fileTreeRows } from '../application/fileTree'
import FileSection, { type CardFileRow } from './FileSection.vue'
const props = defineProps<{
  token: string
  nodeId: string
  paths: string[]
  disabled: boolean
}>()
const emit = defineEmits<{
  menu: [event: MouseEvent, row: CardFileRow]
  open: [row: CardFileRow]
}>()
const service = inject(cardServices)!
const roots = shallowRef<ExternalEntry[]>([]),
  directories = shallowRef<Record<string, ExternalEntry[]>>({}),
  expanded = shallowRef(new Set<string>()),
  message = ref(''),
  error = ref(''),
  loading = ref(false)
const failures = shallowRef<Record<string, string>>({}),
  requests = new Map<string, symbol>()
let alive = true,
  revision = 0
const key = (link: string, path: string) => JSON.stringify([link, path])
const rows = computed<CardFileRow[]>(() =>
  roots.value.flatMap((root) => {
    const cache: Record<string, ExternalEntry[]> = Object.create(null),
      open = new Set<string>()
    for (const [k, v] of Object.entries(directories.value)) {
      const [link, path] = JSON.parse(k)
      if (link === root.path) cache[path] = v
    }
    for (const k of expanded.value) {
      const [link, path] = JSON.parse(k)
      if (link === root.path) open.add(path)
    }
    const row = (e: ExternalEntry, depth: number, path: string): CardFileRow => ({
      key: key(root.path, path),
      name: e.name,
      depth,
      isDirectory: e.isDirectory,
      expanded: open.has(path),
      target: { source: 'external', linked: root.path, relative: path },
      status: failures.value[key(root.path, path)] ? 'unavailable' : e.status,
      message: failures.value[key(root.path, path)] || e.message,
      root: path === '',
    })
    return [
      row(root, 0, ''),
      ...(open.has('')
        ? fileTreeRows(cache, open).map((r) =>
            row(r.entry as ExternalEntry, r.depth + 1, r.entry.path),
          )
        : []),
    ]
  }),
)
async function refresh() {
  const ticket = ++revision
  directories.value = {}
  expanded.value = new Set()
  failures.value = {}
  requests.clear()
  error.value = ''
  if (!props.paths.length) {
    roots.value = []
    return
  }
  loading.value = true
  try {
    await service.prepare()
    const result = await externalFiles.statuses(props.token, props.nodeId)
    if (alive && revision === ticket) roots.value = result
  } catch (e) {
    if (alive && revision === ticket) error.value = String(e)
  } finally {
    if (alive && revision === ticket) loading.value = false
  }
}
watch(
  () => JSON.stringify(props.paths),
  () => {
    void refresh()
  },
  { immediate: true },
)
async function load(link: string, path: string) {
  const k = key(link, path)
  if (Object.hasOwn(directories.value, k) || requests.has(k)) return
  const ticket = Symbol(k),
    rev = revision
  requests.set(k, ticket)
  loading.value = true
  try {
    await service.prepare()
    const result = await externalFiles.list(props.token, props.nodeId, link, path)
    if (alive && rev === revision && requests.get(k) === ticket)
      directories.value = { ...directories.value, [k]: result }
  } catch (e) {
    if (alive && rev === revision && requests.get(k) === ticket)
      failures.value = { ...failures.value, [k]: String(e) }
  } finally {
    if (requests.get(k) === ticket) requests.delete(k)
    if (alive && rev === revision) loading.value = requests.size > 0
  }
}
function activate(row: CardFileRow) {
  if (!row.isDirectory) {
    emit('open', row)
    return
  }
  if (row.target.source !== 'external') return
  const { linked, relative } = row.target,
    k = key(linked, relative),
    next = new Set(expanded.value)
  if (next.has(k)) next.delete(k)
  else {
    next.add(k)
    void load(linked, relative)
  }
  expanded.value = next
}
async function pick(folder: boolean, replace?: string) {
  message.value = ''
  error.value = ''
  try {
    const result = await service.operation(async () => {
      await service.prepare()
      return externalFiles.pick(props.token, props.nodeId, folder, replace)
    })
    if (result !== null) service.links(props.nodeId, result)
  } catch (e) {
    if (alive) error.value = String(e)
  }
}
async function create(extension: 'txt' | 'md') {
  message.value = ''
  error.value = ''
  try {
    const result = await service.operation(async () => {
      await service.prepare()
      return externalFiles.create(props.token, props.nodeId, extension)
    })
    if (result !== null) service.links(props.nodeId, result)
  } catch (e) {
    if (alive) error.value = String(e)
  }
}
function unlink(linked: string) {
  service.links(
    props.nodeId,
    props.paths.filter((p) => p !== linked),
  )
}
function action(a: 'txt' | 'md' | 'file' | 'folder') {
  if (a === 'txt' || a === 'md') void create(a)
  else void pick(a === 'folder')
}
defineExpose({ unlink, relocate: pick, refresh })
onBeforeUnmount(() => {
  alive = false
  revision++
})
</script>
<template>
  <FileSection
    :title="t('外部文件')"
    external
    :rows="rows"
    :disabled="disabled"
    :loading="loading"
    :message="message"
    :error="error"
    @action="action"
    @activate="activate"
    @menu="(e, row) => emit('menu', e, row)"
    @refresh="refresh"
  />
</template>
