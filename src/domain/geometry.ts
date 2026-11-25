export const CARD_WIDTH = 340
export const CARD_HEIGHT = 480
export const CARD_GAP = 24

export const COMPACT_CARD_HEIGHT = 152
export const CARD_PROGRESS_HEIGHT = 32
export const CARD_SECTION_GAP = 7

export function cardHeight(weight: number, expanded: boolean): number {
  const fullHeight = expanded ? CARD_HEIGHT : COMPACT_CARD_HEIGHT
  return weight > 0 ? fullHeight : fullHeight - CARD_PROGRESS_HEIGHT - CARD_SECTION_GAP
}
