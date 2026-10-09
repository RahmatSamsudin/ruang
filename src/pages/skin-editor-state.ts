import {
  SKIN_WIDTH,
  SKIN_PART_BOUNDS,
  type Rect,
} from '../scene3d/skin'

export const SKIN_SIZE = SKIN_WIDTH
export const PIXEL_COUNT = SKIN_SIZE * SKIN_SIZE
export const BYTES_PER_PIXEL = 4
export const BUFFER_LENGTH = PIXEL_COUNT * BYTES_PER_PIXEL

export type RgbaColor = [number, number, number, number]

export type SkinTool = 'pencil' | 'eraser' | 'bucket' | 'eyedropper'

export type ClearablePart = 'head' | 'body' | 'arms' | 'legs'

export const DEFAULT_SWATCHES: string[] = [
  '#000000',
  '#ffffff',
  '#555555',
  '#aaaaaa',
  '#b54b45',
  '#e76f51',
  '#e6b34e',
  '#f4d35e',
  '#4f9c7a',
  '#2f4f3a',
  '#70bdcb',
  '#5a8dee',
  '#8f7ae6',
  '#f4a3b4',
  '#e9b57d',
  '#8b5a2b',
]

export function colorsEqual(a: RgbaColor, b: RgbaColor): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

export function arePixelBuffersEqual(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function rgbaToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => c.toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function hexToRgba(hex: string, alpha = 255): RgbaColor {
  const clean = hex.replace(/^#/, '')
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16)
    const g = parseInt(clean[1] + clean[1], 16)
    const b = parseInt(clean[2] + clean[2], 16)
    return [r, g, b, alpha]
  }
  if (clean.length === 6) {
    const r = parseInt(clean.substring(0, 2), 16)
    const g = parseInt(clean.substring(2, 4), 16)
    const b = parseInt(clean.substring(4, 6), 16)
    return [r, g, b, alpha]
  }
  return [0, 0, 0, alpha]
}

export function pixelIndex(x: number, y: number): number {
  return (y * SKIN_SIZE + x) * BYTES_PER_PIXEL
}

export function getPixel(pixels: Uint8ClampedArray, x: number, y: number): RgbaColor {
  if (x < 0 || x >= SKIN_SIZE || y < 0 || y >= SKIN_SIZE) return [0, 0, 0, 0]
  const idx = pixelIndex(x, y)
  return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]]
}

export function setPixel(pixels: Uint8ClampedArray, x: number, y: number, color: RgbaColor): void {
  if (x < 0 || x >= SKIN_SIZE || y < 0 || y >= SKIN_SIZE) return
  const idx = pixelIndex(x, y)
  pixels[idx] = color[0]
  pixels[idx + 1] = color[1]
  pixels[idx + 2] = color[2]
  pixels[idx + 3] = color[3]
}

export function drawLine(
  pixels: Uint8ClampedArray,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: RgbaColor,
): void {
  let cx0 = Math.floor(x0)
  let cy0 = Math.floor(y0)
  const cx1 = Math.floor(x1)
  const cy1 = Math.floor(y1)

  const dx = Math.abs(cx1 - cx0)
  const dy = Math.abs(cy1 - cy0)
  const sx = cx0 < cx1 ? 1 : -1
  const sy = cy0 < cy1 ? 1 : -1
  let err = dx - dy

  while (true) {
    setPixel(pixels, cx0, cy0, color)
    if (cx0 === cx1 && cy0 === cy1) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      cx0 += sx
    }
    if (e2 < dx) {
      err += dx
      cy0 += sy
    }
  }
}

/** 4-connected flood fill on matching RGBA color. */
export function floodFill(
  pixels: Uint8ClampedArray,
  startX: number,
  startY: number,
  fillColor: RgbaColor,
): boolean {
  if (startX < 0 || startX >= SKIN_SIZE || startY < 0 || startY >= SKIN_SIZE) return false
  const targetColor = getPixel(pixels, startX, startY)
  if (colorsEqual(targetColor, fillColor)) return false

  const visited = new Uint8Array(PIXEL_COUNT)
  const queue: number[] = [startX | (startY << 8)]
  visited[startY * SKIN_SIZE + startX] = 1
  let modified = false

  while (queue.length > 0) {
    const coord = queue.pop()!
    const x = coord & 0xff
    const y = (coord >> 8) & 0xff

    const current = getPixel(pixels, x, y)
    if (colorsEqual(current, targetColor)) {
      setPixel(pixels, x, y, fillColor)
      modified = true

      const neighbors: [number, number][] = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]
      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < SKIN_SIZE && ny >= 0 && ny < SKIN_SIZE) {
          const idx = ny * SKIN_SIZE + nx
          if (!visited[idx]) {
            visited[idx] = 1
            queue.push(nx | (ny << 8))
          }
        }
      }
    }
  }

  return modified
}

export function getPartRects(part: ClearablePart): Rect[] {
  switch (part) {
    case 'head':
      return [SKIN_PART_BOUNDS.head.base, SKIN_PART_BOUNDS.head.overlay]
    case 'body':
      return [SKIN_PART_BOUNDS.body.base, SKIN_PART_BOUNDS.body.overlay]
    case 'arms':
      return [
        SKIN_PART_BOUNDS.rightArm.base,
        SKIN_PART_BOUNDS.rightArm.overlay,
        SKIN_PART_BOUNDS.leftArm.base,
        SKIN_PART_BOUNDS.leftArm.overlay,
      ]
    case 'legs':
      return [
        SKIN_PART_BOUNDS.rightLeg.base,
        SKIN_PART_BOUNDS.rightLeg.overlay,
        SKIN_PART_BOUNDS.leftLeg.base,
        SKIN_PART_BOUNDS.leftLeg.overlay,
      ]
  }
}

/** Clear (erase to transparent 0,0,0,0) all pixels of a given part. */
export function clearPart(pixels: Uint8ClampedArray, part: ClearablePart): boolean {
  const rects = getPartRects(part)
  let modified = false
  const transparent: RgbaColor = [0, 0, 0, 0]

  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const cur = getPixel(pixels, x, y)
        if (!colorsEqual(cur, transparent)) {
          setPixel(pixels, x, y, transparent)
          modified = true
        }
      }
    }
  }

  return modified
}

export function addRecentSwatch(
  swatches: string[],
  colorHex: string,
  maxSwatches = 16,
): string[] {
  const normalized = colorHex.toLowerCase()
  const filtered = swatches.filter((s) => s.toLowerCase() !== normalized)
  return [normalized, ...filtered].slice(0, maxSwatches)
}

/** Bounded undo/redo history manager (defaults to 60 steps, >= 50 required). */
export class UndoHistory {
  private past: Uint8ClampedArray[] = []
  private present: Uint8ClampedArray
  private future: Uint8ClampedArray[] = []
  private readonly capacity: number

  constructor(initialPixels: Uint8ClampedArray, capacity = 60) {
    this.present = new Uint8ClampedArray(initialPixels)
    this.capacity = capacity
  }

  push(newPixels: Uint8ClampedArray): void {
    this.past.push(new Uint8ClampedArray(this.present))
    if (this.past.length > this.capacity) {
      this.past.shift()
    }
    this.present = new Uint8ClampedArray(newPixels)
    this.future = []
  }

  undo(): Uint8ClampedArray | null {
    if (this.past.length === 0) return null
    const prev = this.past.pop()!
    this.future.push(this.present)
    this.present = prev
    return new Uint8ClampedArray(this.present)
  }

  redo(): Uint8ClampedArray | null {
    if (this.future.length === 0) return null
    const next = this.future.pop()!
    this.past.push(this.present)
    this.present = next
    return new Uint8ClampedArray(this.present)
  }

  canUndo(): boolean {
    return this.past.length > 0
  }

  canRedo(): boolean {
    return this.future.length > 0
  }

  current(): Uint8ClampedArray {
    return new Uint8ClampedArray(this.present)
  }

  reset(pixels: Uint8ClampedArray): void {
    this.present = new Uint8ClampedArray(pixels)
    this.past = []
    this.future = []
  }

  historyLength(): number {
    return this.past.length
  }

  futureLength(): number {
    return this.future.length
  }
}

export interface PngValidationResult {
  valid: boolean
  error?: string
  width?: number
  height?: number
}

/** Pure parser to validate 64x64 PNG binary before ingestion. */
export function validateSkinPng(bytes: Uint8Array): PngValidationResult {
  if (bytes.length < 33) {
    return { valid: false, error: 'File is too small to be a valid PNG (minimum 33 bytes)' }
  }

  // PNG Magic 8-byte signature: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== signature[i]) {
      return { valid: false, error: 'Not a valid PNG image (invalid signature)' }
    }
  }

  // IHDR chunk: 4 bytes length (must be 13), 4 bytes type ('IHDR')
  const ihdrLen = (bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]
  const ihdrType = String.fromCharCode(...bytes.slice(12, 16))
  if (ihdrLen !== 13 || ihdrType !== 'IHDR') {
    return { valid: false, error: 'Corrupted PNG header (invalid IHDR chunk)' }
  }

  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]

  if (width !== SKIN_SIZE || height !== SKIN_SIZE) {
    return {
      valid: false,
      error: `Skin PNG must be exactly 64x64 pixels (found ${width}x${height})`,
      width,
      height,
    }
  }

  return { valid: true, width, height }
}

/** Fallback parser for uncompressed PNGs (e.g. generated by encodeRgbaToPng in tests). */
export function decodeUncompressedPng(bytes: Uint8Array): Uint8ClampedArray {
  // Search for 'IDAT' chunk
  let offset = 8
  while (offset + 8 < bytes.length) {
    const chunkLen =
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]
    const chunkType = String.fromCharCode(...bytes.slice(offset + 4, offset + 8))
    if (chunkType === 'IDAT') {
      const dataStart = offset + 8
      // zlib header (2 bytes) + deflate uncompressed header (1 byte block + 4 bytes len/nlen)
      if (bytes[dataStart + 2] === 0x01) {
        const rawStart = dataStart + 7
        const output = new Uint8ClampedArray(BUFFER_LENGTH)
        const stride = 1 + SKIN_SIZE * BYTES_PER_PIXEL // 257
        for (let y = 0; y < SKIN_SIZE; y++) {
          const rowSource = rawStart + y * stride + 1
          const rowDest = y * SKIN_SIZE * BYTES_PER_PIXEL
          for (let i = 0; i < SKIN_SIZE * BYTES_PER_PIXEL; i++) {
            output[rowDest + i] = bytes[rowSource + i]
          }
        }
        return output
      }
      break
    }
    offset += 12 + chunkLen
  }
  return new Uint8ClampedArray(BUFFER_LENGTH)
}

/** Decodes PNG binary bytes into 64x64 RGBA pixel array. */
export async function decodePngBytes(bytes: Uint8Array): Promise<Uint8ClampedArray> {
  const validation = validateSkinPng(bytes)
  if (!validation.valid) {
    throw new Error(validation.error ?? 'Invalid PNG file')
  }

  if (typeof window !== 'undefined' && typeof createImageBitmap === 'function' && typeof document !== 'undefined') {
    try {
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = SKIN_SIZE
      canvas.height = SKIN_SIZE
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0)
        return ctx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data
      }
    } catch {
      // Fallback below
    }
  }

  return decodeUncompressedPng(bytes)
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
