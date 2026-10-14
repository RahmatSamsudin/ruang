import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import express, { type Express, type Request, type Router } from 'express'
import { sceneFile } from './scene.js'
import { matchOriginHost } from './skins.js'

export interface ModelRecord {
  id: string
  name: string
  format: 'glb' | 'gltf'
  size: number
  createdAt: string
}

export const MODEL_ID_REGEX = /^m-[0-9a-f]{12}$/
export const DEFAULT_MAX_MODEL_BYTES = 10 * 1024 * 1024 // 10 MiB (10485760)
export const MAX_MODELS = 100

export class ModelError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra?: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ModelError'
  }
}

export function isValidModelId(id: unknown): id is string {
  return typeof id === 'string' && MODEL_ID_REGEX.test(id)
}

export function generateModelId(): string {
  return `m-${randomBytes(6).toString('hex')}`
}

export function sanitizeModelName(name?: unknown): string {
  if (typeof name !== 'string') return 'model'
  const base = name.split(/[/\\]/).pop() ?? ''
  const withoutExt = base.replace(/\.[^/.]*$/, '')
  // eslint-disable-next-line no-control-regex
  const cleanCtrl = withoutExt.replace(/[\u0000-\u001f\u007f]/g, '')
  const filtered = cleanCtrl.replace(/[^A-Za-z0-9 ._-]/g, '')
  const trimmed = filtered.trim()
  const sliced = trimmed.slice(0, 64).trim()
  if (!sliced || /^\.+$/.test(sliced)) {
    return 'model'
  }
  return sliced
}

export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUANG_DATA_DIR) {
    return join(env.RUANG_DATA_DIR, 'models')
  }
  return join(homedir(), '.local', 'share', 'ruang', 'models')
}

const FORBIDDEN_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'KHR_texture_basisu',
  'EXT_meshopt_compression',
])

function checkGltfJson(json: unknown): void {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ModelError('Invalid glTF: root must be an object.', 400)
  }

  const obj = json as Record<string, unknown>
  const asset = obj.asset
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
    throw new ModelError('Invalid glTF: missing asset object.', 400)
  }

  const version = (asset as Record<string, unknown>).version
  if (typeof version !== 'string' || (!version.startsWith('2.') && version !== '2.0')) {
    throw new ModelError('Unsupported glTF version. Version must be 2.x.', 400)
  }

  const allExtensions: string[] = []
  if (Array.isArray(obj.extensionsRequired)) allExtensions.push(...obj.extensionsRequired)
  if (Array.isArray(obj.extensionsUsed)) allExtensions.push(...obj.extensionsUsed)
  for (const ext of allExtensions) {
    if (typeof ext !== 'string') continue
    const lower = ext.toLowerCase()
    if (
      FORBIDDEN_EXTENSIONS.has(ext) ||
      lower.includes('draco') ||
      lower.includes('basisu') ||
      lower.includes('meshopt')
    ) {
      throw new ModelError(`Unsupported glTF extension: ${ext}.`, 400)
    }
  }

  if (Array.isArray(obj.buffers)) {
    for (const buf of obj.buffers) {
      if (buf && typeof buf === 'object' && 'uri' in buf && buf.uri !== undefined) {
        if (typeof buf.uri !== 'string' || !buf.uri.startsWith('data:')) {
          throw new ModelError('External buffer URIs are not allowed.', 400)
        }
      }
    }
  }

  if (Array.isArray(obj.images)) {
    for (const img of obj.images) {
      if (img && typeof img === 'object' && 'uri' in img && img.uri !== undefined) {
        if (typeof img.uri !== 'string' || !img.uri.startsWith('data:')) {
          throw new ModelError('External image URIs are not allowed.', 400)
        }
      }
    }
  }
}

export function validateModel(buffer: Buffer, expectedFormat?: 'glb' | 'gltf'): { format: 'glb' | 'gltf' } {
  if (!buffer || buffer.length === 0) {
    throw new ModelError('Empty model file.', 400)
  }

  let firstChar = ''
  for (let i = 0; i < Math.min(buffer.length, 128); i++) {
    const b = buffer[i]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      firstChar = String.fromCharCode(b)
      break
    }
  }
  const isJson = firstChar === '{'
  const detectedFormat: 'glb' | 'gltf' = expectedFormat ?? (isJson ? 'gltf' : 'glb')

  if (detectedFormat === 'glb') {
    if (buffer.length < 20) {
      throw new ModelError('Invalid GLB: file too small.', 400)
    }
    if (buffer.subarray(0, 4).toString('ascii') !== 'glTF') {
      throw new ModelError('Invalid GLB: invalid magic.', 400)
    }
    const version = buffer.readUInt32LE(4)
    if (version !== 2) {
      throw new ModelError('Invalid GLB: unsupported version.', 400)
    }
    const headerLength = buffer.readUInt32LE(8)
    if (headerLength !== buffer.length) {
      throw new ModelError('Invalid GLB: header length mismatch.', 400)
    }
    const chunkLength = buffer.readUInt32LE(12)
    const chunkType = buffer.subarray(16, 20).toString('ascii')
    if (chunkType !== 'JSON') {
      throw new ModelError('Invalid GLB: first chunk must be JSON.', 400)
    }
    if (20 + chunkLength > buffer.length) {
      throw new ModelError('Invalid GLB: chunk length exceeds file length.', 400)
    }
    const jsonBuffer = buffer.subarray(20, 20 + chunkLength)
    let json: unknown
    try {
      json = JSON.parse(jsonBuffer.toString('utf8'))
    } catch {
      throw new ModelError('Invalid GLB: JSON chunk parse failed.', 400)
    }
    checkGltfJson(json)
    return { format: 'glb' }
  }

  let json: unknown
  try {
    json = JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new ModelError('Invalid glTF: invalid JSON.', 400)
  }
  checkGltfJson(json)
  return { format: 'gltf' }
}

export function readModelBody(request: Request, limit = DEFAULT_MAX_MODEL_BYTES): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    if (Buffer.isBuffer(request.body)) {
      if (request.body.length > limit) {
        return rejectBody(new ModelError('Payload too large.', 413))
      }
      return resolveBody(request.body)
    }

    const declaredLength = Number(request.headers['content-length'])
    if (!Number.isNaN(declaredLength) && declaredLength > limit) {
      request.resume()
      return rejectBody(new ModelError('Payload too large.', 413))
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
        rejectBody(new ModelError('Payload too large.', 413))
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

export class ModelRateLimiter {
  private requests = new Map<string, number[]>()

  constructor(
    readonly windowMs = 60_000,
    readonly maxRequests = 10,
  ) {}

  check(ip: string): void {
    const now = Date.now()
    const timestamps = (this.requests.get(ip) ?? []).filter((t) => now - t < this.windowMs)
    if (timestamps.length >= this.maxRequests) {
      this.requests.set(ip, timestamps)
      throw new ModelError('Rate limit exceeded.', 429)
    }
    timestamps.push(now)
    this.requests.set(ip, timestamps)
  }

  reset(): void {
    this.requests.clear()
  }
}

class AsyncLock {
  private queue: Promise<void> = Promise.resolve()

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const prev = this.queue
    this.queue = next

    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

const dirLocks = new Map<string, AsyncLock>()
function getDirLock(dir: string): AsyncLock {
  const key = resolve(dir)
  let lock = dirLocks.get(key)
  if (!lock) {
    lock = new AsyncLock()
    dirLocks.set(key, lock)
  }
  return lock
}

export function parseMaxModelBytes(envValue = process.env.RUANG_MODEL_MAX_BYTES): number {
  const parsed = Number(envValue)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_MODEL_BYTES
}

export class ModelStore {
  constructor(
    readonly dir: string = modelsDir(),
    readonly maxModels: number = MAX_MODELS,
    readonly maxBytes: number = parseMaxModelBytes(),
  ) {}

  private get lock(): AsyncLock {
    return getDirLock(this.dir)
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700).catch(() => {})
  }

  private async writeAtomic(filename: string, content: Buffer | string): Promise<void> {
    await this.init()
    const target = join(this.dir, filename)
    const temporary = join(
      this.dir,
      `.${filename}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`,
    )
    await writeFile(temporary, content, { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, target)
    await chmod(target, 0o600).catch(() => {})
  }

  async list(): Promise<ModelRecord[]> {
    const indexPath = join(this.dir, 'index.json')
    let raw: string
    try {
      raw = await readFile(indexPath, 'utf8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return []
      }
      throw new ModelError('Model library unavailable.', 503, undefined, { cause: err })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const timestamp = Date.now()
      const corruptPath = join(this.dir, `index.json.corrupt-${timestamp}`)
      try {
        await rename(indexPath, corruptPath)
        console.warn(`[models] Corrupt index.json detected and renamed to index.json.corrupt-${timestamp}`, err)
      } catch {
        // ignore
      }
      return []
    }

    const listCandidate = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).models)
          ? ((parsed as Record<string, unknown>).models as unknown[])
          : null)
    if (!listCandidate) {
      const timestamp = Date.now()
      const corruptPath = join(this.dir, `index.json.corrupt-${timestamp}`)
      try {
        await rename(indexPath, corruptPath)
        console.warn(`[models] Malformed index.json detected and renamed to index.json.corrupt-${timestamp}`)
      } catch {
        // ignore
      }
      return []
    }

    const valid = listCandidate.filter((r): r is ModelRecord =>
      Boolean(
        r &&
        typeof r === 'object' &&
        isValidModelId((r as ModelRecord).id) &&
        typeof (r as ModelRecord).name === 'string' &&
        ((r as ModelRecord).format === 'glb' || (r as ModelRecord).format === 'gltf') &&
        typeof (r as ModelRecord).size === 'number' &&
        typeof (r as ModelRecord).createdAt === 'string',
      ),
    )
    valid.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    return valid
  }

  async get(id: string): Promise<ModelRecord | null> {
    if (!isValidModelId(id)) return null
    const models = await this.list()
    return models.find((m) => m.id === id) ?? null
  }

  async getFile(id: string): Promise<{ record: ModelRecord; bytes: Buffer } | null> {
    const record = await this.get(id)
    if (!record) return null
    try {
      const file = this.filePath(id, record.format)
      const bytes = await readFile(file)
      return { record, bytes }
    } catch {
      return null
    }
  }

  filePath(id: string, format: 'glb' | 'gltf'): string {
    if (!isValidModelId(id)) {
      throw new ModelError('Model not found.', 404)
    }
    const resolvedDir = resolve(this.dir)
    const resolvedFile = resolve(this.dir, `${id}.${format}`)
    if (dirname(resolvedFile) !== resolvedDir) {
      throw new ModelError('Model not found.', 404)
    }
    return resolvedFile
  }

  async save(name: string, buffer: Buffer, declaredContentType?: string): Promise<ModelRecord> {
    let expectedFormat: 'glb' | 'gltf' | undefined
    if (declaredContentType === 'model/gltf-binary') expectedFormat = 'glb'
    else if (declaredContentType === 'model/gltf+json') expectedFormat = 'gltf'

    const { format } = validateModel(buffer, expectedFormat)
    const sanitizedName = sanitizeModelName(name)

    return this.lock.run(async () => {
      const models = await this.list()
      if (models.length >= this.maxModels) {
        throw new ModelError('Model library full.', 409)
      }

      let id = generateModelId()
      while (models.some((m) => m.id === id)) {
        id = generateModelId()
      }

      const filename = `${id}.${format}`
      await this.writeAtomic(filename, buffer)

      const record: ModelRecord = {
        id,
        name: sanitizedName,
        format,
        size: buffer.length,
        createdAt: new Date().toISOString(),
      }

      const updated = [record, ...models]
      try {
        await this.writeAtomic('index.json', JSON.stringify(updated, null, 2))
      } catch (err) {
        await rm(this.filePath(id, format), { force: true }).catch(() => {})
        throw err
      }
      return record
    })
  }

  async getSceneUsages(modelId: string): Promise<string[]> {
    const p1 = resolve(dirname(this.dir), 'scene.json')
    const p2 = resolve(sceneFile())
    const pathsToCheck = p1 === p2 ? [p1] : [p1, p2]
    const usedBy: string[] = []

    for (const p of pathsToCheck) {
      let raw: string
      try {
        raw = await readFile(p, 'utf8')
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          continue
        }
        throw new ModelError('Cannot verify model usage in scene.', 409)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new ModelError('Cannot verify model usage in scene.', 409)
      }

      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { added?: unknown[] }).added)) {
        for (const item of (parsed as { added: unknown[] }).added) {
          if (
            item &&
            typeof item === 'object' &&
            (item as { kind?: unknown }).kind === 'model' &&
            (item as { modelId?: unknown }).modelId === modelId &&
            typeof (item as { id?: unknown }).id === 'string'
          ) {
            usedBy.push((item as { id: string }).id)
          }
        }
      } else if (!parsed || typeof parsed !== 'object') {
        throw new ModelError('Cannot verify model usage in scene.', 409)
      }
    }
    return Array.from(new Set(usedBy))
  }

  async delete(id: string): Promise<void> {
    if (!isValidModelId(id)) {
      throw new ModelError('Model not found.', 404)
    }

    return this.lock.run(async () => {
      const models = await this.list()
      const record = models.find((m) => m.id === id)
      if (!record) {
        throw new ModelError('Model not found.', 404)
      }

      const usedBy = await this.getSceneUsages(id)
      if (usedBy.length > 0) {
        throw new ModelError('Model is currently in use', 409, { usedBy })
      }

      const file = this.filePath(id, record.format)
      await rm(file, { force: true })

      const updated = models.filter((m) => m.id !== id)
      await this.writeAtomic('index.json', JSON.stringify(updated, null, 2))
    })
  }
}

export interface ModelsRouterOptions {
  store?: ModelStore
  rateLimiter?: ModelRateLimiter
}

export function createModelsRouter(options: ModelsRouterOptions = {}): Router {
  const router = express.Router()
  const store = options.store ?? new ModelStore()
  const rateLimiter = options.rateLimiter ?? new ModelRateLimiter()

  // Origin check for mutating routes (POST, DELETE)
  router.use((request, response, next) => {
    if (request.method === 'POST' || request.method === 'DELETE') {
      if (!matchOriginHost(request.headers.origin, request.headers.host)) {
        response.status(403).json({ error: 'Forbidden.' })
        return
      }
    }
    next()
  })

  // GET /api/models -> 200 { models: ModelRecord[] }
  router.get('/', async (_request, response, next) => {
    try {
      const models = await store.list()
      response.json({ models })
    } catch (error) {
      if (error instanceof ModelError) {
        response.status(error.status).json({ error: error.message, ...(error.extra ?? {}) })
        return
      }
      next(error)
    }
  })

  // POST /api/models?name=<filename> -> 201 { model: ModelRecord }
  router.post('/', async (request, response, next) => {
    try {
      const rawContentType = request.headers['content-type'] ?? ''
      const contentType = rawContentType.toLowerCase().split(';')[0].trim()
      const ALLOWED_CONTENT_TYPES = new Set([
        'application/octet-stream',
        'model/gltf-binary',
        'model/gltf+json',
      ])
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        response.status(415).json({ error: 'Unsupported Content-Type.' })
        return
      }

      const ip = request.ip || request.socket.remoteAddress || 'unknown'
      rateLimiter.check(ip)

      const currentList = await store.list()
      if (currentList.length >= store.maxModels) {
        request.resume()
        response.status(409).json({ error: 'Model library full.' })
        return
      }

      const buffer = await readModelBody(request, store.maxBytes)
      const nameParam = request.query.name as string | undefined
      const record = await store.save(nameParam ?? '', buffer, contentType)

      response.status(201).json({ model: record })
    } catch (error) {
      request.resume()
      if (error instanceof ModelError) {
        response.status(error.status).json({ error: error.message, ...(error.extra ?? {}) })
        return
      }
      next(error)
    }
  })

  // GET /api/models/:id/file -> original bytes
  router.get('/:id/file', async (request, response, next) => {
    try {
      const { id } = request.params
      if (!isValidModelId(id)) {
        response.status(404).json({ error: 'Model not found.' })
        return
      }

      const item = await store.getFile(id)
      if (!item) {
        response.status(404).json({ error: 'Model not found.' })
        return
      }

      const { record, bytes } = item
      const contentType = record.format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json'
      response.setHeader('Content-Type', contentType)
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Content-Disposition', `attachment; filename="${record.name}.${record.format}"`)
      response.send(bytes)
    } catch (error) {
      if (error instanceof ModelError) {
        response.status(error.status).json({ error: error.message, ...(error.extra ?? {}) })
        return
      }
      next(error)
    }
  })

  // DELETE /api/models/:id -> 204 | 404 | 409
  router.delete('/:id', async (request, response, next) => {
    try {
      const { id } = request.params
      if (!isValidModelId(id)) {
        response.status(404).json({ error: 'Model not found.' })
        return
      }

      await store.delete(id)
      response.status(204).end()
    } catch (error) {
      if (error instanceof ModelError) {
        response.status(error.status).json({ error: error.message, ...(error.extra ?? {}) })
        return
      }
      next(error)
    }
  })

  // Catch-all inside models router: bad id, traversal, unknown paths -> 404
  router.use((_request, response) => {
    response.status(404).json({ error: 'Model not found.' })
  })

  return router
}

export function installModels(app: Express, store: ModelStore = new ModelStore(), options: ModelsRouterOptions = {}): Router {
  const router = createModelsRouter({ store, ...options })
  app.use('/api/models', router)
  return router
}
