import { ref } from 'vue'
export type Theme = 'light' | 'dark'
function initialTheme(): Theme {
  try {
    return localStorage.getItem('knode-theme') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
export const theme = ref<Theme>(initialTheme())
let activeTransition: ViewTransition | undefined
let pendingTheme: Theme | undefined
let fallbackTimer: ReturnType<typeof setTimeout> | undefined
let transitionRevision = 0
function applyTheme() {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.theme = theme.value
  document.documentElement.style.colorScheme = theme.value
}
export function setTheme(value: Theme) {
  theme.value = value
  applyTheme()
  try {
    localStorage.setItem('knode-theme', value)
  } catch {
    /* Keep the current session usable. */
  }
}
function motionAllowed() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  try {
    return localStorage.getItem('forest-fold-animation') !== 'false'
  } catch {
    return true
  }
}
export function toggleTheme() {
  const revision = ++transitionRevision
  const next = (pendingTheme ?? theme.value) === 'dark' ? 'light' : 'dark'
  const root = document.documentElement
  activeTransition?.skipTransition()
  activeTransition = undefined
  clearTimeout(fallbackTimer)
  root.classList.remove('theme-transition', 'theme-transition-fallback')
  if (!motionAllowed()) {
    pendingTheme = undefined
    setTheme(next)
    return
  }
  if (typeof document.startViewTransition === 'function') {
    pendingTheme = next
    root.classList.add('theme-transition')
    try {
      const transition = document.startViewTransition(() => {
        if (transitionRevision === revision) setTheme(next)
      })
      activeTransition = transition
      // Skipping a pending snapshot rejects ready, but must not produce an unhandled error.
      void transition.ready.catch(() => {})
      void transition.finished
        .catch(() => {})
        .finally(() => {
          if (activeTransition !== transition) return
          root.classList.remove('theme-transition')
          activeTransition = undefined
          pendingTheme = undefined
        })
      return
    } catch {
      pendingTheme = undefined
      root.classList.remove('theme-transition')
    }
  }
  root.classList.add('theme-transition-fallback')
  // Establish the old colors before changing the theme in older WebViews.
  void root.offsetWidth
  setTheme(next)
  fallbackTimer = setTimeout(() => root.classList.remove('theme-transition-fallback'), 300)
}
applyTheme()
