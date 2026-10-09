import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import {
  decodeFlowPng,
  buildFlowPrompt,
  processFlowSkinImage,
  quantizeColors,
  downsampleTo64x64,
} from './skin-flow.js'
import { createTemplatePng, upscale64To1024Png } from './skin-template.js'
import { isCoordInPart, isInsideLayout } from './skin-layout.js'
import {
  GenerateRateLimiter,
  installSkinGenerate,
  SkinJobManager,
} from './skin-generate.js'
import { decodePng, encodePng } from './skin-compose.js'

// Simple CRC32 for custom test PNG chunks
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  crcTable[n] = c >>> 0
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff]
  }
  return (c ^ 0xffffffff) >>> 0
}

function createCustomPng(
  width: number,
  height: number,
  colorType = 6, // 6 = RGBA, 2 = RGB
  bitDepth = 8,
  interlace = 0,
  fillColor: [number, number, number, number] = [180, 120, 60, 255],
): Buffer {
  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const rowSize = 1 + width * bytesPerPixel
  const rawData = Buffer.alloc(height * rowSize)

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize
    rawData[rowOffset] = 0 // None filter
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * bytesPerPixel
      rawData[pxOffset] = fillColor[0]
      rawData[pxOffset + 1] = fillColor[1]
      rawData[pxOffset + 2] = fillColor[2]
      if (colorType === 6) {
        rawData[pxOffset + 3] = fillColor[3]
      }
    }
  }

  const compressed = zlib.deflateSync(rawData)

  function createChunk(type: string, data: Buffer): Buffer {
    const buf = Buffer.alloc(12 + data.length)
    buf.writeUInt32BE(data.length, 0)
    buf.write(type, 4, 'ascii')
    data.copy(buf, 8)
    const crc = crc32(buf.subarray(4, 8 + data.length))
    buf.writeUInt32BE(crc, 8 + data.length)
    return buf
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = interlace

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', compressed),
    createChunk('IEND', Buffer.alloc(0)),
  ])
}

describe('F3 Template and Layout', () => {
  it('template PNG is 1024x1024 RGBA upscaled 16x', () => {
    const templatePng = createTemplatePng()
    const decoded = decodeFlowPng(templatePng)
    expect(decoded.width).toBe(1024)
    expect(decoded.height).toBe(1024)
    expect(decoded.data.length).toBe(1024 * 1024 * 4)
  })

  it('template PNG regions match Minecraft layout and distinct flat colors', () => {
    const templatePng = createTemplatePng()
    const decoded = decodeFlowPng(templatePng)

    // Check pixel at head front (x=20*16, y=8*16) -> should be HEAD color (255, 107, 107)
    const headX = 20 * 16 + 8
    const headY = 8 * 16 + 8
    const headIdx = (headY * 1024 + headX) * 4
    expect(decoded.data[headIdx]).toBe(255)
    expect(decoded.data[headIdx + 1]).toBe(107)
    expect(decoded.data[headIdx + 2]).toBe(107)
    expect(decoded.data[headIdx + 3]).toBe(255)

    // Check pixel outside layout (e.g. x=0, y=0) -> should be flat grey #808080
    const outIdx = 0
    expect(decoded.data[outIdx]).toBe(0x80)
    expect(decoded.data[outIdx + 1]).toBe(0x80)
    expect(decoded.data[outIdx + 2]).toBe(0x80)
    expect(decoded.data[outIdx + 3]).toBe(255)
  })

  it('upscales 64x64 base PNG to 1024x1024 nearest-neighbor', () => {
    const base64Rgba = Buffer.alloc(64 * 64 * 4)
    // Put a red pixel at 10, 10
    const idx = (10 * 64 + 10) * 4
    base64Rgba[idx] = 255
    base64Rgba[idx + 1] = 0
    base64Rgba[idx + 2] = 0
    base64Rgba[idx + 3] = 255

    const upscaledPng = upscale64To1024Png(base64Rgba)
    const decoded = decodeFlowPng(upscaledPng)
    expect(decoded.width).toBe(1024)
    expect(decoded.height).toBe(1024)

    // The 16x16 block corresponding to (10, 10) should all be red
    for (let dy = 0; dy < 16; dy++) {
      for (let dx = 0; dx < 16; dx++) {
        const pIdx = ((10 * 16 + dy) * 1024 + (10 * 16 + dx)) * 4
        expect(decoded.data[pIdx]).toBe(255)
        expect(decoded.data[pIdx + 1]).toBe(0)
        expect(decoded.data[pIdx + 2]).toBe(0)
        expect(decoded.data[pIdx + 3]).toBe(255)
      }
    }
  })

  it('buildFlowPrompt wraps user prompt and strips control characters', () => {
    const prompt = buildFlowPrompt('Cool\x00\x1f \t cyber\r\nwarrior!')
    expect(prompt).toContain('Minecraft player skin texture sheet for: Cool')
    expect(prompt).toContain('cyber')
    expect(prompt).toContain('warrior!')
    expect(prompt).toContain('Follow the attached template layout exactly')
    expect(prompt).not.toContain('\x00')
    expect(prompt).not.toContain('\x1f')
  })
})

describe('F3 Pure-Node PNG Decoder and Post-processing', () => {
  it('decodes 8-bit RGBA (type 6)', () => {
    const png = createCustomPng(100, 100, 6, 8, 0, [10, 20, 30, 255])
    const decoded = decodeFlowPng(png)
    expect(decoded.width).toBe(100)
    expect(decoded.height).toBe(100)
    expect(decoded.data[0]).toBe(10)
    expect(decoded.data[1]).toBe(20)
    expect(decoded.data[2]).toBe(30)
    expect(decoded.data[3]).toBe(255)
  })

  it('decodes 8-bit RGB (type 2) and converts to RGBA', () => {
    const png = createCustomPng(50, 50, 2, 8, 0, [40, 50, 60, 255])
    const decoded = decodeFlowPng(png)
    expect(decoded.width).toBe(50)
    expect(decoded.height).toBe(50)
    expect(decoded.data.length).toBe(50 * 50 * 4)
    expect(decoded.data[0]).toBe(40)
    expect(decoded.data[1]).toBe(50)
    expect(decoded.data[2]).toBe(60)
    expect(decoded.data[3]).toBe(255)
  })

  it('throws unusable output on interlaced PNG', () => {
    const png = createCustomPng(32, 32, 6, 8, 1)
    expect(() => decodeFlowPng(png)).toThrow('unusable output')
  })

  it('throws unusable output on 16-bit PNG', () => {
    const png = createCustomPng(32, 32, 6, 16, 0)
    expect(() => decodeFlowPng(png)).toThrow('unusable output')
  })

  it('throws unusable output on >4096 px dimension', () => {
    const png = createCustomPng(4097, 10, 6, 8, 0)
    expect(() => decodeFlowPng(png)).toThrow('unusable output')
  })

  it('throws unusable output on corrupt PNG', () => {
    const corrupt = Buffer.from('Not a valid png header')
    expect(() => decodeFlowPng(corrupt)).toThrow('unusable output')
  })

  it('throws unusable output on inflate-bomb PNG exceeding maxOutputLength', () => {
    // 10x10 RGBA image: expected uncompressed size is 10 * (1 + 10 * 4) = 410 bytes
    // Payload deflates to small buffer but decompresses to 100,000 bytes
    const bombPayload = zlib.deflateSync(Buffer.alloc(100_000))

    const width = 10
    const height = 10
    const ihdrData = Buffer.alloc(13)
    ihdrData.writeUInt32BE(width, 0)
    ihdrData.writeUInt32BE(height, 4)
    ihdrData[8] = 8 // bit depth
    ihdrData[9] = 6 // color type RGBA
    ihdrData[10] = 0 // compression
    ihdrData[11] = 0 // filter
    ihdrData[12] = 0 // interlace

    const ihdrChunk = Buffer.alloc(12 + 13)
    ihdrChunk.writeUInt32BE(13, 0)
    ihdrChunk.write('IHDR', 4, 4, 'ascii')
    ihdrData.copy(ihdrChunk, 8)
    ihdrChunk.writeUInt32BE(crc32(ihdrChunk.subarray(4, 21)), 21)

    const idatChunk = Buffer.alloc(12 + bombPayload.length)
    idatChunk.writeUInt32BE(bombPayload.length, 0)
    idatChunk.write('IDAT', 4, 4, 'ascii')
    bombPayload.copy(idatChunk, 8)
    idatChunk.writeUInt32BE(crc32(idatChunk.subarray(4, 8 + bombPayload.length)), 8 + bombPayload.length)

    const iendChunk = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ihdrChunk,
      idatChunk,
      iendChunk,
    ])

    expect(() => decodeFlowPng(png)).toThrow('unusable output')
  })

  it('downsamples 1024x1024 to 64x64 using median color of 16x16 cell', () => {
    const rawRgba = Buffer.alloc(1024 * 1024 * 4)
    // Fill cell (0, 0) with 200 red pixels, 56 green pixels
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const idx = (y * 1024 + x) * 4
        const i = y * 16 + x
        if (i < 200) {
          rawRgba[idx] = 255
          rawRgba[idx + 1] = 0
          rawRgba[idx + 2] = 0
          rawRgba[idx + 3] = 255
        } else {
          rawRgba[idx] = 0
          rawRgba[idx + 1] = 255
          rawRgba[idx + 2] = 0
          rawRgba[idx + 3] = 255
        }
      }
    }

    const downsampled = downsampleTo64x64(rawRgba)
    expect(downsampled.length).toBe(64 * 64 * 4)
    // Median of red should win
    expect(downsampled[0]).toBe(255)
    expect(downsampled[1]).toBe(0)
  })

  it('quantizes to <= 24 colors', () => {
    const pixels = Buffer.alloc(64 * 64 * 4)
    // Generate 100 different colors
    for (let i = 0; i < 64 * 64; i++) {
      const idx = i * 4
      pixels[idx] = (i * 7) % 256
      pixels[idx + 1] = (i * 13) % 256
      pixels[idx + 2] = (i * 29) % 256
      pixels[idx + 3] = 255
    }

    const quantized = quantizeColors(pixels, 24)

    const uniqueColors = new Set<string>()
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (!isInsideLayout(x, y)) continue
        const idx = (y * 64 + x) * 4
        uniqueColors.add(`${quantized[idx]},${quantized[idx + 1]},${quantized[idx + 2]},${quantized[idx + 3]}`)
      }
    }
    expect(uniqueColors.size).toBeLessThanOrEqual(24)
  })

  it('processFlowSkinImage sets transparent outside regions, 255 inside', () => {
    const rawRgba = Buffer.alloc(1024 * 1024 * 4)
    rawRgba.fill(200) // All pixels light grey with alpha 200

    const png = encodePng(rawRgba, 1024, 1024)
    const resultPng = processFlowSkinImage(png, 'all', null)
    const decoded = decodePng(resultPng)

    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)

    // Check pixel at (0, 0) -> outside layout -> alpha 0
    const outIdx = 0
    expect(decoded.data[outIdx + 3]).toBe(0)

    // Check pixel at head front (x=20, y=8) -> inside layout -> alpha 255
    const headIdx = (8 * 64 + 20) * 4
    expect(decoded.data[headIdx + 3]).toBe(255)
  })

  it('part-replace leaves other regions byte-identical', () => {
    // Create base 64x64 skin where head is blue and body is yellow
    const baseRgba = Buffer.alloc(64 * 64 * 4)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 4
        if (isCoordInPart(x, y, 'head')) {
          baseRgba[idx] = 0
          baseRgba[idx + 1] = 0
          baseRgba[idx + 2] = 255
          baseRgba[idx + 3] = 255
        } else if (isCoordInPart(x, y, 'body')) {
          baseRgba[idx] = 255
          baseRgba[idx + 1] = 255
          baseRgba[idx + 2] = 0
          baseRgba[idx + 3] = 255
        }
      }
    }

    // Now generate new skin where everything is green
    const flowRgba = Buffer.alloc(1024 * 1024 * 4)
    for (let i = 0; i < 1024 * 1024; i++) {
      const idx = i * 4
      flowRgba[idx] = 0
      flowRgba[idx + 1] = 255
      flowRgba[idx + 2] = 0
      flowRgba[idx + 3] = 255
    }
    const flowPng = encodePng(flowRgba, 1024, 1024)

    // Replace only 'head'
    const resultPng = processFlowSkinImage(flowPng, 'head', { width: 64, height: 64, data: baseRgba })
    const decoded = decodePng(resultPng)

    // Head should now be green
    const headIdx = (8 * 64 + 20) * 4
    expect(decoded.data[headIdx + 1]).toBe(255) // Green

    // Body MUST be byte-identical to base (yellow: 255, 255, 0, 255)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (isCoordInPart(x, y, 'body')) {
          const idx = (y * 64 + x) * 4
          expect(decoded.data[idx]).toBe(255)
          expect(decoded.data[idx + 1]).toBe(255)
          expect(decoded.data[idx + 2]).toBe(0)
          expect(decoded.data[idx + 3]).toBe(255)
        }
      }
    }
  })
})

describe('F2 & F3 Flow Pipeline with Stub Flow Service', () => {
  let stubServer: http.Server
  let stubFlowUrl: string
  let testOutputDir: string
  let lastReceivedRefPaths: string[] = []
  let nextFlowStatus = 202
  let nextJobStatus = 'done'
  let nextJobFile = ''

  let app: express.Express
  let apiServer: http.Server
  let apiBase: string

  beforeEach(async () => {
    testOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruang-flow-out-'))
    lastReceivedRefPaths = []
    nextFlowStatus = 202
    nextJobStatus = 'done'
    nextJobFile = ''

    stubServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/jobs') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            lastReceivedRefPaths = parsed.reference_paths || []
          } catch {
            // ignore malformed body
          }

          if (nextFlowStatus === 202) {
            res.writeHead(202, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ jobId: 'flow-job-42' }))
          } else if (nextFlowStatus === 429) {
            res.writeHead(429, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'daily cap' }))
          } else if (nextFlowStatus === 503) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'service unavailable' }))
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'internal error' }))
          }
        })
      } else if (req.method === 'GET' && req.url === '/jobs/flow-job-42') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: nextJobStatus, file: nextJobFile }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    stubServer.listen(0, '127.0.0.1')
    await new Promise((resolve) => stubServer.once('listening', resolve))
    stubFlowUrl = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`

    app = express()
    app.disable('x-powered-by')
    installSkinGenerate(app, {
      provider: 'flow',
      flowUrl: stubFlowUrl,
      flowOutputDir: testOutputDir,
      flowPollIntervalMs: 20, // fast polling for tests
      rateLimiter: new GenerateRateLimiter(),
    })

    apiServer = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => apiServer.once('listening', resolve))
    apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => apiServer.close(resolve))
    await new Promise((resolve) => stubServer.close(resolve))
    await fs.rm(testOutputDir, { recursive: true, force: true }).catch(() => {})
  })

  it('POST returns 503 { error: "flow offline" } when Flow service unreachable', async () => {
    const offlineApp = express()
    installSkinGenerate(offlineApp, {
      provider: 'flow',
      flowUrl: 'http://127.0.0.1:59999', // Non-existent port
      rateLimiter: new GenerateRateLimiter(),
    })
    const srv = offlineApp.listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'test' }),
    })

    expect(res.status).toBe(503)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('flow offline')
    srv.close()
  })

  it('POST returns 503 { error: "flow offline" } when Flow returns 503', async () => {
    nextFlowStatus = 503
    const res = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'test' }),
    })

    expect(res.status).toBe(503)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('flow offline')
  })

  it('POST returns 429 { error: "daily cap" } when Flow returns 429', async () => {
    nextFlowStatus = 429
    const res = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'test' }),
    })

    expect(res.status).toBe(429)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('daily cap')
  })

  it('cleans up temp directory (0700) after completion', async () => {
    // Generate valid 1024x1024 output file in testOutputDir
    const outPng = encodePng(Buffer.alloc(1024 * 1024 * 4, 120), 1024, 1024)
    const outFilePath = path.join(testOutputDir, 'output.png')
    await fs.writeFile(outFilePath, outPng)

    nextJobStatus = 'done'
    nextJobFile = outFilePath

    const postRes = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'knight skin' }),
    })
    expect(postRes.status).toBe(202)
    const { jobId } = (await postRes.json()) as { jobId: string }

    // Poll until done
    let getJson: { status: string; png?: string; error?: string } = { status: 'running' }
    for (let i = 0; i < 20; i++) {
      const getRes = await fetch(`${apiBase}/api/skins/generate/${jobId}`)
      getJson = (await getRes.json()) as typeof getJson
      if (getJson.status === 'done' || getJson.status === 'error') break
      await new Promise((r) => setTimeout(r, 30))
    }

    expect(getJson.status).toBe('done')
    expect(getJson.png).toBeDefined()

    // Verify temp dir was deleted
    expect(lastReceivedRefPaths.length).toBeGreaterThan(0)
    const tempDir = path.dirname(lastReceivedRefPaths[0])
    await expect(fs.access(tempDir)).rejects.toThrow()
  })

  it('processes 1000x1000 RGB PNG to 64x64 RGBA output', async () => {
    const outPng = createCustomPng(1000, 1000, 2, 8, 0, [50, 150, 250, 255])
    const outFilePath = path.join(testOutputDir, 'output-rgb.png')
    await fs.writeFile(outFilePath, outPng)

    nextJobStatus = 'done'
    nextJobFile = outFilePath

    const postRes = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'rgb test' }),
    })
    const { jobId } = (await postRes.json()) as { jobId: string }

    let getJson: { status: string; png?: string } = { status: 'running' }
    for (let i = 0; i < 20; i++) {
      const getRes = await fetch(`${apiBase}/api/skins/generate/${jobId}`)
      getJson = (await getRes.json()) as typeof getJson
      if (getJson.status === 'done' || getJson.status === 'error') break
      await new Promise((r) => setTimeout(r, 30))
    }

    expect(getJson.status).toBe('done')
    const decoded = decodePng(Buffer.from(getJson.png!, 'base64'))
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)
  })

  it('handles non-square PNG by resizing to 64x64', async () => {
    const outPng = createCustomPng(800, 600, 6, 8, 0, [100, 100, 100, 255])
    const outFilePath = path.join(testOutputDir, 'output-rect.png')
    await fs.writeFile(outFilePath, outPng)

    nextJobStatus = 'done'
    nextJobFile = outFilePath

    const postRes = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'rect test' }),
    })
    const { jobId } = (await postRes.json()) as { jobId: string }

    let getJson: { status: string; png?: string } = { status: 'running' }
    for (let i = 0; i < 20; i++) {
      const getRes = await fetch(`${apiBase}/api/skins/generate/${jobId}`)
      getJson = (await getRes.json()) as typeof getJson
      if (getJson.status === 'done' || getJson.status === 'error') break
      await new Promise((r) => setTimeout(r, 30))
    }

    expect(getJson.status).toBe('done')
    const decoded = decodePng(Buffer.from(getJson.png!, 'base64'))
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)
  })

  it('fails with error "unusable output" if file is outside RUANG_FLOW_OUTPUT_DIR', async () => {
    // Put output file in os.tmpdir() directly, not inside testOutputDir
    const outsidePath = path.join(os.tmpdir(), `outside-${Date.now()}.png`)
    await fs.writeFile(outsidePath, Buffer.from('png data'))

    nextJobStatus = 'done'
    nextJobFile = outsidePath

    const postRes = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'traversal test' }),
    })
    const { jobId } = (await postRes.json()) as { jobId: string }

    let getJson: { status: string; error?: string } = { status: 'running' }
    for (let i = 0; i < 20; i++) {
      const getRes = await fetch(`${apiBase}/api/skins/generate/${jobId}`)
      getJson = (await getRes.json()) as typeof getJson
      if (getJson.status === 'done' || getJson.status === 'error') break
      await new Promise((r) => setTimeout(r, 30))
    }

    expect(getJson.status).toBe('error')
    expect(getJson.error).toBe('unusable output')

    await fs.unlink(outsidePath).catch(() => {})
  })

  it('fails with error "unusable output" if output file is corrupt', async () => {
    const corruptPath = path.join(testOutputDir, 'corrupt.png')
    await fs.writeFile(corruptPath, Buffer.from('garbage data'))

    nextJobStatus = 'done'
    nextJobFile = corruptPath

    const postRes = await fetch(`${apiBase}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: apiBase },
      body: JSON.stringify({ prompt: 'corrupt test' }),
    })
    const { jobId } = (await postRes.json()) as { jobId: string }

    let getJson: { status: string; error?: string } = { status: 'running' }
    for (let i = 0; i < 20; i++) {
      const getRes = await fetch(`${apiBase}/api/skins/generate/${jobId}`)
      getJson = (await getRes.json()) as typeof getJson
      if (getJson.status === 'done' || getJson.status === 'error') break
      await new Promise((r) => setTimeout(r, 30))
    }

    expect(getJson.status).toBe('error')
    expect(getJson.error).toBe('unusable output')
  })
})

describe('F2 Concurrency, Limits, and Memory Management', () => {
  it('returns 409 { error: "busy" } if another job is already active server-wide', async () => {
    const jobManager = new SkinJobManager()
    const j1 = jobManager.createJob('flow', 'prompt 1', 'all')
    expect(j1.status).toBe('queued')

    // Second job creation throws 409
    expect(() => jobManager.createJob('flow', 'prompt 2', 'all')).toThrow('busy')
  })

  it('marks job status as timeout error after 5 minutes', () => {
    const jobManager = new SkinJobManager()
    const job = jobManager.createJob('flow', 'prompt', 'all')
    // Fast-forward createdAt to 6 minutes ago
    job.createdAt = Date.now() - 6 * 60 * 1000

    const retrieved = jobManager.getJob(job.id)
    expect(retrieved?.status).toBe('error')
    expect(retrieved?.error).toBe('timeout')
  })

  it('purges jobs after 10 minutes (returns undefined / 404)', () => {
    const jobManager = new SkinJobManager()
    const job = jobManager.createJob('flow', 'prompt', 'all')
    job.status = 'done'
    // Fast-forward createdAt to 11 minutes ago
    job.createdAt = Date.now() - 11 * 60 * 1000

    const retrieved = jobManager.getJob(job.id)
    expect(retrieved).toBeUndefined()
  })

  it('evicts oldest entries when map reaches 50 entries', () => {
    const jobManager = new SkinJobManager()
    const firstJob = jobManager.createJob('flow', 'prompt 0', 'all')
    firstJob.status = 'done' // Mark done so it is not active

    for (let i = 1; i < 50; i++) {
      const job = jobManager.createJob('flow', `prompt ${i}`, 'all')
      job.status = 'done'
    }

    // Now adding 51st job should evict firstJob
    const job51 = jobManager.createJob('flow', 'prompt 50', 'all')
    expect(jobManager.getJob(firstJob.id)).toBeUndefined()
    expect(jobManager.getJob(job51.id)).toBeDefined()
  })
})
