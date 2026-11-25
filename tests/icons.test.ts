import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('KNode应用、安装/卸载图标使用同一ICO，覆盖所有Windows必需尺寸且保留RGBA母版', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  expect(config.productName).toBe('KNode')
  expect(config.identifier).toBe('com.foresteditor.desktop')
  expect(config.version).toBe('0.1.0')
  expect(config.bundle.icon).toContain('icons/icon.ico')
  expect(config.bundle.windows.nsis.installerIcon).toBe('icons/icon.ico')
  expect(config.bundle.windows.nsis.uninstallerIcon).toBe('icons/icon.ico')
  const master = readFileSync('src-tauri/icons/source/knoten-master.png')
  expect(master.readUInt32BE(16)).toBe(1024)
  expect(master.readUInt32BE(20)).toBe(1024)
  expect(master[25]).toBe(6)
  const icon = readFileSync('src-tauri/icons/icon.ico')
  expect(icon.readUInt16LE(2)).toBe(1)
  const sizes = []
  for (let i = 0; i < icon.readUInt16LE(4); i++) {
    const off = 6 + 16 * i,
      size = icon[off] || 256
    expect(icon[off + 1] || 256).toBe(size)
    const len = icon.readUInt32LE(off + 8),
      start = icon.readUInt32LE(off + 12)
    expect(len).toBeGreaterThan(0)
    expect(start + len).toBeLessThanOrEqual(icon.length)
    sizes.push(size)
  }
  expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 64, 128, 256]))
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const preview = readFileSync(`src-tauri/icons/previews/${size}x${size}.png`)
    expect(preview.readUInt32BE(16)).toBe(size)
    expect(preview.readUInt32BE(20)).toBe(size)
  }
  expect(config.app.windows[0].title).toBe('KNode')
  expect(config.app.windows[0].decorations).toBe(false)
  expect(config.app.windows[0].resizable).toBe(true)
})

it('Windows NSIS明确释放licenses目录，失败中止且卸载只移除已知文件', () => {
  const base = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const windows = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'))
  // Adding other shared resources must also update the Windows packaging strategy.
  expect(base.bundle.resources).toEqual({
    '../LICENSE': 'licenses/KNode-LICENSE.txt',
    '../licenses/ELKJS-LICENSE.md': 'licenses/ELKJS-LICENSE.md',
    '../licenses/ELKJS-COPYRIGHT.txt': 'licenses/ELKJS-COPYRIGHT.txt',
    '../licenses/Lucide-LICENSE.txt': 'licenses/Lucide-LICENSE.txt',
    '../licenses/Lucide-Vue-LICENSE.txt': 'licenses/Lucide-Vue-LICENSE.txt',
    '../licenses/Tauri-LICENSE-MIT.txt': 'licenses/Tauri-LICENSE-MIT.txt',
    '../licenses/THIRD-PARTY-NOTICES.txt': 'licenses/THIRD-PARTY-NOTICES.txt',
  })
  expect(base.bundle.targets).toEqual(['nsis'])
  expect(windows.bundle.resources).toBeNull()
  expect(windows.bundle.windows.nsis.installerHooks).toBe('installer-hooks.nsh')
  const hooks = readFileSync('src-tauri/installer-hooks.nsh', 'utf8')
  expect(hooks).toContain('SetOutPath "$INSTDIR' + String.fromCharCode(92) + 'licenses"')
  const delivered = Object.values(base.bundle.resources).map((file) =>
    String(file).split('/').at(-1),
  )
  for (const filename of [...delivered, 'FRONTEND-LICENSES.md']) {
    expect(hooks).toContain('"' + filename + '"')
  }
  expect(hooks).toContain('!insertmacro KNODE_LICENSE_FILES KNODE_WRITE_LICENSE')
  expect(hooks).toContain('!insertmacro KNODE_LICENSE_FILES KNODE_DELETE_LICENSE')
  expect(hooks).not.toContain('/oname=licenses')
  expect(hooks).toContain('SetErrorLevel 2')
  expect(hooks).toContain('Abort')
  expect(hooks.toLowerCase()).not.toContain('rmdir /r')
})
