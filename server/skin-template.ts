import { encodePng } from './skin-compose.js'
import {
  SKIN_WIDTH,
  SKIN_HEIGHT,
  SKIN_PARTS,
  SKIN_LAYERS,
  SKIN_FACES,
  SKIN_RECTS,
  type SkinPartName,
} from './skin-layout.js'

export const UNUSED_COLOR: [number, number, number, number] = [128, 128, 128, 255] // #808080

export const REGION_COLORS: Record<SkinPartName, [number, number, number, number]> = {
  head: [255, 107, 107, 255],     // #FF6B6B
  body: [77, 150, 255, 255],      // #4D96FF
  rightArm: [107, 203, 119, 255], // #6BCB77
  leftArm: [56, 229, 77, 255],    // #38E54D
  rightLeg: [255, 217, 61, 255],  // #FFD93D
  leftLeg: [255, 159, 41, 255],   // #FF9F29
}

let cachedTemplatePng: Buffer | null = null

/**
 * Creates 64x64 Minecraft layout canvas with distinct flat color per body region
 * and flat grey (#808080) in unused areas, upscaled 16x to 1024x1024 RGBA PNG.
 */
export function createTemplatePng(): Buffer {
  if (cachedTemplatePng) {
    return cachedTemplatePng
  }

  const canvas64 = Buffer.alloc(SKIN_WIDTH * SKIN_HEIGHT * 4)

  // Fill unused area with flat grey #808080
  for (let i = 0; i < SKIN_WIDTH * SKIN_HEIGHT; i++) {
    const off = i * 4
    canvas64[off] = UNUSED_COLOR[0]
    canvas64[off + 1] = UNUSED_COLOR[1]
    canvas64[off + 2] = UNUSED_COLOR[2]
    canvas64[off + 3] = UNUSED_COLOR[3]
  }

  // Paint body regions
  for (const part of SKIN_PARTS) {
    const color = REGION_COLORS[part]
    for (const layer of SKIN_LAYERS) {
      for (const face of SKIN_FACES) {
        const rect = SKIN_RECTS[part][layer][face]
        for (let y = rect.y; y < rect.y + rect.h; y++) {
          for (let x = rect.x; x < rect.x + rect.w; x++) {
            const off = (y * SKIN_WIDTH + x) * 4
            canvas64[off] = color[0]
            canvas64[off + 1] = color[1]
            canvas64[off + 2] = color[2]
            canvas64[off + 3] = color[3]
          }
        }
      }
    }
  }

  const png1024 = upscale64To1024Png(canvas64)
  cachedTemplatePng = png1024
  return png1024
}

/**
 * Upscales 64x64 RGBA buffer 16x (nearest neighbor) to 1024x1024 and encodes as PNG.
 */
export function upscale64To1024Png(rgba64: Buffer): Buffer {
  if (rgba64.length !== 64 * 64 * 4) {
    throw new Error(`Expected 64x64 RGBA buffer (16384 bytes), got ${rgba64.length}`)
  }

  const scale = 16
  const targetSize = 64 * scale // 1024
  const canvas1024 = Buffer.alloc(targetSize * targetSize * 4)

  for (let cy = 0; cy < 64; cy++) {
    const startY = cy * scale
    for (let cx = 0; cx < 64; cx++) {
      const startX = cx * scale
      const srcOff = (cy * 64 + cx) * 4
      const r = rgba64[srcOff]
      const g = rgba64[srcOff + 1]
      const b = rgba64[srcOff + 2]
      const a = rgba64[srcOff + 3]

      for (let dy = 0; dy < scale; dy++) {
        const y = startY + dy
        const rowOff = y * targetSize * 4
        for (let dx = 0; dx < scale; dx++) {
          const x = startX + dx
          const dstOff = rowOff + x * 4
          canvas1024[dstOff] = r
          canvas1024[dstOff + 1] = g
          canvas1024[dstOff + 2] = b
          canvas1024[dstOff + 3] = a
        }
      }
    }
  }

  return encodePng(canvas1024, targetSize, targetSize)
}
