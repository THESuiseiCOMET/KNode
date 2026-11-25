import type { Point } from './model'
import { CARD_GAP, CARD_WIDTH, cardHeight } from './geometry'

export interface SpacingCard {
  id: string
  position: Point
  weight: number
  expanded: boolean
}
interface PlacedCard extends Point {
  height: number
  active: boolean
}

/** View-only space for open panels. Always derive from saved coordinates, never
 * from the last projection, so collapse/repeated toggles cannot accumulate shifts.
 * Ordinary compact overlaps outside the affected area are deliberately retained.
 */
export function reserveCardSpace(cards: readonly SpacingCard[]): Record<string, Point> {
  const result: Record<string, Point> = Object.fromEntries(
    cards.map((card) => [card.id, { ...card.position }]),
  )
  if (!cards.some((card) => card.expanded)) return result
  const ordered = [...cards].sort(
    (a, b) =>
      a.position.y - b.position.y ||
      Number(b.expanded) - Number(a.expanded) ||
      a.position.x - b.position.x ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  // Sorted by actual top, including displaced cards: each scan only moves down.
  const placed: PlacedCard[] = []
  for (const card of ordered) {
    const { x } = card.position
    const height = cardHeight(card.weight, card.expanded)
    const fit = (start: number, activeOnly: boolean): number => {
      let y = start
      for (const previous of placed) {
        if (previous.y >= y + height + CARD_GAP) break
        if (
          (activeOnly && !previous.active) ||
          x >= previous.x + CARD_WIDTH ||
          x + CARD_WIDTH <= previous.x
        )
          continue
        if (y < previous.y + previous.height + CARD_GAP) y = previous.y + previous.height + CARD_GAP
      }
      return y
    }
    let y = fit(card.position.y, true)
    // A displaced card must also clear ordinary cards encountered along its way.
    if (y !== card.position.y) y = fit(y, false)
    result[card.id] = { x, y }
    const current = { x, y, height, active: card.expanded || y !== card.position.y }
    let low = 0,
      high = placed.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (placed[middle].y <= y) low = middle + 1
      else high = middle
    }
    placed.splice(low, 0, current)
  }
  return result
}
