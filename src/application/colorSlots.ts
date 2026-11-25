import { ref } from 'vue'

const key = 'knode-color-slots'
const defaults = [
  '#6c9661',
  '#6599cb',
  '#8b78c6',
  '#cf7a94',
  '#d59b54',
  '#54a8a0',
  '#d16859',
  '#8795a7',
  '#52685e',
]
function load(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (
      Array.isArray(value) &&
      value.length === 9 &&
      value.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
    )
      return value
  } catch {
    /* Damaged preferences must never block opening a forest. */
  }
  return [...defaults]
}
/** Application preferences only. Node colors remain in the existing forest model. */
export const colorSlots = ref(load())
export function saveColorSlot(index: number, color: string): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= 9 || !/^#[0-9a-f]{6}$/i.test(color))
    return false
  const next = [...colorSlots.value]
  next[index] = color.toLowerCase()
  colorSlots.value = next
  try {
    localStorage.setItem(key, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === key) colorSlots.value = load()
  })
