import { calculateLayout, type LayoutInput } from '../src/domain/layout'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'
import App from '../src/App.vue'
import { setLanguage } from '../src/application/i18n'
import { setTheme } from '../src/application/theme'
import { DEFAULT_NODE_COLOR } from '../src/domain/color'
import { addToGraph, addGraphEdge } from '../src/domain/views'
import { createProject, parseProject, serializeProject } from '../src/domain/model'
import {
  createRoot,
  createChild,
  setManualProgress,
  computeProgress,
  withAllGraphNodes,
} from '../src/domain/forest'

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  destroy: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  requestClose: vi.fn(),
  checkUpdate: vi.fn(),
  fit: vi.fn(),
  close: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  canvasProps: undefined as Record<string, any> | undefined,
  canvasEmit: undefined as undefined | ((event: string, ...args: unknown[]) => void),
}))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: mock.invoke }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.1.0' }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mock.checkUpdate }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    destroy: mock.destroy,
    minimize: mock.minimize,
    toggleMaximize: mock.toggleMaximize,
    close: mock.requestClose,
    isMaximized: async () => false,
    onResized: async () => () => {},
    onCloseRequested: async (handler: typeof mock.close) => {
      mock.close = handler
      return () => {
        mock.close = undefined
      }
    },
  }),
}))
vi.mock('@vue-flow/core', () => ({
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  Handle: { render: () => null },
}))
// Exercise the actual cards, file trees, properties, commands, history and autosave;
// replace only the Vue Flow transport (geometry is checked separately) and native IPC.
vi.mock('../src/canvas/ForestCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue')
  const { default: Node } = await import('../src/canvas/ForestNode.vue')
  const forest = await import('../src/domain/forest')
  const { previewProgress } = await import('../src/domain/progress')
  const { nodeColors } = await import('../src/domain/canvas')
  return {
    default: defineComponent({
      props: [
        'project',
        'view',
        'reduced',
        'foldAnimation',
        'progressPreview',
        'colorPreview',
        'locked',
        'selectedIds',
        'focusId',
      ],
      setup(props, { emit, expose }) {
        mock.canvasProps = props
        mock.canvasEmit = emit
        expose({ center: () => ({ x: 100, y: 100 }), fit: mock.fit, focus: () => undefined })
        return () => {
          const p = props.project as import('../src/domain/model').ProjectDocument
          const progress = previewProgress(p, forest.computeProgress(p), props.progressPreview)
          const colors = nodeColors(p, props.colorPreview),
            children = forest.childIndex(p)
          return h(
            'div',
            { class: 'test-canvas' },
            p.nodes
              .filter((n) =>
                Object.hasOwn(p.views[props.view === 'graph' ? 'graph' : 'tree'].positions, n.id),
              )
              .map((n) =>
                h(Node, {
                  key: n.id,
                  id: n.id,
                  selected: (props.selectedIds ?? []).includes(n.id),
                  disabled: props.locked,
                  data: {
                    title: n.title,
                    weight: n.weight,
                    progress: progress.get(n.id)!,
                    automatic: !!children.get(n.id)?.some((c) => c.weight > 0),
                    collapsed: p.views.tree.collapsedIds.includes(n.id),
                    count: props.view === 'tree' ? (children.get(n.id)?.length ?? 0) : 0,
                    color: colors.get(n.id)!,
                    highlight: false,
                  },
                  onCollapse: () => emit('collapse', n.id),
                  onProgressStart: () => emit('progressStart', n.id),
                  onProgressPreview: (v: number) => emit('progressPreview', n.id, v),
                  onProgressCommit: (v: number) => emit('progressCommit', n.id, v),
                  onProgressCancel: () => emit('progressCancel', n.id),
                }),
              ),
          )
        }
      },
    }),
  }
})
function input(value: string) {
  return field('.modal input', value, host)
}
let app: VueApp,
  host: HTMLDivElement,
  disk = '',
  token = 0
type Entry = { name: string; path: string; isDirectory: boolean; size: number }
let files: Map<string, Entry[]>
const entry = (name: string, path = name, isDirectory = false): Entry => ({
  name,
  path,
  isDirectory,
  size: 0,
})
const original = () =>
  serializeProject(
    createRoot(createProject('测试', 'c0e631c4-9154-4478-b7af-a2d166e62a36'), 'root', '原始节点', {
      x: 0,
      y: 0,
    }),
  )
async function settle() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
function button(text: string, scope: ParentNode = host): HTMLButtonElement {
  const all = [...scope.querySelectorAll<HTMLButtonElement>('button')]
  const found =
    all.find((b) => b.getAttribute('aria-label') === text || b.textContent?.trim() === text) ??
    all.find((b) => b.textContent?.includes(text))
  if (!found) throw new Error(`找不到按钮 ${text}`)
  return found
}
function layoutDirectionButton() {
  return host.querySelector<HTMLButtonElement>('.layout-direction-trigger')!
}
async function chooseLayoutDirection(direction: string) {
  const trigger = layoutDirectionButton()
  for (let clicks = 0; clicks < 4 && trigger.dataset.value !== direction; clicks++) {
    trigger.click()
    await settle()
  }
  expect(trigger.dataset.value).toBe(direction)
}
function card(id = 'root') {
  const n = mock.canvasProps!.project.nodes.findIndex((n: any) => n.id === id)
  return host.querySelectorAll<HTMLElement>('.integrated-card')[n]!
}
function field(selector: string, value: string, scope: ParentNode = card(), change = true) {
  const el = scope.querySelector<HTMLInputElement>(selector)!
  expect(el, selector).toBeTruthy()
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  if (change) el.dispatchEvent(new Event('change', { bubbles: true }))
  return el
}
function row(name: string, scope: ParentNode = card()) {
  const r = [...scope.querySelectorAll<HTMLButtonElement>('[role=treeitem]')].find(
    (r) => r.querySelector('span')?.textContent === name,
  )
  if (!r) throw new Error(`找不到文件 ${name}`)
  return r
}
function double(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
}
function context(el: HTMLElement) {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 80, cancelable: true }),
  )
}
function shortcut(key: string, shiftKey = false, target: HTMLElement | Window = window) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }),
  )
}
async function opened(json?: string, files = true) {
  if (json) disk = json
  button('打开项目').click()
  await settle()
  if (files) {
    button('文件', card()).click()
    await settle()
  }
}
async function saveNow() {
  shortcut('s')
  await settle()
}
const calls = (command: string) => mock.invoke.mock.calls.filter((c) => c[0] === command)
async function createInternal(extension: 'txt' | 'md', name: string) {
  button(extension === 'txt' ? '新建内部 TXT 文件' : '新建内部 Markdown 文件', card()).click()
  await settle()
  field('.card-file-dialog input', name)
  card()
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
beforeEach(async () => {
  setTheme('light')
  setLanguage('zh-CN')
  vi.clearAllMocks()
  window.confirm = vi.fn(() => false)
  disk = original()
  token = 0
  files = new Map()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  mock.invoke.mockImplementation(async (command: string, args?: any) => {
    if (command === 'get_startup') return { enabled: false, supported: true }
    if (command === 'open_project')
      return {
        token: `t${++token}`,
        path: 'C:\\test\\测试.json',
        directory: 'C:\\test',
        json: disk,
      }
    if (command === 'create_project') {
      disk = args.json
      return {
        token: `t${++token}`,
        path: 'C:\\test\\新项目.json',
        directory: 'C:\\test',
        json: disk,
      }
    }
    if (command === 'copy_node_files') {
      for (const [source, target] of args.pairs as [string, string][]) {
        for (const [key, entries] of [...files]) {
          if (key.startsWith(source + ':'))
            files.set(
              target + key.slice(source.length),
              entries.map((e) => ({ ...e })),
            )
        }
      }
      return
    }
    if (command === 'save_project') {
      disk = args.json
      return
    }
    if (command === 'list_node_files') return files.get(`${args.nodeId}:${args.relative}`) ?? []
    if (
      command === 'create_node_file' ||
      command === 'import_node_file' ||
      command === 'import_node_folder'
    ) {
      const name =
        command === 'create_node_file'
          ? args.name
          : command === 'import_node_file'
            ? '导入 空格.txt'
            : '资料文件夹'
      const path = args.relative ? `${args.relative}/${name}` : name
      const key = `${args.nodeId}:${args.relative}`
      files.set(key, [
        ...(files.get(key) ?? []),
        entry(name, path, command === 'import_node_folder'),
      ])
      return true
    }
    if (command === 'rename_node_file' || command === 'delete_node_file') {
      const parent = args.relative.split('/').slice(0, -1).join('/'),
        key = `${args.nodeId}:${parent}`
      files.set(
        key,
        (files.get(key) ?? []).flatMap((e) =>
          e.path !== args.relative
            ? [e]
            : command === 'delete_node_file'
              ? []
              : [entry(args.name, parent ? `${parent}/${args.name}` : args.name)],
        ),
      )
      return
    }
    if (command === 'create_linked_file' || command === 'pick_linked_paths') {
      const paths = parseProject(disk).nodes.find((n) => n.id === args.nodeId)?.linkedPaths ?? []
      const path =
        command === 'create_linked_file'
          ? `../新建.${args.extension}`
          : args.directory
            ? '../资料目录'
            : '../外部文件.txt'
      return [...new Set([...paths.filter((p) => p !== args.replace), path])]
    }
    if (command === 'linked_path_statuses')
      return (parseProject(disk).nodes.find((n) => n.id === args.nodeId)?.linkedPaths ?? []).map(
        (path) => ({
          ...entry(path.split('/').at(-1)!, path, path.includes('目录')),
          status: path.includes('missing') ? 'missing' : 'ok',
          message: '',
        }),
      )
    if (command === 'list_linked_directory')
      return [{ ...entry('子文件.txt', '子文件.txt'), status: 'ok', message: '' }]
    if (command === 'file_action') return 'C:\\中文 空格\\文件.txt'
    return undefined
  })
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(App)
  app.mount(host)
  await settle()
})
afterEach(() => {
  app.unmount()
  host.remove()
  document.querySelectorAll('.file-context-menu').forEach((e) => e.remove())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('保留的画布、标题栏及保存保护回归', () => {
  it('标题栏无项目时无路径星号；打开/切换使用真实目录，纯选择不标脏', async () => {
    expect(host.querySelector('.project-location')).toBeNull()
    expect(host.querySelector('.unsaved-star')).toBeNull()
    button('打开项目').click()
    await settle()
    expect(host.querySelector('.project-path')?.getAttribute('title')).toBe('C:\\test')
    expect(host.querySelector('.unsaved-star')).toBeNull()
    mock.canvasEmit!('select', 'root')
    await settle()
    expect(host.querySelector('.unsaved-star')).toBeNull()
    expect(host.querySelector('.save-status')).toBeNull()
    mock.invoke.mockResolvedValueOnce({
      token: 'other',
      directory: 'D:\\另一项目',
      path: 'D:\\另一项目\\x.json',
      json: disk,
    })
    button('打开项目').click()
    await settle()
    expect(host.querySelector('.project-path')?.getAttribute('title')).toBe('D:\\另一项目')
  })
  it('星号跨保存串行修订保留，旧保存完成不能清掉新修改；撤销重做仍标脏', async () => {
    button('打开项目').click()
    await settle()
    const completions: (() => void)[] = [],
      regular = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] !== 'save_project') return regular(...args)
      await new Promise<void>((resolve) => completions.push(resolve))
      disk = (args[1] as { json: string }).json
    })
    mock.canvasEmit!('progressCommit', 'root', 20)
    await settle()
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(completions).toHaveLength(1)
    mock.canvasEmit!('progressCommit', 'root', 70)
    await settle()
    completions[0]()
    await settle()
    expect(parseProject(disk).nodes[0].progress).toBe(20)
    expect(completions).toHaveLength(2)
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    completions[1]()
    await settle()
    expect(host.querySelector('.unsaved-star')).toBeNull()
    expect(parseProject(disk).nodes[0].progress).toBe(70)
    mock.invoke.mockImplementation(regular)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    await settle()
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(host.querySelector('.unsaved-star')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))
    await settle()
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
  })
  it('路径打开只传会话令牌，复制完整路径；失效目录明确报错且不改变保存结果', async () => {
    button('打开项目').click()
    await settle()
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    host.querySelector<HTMLButtonElement>('.project-path')!.click()
    await settle()
    expect(mock.invoke).toHaveBeenCalledWith('open_project_folder', { token: 't1' })
    host
      .querySelector('.project-location')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    button('复制完整路径').click()
    await settle()
    expect(clipboard).toHaveBeenCalledWith('C:\\test')
    mock.invoke.mockRejectedValueOnce(new Error('目录已移动'))
    host.querySelector<HTMLButtonElement>('.project-path')!.click()
    await settle()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('打开项目文件夹失败')
    expect(host.querySelector('.unsaved-star')).toBeNull()
    expect(disk).toBe(original())
  })
  it('自定义关闭请求经过同一保存保护；失败保留星号，重试后保存窗口状态再销毁', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('progressCommit', 'root', 55)
    await settle()
    const regular = mock.invoke.getMockImplementation()!
    mock.requestClose.mockImplementation(() => mock.close!({ preventDefault: vi.fn() }))
    mock.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'save_project') throw new Error('文件被占用')
      return regular(...args)
    })
    host.querySelector<HTMLButtonElement>('[aria-label="关闭窗口"]')!.click()
    await settle()
    expect(mock.destroy).not.toHaveBeenCalled()
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('关闭已取消')
    mock.invoke.mockImplementation(regular)
    host.querySelector<HTMLButtonElement>('[aria-label="关闭窗口"]')!.click()
    await settle()
    expect(parseProject(disk).nodes[0].progress).toBe(55)
    expect(mock.invoke).toHaveBeenCalledWith('save_window_state')
    expect(mock.destroy).toHaveBeenCalledTimes(1)
    expect(host.querySelector('.unsaved-star')).toBeNull()
  })
  it('设置只保留展开与收起动画开关，记住选择且不改变项目数据', async () => {
    button('打开项目').click()
    await settle()
    const before = host.querySelector('.project-path')?.textContent
    button('设置').click()
    await settle()
    button('动画', host.querySelector('.settings-dialog')!).click()
    await settle()
    const controls = host.querySelector('.settings-dialog')!
    expect(host.querySelector('.title-divider')).toBeNull()
    expect(controls.querySelectorAll('input[type=checkbox]')).toHaveLength(1)
    expect(controls.textContent).not.toContain('连线动画')
    expect(mock.canvasProps?.foldAnimation).toBe(true)
    const fold = controls.querySelector<HTMLInputElement>('input[type=checkbox]')!
    fold.checked = false
    fold.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(mock.canvasProps?.foldAnimation).toBe(false)
    expect(localStorage.getItem('forest-fold-animation')).toBe('false')
    expect(host.querySelector('.project-path')?.textContent).toBe(before)
    expect(host.querySelector('.unsaved-star')).toBeNull()
    localStorage.removeItem('forest-fold-animation')
  })
  it('标题栏恢复开关后仍尊重系统减少动态效果及已有动画偏好', async () => {
    app.unmount()
    localStorage.removeItem('forest-reduced-motion')
    localStorage.setItem('forest-fold-animation', 'false')
    let notify: (() => void) | undefined
    const media = {
      matches: true,
      addEventListener: vi.fn((_type: string, cb: () => void) => {
        notify = cb
      }),
      removeEventListener: vi.fn(),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList)
    app = createApp(App)
    app.mount(host)
    await settle()
    button('打开项目').click()
    await settle()
    expect(mock.canvasProps?.reduced).toBe(true)
    media.matches = false
    notify!()
    await settle()
    expect(mock.canvasProps?.reduced).toBe(false)
    expect(host.querySelector('.app-menu')?.textContent).not.toContain('连线动画')
    expect(host.querySelector('.app-menu')?.textContent).not.toContain('减少动画')
    expect(mock.canvasProps?.foldAnimation).toBe(false)
    localStorage.removeItem('forest-fold-animation')
  })
  it('进度多次预览不写盘，松开一次提交，撤销重做仅一步且坐标不变', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('progressStart', 'root')
    mock.canvasEmit!('progressPreview', 'root', 30)
    mock.canvasEmit!('progressPreview', 'root', 70)
    await settle()
    expect(disk).toBe(original())
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    expect(mock.invoke.mock.calls.some((c) => c[0] === 'save_project')).toBe(false)
    mock.canvasEmit!('progressCommit', 'root', 70)
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes[0]).toMatchObject({ progress: 70 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes[0].progress).toBe(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes[0].progress).toBe(70)
  })
  it('活动进度手势阻止关闭，取消后不产生项目写入', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('progressStart', 'root')
    mock.canvasEmit!('progressPreview', 'root', 90)
    await settle()
    await mock.close!({ preventDefault: vi.fn() })
    await settle()
    expect(mock.destroy).not.toHaveBeenCalled()
    expect(host.textContent).toMatch(/结束或取消拖动/)
    mock.canvasEmit!('progressCancel', 'root')
    await settle()
    expect(disk).toBe(original())
    expect(mock.invoke.mock.calls.some((c) => c[0] === 'save_project')).toBe(false)
  })
  it('父节点进度提交入口拒绝手动覆盖', async () => {
    disk = serializeProject(
      withAllGraphNodes(
        createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 }),
      ),
    )
    const old = disk
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('progressStart', 'root')
    mock.canvasEmit!('progressCommit', 'root', 99)
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(disk).toBe(old)
  })
  it('键盘复制粘贴、撤销、Ctrl+Y 重做保持单条历史并写入真实应用保存队列', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('select', 'root')
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes).toHaveLength(2)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes).toHaveLength(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes).toHaveLength(2)
  })
  it('连线菜单断开可撤销，子节点位置与手动值不变', async () => {
    disk = serializeProject(
      createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 }),
    )
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('context', {
      x: 10,
      y: 100,
      point: { x: 0, y: 0 },
      nodeId: null,
      edgeChild: 'child',
    })
    await settle()
    button('断开连接').click()
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes[1].parentId).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes[1]).toMatchObject({
      parentId: 'root',
      progress: 0,
    })
  })
  it('先选择子树再复制明确选区，粘贴后关系重映射', async () => {
    disk = serializeProject(
      createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 }),
    )
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('select', 'root')
    await settle()
    mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 0, y: 0 }, nodeId: 'root' })
    await settle()
    button('选择子树').click()
    await settle()
    shortcut('c')
    await settle()
    mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 1000, y: 1000 }, nodeId: null })
    await settle()
    button('粘贴').click()
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    const p = parseProject(disk)
    expect(p.nodes).toHaveLength(4)
    expect(p.nodes[3].parentId).toBe(p.nodes[2].id)
  })
  it('同项目剪切在粘贴时一起提交，撤销同时恢复来源和目标', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('select', 'root')
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true }))
    await settle()
    expect(disk).toBe(original())
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes).toHaveLength(1)
    expect(parseProject(disk).nodes[0].id).toBe('root')
    expect(parseProject(disk).views.tree.positions.root).toEqual({ x: 100, y: 100 })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }))
    await settle()
    expect(parseProject(disk).nodes[0].id).toBe('root')
  })
  it('批量删除确认明确列出选中数量，取消保留全部节点', async () => {
    disk = serializeProject(
      createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 }),
    )
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('selection', ['root', 'child'])
    await settle()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    await settle()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('2 个选中节点'))
    expect(parseProject(disk).nodes).toHaveLength(2)
  })
  it('标题确认前按 Esc，不创建节点或改变磁盘', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('context', { x: 100, y: 100, point: { x: 0, y: 300 }, nodeId: null })
    await settle()
    button('带权重节点').click()
    await settle()
    input('取消的新节点')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(host.querySelector('form')).toBeNull()
    expect(mock.invoke.mock.calls.some((c) => c[0] === 'save_project')).toBe(false)
    expect(disk).toBe(original())
  })
  it('非法父子关系明确报错，旧数据与属性值保持有效', async () => {
    button('打开项目').click()
    await settle()
    mock.canvasEmit!('connect', 'root', 'root')
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/自连/)
    expect(parseProject(disk).nodes[0].parentId).toBeNull()
  })
  it('撤销带文件新建节点不再被旧文件检查拦截，重做恢复同一ID', async () => {
    await opened(undefined, false)
    mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 400, y: 0 }, nodeId: null })
    await settle()
    button('带权重节点').click()
    await settle()
    input('新节点')
    host
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    const id = mock.canvasProps!.project.nodes[1].id
    files.set(id + ':', [entry('保留.txt')])
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toHaveLength(1)
    expect(files.get(id + ':')).toHaveLength(1)
    shortcut('y')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[1].id).toBe(id)
    expect(calls('check_node_files')).toHaveLength(0)
  })
})
describe('按需卡片面板与真实文件业务', () => {
  it('主动打开文件页；两个节点独立切页；无右侧面板；空树纯留白且区域各4个按钮', async () => {
    await opened(
      serializeProject(createChild(parseProject(disk), 'root', 'child', '孩子', { x: 220, y: 0 })),
    )
    expect(host.querySelectorAll('.integrated-card')).toHaveLength(2)
    for (const c of host.querySelectorAll<HTMLElement>('.integrated-card')) {
      expect(c.style.width).toBe('340px')
      if (button('文件', c).getAttribute('aria-pressed') !== 'true') button('文件', c).click()
      await settle()
      expect(c.style.height).toBe('480px')
      expect(button('文件', c).getAttribute('aria-pressed')).toBe('true')
      expect(c.querySelectorAll('.section-tools')).toHaveLength(2)
      for (const tools of c.querySelectorAll('.section-tools'))
        expect(tools.querySelectorAll('button')).toHaveLength(4)
      expect([...c.querySelectorAll('ul')].every((e) => e.textContent === '')).toBe(true)
    }
    button('属性', card()).click()
    await settle()
    expect(button('属性', card()).getAttribute('aria-pressed')).toBe('true')
    expect(button('文件', card('child')).getAttribute('aria-pressed')).toBe('true')
    expect(card().querySelector('.section-fold')).toBeNull()
    await settle()
    expect(card().style.height).toBe('480px')
    expect(host.querySelector('aside.node-files,.inspector')).toBeNull()
    expect(calls('save_project')).toHaveLength(0)
  })
  it('名称、0–10权重、颜色保存并重新打开；坐标和手动进度不变，UI页不写JSON', async () => {
    await opened()
    const position = { ...parseProject(disk).views.tree.positions.root }
    button('属性', card()).click()
    await settle()
    field('.card-properties > label input', '中文名称')
    expect(card().querySelector('.weight-editor button')).toBeNull()
    field('[aria-label="节点权重"]', '10')
    await settle()
    expect(card().querySelector('.weight-value')?.textContent).toBe('10')
    button('预设颜色 #6599cb', card()).click()
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]).toMatchObject({
      title: '中文名称',
      weight: 10,
      color: '#6599cb',
      progress: 0,
    })
    expect(parseProject(disk).views.tree.positions.root).toEqual(position)
    expect(disk).not.toContain('customWeight')
    expect(disk).not.toContain('internalFolded')
    await opened()
    expect(button('文件', card()).getAttribute('aria-pressed')).toBe('true')
    expect(card().querySelector('.node-title')?.textContent).toBe('中文名称')
  })
  it('颜色明度预览不写盘；一次提交一条历史；失焦取消预览', async () => {
    await opened()
    button('属性', card()).click()
    await settle()
    field('[aria-label="颜色明度"]', '40', card(), false)
    await settle()
    expect(calls('save_project')).toHaveLength(0)
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    card()
      .querySelector('[aria-label="颜色明度"]')!
      .dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.color).not.toBeNull()
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.color).toBe(DEFAULT_NODE_COLOR)
    field('[aria-label="颜色明度"]', '15', card(), false)
    await settle()
    window.dispatchEvent(new Event('blur'))
    await settle()
    expect(mock.canvasProps!.colorPreview).toBeNull()
  })
  it('圆盘指针实时预览、松开提交；中心饱和度0，取消不写盘', async () => {
    await opened()
    button('属性', card()).click()
    await settle()
    const diskEl = card().querySelector<HTMLElement>('.hsv-disk')!
    diskEl.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 112,
      height: 112,
      right: 112,
      bottom: 112,
      x: 0,
      y: 0,
      toJSON() {},
    })
    diskEl.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 112,
        clientY: 56,
      }),
    )
    await settle()
    expect(calls('save_project')).toHaveLength(0)
    diskEl.dispatchEvent(
      new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 56, clientY: 56 }),
    )
    await settle()
    await saveNow()
    const color = parseProject(disk).nodes[0]!.color!
    expect(color.slice(1, 3)).toBe(color.slice(3, 5))
    expect(color.slice(1, 3)).toBe(color.slice(5, 7))
    diskEl.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: 112, clientY: 56 }),
    )
    diskEl.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }))
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.color).toBe(color)
  })
  it('全零孩子回退手动进度；无权父亲仍计算子树；顶栏隐藏但不清手动值', async () => {
    let p = setManualProgress(parseProject(disk), 'root', 73)
    p = createChild(p, 'root', 'child', '孩子', { x: 350, y: 160 }, 0)
    await opened(serializeProject(p))
    expect(card().querySelector('[role=slider]')?.getAttribute('aria-valuenow')).toBe('73')
    button('属性', card('child')).click()
    await settle()
    field('[aria-label="节点权重"]', '1', card('child'))
    button('属性', card()).click()
    await settle()
    field('[aria-label="节点权重"]', '0')
    await settle()
    await saveNow()
    expect(card().querySelector('.progress-slider')).toBeNull()
    expect(parseProject(disk).nodes[0]!.progress).toBe(73)
    expect(computeProgress(parseProject(disk)).get('root')).toBe(0)
    expect(card().querySelectorAll('.card-properties [role=slider]')).toHaveLength(0)
  })
  it('内部目录单击展开且懒读，折叠保留缓存；文件单击选中、双击系统打开', async () => {
    files.set('root:', [entry('目录', '目录', true), entry('笔记.txt')])
    files.set('root:目录', [entry('二层', '目录/二层', true)])
    files.set('root:目录/二层', [entry('深层.txt', '目录/二层/深层.txt')])
    await opened()
    row('目录').click()
    await settle()
    expect(calls('list_node_files')).toHaveLength(2)
    expect(row('目录').getAttribute('aria-selected')).toBe('true')
    await settle()
    expect(row('二层')).toBeTruthy()
    expect(calls('list_node_files').at(-1)?.[1]).toMatchObject({ relative: '目录' })
    row('二层').click()
    await settle()
    expect(row('深层.txt')).toBeTruthy()
    row('目录').click()
    row('目录').click()
    await settle()
    expect(calls('list_node_files')).toHaveLength(3)
    row('笔记.txt').click()
    await settle()
    expect(calls('file_action')).toHaveLength(0)
    double(row('笔记.txt'))
    await settle()
    expect(calls('file_action').at(-1)?.[1]).toMatchObject({
      action: 'open',
      target: { source: 'internal', relative: '笔记.txt' },
    })
  })
  it('四种内部操作均调用接口并刷新；当前选中文件夹作为目标', async () => {
    files.set('root:', [entry('资料', '资料', true)])
    files.set('root:资料', [])
    await opened()
    row('资料').click()
    await createInternal('txt', '说明')
    await createInternal('md', 'README')
    expect(calls('create_node_file').map((c) => c[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relative: '资料', name: '说明.txt' }),
        expect.objectContaining({ relative: '资料', name: 'README.md' }),
      ]),
    )
    button('复制导入文件', card()).click()
    await settle()
    button('复制导入文件夹', card()).click()
    await settle()
    expect(calls('import_node_folder').at(-1)?.[1]).toMatchObject({ relative: '资料' })
    await settle()
    expect(row('README.md')).toBeTruthy()
    expect(row('资料文件夹')).toBeTruthy()
    expect(disk).not.toContain('README.md')
  })
  it('四种外部操作、持久化重开、目录单击仅懒加载、不触发系统打开', async () => {
    await opened()
    for (const action of [
      '新建外部 TXT 文件',
      '新建外部 Markdown 文件',
      '关联已有文件',
      '关联已有文件夹',
    ]) {
      button(action, card()).click()
      await settle()
    }
    await saveNow()
    expect(parseProject(disk).nodes[0]!.linkedPaths).toEqual([
      '../新建.txt',
      '../新建.md',
      '../外部文件.txt',
      '../资料目录',
    ])
    expect(calls('create_linked_file').map((c) => c[1].extension)).toEqual(['txt', 'md'])
    expect(calls('list_linked_directory')).toHaveLength(0)
    row('资料目录').click()
    await settle()
    expect(calls('list_linked_directory')).toHaveLength(1)
    await settle()
    expect(row('子文件.txt')).toBeTruthy()
    expect(calls('file_action')).toHaveLength(0)
    double(row('子文件.txt'))
    await settle()
    expect(calls('file_action').at(-1)?.[1]).toMatchObject({
      action: 'open',
      target: { source: 'external', linked: '../资料目录', relative: '子文件.txt' },
    })
    await opened()
    expect(row('新建.txt')).toBeTruthy()
    expect(calls('list_linked_directory')).toHaveLength(1)
  })
  it('文件菜单复制绝对路径、定位、内部重命名；删除需确认且不碰外部', async () => {
    files.set('root:', [entry('原名.txt')])
    await opened()
    context(row('原名.txt'))
    await settle()
    button('复制完整路径', document.querySelector('.file-context-menu')!).click()
    await settle()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('C:\\中文 空格\\文件.txt')
    context(row('原名.txt'))
    await settle()
    button('在资源管理器中显示', document.querySelector('.file-context-menu')!).click()
    await settle()
    expect(calls('file_action').at(-1)?.[1].action).toBe('reveal')
    context(row('原名.txt'))
    await settle()
    button('重命名内部文件', document.querySelector('.file-context-menu')!).click()
    await settle()
    field('.card-file-dialog input', '新名.md')
    card()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(row('新名.md')).toBeTruthy()
    context(row('新名.md'))
    await settle()
    button('删除内部文件…', document.querySelector('.file-context-menu')!).click()
    await settle()
    expect(calls('delete_node_file')).toHaveLength(0)
    button('取消', card()).click()
    await settle()
    expect(row('新名.md')).toBeTruthy()
    context(row('新名.md'))
    await settle()
    button('删除内部文件…', document.querySelector('.file-context-menu')!).click()
    await settle()
    button('确认', card()).click()
    await settle()
    expect(calls('delete_node_file')).toHaveLength(1)
    expect(files.get('root:')).toEqual([])
  })
  it('失效关联保留且可重新关联、解除和撤销，不调用内部删除', async () => {
    const p = parseProject(disk)
    p.nodes[0]!.linkedPaths = ['../missing.txt']
    await opened(serializeProject(p))
    expect(row('missing.txt').classList.contains('invalid')).toBe(true)
    context(row('missing.txt'))
    await settle()
    button('重新关联文件…', document.querySelector('.file-context-menu')!).click()
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.linkedPaths).toEqual(['../外部文件.txt'])
    context(row('外部文件.txt'))
    await settle()
    button('解除关联', document.querySelector('.file-context-menu')!).click()
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.linkedPaths).toBeUndefined()
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.linkedPaths).toEqual(['../外部文件.txt'])
    expect(calls('delete_node_file')).toHaveLength(0)
  })
  it('读取错误可重试；文件操作失败明确显示、不虚报成功；默认程序打开失败不崩溃', async () => {
    const regular = mock.invoke.getMockImplementation()!
    let failList = true
    mock.invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'list_node_files' && failList) throw new Error('拒绝访问')
      if (cmd === 'create_node_file') throw new Error('同名文件')
      if (cmd === 'file_action') throw new Error('没有默认程序')
      return regular(cmd, args)
    })
    files.set('root:', [entry('笔记.txt')])
    await opened()
    expect(card().textContent).toContain('拒绝访问')
    failList = false
    button('重试', card()).click()
    await settle()
    await createInternal('txt', '笔记')
    expect(card().querySelector('[role=alert]')?.textContent).toContain('同名文件')
    double(row('笔记.txt'))
    await settle()
    expect(card().textContent).toContain('没有默认程序')
    expect(parseProject(disk).nodes).toHaveLength(1)
  })
  it('文件创建进行中阻止关闭与项目切换，完成后可关闭', async () => {
    await opened()
    const regular = mock.invoke.getMockImplementation()!
    let finish!: () => void
    mock.invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'create_node_file') await new Promise<void>((r) => (finish = r))
      return regular(cmd, args)
    })
    button('新建内部 TXT 文件', card()).click()
    await settle()
    field('.card-file-dialog input', '说明')
    card()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    expect(button('打开项目').disabled).toBe(true)
    await mock.close!({ preventDefault: vi.fn() })
    expect(mock.destroy).not.toHaveBeenCalled()
    finish()
    await settle()
    expect(row('说明.txt')).toBeTruthy()
    await mock.close!({ preventDefault: vi.fn() })
    expect(mock.destroy).toHaveBeenCalledOnce()
  })
  it('卡片内输入、可滚动列表及指针隔离；Ctrl+S仍保存且滑块键盘不移动节点', async () => {
    await opened()
    const c = card(),
      bubble = vi.fn()
    host.querySelector('.test-canvas')!.addEventListener('pointerdown', bubble)
    host.querySelector('.test-canvas')!.addEventListener('wheel', bubble)
    button('属性', c).click()
    await settle()
    const el = field('.card-properties > label input', '不会复制')
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    button('文件', c).click()
    await settle()
    const list = c.querySelector<HTMLElement>('.section-list')!
    Object.defineProperties(list, { scrollHeight: { value: 200 }, clientHeight: { value: 100 } })
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    shortcut('c', false, el)
    shortcut('v', false, el)
    await settle()
    expect(bubble).not.toHaveBeenCalled()
    expect(mock.canvasProps!.project.nodes).toHaveLength(1)
    shortcut('s', false, el)
    await settle()
    expect(parseProject(disk).nodes[0]!.title).toBe('不会复制')
    c.querySelector('[role=slider]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    )
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]).toMatchObject({ progress: 100 })
  })
})

describe('新卡片中的数据安全与异步边界', () => {
  it('保存失败阻止关闭和切换，重试成功清除错误及星号', async () => {
    await opened()
    button('属性', card()).click()
    await settle()
    field('.card-properties > label input', '修改标题')
    await settle()
    const regular = mock.invoke.getMockImplementation()!
    let fail = true
    mock.invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'save_project' && fail) throw new Error('磁盘只读')
      return regular(cmd, args)
    })
    await mock.close!({ preventDefault: vi.fn() })
    await settle()
    expect(mock.destroy).not.toHaveBeenCalled()
    expect(host.querySelector('.error-banner')?.textContent).toContain('磁盘只读')
    const count = calls('open_project').length
    button('打开项目').click()
    await settle()
    expect(calls('open_project')).toHaveLength(count)
    fail = false
    button('重试保存').click()
    await settle()
    expect(host.querySelector('.error-banner')).toBeNull()
    expect(host.querySelector('.unsaved-star')).toBeNull()
    expect(parseProject(disk).nodes[0]!.title).toBe('修改标题')
  })
  it('损坏JSON不替换当前森林或自动写出空项目', async () => {
    await opened()
    const old = disk,
      regular = mock.invoke.getMockImplementation()!
    mock.invoke.mockImplementation(async (cmd: string, args: any) =>
      cmd === 'open_project'
        ? { token: 'broken', path: 'C:/broken.json', directory: 'C:/', json: '{broken' }
        : regular(cmd, args),
    )
    button('打开项目').click()
    await settle()
    expect(card().querySelector('.node-title')?.textContent).toBe('原始节点')
    expect(disk).toBe(old)
    expect(calls('save_project')).toHaveLength(0)
    expect(calls('release_project').at(-1)?.[1]).toMatchObject({ token: 'broken' })
  })
  it('复制子树包括后代文件，删除及撤销保留原目录，副本修改不共享列表', async () => {
    await opened(
      serializeProject(createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 })),
      false,
    )
    files.set('child:', [entry('资料', '资料', true)])
    files.set('child:资料', [entry('中文 空格.txt', '资料/中文 空格.txt')])
    mock.canvasEmit!('select', 'root')
    await settle()
    mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 0, y: 0 }, nodeId: 'root' })
    await settle()
    button('选择子树').click()
    await settle()
    shortcut('c')
    await settle()
    shortcut('v')
    await settle()
    await saveNow()
    let p = parseProject(disk),
      clone = p.nodes[3]
    expect(p.nodes).toHaveLength(4)
    expect(clone.parentId).toBe(p.nodes[2].id)
    expect(files.get(clone.id + ':资料')).toEqual(files.get('child:资料'))
    expect(files.get(clone.id + ':资料')).not.toBe(files.get('child:资料'))
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toHaveLength(2)
    expect(files.get(clone.id + ':资料')).toHaveLength(1)
    shortcut('y')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[3].id).toBe(clone.id)
    window.confirm = vi.fn(() => true)
    mock.canvasEmit!('select', 'root')
    await settle()
    mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 0, y: 0 }, nodeId: 'root' })
    await settle()
    button('选择子树').click()
    await settle()
    shortcut('Delete')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toHaveLength(2)
    expect(files.get('child:资料')).toHaveLength(1)
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toHaveLength(4)
  })
  it('节点删除须等原生确认，同意才写入，撤销恢复相同ID和坐标', async () => {
    await opened()
    const originalNode = parseProject(disk).nodes[0]!
    let confirm!: (v: boolean) => void
    vi.spyOn(window, 'confirm').mockReturnValue(
      new Promise<boolean>((r) => (confirm = r)) as unknown as boolean,
    )
    mock.canvasEmit!('select', 'root')
    await settle()
    mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 0, y: 0 }, nodeId: 'root' })
    await settle()
    button('删除', host.querySelector('.context-menu')!).click()
    await settle()
    expect(mock.canvasProps!.project.nodes).toHaveLength(1)
    confirm(true)
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toHaveLength(0)
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toEqual([originalNode])
  })
  it('异步确认取消不删除；原生确认失败明确提示且保留数据', async () => {
    await opened()
    let fail = false
    vi.spyOn(window, 'confirm').mockImplementation(() => {
      if (fail) return Promise.reject(new Error('确认失败')) as unknown as boolean
      return false
    })
    for (const failed of [false, true]) {
      fail = failed
      mock.canvasEmit!('select', 'root')
      mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 0, y: 0 }, nodeId: 'root' })
      await settle()
      button('删除', host.querySelector('.context-menu')!).click()
      await settle()
      expect(parseProject(disk).nodes).toHaveLength(1)
    }
    expect(host.textContent).toContain('删除已取消')
  })
  it('切换项目时旧文件请求不能污染新会话，旧卡片不会复活', async () => {
    const regular = mock.invoke.getMockImplementation()!
    let resolve!: (rows: Entry[]) => void
    mock.invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'list_node_files' && args.token === 't1')
        return new Promise<Entry[]>((r) => (resolve = r))
      return regular(cmd, args)
    })
    await opened()
    await opened()
    resolve([entry('旧请求.txt')])
    await settle()
    expect(card().textContent).not.toContain('旧请求.txt')
  })
  it('目录请求期间可折叠；迟到内容不会自行展开，重开时复用缓存', async () => {
    files.set('root:', [entry('慢目录', '慢目录', true)])
    const regular = mock.invoke.getMockImplementation()!
    let resolve!: (rows: Entry[]) => void
    mock.invoke.mockImplementation(async (cmd: string, args: any) =>
      cmd === 'list_node_files' && args.relative === '慢目录'
        ? new Promise<Entry[]>((r) => (resolve = r))
        : regular(cmd, args),
    )
    await opened()
    row('慢目录').click()
    await settle()
    row('慢目录').click()
    await settle()
    resolve([entry('迟到.txt', '慢目录/迟到.txt')])
    await settle()
    expect(card().textContent).not.toContain('迟到.txt')
    row('慢目录').click()
    await settle()
    expect(row('迟到.txt')).toBeTruthy()
    expect(calls('list_node_files')).toHaveLength(2)
  })
  it('外部路径选择取消不删除原引用；目录权限失败保留引用并可再次展开重试', async () => {
    const p = parseProject(disk)
    p.nodes[0]!.linkedPaths = ['../资料目录']
    const regular = mock.invoke.getMockImplementation()!
    let fail = true
    mock.invoke.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === 'pick_linked_paths') return null
      if (cmd === 'list_linked_directory' && fail) throw new Error('目录拒绝访问')
      return regular(cmd, args)
    })
    await opened(serializeProject(p))
    button('关联已有文件', card()).click()
    await settle()
    row('资料目录').click()
    await settle()
    expect(row('资料目录').getAttribute('title')).toContain('目录拒绝访问')
    fail = false
    row('资料目录').click()
    row('资料目录').click()
    await settle()
    expect(row('子文件.txt')).toBeTruthy()
    expect(parseProject(disk).nodes[0]!.linkedPaths).toEqual(['../资料目录'])
  })
  it('批量拖动一次一条历史，属性页切换不会挪动旧坐标', async () => {
    await opened(
      serializeProject(createChild(parseProject(disk), 'root', 'child', '孩子', { x: 200, y: 80 })),
    )
    const old = parseProject(disk)
    mock.canvasEmit!(
      'move',
      new Map([
        ['root', { x: 25, y: 30 }],
        ['child', { x: 225, y: 110 }],
      ]),
    )
    await settle()
    button('属性', card()).click()
    button('文件', card()).click()
    await settle()
    await saveNow()
    expect(parseProject(disk).views.tree.positions.child).toEqual({ x: 225, y: 110 })
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes).toEqual(old.nodes)
    shortcut('y')
    await settle()
    await saveNow()
    expect(parseProject(disk).views.tree.positions.root).toEqual({ x: 25, y: 30 })
  })
  it('折叠及再展开可以撤销、保存和重新打开，不改变后代坐标或文件', async () => {
    await opened(
      serializeProject(createChild(parseProject(disk), 'root', 'child', '孩子', { x: 200, y: 80 })),
    )
    const old = parseProject(disk).nodes[1]!
    button('折叠子树', card()).click()
    await settle()
    await saveNow()
    expect(parseProject(disk).views.tree.collapsedIds.includes('root')).toBe(true)
    expect(parseProject(disk).nodes[1]).toEqual(old)
    await opened()
    expect(button('展开子树', card())).toBeTruthy()
    button('展开子树', card()).click()
    await settle()
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).views.tree.collapsedIds.includes('root')).toBe(true)
  })
})

it('卡片和空列表滚轮到达画布，仅溢出内容消费滚轮；没有祖先nowheel拦截', async () => {
  await opened()
  const c = card(),
    wheel = vi.fn()
  host.querySelector('.test-canvas')!.addEventListener('wheel', wheel)
  for (const selector of ['.card-titlebar', '.card-tabs', '.section-list', '.card-properties']) {
    if (selector === '.card-properties') {
      button('属性', c).click()
      await settle()
    }
    const target = c.querySelector<HTMLElement>(selector)!
    expect(target.closest('.nowheel')).toBeNull()
    target.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
  }
  expect(wheel).toHaveBeenCalledTimes(4)
  const props = c.querySelector<HTMLElement>('.card-properties')!
  Object.defineProperties(props, { scrollHeight: { value: 400 }, clientHeight: { value: 100 } })
  props.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
  expect(wheel).toHaveBeenCalledTimes(4)
})

it('中键从卡片输入区、进度条和色盘传到画布，且不启动控件编辑；左键继续隔离', async () => {
  await opened()
  button('属性', card()).click()
  await settle()
  const seen = vi.fn(),
    pointers = vi.fn()
  host.querySelector('.test-canvas')!.addEventListener('mousedown', seen)
  host.querySelector('.test-canvas')!.addEventListener('pointerdown', pointers)
  for (const target of [
    card().querySelector('.card-properties input')!,
    card().querySelector('[role=slider]')!,
    card().querySelector('.hsv-disk')!,
  ]) {
    const pointer = new PointerEvent('pointerdown', {
      button: 1,
      pointerId: 4,
      bubbles: true,
      cancelable: true,
    })
    target.dispatchEvent(pointer)
    expect(pointer.defaultPrevented).toBe(false)
    target.dispatchEvent(
      new MouseEvent('mousedown', { button: 1, bubbles: true, cancelable: true }),
    )
  }
  expect(seen).toHaveBeenCalledTimes(3)
  expect(pointers).toHaveBeenCalledTimes(3)
  expect(mock.canvasProps!.progressPreview).toBeNull()
  expect(mock.canvasProps!.colorPreview).toBeNull()
  const target = card().querySelector('.card-properties input')!
  target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
  expect(seen).toHaveBeenCalledTimes(3)
})
it('权重0–10整数边界，拖动数字即时变化，提交保存且不清手动进度', async () => {
  await opened()
  button('属性', card()).click()
  await settle()
  const range = card().querySelector<HTMLInputElement>('[aria-label="节点权重"]')!
  expect(range.min).toBe('0')
  expect(range.max).toBe('10')
  expect(range.step).toBe('1')
  for (const value of ['0', '5', '10']) {
    field('[aria-label="节点权重"]', value, card(), false)
    await settle()
    expect(card().querySelector('.weight-value')?.textContent).toBe(value)
    range.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[0]!.weight).toBe(Number(value))
    expect(parseProject(disk).nodes[0]!.progress).toBe(0)
  }
})

describe('大目录窗口化回归', () => {
  it('内部展开10000文件只创建可见行；滚到底和键盘定位后仍可操作', async () => {
    files.set('root:', [entry('大目录', '大目录', true)])
    files.set(
      'root:大目录',
      Array.from({ length: 10000 }, (_, i) =>
        entry('文件' + i + '.txt', '大目录/文件' + i + '.txt'),
      ),
    )
    await opened()
    const began = performance.now()
    row('大目录').click()
    await settle()
    const duration = performance.now() - began
    const list = card().querySelector<HTMLElement>('.section-list')!
    expect(list.querySelectorAll('[role=treeitem]').length).toBeLessThan(40)
    expect(row('文件0.txt')).toBeTruthy()
    expect(calls('list_node_files')).toHaveLength(2)
    list.scrollTop = 270000
    list.dispatchEvent(new Event('scroll'))
    await settle()
    expect(row('文件9999.txt')).toBeTruthy()
    expect(list.querySelectorAll('[role=treeitem]').length).toBeLessThan(40)
    row('文件9999.txt').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await settle()
    expect(row('大目录')).toBeTruthy()
    console.info('内部10000项展开与可见行渲染（happy-dom，非FPS）ms', Math.round(duration))
  })
  it('外部10000文件懒读、展开渲染有界，读取中显示状态且可折叠', async () => {
    const p = parseProject(disk)
    p.nodes[0]!.linkedPaths = ['../资料目录']
    const regular = mock.invoke.getMockImplementation()!
    let done!: (rows: any[]) => void
    mock.invoke.mockImplementation(async (cmd: string, args: any) =>
      cmd === 'list_linked_directory' ? new Promise<any[]>((r) => (done = r)) : regular(cmd, args),
    )
    await opened(serializeProject(p))
    row('资料目录').click()
    await settle()
    expect(card().querySelectorAll('.card-file-status[role=status]').length).toBeGreaterThan(0)
    row('资料目录').click()
    await settle()
    done(
      Array.from({ length: 10000 }, (_, i) => ({
        ...entry('外部' + i + '.txt', '外部' + i + '.txt'),
        status: 'ok',
        message: '',
      })),
    )
    await settle()
    expect(card().textContent).not.toContain('外部0.txt')
    const began = performance.now()
    row('资料目录').click()
    await settle()
    expect(row('外部0.txt')).toBeTruthy()
    expect(card().querySelectorAll('[role=treeitem]').length).toBeLessThan(40)
    expect(calls('list_linked_directory')).toHaveLength(1)
    console.info(
      '外部10000项缓存展开与可见行渲染（happy-dom，非FPS）ms',
      Math.round(performance.now() - began),
    )
  })
})

it('内外文件夹每次点击都切换，双击事件不额外切换，右键只选中，文件仍双击打开', async () => {
  files.set('root:', [entry('目录', '目录', true), entry('笔记.txt')])
  files.set('root:目录', [entry('child.txt', '目录/child.txt')])
  const p = parseProject(disk)
  p.nodes[0]!.linkedPaths = ['../资料目录']
  await opened(serializeProject(p))
  for (const name of ['目录', '资料目录']) {
    row(name).dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
    await settle()
    row(name).dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }))
    double(row(name))
    await settle()
    expect(row(name).getAttribute('aria-expanded')).toBe('false')
    context(row(name))
    await settle()
    expect(row(name).getAttribute('aria-expanded')).toBe('false')
    document
      .querySelector('.file-context-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    row(name).dispatchEvent(new MouseEvent('click', { detail: 3, bubbles: true }))
    await settle()
    expect(row(name).getAttribute('aria-expanded')).toBe('true')
  }
  expect(calls('file_action')).toHaveLength(0)
  row('笔记.txt').click()
  await settle()
  expect(calls('file_action')).toHaveLength(0)
  double(row('笔记.txt'))
  await settle()
  expect(calls('file_action')).toHaveLength(1)
})

it('文件区域没有收起按钮，明度位于色盘下方，三个滑条共用宽度布局', async () => {
  await opened()
  const c = card()
  expect([...c.querySelectorAll('.file-section-title')].map((e) => e.textContent)).toEqual([
    '节点文件',
    '外部文件',
  ])
  expect(c.querySelectorAll('.section-fold')).toHaveLength(0)
  expect(c.querySelectorAll('.section-tools button')).toHaveLength(8)
  button('属性', c).click()
  await settle()
  const color = c.querySelector('.color-control')!,
    body = color.querySelector('.color-body')!,
    value = color.querySelector('.color-value-row')!
  expect(body.nextElementSibling).toBe(value)
  expect(body.querySelectorAll('.color-presets button')).toHaveLength(9)
  expect(body.querySelector('[aria-label="颜色明度"]')).toBeNull()
  expect(value.querySelector('[aria-label="颜色明度"]')).toBeTruthy()
  expect(c.querySelectorAll('.slider-row')).toHaveLength(3)
})

it('新文件夹首次收到detail=2/3的有效点击也立即展开；已有目录不因连击计数卡死', async () => {
  files.set('root:', [entry('目录', '目录', true)])
  files.set('root:目录', [entry('二层', '目录/二层', true)])
  files.set('root:目录/二层', [entry('child.txt', '目录/二层/child.txt')])
  const p = parseProject(disk)
  p.nodes[0]!.linkedPaths = ['../资料目录']
  await opened(serializeProject(p))
  for (const [name, detail] of [
    ['目录', 2],
    ['二层', 3],
    ['资料目录', 2],
  ] as const) {
    row(name).dispatchEvent(new MouseEvent('click', { detail, bubbles: true }))
    await settle()
    expect(row(name).getAttribute('aria-expanded')).toBe('true')
  }
  expect(calls('list_node_files')).toHaveLength(3)
  expect(calls('list_linked_directory')).toHaveLength(1)
  for (const detail of [2, 3, 4, 1]) {
    row('资料目录').dispatchEvent(new MouseEvent('click', { detail, bubbles: true }))
    await settle()
    expect(row('资料目录').getAttribute('aria-expanded')).toBe(
      detail === 2 || detail === 4 ? 'false' : 'true',
    )
  }
  expect(calls('file_action')).toHaveLength(0)
})

it('默认收起且零目录请求；按图标只挂载对应面板，关闭恢复紧凑且不改坐标或JSON', async () => {
  await opened(undefined, false)
  const before = disk
  expect(card().style.height).toBe('152px')
  expect(card().querySelector('.card-files,.card-properties,.hsv-disk')).toBeNull()
  expect(calls('list_node_files')).toHaveLength(0)
  for (const name of ['文件', '属性']) expect(button(name, card()).textContent?.trim()).toBe('')
  button('属性', card()).click()
  await settle()
  expect(card().style.height).toBe('480px')
  expect(card().querySelector('.hsv-disk')).not.toBeNull()
  expect(card().querySelector('.card-files')).toBeNull()
  expect(calls('list_node_files')).toHaveLength(0)
  button('文件', card()).click()
  await settle()
  expect(card().querySelector('.hsv-disk')).toBeNull()
  expect(calls('list_node_files')).toHaveLength(1)
  button('文件', card()).click()
  await settle()
  expect(card().style.height).toBe('152px')
  expect(card().querySelector('.card-content,.card-files,.card-properties')).toBeNull()
  expect(calls('save_project')).toHaveLength(0)
  expect(disk).toBe(before)
  button('文件', card()).click()
  await settle()
  expect(calls('list_node_files')).toHaveLength(2)
})

it('1000个默认紧凑节点不挂载文件树或属性页；打开一个节点只读取一个根目录', async () => {
  const p = parseProject(original())
  const template = p.nodes[0]
  p.nodes = Array.from({ length: 1000 }, (_, i) => ({
    ...template,
    id: i === 0 ? 'root' : 'node' + i,
    title: '节点' + i,
  }))
  p.views.tree.positions = Object.fromEntries(p.nodes.map((n, i) => [n.id, { x: i * 380, y: 0 }]))
  await opened(serializeProject(p), false)
  expect(host.querySelectorAll('.integrated-card')).toHaveLength(1000)
  expect(host.querySelectorAll('.card-files,.hsv-disk')).toHaveLength(0)
  expect(calls('list_node_files')).toHaveLength(0)
  button('文件', card()).click()
  await settle()
  expect(host.querySelectorAll('.card-files')).toHaveLength(1)
  expect(calls('list_node_files')).toHaveLength(1)
})

it('关闭文件面板后返回的旧目录请求不会污染重新打开的面板', async () => {
  const regular = mock.invoke.getMockImplementation()!
  let finish!: (rows: Entry[]) => void,
    first = true
  mock.invoke.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === 'list_node_files' && first) {
      first = false
      return new Promise<Entry[]>((r) => (finish = r))
    }
    return regular(cmd, args)
  })
  await opened()
  button('文件', card()).click()
  await settle()
  button('文件', card()).click()
  await settle()
  finish([entry('旧面板迟到.txt')])
  await settle()
  expect(card().textContent).not.toContain('旧面板迟到.txt')
})

it('原图标再次点击收起，切换另一个图标不先收起，关闭按钮完全移除', async () => {
  await opened(undefined, false)
  const before = disk
  expect(card().querySelector('.panel-close')).toBeNull()
  button('属性', card()).click()
  await settle()
  expect(card().querySelector('.card-properties')).not.toBeNull()
  expect(card().style.height).toBe('480px')
  button('属性', card()).click()
  await settle()
  expect(card().style.height).toBe('152px')
  expect(card().querySelector('.card-content')).toBeNull()
  button('文件', card()).click()
  await settle()
  button('属性', card()).click()
  await settle()
  expect(card().style.height).toBe('480px')
  expect(card().querySelector('.card-properties')).not.toBeNull()
  expect(card().querySelector('.card-files')).toBeNull()
  expect(button('文件', card()).getAttribute('aria-pressed')).toBe('false')
  expect(button('属性', card()).getAttribute('aria-pressed')).toBe('true')
  expect(disk).toBe(before)
})

it('顶部唯一搜索入口支持Ctrl+F、定位展开祖先、清除、Esc；菜单包含最近项目入口', async () => {
  const p = createChild(parseProject(disk), 'root', 'child', '要找的任务', { x: 400, y: 0 })
  p.views.tree.collapsedIds = ['root']
  await opened(serializeProject(p), false)
  expect(
    [...host.querySelectorAll('.app-menu > button,.app-menu > .recent-submenu-wrap > button')].map(
      (e) => e.textContent?.replace('Ctrl+S', '').trim(),
    ),
  ).toEqual(['新建项目', '打开项目', '自动保存', '重命名项目', '最近打开的项目'])
  expect(host.querySelector('.node-search,.batch-color,.title-motion')).toBeNull()
  shortcut('f')
  await settle()
  const search = host.querySelector<HTMLInputElement>('.title-search input')!
  expect(document.activeElement).toBe(search)
  expect(search.getAttribute('placeholder')).toBeNull()
  field('.title-search input', '要找', host, false)
  await settle()
  search.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  await settle()
  expect(mock.canvasProps?.project.views.tree.collapsedIds.includes('root')).toBe(false)
  expect(mock.canvasProps?.focusId).toBe('child')
  button('搜索节点').click()
  await settle()
  button('清除搜索').click()
  await settle()
  expect(host.querySelector<HTMLInputElement>('.title-search input')!.value).toBe('')
  shortcut('Escape', false, host.querySelector<HTMLInputElement>('.title-search input')!)
  await settle()
  expect(host.querySelector('.title-search')).toBeNull()
  expect(host.querySelector('.title-tools .redo-mirror path')?.getAttribute('d')).toBe(
    button('撤销').querySelector('svg path')?.getAttribute('d'),
  )
})
it('语言即时切换并持久化，用户标题不会被翻译；AI入口完全移除', async () => {
  await opened(undefined, false)
  button('设置').click()
  await settle()
  const select = host.querySelector<HTMLSelectElement>('.settings-dialog select')!
  select.value = 'en'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(host.querySelector('.settings-dialog')?.textContent).toContain('General')
  expect(localStorage.getItem('knode-language')).toBe('en')
  expect(host.querySelector('.node-title')?.textContent).toBe(parseProject(disk).nodes[0].title)
  button('Close', host.querySelector('.settings-dialog')!).click()
  await settle()
  expect(host.querySelector('[aria-label="AI workspace"],.ai-workspace')).toBeNull()
  setLanguage('zh-CN')
})
it('重命名先保存、接入新会话、同步最近路径；项目身份及节点不改变', async () => {
  await opened(undefined, false)
  const before = parseProject(disk)
  const old = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === 'rename_project') {
      const p = parseProject(disk)
      p.name = args.name
      disk = serializeProject(p)
      return {
        token: 'renamed',
        path: 'C:\\test\\新的森林\\新的森林.json',
        directory: 'C:\\test\\新的森林',
        json: disk,
      }
    }
    return old(cmd, args)
  })
  button('重命名项目').click()
  await settle()
  field('.modal input', '新的森林', host)
  host
    .querySelector('form.modal')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(parseProject(disk).name).toBe('新的森林')
  expect(parseProject(disk).projectId).toBe(before.projectId)
  expect(parseProject(disk).nodes).toEqual(before.nodes)
  expect(host.querySelector('.project-path')?.textContent).toContain('新的森林')
  expect(localStorage.getItem('knode-recent-projects')).not.toContain('测试.json')
})
it('新建项目精简文案与默认名称，Enter提交仍走系统目录选择，Esc取消节点创建', async () => {
  expect(host.querySelector('.welcome h1')?.textContent).toBe('KNode')
  button('新建项目').click()
  await settle()
  const input = host.querySelector<HTMLInputElement>('.modal input')!
  expect(input.value).toBe('未命名项目')
  expect(document.activeElement).toBe(input)
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe(input.value.length)
  expect(host.querySelector('.modal')?.textContent).not.toContain('下一步')
  host
    .querySelector('form.modal')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(calls('create_project')).toHaveLength(1)
})

it('主页隐藏项目工具，最近项目去重并直接打开，重启后仍保留记录', async () => {
  const path = 'C:\\资料 空格\\中文项目\\中文项目.json'
  app.unmount()
  localStorage.setItem('knode-recent-projects', JSON.stringify([path, path, 12, null, '']))
  app = createApp(App)
  app.mount(host)
  await settle()
  expect(host.querySelector('.title-search')).toBeNull()
  expect(host.querySelector('.title-tools [aria-label="撤销"]')).toBeNull()
  expect(host.querySelector('.title-tools [aria-label="重做"]')).toBeNull()
  expect(host.querySelector('.title-tools [aria-label="设置"]')).not.toBeNull()
  const entries = host.querySelectorAll<HTMLButtonElement>('.recent-project-open')
  expect(entries).toHaveLength(1)
  expect(entries[0].querySelector('strong')?.textContent).toBe('中文项目')
  expect(entries[0].title).toBe(path)
  const regular = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === 'open_project' && args.path === path)
      return { token: 'recent-session', path, directory: 'C:\\资料 空格\\中文项目', json: disk }
    return regular(command, args)
  })
  entries[0].click()
  await settle()
  expect(mock.invoke).toHaveBeenCalledWith('open_project', { language: 'zh-CN', path })
  expect(host.querySelector('.welcome')).toBeNull()
  expect(host.querySelector('.search-trigger')).not.toBeNull()
  expect(host.querySelector('.title-search')).toBeNull()
  expect(host.querySelector('.title-tools [aria-label="设置"]')).not.toBeNull()
  expect(calls('save_project')).toHaveLength(0)
  app.unmount()
  app = createApp(App)
  app.mount(host)
  await settle()
  expect(host.querySelector('.recent-project-list button')?.getAttribute('title')).toBe(path)
  localStorage.removeItem('knode-recent-projects')
})

it('失效最近项目明确报错且保留主页，不保存空项目；损坏的历史偏好不影响启动', async () => {
  app.unmount()
  localStorage.setItem('knode-recent-projects', 'invalid json')
  app = createApp(App)
  app.mount(host)
  await settle()
  expect(host.querySelector('.recent-projects')?.textContent).toContain('暂无记录')
  app.unmount()
  const path = 'C:\\missing\\missing.json'
  localStorage.setItem('knode-recent-projects', JSON.stringify([path]))
  app = createApp(App)
  app.mount(host)
  await settle()
  const regular = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === 'open_project' && args.path === path) throw new Error('项目文件不存在')
    return regular(command, args)
  })
  host.querySelector<HTMLButtonElement>('.recent-project-list button')!.click()
  await settle()
  expect(host.querySelector('[role=alert]')?.textContent).toContain('项目文件不存在')
  expect(host.querySelector('.welcome')).not.toBeNull()
  expect(calls('save_project')).toHaveLength(0)
  expect(calls('create_project')).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem('knode-recent-projects')!)).toEqual([path])
  localStorage.removeItem('knode-recent-projects')
})

it('项目名替代路径，工具依次靠右，搜索按钮弹出浮层并支持点击外部关闭', async () => {
  await opened(undefined, false)
  expect(host.querySelector('.project-path')?.textContent?.trim()).toBe(parseProject(disk).name)
  expect(host.querySelector('.path-start,.path-middle')).toBeNull()
  expect(
    [...host.querySelectorAll('.title-tools button')].map((b) => b.getAttribute('aria-label')),
  ).toEqual(['撤销', '重做', '搜索节点', '切换深色模式', '设置'])
  expect(host.querySelector('.window-drag')?.nextElementSibling?.className).toBe('view-switch')
  expect(host.querySelector('.title-search')).toBeNull()
  button('搜索节点').click()
  await settle()
  expect(document.activeElement).toBe(host.querySelector('.title-search input'))
  expect(host.querySelector('.titlebar .title-search')).toBeNull()
  host.querySelector('.workspace')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await settle()
  expect(host.querySelector('.title-search')).toBeNull()
  expect(
    host.querySelector('.title-tools button[aria-label="设置"] svg circle')?.getAttribute('cx'),
  ).toBe('12')
})

it('内部文件复制失败不添加空节点、不污染历史，原项目可重试', async () => {
  await opened(undefined, false)
  files.set('root:', [entry('原件.txt')])
  const regular = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === 'copy_node_files') throw new Error('文件读取失败')
    return regular(cmd, args)
  })
  mock.canvasEmit!('select', 'root')
  await settle()
  shortcut('c')
  await settle()
  shortcut('v')
  await settle()
  expect(host.textContent).toContain('文件读取失败')
  expect(mock.canvasProps!.project.nodes).toHaveLength(1)
  expect(calls('save_project')).toHaveLength(0)
  expect(files.get('root:')).toHaveLength(1)
  mock.invoke.mockImplementation(regular)
  shortcut('v')
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes).toHaveLength(2)
})
it('带文件节点剪切只移动原 ID 一次，保留未选中后代与外部父关系', async () => {
  const p = createChild(
    createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 }),
    'child',
    'grand',
    '孙',
    { x: 800, y: 20 },
  )
  p.nodes[1].linkedPaths = ['../outside.txt']
  await opened(serializeProject(p), false)
  files.set('child:', [entry('笔记.md')])
  mock.canvasEmit!('select', 'child')
  await settle()
  shortcut('x')
  await settle()
  shortcut('v')
  await settle()
  await saveNow()
  const next = parseProject(disk)
  expect(next.nodes).toHaveLength(3)
  expect(next.nodes[1]).toMatchObject({
    id: 'child',
    parentId: 'root',
    linkedPaths: ['../outside.txt'],
  })
  expect(next.nodes[2].parentId).toBe('child')
  shortcut('v')
  await settle()
  await saveNow()
  expect(parseProject(disk)).toEqual(next)
  mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 800, y: 500 }, nodeId: null })
  await settle()
  expect(button('粘贴', host.querySelector('.context-menu')!).disabled).toBe(true)
  expect(calls('copy_node_files')).toHaveLength(0)
  expect(files.get('child:')).toHaveLength(1)
  shortcut('z')
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes).toEqual(p.nodes)
  expect(parseProject(disk).views.tree.positions).toEqual(p.views.tree.positions)
})

it('剪切粘贴前保存失败时保留原节点，修复写入后可重试一次', async () => {
  await opened(undefined, false)
  const regular = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async (cmd: string, args: any) => {
    if (cmd === 'save_project') throw new Error('项目暂不可写')
    return regular(cmd, args)
  })
  const originalPosition = { x: 25, y: 40 }
  mock.canvasEmit!('move', new Map([['root', originalPosition]]))
  mock.canvasEmit!('select', 'root')
  await settle()
  shortcut('x')
  shortcut('v')
  await settle()
  expect(host.textContent).toContain('项目暂不可写')
  expect(mock.canvasProps!.project.views.tree.positions.root).toEqual(originalPosition)

  const target = { x: 450, y: 275 }
  mock.canvasEmit!('context', { x: 10, y: 100, point: target, nodeId: null })
  await settle()
  const paste = button('粘贴', host.querySelector('.context-menu')!)
  expect(paste.disabled).toBe(false)
  mock.invoke.mockImplementation(regular)
  paste.click()
  await settle()
  await saveNow()
  expect(parseProject(disk).views.tree.positions).toEqual({ root: target })
  expect(parseProject(disk).nodes.map((n) => n.id)).toEqual(['root'])
  expect(calls('copy_node_files')).toHaveLength(0)
})

it('普通复制仅复制明确选中节点的文件及关联，重复粘贴使用独立ID；仅删父节点保留孩子', async () => {
  const p = createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 })
  p.nodes[0].linkedPaths = ['../external.txt']
  await opened(serializeProject(p), false)
  files.set('root:', [entry('父.txt')])
  files.set('child:', [entry('子.txt')])
  mock.canvasEmit!('select', 'root')
  await settle()
  shortcut('c')
  await settle()
  shortcut('v')
  await settle()
  await saveNow()
  const first = parseProject(disk).nodes[2]
  expect(parseProject(disk).nodes).toHaveLength(3)
  expect(first.linkedPaths).toEqual(['../external.txt'])
  expect(files.get(first.id + ':')?.[0].name).toBe('父.txt')
  expect(calls('copy_node_files')[0][1].pairs).toEqual([['root', first.id]])
  shortcut('v')
  await settle()
  await saveNow()
  const second = parseProject(disk).nodes[3]
  expect(second.id).not.toBe(first.id)
  expect(files.get(second.id + ':')).not.toBe(files.get(first.id + ':'))
  window.confirm = vi.fn(() => true)
  mock.canvasEmit!('select', 'root')
  await settle()
  mock.canvasEmit!('context', { x: 10, y: 100, point: { x: 0, y: 0 }, nodeId: 'root' })
  await settle()
  button('删除', host.querySelector('.context-menu')!).click()
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes.find((n) => n.id === 'child')?.parentId).toBeNull()
  expect(files.get('root:')).toHaveLength(1)
  expect(files.get('child:')).toHaveLength(1)
  shortcut('z')
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes.find((n) => n.id === 'child')?.parentId).toBe('root')
})

it('最近项目显示普通路径，打开时保留原始Win32路径', async () => {
  const slash = String.fromCharCode(92),
    visible = ['C:', '资料 空格', '项目.json'].join(slash)
  const originalPath = slash + slash + '?' + slash + visible
  app.unmount()
  localStorage.setItem('knode-recent-projects', JSON.stringify([originalPath]))
  app = createApp(App)
  app.mount(host)
  await settle()
  const recent = host.querySelector<HTMLButtonElement>('.recent-project-list button')!
  expect(recent.title).toBe(visible)
  expect(recent.querySelector('small')?.textContent).toBe(visible)
  recent.click()
  await settle()
  expect(mock.invoke).toHaveBeenCalledWith('open_project', {
    language: 'zh-CN',
    path: originalPath,
  })
  localStorage.removeItem('knode-recent-projects')
})

it('右键属性入口先保存目标ID再选中节点，能展开真实属性页', async () => {
  await opened(undefined, false)
  mock.canvasEmit!('context', { x: 40, y: 80, point: { x: 0, y: 0 }, nodeId: 'root' })
  await settle()
  button('属性', host.querySelector('.context-menu')!).click()
  await settle()
  expect(card().querySelector('.card-properties')).not.toBeNull()
  expect(host.querySelector('.context-menu')).toBeNull()
  expect(card().style.height).toBe('480px')
})
it('两视图的共同右键菜单顺序和分组一致，树只在有孩子时提供折叠和选择子树', async () => {
  let p = createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 })
  p = createChild(p, 'child', 'grandchild', '孙节点', { x: 800, y: 20 })
  await opened(serializeProject(p), false)
  const openMenu = async (nodeId: string) => {
    mock.canvasEmit!('context', { x: 40, y: 80, point: { x: 0, y: 0 }, nodeId })
    await settle()
    return host.querySelector<HTMLElement>('.context-menu')!
  }
  const common = ['无权重节点', '带权重节点', '文件', '属性', '重命名', '复制', '剪切', '删除']
  const multi = ['文件', '属性', '复制', '剪切', '删除']
  const labels = (menu: HTMLElement) =>
    [...menu.children].map((item) => item.firstChild?.textContent?.trim())
  mock.canvasEmit!('selection', ['root', 'child'])
  let menu = await openMenu('child')
  expect(mock.canvasProps!.selectedIds).toEqual(['root', 'child'])
  expect(labels(menu)).toEqual(multi)
  mock.canvasEmit!('selection', ['child'])
  menu = await openMenu('child')
  expect(labels(menu)).toEqual([...common, '折叠', '选择子树'])
  expect(
    [...menu.querySelectorAll(':scope > button > small')].slice(0, 2).map((el) => el.textContent),
  ).toEqual(['权重 0', '权重 1'])
  expect(
    [...menu.querySelectorAll('.menu-group-start')].map((el) => el.firstChild?.textContent?.trim()),
  ).toEqual(['文件', '复制', '折叠'])
  button('折叠', menu).click()
  await settle()
  menu = await openMenu('child')
  expect(labels(menu)).toEqual([...common, '展开', '选择子树'])
  button('选择子树', menu).click()
  await settle()
  expect(mock.canvasProps!.selectedIds).toEqual(['child', 'grandchild'])
  menu = await openMenu('root')
  expect(mock.canvasProps!.selectedIds).toEqual(['root'])
  button('折叠', menu).click()
  await settle()
  menu = await openMenu('root')
  button('选择子树', menu).click()
  await settle()
  expect(mock.canvasProps!.selectedIds).toEqual(['root', 'child', 'grandchild'])
  mock.canvasEmit!('selection', ['root'])
  menu = await openMenu('root')
  button('展开', menu).click()
  await settle()
  menu = await openMenu('child')
  button('展开', menu).click()
  await settle()
  menu = await openMenu('grandchild')
  expect(labels(menu)).toEqual(common)
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  host.querySelector('.workspace')!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)

  button('图视图').click()
  await settle()
  mock.canvasEmit!('selection', ['root', 'child'])
  menu = await openMenu('child')
  expect(labels(menu)).toEqual(multi)
  expect(mock.canvasProps!.selectedIds).toEqual(['root', 'child'])
  menu = await openMenu('grandchild')
  expect(mock.canvasProps!.selectedIds).toEqual(['grandchild'])
  expect(labels(menu)).toEqual(common)
  menu = await openMenu('root')
  expect(labels(menu)).toEqual(common)
  expect(
    [...menu.querySelectorAll('[aria-keyshortcuts]')].map((el) =>
      el.getAttribute('aria-keyshortcuts'),
    ),
  ).toEqual(['Control+C', 'Control+X', 'Delete'])
  expect(host.querySelector('.test-canvas .collapse-toggle')).toBeNull()
  await saveNow()
})

it.each(['tree', 'graph'] as const)(
  '%s 菜单复制、剪切及删除只处理所选节点，双视图共享删除和撤销结果',
  async (view) => {
    let p = createChild(parseProject(disk), 'root', 'child', '孩子', { x: 400, y: 20 })
    p = createRoot(p, 'other', '另一个根', { x: 0, y: 300 })
    p = withAllGraphNodes(p)
    p = addGraphEdge(p, { id: 'link', source: 'root', target: 'child', direction: 'forward' })
    await opened(serializeProject(p), false)
    if (view === 'graph') {
      button('图视图').click()
      await settle()
    }
    const openMultiMenu = async () => {
      mock.canvasEmit!('selection', ['root', 'other'])
      mock.canvasEmit!('context', { x: 40, y: 80, point: { x: 0, y: 0 }, nodeId: 'other' })
      await settle()
      expect(mock.canvasProps!.selectedIds).toEqual(['root', 'other'])
      return host.querySelector<HTMLElement>('.context-menu')!
    }
    button('复制', await openMultiMenu()).click()
    await settle()
    shortcut('v')
    await settle()
    await saveNow()
    let saved = parseProject(disk)
    expect(saved.nodes.slice(3).map((n) => n.title)).toEqual(['原始节点', '另一个根'])
    expect(
      calls('copy_node_files')[0][1].pairs.map(([source]: [string, string]) => source),
    ).toEqual(['root', 'other'])
    shortcut('z')
    await settle()

    button('剪切', await openMultiMenu()).click()
    await settle()
    expect(mock.canvasProps!.project.nodes.map((n: { id: string }) => n.id)).toEqual([
      'root',
      'child',
      'other',
    ])
    shortcut('v')
    await settle()
    await saveNow()
    saved = parseProject(disk)
    expect(saved.nodes.map((n) => n.id)).toEqual(['root', 'child', 'other'])
    expect(saved.views[view].positions.root).not.toEqual(p.views[view].positions.root)
    expect(saved.views[view].positions.other).not.toEqual(p.views[view].positions.other)
    expect(saved.views[view].positions.child).toEqual(p.views[view].positions.child)
    expect(saved.nodes[1].parentId).toBe('root')

    shortcut('v')
    await settle()
    await saveNow()
    expect(parseProject(disk)).toEqual(saved)
    expect(calls('copy_node_files')).toHaveLength(1)

    const menu = await openMultiMenu()
    window.confirm = vi.fn(() => true)
    if (view === 'tree') button('删除', menu).click()
    else shortcut('Delete')
    await settle()
    await saveNow()
    saved = parseProject(disk)
    expect(saved.nodes.map((n) => [n.id, n.parentId])).toEqual([['child', null]])
    expect(Object.keys(saved.views.tree.positions)).toEqual(['child'])
    expect(Object.keys(saved.views.graph.positions)).toEqual(['child'])
    expect(saved.views.graph.edges).toEqual([])
    shortcut('z')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes[1].parentId).toBe('root')
    expect(parseProject(disk).views.graph.edges).toEqual(p.views.graph.edges)
    shortcut('y')
    await settle()
    await saveNow()
    expect(parseProject(disk).nodes.map((n) => n.id)).toEqual(['child'])
  },
)
it('主题按钮在搜索和设置之间，切换后持久化且不修改项目', async () => {
  await opened(undefined, false)
  const before = disk
  button('切换深色模式').click()
  await settle()
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(localStorage.getItem('knode-theme')).toBe('dark')
  expect(host.querySelector('.theme-toggle')?.getAttribute('aria-label')).toBe('切换浅色模式')
  expect(disk).toBe(before)
  expect(calls('save_project')).toHaveLength(0)
  button('切换浅色模式').click()
  await settle()
  expect(document.documentElement.dataset.theme).toBe('light')
})

it('卡片按钮、属性控件及文件空白区右键不显示WebView菜单，文字编辑菜单保留', async () => {
  await opened(undefined, false)
  const check = (element: Element, prevented = true) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    expect(event.defaultPrevented, element.className).toBe(prevented)
  }
  for (const name of ['文件', '属性']) check(button(name, card()))
  button('属性', card()).click()
  await settle()
  for (const selector of [
    '.card-editor',
    '.card-tabs',
    '.card-properties',
    '.color-body',
    '.color-presets button',
    'input[type=range]',
  ]) {
    check(card().querySelector(selector)!)
  }
  expect(card().querySelector('.color-heading input')).toBeNull()
  expect(card().querySelector('.color-hex')?.textContent).toBe(DEFAULT_NODE_COLOR)
  check(card().querySelector('.color-hex')!)
  check(card().querySelector('.card-properties input')!, false)
  button('文件', card()).click()
  await settle()
  for (const selector of [
    '.file-section-heading',
    '.section-tools button',
    '.section-list',
    '[role=tree]',
  ]) {
    check(card().querySelector(selector)!)
  }
  check(host.querySelector('.titlebar')!)
  check(host.querySelector('.theme-toggle')!)
  check(host.querySelector('.workspace')!)
  button('设置').click()
  await settle()
  check(host.querySelector('.settings-dialog')!)
  check(host.querySelector('.settings-layout nav button')!)
})
it('主题图标显示当前模式，浅色太阳、深色月亮，切换提示仍指向目标模式', async () => {
  expect(host.querySelector('.theme-toggle svg circle')).not.toBeNull()
  button('切换深色模式').click()
  await settle()
  expect(host.querySelector('.theme-toggle svg circle')).toBeNull()
  expect(host.querySelector('.theme-toggle')?.getAttribute('title')).toBe('切换浅色模式')
})

it('快速文件属性切换只替换面板内容，保留标题进度DOM、固定尺寸和项目数据', async () => {
  await opened(undefined, false)
  const title = card().querySelector('.card-titlebar')
  const progress = card().querySelector('.card-progress-slot')
  const original = disk
  for (let i = 0; i < 6; i++) {
    button(i % 2 ? '属性' : '文件', card()).click()
    await settle()
    expect(card().style.width).toBe('340px')
    expect(card().style.height).toBe('480px')
    expect(card().querySelector('.card-titlebar')).toBe(title)
    expect(card().querySelector('.card-progress-slot')).toBe(progress)
    expect(card().querySelectorAll('.card-content')).toHaveLength(1)
    expect(card().querySelectorAll('.card-properties')).toHaveLength(i % 2 ? 1 : 0)
  }
  expect(disk).toBe(original)
  expect(calls('save_project')).toHaveLength(0)
  button('设置').click()
  await settle()
  button('动画', host.querySelector('.settings-dialog')!).click()
  await settle()
  const fold = host.querySelector<HTMLInputElement>('.setting-check input')!
  fold.checked = false
  fold.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(host.querySelector('.app-shell')?.classList.contains('static-ui')).toBe(true)
  expect(mock.canvasProps!.foldAnimation).toBe(false)
  expect(host.querySelector('.settings-backdrop')?.classList.contains('settings-static')).toBe(
    false,
  )
  localStorage.removeItem('forest-fold-animation')
})

it('最近项目可逐项移除且重启保留，不打开项目或调用文件接口；主页设置入口可用', async () => {
  app.unmount()
  const paths = ['C:/samples/one.json', 'C:/samples/two.json']
  localStorage.setItem('knode-recent-projects', JSON.stringify(paths))
  app = createApp(App)
  app.mount(host)
  await settle()
  mock.invoke.mockClear()
  host.querySelector<HTMLButtonElement>('.recent-project-remove')!.click()
  await settle()
  expect(JSON.parse(localStorage.getItem('knode-recent-projects')!)).toEqual([paths[1]])
  expect(host.querySelectorAll('.recent-project-row')).toHaveLength(1)
  expect(mock.invoke).not.toHaveBeenCalled()
  app.unmount()
  app = createApp(App)
  app.mount(host)
  await settle()
  expect(host.querySelector('.recent-project-open')?.getAttribute('title')).toBe(paths[1])
  host.querySelector<HTMLButtonElement>('.recent-project-remove')!.click()
  await settle()
  expect(host.querySelector('.recent-project-list')).toBeNull()
  expect(host.querySelector('.recent-projects')?.textContent).toContain('暂无记录')
  const tools = [...host.querySelectorAll('.title-tools button')].map((b) =>
    b.getAttribute('aria-label'),
  )
  expect(tools).toEqual(['切换深色模式', '设置'])
  button('设置').click()
  await settle()
  expect(host.querySelector('.settings-dialog')).not.toBeNull()
  localStorage.removeItem('knode-recent-projects')
})

it('V3 应用层加载、自动保存、导航及撤销保留隐藏图数据，重新打开不退回旧格式', async () => {
  let p = addToGraph(parseProject(original()), 'root', { x: 1600, y: -40 })
  p = addGraphEdge(p, { id: 'self', source: 'root', target: 'root', direction: 'both' })
  disk = serializeProject(p)
  await opened(disk, false)
  mock.canvasEmit!('move', new Map([['root', { x: 300, y: 400 }]]))
  mock.canvasEmit!('viewport', { x: 42, y: -80, zoom: 0.75 })
  await saveNow()
  expect(parseProject(disk).views.graph).toEqual(p.views.graph)
  expect(parseProject(disk).views.tree.positions.root).toEqual({ x: 300, y: 400 })
  expect(parseProject(disk).views.tree.viewport.zoom).toBe(0.75)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
  await settle()
  await saveNow()
  expect(parseProject(disk).views.tree.positions.root).toEqual(p.views.tree.positions.root)
  expect(parseProject(disk).views.tree.viewport.zoom).toBe(0.75)
  await opened(disk, false)
  expect(mock.canvasProps?.project.views.graph).toEqual(p.views.graph)
  expect(parseProject(disk).version).toBe(3)
})

it('About 确认更新时先保存项目，写入失败时阻止安装并允许重试', async () => {
  await opened(disk, false)
  const nativeInvoke = mock.invoke.getMockImplementation()!
  let failSave = true
  const newPosition = { x: 120, y: 80 }
  mock.invoke.mockImplementation(async (command: string, args: unknown) => {
    if (command === 'updates_configured') return true
    if (command === 'save_project' && failSave) throw new Error('测试保存失败')
    return nativeInvoke(command, args)
  })
  const downloadAndInstall = vi.fn(async () => {
    expect(parseProject(disk).views.tree.positions.root).toEqual(newPosition)
  })
  mock.checkUpdate.mockResolvedValue({
    version: '0.2.0',
    downloadAndInstall,
    close: async () => {},
  })
  mock.canvasEmit!('move', new Map([['root', newPosition]]))
  await settle()
  button('设置').click()
  await settle()
  button('关于').click()
  await settle()
  button('检查更新').click()
  await vi.waitFor(() =>
    expect(host.querySelector('.about-update')?.textContent).toContain('0.2.0'),
  )
  button('下载安装').click()
  await settle()
  expect(host.querySelector('.about-update')?.textContent).toContain('测试保存失败')
  expect(downloadAndInstall).not.toHaveBeenCalled()
  failSave = false
  button('下载安装').click()
  await settle()
  expect(downloadAndInstall).toHaveBeenCalledOnce()
  expect(host.querySelector('.settings-dialog')).toBeNull()
})

it('图视图创建无向边，保存并重新打开后保留方向', async () => {
  const p = createChild(parseProject(original()), 'root', 'child', '子节点', { x: 400, y: 0 })
  await opened(serializeProject(p), false)
  button('图视图').click()
  await settle()
  mock.canvasEmit!('graphConnect', 'root', 'child', 'undirected')
  mock.canvasEmit!('graphConnect', 'child', 'root', 'forward')
  await settle()
  await saveNow()
  const expectDirections = (project: typeof p) =>
    expect(project.views.graph.edges.map((edge) => edge.direction)).toEqual([
      'undirected',
      'forward',
    ])
  expectDirections(parseProject(disk))

  app.unmount()
  app = createApp(App, { view: 'graph' })
  app.mount(host)
  await settle()
  await opened(disk, false)
  expectDirections(mock.canvasProps!.project)
})

it('同一应用控制器图模式编辑只写图：自环、重接、断开、拖动及撤销均不破坏真实节点', async () => {
  app.unmount()
  app = createApp(App, { view: 'graph' })
  app.mount(host)
  await settle()
  let p = addToGraph(parseProject(original()), 'root', { x: 1600, y: -40 })
  p = createChild(p, 'root', 'child', '树子节点', { x: 400, y: 0 })
  p = addToGraph(p, 'child', { x: -600, y: 400 })
  disk = serializeProject(p)
  await opened(disk, false)
  mock.canvasEmit!('graphConnect', 'root', 'root')
  await settle()
  await saveNow()
  let saved = parseProject(disk)
  expect(saved.views.graph.edges[0]).toMatchObject({
    source: 'root',
    target: 'root',
    direction: 'forward',
  })
  expect(saved.nodes).toEqual(p.nodes)
  const edgeId = saved.views.graph.edges[0].id
  mock.canvasEmit!('graphReconnect', edgeId, 'child', 'root')
  await settle()
  await saveNow()
  expect(parseProject(disk).views.graph.edges[0]).toMatchObject({ source: 'child', target: 'root' })
  mock.canvasEmit!('move', new Map([['root', { x: -800, y: 500 }]]))
  mock.canvasEmit!('viewport', { x: 90, y: -30, zoom: 1.8 })
  await settle()
  await saveNow()
  saved = parseProject(disk)
  expect(saved.views.tree).toEqual(p.views.tree)
  expect(saved.views.graph.positions.root).toEqual({ x: -800, y: 500 })
  expect(saved.views.graph.viewport.zoom).toBe(1.8)
  mock.canvasEmit!('context', {
    x: 30,
    y: 50,
    point: { x: 0, y: 0 },
    nodeId: null,
    graphEdgeId: edgeId,
  })
  await settle()
  button('断开连接').click()
  await settle()
  await saveNow()
  expect(parseProject(disk).views.graph.edges).toEqual([])
  expect(parseProject(disk).nodes[1].parentId).toBe('root')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
  await settle()
  await saveNow()
  expect(parseProject(disk).views.graph.edges).toHaveLength(1)
  mock.canvasEmit!('select', 'root')
  mock.canvasEmit!('context', { x: 30, y: 50, point: { x: 0, y: 0 }, nodeId: 'root' })
  await settle()
  expect(host.querySelector('.context-menu')?.textContent).not.toContain('移出图视图')
  expect(host.querySelector('.context-menu')?.textContent).toContain('删除')
  host.querySelector('.workspace')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await settle()
  expect(host.querySelector('.context-menu')).toBeNull()
  expect(parseProject(disk).views.graph.positions.root).toEqual({ x: -800, y: 500 })
  expect(parseProject(disk).views.graph.edges).toHaveLength(1)
  await opened(disk, false)
  expect(mock.canvasProps?.project.views.graph.viewport.zoom).toBe(1.8)
})

it('图模式创建真实根，树图共享文件入口；旧版本打开失败保留当前项目及原磁盘', async () => {
  app.unmount()
  app = createApp(App, { view: 'graph' })
  app.mount(host)
  await settle()
  await opened(disk, false)
  mock.canvasEmit!('context', { x: 20, y: 80, point: { x: 700, y: 900 }, nodeId: null })
  await settle()
  button('带权重节点').click()
  await settle()
  input('图新节点')
  host
    .querySelector('form.modal')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  await saveNow()
  const p = parseProject(disk),
    n = p.nodes.find((n) => n.title === '图新节点')!
  expect(n.parentId).toBeNull()
  expect(p.views.tree.positions[n.id]).toBeDefined()
  expect(p.views.graph.positions[n.id]).toEqual({ x: 700, y: 900 })
  const current = mock.canvasProps!.project
  disk = JSON.stringify({ format: 'forest-project', schemaVersion: 2, nodes: [] })
  const legacy = disk
  host.querySelector<HTMLButtonElement>('.app-menu-trigger')!.click()
  await settle()
  button('打开项目').click()
  await settle()
  expect(host.textContent).toContain('仅支持 V3')
  expect(mock.canvasProps!.project).toBe(current)
  expect(disk).toBe(legacy)
})

it('同一项目在两种投影间切换，各自视口与坐标恢复，共用历史只撤销最近一次编辑', async () => {
  app.unmount()
  const mode = ref<'tree' | 'graph'>('tree')
  app = createApp({ render: () => h(App, { view: mode.value }) })
  app.mount(host)
  await settle()
  const p = addToGraph(parseProject(original()), 'root', { x: 1500, y: -100 })
  await opened(serializeProject(p), false)
  mock.canvasEmit!('move', new Map([['root', { x: 30, y: 40 }]]))
  mock.canvasEmit!('viewport', { x: 15, y: -25, zoom: 0.6 })
  await settle()
  await saveNow()
  mode.value = 'graph'
  await settle()
  expect(mock.canvasProps!.view).toBe('graph')
  mock.canvasEmit!('move', new Map([['root', { x: -400, y: 900 }]]))
  mock.canvasEmit!('viewport', { x: -600, y: 70, zoom: 1.7 })
  await settle()
  await saveNow()
  mode.value = 'tree'
  await settle()
  expect(mock.canvasProps!.project.views.tree.viewport.zoom).toBe(0.6)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
  await settle()
  await saveNow()
  let saved = parseProject(disk)
  expect(saved.views.tree.positions.root).toEqual({ x: 30, y: 40 })
  expect(saved.views.graph.positions.root).toEqual({ x: 1500, y: -100 })
  expect(saved.views.tree.viewport.zoom).toBe(0.6)
  expect(saved.views.graph.viewport.zoom).toBe(1.7)
  mode.value = 'graph'
  await settle()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }))
  await settle()
  await saveNow()
  saved = parseProject(disk)
  expect(saved.views.graph.positions.root).toEqual({ x: -400, y: 900 })
  expect(saved.views.tree.positions.root).toEqual({ x: 30, y: 40 })
})

it('标题栏视图按钮在主页隐藏，点击切换保持各自布局和视口且不标脏，跨视图撤销仍共用历史', async () => {
  expect(host.querySelector('.view-switch')).toBeNull()
  const p = addToGraph(parseProject(original()), 'root', { x: 1500, y: -100 })
  p.views.tree.viewport = { x: 15, y: 25, zoom: 0.6 }
  p.views.graph.viewport = { x: -900, y: 600, zoom: 1.7 }
  await opened(serializeProject(p), false)
  const saves = calls('save_project').length
  expect(button('树视图').getAttribute('aria-pressed')).toBe('true')
  expect(button('图视图').closest('[data-tauri-drag-region]')).toBeNull()
  button('图视图').click()
  await settle()
  expect(mock.canvasProps!.view).toBe('graph')
  expect(button('图视图').getAttribute('aria-pressed')).toBe('true')
  expect(button('树视图').getAttribute('aria-pressed')).toBe('false')
  expect(mock.canvasProps!.project.views.graph.viewport.zoom).toBe(1.7)
  expect(calls('save_project')).toHaveLength(saves)
  expect(host.querySelector('.unsaved-star')).toBeNull()
  // A late move-end from the outgoing canvas cannot overwrite the incoming view.
  mock.canvasEmit!('viewport', { x: 15, y: 25, zoom: 0.6 }, 'tree')
  await settle()
  expect(mock.canvasProps!.project.views.graph.viewport.zoom).toBe(1.7)
  mock.canvasEmit!('move', new Map([['root', { x: -400, y: 900 }]]))
  await settle()
  await saveNow()
  button('树视图').click()
  await settle()
  expect(mock.canvasProps!.view).toBe('tree')
  expect(mock.canvasProps!.project.views.tree.positions.root).toEqual(p.views.tree.positions.root)
  expect(mock.canvasProps!.project.views.tree.viewport.zoom).toBe(0.6)
  button('撤销').click()
  await settle()
  await saveNow()
  expect(parseProject(disk).views.graph.positions.root).toEqual({ x: 1500, y: -100 })
  button('重做').click()
  await settle()
  await saveNow()
  expect(parseProject(disk).views.graph.positions.root).toEqual({ x: -400, y: 900 })
  expect(parseProject(disk).views.tree.positions.root).toEqual(p.views.tree.positions.root)
  expect(disk).not.toContain('activeView')
})

it('打开旧 V3 时补齐图节点，保留原图布局，首次保存落盘而且不产生撤销步骤', async () => {
  let p = createChild(parseProject(disk), 'root', 'child', '旧树节点', { x: 20, y: 50 })
  p = addToGraph(p, 'root', { x: 1000, y: 800 })
  p = addGraphEdge(p, { id: 'loop', source: 'root', target: 'root', direction: 'both' })
  p.views.graph.viewport = { x: 40, y: -20, zoom: 1.4 }
  p.views.tree.collapsedIds = ['root']
  await opened(serializeProject(p), false)
  expect(parseProject(disk)).toEqual(p)
  expect(calls('save_project')).toHaveLength(0)
  expect(button('撤销').disabled).toBe(true)
  button('图视图').click()
  await settle()
  expect(host.querySelectorAll('.integrated-card')).toHaveLength(2)
  expect(host.querySelector('.canvas-empty')).toBeNull()
  expect(host.querySelector('[aria-label="添加已有节点"]')).toBeNull()
  await saveNow()
  const saved = parseProject(disk)
  expect(saved.nodes).toEqual(p.nodes)
  expect(saved.views.tree).toEqual(p.views.tree)
  expect(saved.views.graph.positions.child).toEqual({ x: 20, y: 50 })
  expect(saved.views.graph.positions.root).toEqual(p.views.graph.positions.root)
  expect(saved.views.graph.edges).toEqual(p.views.graph.edges)
  expect(saved.views.graph.viewport).toEqual(p.views.graph.viewport)
  await opened(disk, false)
  expect(mock.canvasProps!.project).toEqual(saved)
})

it('树中创建和粘贴自动出现在图中，图中改名和树中删除对两侧生效', async () => {
  await opened(disk, false)
  mock.canvasEmit!('select', 'root')
  mock.canvasEmit!('context', { x: 30, y: 80, point: { x: 300, y: 120 }, nodeId: 'root' })
  await settle()
  button('带权重节点').click()
  await settle()
  input('同步测试节点')
  host
    .querySelector('form.modal')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  await saveNow()
  const created = parseProject(disk)
  const node = created.nodes.find((n) => n.title === '同步测试节点')!
  expect(node.parentId).toBe('root')
  expect(Object.keys(created.views.graph.positions)).toEqual(['root', node.id])
  expect(created.views.graph.edges).toEqual([])

  shortcut('c')
  shortcut('v')
  await settle()
  await saveNow()
  const pasted = parseProject(disk)
  expect(Object.keys(pasted.views.graph.positions)).toHaveLength(3)
  shortcut('z')
  await settle()
  button('图视图').click()
  await settle()
  expect(host.querySelectorAll('.integrated-card')).toHaveLength(2)
  mock.canvasEmit!('select', node.id)
  mock.canvasEmit!('context', { x: 30, y: 80, point: { x: 300, y: 120 }, nodeId: node.id })
  await settle()
  button('重命名', host.querySelector('.context-menu')!).click()
  await settle()
  input('图中修改')
  host
    .querySelector('form.modal')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  button('树视图').click()
  await settle()
  expect(host.querySelector('.test-canvas')?.textContent).toContain('图中修改')

  window.confirm = vi.fn(() => true)
  mock.canvasEmit!('select', node.id)
  shortcut('Delete')
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes.some((n) => n.id === node.id)).toBe(false)
  expect(parseProject(disk).views.graph.positions[node.id]).toBeUndefined()
  shortcut('z')
  await settle()
  await saveNow()
  expect(parseProject(disk).views.graph.positions[node.id]).toEqual(
    created.views.graph.positions[node.id],
  )
})
it('属性和进度交互过程中禁用视图切换，语言切换翻译按钮', async () => {
  await opened(disk, false)
  mock.canvasEmit!('progressStart', 'root')
  await settle()
  expect(button('图视图').disabled).toBe(true)
  button('图视图').click()
  await settle()
  expect(mock.canvasProps!.view).toBe('tree')
  mock.canvasEmit!('progressCancel', 'root')
  await settle()
  expect(button('图视图').disabled).toBe(false)
  setLanguage('en')
  await settle()
  expect(button('Tree view').getAttribute('aria-pressed')).toBe('true')
  button('Graph view').click()
  await settle()
  expect(mock.canvasProps!.view).toBe('graph')
})

function layoutWorkerMock(failure = false, ready = Promise.resolve()) {
  const postLayout = vi.fn<(input: LayoutInput) => void>()
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((e: MessageEvent) => void) | null = null
      onerror: ((e: ErrorEvent) => void) | null = null
      postMessage(input: LayoutInput) {
        postLayout(input)
        void ready.then(() => {
          if (failure) {
            this.onmessage?.({ data: { error: '测试布局失败' } } as MessageEvent)
            return
          }
          if (input.view === 'tree') {
            this.onmessage?.({ data: { positions: calculateLayout(input) } } as MessageEvent)
            return
          }
          // Mock worker transport. Real ELK geometry is tested in layout.test.ts.
          const positions = Object.fromEntries(
            input.nodes.map((node, index) => [node.id, { x: 40 + index * 440, y: 40 }]),
          )
          this.onmessage?.({ data: { positions } } as MessageEvent)
        })
      }
      terminate() {}
    },
  )
  return postLayout
}
it.each(['tree', 'graph'] as const)(
  '%s 空白菜单精简，剪贴板禁用和 Ctrl+A 保持正常',
  async (view) => {
    const p = createChild(parseProject(disk), 'root', 'child', '孩子', { x: 80, y: 180 })
    await opened(serializeProject(p), false)
    if (view === 'graph') {
      button('图视图').click()
      await settle()
    }
    const openPaneMenu = async () => {
      mock.canvasEmit!('context', { x: 40, y: 80, point: { x: 1, y: 2 }, nodeId: null })
      await settle()
      return host.querySelector<HTMLElement>('.context-menu')!
    }
    const menu = await openPaneMenu()
    expect([...menu.children].map((row) => row.firstChild?.textContent?.trim())).toEqual([
      '无权重节点',
      '带权重节点',
      '粘贴',
    ])
    const paste = button('粘贴', menu)
    expect(paste.disabled).toBe(true)
    expect(paste.classList.contains('menu-group-start')).toBe(true)
    expect(paste.querySelector('small')?.textContent).toBe('Ctrl+V')
    shortcut('a')
    await settle()
    expect(mock.canvasProps!.selectedIds).toEqual(['root', 'child'])
    shortcut('c')
    await settle()
    expect(button('粘贴', await openPaneMenu()).disabled).toBe(false)
  },
)

it.each(['tree', 'graph'] as const)(
  '%s 多选文件和属性打开及收起选中卡片，混合状态同步打开',
  async (view) => {
    let p = createChild(parseProject(disk), 'root', 'child', '孩子', { x: 0, y: 160 })
    p = createChild(p, 'child', 'hidden', '孙节点', { x: 0, y: 320 })
    p = createRoot(p, 'outside', '未选中', { x: 500, y: 80 })
    p = withAllGraphNodes(p)
    p.views.tree.collapsedIds = ['child']
    await opened(serializeProject(p), false)
    if (view === 'graph') {
      button('图视图').click()
      await settle()
    }
    const ids = ['root', 'child', 'hidden']
    for (const id of ids) files.set(`${id}:`, [entry(`${id}.txt`)])
    mock.canvasEmit!('selection', ids)
    const menu = async () => {
      mock.canvasEmit!('context', { x: 50, y: 90, point: { x: 0, y: 0 }, nodeId: 'root' })
      await settle()
      return host.querySelector<HTMLElement>('.context-menu')!
    }
    button('文件', await menu()).click()
    await settle()
    for (const id of ids) expect(row(`${id}.txt`, card(id))).toBeTruthy()
    expect(card('outside').querySelector('.card-content')).toBeNull()
    expect(mock.canvasProps!.selectedIds).toEqual(ids)
    expect(mock.fit).toHaveBeenLastCalledWith(ids)
    expect(mock.canvasProps!.project.views.tree.collapsedIds).toEqual(
      view === 'tree' ? [] : ['child'],
    )
    const countBeforeClose = mock.fit.mock.calls.length
    button('文件', await menu()).click()
    await settle()
    for (const id of ids) expect(card(id).querySelector('.card-content')).toBeNull()
    expect(mock.fit).toHaveBeenCalledTimes(countBeforeClose)

    button('属性', card('child')).click()
    button('文件', card('outside')).click()
    await settle()
    button('属性', await menu()).click()
    await settle()
    for (const id of ids)
      expect(card(id).querySelector('.card-properties .color-hex')).not.toBeNull()
    expect(card('outside').querySelector('.card-files')).not.toBeNull()
    button('属性', await menu()).click()
    await settle()
    for (const id of ids) expect(card(id).querySelector('.card-content')).toBeNull()
    expect(card('outside').querySelector('.card-files')).not.toBeNull()
    expect(mock.canvasProps!.selectedIds).toEqual(ids)
    await saveNow()
    expect(parseProject(disk).views.tree.positions).toEqual(p.views.tree.positions)
    expect(parseProject(disk).views.graph.positions).toEqual(p.views.graph.positions)
  },
)

it('多选颜色复用属性色轮，颜色独立保存和撤销，取消预览不写盘', async () => {
  let p = createChild(parseProject(disk), 'root', 'a', '孩子 A', { x: 450, y: 20 })
  p = createChild(p, 'root', 'b', '孩子 B', { x: 900, y: 20 })
  p = createChild(p, 'a', 'untouched', '未选后代', { x: 980, y: 200 })
  p.nodes[0].color = '#123456'
  p.nodes[1].color = null
  p.nodes[2].color = '#abcdef'
  p.nodes[3].color = null
  await opened(serializeProject(withAllGraphNodes(p)), false)
  mock.canvasEmit!('selection', ['a', 'b'])
  await settle()
  const trigger = button('选区强调色')
  expect(host.querySelector('.batch-color input[type="color"]')).toBeNull()
  trigger.click()
  await settle()
  const popup = () => host.querySelector<HTMLElement>('.batch-color-popover')!
  expect(popup().querySelector('.hsv-disk')).not.toBeNull()
  expect(popup().querySelectorAll('.color-presets button')).toHaveLength(9)
  expect(popup().querySelector('.color-heading input')).toBeNull()
  expect(popup().querySelector('.color-swatch')).not.toBeNull()
  expect(popup().querySelector('.color-hex')?.textContent).toBe('#123456')
  expect(document.activeElement).toBe(popup())
  const brightness = field('input[type="range"]', '91', popup(), false)
  await settle()
  expect(mock.canvasProps!.colorPreview?.ids).toEqual(['a', 'b'])
  expect(
    mock.canvasProps!.project.nodes.map((node: { color: string | null }) => node.color),
  ).toEqual(['#123456', '#123456', '#abcdef', '#123456'])
  expect(card('untouched').style.getPropertyValue('--node-color')).toBe('#123456')
  brightness.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  expect(popup()).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(mock.canvasProps!.colorPreview).toBeNull()
  expect(calls('save_project')).toHaveLength(0)

  trigger.click()
  await settle()
  button('预设颜色 #6599cb', popup()).click()
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes.map((node) => node.color)).toEqual([
    '#123456',
    '#6599cb',
    '#6599cb',
    '#123456',
  ])
  button('撤销').click()
  await settle()
  await saveNow()
  expect(parseProject(disk).nodes.map((node) => node.color)).toEqual([
    '#123456',
    '#123456',
    '#abcdef',
    '#123456',
  ])
  await opened(disk, false)
  expect(card('a').style.getPropertyValue('--node-color')).toBe('#123456')
  expect(card('b').style.getPropertyValue('--node-color')).toBe('#abcdef')
})
it('整理期间暂时锁定顶栏，正常可用的按钮保持原有亮度，空历史按钮仍置灰', async () => {
  let finish!: () => void
  layoutWorkerMock(false, new Promise<void>((resolve) => (finish = resolve)))
  try {
    await opened(disk, false)
    mock.canvasEmit!('move', new Map([['root', { x: 420, y: 240 }]]))
    await settle()
    const stableControls = [
      button('树视图'),
      button('图视图'),
      layoutDirectionButton(),
      button('撤销'),
      button('搜索节点'),
    ]
    const redo = button('重做')
    const arrange = button('整理布局')
    expect(stableControls.every((control) => !control.disabled)).toBe(true)
    expect(redo.disabled).toBe(true)
    arrange.click()
    await settle()
    expect(host.querySelector('.titlebar.layout-running')).not.toBeNull()
    expect(arrange.disabled).toBe(true)
    expect(arrange.getAttribute('aria-busy')).toBe('true')
    expect(
      stableControls.every(
        (control) => control.disabled && control.hasAttribute('data-layout-lock'),
      ),
    ).toBe(true)
    expect(redo.hasAttribute('data-layout-lock')).toBe(false)
    finish()
    await settle()
    expect(host.querySelector('.titlebar.layout-running')).toBeNull()
    expect(stableControls.every((control) => !control.disabled)).toBe(true)
    expect(redo.disabled).toBe(true)
  } finally {
    finish()
    vi.unstubAllGlobals()
  }
})
it('方向仅修改应用偏好，树图分别记忆；树整理单步撤销重做、保存重开，不改另一个视图', async () => {
  const postLayout = layoutWorkerMock()
  try {
    let p = createChild(parseProject(original()), 'root', 'child', '孩子', { x: 0, y: 0 })
    p = createChild(p, 'root', 'child2', '孩子2', { x: 0, y: 0 })
    p = withAllGraphNodes(addToGraph(p, 'root', { x: 4000, y: 3000 }))
    await opened(serializeProject(p), false)
    const originalDocument = mock.canvasProps!.project
    const select = layoutDirectionButton
    await chooseLayoutDirection('LR')
    await settle()
    expect(mock.canvasProps!.project).toBe(originalDocument)
    expect(calls('save_project')).toHaveLength(0)
    button('图视图').click()
    await settle()
    expect(select().dataset.value).toBe('TB')
    await chooseLayoutDirection('RL')
    await settle()
    button('树视图').click()
    await settle()
    expect(select().dataset.value).toBe('LR')
    button('整理布局').click()
    await settle()
    await saveNow()
    const arranged = parseProject(disk)
    expect(arranged.nodes).toEqual(p.nodes)
    expect(arranged.views.graph).toEqual(p.views.graph)
    expect(arranged.views.tree.positions.child.x).toBeGreaterThan(
      arranged.views.tree.positions.root.x,
    )
    expect(arranged.views.tree.positions.child2.x).toBe(arranged.views.tree.positions.child.x)
    expect(arranged.views.tree.positions.child2.y).not.toBe(arranged.views.tree.positions.child.y)
    expect(mock.fit).toHaveBeenCalledOnce()
    const saves = calls('save_project').length
    button('整理布局').click()
    await settle()
    expect(postLayout).toHaveBeenCalledOnce()
    expect(mock.fit).toHaveBeenCalledOnce()
    expect(calls('save_project')).toHaveLength(saves)
    button('撤销').click()
    await settle()
    await saveNow()
    expect(parseProject(disk)).toEqual(p)
    expect(button('撤销').disabled).toBe(true)
    button('重做').click()
    await settle()
    await saveNow()
    expect(parseProject(disk)).toEqual(arranged)
    await opened(disk, false)
    expect(mock.canvasProps!.project.views.tree.positions).toEqual(arranged.views.tree.positions)
    button('整理布局').click()
    await settle()
    expect(postLayout).toHaveBeenCalledTimes(2)
    expect(mock.fit).toHaveBeenCalledOnce()
    app.unmount()
    app = createApp(App)
    app.mount(host)
    await settle()
    await opened(disk, false)
    expect(select().dataset.value).toBe('LR')
    button('图视图').click()
    await settle()
    expect(select().dataset.value).toBe('RL')
  } finally {
    vi.unstubAllGlobals()
    localStorage.removeItem('knode-layout-directions')
  }
})
it('图整理按选定方向处理循环，自动保存并可撤销，保留树层级和业务数据', async () => {
  const postLayout = layoutWorkerMock()
  vi.useFakeTimers()
  try {
    let p = createChild(parseProject(original()), 'root', 'child', '孩子', { x: 0, y: 0 })
    p = addToGraph(addToGraph(p, 'root', { x: 0, y: 0 }), 'child', { x: 0, y: 0 })
    p = addGraphEdge(p, { id: 'loop', source: 'root', target: 'root', direction: 'forward' })
    p = addGraphEdge(p, { id: 'both', source: 'root', target: 'child', direction: 'both' })
    await opened(serializeProject(p), false)
    button('图视图').click()
    await settle()
    await chooseLayoutDirection('RL')
    button('整理布局').click()
    await settle()
    expect(postLayout).toHaveBeenCalledWith(expect.objectContaining({ direction: 'RL' }))
    expect(calls('save_project')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(800)
    await settle()
    expect(calls('save_project')).toHaveLength(1)
    const next = parseProject(disk)
    expect(next.views.tree).toEqual(p.views.tree)
    expect(next.nodes).toEqual(p.nodes)
    expect(next.views.graph.edges).toEqual(p.views.graph.edges)
    expect(Object.keys(next.views.graph).sort()).toEqual(['edges', 'positions', 'viewport'])
    expect(next.views.graph.positions.root).not.toEqual(next.views.graph.positions.child)
    button('撤销').click()
    await settle()
    await saveNow()
    expect(parseProject(disk)).toEqual(p)
    expect(button('撤销').disabled).toBe(true)
  } finally {
    vi.unstubAllGlobals()
    localStorage.removeItem('knode-layout-directions')
  }
})
it('树和图分别记住整理结果，切换视图后重复整理不再发起工作或写盘', async () => {
  const worker = layoutWorkerMock()
  try {
    let p = createChild(parseProject(disk), 'root', 'child', '孩子', { x: 0, y: 0 }, 0)
    p = withAllGraphNodes(p)
    p = addGraphEdge(p, { id: 'ab', source: 'root', target: 'child', direction: 'forward' })
    await opened(serializeProject(p), false)
    button('整理布局').click()
    await settle()
    button('图视图').click()
    await settle()
    button('整理布局').click()
    await settle()
    await saveNow()
    expect(worker.mock.calls.map(([input]) => input.view)).toEqual(['tree', 'graph'])
    const saved = disk,
      saves = calls('save_project').length
    for (const name of ['树视图', '图视图']) {
      button(name).click()
      await settle()
      button('整理布局').click()
      await settle()
    }
    expect(worker).toHaveBeenCalledTimes(2)
    expect(calls('save_project')).toHaveLength(saves)
    expect(disk).toBe(saved)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('空视图不能整理，Worker失败不保存部分结果，恢复控件并明确报错', async () => {
  layoutWorkerMock(true)
  try {
    const before = parseProject(disk)
    await opened(serializeProject(createProject('空项目', before.projectId)), false)
    button('图视图').click()
    await settle()
    expect(button('整理布局').disabled).toBe(true)
    await opened(serializeProject(before), false)
    button('树视图').click()
    await settle()
    button('整理布局').click()
    await settle()
    expect(host.textContent).toContain('测试布局失败')
    expect(parseProject(disk)).toEqual(before)
    expect(calls('save_project')).toHaveLength(0)
    expect(button('整理布局').disabled).toBe(false)
    expect(button('图视图').disabled).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('图树切换与整理控件位于撤销左侧，保持独立拖动区域且不在画布遮挡节点', async () => {
  await opened(disk, false)
  const title = host.querySelector('.titlebar')!,
    group = title.querySelector('.layout-controls')!
  expect(group).toBeTruthy()
  expect(
    [...title.querySelectorAll('.view-switch button')].map((b) => b.getAttribute('aria-label')),
  ).toEqual(['树视图', '图视图'])
  expect(button('树视图').querySelectorAll('svg circle')).toHaveLength(3)
  expect(button('图视图').querySelectorAll('svg circle')).toHaveLength(4)
  expect(button('树视图').textContent?.trim()).toBe('')
  expect(button('图视图').textContent?.trim()).toBe('')
  expect(button('撤销').closest('.title-tools')).toBeTruthy()
  expect(group.previousElementSibling?.classList.contains('view-switch')).toBe(true)
  expect(group.nextElementSibling?.classList.contains('title-tools')).toBe(true)
  expect(group.closest('[data-tauri-drag-region]')).toBeNull()
  expect(group.querySelector('button + button')).toBe(button('整理布局'))
  expect(button('整理布局').title).toBe('整理布局')
  expect(button('整理布局').querySelector('svg.lucide-layout-dashboard')).not.toBeNull()
  expect(group.textContent?.trim()).toBe('')
  expect(host.querySelector('.workspace .layout-controls')).toBeNull()
  expect(title.querySelector('.window-drag[data-tauri-drag-region]')).toBeTruthy()
})

it('方向箭头按四向循环，显示图标和提示且不会触发整理、历史或项目写入', async () => {
  const postLayout = layoutWorkerMock()
  try {
    await opened(disk, false)
    const before = mock.canvasProps!.project
    await chooseLayoutDirection('LR')
    const trigger = layoutDirectionButton()
    trigger.focus()
    const directions = [
      ['LR', 'right', '从左到右'],
      ['TB', 'down', '从上到下'],
      ['RL', 'left', '从右到左'],
      ['BT', 'up', '从下到上'],
      ['LR', 'right', '从左到右'],
    ]
    for (const [index, [value, icon, label]] of directions.entries()) {
      if (index > 0) {
        trigger.click()
        await settle()
      }
      expect(trigger.dataset.value).toBe(value)
      expect(trigger.querySelector('svg.lucide-arrow-' + icon)).not.toBeNull()
      expect(trigger.title).toBe('布局方向：' + label + ' · 点击切换')
      expect(trigger.getAttribute('aria-label')).toBe(trigger.title)
    }
    expect(trigger.textContent?.trim()).toBe('')
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false)
    expect(host.querySelector('.direction-menu,[role=listbox]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(mock.canvasProps!.project).toBe(before)
    expect(postLayout).not.toHaveBeenCalled()
    expect(button('撤销').disabled).toBe(true)
    expect(calls('save_project')).toHaveLength(0)
  } finally {
    vi.unstubAllGlobals()
    localStorage.removeItem('knode-layout-directions')
  }
})

it('最近项目悬停子菜单共用首页记录，直接打开原始路径，离开和Esc可关闭', async () => {
  const path = 'C:\\资料 空格\\中文项目\\中文项目.json'
  localStorage.setItem('knode-recent-projects', JSON.stringify([path]))
  app.unmount()
  app = createApp(App)
  app.mount(host)
  await settle()
  const native = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async (cmd: string, args: Record<string, any>) => {
    if (cmd === 'open_project' && args?.path === path)
      return {
        token: 'recent-menu-session',
        path,
        directory: 'C:\\资料 空格\\中文项目',
        json: disk,
      }
    return native(cmd, args)
  })
  button('KNode 应用菜单').click()
  await settle()
  const wrapper = host.querySelector<HTMLElement>('.recent-submenu-wrap')!
  expect(host.querySelector('.recent-submenu')).toBeNull()
  wrapper.dispatchEvent(new MouseEvent('mouseenter'))
  await settle()
  expect(host.querySelector('.recent-submenu strong')?.textContent).toBe('中文项目')
  expect(host.querySelector('.recent-submenu button')?.getAttribute('title')).toBe(path)
  wrapper.dispatchEvent(new MouseEvent('mouseleave'))
  await settle()
  expect(host.querySelector('.recent-submenu')).toBeNull()
  const trigger = host.querySelector<HTMLButtonElement>('.recent-menu-trigger')!
  trigger.focus()
  trigger.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  )
  await settle()
  expect(document.activeElement).toBe(host.querySelector('.recent-submenu button'))
  document.activeElement!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
  await settle()
  expect(document.activeElement).toBe(trigger)
  expect(host.querySelector('.recent-submenu')).toBeNull()
  wrapper.dispatchEvent(new MouseEvent('mouseenter'))
  await settle()
  host.querySelector<HTMLButtonElement>('.recent-submenu button')!.click()
  await settle()
  expect(calls('open_project').at(-1)?.[1]).toEqual({ path, language: 'zh-CN' })
  expect(host.querySelector('.welcome')).toBeNull()
  expect((host.querySelector('.app-menu') as HTMLElement).style.display).toBe('none')
  expect(host.querySelector('.recent-submenu')).toBeNull()
  localStorage.removeItem('knode-recent-projects')
})

it('无最近记录时子菜单显示空状态，切换语言后方向和整理提示使用英文', async () => {
  localStorage.removeItem('knode-recent-projects')
  app.unmount()
  app = createApp(App)
  app.mount(host)
  await settle()
  host.querySelector('.recent-submenu-wrap')!.dispatchEvent(new MouseEvent('mouseenter'))
  await settle()
  expect(host.querySelector('.recent-menu-empty')?.textContent).toBe('暂无记录')
  expect(host.querySelectorAll('.recent-submenu button')).toHaveLength(0)
  await opened(disk, false)
  setLanguage('en')
  await settle()
  await chooseLayoutDirection('LR')
  expect(layoutDirectionButton().title).toBe('Layout direction: Left to right · Click to switch')
  expect(button('Arrange layout').title).toBe('Arrange layout')
  localStorage.removeItem('knode-layout-directions')
})

it('主页菜单提供新建、打开和最近项目；项目菜单按顺序加入自动保存与重命名', async () => {
  const names = () =>
    [...host.querySelectorAll('.app-menu > button,.app-menu > .recent-submenu-wrap > button')].map(
      (b) => b.textContent?.trim(),
    )
  expect(names()).toEqual(['新建项目', '打开项目', '最近打开的项目'])
  await opened(disk, false)
  expect(names()).toEqual(['新建项目', '打开项目', '自动保存', '重命名项目', '最近打开的项目'])
  expect(layoutDirectionButton().querySelector('svg')).not.toBeNull()
})

it('项目菜单勾选控制后台自动保存，重启保留偏好，Ctrl+S 可手动保存', async () => {
  vi.useFakeTimers()
  try {
    await opened(undefined, false)
    const control = () => button('自动保存', host.querySelector('.app-menu')!)
    expect(control().getAttribute('aria-pressed')).toBe('true')
    expect(control().querySelector('svg')).not.toBeNull()
    mock.canvasEmit!('progressStart', 'root')
    mock.canvasEmit!('progressCommit', 'root', 34)
    await settle()
    control().click()
    await settle()
    expect(control().getAttribute('aria-pressed')).toBe('false')
    expect(control().querySelector('svg')).toBeNull()
    await vi.advanceTimersByTimeAsync(900)
    expect(calls('save_project')).toHaveLength(0)
    expect(host.querySelector('.unsaved-star')).not.toBeNull()
    await saveNow()
    expect(parseProject(disk).nodes[0].progress).toBe(34)

    app.unmount()
    app = createApp(App)
    app.mount(host)
    await settle()
    await opened(disk, false)
    expect(control().getAttribute('aria-pressed')).toBe('false')
    mock.canvasEmit!('progressStart', 'root')
    mock.canvasEmit!('progressCommit', 'root', 61)
    await settle()
    await vi.advanceTimersByTimeAsync(900)
    expect(parseProject(disk).nodes[0].progress).toBe(34)
    control().click()
    await settle()
    expect(control().querySelector('svg')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(800)
    expect(parseProject(disk).nodes[0].progress).toBe(61)
  } finally {
    localStorage.removeItem('knode-auto-save')
  }
})
