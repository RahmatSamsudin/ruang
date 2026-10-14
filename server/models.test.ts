import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccessStore, installAccess } from './access.js'
import {
  createModelsRouter,
  installModels,
  isValidModelId,
  ModelError,
  ModelRateLimiter,
  ModelRecord,
  modelsDir,
  ModelStore,
  sanitizeModelName,
  validateModel,
} from './models.js'

function makeTestGlb(jsonObj: unknown, binBuffer?: Buffer): Buffer {
  const jsonStr = JSON.stringify(jsonObj)
  let jsonBuf = Buffer.from(jsonStr, 'utf8')
  const jsonRemainder = jsonBuf.length % 4
  if (jsonRemainder !== 0) {
    const pad = 4 - jsonRemainder
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(pad, 0x20)])
  }

  let binChunk = Buffer.alloc(0)
  if (binBuffer && binBuffer.length > 0) {
    let binBuf = binBuffer
    const binRemainder = binBuf.length % 4
    if (binRemainder !== 0) {
      const pad = 4 - binRemainder
      binBuf = Buffer.concat([binBuf, Buffer.alloc(pad, 0x00)])
    }
    const binHeader = Buffer.alloc(8)
    binHeader.writeUInt32LE(binBuf.length, 0)
    binHeader.writeUInt32LE(0x004e4942, 4)
    binChunk = Buffer.concat([binHeader, binBuf])
  }

  const jsonHeader = Buffer.alloc(8)
  jsonHeader.writeUInt32LE(jsonBuf.length, 0)
  jsonHeader.writeUInt32LE(0x4e4f534a, 4)

  const totalLength = 12 + 8 + jsonBuf.length + binChunk.length

  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0) // 'glTF'
  header.writeUInt32LE(2, 4) // version 2
  header.writeUInt32LE(totalLength, 8)

  return Buffer.concat([header, jsonHeader, jsonBuf, binChunk])
}

const validGlbBuffer = makeTestGlb({ asset: { version: '2.0' } })
const validGltfBuffer = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }), 'utf8')

describe('models unit tests', () => {
  it('validates model IDs properly', () => {
    expect(isValidModelId('m-123456789abc')).toBe(true)
    expect(isValidModelId('m-abcdef012345')).toBe(true)
    expect(isValidModelId('m-ABCDEF012345')).toBe(false)
    expect(isValidModelId('m-12345')).toBe(false)
    expect(isValidModelId('m-123456789abcdef0')).toBe(false)
    expect(isValidModelId('../secret')).toBe(false)
    expect(isValidModelId('')).toBe(false)
    expect(isValidModelId(null)).toBe(false)
  })

  it('sanitises model filenames', () => {
    expect(sanitizeModelName('chair.glb')).toBe('chair')
    expect(sanitizeModelName('table.gltf')).toBe('table')
    expect(sanitizeModelName('model.bin.glb')).toBe('model.bin')
    expect(sanitizeModelName('../../evil.glb')).toBe('evil')
    expect(sanitizeModelName('..\\..\\evil.glb')).toBe('evil')
    expect(sanitizeModelName('../..')).toBe('model')
    expect(sanitizeModelName('foo\x00bar\x1f!.glb')).toBe('foobar')
    expect(sanitizeModelName('')).toBe('model')
    expect(sanitizeModelName(undefined)).toBe('model')
    expect(sanitizeModelName('   ')).toBe('model')
    expect(sanitizeModelName('...')).toBe('model')
    const longName = 'a'.repeat(100) + '.glb'
    expect(sanitizeModelName(longName)).toHaveLength(64)
  })

  it('resolves modelsDir according to environment', () => {
    expect(modelsDir({ RUANG_DATA_DIR: '/tmp/test-ruang' })).toBe('/tmp/test-ruang/models')
  })

  it('validates GLB and GLTF buffers correctly', () => {
    expect(validateModel(validGlbBuffer)).toEqual({ format: 'glb' })
    expect(validateModel(validGltfBuffer)).toEqual({ format: 'gltf' })

    // Empty
    expect(() => validateModel(Buffer.alloc(0))).toThrow(ModelError)

    // Invalid GLB magic
    const badMagic = Buffer.from(validGlbBuffer)
    badMagic.writeUInt32LE(0x12345678, 0)
    expect(() => validateModel(badMagic)).toThrow('Invalid GLB: invalid magic.')

    // Invalid GLB version
    const badVer = Buffer.from(validGlbBuffer)
    badVer.writeUInt32LE(1, 4)
    expect(() => validateModel(badVer)).toThrow('Invalid GLB: unsupported version.')

    // GLB length mismatch
    const badLen = Buffer.from(validGlbBuffer)
    badLen.writeUInt32LE(validGlbBuffer.length + 10, 8)
    expect(() => validateModel(badLen)).toThrow('Invalid GLB: header length mismatch.')

    // glTF missing asset
    const noAsset = Buffer.from(JSON.stringify({}), 'utf8')
    expect(() => validateModel(noAsset)).toThrow('missing asset object')

    // glTF unsupported version
    const oldVersion = Buffer.from(JSON.stringify({ asset: { version: '1.0' } }), 'utf8')
    expect(() => validateModel(oldVersion)).toThrow('Unsupported glTF version')

    // glTF forbidden extension Draco
    const dracoGltf = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      extensionsRequired: ['KHR_draco_mesh_compression'],
    }), 'utf8')
    expect(() => validateModel(dracoGltf)).toThrow('Unsupported glTF extension: KHR_draco_mesh_compression.')

    // glTF forbidden extension BasisU
    const basisuGltf = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_texture_basisu'],
    }), 'utf8')
    expect(() => validateModel(basisuGltf)).toThrow('Unsupported glTF extension: KHR_texture_basisu.')

    // glTF external buffer URI
    const externalBuf = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'https://evil.com/mesh.bin' }],
    }), 'utf8')
    expect(() => validateModel(externalBuf)).toThrow('External buffer URIs are not allowed.')

    // glTF inline data URI is allowed
    const inlineBuf = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }],
    }), 'utf8')
    expect(validateModel(inlineBuf)).toEqual({ format: 'gltf' })

    // glTF external image URI
    const externalImg = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      images: [{ uri: 'https://evil.com/tex.png' }],
    }), 'utf8')
    expect(() => validateModel(externalImg)).toThrow('External image URIs are not allowed.')

    // glTF inline data image URI is allowed
    const inlineImg = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      images: [{ uri: 'data:image/png;base64,iVBORw0KGgo=' }],
    }), 'utf8')
    expect(validateModel(inlineImg)).toEqual({ format: 'gltf' })
  })

  it('enforces directory permissions 0700 and file permissions 0600', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ruang-model-perm-test-'))
    try {
      const modelsPath = join(tmp, 'models')
      const store = new ModelStore(modelsPath)
      const record = await store.save('test.glb', validGlbBuffer)

      const dirStat = await stat(modelsPath)
      expect(dirStat.mode & 0o777).toBe(0o700)

      const fileStat = await stat(store.filePath(record.id, record.format))
      expect(fileStat.mode & 0o777).toBe(0o600)

      const indexStat = await stat(join(modelsPath, 'index.json'))
      expect(indexStat.mode & 0o777).toBe(0o600)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('handles missing or corrupt index.json gracefully', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ruang-model-corrupt-test-'))
    try {
      const modelsPath = join(tmp, 'models')
      const store = new ModelStore(modelsPath)
      await store.init()

      // Missing index.json
      expect(await store.list()).toEqual([])

      // Corrupt index.json
      await writeFile(join(modelsPath, 'index.json'), '{ invalid json ...')
      expect(await store.list()).toEqual([])

      // Saving after corrupt recovers and overwrites cleanly
      const record = await store.save('recovered.glb', validGlbBuffer)
      const list = await store.list()
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe(record.id)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('propagates non-ENOENT index read errors as 503 ModelError and aborts mutations without writes', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'ruang-model-read-err-test-'))
    try {
      const modelsPath = join(tmp, 'models')
      const store = new ModelStore(modelsPath)
      await store.init()

      // 1. EISDIR: index.json is a directory
      const indexPath = join(modelsPath, 'index.json')
      await mkdir(indexPath)

      await expect(store.list()).rejects.toMatchObject({
        name: 'ModelError',
        status: 503,
        message: 'Model library unavailable.',
      })

      // Verify original cause is attached
      try {
        await store.list()
        expect.unreachable('should have thrown')
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(ModelError)
        const me = err as ModelError & { cause?: { code?: string } }
        expect(me.cause).toBeDefined()
        expect(me.cause?.code).toBe('EISDIR')
      }

      // Save must abort before write; directory unchanged
      await expect(store.save('test.glb', validGlbBuffer)).rejects.toMatchObject({
        name: 'ModelError',
        status: 503,
      })

      // Delete must abort before write; directory unchanged
      await expect(store.delete('m-123456789abc')).rejects.toMatchObject({
        name: 'ModelError',
        status: 503,
      })

      // index.json still a directory, no temp or corrupt files created
      const entriesAfterEisdir = await readdir(modelsPath)
      expect(entriesAfterEisdir).toEqual(['index.json'])

      await rm(indexPath, { recursive: true, force: true })

      // 2. EACCES: chmod 000 (when not root)
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const initialContent = JSON.stringify([
          {
            id: 'm-0123456789ab',
            name: 'existing',
            format: 'glb',
            size: 100,
            createdAt: new Date().toISOString(),
          },
        ])
        await writeFile(indexPath, initialContent, { mode: 0o000 })
        await chmod(indexPath, 0o000)

        await expect(store.list()).rejects.toMatchObject({
          name: 'ModelError',
          status: 503,
          message: 'Model library unavailable.',
        })

        try {
          await store.list()
          expect.unreachable('should have thrown')
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(ModelError)
          const me = err as ModelError & { cause?: { code?: string } }
          expect(me.cause).toBeDefined()
          expect(me.cause?.code).toBe('EACCES')
        }

        // Save must abort before write
        await expect(store.save('test.glb', validGlbBuffer)).rejects.toMatchObject({
          name: 'ModelError',
          status: 503,
        })

        // Delete must abort before write
        await expect(store.delete('m-0123456789ab')).rejects.toMatchObject({
          name: 'ModelError',
          status: 503,
        })

        // Restore permissions to inspect and clean up
        await chmod(indexPath, 0o600)
        const contentAfter = await readFile(indexPath, 'utf8')
        expect(contentAfter).toBe(initialContent)

        const allFiles = await readdir(modelsPath)
        expect(allFiles).toEqual(['index.json'])
      }
    } finally {
      await chmod(join(tmp, 'models', 'index.json'), 0o600).catch(() => {})
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('rate limiter allows up to maxRequests and blocks subsequent within window', () => {
    const limiter = new ModelRateLimiter(60_000, 10)
    for (let i = 0; i < 10; i++) {
      expect(() => limiter.check('127.0.0.1')).not.toThrow()
    }
    expect(() => limiter.check('127.0.0.1')).toThrow(ModelError)
    expect(() => limiter.check('127.0.0.2')).not.toThrow()
    limiter.reset()
    expect(() => limiter.check('127.0.0.1')).not.toThrow()
  })
})

describe('models API HTTP integration', () => {
  let tmp: string
  let dataDir: string
  let modelsDirStr: string
  let store: ModelStore
  let rateLimiter: ModelRateLimiter
  let base: string
  let host: string
  let server: http.Server

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ruang-model-api-test-'))
    dataDir = tmp
    modelsDirStr = join(tmp, 'models')
    store = new ModelStore(modelsDirStr)
    rateLimiter = new ModelRateLimiter(60_000, 10)

    const app = express()
    const router = createModelsRouter({ store, rateLimiter })
    app.use('/api/models', router)
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void _next
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal error' })
    })

    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    host = `127.0.0.1:${port}`
    base = `http://${host}`
  })

  afterEach(async () => {
    server.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('uploads valid GLB and GLTF and lists them in GET /api/models', async () => {
    // 1. Initially empty
    const listRes0 = await fetch(`${base}/api/models`)
    expect(listRes0.status).toBe(200)
    const listBody0 = await listRes0.json() as { models: ModelRecord[] }
    expect(listBody0.models).toEqual([])

    // 2. Upload GLB
    const glbRes = await fetch(`${base}/api/models?name=tree.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(glbRes.status).toBe(201)
    const glbJson = await glbRes.json() as { model: ModelRecord }
    expect(glbJson.model.name).toBe('tree')
    expect(glbJson.model.format).toBe('glb')
    expect(glbJson.model.size).toBe(validGlbBuffer.length)
    expect(isValidModelId(glbJson.model.id)).toBe(true)

    // 3. Upload GLTF with octet-stream
    const gltfRes = await fetch(`${base}/api/models?name=../../chair.gltf`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'application/octet-stream',
      },
      body: validGltfBuffer,
    })
    expect(gltfRes.status).toBe(201)
    const gltfJson = await gltfRes.json() as { model: ModelRecord }
    expect(gltfJson.model.name).toBe('chair')
    expect(gltfJson.model.format).toBe('gltf')

    // 4. List models: newest first
    const listRes = await fetch(`${base}/api/models`)
    expect(listRes.status).toBe(200)
    const listBody = await listRes.json() as { models: ModelRecord[] }
    expect(listBody.models).toHaveLength(2)
    expect(listBody.models[0].id).toBe(gltfJson.model.id)
    expect(listBody.models[1].id).toBe(glbJson.model.id)
  })

  it('downloads model file and verifies round-trip byte equality and headers', async () => {
    const postRes = await fetch(`${base}/api/models?name=robot.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    const postJson = await postRes.json() as { model: ModelRecord }
    const modelId = postJson.model.id

    const getFileRes = await fetch(`${base}/api/models/${modelId}/file`)
    expect(getFileRes.status).toBe(200)
    expect(getFileRes.headers.get('content-type')).toBe('model/gltf-binary')
    expect(getFileRes.headers.get('x-content-type-options')).toBe('nosniff')
    expect(getFileRes.headers.get('content-disposition')).toBe('attachment; filename="robot.glb"')

    const downloadedBytes = Buffer.from(await getFileRes.arrayBuffer())
    expect(downloadedBytes.equals(validGlbBuffer)).toBe(true)
  })

  it('rejects invalid upload types, formats, and corrupt files with proper status codes', async () => {
    // 415 unsupported content-type
    const res415 = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'image/png' },
      body: validGlbBuffer,
    })
    expect(res415.status).toBe(415)

    // 400 empty body
    const resEmpty = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
    expect(resEmpty.status).toBe(400)

    // 400 bad glb magic
    const badGlb = Buffer.from(validGlbBuffer)
    badGlb.writeUInt32LE(0x12345678, 0)
    const resBadGlb = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'model/gltf-binary' },
      body: badGlb,
    })
    expect(resBadGlb.status).toBe(400)

    // 400 glTF with external buffer
    const externalGltf = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      buffers: [{ uri: 'https://evil.com/mesh.bin' }],
    }), 'utf8')
    const resExternal = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'model/gltf+json' },
      body: externalGltf,
    })
    expect(resExternal.status).toBe(400)

    // 400 glTF with Draco extension
    const dracoGltf = Buffer.from(JSON.stringify({
      asset: { version: '2.0' },
      extensionsRequired: ['KHR_draco_mesh_compression'],
    }), 'utf8')
    const resDraco = await fetch(`${base}/api/models`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'model/gltf+json' },
      body: dracoGltf,
    })
    expect(resDraco.status).toBe(400)
  })

  it('rejects bad id with 404 including path traversal attempts', async () => {
    const res1 = await fetch(`${base}/api/models/bad-id/file`)
    expect(res1.status).toBe(404)

    const res2 = await fetch(`${base}/api/models/..%2f..%2fsecret/file`)
    expect(res2.status).toBe(404)

    const res3 = await fetch(`${base}/api/models/m-12345/file`)
    expect(res3.status).toBe(404)

    const resDelBad = await fetch(`${base}/api/models/bad-id`, {
      method: 'DELETE',
      headers: { 'Origin': base, 'Host': host },
    })
    expect(resDelBad.status).toBe(404)
  })

  it('enforces upload rate limiting (10 allowed, 11th triggers 429)', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${base}/api/models?name=m${i}.glb`, {
        method: 'POST',
        headers: {
          'Origin': base,
          'Host': host,
          'Content-Type': 'model/gltf-binary',
        },
        body: validGlbBuffer,
      })
      expect(res.status).toBe(201)
    }

    const res11 = await fetch(`${base}/api/models?name=m11.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(res11.status).toBe(429)
    const errBody = await res11.json() as { error: string }
    expect(errBody.error).toBe('Rate limit exceeded.')
  })

  it('returns 409 when model library is full', async () => {
    // Custom store with maxModels = 1
    const smallStore = new ModelStore(modelsDirStr, 1)
    const app = express()
    app.use('/api/models', createModelsRouter({ store: smallStore }))
    const smallServer = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => smallServer.once('listening', resolve))
    const smallPort = (smallServer.address() as AddressInfo).port
    const smallBase = `http://127.0.0.1:${smallPort}`

    try {
      const res1 = await fetch(`${smallBase}/api/models?name=first.glb`, {
        method: 'POST',
        headers: { 'Origin': smallBase, 'Host': `127.0.0.1:${smallPort}`, 'Content-Type': 'model/gltf-binary' },
        body: validGlbBuffer,
      })
      expect(res1.status).toBe(201)

      const res2 = await fetch(`${smallBase}/api/models?name=second.glb`, {
        method: 'POST',
        headers: { 'Origin': smallBase, 'Host': `127.0.0.1:${smallPort}`, 'Content-Type': 'model/gltf-binary' },
        body: validGlbBuffer,
      })
      expect(res2.status).toBe(409)
      const err = await res2.json() as { error: string }
      expect(err.error).toMatch(/full/i)
    } finally {
      smallServer.close()
    }
  })

  it('enforces streaming size cap (413 Payload Too Large)', async () => {
    // Custom store with maxBytes = 30
    const tinyLimitStore = new ModelStore(modelsDirStr, 100, 30)
    const app = express()
    app.use('/api/models', createModelsRouter({ store: tinyLimitStore }))
    const smallServer = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => smallServer.once('listening', resolve))
    const smallPort = (smallServer.address() as AddressInfo).port
    const smallBase = `http://127.0.0.1:${smallPort}`

    try {
      const res = await fetch(`${smallBase}/api/models?name=toolarge.glb`, {
        method: 'POST',
        headers: {
          'Origin': smallBase,
          'Host': `127.0.0.1:${smallPort}`,
          'Content-Type': 'model/gltf-binary',
          'Content-Length': String(validGlbBuffer.length),
        },
        body: validGlbBuffer,
      })
      expect(res.status).toBe(413)
    } finally {
      smallServer.close()
    }
  })

  it('blocks mutating routes when Origin header does not match Host', async () => {
    const postRes = await fetch(`${base}/api/models?name=evil.glb`, {
      method: 'POST',
      headers: {
        'Origin': 'http://evil.com',
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(postRes.status).toBe(403)

    const delRes = await fetch(`${base}/api/models/m-123456789abc`, {
      method: 'DELETE',
      headers: {
        'Origin': 'http://evil.com',
        'Host': host,
      },
    })
    expect(delRes.status).toBe(403)
  })

  it('deletes model successfully when not in use', async () => {
    const postRes = await fetch(`${base}/api/models?name=temp.glb`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'model/gltf-binary' },
      body: validGlbBuffer,
    })
    const { model } = await postRes.json() as { model: ModelRecord }

    const delRes = await fetch(`${base}/api/models/${model.id}`, {
      method: 'DELETE',
      headers: { 'Origin': base, 'Host': host },
    })
    expect(delRes.status).toBe(204)

    // Confirm deleted from list
    const listRes = await fetch(`${base}/api/models`)
    const { models } = await listRes.json() as { models: ModelRecord[] }
    expect(models.find((m) => m.id === model.id)).toBeUndefined()

    // Confirm file returns 404
    const fileRes = await fetch(`${base}/api/models/${model.id}/file`)
    expect(fileRes.status).toBe(404)

    // Second delete returns 404
    const delRes2 = await fetch(`${base}/api/models/${model.id}`, {
      method: 'DELETE',
      headers: { 'Origin': base, 'Host': host },
    })
    expect(delRes2.status).toBe(404)
  })

  it('prevents DELETE and returns 409 with usedBy when referenced in scene.json', async () => {
    const postRes = await fetch(`${base}/api/models?name=inuse.glb`, {
      method: 'POST',
      headers: { 'Origin': base, 'Host': host, 'Content-Type': 'model/gltf-binary' },
      body: validGlbBuffer,
    })
    const { model } = await postRes.json() as { model: ModelRecord }

    // Create scene.json in dataDir with item referencing this model
    const scenePath = join(dataDir, 'scene.json')
    const sceneContent = {
      version: 1,
      overrides: {},
      added: [
        { id: 'desk-model-1', kind: 'model', modelId: model.id, position: [0, 0, 0] },
        { id: 'plant-model-2', kind: 'model', modelId: model.id, position: [1, 0, 1] },
        { id: 'other-prop', kind: 'prop', type: 'Sofa', position: [2, 0, 2] },
      ],
    }
    await writeFile(scenePath, JSON.stringify(sceneContent, null, 2))

    // Attempt delete
    const delRes = await fetch(`${base}/api/models/${model.id}`, {
      method: 'DELETE',
      headers: { 'Origin': base, 'Host': host },
    })
    expect(delRes.status).toBe(409)
    const err = await delRes.json() as { error: string; usedBy: string[] }
    expect(err.error).toBe('Model is currently in use')
    expect(err.usedBy).toEqual(['desk-model-1', 'plant-model-2'])

    // File should still exist
    const fileRes = await fetch(`${base}/api/models/${model.id}/file`)
    expect(fileRes.status).toBe(200)
  })

  it('integrates behind installAccess middleware when locked', async () => {
    const accessTmp = await mkdtemp(join(tmpdir(), 'ruang-access-test-'))
    try {
      const accessStore = new AccessStore(accessTmp)
      await accessStore.set('ruang-test-code-1234')

      const secureApp = express()
      installAccess(secureApp, accessStore)
      installModels(secureApp, store)

      const sServer = secureApp.listen(0, '127.0.0.1')
      await new Promise((resolve) => sServer.once('listening', resolve))
      const sPort = (sServer.address() as AddressInfo).port
      const sBase = `http://127.0.0.1:${sPort}`

      try {
        const res = await fetch(`${sBase}/api/models`)
        expect(res.status).toBe(401)
        const body = await res.json() as { error: string; locked: boolean }
        expect(body.locked).toBe(true)
      } finally {
        sServer.close()
      }
    } finally {
      await rm(accessTmp, { recursive: true, force: true })
    }
  })
})

describe('models concurrency and resilience', () => {
  let tmp: string
  let dataDir: string
  let modelsDirStr: string
  let store: ModelStore
  let base: string
  let host: string
  let server: http.Server

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ruang-model-concurrency-test-'))
    dataDir = tmp
    modelsDirStr = join(tmp, 'models')
    store = new ModelStore(modelsDirStr)

    // Bypass/widen rate limiter in test harness (10_000 max requests)
    const rateLimiter = new ModelRateLimiter(60_000, 10_000)
    const app = express()
    app.use('/api/models', createModelsRouter({ store, rateLimiter }))
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      void _next
      res.status(500).json({ error: error instanceof Error ? error.message : 'Internal error' })
    })

    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port
    host = `127.0.0.1:${port}`
    base = `http://${host}`
  })

  afterEach(async () => {
    server.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('handles 20 parallel saves: all 201, index length == files == 20', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fetch(`${base}/api/models?name=parallel-${i}.glb`, {
          method: 'POST',
          headers: {
            'Origin': base,
            'Host': host,
            'Content-Type': 'model/gltf-binary',
          },
          body: validGlbBuffer,
        }),
      ),
    )

    for (const res of results) {
      expect(res.status).toBe(201)
    }

    const listRes = await fetch(`${base}/api/models`)
    const listBody = (await listRes.json()) as { models: ModelRecord[] }
    expect(listBody.models).toHaveLength(20)

    const files = await readdir(modelsDirStr)
    const modelFiles = files.filter((f) => f.endsWith('.glb') || f.endsWith('.gltf'))
    expect(modelFiles).toHaveLength(20)
  })

  it('handles 30 parallel saves: all 201, index length == files == 30', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        fetch(`${base}/api/models?name=parallel30-${i}.glb`, {
          method: 'POST',
          headers: {
            'Origin': base,
            'Host': host,
            'Content-Type': 'model/gltf-binary',
          },
          body: validGlbBuffer,
        }),
      ),
    )

    for (const res of results) {
      expect(res.status).toBe(201)
    }

    const listRes = await fetch(`${base}/api/models`)
    const listBody = (await listRes.json()) as { models: ModelRecord[] }
    expect(listBody.models).toHaveLength(30)

    const files = await readdir(modelsDirStr)
    const modelFiles = files.filter((f) => f.endsWith('.glb') || f.endsWith('.gltf'))
    expect(modelFiles).toHaveLength(30)
  })

  it('filling to 99 then 5 parallel saves: exactly one 201 and 4 409, index length 100', async () => {
    await store.init()
    const dummyRecords: ModelRecord[] = []
    for (let i = 0; i < 99; i++) {
      const hex = i.toString(16).padStart(12, '0')
      const id = `m-${hex}`
      dummyRecords.push({
        id,
        name: `dummy-${i}`,
        format: 'glb',
        size: validGlbBuffer.length,
        createdAt: new Date().toISOString(),
      })
      await writeFile(join(modelsDirStr, `${id}.glb`), validGlbBuffer)
    }
    await writeFile(join(modelsDirStr, 'index.json'), JSON.stringify(dummyRecords, null, 2))

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`${base}/api/models?name=overflow-${i}.glb`, {
          method: 'POST',
          headers: {
            'Origin': base,
            'Host': host,
            'Content-Type': 'model/gltf-binary',
          },
          body: validGlbBuffer,
        }),
      ),
    )

    const statuses = results.map((r) => r.status)
    const successCount = statuses.filter((s) => s === 201).length
    const conflictCount = statuses.filter((s) => s === 409).length

    expect(successCount).toBe(1)
    expect(conflictCount).toBe(4)

    const listRes = await fetch(`${base}/api/models`)
    const listBody = (await listRes.json()) as { models: ModelRecord[] }
    expect(listBody.models).toHaveLength(100)
  })

  it('handles 5 parallel deletes of distinct IDs: all 204 and none remain listed', async () => {
    const created: ModelRecord[] = []
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/api/models?name=item-${i}.glb`, {
        method: 'POST',
        headers: {
          'Origin': base,
          'Host': host,
          'Content-Type': 'model/gltf-binary',
        },
        body: validGlbBuffer,
      })
      expect(res.status).toBe(201)
      const data = (await res.json()) as { model: ModelRecord }
      created.push(data.model)
    }

    const delResults = await Promise.all(
      created.map((m) =>
        fetch(`${base}/api/models/${m.id}`, {
          method: 'DELETE',
          headers: {
            'Origin': base,
            'Host': host,
          },
        }),
      ),
    )

    for (const res of delResults) {
      expect(res.status).toBe(204)
    }

    const listRes = await fetch(`${base}/api/models`)
    const listBody = (await listRes.json()) as { models: ModelRecord[] }
    expect(listBody.models).toHaveLength(0)

    const files = await readdir(modelsDirStr)
    const modelFiles = files.filter((f) => f.endsWith('.glb') || f.endsWith('.gltf'))
    expect(modelFiles).toHaveLength(0)
  })

  it('handles parallel delete of the same ID: exactly one 204 and rest 404', async () => {
    const postRes = await fetch(`${base}/api/models?name=target.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(postRes.status).toBe(201)
    const { model } = (await postRes.json()) as { model: ModelRecord }

    const delResults = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${base}/api/models/${model.id}`, {
          method: 'DELETE',
          headers: {
            'Origin': base,
            'Host': host,
          },
        }),
      ),
    )

    const statuses = delResults.map((r) => r.status)
    const successCount = statuses.filter((s) => s === 204).length
    const notFoundCount = statuses.filter((s) => s === 404).length

    expect(successCount).toBe(1)
    expect(notFoundCount).toBe(4)
  })

  it('refuses DELETE with 409 when scene.json is unparseable or corrupt', async () => {
    const postRes = await fetch(`${base}/api/models?name=scenetest.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(postRes.status).toBe(201)
    const { model } = (await postRes.json()) as { model: ModelRecord }

    // Corrupt scene.json
    const scenePath = join(dataDir, 'scene.json')
    await writeFile(scenePath, '{ corrupt json !!!')

    const delRes = await fetch(`${base}/api/models/${model.id}`, {
      method: 'DELETE',
      headers: {
        'Origin': base,
        'Host': host,
      },
    })
    expect(delRes.status).toBe(409)
    const body = (await delRes.json()) as { error: string }
    expect(body.error).toMatch(/scene/i)

    // Model still listed and file still intact
    const listRes = await fetch(`${base}/api/models`)
    const { models } = (await listRes.json()) as { models: ModelRecord[] }
    expect(models.some((m) => m.id === model.id)).toBe(true)
  })

  it('preserves corrupt index.json as .corrupt-<timestamp> and does not overwrite it on save', async () => {
    await store.init()
    const indexPath = join(modelsDirStr, 'index.json')
    await writeFile(indexPath, '{ corrupt index json content')

    // POST a new model
    const postRes = await fetch(`${base}/api/models?name=fresh.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(postRes.status).toBe(201)

    // Check directory files for preserved corrupt index
    const files = await readdir(modelsDirStr)
    const corruptBackup = files.find((f) => f.startsWith('index.json.corrupt-'))
    expect(corruptBackup).toBeDefined()

    const backupContent = await readFile(join(modelsDirStr, corruptBackup!), 'utf8')
    expect(backupContent).toBe('{ corrupt index json content')

    // New index.json is valid and contains fresh.glb
    const newIndexContent = await readFile(indexPath, 'utf8')
    const parsed = JSON.parse(newIndexContent)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe('fresh')
  })

  it('returns 503 on GET, POST, and DELETE when index.json encounters non-ENOENT read errors without creating temp files', async () => {
    // Populate an initial model first
    const postRes1 = await fetch(`${base}/api/models?name=existing.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(postRes1.status).toBe(201)
    const { model: existingModel } = (await postRes1.json()) as { model: ModelRecord }

    const indexPath = join(modelsDirStr, 'index.json')

    // Turn index.json into a directory to force EISDIR on readFile
    await rm(indexPath, { force: true })
    await mkdir(indexPath)

    // GET /api/models -> 503
    const getRes = await fetch(`${base}/api/models`)
    expect(getRes.status).toBe(503)
    const getBody = (await getRes.json()) as { error: string }
    expect(getBody.error).toBe('Model library unavailable.')

    // POST /api/models -> 503
    const postRes2 = await fetch(`${base}/api/models?name=fail.glb`, {
      method: 'POST',
      headers: {
        'Origin': base,
        'Host': host,
        'Content-Type': 'model/gltf-binary',
      },
      body: validGlbBuffer,
    })
    expect(postRes2.status).toBe(503)
    const postBody = (await postRes2.json()) as { error: string }
    expect(postBody.error).toBe('Model library unavailable.')

    // DELETE /api/models/:id -> 503
    const delRes = await fetch(`${base}/api/models/${existingModel.id}`, {
      method: 'DELETE',
      headers: {
        'Origin': base,
        'Host': host,
      },
    })
    expect(delRes.status).toBe(503)
    const delBody = (await delRes.json()) as { error: string }
    expect(delBody.error).toBe('Model library unavailable.')

    // Verify existing model file is still intact and no temp or corrupt files created
    const dirEntries = await readdir(modelsDirStr)
    expect(dirEntries.some((f) => f.startsWith('.index.json') || f.includes('.tmp'))).toBe(false)
    expect(dirEntries.some((f) => f.startsWith('index.json.corrupt-'))).toBe(false)
    expect(dirEntries).toContain(`${existingModel.id}.glb`)
  })
})
