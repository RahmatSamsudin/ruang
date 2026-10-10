import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccessStore, installAccess } from './access.js'
import { installProfileLock, ProfileLockStore } from './profile-lock.js'
import { SkinLibraryStore } from './skin-library.js'
import { installSkins, isValidSkinId, matchOriginHost, SkinStore, validatePng } from './skins.js'

// CRC32 table for generating valid test PNGs
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  crcTable[n] = c
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  const toCrc = Buffer.concat([typeBuf, data])
  crcBuf.writeUInt32BE(crc32(toCrc), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function makePng(width = 64, height = 64, colorType = 6, bitDepth = 8): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData.writeUInt8(bitDepth, 8)
  ihdrData.writeUInt8(colorType, 9)
  ihdrData.writeUInt8(0, 10)
  ihdrData.writeUInt8(0, 11)
  ihdrData.writeUInt8(0, 12)
  const ihdrChunk = makeChunk('IHDR', ihdrData)

  const bytesPerPixel = colorType === 6 ? 4 : (colorType === 2 ? 3 : 1)
  const rowSize = 1 + width * bytesPerPixel
  const rawData = Buffer.alloc(height * rowSize, 0)
  for (let y = 0; y < height; y++) {
    rawData[y * rowSize] = 0 // filter type 0
    for (let x = 0; x < width; x++) {
      const offset = y * rowSize + 1 + x * bytesPerPixel
      if (colorType === 6) {
        rawData[offset] = 120
        rawData[offset + 1] = 180
        rawData[offset + 2] = 240
        rawData[offset + 3] = 255
      }
    }
  }

  const idatChunk = makeChunk('IDAT', deflateSync(rawData))
  const iendChunk = makeChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

describe('skins unit tests', () => {
  it('validates skin IDs correctly', () => {
    expect(isValidSkinId('coder')).toBe(true)
    expect(isValidSkinId('agent.1')).toBe(true)
    expect(isValidSkinId('agent_2-3')).toBe(true)
    expect(isValidSkinId('a'.repeat(64))).toBe(true)

    expect(isValidSkinId('')).toBe(false)
    expect(isValidSkinId('a'.repeat(65))).toBe(false)
    expect(isValidSkinId('.')).toBe(false)
    expect(isValidSkinId('..')).toBe(false)
    expect(isValidSkinId('../x')).toBe(false)
    expect(isValidSkinId('a/b')).toBe(false)
    expect(isValidSkinId('%2e%2e')).toBe(false)
    expect(isValidSkinId(null)).toBe(false)
    expect(isValidSkinId(undefined)).toBe(false)
  })

  it('validates origin host matching', () => {
    expect(matchOriginHost('http://127.0.0.1:3001', '127.0.0.1:3001')).toBe(true)
    expect(matchOriginHost('http://example.com:80', 'example.com')).toBe(true)
    expect(matchOriginHost('https://example.com:443', 'example.com')).toBe(true)
    expect(matchOriginHost('http://evil.com:3001', '127.0.0.1:3001')).toBe(false)
    expect(matchOriginHost(undefined, '127.0.0.1:3001')).toBe(false)
    expect(matchOriginHost('http://127.0.0.1:3001', undefined)).toBe(false)
    expect(matchOriginHost('not-a-url', '127.0.0.1:3001')).toBe(false)
  })

  it('validates 64x64 RGBA PNGs and rejects invalid formats', () => {
    expect(() => validatePng(makePng(64, 64, 6, 8))).not.toThrow()
    expect(() => validatePng(makePng(32, 32, 6, 8))).toThrow(/64x64/)
    expect(() => validatePng(makePng(64, 32, 6, 8))).toThrow(/64x64/)
    expect(() => validatePng(makePng(64, 64, 2, 8))).toThrow(/RGBA/)
    expect(() => validatePng(makePng(64, 64, 0, 8))).toThrow(/RGBA/)
    expect(() => validatePng(Buffer.alloc(20))).toThrow(/too short/)
    expect(() => validatePng(Buffer.alloc(40))).toThrow(/invalid signature/)
  })
})

describe('skins api routes', () => {
  let tmp: string
  let store: SkinStore
  let base: string
  let close: () => void
  let lockStore: ProfileLockStore
  let accessStore: AccessStore

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ruang-skins-test-'))
    const skinsPath = join(tmp, 'skins')
    store = new SkinStore(skinsPath)
    lockStore = new ProfileLockStore(join(tmp, 'lock'))
    accessStore = new AccessStore(join(tmp, 'access'))

    const app = express()
    app.disable('x-powered-by')
    installAccess(app, accessStore)
    const privacyOf = installProfileLock(app, lockStore)
    installSkins(app, privacyOf, store)

    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })

  afterEach(async () => {
    close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('roundtrip: list, PUT, get png identical bytes, list again, idempotent delete', async () => {
    // Initial list is empty
    const list0 = (await (await fetch(`${base}/api/skins`)).json()) as { skins: Record<string, unknown> }
    expect(list0).toEqual({ skins: {} })

    const validPng = makePng(64, 64, 6, 8)
    const putRes = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: {
        'content-type': 'image/png',
        origin: base,
      },
      body: validPng,
    })
    expect(putRes.status).toBe(200)
    const putData = (await putRes.json()) as { id: string; version: string; updatedAt: string }
    expect(putData).toMatchObject({
      id: 'coder',
      version: expect.stringMatching(/^[0-9a-f]{12}$/),
      updatedAt: expect.any(String),
    })

    // List shows the version and updatedAt
    const list1 = (await (await fetch(`${base}/api/skins`)).json()) as { skins: Record<string, { version: string; updatedAt: string }> }
    expect(list1.skins.coder).toEqual({
      version: putData.version,
      updatedAt: putData.updatedAt,
    })

    // GET /api/skins/coder.png returns identical bytes and no-store
    const getRes = await fetch(`${base}/api/skins/coder.png`)
    expect(getRes.status).toBe(200)
    expect(getRes.headers.get('content-type')).toBe('image/png')
    expect(getRes.headers.get('cache-control')).toBe('no-store')
    const gotBytes = Buffer.from(await getRes.arrayBuffer())
    expect(gotBytes.equals(validPng)).toBe(true)

    // Directory mode 0700, file mode 0600
    const dirStat = await stat(store.dir)
    expect(dirStat.mode & 0o777).toBe(0o700)
    const fileStat = await stat(store.filePath('coder'))
    expect(fileStat.mode & 0o777).toBe(0o600)

    // DELETE is idempotent
    const delRes1 = await fetch(`${base}/api/skins/coder`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(delRes1.status).toBe(200)
    expect(await delRes1.json()).toEqual({ ok: true })

    const delRes2 = await fetch(`${base}/api/skins/coder`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(delRes2.status).toBe(200)
    expect(await delRes2.json()).toEqual({ ok: true })

    // GET /api/skins/coder.png returns 404 after deletion
    const getRes404 = await fetch(`${base}/api/skins/coder.png`)
    expect(getRes404.status).toBe(404)
    expect(await getRes404.json()).toEqual({ error: 'Skin not found.' })

    const list2 = (await (await fetch(`${base}/api/skins`)).json()) as { skins: Record<string, unknown> }
    expect(list2).toEqual({ skins: {} })
  })

  it('does not duplicate library entries when identical pixels arrive with different PNG encodings', async () => {
    const plain = makePng(64, 64, 6, 8)
    // Same pixels as makePng, but Sub-filtered like a browser canvas would encode them.
    const sub = Buffer.alloc(64 * (1 + 256), 0)
    for (let y = 0; y < 64; y++) {
      sub[y * 257] = 1
      sub.set([120, 180, 240, 255], y * 257 + 1)
    }
    const reencoded = Buffer.concat([
      plain.subarray(0, 33),
      makeChunk('IDAT', deflateSync(sub)),
      makeChunk('IEND', Buffer.alloc(0)),
    ])
    expect(reencoded.equals(plain)).toBe(false)

    const put = (agent: string, body: Buffer) =>
      fetch(`${base}/api/skins/${agent}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', origin: base },
        body,
      })
    const first = (await (await put('coder', plain)).json()) as { version: string }
    const second = (await (await put('writer', reencoded)).json()) as { version: string }

    expect(second.version).toBe(first.version)
    const items = await new SkinLibraryStore(join(store.dir, 'library')).list()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(first.version)
  })

  it('rejects PUT/DELETE without matching Origin with 403', async () => {
    const validPng = makePng(64, 64, 6, 8)

    // No Origin header -> 403
    const putNoOrigin = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: validPng,
    })
    expect(putNoOrigin.status).toBe(403)

    // Mismatched Origin header -> 403
    const putEvil = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin: 'http://evil.com' },
      body: validPng,
    })
    expect(putEvil.status).toBe(403)

    // DELETE without Origin -> 403
    const delNoOrigin = await fetch(`${base}/api/skins/coder`, { method: 'DELETE' })
    expect(delNoOrigin.status).toBe(403)

    // DELETE with mismatched Origin -> 403
    const delEvil = await fetch(`${base}/api/skins/coder`, {
      method: 'DELETE',
      headers: { origin: 'http://evil.com' },
    })
    expect(delEvil.status).toBe(403)
  })

  it('rejects non image/png content-type with 415', async () => {
    const validPng = makePng(64, 64, 6, 8)
    const res = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', origin: base },
      body: validPng,
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'Content-Type must be image/png.' })
  })

  it('rejects payload > 16 KiB with 413 without unbounded buffering', async () => {
    const largeBody = Buffer.alloc(17 * 1024, 0)
    const res = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin: base },
      body: largeBody,
    })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'Payload too large.' })
  })

  it('rejects invalid or wrong-size PNG with 400', async () => {
    const wrongSizePng = makePng(32, 32, 6, 8)
    const res = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin: base },
      body: wrongSizePng,
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toMatch(/64x64/)
  })

  function rawRequest(
    path: string,
    options: { method: string; headers?: Record<string, string>; body?: Buffer },
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(base)
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path,
          method: options.method,
          headers: options.headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      req.on('error', reject)
      if (options.body) req.write(options.body)
      req.end()
    })
  }

  it('rejects bad and traversal IDs with 400 and touches no files outside skins dir', async () => {
    const validPng = makePng(64, 64, 6, 8)
    const badIds = ['bad@id', 'bad$id', 'bad!id', 'a'.repeat(65)]

    for (const badId of badIds) {
      const putRes = await fetch(`${base}/api/skins/${encodeURIComponent(badId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', origin: base },
        body: validPng,
      })
      expect(putRes.status).toBe(400)

      const getRes = await fetch(`${base}/api/skins/${encodeURIComponent(badId)}.png`)
      expect(getRes.status).toBe(400)

      const delRes = await fetch(`${base}/api/skins/${encodeURIComponent(badId)}`, {
        method: 'DELETE',
        headers: { origin: base },
      })
      expect(delRes.status).toBe(400)
    }

    const traversalPaths = [
      '/api/skins/..%2fx',
      '/api/skins/%2e%2e',
      '/api/skins/a/b',
      '/api/skins/',
    ]

    for (const tPath of traversalPaths) {
      const putRaw = await rawRequest(tPath, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', origin: base, host: new URL(base).host },
        body: validPng,
      })
      expect(putRaw.status).toBe(400)

      const delRaw = await rawRequest(tPath, {
        method: 'DELETE',
        headers: { origin: base, host: new URL(base).host },
      })
      expect(delRaw.status).toBe(400)
    }

    // Check parent tmp dir has no new files created outside skins directory
    const entries = await readdir(tmp)
    for (const entry of entries) {
      expect(['access', 'lock', 'skins']).toContain(entry)
    }
  })

  it('integrates with profile lock: locked agent hidden from list and routes return 423', async () => {
    const pin = '123456'
    // Lock agent 'coder'
    await lockStore.setPin(pin, ['coder'])

    const validPng = makePng(64, 64, 6, 8)

    // PUT locked agent returns 423
    const putRes = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin: base },
      body: validPng,
    })
    expect(putRes.status).toBe(423)
    expect(await putRes.json()).toMatchObject({ locked: 'profile', agent: 'coder' })

    // GET locked agent returns 423
    const getRes = await fetch(`${base}/api/skins/coder.png`)
    expect(getRes.status).toBe(423)
    expect(await getRes.json()).toMatchObject({ locked: 'profile', agent: 'coder' })

    // DELETE locked agent returns 423
    const delRes = await fetch(`${base}/api/skins/coder`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(delRes.status).toBe(423)

    // Save a skin for an unlocked agent
    const putOther = await fetch(`${base}/api/skins/writer`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin: base },
      body: validPng,
    })
    expect(putOther.status).toBe(200)

    // List skins: writer is visible, coder is not visible
    const listRes = await fetch(`${base}/api/skins`)
    const list = (await listRes.json()) as { skins: Record<string, unknown> }
    expect(list.skins.writer).toBeDefined()
    expect(list.skins.coder).toBeUndefined()
  })

  it('integrates with access gate: rejects unauthenticated requests with 401 when code is set', async () => {
    await accessStore.set('ruang-7KQ4-M2XD-9PWT-H6RA')

    const resList = await fetch(`${base}/api/skins`)
    expect(resList.status).toBe(401)
    expect(await resList.json()).toMatchObject({ locked: true })

    const resGet = await fetch(`${base}/api/skins/coder.png`)
    expect(resGet.status).toBe(401)

    const resPut = await fetch(`${base}/api/skins/coder`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', origin: base },
      body: makePng(64, 64, 6, 8),
    })
    expect(resPut.status).toBe(401)

    const resDelete = await fetch(`${base}/api/skins/coder`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(resDelete.status).toBe(401)
  })
})
