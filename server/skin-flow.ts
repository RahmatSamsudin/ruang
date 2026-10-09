import { inflateSync } from 'node:zlib'
import { crc32, encodePng } from './skin-compose.js'
import {
  SKIN_WIDTH,
  SKIN_HEIGHT,
  isInsideLayout,
  isCoordInPart,
  type SkinPart,
} from './skin-layout.js'
import { validatePng } from './skins.js'

export const FLOW_PROMPT_PREFIX = 'Minecraft player skin texture sheet for: '
export const FLOW_PROMPT_SUFFIX =
  '. Follow the attached template layout exactly: same regions, same positions, no text, flat pixel-art look, hard edges, no antialiasing, no gradients, no shadows, background grey outside regions.'

export function buildFlowPrompt(userPrompt: string): string {
  // Strip control chars, trim, limit to 300 chars
  // eslint-disable-next-line no-control-regex
  const sanitized = userPrompt.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 300)
  return `${FLOW_PROMPT_PREFIX}${sanitized}${FLOW_PROMPT_SUFFIX}`
}

export interface DecodedFlowPng {
  width: number
  height: number
  data: Buffer // RGBA buffer (width * height * 4)
}

/**
 * Pure Node.js PNG decoder for Flow output.
 * Handles 8-bit color types 2 (RGB), 6 (RGBA), 0 (Grayscale), 3 (Indexed/PLTE).
 * Rejects 16-bit, interlaced, >4096 px or corrupt PNGs with Error("unusable output").
 */
export function decodeFlowPng(buffer: Buffer): DecodedFlowPng {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('unusable output')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let compression = 0
  let filterMethod = 0
  let interlace = 0
  let seenIhdr = false

  const idatChunks: Buffer[] = []
  const palette: [number, number, number][] = []
  const trns: number[] = []

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      throw new Error('unusable output')
    }

    const chunkLen = buffer.readUInt32BE(offset)
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8)

    if (offset + 12 + chunkLen > buffer.length) {
      throw new Error('unusable output')
    }

    const chunkData = buffer.subarray(offset + 8, offset + 8 + chunkLen)
    const expectedCrc = buffer.readUInt32BE(offset + 8 + chunkLen)
    const typeAndData = buffer.subarray(offset + 4, offset + 8 + chunkLen)
    const actualCrc = crc32(typeAndData)

    if (actualCrc !== expectedCrc) {
      throw new Error('unusable output')
    }

    offset += 12 + chunkLen

    if (chunkType === 'IHDR') {
      if (seenIhdr || chunkLen !== 13) {
        throw new Error('unusable output')
      }
      seenIhdr = true
      width = chunkData.readUInt32BE(0)
      height = chunkData.readUInt32BE(4)
      bitDepth = chunkData[8]
      colorType = chunkData[9]
      compression = chunkData[10]
      filterMethod = chunkData[11]
      interlace = chunkData[12]

      if (width <= 0 || width > 4096 || height <= 0 || height > 4096) {
        throw new Error('unusable output')
      }
      if (bitDepth !== 8) {
        throw new Error('unusable output')
      }
      if (interlace !== 0) {
        throw new Error('unusable output')
      }
      if (compression !== 0 || filterMethod !== 0) {
        throw new Error('unusable output')
      }
      if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 6) {
        throw new Error('unusable output')
      }
    } else if (chunkType === 'PLTE') {
      if (chunkLen % 3 !== 0) {
        throw new Error('unusable output')
      }
      for (let p = 0; p < chunkLen; p += 3) {
        palette.push([chunkData[p], chunkData[p + 1], chunkData[p + 2]])
      }
    } else if (chunkType === 'tRNS') {
      for (let t = 0; t < chunkLen; t++) {
        trns.push(chunkData[t])
      }
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData)
    } else if (chunkType === 'IEND') {
      break
    }
  }

  if (!seenIhdr || idatChunks.length === 0) {
    throw new Error('unusable output')
  }

  let bpp = 4
  if (colorType === 2) bpp = 3
  else if (colorType === 0 || colorType === 3) bpp = 1

  const maxOutputLength = height * (1 + width * bpp)
  let uncompressed: Buffer
  try {
    uncompressed = inflateSync(Buffer.concat(idatChunks), { maxOutputLength })
  } catch {
    throw new Error('unusable output')
  }

  const rowSize = 1 + width * bpp
  if (uncompressed.length !== height * rowSize) {
    throw new Error('unusable output')
  }

  const rawBytes = Buffer.alloc(width * height * bpp)

  for (let y = 0; y < height; y++) {
    const filterType = uncompressed[y * rowSize]
    const rowOffset = y * rowSize + 1
    const outRowOffset = y * width * bpp

    for (let xByte = 0; xByte < width * bpp; xByte++) {
      const raw = uncompressed[rowOffset + xByte]
      const a = xByte >= bpp ? rawBytes[outRowOffset + xByte - bpp] : 0
      const b = y > 0 ? rawBytes[(y - 1) * width * bpp + xByte] : 0
      const c = y > 0 && xByte >= bpp ? rawBytes[(y - 1) * width * bpp + xByte - bpp] : 0

      let val = 0
      switch (filterType) {
        case 0:
          val = raw
          break
        case 1:
          val = (raw + a) & 0xff
          break
        case 2:
          val = (raw + b) & 0xff
          break
        case 3:
          val = (raw + Math.floor((a + b) / 2)) & 0xff
          break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pr = pb < pa && pb <= pc ? b : pc < pa ? c : a
          val = (raw + pr) & 0xff
          break
        }
        default:
          throw new Error('unusable output')
      }
      rawBytes[outRowOffset + xByte] = val
    }
  }

  const rgba = Buffer.alloc(width * height * 4)
  if (colorType === 6) {
    rawBytes.copy(rgba)
  } else if (colorType === 2) {
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = rawBytes[i * 3]
      rgba[i * 4 + 1] = rawBytes[i * 3 + 1]
      rgba[i * 4 + 2] = rawBytes[i * 3 + 2]
      rgba[i * 4 + 3] = 255
    }
  } else if (colorType === 0) {
    for (let i = 0; i < width * height; i++) {
      const val = rawBytes[i]
      rgba[i * 4] = val
      rgba[i * 4 + 1] = val
      rgba[i * 4 + 2] = val
      rgba[i * 4 + 3] = 255
    }
  } else if (colorType === 3) {
    for (let i = 0; i < width * height; i++) {
      const idx = rawBytes[i]
      const color = palette[idx] || [0, 0, 0]
      rgba[i * 4] = color[0]
      rgba[i * 4 + 1] = color[1]
      rgba[i * 4 + 2] = color[2]
      rgba[i * 4 + 3] = trns[idx] !== undefined ? trns[idx] : 255
    }
  }

  return { width, height, data: rgba }
}

/**
 * Resizes RGBA buffer to targetW x targetH using nearest neighbor.
 */
export function resizeRgba(
  src: Buffer,
  srcW: number,
  srcH: number,
  targetW = 1024,
  targetH = 1024,
): Buffer {
  if (srcW === targetW && srcH === targetH) {
    return Buffer.from(src)
  }

  const dst = Buffer.alloc(targetW * targetH * 4)
  for (let dy = 0; dy < targetH; dy++) {
    const sy = Math.min(srcH - 1, Math.floor((dy / targetH) * srcH))
    const sRowOffset = sy * srcW * 4
    const dRowOffset = dy * targetW * 4
    for (let dx = 0; dx < targetW; dx++) {
      const sx = Math.min(srcW - 1, Math.floor((dx / targetW) * srcW))
      const sOffset = sRowOffset + sx * 4
      const dOffset = dRowOffset + dx * 4
      dst[dOffset] = src[sOffset]
      dst[dOffset + 1] = src[sOffset + 1]
      dst[dOffset + 2] = src[sOffset + 2]
      dst[dOffset + 3] = src[sOffset + 3]
    }
  }
  return dst
}

/**
 * Downsamples 1024x1024 RGBA image to 64x64 using median color of each 16x16 cell.
 */
export function downsampleTo64x64(src1024: Buffer): Buffer {
  if (src1024.length !== 1024 * 1024 * 4) {
    throw new Error('unusable output')
  }

  const dst64 = Buffer.alloc(SKIN_WIDTH * SKIN_HEIGHT * 4)
  const rVals = new Uint8Array(256)
  const gVals = new Uint8Array(256)
  const bVals = new Uint8Array(256)

  for (let cy = 0; cy < 64; cy++) {
    for (let cx = 0; cx < 64; cx++) {
      let idx = 0
      for (let py = 0; py < 16; py++) {
        const y = cy * 16 + py
        const rowOffset = y * 1024 * 4
        for (let px = 0; px < 16; px++) {
          const x = cx * 16 + px
          const offset = rowOffset + x * 4
          rVals[idx] = src1024[offset]
          gVals[idx] = src1024[offset + 1]
          bVals[idx] = src1024[offset + 2]
          idx++
        }
      }

      rVals.sort()
      gVals.sort()
      bVals.sort()

      const dstOffset = (cy * 64 + cx) * 4
      dst64[dstOffset] = rVals[128]
      dst64[dstOffset + 1] = gVals[128]
      dst64[dstOffset + 2] = bVals[128]
      dst64[dstOffset + 3] = 255
    }
  }

  return dst64
}

interface ColorCount {
  r: number
  g: number
  b: number
  count: number
}

interface MedianCutBox {
  colors: ColorCount[]
  totalCount: number
  maxRange: number
  axis: 'r' | 'g' | 'b'
}

function createBox(colors: ColorCount[]): MedianCutBox {
  let rMin = 255, rMax = 0
  let gMin = 255, gMax = 0
  let bMin = 255, bMax = 0
  let totalCount = 0

  for (const c of colors) {
    if (c.r < rMin) rMin = c.r
    if (c.r > rMax) rMax = c.r
    if (c.g < gMin) gMin = c.g
    if (c.g > gMax) gMax = c.g
    if (c.b < bMin) bMin = c.b
    if (c.b > bMax) bMax = c.b
    totalCount += c.count
  }

  const rRange = rMax - rMin
  const gRange = gMax - gMin
  const bRange = bMax - bMin
  const maxRange = Math.max(rRange, gRange, bRange)

  let axis: 'r' | 'g' | 'b' = 'r'
  if (gRange >= rRange && gRange >= bRange) {
    axis = 'g'
  } else if (bRange >= rRange && bRange >= gRange) {
    axis = 'b'
  }

  return { colors, totalCount, maxRange, axis }
}

/**
 * Quantizes colors of pixels inside layout regions to <= maxColors (24) using deterministic median-cut.
 */
export function quantizeColors(src64: Buffer, maxColors = 24): Buffer {
  const result = Buffer.from(src64)
  const counts = new Map<number, ColorCount>()

  for (let y = 0; y < SKIN_HEIGHT; y++) {
    for (let x = 0; x < SKIN_WIDTH; x++) {
      if (!isInsideLayout(x, y)) continue
      const off = (y * SKIN_WIDTH + x) * 4
      const r = src64[off]
      const g = src64[off + 1]
      const b = src64[off + 2]
      const key = (r << 16) | (g << 8) | b
      const entry = counts.get(key)
      if (entry) {
        entry.count++
      } else {
        counts.set(key, { r, g, b, count: 1 })
      }
    }
  }

  if (counts.size <= maxColors) {
    return result
  }

  const initialBox = createBox(Array.from(counts.values()))
  const boxes: MedianCutBox[] = [initialBox]

  while (boxes.length < maxColors) {
    // Find splittable box with highest maxRange
    let bestIdx = -1
    let bestRange = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].colors.length > 1 && boxes[i].maxRange > bestRange) {
        bestRange = boxes[i].maxRange
        bestIdx = i
      }
    }

    if (bestIdx === -1 || bestRange === 0) {
      break
    }

    const boxToSplit = boxes.splice(bestIdx, 1)[0]
    const axis = boxToSplit.axis

    boxToSplit.colors.sort((c1, c2) => {
      if (c1[axis] !== c2[axis]) return c1[axis] - c2[axis]
      if (c1.r !== c2.r) return c1.r - c2.r
      if (c1.g !== c2.g) return c1.g - c2.g
      return c1.b - c2.b
    })

    const mid = Math.floor(boxToSplit.colors.length / 2)
    const leftColors = boxToSplit.colors.slice(0, mid)
    const rightColors = boxToSplit.colors.slice(mid)

    boxes.push(createBox(leftColors))
    boxes.push(createBox(rightColors))
  }

  // Create mapping from original color key to representative color
  const colorMap = new Map<number, [number, number, number]>()
  for (const box of boxes) {
    if (box.totalCount === 0) continue
    let sumR = 0, sumG = 0, sumB = 0
    for (const c of box.colors) {
      sumR += c.r * c.count
      sumG += c.g * c.count
      sumB += c.b * c.count
    }
    const repR = Math.round(sumR / box.totalCount)
    const repG = Math.round(sumG / box.totalCount)
    const repB = Math.round(sumB / box.totalCount)

    for (const c of box.colors) {
      const key = (c.r << 16) | (c.g << 8) | c.b
      colorMap.set(key, [repR, repG, repB])
    }
  }

  for (let y = 0; y < SKIN_HEIGHT; y++) {
    for (let x = 0; x < SKIN_WIDTH; x++) {
      if (!isInsideLayout(x, y)) continue
      const off = (y * SKIN_WIDTH + x) * 4
      const r = src64[off]
      const g = src64[off + 1]
      const b = src64[off + 2]
      const key = (r << 16) | (g << 8) | b
      const rep = colorMap.get(key)
      if (rep) {
        result[off] = rep[0]
        result[off + 1] = rep[1]
        result[off + 2] = rep[2]
      }
    }
  }

  return result
}

/**
 * Pixels outside layout regions -> transparent [0, 0, 0, 0], alpha 255 inside regions.
 */
export function applyLayoutMask(src64: Buffer): Buffer {
  const result = Buffer.from(src64)
  for (let y = 0; y < SKIN_HEIGHT; y++) {
    for (let x = 0; x < SKIN_WIDTH; x++) {
      const off = (y * SKIN_WIDTH + x) * 4
      if (!isInsideLayout(x, y)) {
        result[off] = 0
        result[off + 1] = 0
        result[off + 2] = 0
        result[off + 3] = 0
      } else {
        result[off + 3] = 255
      }
    }
  }
  return result
}

/**
 * Replaces part coordinates from canvas64 into base64.
 * Coordinates outside part remain byte-identical to base64.
 */
export function replacePart(canvas64: Buffer, base64: Buffer, part: SkinPart): Buffer {
  if (part === 'all') {
    return canvas64
  }

  const result = Buffer.from(base64)
  for (let y = 0; y < SKIN_HEIGHT; y++) {
    for (let x = 0; x < SKIN_WIDTH; x++) {
      if (isCoordInPart(x, y, part)) {
        const off = (y * SKIN_WIDTH + x) * 4
        result[off] = canvas64[off]
        result[off + 1] = canvas64[off + 1]
        result[off + 2] = canvas64[off + 2]
        result[off + 3] = canvas64[off + 3]
      }
    }
  }
  return result
}

/**
 * Complete Flow image post-processing pipeline:
 * 1. decodeFlowPng (8-bit, 2/6/0/3, rejects invalid/16-bit/interlace/>4096)
 * 2. resize to 1024x1024
 * 3. downsample to 64x64 using median color of each 16x16 cell
 * 4. quantize to <=24 colors
 * 5. pixels outside layout regions -> transparent, alpha 255 inside regions
 * 6. part-replace into base if part != 'all'
 * 7. validate final 64x64 RGBA PNG
 */
export function processFlowSkinImage(
  rawBytes: Buffer,
  part: SkinPart = 'all',
  baseDecoded: { width: number; height: number; data: Buffer } | null = null,
): Buffer {
  const decoded = decodeFlowPng(rawBytes)
  const resized1024 = resizeRgba(decoded.data, decoded.width, decoded.height, 1024, 1024)
  const downsampled64 = downsampleTo64x64(resized1024)
  const quantized64 = quantizeColors(downsampled64, 24)
  const masked64 = applyLayoutMask(quantized64)

  let final64 = masked64
  if (part !== 'all' && baseDecoded) {
    final64 = replacePart(final64, baseDecoded.data, part)
  }

  const finalPng = encodePng(final64, SKIN_WIDTH, SKIN_HEIGHT)
  validatePng(finalPng)
  return finalPng
}

/**
 * Process BLOCK service 64x64 PNG output:
 * 1. decode 64x64 PNG (reject invalid or non-64x64)
 * 2. part-replace into baseDecoded if part !== 'all'
 * 3. encode to 64x64 RGBA PNG and validate
 */
export function processBlockSkinImage(
  rawBytes: Buffer,
  part: SkinPart = 'all',
  baseDecoded: { width: number; height: number; data: Buffer } | null = null,
): Buffer {
  let decoded: { width: number; height: number; data: Buffer }
  try {
    decoded = decodeFlowPng(rawBytes)
  } catch (err) {
    throw new Error('unusable output', { cause: err })
  }
  if (decoded.width !== SKIN_WIDTH || decoded.height !== SKIN_HEIGHT) {
    throw new Error('unusable output')
  }

  let final64 = decoded.data
  if (part !== 'all' && baseDecoded) {
    final64 = replacePart(final64, baseDecoded.data, part)
  }

  const finalPng = encodePng(final64, SKIN_WIDTH, SKIN_HEIGHT)
  validatePng(finalPng)
  return finalPng
}
