import { deflateSync, inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class ComposeError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message)
  }
}

// CRC32 table for PNG chunk generation and verification
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  crcTable[n] = c
}

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  const toCrc = Buffer.concat([typeBuf, data])
  crcBuf.writeUInt32BE(crc32(toCrc), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/**
 * Encodes a 64x64 RGBA buffer into a valid PNG.
 */
export function encodePng(rgbaBuffer: Buffer, width = 64, height = 64): Buffer {
  if (rgbaBuffer.length !== width * height * 4) {
    throw new ComposeError(`Invalid RGBA buffer length: expected ${width * height * 4}, got ${rgbaBuffer.length}`, 500)
  }

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData.writeUInt8(8, 8) // bit depth: 8
  ihdrData.writeUInt8(6, 9) // color type: 6 (RGBA)
  ihdrData.writeUInt8(0, 10) // compression
  ihdrData.writeUInt8(0, 11) // filter
  ihdrData.writeUInt8(0, 12) // interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData)

  const rowSize = 1 + width * 4
  const rawData = Buffer.alloc(height * rowSize)
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0 // filter type 0 (None)
    rgbaBuffer.copy(rawData, y * rowSize + 1, y * width * 4, (y + 1) * width * 4)
  }

  const idatChunk = makeChunk('IDAT', deflateSync(rawData))
  const iendChunk = makeChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([PNG_SIGNATURE, ihdrChunk, idatChunk, iendChunk])
}

/**
 * Decodes a 64x64 RGBA PNG into raw RGBA buffer, verifying signature, IHDR, CRC, and un-filtering.
 */
export function decodePng(buffer: Buffer): { width: number; height: number; data: Buffer } {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ComposeError('Invalid PNG: invalid signature.', 400)
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let compression = 0
  let filter = 0
  let interlace = 0
  const idatChunks: Buffer[] = []

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(offset)
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + chunkLength
    if (dataEnd + 4 > buffer.length) {
      throw new ComposeError('Invalid PNG: truncated chunk.', 400)
    }

    const chunkData = buffer.subarray(dataStart, dataEnd)
    const expectedCrc = buffer.readUInt32BE(dataEnd)
    const typeBuf = buffer.subarray(offset + 4, offset + 8)
    const actualCrc = crc32(Buffer.concat([typeBuf, chunkData]))
    if (actualCrc !== expectedCrc) {
      throw new ComposeError(`Invalid PNG: CRC mismatch in ${chunkType}.`, 400)
    }

    if (chunkType === 'IHDR') {
      if (chunkLength !== 13) throw new ComposeError('Invalid PNG: invalid IHDR length.', 400)
      width = chunkData.readUInt32BE(0)
      height = chunkData.readUInt32BE(4)
      bitDepth = chunkData.readUInt8(8)
      colorType = chunkData.readUInt8(9)
      compression = chunkData.readUInt8(10)
      filter = chunkData.readUInt8(11)
      interlace = chunkData.readUInt8(12)
    } else if (chunkType === 'IDAT') {
      idatChunks.push(chunkData)
    } else if (chunkType === 'IEND') {
      break
    }

    offset = dataEnd + 4
  }

  if (width !== 64 || height !== 64) {
    throw new ComposeError(`Skin must be 64x64 pixels (received ${width}x${height}).`, 400)
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new ComposeError(`Invalid PNG: must be 8-bit RGBA (bitDepth=${bitDepth}, colorType=${colorType}).`, 400)
  }
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new ComposeError('Invalid PNG: unsupported compression, filter, or interlace.', 400)
  }
  if (idatChunks.length === 0) {
    throw new ComposeError('Invalid PNG: missing IDAT.', 400)
  }

  let uncompressed: Buffer
  try {
    uncompressed = inflateSync(Buffer.concat(idatChunks), {
      maxOutputLength: 64 * (1 + 256),
    })
  } catch {
    throw new ComposeError('Invalid PNG: corrupted compressed data.', 400)
  }

  const bpp = 4 // 8-bit RGBA
  const rowSize = 1 + width * bpp
  if (uncompressed.length !== height * rowSize) {
    throw new ComposeError(`Invalid PNG: uncompressed size mismatch (expected ${height * rowSize}, got ${uncompressed.length}).`, 400)
  }

  const rgba = Buffer.alloc(width * height * bpp)

  for (let y = 0; y < height; y++) {
    const filterType = uncompressed[y * rowSize]
    const rowOffset = y * rowSize + 1
    const outRowOffset = y * width * bpp

    for (let xByte = 0; xByte < width * bpp; xByte++) {
      const raw = uncompressed[rowOffset + xByte]
      const a = xByte >= bpp ? rgba[outRowOffset + xByte - bpp] : 0
      const b = y > 0 ? rgba[(y - 1) * width * bpp + xByte] : 0
      const c = (y > 0 && xByte >= bpp) ? rgba[(y - 1) * width * bpp + xByte - bpp] : 0

      let val = 0
      if (filterType === 0) {
        val = raw
      } else if (filterType === 1) { // Sub
        val = (raw + a) & 0xff
      } else if (filterType === 2) { // Up
        val = (raw + b) & 0xff
      } else if (filterType === 3) { // Average
        val = (raw + Math.floor((a + b) / 2)) & 0xff
      } else if (filterType === 4) { // Paeth
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        let pr = a
        if (pb < pa && pb <= pc) pr = b
        else if (pc < pa) pr = c
        val = (raw + pr) & 0xff
      } else {
        throw new ComposeError(`Invalid PNG: unknown filter type ${filterType}.`, 400)
      }
      rgba[outRowOffset + xByte] = val
    }
  }

  return { width, height, data: rgba }
}

export type SkinPart = 'all' | 'head' | 'body' | 'arms' | 'legs'

export type PaletteMap = Map<string, [number, number, number, number]>

/**
 * Validates palette hex colors and builds index map.
 * Throws ComposeError (502) if palette is invalid or exceeds 16 colors.
 */
export function parsePalette(palette: unknown): PaletteMap {
  if (!Array.isArray(palette) || palette.length === 0 || palette.length > 16) {
    throw new ComposeError('Palette must be an array of 1 to 16 hex colors.', 502)
  }
  const hexRegex = /^#[0-9a-fA-F]{6}$/
  const map: PaletteMap = new Map()

  const transparent: [number, number, number, number] = [0, 0, 0, 0]
  map.set('.', transparent)
  map.set(' ', transparent)
  map.set('-', transparent)

  for (let i = 0; i < palette.length; i++) {
    const hex = palette[i]
    if (typeof hex !== 'string' || !hexRegex.test(hex)) {
      throw new ComposeError(`Invalid palette hex color: ${hex}.`, 502)
    }
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    const color: [number, number, number, number] = [r, g, b, 255]

    const charLower = i.toString(16).toLowerCase()
    const charUpper = i.toString(16).toUpperCase()
    map.set(charLower, color)
    map.set(charUpper, color)
  }

  return map
}

/**
 * Repairs minor width and height errors.
 * Minor width error: difference <= 2.
 * Minor height error: difference <= 1.
 * Unusable errors throw ComposeError (502).
 */
export function repairFaceRows(rows: unknown, targetW: number, targetH: number): string[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ComposeError('Face rows must be a non-empty array.', 502)
  }

  let cleaned = rows.map((r) => {
    if (typeof r !== 'string') {
      throw new ComposeError('Row must be a string.', 502)
    }
    return r.trim()
  })

  // Height check
  if (Math.abs(cleaned.length - targetH) > 1) {
    throw new ComposeError(`Unusable height: expected ${targetH}, received ${cleaned.length}.`, 502)
  }
  if (cleaned.length === targetH - 1) {
    cleaned.push(cleaned[cleaned.length - 1] ?? '.'.repeat(targetW))
  } else if (cleaned.length === targetH + 1) {
    cleaned = cleaned.slice(0, targetH)
  }

  // Width check
  return cleaned.map((row) => {
    const diff = Math.abs(row.length - targetW)
    if (diff === 0) return row
    if (diff > 2) {
      throw new ComposeError(`Unusable width: expected ${targetW}, received ${row.length}.`, 502)
    }
    if (row.length < targetW) {
      const padChar = row.length > 0 ? row[row.length - 1] : '.'
      return row.padEnd(targetW, padChar)
    }
    return row.slice(0, targetW)
  })
}

export interface NormalizedFaceGroup {
  front: string[]
  back: string[]
  top: string[]
  bottom: string[]
  left: string[]
  right: string[]
}

export function normalizeFaceGroup(
  val: unknown,
  defaultW: number,
  defaultH: number,
  sideW: number,
  topH: number,
): NormalizedFaceGroup {
  let frontRaw: unknown
  let backRaw: unknown
  let topRaw: unknown
  let bottomRaw: unknown
  let leftRaw: unknown
  let rightRaw: unknown

  if (Array.isArray(val)) {
    frontRaw = val
  } else if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>
    frontRaw = obj.front ?? (Array.isArray(obj.rows) ? obj.rows : undefined)
    backRaw = obj.back
    topRaw = obj.top
    bottomRaw = obj.bottom
    leftRaw = obj.left
    rightRaw = obj.right
  } else {
    throw new ComposeError('Part must be an array of rows or an object containing faces.', 502)
  }

  if (!frontRaw) {
    throw new ComposeError('Missing front face for part.', 502)
  }

  const front = repairFaceRows(frontRaw, defaultW, defaultH)
  const back = backRaw ? repairFaceRows(backRaw, defaultW, defaultH) : front.map((r) => r.split('').reverse().join(''))

  const right = rightRaw
    ? repairFaceRows(rightRaw, sideW, defaultH)
    : front.map((r) => r[0].repeat(sideW))

  const left = leftRaw
    ? repairFaceRows(leftRaw, sideW, defaultH)
    : front.map((r) => r[r.length - 1].repeat(sideW))

  const top = topRaw
    ? repairFaceRows(topRaw, defaultW, topH)
    : Array.from({ length: topH }, () => front[0])

  const bottom = bottomRaw
    ? repairFaceRows(bottomRaw, defaultW, topH)
    : Array.from({ length: topH }, () => front[front.length - 1])

  return { front, back, top, bottom, left, right }
}

function paintFace(
  canvas: Buffer,
  startX: number,
  startY: number,
  rows: string[],
  paletteMap: PaletteMap,
  mirrorH = false,
) {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < row.length; x++) {
      const srcX = mirrorH ? row.length - 1 - x : x
      const char = row[srcX]
      const color = paletteMap.get(char)
      if (!color) {
        throw new ComposeError(`Invalid pixel character or palette index out of bounds: '${char}'.`, 502)
      }
      const targetX = startX + x
      const targetY = startY + y
      const offset = (targetY * 64 + targetX) * 4
      canvas[offset] = color[0]
      canvas[offset + 1] = color[1]
      canvas[offset + 2] = color[2]
      canvas[offset + 3] = color[3]
    }
  }
}

/**
 * Checks whether coordinates belong to a part.
 */
export function isCoordInPart(x: number, y: number, part: SkinPart): boolean {
  if (part === 'all') return true
  if (part === 'head') {
    return y >= 0 && y <= 15
  }
  if (part === 'body') {
    return x >= 16 && x <= 39 && y >= 16 && y <= 47
  }
  if (part === 'arms') {
    const isRightArm = x >= 40 && x <= 55 && y >= 16 && y <= 47
    const isLeftArm = x >= 32 && x <= 63 && y >= 48 && y <= 63
    return isRightArm || isLeftArm
  }
  if (part === 'legs') {
    const isRightLeg = x >= 0 && x <= 15 && y >= 16 && y <= 47
    const isLeftLeg = x >= 0 && x <= 31 && y >= 48 && y <= 63
    return isRightLeg || isLeftLeg
  }
  return false
}

/**
 * Clears the pixel region of a part to transparent [0,0,0,0].
 */
export function clearPart(canvas: Buffer, part: SkinPart): void {
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (isCoordInPart(x, y, part)) {
        const offset = (y * 64 + x) * 4
        canvas[offset] = 0
        canvas[offset + 1] = 0
        canvas[offset + 2] = 0
        canvas[offset + 3] = 0
      }
    }
  }
}

/**
 * Composes a full or partial Minecraft skin from LLM JSON output.
 * If baseBuffer is provided, only pixels inside the requested part region are replaced.
 */
export function composeSkinFromJson(
  json: unknown,
  part: SkinPart = 'all',
  baseDecoded?: { width: number; height: number; data: Buffer } | null,
): Buffer {
  if (!json || typeof json !== 'object') {
    throw new ComposeError('LLM response must be a JSON object.', 502)
  }

  const { palette, parts } = json as { palette?: unknown; parts?: unknown }
  const paletteMap = parsePalette(palette)

  if (!parts || typeof parts !== 'object') {
    throw new ComposeError('LLM response missing parts object.', 502)
  }

  const partsObj = parts as Record<string, unknown>

  // Prepare canvas: either clone base image or create blank 64x64 RGBA buffer
  const canvas = baseDecoded
    ? Buffer.from(baseDecoded.data)
    : Buffer.alloc(64 * 64 * 4, 0)

  // Clear part area on canvas before painting new faces
  clearPart(canvas, part)

  // Compose Head
  if (part === 'all' || part === 'head') {
    if (!partsObj.head) {
      throw new ComposeError('Missing head part in LLM response.', 502)
    }
    const head = normalizeFaceGroup(partsObj.head, 8, 8, 8, 8)
    paintFace(canvas, 8, 0, head.top, paletteMap)
    paintFace(canvas, 16, 0, head.bottom, paletteMap)
    paintFace(canvas, 0, 8, head.right, paletteMap)
    paintFace(canvas, 8, 8, head.front, paletteMap)
    paintFace(canvas, 16, 8, head.left, paletteMap)
    paintFace(canvas, 24, 8, head.back, paletteMap)
  }

  // Compose Body
  if (part === 'all' || part === 'body') {
    if (!partsObj.body) {
      throw new ComposeError('Missing body part in LLM response.', 502)
    }
    const body = normalizeFaceGroup(partsObj.body, 8, 12, 4, 4)
    paintFace(canvas, 20, 16, body.top, paletteMap)
    paintFace(canvas, 28, 16, body.bottom, paletteMap)
    paintFace(canvas, 16, 20, body.right, paletteMap)
    paintFace(canvas, 20, 20, body.front, paletteMap)
    paintFace(canvas, 28, 20, body.left, paletteMap)
    paintFace(canvas, 32, 20, body.back, paletteMap)
  }

  // Compose Arms
  if (part === 'all' || part === 'arms') {
    const armSource = partsObj.arm ?? partsObj.arms
    if (!armSource) {
      throw new ComposeError('Missing arm part in LLM response.', 502)
    }
    const arm = normalizeFaceGroup(armSource, 4, 12, 4, 4)

    // Right Arm (Base)
    paintFace(canvas, 44, 16, arm.top, paletteMap)
    paintFace(canvas, 48, 16, arm.bottom, paletteMap)
    paintFace(canvas, 40, 20, arm.right, paletteMap)
    paintFace(canvas, 44, 20, arm.front, paletteMap)
    paintFace(canvas, 48, 20, arm.left, paletteMap)
    paintFace(canvas, 52, 20, arm.back, paletteMap)

    // Left Arm (Mirrored Right Arm)
    paintFace(canvas, 36, 48, arm.top, paletteMap, true)
    paintFace(canvas, 40, 48, arm.bottom, paletteMap, true)
    paintFace(canvas, 32, 52, arm.left, paletteMap, true)
    paintFace(canvas, 36, 52, arm.front, paletteMap, true)
    paintFace(canvas, 40, 52, arm.right, paletteMap, true)
    paintFace(canvas, 44, 52, arm.back, paletteMap, true)
  }

  // Compose Legs
  if (part === 'all' || part === 'legs') {
    const legSource = partsObj.leg ?? partsObj.legs
    if (!legSource) {
      throw new ComposeError('Missing leg part in LLM response.', 502)
    }
    const leg = normalizeFaceGroup(legSource, 4, 12, 4, 4)

    // Right Leg (Base)
    paintFace(canvas, 4, 16, leg.top, paletteMap)
    paintFace(canvas, 8, 16, leg.bottom, paletteMap)
    paintFace(canvas, 0, 20, leg.right, paletteMap)
    paintFace(canvas, 4, 20, leg.front, paletteMap)
    paintFace(canvas, 8, 20, leg.left, paletteMap)
    paintFace(canvas, 12, 20, leg.back, paletteMap)

    // Left Leg (Mirrored Right Leg)
    paintFace(canvas, 20, 48, leg.top, paletteMap, true)
    paintFace(canvas, 24, 48, leg.bottom, paletteMap, true)
    paintFace(canvas, 16, 52, leg.left, paletteMap, true)
    paintFace(canvas, 20, 52, leg.front, paletteMap, true)
    paintFace(canvas, 24, 52, leg.right, paletteMap, true)
    paintFace(canvas, 28, 52, leg.back, paletteMap, true)
  }

  return encodePng(canvas, 64, 64)
}
