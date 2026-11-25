import { describe, expect, it } from 'vitest'
import { diskHS, hexToHsv, hsvToHex } from '../src/domain/color'
describe('HSV颜色转换与圆盘坐标', () => {
  it('已用颜色、黑白与灰色无损往返', () => {
    for (const color of [
      '#000000',
      '#ffffff',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#6599cb',
      '#d16859',
    ])
      expect(hsvToHex(hexToHsv(color))).toBe(color)
  })
  it('圆盘角度决定色相，距离决定饱和度，超圆盘钳制', () => {
    expect(diskHS(0, 0)).toEqual({ h: 0, s: 0 })
    expect(diskHS(1, 0)).toEqual({ h: 0, s: 1 })
    expect(diskHS(0, 1)).toEqual({ h: 90, s: 1 })
    expect(diskHS(-1, 0)).toEqual({ h: 180, s: 1 })
    expect(diskHS(0, -1)).toEqual({ h: 270, s: 1 })
    expect(diskHS(2, 2).s).toBe(1)
    expect(diskHS(0.3, 0.4).s).toBeCloseTo(0.5)
  })
  it('明度0为黑，饱和度0为灰，色相循环', () => {
    expect(hsvToHex({ h: 123, s: 1, v: 0 })).toBe('#000000')
    expect(hsvToHex({ h: 80, s: 0, v: 0.5 })).toBe('#808080')
    expect(hsvToHex({ h: 420, s: 1, v: 1 })).toBe('#ffff00')
  })
})
