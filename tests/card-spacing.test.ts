import { describe, expect, it } from 'vitest'
import { reserveCardSpace, type SpacingCard } from '../src/domain/cardSpacing'
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CARD_GAP,
  COMPACT_CARD_HEIGHT,
  cardHeight,
} from '../src/domain/geometry'

const card = (id: string, x: number, y: number, expanded = false, weight = 1): SpacingCard => ({
  id,
  position: { x, y },
  expanded,
  weight,
})
describe('卡片临时避让与收起', () => {
  it('展开向下腾出空间并连带避让，不移动旁列和无关重叠，不修改原坐标', () => {
    const cards = [
      card('a', 0, 0, true),
      card('b', 0, 200),
      card('c', 0, 400),
      card('side', 360, 200),
      card('overlap1', 1000, 0),
      card('overlap2', 1000, 0),
    ]
    const before = JSON.stringify(cards)
    const result = reserveCardSpace(cards)
    expect(result.a).toEqual({ x: 0, y: 0 })
    expect(result.b.y).toBe(CARD_HEIGHT + CARD_GAP)
    expect(result.c.y).toBe(result.b.y + COMPACT_CARD_HEIGHT + CARD_GAP)
    expect(result.side).toEqual(cards[3].position)
    expect(result.overlap1).toEqual(result.overlap2)
    expect(JSON.stringify(cards)).toBe(before)
    expect(reserveCardSpace([...cards].reverse())).toEqual(result)
  })
  it('收起恢复基准，多次开关不漂移；文件与属性切换不重新挪动', () => {
    const compact = [card('a', 0, -100), card('b', 0, 100)]
    for (let i = 0; i < 10; i++) {
      expect(reserveCardSpace(compact)).toEqual({ a: compact[0].position, b: compact[1].position })
      const open = compact.map((n) => ({ ...n, expanded: n.id === 'a' }))
      expect(reserveCardSpace(open).b.y).toBe(-100 + CARD_HEIGHT + CARD_GAP)
      expect(reserveCardSpace(open)).toEqual(reserveCardSpace(open))
    }
  })
  it('避让按无权重卡片的紧凑和展开高度计算', () => {
    const cards = [card('a', 0, 0, true, 0), card('b', 0, 300, false, 0), card('c', 0, 450)]
    const result = reserveCardSpace(cards)
    expect(result.b.y).toBe(cardHeight(0, true) + CARD_GAP)
    expect(result.c.y).toBe(result.b.y + cardHeight(0, false) + CARD_GAP)
    expect(result.b.y).toBeLessThan(CARD_HEIGHT + CARD_GAP)
  })
  it('多个面板展开时逐个留空间，收起其中一个只撤回它的影响', () => {
    const cards = [card('a', 0, 0, true), card('b', 0, 200, true), card('c', 0, 400)]
    expect(reserveCardSpace(cards).c.y).toBe(2 * (CARD_HEIGHT + CARD_GAP))
    cards[0].expanded = false
    const once = reserveCardSpace(cards)
    expect(once.b).toEqual(cards[1].position)
    expect(once.c.y).toBe(200 + CARD_HEIGHT + CARD_GAP)
    cards[1].expanded = false
    expect(reserveCardSpace(cards).c).toEqual(cards[2].position)
  })
  it('部分横向交叠会连带避让，已手动移到空位的卡片收起后保持新坐标', () => {
    const cards = [card('a', 0, 0, true), card('b', 300, 200), card('c', 600, 400)]
    const result = reserveCardSpace(cards)
    expect(result.c.y).toBe(result.b.y + COMPACT_CARD_HEIGHT + CARD_GAP)
    cards[1].position = { x: 800, y: 900 }
    cards[0].expanded = false
    expect(reserveCardSpace(cards).b).toEqual({ x: 800, y: 900 })
  })
  it('2000节点计算有界且受影响卡片不重叠（算法计时，不是桌面FPS）', () => {
    const cards = Array.from({ length: 2000 }, (_, i) =>
      card(String(i), (i % 20) * 360, Math.floor(i / 20) * 200, i === 0),
    )
    const start = performance.now()
    const result = reserveCardSpace(cards)
    console.log('2000节点面板避让纯算法 ms', Math.round(performance.now() - start))
    expect(Object.keys(result)).toHaveLength(2000)
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++) {
        const a = result[cards[i].id],
          b = result[cards[j].id]
        if (a.x >= b.x + CARD_WIDTH || a.x + CARD_WIDTH <= b.x) continue
        const ah = cardHeight(cards[i].weight, cards[i].expanded)
        const bh = cardHeight(cards[j].weight, cards[j].expanded)
        expect(a.y >= b.y + bh || a.y + ah <= b.y).toBe(true)
      }
  })
})
