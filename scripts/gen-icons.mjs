// Renders build/icon.svg to the PNG sizes electron-builder needs (Windows/macOS convert from icon.png).
import { Resvg } from '@resvg/resvg-js'
import fs from 'node:fs'
import path from 'node:path'

const svg = fs.readFileSync('build/icon.svg')
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

fs.writeFileSync('build/icon.png', render(1024))
fs.mkdirSync('build/icons', { recursive: true })
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  fs.writeFileSync(path.join('build/icons', `${size}x${size}.png`), render(size))
}
fs.copyFileSync('build/icons/256x256.png', 'resources/icon.png')
console.log('icons written to build/ and resources/icon.png')
