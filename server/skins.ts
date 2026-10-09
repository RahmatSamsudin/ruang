import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import express, { type Express, type Request, type Response, type Router } from 'express'
import { isHidden, type Privacy } from './profile-lock.js'
import { SkinLibraryStore } from './skin-library.js'

export const SKIN_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/
export const MAX_SKIN_BYTES = 16 * 1024 // 16 KiB

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class SkinError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function skinsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUANG_DATA_DIR) {
    return join(env.RUANG_DATA_DIR, 'skins')
  }
  return join(homedir(), '.local', 'share', 'ruang', 'skins')
}

export function isValidSkinId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > 64) return false
  if (id === '.' || id === '..') return false
  return SKIN_ID_REGEX.test(id)
}

export function matchOriginHost(originHeader?: string, hostHeader?: string): boolean {
  if (!originHeader || !hostHeader) return false
  try {
    const originHost = new URL(originHeader).host.toLowerCase()
    const cleanHost = hostHeader.toLowerCase().replace(/:(80|443)$/, '')
    return originHost === cleanHost || originHost === hostHeader.toLowerCase()
  } catch {
    return false
  }
}

export function validatePng(buffer: Buffer): void {
  if (buffer.length < 33) {
    throw new SkinError('Invalid PNG: file too short.', 400)
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new SkinError('Invalid PNG: invalid signature.', 400)
  }
  const chunkLength = buffer.readUInt32BE(8)
  if (chunkLength !== 13) {
    throw new SkinError('Invalid PNG: invalid IHDR length.', 400)
  }
  const chunkType = buffer.toString('ascii', 12, 16)
  if (chunkType !== 'IHDR') {
    throw new SkinError('Invalid PNG: missing IHDR chunk.', 400)
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer.readUInt8(24)
  const colorType = buffer.readUInt8(25)
  const compression = buffer.readUInt8(26)
  const filter = buffer.readUInt8(27)

  if (width !== 64 || height !== 64) {
    throw new SkinError(`Skin must be 64x64 pixels (received ${width}x${height}).`, 400)
  }
  if (colorType !== 6) {
    throw new SkinError('Skin must be RGBA color type.', 400)
  }
  if (bitDepth !== 8) {
    throw new SkinError('Skin must have 8-bit depth.', 400)
  }
  if (compression !== 0 || filter !== 0) {
    throw new SkinError('Invalid PNG: unsupported compression or filter.', 400)
  }
}

export function readSkinBody(request: Request, limit = MAX_SKIN_BYTES): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    if (Buffer.isBuffer(request.body)) {
      if (request.body.length > limit) {
        return rejectBody(new SkinError('Payload too large.', 413))
      }
      return resolveBody(request.body)
    }

    const declaredLength = Number(request.headers['content-length'])
    if (!Number.isNaN(declaredLength) && declaredLength > limit) {
      request.resume()
      return rejectBody(new SkinError('Payload too large.', 413))
    }

    if (request.readableEnded) {
      return resolveBody(Buffer.alloc(0))
    }

    const chunks: Buffer[] = []
    let total = 0
    let done = false

    const cleanup = () => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
    }

    const onData = (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > limit) {
        done = true
        cleanup()
        request.resume()
        rejectBody(new SkinError('Payload too large.', 413))
        return
      }
      chunks.push(chunk)
    }

    const onEnd = () => {
      if (done) return
      done = true
      cleanup()
      resolveBody(Buffer.concat(chunks))
    }

    const onError = (err: unknown) => {
      if (done) return
      done = true
      cleanup()
      rejectBody(err)
    }

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
  })
}

export interface SkinMeta {
  version: string
  updatedAt: string
}

export class SkinStore {
  constructor(readonly dir: string = skinsDir()) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700).catch(() => {})
  }

  filePath(id: string): string {
    if (!isValidSkinId(id)) throw new SkinError('Invalid agent id.', 400)
    const resolvedDir = resolve(this.dir)
    const resolvedFile = resolve(this.dir, `${id}.png`)
    if (dirname(resolvedFile) !== resolvedDir) throw new SkinError('Invalid agent id.', 400)
    return resolvedFile
  }

  async list(): Promise<Record<string, SkinMeta>> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      const result: Record<string, SkinMeta> = {}
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.png')) continue
        const id = entry.name.slice(0, -4)
        if (!isValidSkinId(id)) continue
        try {
          const fullPath = join(this.dir, entry.name)
          const [bytes, info] = await Promise.all([readFile(fullPath), stat(fullPath)])
          const version = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
          result[id] = { version, updatedAt: info.mtime.toISOString() }
        } catch {
          // File may have been removed concurrently
        }
      }
      return result
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async get(id: string): Promise<Buffer | null> {
    const file = this.filePath(id)
    try {
      return await readFile(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async save(id: string, bytes: Buffer): Promise<{ id: string; version: string; updatedAt: string }> {
    await this.init()
    const target = this.filePath(id)
    const temporary = join(this.dir, `.${id}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temporary, bytes, { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, target)
    await chmod(target, 0o600).catch(() => {})
    const info = await stat(target)
    const version = createHash('sha1').update(bytes).digest('hex').slice(0, 12)
    const updatedAt = info.mtime.toISOString()
    return { id, version, updatedAt }
  }

  async delete(id: string): Promise<boolean> {
    const file = this.filePath(id)
    try {
      await rm(file, { force: true })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }
}

export function createSkinsRouter(
  privacyOf: (request: Request) => Promise<Privacy>,
  store: SkinStore = new SkinStore(),
  libraryStore?: SkinLibraryStore,
): Router {
  const router = express.Router()
  const libStore = libraryStore ?? new SkinLibraryStore(join(store.dir, 'library'))

  const locked = (response: Response, agent: string) =>
    response.status(423).json({ error: `🔒 ${agent} is locked. Enter the PIN to see it.`, locked: 'profile', agent })

  // Origin check for mutating routes
  router.use((request, response, next) => {
    if (request.method === 'PUT' || request.method === 'DELETE') {
      if (!matchOriginHost(request.headers.origin, request.headers.host)) {
        response.status(403).json({ error: 'Forbidden.' })
        return
      }
    }
    next()
  })

  // GET /api/skins -> 200 {skins:{"<id>":{"version":"<sha1-12>","updatedAt":ISO}}}
  router.get('/', async (request, response, next) => {
    try {
      const privacy = await privacyOf(request)
      const all = await store.list()
      const skins: Record<string, SkinMeta> = {}
      for (const [id, meta] of Object.entries(all)) {
        if (!isHidden(privacy, id)) {
          skins[id] = meta
        }
      }
      response.json({ skins })
    } catch (error) {
      next(error)
    }
  })

  // Empty id on PUT/DELETE returns 400
  router.put('/', (_request, response) => {
    response.status(400).json({ error: 'Invalid agent id.' })
  })

  router.delete('/', (_request, response) => {
    response.status(400).json({ error: 'Invalid agent id.' })
  })

  // GET /api/skins/:id.png -> 200 image/png, Cache-Control: no-store | 404 {error}
  router.get('/:id.png', async (request, response, next) => {
    const { id } = request.params
    if (!isValidSkinId(id)) {
      response.status(400).json({ error: 'Invalid agent id.' })
      return
    }
    try {
      const privacy = await privacyOf(request)
      if (isHidden(privacy, id)) {
        locked(response, id)
        return
      }
      const buffer = await store.get(id)
      if (!buffer) {
        response.status(404).json({ error: 'Skin not found.' })
        return
      }
      response.set('Content-Type', 'image/png')
      response.set('Cache-Control', 'no-store')
      response.send(buffer)
    } catch (error) {
      next(error)
    }
  })

  // PUT /api/skins/:id body = raw image/png bytes, max 16 KiB -> 200 {id,version,updatedAt}
  router.put('/:id', async (request, response, next) => {
    const { id } = request.params
    if (!isValidSkinId(id)) {
      response.status(400).json({ error: 'Invalid agent id.' })
      return
    }
    try {
      const privacy = await privacyOf(request)
      if (isHidden(privacy, id)) {
        locked(response, id)
        return
      }
      const contentType = (request.headers['content-type'] ?? '').toLowerCase().split(';')[0].trim()
      if (contentType !== 'image/png') {
        response.status(415).json({ error: 'Content-Type must be image/png.' })
        return
      }
      const buffer = await readSkinBody(request)
      validatePng(buffer)
      const saved = await store.save(id, buffer)
      try {
        await libStore.archive({
          bytes: buffer,
          source: 'saved',
          agentId: id,
        })
      } catch (archiveError) {
        console.error('Skin library auto-archive failed:', archiveError)
      }
      response.json(saved)
    } catch (error) {
      if (error instanceof SkinError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  // DELETE /api/skins/:id -> 200 {ok:true}, idempotent
  router.delete('/:id', async (request, response, next) => {
    const { id } = request.params
    if (!isValidSkinId(id)) {
      response.status(400).json({ error: 'Invalid agent id.' })
      return
    }
    try {
      const privacy = await privacyOf(request)
      if (isHidden(privacy, id)) {
        locked(response, id)
        return
      }
      await store.delete(id)
      response.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  // Catch-all: bad/traversal ids outside valid routes return 400
  router.use((_request, response) => {
    response.status(400).json({ error: 'Invalid agent id.' })
  })

  return router
}

export function installSkins(
  app: Express,
  privacyOf: (request: Request) => Promise<Privacy>,
  store: SkinStore = new SkinStore(),
  libraryStore?: SkinLibraryStore,
): Router {
  const router = createSkinsRouter(privacyOf, store, libraryStore)
  app.use('/api/skins', router)
  return router
}
