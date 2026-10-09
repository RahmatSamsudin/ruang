import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import {
  SkinLibraryStore,
  computeLibId,
  installSkinLibrary,
} from './skin-library.js'
import {
  installSkins,
  SkinStore,
} from './skins.js'
import {
  installSkinGenerate,
  GenerateRateLimiter,
  archiveGeneratedJob,
  type SkinJob,
} from './skin-generate.js'
import { installProfileLock, ProfileLockStore } from './profile-lock.js'
import { installAccess, AccessStore } from './access.js'

// Helper to create valid 64x64 RGBA PNGs
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

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  const toCrc = Buffer.concat([typeBuf, data])
  crcBuf.writeUInt32BE(crc32(toCrc), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function makePng(
  width = 64,
  height = 64,
  colorType = 6,
  bitDepth = 8,
  r = 120,
  g = 180,
  b = 240,
  a = 255,
): Buffer {
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

  const bytesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const rowSize = 1 + width * bytesPerPixel
  const rawData = Buffer.alloc(height * rowSize, 0)

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize
    rawData[rowOffset] = 0 // None filter
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * bytesPerPixel
      if (colorType === 6) {
        rawData[pxOffset] = (r + x) % 256
        rawData[pxOffset + 1] = (g + y) % 256
        rawData[pxOffset + 2] = b % 256
        rawData[pxOffset + 3] = a % 256
      } else if (colorType === 2) {
        rawData[pxOffset] = r
        rawData[pxOffset + 1] = g
        rawData[pxOffset + 2] = b
      } else {
        rawData[pxOffset] = r
      }
    }
  }

  const idatChunk = makeChunk('IDAT', zlib.deflateSync(rawData))
  const iendChunk = makeChunk('IEND', Buffer.alloc(0))

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

describe('SkinLibrary', () => {
  let tmp: string
  let libDir: string
  let skinsPath: string
  let store: SkinLibraryStore
  let skinsStore: SkinStore
  let lockStore: ProfileLockStore
  let accessStore: AccessStore
  let app: express.Express
  let server: http.Server
  let base: string
  let closeServer: () => Promise<void>

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ruang-skin-lib-test-'))
    skinsPath = path.join(tmp, 'skins')
    libDir = path.join(skinsPath, 'library')
    await fs.mkdir(skinsPath, { recursive: true })

    store = new SkinLibraryStore(libDir, skinsPath)
    skinsStore = new SkinStore(skinsPath)
    lockStore = new ProfileLockStore(path.join(tmp, 'lock'))
    accessStore = new AccessStore(path.join(tmp, 'access'))

    app = express()
    app.disable('x-powered-by')
    installAccess(app, accessStore)
    const privacyOf = installProfileLock(app, lockStore)
    installSkins(app, privacyOf, skinsStore, store)
    installSkinLibrary(app, privacyOf, store)

    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    closeServer = () => new Promise((resolve) => server.close(() => resolve()))
  })

  afterEach(async () => {
    if (closeServer) {
      await closeServer()
    }
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('dedupes by hash and bumps lastUsedAt without increasing entry count', async () => {
    const png = makePng(64, 64, 6, 8, 10, 20, 30)
    const expectedId = computeLibId(png)

    const first = await store.archive({
      bytes: png,
      source: 'generated',
      prompt: 'cyberpunk warrior',
    })
    expect(first.id).toBe(expectedId)
    expect(first.name).toBe('cyberpunk warrior')
    expect(first.source).toBe('generated')
    expect(first.prompt).toBe('cyberpunk warrior')

    // Sleep 15ms so timestamp differences are observable
    await new Promise((r) => setTimeout(r, 20))

    const second = await store.archive({
      bytes: png,
      source: 'saved',
      agentId: 'coder',
    })
    expect(second.id).toBe(expectedId)
    expect(new Date(second.lastUsedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.lastUsedAt).getTime(),
    )

    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(expectedId)
  })

  it('enforces cap of 60 entries and evicts oldest by lastUsedAt', async () => {
    const customStore = new SkinLibraryStore(libDir, skinsPath, 60)

    // Create 65 unique PNGs
    const items: Array<{ id: string; lastUsedAt: string }> = []
    for (let i = 0; i < 65; i++) {
      const png = makePng(64, 64, 6, 8, i, 50, 100)
      const baseTime = new Date(Date.now() - (65 - i) * 1000).toISOString()
      const item = await customStore.archive({
        bytes: png,
        source: 'generated',
        prompt: `prompt number ${i}`,
        createdAt: baseTime,
      })
      items.push({ id: item.id, lastUsedAt: item.lastUsedAt })
    }

    const remaining = await customStore.list()
    expect(remaining).toHaveLength(60)

    // The first 5 items (oldest lastUsedAt) must have been evicted from disk
    for (let i = 0; i < 5; i++) {
      const evictedId = items[i].id
      expect(await customStore.getItem(evictedId)).toBeNull()
      expect(await customStore.getPng(evictedId)).toBeNull()
    }

    // The remaining 60 items must still exist
    for (let i = 5; i < 65; i++) {
      const keptId = items[i].id
      expect(await customStore.getItem(keptId)).not.toBeNull()
      expect(await customStore.getPng(keptId)).not.toBeNull()
    }
  })

  it('validates rename input and returns 400 or 404 properly', async () => {
    const png = makePng(64, 64, 6, 8, 30, 40, 50)
    const item = await store.archive({
      bytes: png,
      source: 'saved',
      agentId: 'tester',
    })

    // Empty string after trim -> 400
    const resEmpty = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: '   ' }),
    })
    expect(resEmpty.status).toBe(400)

    // Over 40 chars -> 400
    const resTooLong = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'a'.repeat(41) }),
    })
    expect(resTooLong.status).toBe(400)

    // Non-string -> 400
    const resNonString = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: 12345 }),
    })
    expect(resNonString.status).toBe(400)

    // Unknown 12-hex ID -> 404
    const resUnknown = await fetch(`${base}/api/skin-library/0123456789ab`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'Valid New Name' }),
    })
    expect(resUnknown.status).toBe(404)

    // Valid rename 1..40 chars -> 200
    const resSuccess = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: '  Renamed Skin  ' }),
    })
    expect(resSuccess.status).toBe(200)
    const updated = (await resSuccess.json()) as { name: string }
    expect(updated.name).toBe('Renamed Skin')

    // Confirm persisted
    const stored = await store.getItem(item.id)
    expect(stored?.name).toBe('Renamed Skin')
  })

  it('performs idempotent deletion', async () => {
    const png = makePng(64, 64, 6, 8, 40, 50, 60)
    const item = await store.archive({
      bytes: png,
      source: 'generated',
    })

    // First delete -> 200
    const res1 = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(res1.status).toBe(200)
    expect(await res1.json()).toEqual({ ok: true })
    expect(await store.getItem(item.id)).toBeNull()
    expect(await store.getPng(item.id)).toBeNull()

    // Second delete on same id -> 200 (idempotent)
    const res2 = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual({ ok: true })

    // Delete on unknown valid id -> 200
    const res3 = await fetch(`${base}/api/skin-library/fedcba987654`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(res3.status).toBe(200)
    expect(await res3.json()).toEqual({ ok: true })
  })

  it('rejects invalid lib IDs and directory traversal with 400', async () => {
    // Bad id on GET .png
    const res1 = await fetch(`${base}/api/skin-library/bad-id.png`)
    expect(res1.status).toBe(400)

    // Traversal on store path resolution throws 400 SkinLibraryError
    expect(() => store.filePath('../../etc/passwd', 'png')).toThrow('Invalid library id.')
    expect(() => store.filePath('../bad', 'json')).toThrow('Invalid library id.')

    // Traversal on route
    const res2 = await fetch(`${base}/api/skin-library/%2e%2e%2fpasswd.png`)
    expect(res2.status).toBe(400)

    // Bad id on PATCH
    const res3 = await fetch(`${base}/api/skin-library/123`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'test' }),
    })
    expect(res3.status).toBe(400)

    // Bad id on DELETE
    const res4 = await fetch(`${base}/api/skin-library/non-hex-length-12`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(res4.status).toBe(400)
  })

  it('enforces origin check on mutating routes (PATCH and DELETE)', async () => {
    const png = makePng(64, 64, 6, 8, 70, 80, 90)
    const item = await store.archive({ bytes: png, source: 'saved', agentId: 'bot' })

    // PATCH with evil origin -> 403
    const resPatchForbidden = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        origin: 'http://malicious-site.example.com',
      },
      body: JSON.stringify({ name: 'Hacked' }),
    })
    expect(resPatchForbidden.status).toBe(403)

    // DELETE with evil origin -> 403
    const resDeleteForbidden = await fetch(`${base}/api/skin-library/${item.id}`, {
      method: 'DELETE',
      headers: {
        origin: 'http://malicious-site.example.com',
      },
    })
    expect(resDeleteForbidden.status).toBe(403)
  })

  it('hides locked agent entries from list and returns 423 on .png, PATCH, DELETE', async () => {
    // Set PIN and lock 'secret-agent'
    await lockStore.setPin('123456', ['secret-agent'])

    const pngSecret = makePng(64, 64, 6, 8, 1, 2, 3)
    const secretItem = await store.archive({
      bytes: pngSecret,
      source: 'saved',
      agentId: 'secret-agent',
    })

    const pngPublic = makePng(64, 64, 6, 8, 4, 5, 6)
    const publicItem = await store.archive({
      bytes: pngPublic,
      source: 'saved',
      agentId: 'public-agent',
    })

    const pngUnassigned = makePng(64, 64, 6, 8, 7, 8, 9)
    const unassignedItem = await store.archive({
      bytes: pngUnassigned,
      source: 'generated',
      prompt: 'anonymous skin',
    })

    // List: secret-agent must be omitted, public and unassigned present
    const listRes = await fetch(`${base}/api/skin-library`)
    expect(listRes.status).toBe(200)
    const listData = (await listRes.json()) as { items: Array<{ id: string }> }
    const ids = listData.items.map((i) => i.id)
    expect(ids).toContain(publicItem.id)
    expect(ids).toContain(unassignedItem.id)
    expect(ids).not.toContain(secretItem.id)

    // GET .png for locked agent -> 423
    const pngRes = await fetch(`${base}/api/skin-library/${secretItem.id}.png`)
    expect(pngRes.status).toBe(423)
    const pngLockedBody = (await pngRes.json()) as { locked: string; agent: string }
    expect(pngLockedBody.locked).toBe('profile')
    expect(pngLockedBody.agent).toBe('secret-agent')

    // PATCH for locked agent -> 423
    const patchRes = await fetch(`${base}/api/skin-library/${secretItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', origin: base },
      body: JSON.stringify({ name: 'Should Fail' }),
    })
    expect(patchRes.status).toBe(423)

    // DELETE for locked agent -> 423
    const deleteRes = await fetch(`${base}/api/skin-library/${secretItem.id}`, {
      method: 'DELETE',
      headers: { origin: base },
    })
    expect(deleteRes.status).toBe(423)
  })

  it('seeds on first run and does not re-seed when library directory already exists', async () => {
    // Prepare fresh separate test dir
    const seedTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ruang-seed-test-'))
    const seedSkinsDir = path.join(seedTmp, 'skins')
    const seedLibDir = path.join(seedSkinsDir, 'library')
    await fs.mkdir(seedSkinsDir, { recursive: true })

    const png1 = makePng(64, 64, 6, 8, 10, 10, 10)
    const png2 = makePng(64, 64, 6, 8, 20, 20, 20)
    await fs.writeFile(path.join(seedSkinsDir, 'agent1.png'), png1)
    await fs.writeFile(path.join(seedSkinsDir, 'agent2.png'), png2)

    const seedStore = new SkinLibraryStore(seedLibDir, seedSkinsDir)

    // First seed: directory does not exist, so it should seed both files
    await seedStore.seed()
    const items1 = await seedStore.list()
    expect(items1).toHaveLength(2)
    const agentIds = items1.map((i) => i.agentId)
    expect(agentIds).toContain('agent1')
    expect(agentIds).toContain('agent2')

    // Add a third agent file to the skins directory
    const png3 = makePng(64, 64, 6, 8, 30, 30, 30)
    await fs.writeFile(path.join(seedSkinsDir, 'agent3.png'), png3)

    // Second seed: library dir exists -> does NOT re-seed
    await seedStore.seed()
    const items2 = await seedStore.list()
    expect(items2).toHaveLength(2)
    expect(items2.map((i) => i.agentId)).not.toContain('agent3')

    await fs.rm(seedTmp, { recursive: true, force: true }).catch(() => {})
  })

  it('archives automatically on PUT /api/skins/:id save', async () => {
    const png = makePng(64, 64, 6, 8, 99, 88, 77)

    const putRes = await fetch(`${base}/api/skins/designer`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        origin: base,
      },
      body: png,
    })
    expect(putRes.status).toBe(200)

    const expectedLibId = computeLibId(png)
    const item = await store.getItem(expectedLibId)
    expect(item).not.toBeNull()
    expect(item?.source).toBe('saved')
    expect(item?.agentId).toBe('designer')
    expect(item?.name).toBe('designer skin')
  })

  it('archives automatically when skin generation finishes for all providers', async () => {
    // 1. LLM provider via stub completion
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
    const mockLlmApp = express()
    const mockRateLimiter = new GenerateRateLimiter()

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(sampleValidLlmJson),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })

    const llmLibStore = new SkinLibraryStore(libDir, skinsPath)
    installSkinGenerate(mockLlmApp, {
      provider: 'llm',
      rateLimiter: mockRateLimiter,
      libraryStore: llmLibStore,
      fetchFn: mockFetch as unknown as typeof fetch,
      timeoutMs: 500,
      apiKey: 'test-key',
    })

    const llmServer = mockLlmApp.listen(0, '127.0.0.1')
    await new Promise((r) => llmServer.once('listening', r))
    const llmBase = `http://127.0.0.1:${(llmServer.address() as AddressInfo).port}`

    try {
      const genRes = await fetch(`${llmBase}/api/skins/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin: llmBase },
        body: JSON.stringify({ prompt: 'space explorer', agent: 'astronaut' }),
      })
      expect(genRes.status).toBe(202)
      const { jobId } = (await genRes.json()) as { jobId: string }

      // Poll until done
      let done = false
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const poll = await fetch(`${llmBase}/api/skins/generate/${jobId}`)
        const data = (await poll.json()) as { status: string; png?: string }
        if (data.status === 'done') {
          done = true
          break
        }
      }
      expect(done).toBe(true)

      const items = await llmLibStore.list()
      const llmItem = items.find((i) => i.agentId === 'astronaut')
      expect(llmItem).toBeDefined()
      expect(llmItem?.source).toBe('generated')
      expect(llmItem?.prompt).toBe('space explorer')
    } finally {
      llmServer.close()
    }

    // 2. Flow provider via archiveGeneratedJob
    const pngFlow = makePng(64, 64, 6, 8, 22, 44, 66)
    const flowJob: SkinJob = {
      id: 'job_flow_test',
      status: 'done',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'flow',
      prompt: 'neon cyberpunk',
      part: 'all',
      agent: 'cyber-bot',
      png: pngFlow.toString('base64'),
    }
    await archiveGeneratedJob(flowJob, store)
    const flowLibItem = await store.getItem(computeLibId(pngFlow))
    expect(flowLibItem).not.toBeNull()
    expect(flowLibItem?.source).toBe('generated')
    expect(flowLibItem?.prompt).toBe('neon cyberpunk')
    expect(flowLibItem?.agentId).toBe('cyber-bot')

    // 3. Block provider via archiveGeneratedJob
    const pngBlock = makePng(64, 64, 6, 8, 33, 55, 77)
    const blockJob: SkinJob = {
      id: 'job_block_test',
      status: 'done',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      provider: 'block',
      prompt: 'retro pixel knight',
      part: 'all',
      png: pngBlock.toString('base64'),
    }
    await archiveGeneratedJob(blockJob, store)
    const blockLibItem = await store.getItem(computeLibId(pngBlock))
    expect(blockLibItem).not.toBeNull()
    expect(blockLibItem?.source).toBe('generated')
    expect(blockLibItem?.prompt).toBe('retro pixel knight')
    expect(blockLibItem?.agentId).toBeUndefined()
  })

  it('does not fail save or generate if library archiving fails', async () => {
    // Mock failing library store
    const failingStore = {
      archive: vi.fn().mockRejectedValue(new Error('Disk failure in library')),
    } as unknown as SkinLibraryStore

    const appWithFailingLib = express()
    const privacyOf = installProfileLock(appWithFailingLib, lockStore)
    installSkins(appWithFailingLib, privacyOf, skinsStore, failingStore)

    const failServer = appWithFailingLib.listen(0, '127.0.0.1')
    await new Promise((r) => failServer.once('listening', r))
    const failBase = `http://127.0.0.1:${(failServer.address() as AddressInfo).port}`

    try {
      const validPng = makePng(64, 64, 6, 8, 55, 66, 77)
      const saveRes = await fetch(`${failBase}/api/skins/resilient-agent`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          origin: failBase,
        },
        body: validPng,
      })
      // Save must succeed with 200 despite library failure
      expect(saveRes.status).toBe(200)
      expect(await skinsStore.get('resilient-agent')).not.toBeNull()

      // Test generate archive helper resilience
      const job: SkinJob = {
        id: 'job_resilient',
        status: 'done',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider: 'llm',
        prompt: 'test prompt',
        part: 'all',
        png: validPng.toString('base64'),
      }

      // Must not throw
      await expect(archiveGeneratedJob(job, failingStore)).resolves.not.toThrow()
    } finally {
      failServer.close()
    }
  })

  it('sets correct headers on GET /:id.png', async () => {
    const png = makePng(64, 64, 6, 8, 80, 90, 100)
    const item = await store.archive({ bytes: png, source: 'saved' })

    const res = await fetch(`${base}/api/skin-library/${item.id}.png`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable',
    )
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(png)).toBe(true)
  })

  it('enforces file permissions 0700 on library dir and 0600 on files', async () => {
    const png = makePng(64, 64, 6, 8, 11, 22, 33)
    const item = await store.archive({ bytes: png, source: 'saved' })

    const dirStat = await fs.stat(libDir)
    // 0o700 mask check: dir mode in octal & 0o777 === 0o700
    expect(dirStat.mode & 0o777).toBe(0o700)

    const pngStat = await fs.stat(store.filePath(item.id, 'png'))
    expect(pngStat.mode & 0o777).toBe(0o600)

    const jsonStat = await fs.stat(store.filePath(item.id, 'json'))
    expect(jsonStat.mode & 0o777).toBe(0o600)
  })
})
