// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import SettingsDialog from '../src/ui/SettingsDialog.vue'
import capability from '../src-tauri/capabilities/main.json'
import { version as configuredVersion } from '../src-tauri/tauri.conf.json'
import { setLanguage } from '../src/application/i18n'
const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  desktop: false,
  openUrl: vi.fn(),
  checkUpdate: vi.fn(),
  version: '2.3.4',
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke, isTauri: () => mock.desktop }))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => mock.version }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mock.openUrl }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mock.checkUpdate }))
let app: App | undefined, host: HTMLDivElement | undefined
afterEach(() => {
  app?.unmount()
  host?.remove()
  setLanguage('zh-CN')
  mock.desktop = false
  vi.resetAllMocks()
})
async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount(installUpdate?: (install: () => Promise<void>) => Promise<void>) {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp({ render: () => h(SettingsDialog, { foldAnimation: true, installUpdate }) })
  app.mount(host)
  await settle()
}
function settingsButton(label: string): HTMLButtonElement {
  return [...host!.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  )!
}

it('About 只在手动点击后检查，显示版本和说明，用户确认后才走安装', async () => {
  mock.desktop = true
  mock.invoke.mockImplementation(async (command: string) =>
    command === 'updates_configured' ? true : { enabled: false, supported: true },
  )
  const downloadAndInstall = vi.fn(async () => {})
  const close = vi.fn(async () => {})
  mock.checkUpdate.mockResolvedValue({
    version: '0.2.0',
    body: '<b>release notes</b>',
    downloadAndInstall,
    close,
  })
  let saved = false
  await mount(async (install) => {
    saved = true
    await install()
  })
  settingsButton('关于').click()
  await settle()
  expect(mock.checkUpdate).not.toHaveBeenCalled()
  const checkButton = settingsButton('检查更新')
  expect(checkButton.nextElementSibling).toBe(settingsButton('Star on GitHub'))
  checkButton.click()
  await vi.waitFor(() => expect(settingsButton('下载安装')).toBeTruthy())
  expect(mock.checkUpdate).toHaveBeenCalledWith({ timeout: 15_000 })
  expect(host!.querySelector('.about-update')?.textContent).toContain('0.2.0')
  expect(host!.querySelector('.about-update-notes')?.textContent).toBe('<b>release notes</b>')
  expect(host!.querySelector('.about-update-notes b')).toBeNull()
  expect(downloadAndInstall).not.toHaveBeenCalled()
  settingsButton('取消').click()
  await settle()
  expect(close).toHaveBeenCalledOnce()
  expect(host!.querySelector('.about-update')).toBeNull()
  checkButton.click()
  await vi.waitFor(() => expect(settingsButton('下载安装')).toBeTruthy())
  settingsButton('下载安装').click()
  await settle()
  expect(saved).toBe(true)
  expect(downloadAndInstall).toHaveBeenCalledOnce()
})

it('About 显示未配置和已经最新，保存失败不会开始下载或安装', async () => {
  mock.desktop = true
  let configured = false
  mock.invoke.mockImplementation(async (command: string) =>
    command === 'updates_configured' ? configured : { enabled: false, supported: true },
  )
  mock.checkUpdate.mockResolvedValue(null)
  await mount(async () => {
    throw new Error('模拟磁盘写入失败')
  })
  settingsButton('关于').click()
  await settle()
  const checkButton = settingsButton('检查更新')
  checkButton.click()
  await settle()
  expect(host!.querySelector('.about-update')?.textContent).toContain('未配置签名更新')
  expect(mock.checkUpdate).not.toHaveBeenCalled()
  configured = true
  checkButton.click()
  await vi.waitFor(() =>
    expect(host!.querySelector('.about-update')?.textContent).toContain('已是最新版本'),
  )
  const downloadAndInstall = vi.fn(async () => {})
  mock.checkUpdate.mockResolvedValue({
    version: '0.2.0',
    downloadAndInstall,
    close: async () => {},
  })
  checkButton.click()
  await vi.waitFor(() => expect(settingsButton('下载安装')).toBeTruthy())
  settingsButton('下载安装').click()
  await settle()
  expect(downloadAndInstall).not.toHaveBeenCalled()
  expect(host!.querySelector('.about-update [role="alert"]')?.textContent).toContain(
    '模拟磁盘写入失败',
  )
})
it('设置保留通用、动画及已有关于分类，不显示AI服务且不读取凭据', async () => {
  await mount()
  expect([...host!.querySelectorAll('nav button')].map((b) => b.textContent?.trim())).toEqual([
    '通用',
    '动画',
    '关于',
  ])
  expect(host!.textContent).not.toContain('AI')
  expect(host!.textContent).not.toContain('开发中')
  expect(mock.invoke).not.toHaveBeenCalled()
})

it('分类切换保留导航焦点与对话框，只更换右侧内容且不读写配置', async () => {
  await mount()
  const dialog = host!.querySelector('.settings-dialog')!
  const nav = host!.querySelector('nav')!
  const animation = nav.querySelectorAll<HTMLButtonElement>('button')[1]!
  const general = nav.querySelector<HTMLButtonElement>('button')!
  for (let i = 0; i < 6; i++) {
    const target = i % 2 ? general : animation
    target.focus()
    target.click()
    await settle()
    expect(document.activeElement).toBe(target)
    expect(host!.querySelector('.settings-dialog')).toBe(dialog)
    expect(host!.querySelector('nav')).toBe(nav)
    expect(host!.querySelectorAll('.settings-content')).toHaveLength(1)
    expect(host!.querySelector('.settings-content h3')?.textContent).toBe(i % 2 ? '通用' : '动画')
    expect(host!.querySelectorAll('.setting-check')).toHaveLength(1)
    expect(host!.querySelector('.setting-check')?.textContent).toContain(
      i % 2 ? '开机时启动' : '展开与收起动画',
    )
  }
  expect(mock.invoke).not.toHaveBeenCalled()
})

it.each([true, false])(
  '连续切换展开动画时保留本次设置窗口的进场配置（初始 %s）',
  async (initial) => {
    const foldAnimation = ref(initial)
    host = document.createElement('div')
    document.body.append(host)
    app = createApp({
      render: () =>
        h('main', { class: { 'static-ui': !foldAnimation.value } }, [
          h(SettingsDialog, {
            foldAnimation: foldAnimation.value,
            onFoldMotion: (enabled: boolean) => (foldAnimation.value = enabled),
          }),
        ]),
    })
    app.mount(host)
    await settle()
    host.querySelectorAll<HTMLButtonElement>('nav button')[1].click()
    await settle()
    const dialog = host.querySelector('.settings-backdrop')!
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    checkbox.focus()
    for (let i = 0; i < 6; i++) {
      checkbox.click()
      await nextTick()
      expect(host.querySelector('.settings-backdrop')).toBe(dialog)
      expect(dialog.classList.contains('settings-static')).toBe(!initial)
      expect(checkbox.checked).toBe(i % 2 === 0 ? !initial : initial)
      expect(document.activeElement).toBe(checkbox)
    }
  },
)

it('通用开机启动复用勾选样式，读回系统状态，仅用户勾选才写入，重新打开仍恢复', async () => {
  mock.desktop = true
  let enabled = false
  mock.invoke.mockImplementation(async (command: string, args?: { enabled: boolean }) => {
    if (command === 'set_startup') enabled = args!.enabled
    return { enabled, supported: true }
  })
  await mount()
  const checkbox = () => host!.querySelector<HTMLInputElement>('.setting-check input')!
  expect(host!.querySelector('.setting-check')?.textContent).toContain('开机时启动')
  expect(checkbox().checked).toBe(false)
  expect(checkbox().disabled).toBe(false)
  expect(mock.invoke.mock.calls.map((c) => c[0])).toEqual(['get_startup'])
  checkbox().checked = true
  checkbox().dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(mock.invoke).toHaveBeenCalledWith('set_startup', { enabled: true })
  expect(checkbox().checked).toBe(true)
  app!.unmount()
  host!.remove()
  await mount()
  expect(checkbox().checked).toBe(true)
  checkbox().checked = false
  checkbox().dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(checkbox().checked).toBe(false)
  expect(enabled).toBe(false)
})

it('开机启动写入中禁用，失败恢复原勾选并明确报错，不误报保存成功', async () => {
  mock.desktop = true
  let rejectWrite: ((reason: Error) => void) | undefined
  mock.invoke.mockImplementation((command: string) =>
    command === 'get_startup'
      ? Promise.resolve({ enabled: true, supported: true })
      : new Promise((_, reject) => {
          rejectWrite = reject
        }),
  )
  await mount()
  const checkbox = host!.querySelector<HTMLInputElement>('.setting-check input')!
  checkbox.checked = false
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
  expect(checkbox.disabled).toBe(true)
  expect(checkbox.checked).toBe(true)
  rejectWrite!(new Error('权限不足'))
  await settle()
  expect(checkbox.checked).toBe(true)
  expect(checkbox.disabled).toBe(false)
  expect(host!.querySelector('[role="alert"]')?.textContent).toContain('权限不足')
})

it('开机启动读取失败和非桌面环境不显示虚假的可用状态', async () => {
  mock.desktop = true
  mock.invoke.mockRejectedValue(new Error('读取启动设置失败'))
  await mount()
  expect(host!.querySelector<HTMLInputElement>('.setting-check input')!.disabled).toBe(true)
  expect(host!.querySelector('[role="alert"]')?.textContent).toContain('读取启动设置失败')
})

it('关于在主窗口拥有版本读取权限，桌面运行时版本优先', async () => {
  expect(capability.windows).toContain('main')
  expect(capability.permissions).toContain('core:app:allow-version')

  await mount()
  host!.querySelectorAll<HTMLButtonElement>('nav button')[2].click()
  await settle()
  expect(host!.querySelector('.about-version')?.textContent).toBe(configuredVersion)

  app!.unmount()
  host!.remove()
  mock.desktop = true
  mock.invoke.mockResolvedValue({ enabled: false, supported: true })
  await mount()
  host!.querySelectorAll<HTMLButtonElement>('nav button')[2].click()
  await settle()
  expect(host!.querySelector('.about-version')?.textContent).toBe(mock.version)
})

it('关于的六个入口通过 Opener 打开白名单内的对应地址，错误时显示提示', async () => {
  mock.desktop = true
  mock.invoke.mockResolvedValue({ enabled: false, supported: true })
  mock.openUrl.mockResolvedValue(undefined)
  await mount()
  host!.querySelectorAll<HTMLButtonElement>('nav button')[2].click()
  await settle()
  const links = [
    ...host!.querySelectorAll<HTMLButtonElement>(
      '.about-content .about-action:not(.about-update-check)',
    ),
  ]
  expect(links.map((button) => button.textContent?.trim())).toEqual([
    'Star on GitHub',
    'Code',
    'Issues',
    'Pull requests',
    'Email',
    'THESuiseiCOMET',
  ])
  for (const link of links) {
    link.click()
    await settle()
  }
  const urls = mock.openUrl.mock.calls.map(([url]) => url)
  expect(urls).toEqual([
    'https://github.com/THESuiseiCOMET/KNode',
    'https://github.com/THESuiseiCOMET/KNode',
    'https://github.com/THESuiseiCOMET/KNode/issues',
    'https://github.com/THESuiseiCOMET/KNode/pulls',
    'mailto:thesuiseicomet@gmail.com',
    'https://github.com/THESuiseiCOMET',
  ])
  const opener = capability.permissions.find(
    (item) => typeof item === 'object' && item.identifier === 'opener:allow-open-url',
  )
  expect(typeof opener === 'object' ? opener.allow.map((entry) => entry.url) : []).toEqual([
    ...new Set(urls),
  ])

  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    mock.openUrl.mockRejectedValueOnce(new Error('No mail handler'))
    links[4].click()
    await settle()
    expect(host!.querySelector('.about-content [role="alert"]')?.textContent).toContain(
      '无法打开链接',
    )
    links[1].click()
    await settle()
    expect(host!.querySelector('.about-content [role="alert"]')).toBeNull()
  } finally {
    log.mockRestore()
  }
})
