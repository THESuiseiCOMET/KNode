<script setup lang="ts">
import {
  computed,
  watch,
  provide,
  reactive,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
} from 'vue'
import ForestCanvas from './canvas/ForestCanvas.vue'
import SettingsDialog from './ui/SettingsDialog.vue'
import { suppressBrowserMenu } from './ui/contextMenu'
import { language, t } from './application/i18n'
import { desktopPreferences } from './adapters/desktopPreferences'
import TitleBar from './ui/TitleBar.vue'
import Icon from './ui/Icon.vue'
import ColorDisk from './ui/ColorDisk.vue'
import { displayProjectPath } from './application/titlebar'
import { cardServices, type CardUI } from './application/cardContext'
import { setLinkedPaths } from './domain/linkedPaths'
import { nodeFiles } from './adapters/nodeFiles'
import {
  createProject,
  parseProject,
  serializeProject,
  type GraphEdge,
  type Point,
  type ProjectDocument,
  type Viewport,
  type ViewName,
} from './domain/model'
import * as forest from './domain/forest'
import * as canvas from './domain/canvas'
import { DEFAULT_NODE_COLOR } from './domain/color'
import { type ProgressPreview } from './domain/progress'
import { CanvasHistory } from './application/history'
import {
  setCollapsed,
  moveViewNodes,
  setViewViewport,
  addGraphEdge,
  updateGraphEdge,
  removeGraphEdge,
} from './domain/views'
import { makeLayoutInput, isLayoutDirection, type LayoutDirection } from './domain/layout'
import {
  readLayoutDirections,
  saveLayoutDirections,
  startAutoLayout,
} from './application/autoLayout'
import { Autosave, type SaveState } from './application/autosave'
import {
  desktopAvailable,
  installCloseGuard,
  projectIO,
  type OpenedProject,
} from './adapters/project'

// The titlebar and optional host prop share one view controller.
const appProps = withDefaults(defineProps<{ view?: ViewName }>(), { view: 'tree' })
const activeView = ref<ViewName>(appProps.view)
watch(
  () => appProps.view,
  (view) => switchView(view),
)
const layoutDirections = reactive(readLayoutDirections())
const appliedTreeDirection = ref<LayoutDirection>()
const arranging = ref(false)
let cancelLayout: (() => void) | null = null
let lastArrangements: Partial<
  Record<ViewName, { signature: string; positions: Record<string, Point> }>
> = {}
const fileWorking = ref(false)
const colorDraft = shallowRef<canvas.ColorPreview | null>(null)
const cardStates = new Map<string, CardUI>()
let cardOrder = 0
function bringCardForward(id: string): void {
  cardUI(id).order = ++cardOrder
}
function cardUI(id: string): CardUI {
  let ui = cardStates.get(id)
  if (!ui) {
    ui = reactive<CardUI>({
      page: null,
    })
    cardStates.set(id, ui)
  }
  return ui
}
const project = shallowRef<ProjectDocument | null>(null),
  opened = shallowRef<OpenedProject | null>(null)
const selectedId = ref<string | null>(null),
  busy = ref(false),
  closing = ref(false),
  error = ref('')
const selectedIds = ref<string[]>([])
const batchColorTargets = shallowRef<readonly string[] | null>(null)
const batchColorTrigger = ref<HTMLButtonElement>()
const batchColorPanel = ref<HTMLElement>()
const batchColors = computed(() => {
  if (!project.value || selectedIds.value.length < 2) return []
  const colors = canvas.nodeColors(project.value)
  return [...new Set(selectedIds.value.map((id) => colors.get(id) ?? DEFAULT_NODE_COLOR))]
})
const batchSwatch = computed(() => {
  const draft = colorDraft.value
  if (draft && draft.ids === batchColorTargets.value) return draft.color
  const [first, second] = batchColors.value
  return second ? `linear-gradient(135deg, ${first} 50%, ${second} 50%)` : first
})
watch(selectedIds, (ids) => {
  const targets = batchColorTargets.value
  if (targets && (ids.length !== targets.length || ids.some((id, index) => id !== targets[index])))
    closeBatchColor()
})
const history = shallowRef(new CanvasHistory())
const historyRevision = ref(0)
const canvasView = ref<InstanceType<typeof ForestCanvas>>()
const focusId = ref<string | null>(null),
  searchOpen = ref(false),
  query = ref('')
const progressDraft = shallowRef<ProgressPreview | null>(null)
const foldAnimation = ref(localStorage.getItem('forest-fold-animation') !== 'false')
function foldMotion(enabled: boolean) {
  foldAnimation.value = enabled
  localStorage.setItem('forest-fold-animation', String(enabled))
}
const systemReduced = ref(false)
const effectiveReduced = computed(() => reduced.value || systemReduced.value)
let media: MediaQueryList | undefined
function mediaChanged(): void {
  systemReduced.value = media?.matches ?? false
}
const reduced = ref(localStorage.getItem('forest-reduced-motion') === 'true')
const titlebar = ref<InstanceType<typeof TitleBar>>()
const settingsOpen = ref(false)
const searchResults = computed(
  () =>
    project.value?.nodes
      .filter(
        (n) =>
          Object.hasOwn(project.value!.views[activeView.value].positions, n.id) &&
          canvas.fuzzyMatch(n.title, query.value),
      )
      .slice(0, 100) ?? [],
)
let copied: canvas.CopiedNode[] = [],
  cutIds: string[] = [],
  cutSnapshot = ''
let errorIsSave = false
watch(
  () => activeView.value,
  () => {
    select(null)
    progressDraft.value = null
    colorDraft.value = null
    focusId.value = null
    copied = []
    cutIds = []
  },
)
const closeGuardReady = ref(!desktopAvailable)
const saveState = ref<SaveState>({ status: 'saved', error: null })
const autoSave = ref(localStorage.getItem('knode-auto-save') !== 'false')
let saver: Autosave | null = null,
  unlisten: (() => void) | undefined
function toggleAutoSave(): void {
  autoSave.value = !autoSave.value
  saver?.setAutomatic(autoSave.value)
  localStorage.setItem('knode-auto-save', String(autoSave.value))
}
const locked = computed(() => busy.value || closing.value || !closeGuardReady.value)
const selected = computed(() => project.value?.nodes.find((n) => n.id === selectedId.value))
const appMenu = ref(false),
  recentMenu = ref(false)
const recentTrigger = ref<HTMLButtonElement>(),
  recentSubmenu = ref<HTMLElement>()
watch(appMenu, (open) => {
  if (!open) recentMenu.value = false
})
async function openRecentMenu(focus = false) {
  if (locked.value || !desktopAvailable) return
  recentMenu.value = true
  if (focus) {
    await nextTick()
    recentSubmenu.value?.querySelector<HTMLButtonElement>('button')?.focus()
  }
}
function recentFocusOut(event: FocusEvent) {
  if (
    event.currentTarget instanceof HTMLElement &&
    !event.currentTarget.contains(event.relatedTarget as Node | null)
  )
    recentMenu.value = false
}
function recentMenuKey(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft' || event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    recentMenu.value = false
    recentTrigger.value?.focus()
    return
  }
  const buttons = [
    ...(recentSubmenu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
  ]
  if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[index].focus()
}
function menuAction(action: () => unknown): void {
  appMenu.value = false
  recentMenu.value = false
  action()
}
function readRecentProjects(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('knode-recent-projects') ?? '[]')
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (path): path is string =>
                typeof path === 'string' &&
                path.length > 0 &&
                path.length <= 32767 &&
                !/[\u0000-\u001f]/u.test(path),
            ),
          ),
        ].slice(0, 20)
      : []
  } catch {
    return []
  }
}
const recentProjects = ref(readRecentProjects())
function rememberProject(path: string, previous?: string): void {
  recentProjects.value = [
    path,
    ...recentProjects.value.filter((p) => p !== path && p !== previous),
  ].slice(0, 20)
  try {
    localStorage.setItem('knode-recent-projects', JSON.stringify(recentProjects.value))
  } catch {
    /* Preferences cannot prevent a valid project from opening. */
  }
}
function removeRecentProject(path: string): void {
  if (locked.value) return
  recentProjects.value = recentProjects.value.filter((p) => p !== path)
  try {
    localStorage.setItem('knode-recent-projects', JSON.stringify(recentProjects.value))
  } catch {
    report(t('最近记录无法保存，重启后可能恢复'))
  }
}
function recentProjectName(path: string): string {
  return (path.split(/[\\/]/u).pop() || path).replace(/\.json$/iu, '')
}
const projectDirectory = computed(() => opened.value?.directory ?? null)
let progressOriginal = 0
const unsaved = computed(
  () =>
    !!opened.value &&
    (fileWorking.value ||
      !!colorDraft.value ||
      saveState.value.status !== 'saved' ||
      (!!progressDraft.value && progressDraft.value.value !== progressOriginal)),
)
async function openFolder(): Promise<void> {
  if (!opened.value) return
  try {
    await projectIO.openFolder(opened.value.token)
  } catch (e) {
    report(t('打开项目文件夹失败：') + String(e))
  }
}
async function copyPath(): Promise<void> {
  if (!projectDirectory.value) return
  try {
    await navigator.clipboard.writeText(projectDirectory.value)
  } catch (e) {
    report(t('复制路径失败：') + String(e))
  }
}
function dismissAppMenu(event: PointerEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('.app-menu,.app-menu-trigger'))
    appMenu.value = false
  if (
    batchColorTargets.value &&
    (!(event.target instanceof Element) || !event.target.closest('.batch-color'))
  )
    closeBatchColor()
}
function cancelBatchColorPreview(): void {
  if (colorDraft.value?.ids === batchColorTargets.value) colorDraft.value = null
}
function closeBatchColor(restoreFocus = false): void {
  cancelBatchColorPreview()
  batchColorTargets.value = null
  if (restoreFocus) batchColorTrigger.value?.focus()
}
async function toggleBatchColor(): Promise<void> {
  if (batchColorTargets.value) return closeBatchColor(true)
  if (locked.value || progressDraft.value || colorDraft.value || selectedIds.value.length < 2)
    return
  batchColorTargets.value = selectedIds.value
  await nextTick()
  batchColorPanel.value?.focus({ preventScroll: true })
}
function previewBatchColor(color: string): void {
  if (batchColorTargets.value && !locked.value && !progressDraft.value)
    colorDraft.value = { ids: batchColorTargets.value, color }
}
function commitBatchColor(color: string): void {
  const ids = batchColorTargets.value
  cancelBatchColorPreview()
  if (ids) change((p) => canvas.patchNodes(p, ids, { color }))
}

type Context = {
  x: number
  y: number
  point: Point
  nodeId: string | null
  edgeChild?: string
  graphEdgeId?: string
}
const context = ref<Context | null>(null)
function openContext(menu: Context): void {
  if (menu.nodeId) {
    if (selectedIds.value.includes(menu.nodeId)) selectedId.value = menu.nodeId
    else select(menu.nodeId)
  }
  context.value = menu
}
const treeMenuHasChildren = computed(() => {
  const id = context.value?.nodeId
  return !!id && activeView.value === 'tree' && project.value?.nodes.some((n) => n.parentId === id)
})
const menuStyle = computed(() =>
  context.value
    ? {
        left: `${Math.max(8, Math.min(context.value.x, window.innerWidth - 230))}px`,
        top: `${Math.max(55, Math.min(context.value.y, window.innerHeight - 530))}px`,
      }
    : {},
)
const dialog = ref<'project' | 'projectRename' | 'node' | 'rename' | null>(null),
  input = ref(''),
  titleInput = ref<HTMLInputElement>()
let pendingNode: { parentId: string | null; point: Point; weight: number } | null = null
function report(e: unknown): void {
  error.value = e instanceof Error ? e.message : String(e)
  errorIsSave = saveState.value.status === 'error'
}
function dismissError(): void {
  error.value = ''
  saveState.value.error = null
}
let projectNeedsSave = false
function change(action: (p: ProjectDocument) => ProjectDocument, record = true): void {
  if (!project.value || locked.value || progressDraft.value) return
  try {
    const next = forest.withAllGraphNodes(action(project.value))
    const json = serializeProject(next)
    if (json === serializeProject(project.value)) return
    if (record) {
      history.value.record(project.value, next)
      historyRevision.value++
    }
    project.value = next
    const members = next.views[activeView.value].positions
    selectedIds.value = selectedIds.value.filter((id) => Object.hasOwn(members, id))
    if (
      activeView.value === 'graph' &&
      selectedId.value &&
      !Object.hasOwn(members, selectedId.value)
    )
      selectedId.value = selectedIds.value[0] ?? null
    projectNeedsSave = false
    saver?.mark(json)
    error.value = ''
  } catch (e) {
    report(e)
  }
}
async function flushProject(): Promise<void> {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  if (projectNeedsSave && project.value && saver) {
    saver.mark(serializeProject(project.value))
    projectNeedsSave = false
  }
  await saver?.flush()
}
async function save(): Promise<void> {
  if (progressDraft.value) return
  try {
    await flushProject()
  } catch (e) {
    report(e)
  }
}
async function installUpdate(install: () => Promise<void>): Promise<void> {
  if (locked.value || fileWorking.value || progressDraft.value || colorDraft.value) {
    throw new Error(t('请先完成当前编辑或文件操作，再安装更新。'))
  }
  await flushProject()
  busy.value = true
  try {
    await install()
  } finally {
    busy.value = false
  }
}
async function attach(result: OpenedProject): Promise<void> {
  let next: ProjectDocument
  try {
    const loaded = parseProject(result.json)
    next = canvas.materializeLegacyColors(forest.withAllGraphNodes(loaded))
    projectNeedsSave = next !== loaded
  } catch (e) {
    await projectIO.release(result.token)
    throw e
  }
  cardStates.clear()
  lastArrangements = {}
  appliedTreeDirection.value = undefined
  closeBatchColor()
  colorDraft.value = null
  progressDraft.value = null
  const previous = opened.value
  project.value = next
  opened.value = result
  rememberProject(result.path)
  selectedId.value = null
  selectedIds.value = []
  history.value = new CanvasHistory()
  historyRevision.value++
  copied = []
  cutIds = []
  searchOpen.value = false
  focusId.value = null
  saver = new Autosave(
    (json) => projectIO.save(result.token, json),
    (state) => {
      saveState.value = state
      if (state.status === 'saved' && errorIsSave) {
        error.value = ''
        errorIsSave = false
      }
    },
  )
  saver.setAutomatic(autoSave.value)
  saveState.value = { status: 'saved', error: null }
  error.value = ''
  if (previous && previous.token !== result.token) await projectIO.release(previous.token)
}
async function openProject(path?: string): Promise<void> {
  if (locked.value || progressDraft.value) return
  busy.value = true
  context.value = null
  try {
    await saver?.flush()
    const result = await projectIO.open(path)
    if (result) await attach(result)
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}
async function showDialog(
  kind: 'project' | 'projectRename' | 'node' | 'rename',
  value: string,
): Promise<void> {
  input.value = value
  dialog.value = kind
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}
async function newProject(): Promise<void> {
  if (!locked.value && !progressDraft.value) await showDialog('project', t('未命名项目'))
}
async function submitDialog(): Promise<void> {
  if (locked.value || !dialog.value) return
  try {
    if (dialog.value === 'projectRename' && opened.value && project.value) {
      await saver?.flush()
      busy.value = true
      const oldPath = opened.value.path
      const result = await projectIO.rename(opened.value.token, input.value.trim())
      await attach(result)
      rememberProject(result.path, oldPath)
      dialog.value = null
    } else if (dialog.value === 'project') {
      const json = serializeProject(createProject(input.value, crypto.randomUUID()))
      busy.value = true
      await saver?.flush()
      const result = await projectIO.create(json)
      if (result) {
        await attach(result)
        dialog.value = null
      }
    } else if (dialog.value === 'rename' && selected.value) {
      change((p) => forest.renameNode(p, selected.value!.id, input.value))
      dialog.value = null
    } else if (pendingNode && project.value) {
      const pending = pendingNode,
        id = crypto.randomUUID()
      const position = forest.freePosition(project.value, pending.point)
      // Stage the creation until title confirmation; Esc has no persisted side effects.
      const next =
        activeView.value === 'graph'
          ? forest.createGraphNode(project.value, id, input.value, pending.point, pending.weight)
          : pending.parentId
            ? forest.createChild(
                project.value,
                pending.parentId,
                id,
                input.value,
                position,
                pending.weight,
              )
            : forest.createRoot(project.value, id, input.value, position, pending.weight)
      change(() => next)
      selectedId.value = id
      selectedIds.value = [id]
      cancelDialog()
    }
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}
function cancelDialog(): void {
  if (!locked.value) {
    dialog.value = null
    pendingNode = null
  }
}
async function addNode(weight: number): Promise<void> {
  if (!context.value || !project.value) return
  const menu = context.value
  pendingNode = {
    parentId: activeView.value === 'tree' ? menu.nodeId : null,
    weight,
    point: menu.nodeId ? { x: menu.point.x + 330, y: menu.point.y } : menu.point,
  }
  context.value = null
  await showDialog('node', t('新节点'))
}
async function remove(): Promise<void> {
  if (!selected.value || !project.value || locked.value) return
  const { id, title } = selected.value
  const targets = selectedIds.value.length ? [...selectedIds.value] : [id]
  context.value = null
  const subject =
    targets.length > 1
      ? t('{count} 个选中节点').replace('{count}', String(targets.length))
      : `“${title}”`
  const session = opened.value?.token
  busy.value = true
  try {
    await saver?.flush()
    // Tauri's dialog plugin replaces confirm with an async function. Await also
    // supports the browser's boolean return value; a Promise must never count as consent.
    const confirmed = await window.confirm(
      t('仅删除{subject}？未选中的直接子节点将成为根；可通过画布撤销恢复。').replace(
        '{subject}',
        subject,
      ) +
        '\n' +
        t('内部文件保留在 Nodes 目录，撤销可恢复节点；外部文件不受影响。'),
    )
    if (!confirmed) return
    if (opened.value?.token !== session) throw new Error('项目已切换，请重新选择节点')
    busy.value = false
    change((p) => canvas.deleteNodes(p, targets, false))
    if (!project.value.nodes.some((n) => n.id === id)) selectedId.value = null
  } catch (e) {
    report(`删除已取消：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    busy.value = false
  }
}
function progressStart(id: string): void {
  if (!project.value || locked.value) return
  const node = project.value.nodes.find((n) => n.id === id)
  if (node && !project.value.nodes.some((n) => n.parentId === id && n.weight > 0)) {
    progressOriginal = node.progress
    progressDraft.value = { id, value: node.progress }
  }
}
function progressPreviewChange(id: string, value: number): void {
  if (progressDraft.value?.id === id) progressDraft.value = { id, value }
}
function progressCancel(id: string): void {
  if (progressDraft.value?.id === id) progressDraft.value = null
}
function progressCommit(id: string, value: number): void {
  if (!project.value || locked.value) return
  if (project.value.nodes.some((n) => n.parentId === id && n.weight > 0)) return
  progressDraft.value = null
  change((p) => forest.setManualProgress(p, id, value))
}
function chooseLayoutDirection(direction: string): void {
  if (!isLayoutDirection(direction) || locked.value || arranging.value) return
  layoutDirections[activeView.value] = direction
  try {
    saveLayoutDirections(layoutDirections)
  } catch {
    report(new Error('整理方向设置无法保存，当前窗口内仍然有效'))
  }
}
async function autoArrange(): Promise<void> {
  if (
    !project.value ||
    !opened.value ||
    locked.value ||
    arranging.value ||
    dialog.value ||
    progressDraft.value ||
    colorDraft.value
  )
    return
  const snapshot = project.value,
    mode = activeView.value,
    session = opened.value.token
  const expanded = new Set([...cardStates].filter(([, ui]) => ui.page).map(([id]) => id))
  const input = makeLayoutInput(snapshot, mode, layoutDirections[mode], expanded)
  if (mode === 'graph') {
    const sizes = canvasView.value?.graphNodeSizes?.()
    for (const node of input.nodes) Object.assign(node, sizes?.get(node.id))
  }
  if (!input.nodes.length) return
  const signature = JSON.stringify(input)
  const currentPositions = snapshot.views[mode].positions
  const isAlreadyPlaced = (positions: Record<string, Point>) =>
    Object.entries(positions).every(
      ([id, point]) => currentPositions[id]?.x === point.x && currentPositions[id]?.y === point.y,
    )
  const last = lastArrangements[mode]
  if (last?.signature === signature && isAlreadyPlaced(last.positions)) return
  arranging.value = true
  busy.value = true
  context.value = null
  try {
    const job = startAutoLayout(input)
    cancelLayout = job.cancel
    const { positions } = await job.result
    if (
      project.value !== snapshot ||
      opened.value?.token !== session ||
      activeView.value !== mode ||
      closing.value
    )
      throw new Error('项目状态已变化，本次整理未应用')
    lastArrangements[mode] = { signature, positions }
    if (mode === 'tree') appliedTreeDirection.value = input.direction
    if (isAlreadyPlaced(positions)) return
    busy.value = false
    change((p) => moveViewNodes(p, mode, new Map(Object.entries(positions))))
    if (project.value !== snapshot) {
      await nextTick()
      fit()
    }
  } catch (e) {
    report(e)
  } finally {
    cancelLayout = null
    arranging.value = false
    busy.value = false
  }
}
function switchView(view: ViewName): void {
  if (
    view === activeView.value ||
    locked.value ||
    dialog.value ||
    progressDraft.value ||
    colorDraft.value
  )
    return
  activeView.value = view
  appMenu.value = false
  context.value = null
  searchOpen.value = false
  query.value = ''
}
function move(positions: Map<string, Point>): void {
  change((p) => moveViewNodes(p, activeView.value, positions))
}
function viewport(value: Viewport, origin: ViewName = activeView.value): void {
  if (origin !== activeView.value) return
  if (!project.value || locked.value) return
  const old = project.value.views[activeView.value].viewport
  if (old.x !== value.x || old.y !== value.y || old.zoom !== value.zoom)
    change((p) => setViewViewport(p, activeView.value, value), false)
}
function select(id: string | null): void {
  context.value = null
  selectedId.value = id
  selectedIds.value = id ? [id] : []
}
function selection(ids: string[]): void {
  selectedIds.value = ids
  selectedId.value = ids.includes(selectedId.value ?? '') ? selectedId.value : (ids[0] ?? null)
}
async function undo(redo = false): Promise<void> {
  if (!project.value || !opened.value || locked.value) return
  change((p) => (redo ? history.value.redo(p) : history.value.undo(p)), false)
  historyRevision.value++
}
function copySnapshot(p: ProjectDocument): string {
  return JSON.stringify([
    p.nodes,
    p.views[activeView.value].positions,
    activeView.value === 'tree' ? p.views.tree.collapsedIds : p.views.graph.edges,
  ])
}
let pendingCopy: Promise<void> | null = null
function copy(cut = false): Promise<void> {
  const pending = copyChecked(cut)
  pendingCopy = pending
  void pending.then(
    () => {
      if (pendingCopy === pending) pendingCopy = null
    },
    (e) => {
      pendingCopy = null
      report(e)
    },
  )
  return pending
}
async function copyChecked(cut: boolean): Promise<void> {
  if (!project.value || locked.value || !selectedIds.value.length) return
  copied = canvas.copyNodes(project.value, selectedIds.value, false, activeView.value)
  cutIds = cut ? [...selectedIds.value] : []
  cutSnapshot = cut ? copySnapshot(project.value) : ''
  context.value = null
}
async function paste(): Promise<void> {
  if (
    !project.value ||
    !opened.value ||
    locked.value ||
    !copied.length ||
    progressDraft.value ||
    colorDraft.value
  )
    return
  const current = project.value,
    session = opened.value.token
  const point = context.value?.point ?? canvasView.value?.center() ?? { x: 100, y: 100 }
  const cutting = cutIds.length > 0
  const items = copied,
    cuts = [...cutIds]
  busy.value = true
  try {
    if (cutting && copySnapshot(current) !== cutSnapshot)
      throw new Error('剪切后来源已变化，请重新剪切；原节点保留')
    const oldIds = new Set(current.nodes.map((n) => n.id))
    const generated = items.map(() => crypto.randomUUID())
    let index = 0
    // Cut moves original IDs; descendants and outside parent relations stay intact.
    const positioned = canvas.pasteNodes(
      cutting ? canvas.deleteNodes(current, cuts, false) : current,
      items,
      point,
      () => (cutting ? items[index++].node.id : generated[index++]),
      activeView.value,
    )
    const moved = new Map(
      positioned.nodes
        .filter((n) => cuts.includes(n.id))
        .map((n) => [n.id, positioned.views[activeView.value].positions[n.id]]),
    )
    const next = cutting ? moveViewNodes(current, activeView.value, moved) : positioned
    await saver?.flush()
    if (!cutting)
      await nodeFiles.copy(
        session,
        items.map((n, i) => [n.node.id, generated[i]]),
      )
    if (opened.value?.token !== session || project.value !== current)
      throw new Error('项目已变化，请重新粘贴；原文件保留')
    busy.value = false
    change(() => next)
    selection(cutting ? cuts : next.nodes.filter((n) => !oldIds.has(n.id)).map((n) => n.id))
    if (cutting) {
      copied = []
      cutIds = []
      cutSnapshot = ''
    }
    context.value = null
  } catch (e) {
    report(e)
  } finally {
    busy.value = false
  }
}

provide(cardServices, {
  get token() {
    return opened.value?.token ?? ''
  },
  get project() {
    return project.value
  },
  get locked() {
    return locked.value || !!progressDraft.value
  },
  ui: cardUI,
  bringForward: bringCardForward,
  async prepare() {
    await saver?.flush()
  },
  async operation<T>(task: () => Promise<T>): Promise<T> {
    if (locked.value || progressDraft.value || colorDraft.value) throw new Error('请先结束当前操作')
    busy.value = true
    fileWorking.value = true
    try {
      return await task()
    } catch (e) {
      report(e)
      throw e
    } finally {
      busy.value = false
      fileWorking.value = false
    }
  },
  attribute(id, patch) {
    change((p) => {
      let next = p
      if (patch.title !== undefined) next = forest.renameNode(next, id, patch.title)
      if (patch.weight !== undefined) next = forest.setWeight(next, id, patch.weight)
      return next
    })
  },
  links(id, paths) {
    change((p) => setLinkedPaths(p, id, paths))
  },
  previewColor(id, color) {
    if (!locked.value && !progressDraft.value) colorDraft.value = { ids: [id], color }
  },
  commitColor(id, color) {
    colorDraft.value = null
    change((p) => canvas.patchNodes(p, [id], { color }))
  },
  cancelColor() {
    colorDraft.value = null
  },
})
async function openNodePanels(
  page: NonNullable<CardUI['page']>,
  ids: readonly string[],
): Promise<void> {
  context.value = null
  if (locked.value || !ids.length) return
  if (ids.length === 1) select(ids[0])
  else if (ids.every((id) => cardUI(id).page === page)) {
    for (const id of ids) cardUI(id).page = null
    return
  } else if (activeView.value === 'tree') change((p) => canvas.reveal(p, ids))
  for (const id of ids) {
    cardUI(id).page = page
    bringCardForward(id)
  }
  focusId.value = ids.length === 1 ? ids[0] : null
  if (ids.length > 1) {
    await nextTick()
    void canvasView.value?.fit(ids)
  }
}
function toggle(id: string): void {
  if (activeView.value !== 'tree') return
  if (project.value?.nodes.some((n) => n.parentId === id))
    change((p) => setCollapsed(p, [id], !p.views.tree.collapsedIds.includes(id)))
}
function find(id: string): void {
  searchOpen.value = false
  if (activeView.value === 'tree') change((p) => canvas.reveal(p, id))
  select(id)
  focusId.value = null
  void nextTick(() => {
    focusId.value = id
  })
}
function selectSubtree(): void {
  const id = context.value?.nodeId
  if (id && treeMenuHasChildren.value && project.value)
    selection([...canvas.descendants(project.value, [id])])
  context.value = null
}
function graphConnect(
  source: string,
  target: string,
  direction: GraphEdge['direction'] = 'forward',
): void {
  change((p) => addGraphEdge(p, { id: crypto.randomUUID(), source, target, direction }))
}
function disconnect(): void {
  const id = context.value?.edgeChild
  if (context.value?.graphEdgeId) change((p) => removeGraphEdge(p, context.value!.graphEdgeId!))
  else if (id) change((p) => forest.reparent(p, id, null))
  context.value = null
}
function rename(): void {
  context.value = null
  if (selected.value) void showDialog('rename', selected.value.title)
}
function menuToggle(): void {
  const id = context.value?.nodeId
  if (id) toggle(id)
  context.value = null
}
function allVisible(): void {
  if (project.value) {
    const hidden = activeView.value === 'tree' ? canvas.hiddenIds(project.value) : new Set<string>()
    selection(
      project.value.nodes
        .filter(
          (n) =>
            Object.hasOwn(project.value!.views[activeView.value].positions, n.id) &&
            !hidden.has(n.id),
        )
        .map((n) => n.id),
    )
  }
  context.value = null
}
function fit(): void {
  void canvasView.value?.fit()
  context.value = null
}
function menuPanels(page: NonNullable<CardUI['page']>): void {
  if (context.value?.nodeId) void openNodePanels(page, selectedIds.value)
}
function keyboard(event: KeyboardEvent): void {
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'f' &&
    project.value &&
    !dialog.value &&
    !settingsOpen.value
  ) {
    event.preventDefault()
    searchOpen.value = true
    void nextTick(() => titlebar.value?.focusSearch())
    return
  }
  if (settingsOpen.value) return
  if (
    event.target instanceof Element &&
    event.target.closest('.card-editor,.file-context-menu,.batch-color-popover')
  ) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
    return
  }
  if (progressDraft.value || colorDraft.value) return
  if (pendingCopy && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
    event.preventDefault()
    void pendingCopy.then(() => paste())
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
  }
  const editable =
    event.target instanceof HTMLElement &&
    !!event.target.closest('input,textarea,select,[contenteditable]')
  if (!editable && !dialog.value && project.value && !locked.value) {
    const ctrl = event.ctrlKey || event.metaKey,
      key = event.key.toLowerCase()
    if (ctrl && ['z', 'y', 'c', 'v', 'x', 'f', 'a'].includes(key)) {
      event.preventDefault()
      if (key === 'z') undo(event.shiftKey)
      if (key === 'y') undo(true)
      if (key === 'c') copy()
      if (key === 'x') copy(true)
      if (key === 'v') paste()
      if (key === 'a') allVisible()
      if (key === 'f') {
        searchOpen.value = true
        void nextTick(() => titlebar.value?.focusSearch())
      }
    }
    if (event.key === 'Delete' && selected.value) {
      event.preventDefault()
      void remove()
    }
    if (key === 'f' && !ctrl && selectedId.value) find(selectedId.value)
  }
  if (event.key === 'Escape') {
    appMenu.value = false
    searchOpen.value = false
    context.value = null
    cancelDialog()
  }
}
function beforeUnload(event: BeforeUnloadEvent): void {
  if (saver?.dirty) {
    event.preventDefault()
    event.returnValue = ''
  }
}
function syncTrayLanguage() {
  void desktopPreferences
    .trayLanguage(language.value)
    .catch((e) => console.warn('Tray language update failed', e))
}
watch(language, syncTrayLanguage)
onMounted(async () => {
  syncTrayLanguage()
  media = window.matchMedia('(prefers-reduced-motion: reduce)')
  mediaChanged()
  media.addEventListener('change', mediaChanged)
  window.addEventListener('pointerdown', dismissAppMenu)
  window.addEventListener('keydown', keyboard)
  window.addEventListener('beforeunload', beforeUnload)
  try {
    unlisten = await installCloseGuard(
      async () => {
        if (progressDraft.value || colorDraft.value) throw new Error('请先结束或取消拖动。')
        if (busy.value) throw new Error('当前操作尚未完成，请先完成或取消。')
        // Commit focused attribute inputs before the final flush.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        await saver?.flush()
      },
      (value) => {
        closing.value = value
      },
      report,
    )
    closeGuardReady.value = true
  } catch (e) {
    report(`关闭保存保护初始化失败：${String(e)}`)
  }
})
onBeforeUnmount(() => {
  cancelLayout?.()
  unlisten?.()
  media?.removeEventListener('change', mediaChanged)
  window.removeEventListener('pointerdown', dismissAppMenu)
  window.removeEventListener('keydown', keyboard)
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'static-ui': !foldAnimation || effectiveReduced }"
    @click="context = null"
    @contextmenu="suppressBrowserMenu"
  >
    <TitleBar
      ref="titlebar"
      :query="query"
      :search-open="searchOpen"
      :results="searchResults"
      :has-project="!!project"
      :view="activeView"
      :layout-direction="layoutDirections[activeView]"
      :arranging="arranging"
      :arrange-disabled="
        locked ||
        arranging ||
        !!dialog ||
        !!progressDraft ||
        !!colorDraft ||
        !project ||
        !Object.keys(project.views[activeView].positions).length
      "
      @layout-direction="chooseLayoutDirection"
      @arrange="autoArrange"
      :view-locked="locked || !!dialog || !!progressDraft || !!colorDraft"
      @view="switchView"
      :can-undo="history.canUndo"
      :can-redo="history.canRedo"
      :data-revision="historyRevision"
      :locked="locked"
      @query="query = $event"
      @search="searchOpen = $event"
      @find="find"
      @undo="undo()"
      @redo="undo(true)"
      @settings="settingsOpen = true"
      :project-name="project?.name"
      :directory="projectDirectory"
      :dirty="unsaved"
      :desktop="desktopAvailable"
      @menu="appMenu = !appMenu"
      @open-folder="openFolder"
      @copy-path="copyPath"
      @error="report"
    />
    <nav
      v-show="appMenu"
      class="app-menu chrome-menu"
      :aria-label="t('应用操作')"
      @keydown.esc="appMenu = false"
    >
      <button :disabled="locked || !desktopAvailable" @click="menuAction(newProject)">
        {{ t('新建项目') }}
      </button>
      <button :disabled="locked || !desktopAvailable" @click="menuAction(() => openProject())">
        {{ t('打开项目') }}
      </button>
      <button
        v-if="project"
        class="autosave-menu-trigger"
        :aria-pressed="autoSave"
        :disabled="locked"
        @click="toggleAutoSave"
      >
        {{ t('自动保存') }}<Icon v-if="autoSave" name="check" />
      </button>
      <button
        v-if="project"
        :disabled="locked"
        @click="menuAction(() => showDialog('projectRename', project!.name))"
      >
        {{ t('重命名项目') }}
      </button>
      <div
        class="recent-submenu-wrap"
        @mouseenter="openRecentMenu()"
        @mouseleave="recentMenu = false"
        @focusout="recentFocusOut"
      >
        <button
          ref="recentTrigger"
          class="recent-menu-trigger"
          :disabled="locked || !desktopAvailable"
          aria-haspopup="menu"
          :aria-expanded="recentMenu"
          aria-controls="recent-project-submenu"
          @click="openRecentMenu()"
          @keydown.right.prevent="openRecentMenu(true)"
        >
          <span>{{ t('最近打开的项目') }}</span><Icon name="right" />
        </button>
        <div
          v-if="recentMenu"
          id="recent-project-submenu"
          ref="recentSubmenu"
          class="recent-submenu chrome-menu"
          role="menu"
          :aria-label="t('最近打开的项目')"
          @keydown="recentMenuKey"
        >
          <button
            v-for="path in recentProjects"
            :key="path"
            role="menuitem"
            :title="displayProjectPath(path)"
            :disabled="locked || !desktopAvailable"
            @click="menuAction(() => openProject(path))"
          >
            <strong>{{ recentProjectName(path) }}</strong><small>{{
              displayProjectPath(path)
            }}</small>
          </button>
          <span v-if="!recentProjects.length" class="recent-menu-empty">{{ t('暂无记录') }}</span>
        </div>
      </div>
    </nav>
    <div v-if="error || saveState.error" class="error-banner" role="alert">
      <span>{{ t(error || saveState.error || '') }}</span><button
        v-if="saveState.status === 'error'"
        @click="save"
      >
        {{ t('重试保存') }}</button
      ><button @click="dismissError">{{ t('收起提示') }}</button>
    </div>
    <section v-if="!project" class="welcome">
      <div class="welcome-card">
        <h1>KNode</h1>
        <section class="recent-projects" :aria-label="t('最近打开的项目')">
          <h2>{{ t('最近打开的项目') }}</h2>
          <div v-if="recentProjects.length" class="recent-project-list">
            <div v-for="path in recentProjects" :key="path" class="recent-project-row">
              <button
                class="recent-project-open"
                :title="displayProjectPath(path)"
                :disabled="locked || !desktopAvailable"
                @click="openProject(path)"
              >
                <strong>{{ recentProjectName(path) }}</strong><small>{{
                  displayProjectPath(path)
                }}</small>
              </button>
              <button
                class="recent-project-remove"
                :disabled="locked"
                :aria-label="t('移除最近记录') + ': ' + recentProjectName(path)"
                :title="t('仅移除记录，不删除项目文件')"
                @click.stop="removeRecentProject(path)"
              >
                <Icon name="close" />
              </button>
            </div>
          </div>
          <small v-else>{{ t('暂无记录') }}</small>
        </section>
        <div class="welcome-actions">
          <button class="primary" :disabled="locked || !desktopAvailable" @click="newProject">
            {{ t('新建项目') }}</button><button
            :disabled="locked || !desktopAvailable"
            @click="openProject()"
          >
            {{ t('打开项目') }}
          </button>
        </div>
        <small v-if="!desktopAvailable">{{
          t('当前是浏览器预览。请用 npm run tauri dev 启动桌面版，使用本地项目读写。')
        }}</small>
      </div>
    </section>
    <div v-else class="project-workspace">
      <section class="workspace" :class="{ locked }">
        <div
          v-if="selectedIds.length > 1"
          class="batch-color"
          @keydown.esc.stop.prevent="closeBatchColor(true)"
        >
          {{ t('已选') }} {{ selectedIds.length }} {{ t('个节点') }}
          <button
            ref="batchColorTrigger"
            type="button"
            class="batch-color-trigger"
            :aria-label="t('选区强调色')"
            :title="t('选区强调色')"
            :aria-expanded="!!batchColorTargets"
            :disabled="locked || !!progressDraft"
            @click="toggleBatchColor"
          >
            <span
              class="batch-color-swatch"
              :style="{ background: batchSwatch }"
              aria-hidden="true"
            />
          </button>
          <section
            v-if="batchColorTargets"
            ref="batchColorPanel"
            class="batch-color-popover chrome-menu"
            :aria-label="t('选区强调色')"
            tabindex="-1"
          >
            <ColorDisk
              :value="batchColors[0] ?? DEFAULT_NODE_COLOR"
              :disabled="locked || !!progressDraft"
              @preview="previewBatchColor"
              @commit="commitBatchColor"
              @cancel="cancelBatchColorPreview"
            />
          </section>
        </div>
        <ForestCanvas
          ref="canvasView"
          :selected-ids="selectedIds"
          :reduced="effectiveReduced"
          :fold-animation="foldAnimation"
          :progress-preview="progressDraft"
          @progress-start="progressStart"
          @progress-preview="progressPreviewChange"
          @progress-commit="progressCommit"
          @progress-cancel="progressCancel"
          :focus-id="focusId"
          @selection="selection"
          @collapse="toggle"
          :key="`${opened!.token}-${activeView}`"
          :view="activeView"
          :applied-tree-direction="appliedTreeDirection"
          :project="project"
          :selected-id="selectedId"
          :locked="locked || !!colorDraft"
          :color-preview="colorDraft"
          @select="select"
          @files="openNodePanels('files', [$event])"
          @move="move"
          @viewport="viewport"
          @connect="(child, parent) => change((p) => forest.reparent(p, child, parent))"
          @graph-connect="graphConnect"
          @graph-reconnect="
            (id, source, target) => change((p) => updateGraphEdge(p, id, { source, target }))
          "
          @context="openContext"
        />
        <div v-if="!Object.keys(project.views[activeView].positions).length" class="canvas-empty">
          <h2>{{ activeView === 'graph' ? t('图视图中还没有节点') : t('从第一个节点开始') }}</h2>
          <p>
            {{
              activeView === 'graph'
                ? t('右键画布创建节点。')
                : t('右键画布，创建带权重根节点或无权重根节点。')
            }}
          </p>
        </div>
      </section>
    </div>
    <nav v-if="context" class="context-menu" :style="menuStyle" @click.stop>
      <template v-if="context.edgeChild || context.graphEdgeId"
        ><button @click="disconnect">{{ t('断开连接') }}</button></template
      >
      <template v-else>
        <template v-if="!context.nodeId || selectedIds.length < 2">
          <button @click="addNode(0)">
            {{ t('无权重节点') }}<small>{{ t('权重 0') }}</small>
          </button>
          <button @click="addNode(1)">
            {{ t('带权重节点') }}<small>{{ t('权重 1') }}</small>
          </button>
        </template>
        <template v-if="context.nodeId">
          <button
            :class="{ 'menu-group-start': selectedIds.length < 2 }"
            @click="menuPanels('files')"
          >
            {{ t('文件') }}
          </button>
          <button @click="menuPanels('properties')">{{ t('属性') }}</button>
          <button v-if="selectedIds.length < 2" @click="rename">{{ t('重命名') }}</button>
          <button class="menu-group-start" aria-keyshortcuts="Control+C" @click="copy()">
            {{ t('复制') }}<small>Ctrl+C</small>
          </button>
          <button aria-keyshortcuts="Control+X" @click="copy(true)">
            {{ t('剪切') }}<small>Ctrl+X</small>
          </button>
          <button class="danger" aria-keyshortcuts="Delete" @click="remove">
            {{ t('删除') }}<small>Delete</small>
          </button>
          <template v-if="selectedIds.length < 2 && treeMenuHasChildren">
            <button class="menu-group-start" @click="menuToggle">
              {{
                project?.views.tree.collapsedIds.includes(context.nodeId) ? t('展开') : t('折叠')
              }}
            </button>
            <button @click="selectSubtree">{{ t('选择子树') }}</button>
          </template>
        </template>
        <template v-else>
          <button
            class="menu-group-start"
            :disabled="!copied.length"
            aria-keyshortcuts="Control+V"
            @click="paste"
          >
            {{ t('粘贴') }}<small>Ctrl+V</small>
          </button>
        </template>
      </template>
    </nav>
    <div v-if="dialog" class="modal-backdrop" @click.self="cancelDialog">
      <form class="modal" @submit.prevent="submitDialog">
        <h2>
          {{
            dialog === 'projectRename'
              ? t('重命名项目')
              : dialog === 'project'
                ? t('新建项目')
                : pendingNode?.parentId
                  ? t('新建子节点')
                  : dialog === 'rename'
                    ? t('重命名节点')
                    : activeView === 'graph'
                      ? t('新建节点')
                      : t('新建根节点')
          }}
        </h2>
        <label
          >{{ dialog === 'project' || dialog === 'projectRename' ? t('项目名称') : t('节点名称')
          }}<input ref="titleInput" v-model="input" maxlength="200" :disabled="locked"
        /></label>
        <div class="modal-actions">
          <button type="button" :disabled="locked" @click="cancelDialog">
            {{ t('取消') }}</button><button class="primary" :disabled="locked || !input.trim()">
            {{
              busy
                ? t('处理中…')
                : dialog === 'project'
                  ? t('创建')
                  : dialog === 'rename' || dialog === 'projectRename'
                    ? t('确认重命名')
                    : t('创建')
            }}
          </button>
        </div>
      </form>
    </div>
    <SettingsDialog
      v-if="settingsOpen"
      :fold-animation="foldAnimation"
      :reduced-motion="effectiveReduced"
      :install-update="installUpdate"
      @fold-motion="foldMotion"
      @close="settingsOpen = false"
    />
  </main>
</template>
