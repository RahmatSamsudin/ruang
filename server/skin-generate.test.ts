import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  composeSkinFromJson,
  decodePng,
  encodePng,
  parsePalette,
  repairFaceRows,
} from './skin-compose.js'
import {
  GenerateRateLimiter,
  installSkinGenerate,
} from './skin-generate.js'

describe('skin-compose unit tests', () => {
  it('encodes and decodes 64x64 RGBA PNG round-trip', () => {
    const rawRgba = Buffer.alloc(64 * 64 * 4)
    // Paint pixel (10, 20) with [255, 100, 50, 200]
    const idx = (20 * 64 + 10) * 4
    rawRgba[idx] = 255
    rawRgba[idx + 1] = 100
    rawRgba[idx + 2] = 50
    rawRgba[idx + 3] = 200

    const png = encodePng(rawRgba, 64, 64)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

    const decoded = decodePng(png)
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)
    expect(decoded.data.length).toBe(64 * 64 * 4)
    expect(decoded.data[idx]).toBe(255)
    expect(decoded.data[idx + 1]).toBe(100)
    expect(decoded.data[idx + 2]).toBe(50)
    expect(decoded.data[idx + 3]).toBe(200)
  })

  it('rejects non-64x64 PNG in decodePng', () => {
    const raw32 = Buffer.alloc(32 * 32 * 4)
    const png32 = encodePng(raw32, 32, 32)
    expect(() => decodePng(png32)).toThrow(/must be 64x64 pixels/)
  })

  it('rejects corrupted PNG data', () => {
    expect(() => decodePng(Buffer.alloc(10))).toThrow(/invalid signature/)
    const garbage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(() => decodePng(garbage)).toThrow(/Invalid PNG/)
  })

  it('parses valid palettes and rejects invalid ones', () => {
    const valid = ['#ffffff', '#000000', '#ff00aa']
    const map = parsePalette(valid)
    expect(map.get('0')).toEqual([255, 255, 255, 255])
    expect(map.get('1')).toEqual([0, 0, 0, 255])
    expect(map.get('2')).toEqual([255, 0, 170, 255])
    expect(map.get('.')).toEqual([0, 0, 0, 0]) // transparent

    // Too many colors (>16)
    const tooMany = Array.from({ length: 17 }, () => '#112233')
    expect(() => parsePalette(tooMany)).toThrow(/1 to 16/)

    // Invalid hex
    expect(() => parsePalette(['#xyz123'])).toThrow(/Invalid palette hex/)
    expect(() => parsePalette([])).toThrow(/1 to 16/)
    expect(() => parsePalette(null)).toThrow(/must be an array/)
  })

  it('repairs minor width and height errors in face rows', () => {
    // Exact
    const exact = repairFaceRows(['01234567', '01234567'], 8, 2)
    expect(exact).toEqual(['01234567', '01234567'])

    // Minor width error: 7 chars -> padded to 8
    const shortW = repairFaceRows(['0123456'], 8, 1)
    expect(shortW[0]).toBe('01234566')

    // Minor width error: 9 chars -> cropped to 8
    const longW = repairFaceRows(['012345678'], 8, 1)
    expect(longW[0]).toBe('01234567')

    // Major width error: 5 chars (diff = 3 > 2) -> throw 502
    expect(() => repairFaceRows(['01234'], 8, 1)).toThrow(/Unusable width/)

    // Minor height error: 7 rows -> padded to 8
    const shortH = repairFaceRows(Array.from({ length: 7 }, () => '00000000'), 8, 8)
    expect(shortH.length).toBe(8)

    // Minor height error: 9 rows -> truncated to 8
    const longH = repairFaceRows(Array.from({ length: 9 }, () => '00000000'), 8, 8)
    expect(longH.length).toBe(8)

    // Major height error: 5 rows -> throw 502
    expect(() => repairFaceRows(Array.from({ length: 5 }, () => '00000000'), 8, 8)).toThrow(/Unusable height/)
  })

  it('composes full skin from valid LLM JSON', () => {
    const json = {
      palette: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'],
      parts: {
        head: {
          front: Array.from({ length: 8 }, () => '00000000'),
          back: Array.from({ length: 8 }, () => '11111111'),
          top: Array.from({ length: 8 }, () => '22222222'),
          bottom: Array.from({ length: 8 }, () => '33333333'),
          left: Array.from({ length: 8 }, () => '01010101'),
          right: Array.from({ length: 8 }, () => '10101010'),
        },
        body: {
          front: Array.from({ length: 12 }, () => '11111111'),
          back: Array.from({ length: 12 }, () => '22222222'),
        },
        arm: Array.from({ length: 12 }, () => '0000'),
        leg: Array.from({ length: 12 }, () => '3333'),
      },
    }

    const png = composeSkinFromJson(json, 'all')
    const decoded = decodePng(png)
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)

    // Check head front pixel at (8, 8) has palette 0 (#ff0000)
    const headFrontIdx = (8 * 64 + 8) * 4
    expect(decoded.data[headFrontIdx]).toBe(255)
    expect(decoded.data[headFrontIdx + 1]).toBe(0)
    expect(decoded.data[headFrontIdx + 2]).toBe(0)

    // Check body front pixel at (20, 20) has palette 1 (#00ff00)
    const bodyFrontIdx = (20 * 64 + 20) * 4
    expect(decoded.data[bodyFrontIdx]).toBe(0)
    expect(decoded.data[bodyFrontIdx + 1]).toBe(255)
    expect(decoded.data[bodyFrontIdx + 2]).toBe(0)
  })

  it('part-only replace with base leaves other regions byte-identical', () => {
    // Create base image where all pixels are [120, 140, 160, 255]
    const baseRgba = Buffer.alloc(64 * 64 * 4)
    for (let i = 0; i < baseRgba.length; i += 4) {
      baseRgba[i] = 120
      baseRgba[i + 1] = 140
      baseRgba[i + 2] = 160
      baseRgba[i + 3] = 255
    }
    const baseDecoded = { width: 64, height: 64, data: baseRgba }

    // JSON specifying only head
    const jsonHead = {
      palette: ['#ff0000'],
      parts: {
        head: {
          front: Array.from({ length: 8 }, () => '00000000'),
        },
      },
    }

    const modifiedPng = composeSkinFromJson(jsonHead, 'head', baseDecoded)
    const modifiedDecoded = decodePng(modifiedPng)

    // Non-head regions (rows 16..63) MUST be completely byte-identical
    const bodyStart = 16 * 64 * 4
    const bodyEnd = 64 * 64 * 4
    expect(modifiedDecoded.data.subarray(bodyStart, bodyEnd)).toEqual(baseRgba.subarray(bodyStart, bodyEnd))

    // Head region (rows 0..15) front face must have changed
    const headFrontPixel = (8 * 64 + 8) * 4
    expect(modifiedDecoded.data[headFrontPixel]).toBe(255) // #ff0000
    expect(modifiedDecoded.data[headFrontPixel + 1]).toBe(0)
    expect(modifiedDecoded.data[headFrontPixel + 2]).toBe(0)
  })
})

describe('skin-generate API and LLM handling', () => {
  let app: express.Express
  let server: http.Server
  let base: string
  let rateLimiter: GenerateRateLimiter
  let stubLlmResponses: Array<{ status?: number; body?: unknown; delay?: number }>
  let stubFetchCalls: Array<{ url: string; headers: Record<string, string>; body: string }>

  beforeEach(async () => {
    rateLimiter = new GenerateRateLimiter(60_000, 6)
    stubLlmResponses = []
    stubFetchCalls = []

    const mockFetch = async (input: unknown, init?: { headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<Response> => {
      stubFetchCalls.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: String(init?.body ?? ''),
      })

      const next = stubLlmResponses.shift()
      if (!next) {
        throw new Error('No more stub LLM responses.')
      }

      if (next.delay) {
        await new Promise((res, rej) => {
          const timer = setTimeout(res, next.delay)
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              clearTimeout(timer)
              const abortErr = new Error('The operation was aborted.')
              abortErr.name = 'TimeoutError'
              rej(abortErr)
            })
          }
        })
      }

      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    app = express()
    app.disable('x-powered-by')

    installSkinGenerate(app, {
      rateLimiter,
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 200, // Short timeout for tests
      apiKey: 'test-secret-key-12345',
    })

    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  const sampleValidLlmJson = {
    palette: ['#ff0000', '#00ff00'],
    parts: {
      head: { front: Array.from({ length: 8 }, () => '00000000') },
      body: { front: Array.from({ length: 12 }, () => '11111111') },
      arm: Array.from({ length: 12 }, () => '0000'),
      leg: Array.from({ length: 12 }, () => '1111'),
    },
    notes: 'A cool red and green warrior',
  }

  it('generates 64x64 PNG from prompt with 200 status', async () => {
    stubLlmResponses.push({
      status: 200,
      body: {
        choices: [{ message: { content: JSON.stringify(sampleValidLlmJson) } }],
      },
    })

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ prompt: 'cyberpunk warrior' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { png: string; notes?: string }
    expect(json.notes).toBe('A cool red and green warrior')
    expect(typeof json.png).toBe('string')

    const pngBuf = Buffer.from(json.png, 'base64')
    const decoded = decodePng(pngBuf)
    expect(decoded.width).toBe(64)
    expect(decoded.height).toBe(64)

    // Verify LLM prompt was passed
    expect(stubFetchCalls.length).toBe(1)
    expect(stubFetchCalls[0].body).toContain('cyberpunk warrior')
    // Verify auth header included API key
    expect((stubFetchCalls[0].headers as Record<string, string>)['Authorization']).toBe('Bearer test-secret-key-12345')
  })

  it('strips markdown code fences from LLM response', async () => {
    stubLlmResponses.push({
      status: 200,
      body: {
        choices: [
          {
            message: {
              content: `\`\`\`json\n${JSON.stringify(sampleValidLlmJson)}\n\`\`\``,
            },
          },
        ],
      },
    })

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ prompt: 'fenced json test' }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { png: string }
    const decoded = decodePng(Buffer.from(json.png, 'base64'))
    expect(decoded.width).toBe(64)
  })

  it('retries once on malformed JSON and succeeds if 2nd attempt valid', async () => {
    // Attempt 1: malformed JSON
    stubLlmResponses.push({
      status: 200,
      body: { choices: [{ message: { content: 'not valid json at all' } }] },
    })
    // Attempt 2: valid JSON
    stubLlmResponses.push({
      status: 200,
      body: { choices: [{ message: { content: JSON.stringify(sampleValidLlmJson) } }] },
    })

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ prompt: 'retry test' }),
    })

    expect(res.status).toBe(200)
    expect(stubFetchCalls.length).toBe(2)
  })

  it('fails with 502 if LLM JSON unusable after 1 retry', async () => {
    // Attempt 1: malformed
    stubLlmResponses.push({
      status: 200,
      body: { choices: [{ message: { content: '{ "palette": ' } }] },
    })
    // Attempt 2: still malformed
    stubLlmResponses.push({
      status: 200,
      body: { choices: [{ message: { content: 'broken' } }] },
    })

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({ prompt: 'retry fail test' }),
    })

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBeDefined()
    expect(stubFetchCalls.length).toBe(2)
  })

  it('fails with 502 on unusable dimensions or bad palette after retry', async () => {
    const badDimsJson = {
      palette: ['#ff0000'],
      parts: {
        head: { front: ['00'] }, // Way too short (expected 8, got 2 -> unusable)
      },
    }

    stubLlmResponses.push(
      { status: 200, body: { choices: [{ message: { content: JSON.stringify(badDimsJson) } }] } },
      { status: 200, body: { choices: [{ message: { content: JSON.stringify(badDimsJson) } }] } },
    )

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'bad dimensions' }),
    })

    expect(res.status).toBe(502)
  })

  it('fails with 504 on timeout without retrying', async () => {
    // Delay exceeds test timeout of 200ms
    stubLlmResponses.push({
      delay: 500,
      body: { choices: [{ message: { content: JSON.stringify(sampleValidLlmJson) } }] },
    })

    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'slow prompt' }),
    })

    expect(res.status).toBe(504)
    const data = (await res.json()) as { error: string }
    expect(data.error).toMatch(/timeout/i)
    // Timeouts do not trigger retry
    expect(stubFetchCalls.length).toBe(1)
  })

  it('rate limits 7th call within a minute with 429', async () => {
    for (let i = 0; i < 6; i++) {
      stubLlmResponses.push({
        status: 200,
        body: { choices: [{ message: { content: JSON.stringify(sampleValidLlmJson) } }] },
      })
      const res = await fetch(`${base}/api/skins/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ prompt: `call ${i}` }),
      })
      expect(res.status).toBe(200)
    }

    // 7th call triggers 429
    const res7 = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'call 7' }),
    })

    expect(res7.status).toBe(429)
    const data = (await res7.json()) as { error: string }
    expect(data.error).toMatch(/Rate limit exceeded/)
  })

  it('validates input prompt: empty or > 300 chars returns 400', async () => {
    // Empty prompt
    const resEmpty = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: '   ' }),
    })
    expect(resEmpty.status).toBe(400)

    // >300 chars prompt
    const resLong = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'a'.repeat(301) }),
    })
    expect(resLong.status).toBe(400)
  })

  it('validates part and base image input', async () => {
    // Invalid part
    const resPart = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'valid', part: 'wings' }),
    })
    expect(resPart.status).toBe(400)

    // Invalid base (corrupt base64/not PNG)
    const resBase = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: 'valid', base: 'not-a-png' }),
    })
    expect(resBase.status).toBe(400)
  })

  it('rejects missing or mismatched Origin header with 403', async () => {
    // No Origin
    const resNoOrigin = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'valid' }),
    })
    expect(resNoOrigin.status).toBe(403)

    // Evil Origin
    const resEvil = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.com' },
      body: JSON.stringify({ prompt: 'valid' }),
    })
    expect(resEvil.status).toBe(403)
  })

  it('rejects oversized JSON payload (>64 KiB) with 413', async () => {
    const hugePrompt = 'x'.repeat(70 * 1024)
    const res = await fetch(`${base}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ prompt: hugePrompt }),
    })
    expect(res.status).toBe(413)
  })

  it('never leaks API key in errors', async () => {
    // Simulate network error containing secret key
    const mockErrorFetch = async (): Promise<Response> => {
      throw new Error('Connection failed with token test-secret-key-12345 to endpoint')
    }

    const appLeak = express()
    installSkinGenerate(appLeak, {
      rateLimiter: new GenerateRateLimiter(),
      fetchFn: mockErrorFetch as unknown as typeof fetch,
      apiKey: 'test-secret-key-12345',
    })

    const serverLeak = appLeak.listen(0, '127.0.0.1')
    await new Promise((resolve) => serverLeak.once('listening', resolve))
    const baseLeak = `http://127.0.0.1:${(serverLeak.address() as AddressInfo).port}`

    const res = await fetch(`${baseLeak}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseLeak },
      body: JSON.stringify({ prompt: 'test' }),
    })

    const text = await res.text()
    expect(text).not.toContain('test-secret-key-12345')
    expect(text).toContain('[REDACTED]')

    serverLeak.close()
  })

  it('rejects locked agent with 423', async () => {
    const appLock = express()
    const privacyOf = async () => ({
      hidden: new Set(['locked-agent']),
      locked: new Set(['locked-agent']),
      all: false,
    })

    installSkinGenerate(appLock, {
      privacyOf,
      rateLimiter: new GenerateRateLimiter(),
    })

    const serverLock = appLock.listen(0, '127.0.0.1')
    await new Promise((resolve) => serverLock.once('listening', resolve))
    const baseLock = `http://127.0.0.1:${(serverLock.address() as AddressInfo).port}`

    const res = await fetch(`${baseLock}/api/skins/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseLock },
      body: JSON.stringify({ prompt: 'steve', agent: 'locked-agent' }),
    })

    expect(res.status).toBe(423)
    const json = (await res.json()) as { locked: string; agent: string }
    expect(json.locked).toBe('profile')
    expect(json.agent).toBe('locked-agent')

    serverLock.close()
  })
})
