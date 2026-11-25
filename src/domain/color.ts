export const DEFAULT_NODE_COLOR = '#6c9661'

export interface HSV {
  h: number
  s: number
  v: number
}
export function hsvToHex({ h, s, v }: HSV): string {
  const sector = (((h % 360) + 360) % 360) / 60,
    c = v * s,
    x = c * (1 - Math.abs((sector % 2) - 1)),
    m = v - c
  const values =
    sector < 1
      ? [c, x, 0]
      : sector < 2
        ? [x, c, 0]
        : sector < 3
          ? [0, c, x]
          : sector < 4
            ? [0, x, c]
            : sector < 5
              ? [x, 0, c]
              : [c, 0, x]
  return (
    '#' +
    values
      .map((n) =>
        Math.round(Math.max(0, Math.min(1, n + m)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  )
}
export function hexToHsv(hex: string): HSV {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min
  const h =
    d === 0
      ? 0
      : max === r
        ? 60 * (((g - b) / d) % 6)
        : max === g
          ? 60 * ((b - r) / d + 2)
          : 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s: max === 0 ? 0 : d / max, v: max }
}
export function diskHS(x: number, y: number): Pick<HSV, 'h' | 's'> {
  return { h: ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(x, y)) }
}
