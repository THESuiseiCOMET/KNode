<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import Icon from './Icon.vue'
import brandIcon from '../../src-tauri/icons/64x64.png'
import { version as configuredVersion } from '../../src-tauri/tauri.conf.json'
import contributorAvatar from '../assets/thesuiseicomet-avatar.jpg'
import { desktopPreferences, type StartupStatus } from '../adapters/desktopPreferences'
import { getVersion } from '@tauri-apps/api/app'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { Update } from '@tauri-apps/plugin-updater'
import { openUrl } from '@tauri-apps/plugin-opener'
import { language, setLanguage, t, type Language } from '../application/i18n'

const props = defineProps<{
  foldAnimation: boolean
  reducedMotion?: boolean
  installUpdate?: (install: () => Promise<void>) => Promise<void>
}>()
// Keep the dialog's entrance policy stable while its own animation setting is edited.
const animateOnOpen = props.foldAnimation

const emit = defineEmits<{
  close: []
  foldMotion: [value: boolean]
}>()

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'latest'
  | 'unconfigured'
  | 'installing'
  | 'check-failed'
  | 'install-failed'
const updateStatus = ref<UpdateStatus>('idle')
const update = shallowRef<Update | null>(null)
const installError = ref('')
let disposed = false

function discardUpdate() {
  const previous = update.value
  update.value = null
  if (previous) void previous.close().catch(() => {})
}
function cancelUpdate() {
  discardUpdate()
  updateStatus.value = 'idle'
}
function closeSettings() {
  if (updateStatus.value !== 'installing') emit('close')
}
async function checkForUpdate() {
  if (updateStatus.value === 'checking' || updateStatus.value === 'installing') return
  discardUpdate()
  updateStatus.value = 'checking'
  try {
    if (!isTauri() || !(await invoke<boolean>('updates_configured'))) {
      updateStatus.value = 'unconfigured'
      return
    }
    if (disposed) return
    const { check } = await import('@tauri-apps/plugin-updater')
    if (disposed) return
    const result = await check({ timeout: 15_000 })
    if (disposed) {
      if (result) await result.close()
      return
    }
    update.value = result
    updateStatus.value = result ? 'available' : 'latest'
  } catch {
    if (!disposed) updateStatus.value = 'check-failed'
  }
}
async function confirmUpdate() {
  const selected = update.value
  if (!selected || !props.installUpdate || updateStatus.value === 'installing') return
  updateStatus.value = 'installing'
  installError.value = ''
  try {
    await props.installUpdate(() => selected.downloadAndInstall(undefined, { timeout: 120_000 }))
    cancelUpdate()
    closeSettings()
  } catch (error) {
    installError.value = error instanceof Error ? error.message : String(error)
    updateStatus.value = 'install-failed'
  }
}
onBeforeUnmount(() => {
  disposed = true
  discardUpdate()
})

const dialogElement = ref<HTMLElement>()
const category = ref('general')
const version = ref(configuredVersion)
const linkError = ref(false)
const startup = ref<StartupStatus>({ enabled: false, supported: false })
const startupBusy = ref(true),
  startupError = ref('')
async function loadStartup() {
  try {
    startup.value = await desktopPreferences.startup()
  } catch (e) {
    startupError.value = String(e)
  } finally {
    startupBusy.value = false
  }
}
async function changeStartup(event: Event) {
  const checkbox = event.target as HTMLInputElement
  const enabled = checkbox.checked
  checkbox.checked = startup.value.enabled
  if (startupBusy.value || !startup.value.supported) return
  startupBusy.value = true
  startupError.value = ''
  try {
    startup.value = await desktopPreferences.setStartup(enabled)
  } catch (e) {
    startupError.value = String(e)
  } finally {
    startupBusy.value = false
  }
}

const links = {
  github: 'https://github.com/THESuiseiCOMET/KNode',
  email: 'mailto:thesuiseicomet@gmail.com',
  issues: 'https://github.com/THESuiseiCOMET/KNode/issues',
  pulls: 'https://github.com/THESuiseiCOMET/KNode/pulls',
  contributor: 'https://github.com/THESuiseiCOMET',
} as const

type LinkName = keyof typeof links

const aboutLinks = [
  { name: 'github', label: 'Code', icon: 'about-code' },
  { name: 'issues', label: 'Issues', icon: 'about-issue' },
  { name: 'pulls', label: 'Pull requests', icon: 'about-pull-request' },
  { name: 'email', label: 'Email', icon: 'about-mail' },
] as const

async function openExternal(name: LinkName) {
  linkError.value = false

  try {
    const url = links[name]

    if (isTauri()) {
      await openUrl(url)
    } else if (name === 'email') {
      window.location.href = url
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  } catch (error) {
    console.error('Failed to open external link:', error)
    linkError.value = true
  }
}

function trap(event: KeyboardEvent) {
  if (event.key !== 'Tab') return

  const items = [
    ...dialogElement.value!.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
    ),
  ]

  const index = items.indexOf(document.activeElement as HTMLElement)

  if (event.shiftKey && index <= 0) {
    event.preventDefault()
    items.at(-1)?.focus()
  } else if (!event.shiftKey && index === items.length - 1) {
    event.preventDefault()
    items[0]?.focus()
  }
}

onMounted(() => {
  void loadStartup()
  dialogElement.value?.querySelector<HTMLButtonElement>('button')?.focus()

  if (isTauri()) {
    void getVersion()
      .then((value) => {
        version.value = value
      })
      .catch((error) => {
        console.error('Failed to read app version:', error)
      })
  }
})
</script>

<template>
  <div
    class="modal-backdrop settings-backdrop"
    :class="{ 'settings-static': !animateOnOpen || reducedMotion }"
    @click.self="closeSettings"
    @keydown.esc.stop="closeSettings"
  >
    <section
      ref="dialogElement"
      @keydown="trap"
      class="settings-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('设置')"
    >
      <header>
        <h2>{{ t('设置') }}</h2>
        <button
          type="button"
          class="settings-close"
          :aria-label="t('关闭')"
          :disabled="updateStatus === 'installing'"
          @click="closeSettings"
        >
          <Icon name="close" />
        </button>
      </header>

      <div class="settings-layout">
        <nav>
          <button
            v-for="entry in [
              { id: 'general', name: t('通用') },
              { id: 'animation', name: t('动画') },
              { id: 'about', name: t('关于') },
            ]"
            :key="entry.id"
            :aria-pressed="category === entry.id"
            :disabled="updateStatus === 'installing'"
            @click="category = entry.id"
          >
            {{ entry.name }}
          </button>
        </nav>

        <div :key="category" class="settings-content">
          <!-- 通用 -->
          <section v-if="category === 'general'">
            <h3>{{ t('通用') }}</h3>

            <label>
              {{ t('界面语言') }}
              <select
                :value="language"
                @change="setLanguage(($event.target as HTMLSelectElement).value as Language)"
              >
                <option value="zh-CN">{{ t('简体中文') }}</option>
                <option value="en">English</option>
              </select>
            </label>
            <label class="setting-check">
              <input
                type="checkbox"
                :checked="startup.enabled"
                :disabled="startupBusy || !startup.supported"
                @change="changeStartup"
              />
              {{ t('开机时启动') }}
            </label>
            <p v-if="startupError" class="about-error" role="alert">
              {{ t('开机启动设置失败：') }}{{ startupError }}
            </p>
          </section>

          <!-- 动画 -->
          <section v-else-if="category === 'animation'">
            <h3>{{ t('动画') }}</h3>

            <label class="setting-check">
              <input
                type="checkbox"
                :checked="foldAnimation"
                @change="emit('foldMotion', ($event.target as HTMLInputElement).checked)"
              />
              {{ t('展开与收起动画') }}
            </label>
          </section>

          <!-- 关于 -->
          <section v-else-if="category === 'about'" class="about-content">
            <h3>{{ t('关于') }}</h3>

            <div class="about-header">
              <div class="about-info">
                <img :src="brandIcon" class="about-brand-icon" width="42" height="42" alt="" />
                <div>
                  <strong class="about-name">KNode</strong>
                  <span class="about-version" :aria-label="t('版本') + ' ' + version">{{
                    version
                  }}</span>
                </div>
              </div>
              <div class="about-header-actions">
                <button
                  type="button"
                  class="about-action about-star about-update-check"
                  :disabled="updateStatus === 'checking' || updateStatus === 'installing'"
                  @click="checkForUpdate"
                >
                  {{ t('检查更新') }}
                </button>
                <button
                  type="button"
                  class="about-action about-star"
                  @click="openExternal('github')"
                >
                  <Icon name="about-star" />
                  Star on GitHub
                </button>
              </div>
            </div>

            <div v-if="updateStatus !== 'idle'" class="about-update">
              <p v-if="updateStatus === 'checking'" role="status">{{ t('正在检查更新…') }}</p>
              <p v-if="updateStatus === 'latest'" role="status">{{ t('已是最新版本。') }}</p>
              <p v-if="updateStatus === 'unconfigured'" role="status">
                {{ t('当前版本未配置签名更新。') }}
              </p>
              <p v-if="updateStatus === 'check-failed'" class="about-error" role="alert">
                {{ t('检查更新失败，请稍后重试。') }}
              </p>
              <template v-if="update">
                <p role="status">
                  <strong>{{ t('发现新版本') }} {{ update.version }}</strong>
                </p>
                <p v-if="update.body" class="about-update-notes">{{ update.body }}</p>
                <p v-if="updateStatus === 'installing'" role="status">
                  {{ t('正在保存项目并下载安装更新…') }}
                </p>
                <p v-if="updateStatus === 'install-failed'" class="about-error" role="alert">
                  {{ t('安装更新失败：') }}{{ installError }}
                </p>
                <div v-if="updateStatus !== 'installing'" class="about-header-actions">
                  <button type="button" class="about-action about-star" @click="confirmUpdate">
                    {{ t('下载安装') }}
                  </button>
                  <button type="button" class="about-action" @click="cancelUpdate">
                    {{ t('取消') }}
                  </button>
                </div>
              </template>
            </div>

            <p class="about-description">
              {{ t('如果 KNode 对你有帮助，欢迎在 GitHub 上给项目点个 Star。') }}
            </p>
            <p class="about-description">
              {{ t('如果你想参与 KNode 的开发，或有任何想法与建议，欢迎通过以下入口参与。') }}
            </p>

            <div class="about-links">
              <button
                v-for="link in aboutLinks"
                :key="link.name"
                type="button"
                class="about-action"
                @click="openExternal(link.name)"
              >
                <Icon :name="link.icon" />
                {{ link.label }}
              </button>
            </div>

            <div class="about-contributors">
              <h4>Contributors</h4>
              <button
                type="button"
                class="about-action about-contributor"
                @click="openExternal('contributor')"
              >
                <img :src="contributorAvatar" width="26" height="26" alt="" />
                THESuiseiCOMET
              </button>
            </div>

            <p v-if="linkError" class="about-error" role="alert">
              {{ t('无法打开链接') }}
            </p>
          </section>
        </div>
      </div>
    </section>
  </div>
</template>
