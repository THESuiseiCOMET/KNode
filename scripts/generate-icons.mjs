// Canonical Photoshop artwork. Never alter the master or redesign small sizes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const source = resolve('src-tauri/icons/source/knoten-master.png')
const output = resolve('src-tauri/icons')
const previews = resolve('src-tauri/icons/previews')
const png = readFileSync(source)
if (png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024 || png[25] !== 6)
  throw new Error('Master must be 1024px RGBA PNG')
mkdirSync(previews, { recursive: true })
const cli = resolve('node_modules/@tauri-apps/cli/tauri.js')
for (const args of [
  ['icon', source, '--output', output],
  [
    'icon',
    source,
    '--output',
    previews,
    '--png',
    '16',
    '--png',
    '32',
    '--png',
    '48',
    '--png',
    '64',
    '--png',
    '128',
    '--png',
    '256',
  ],
]) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('Tauri icon generation failed')
}
// The CLI's default Windows ICO omits 128px. Add its CLI-generated PNG as a proper ICO layer.
const icoPath = resolve(output, 'icon.ico'),
  ico = readFileSync(icoPath),
  layers = []
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const off = 6 + i * 16,
    size = ico[off] || 256
  layers.push({
    size,
    header: Buffer.from(ico.subarray(off, off + 16)),
    data: ico.subarray(
      ico.readUInt32LE(off + 12),
      ico.readUInt32LE(off + 12) + ico.readUInt32LE(off + 8),
    ),
  })
}
if (!layers.some((l) => l.size === 128)) {
  const data = readFileSync(resolve(previews, '128x128.png')),
    header = Buffer.alloc(16)
  header[0] = 128
  header[1] = 128
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(32, 6)
  header.writeUInt32LE(data.length, 8)
  layers.push({ size: 128, header, data })
}
layers.sort((a, b) => a.size - b.size)
let offset = 6 + layers.length * 16
const head = Buffer.alloc(offset)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(layers.length, 4)
layers.forEach((l, i) => {
  l.header.writeUInt32LE(offset, 12)
  l.header.copy(head, 6 + i * 16)
  offset += l.data.length
})
writeFileSync(icoPath, Buffer.concat([head, ...layers.map((l) => l.data)]))
if (![16, 32, 48, 64, 128, 256].every((s) => layers.some((l) => l.size === s)))
  throw new Error('Missing required Windows ICO layers')
console.log(
  'KNode Windows ICO sizes:',
  layers.map((l) => l.size),
)
