import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import express, { type Express, type Request, type Response, type Router } from 'express'
import { isHidden, type Privacy } from './profile-lock.js'
import { isValidSkinId, matchOriginHost, validatePng } from './skins.js'

export const LIB_ID_REGEX = /^[0-9a-f]{12}$/

export function isValidLibId(id: unknown): id is string {
  return typeof id === 'string' && LIB_ID_REGEX.test(id)
}

export function computeLibId(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex').slice(0, 12)
}

export function skinLibraryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUANG_DATA_DIR) {
    return join(env.RUANG_DATA_DIR, 'skins', 'library')
  }
  return join(homedir(), '.local', 'share', 'ruang', 'skins', 'library')
}

export class SkinLibraryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SkinLibraryError'
  }
}

export interface SkinLibraryItem {
  id: string
  name: string
  source: 'generated' | 'saved'
  prompt?: string
  agentId?: string
  createdAt: string
  lastUsedAt: string
}

export interface ArchiveInput {
  bytes: Buffer
  source: 'generated' | 'saved'
  prompt?: string
  agentId?: string
  name?: string
  createdAt?: string
}

export class SkinLibraryStore {
  readonly dir: string
  readonly skinsDirectory: string
  readonly maxEntries: number

  constructor(dir?: string, skinsDirectory?: string, maxEntries = 60) {
    this.dir = dir ?? skinLibraryDir()
    this.skinsDirectory = skinsDirectory ?? dirname(this.dir)
    this.maxEntries = maxEntries
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700).catch(() => {})
  }

  filePath(id: string, ext: 'png' | 'json'): string {
    if (!isValidLibId(id)) {
      throw new SkinLibraryError('Invalid library id.', 400)
    }
    const resolvedDir = resolve(this.dir)
    const resolvedFile = resolve(this.dir, `${id}.${ext}`)
    if (dirname(resolvedFile) !== resolvedDir) {
      throw new SkinLibraryError('Invalid library id.', 400)
    }
    return resolvedFile
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

  async getItem(id: string): Promise<SkinLibraryItem | null> {
    const file = this.filePath(id, 'json')
    try {
      const raw = await readFile(file, 'utf8')
      return JSON.parse(raw) as SkinLibraryItem
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      return null
    }
  }

  async getPng(id: string): Promise<Buffer | null> {
    const file = this.filePath(id, 'png')
    try {
      return await readFile(file)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      return null
    }
  }

  async list(): Promise<SkinLibraryItem[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      const items: SkinLibraryItem[] = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -5)
        if (!isValidLibId(id)) continue
        const item = await this.getItem(id)
        if (item) {
          items.push(item)
        }
      }
      items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      return items
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }
  }

  async archive(input: ArchiveInput): Promise<SkinLibraryItem> {
    validatePng(input.bytes)
    const id = computeLibId(input.bytes)
    await this.init()

    const existing = await this.getItem(id)
    if (existing) {
      const now = new Date().toISOString()
      existing.lastUsedAt = now
      await this.writeAtomic(`${id}.json`, JSON.stringify(existing, null, 2))
      try {
        await stat(this.filePath(id, 'png'))
      } catch {
        await this.writeAtomic(`${id}.png`, input.bytes)
      }
      return existing
    }

    let name = input.name?.trim().slice(0, 40)
    if (!name) {
      if (input.source === 'generated') {
        const prompt = input.prompt?.trim()
        name = prompt ? prompt.slice(0, 40) : 'generated skin'
      } else {
        name = input.agentId ? `${input.agentId} skin` : 'saved skin'
      }
    }

    const now = new Date().toISOString()
    const createdAt = input.createdAt ?? now
    const lastUsedAt = input.createdAt ?? now

    const item: SkinLibraryItem = {
      id,
      name,
      source: input.source,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      createdAt,
      lastUsedAt,
    }

    await this.writeAtomic(`${id}.png`, input.bytes)
    await this.writeAtomic(`${id}.json`, JSON.stringify(item, null, 2))

    await this.enforceCap(this.maxEntries)
    return item
  }

  async updateName(id: string, name: string): Promise<SkinLibraryItem | null> {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 40) {
      throw new SkinLibraryError('Name must be between 1 and 40 characters.', 400)
    }
    const item = await this.getItem(id)
    if (!item) return null
    item.name = trimmed
    await this.writeAtomic(`${id}.json`, JSON.stringify(item, null, 2))
    return item
  }

  async delete(id: string): Promise<boolean> {
    const pngPath = this.filePath(id, 'png')
    const jsonPath = this.filePath(id, 'json')
    await Promise.all([
      rm(pngPath, { force: true }),
      rm(jsonPath, { force: true }),
    ])
    return true
  }

  async enforceCap(limit = 60): Promise<void> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      const items: SkinLibraryItem[] = []
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const id = entry.name.slice(0, -5)
        if (!isValidLibId(id)) continue
        const item = await this.getItem(id)
        if (item) items.push(item)
      }
      if (items.length <= limit) return

      // Sort oldest lastUsedAt first
      items.sort((a, b) => {
        const timeDiff = new Date(a.lastUsedAt).getTime() - new Date(b.lastUsedAt).getTime()
        if (timeDiff !== 0) return timeDiff
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        if (createdDiff !== 0) return createdDiff
        return a.id.localeCompare(b.id)
      })

      const excessCount = items.length - limit
      const toEvict = items.slice(0, excessCount)
      for (const item of toEvict) {
        await this.delete(item.id)
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  }

  async seed(): Promise<void> {
    // If library dir already exists, do not seed
    try {
      const s = await stat(this.dir)
      if (s.isDirectory()) {
        return
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return
      }
    }

    try {
      await this.init()
      const entries = await readdir(this.skinsDirectory, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.png')) continue
        const agentId = entry.name.slice(0, -4)
        if (!isValidSkinId(agentId)) continue
        const filePath = join(this.skinsDirectory, entry.name)
        try {
          const [bytes, st] = await Promise.all([readFile(filePath), stat(filePath)])
          validatePng(bytes)
          const id = computeLibId(bytes)
          const existing = await this.getItem(id)
          if (existing) continue
          const createdAt = st.mtime.toISOString()
          const item: SkinLibraryItem = {
            id,
            name: `${agentId} skin`,
            source: 'saved',
            agentId,
            createdAt,
            lastUsedAt: createdAt,
          }
          await this.writeAtomic(`${id}.png`, bytes)
          await this.writeAtomic(`${id}.json`, JSON.stringify(item, null, 2))
        } catch {
          // Skip invalid skins
          continue
        }
      }
      await this.enforceCap(this.maxEntries)
    } catch {
      // Seed errors swallowed
    }
  }
}

export function createSkinLibraryRouter(
  privacyOf: (request: Request) => Promise<Privacy>,
  store: SkinLibraryStore = new SkinLibraryStore(),
): Router {
  const router = express.Router()

  const locked = (response: Response, agent: string) =>
    response.status(423).json({ error: `🔒 ${agent} is locked. Enter the PIN to see it.`, locked: 'profile', agent })

  router.use(express.json({ limit: '64kb' }))

  // Origin check for mutating routes (PATCH, DELETE)
  router.use((request, response, next) => {
    if (request.method === 'PATCH' || request.method === 'DELETE') {
      if (!matchOriginHost(request.headers.origin, request.headers.host)) {
        response.status(403).json({ error: 'Forbidden.' })
        return
      }
    }
    next()
  })

  // GET /api/skin-library -> 200 { items: [...] } newest createdAt first
  router.get('/', async (request, response, next) => {
    try {
      const privacy = await privacyOf(request)
      const all = await store.list()
      const items = all.filter((item) => {
        if (!item.agentId) return true
        return !isHidden(privacy, item.agentId)
      })
      response.json({ items })
    } catch (error) {
      next(error)
    }
  })

  // GET /api/skin-library/:id.png -> 200 image/png, Cache-Control: private, max-age=31536000, immutable | 404
  router.get('/:id.png', async (request, response, next) => {
    const { id } = request.params
    if (!isValidLibId(id)) {
      response.status(400).json({ error: 'Invalid library id.' })
      return
    }
    try {
      const item = await store.getItem(id)
      if (!item) {
        response.status(404).json({ error: 'Library skin not found.' })
        return
      }
      const privacy = await privacyOf(request)
      if (item.agentId && isHidden(privacy, item.agentId)) {
        locked(response, item.agentId)
        return
      }
      const buffer = await store.getPng(id)
      if (!buffer) {
        response.status(404).json({ error: 'Library skin not found.' })
        return
      }
      response.set('Content-Type', 'image/png')
      response.set('Cache-Control', 'private, max-age=31536000, immutable')
      response.send(buffer)
    } catch (error) {
      if (error instanceof SkinLibraryError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  // PATCH /api/skin-library/:id JSON { name: string 1..40 after trim } -> 200 item | 400 | 404
  router.patch('/:id', async (request, response, next) => {
    const { id } = request.params
    if (!isValidLibId(id)) {
      response.status(400).json({ error: 'Invalid library id.' })
      return
    }
    const name = request.body?.name
    if (typeof name !== 'string') {
      response.status(400).json({ error: 'Name must be a string.' })
      return
    }
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 40) {
      response.status(400).json({ error: 'Name must be between 1 and 40 characters.' })
      return
    }
    try {
      const item = await store.getItem(id)
      if (!item) {
        response.status(404).json({ error: 'Library skin not found.' })
        return
      }
      const privacy = await privacyOf(request)
      if (item.agentId && isHidden(privacy, item.agentId)) {
        locked(response, item.agentId)
        return
      }
      const updated = await store.updateName(id, trimmed)
      if (!updated) {
        response.status(404).json({ error: 'Library skin not found.' })
        return
      }
      response.json(updated)
    } catch (error) {
      if (error instanceof SkinLibraryError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  // DELETE /api/skin-library/:id -> 200 { ok: true }, idempotent
  router.delete('/:id', async (request, response, next) => {
    const { id } = request.params
    if (!isValidLibId(id)) {
      response.status(400).json({ error: 'Invalid library id.' })
      return
    }
    try {
      const item = await store.getItem(id)
      if (item) {
        const privacy = await privacyOf(request)
        if (item.agentId && isHidden(privacy, item.agentId)) {
          locked(response, item.agentId)
          return
        }
      }
      await store.delete(id)
      response.json({ ok: true })
    } catch (error) {
      if (error instanceof SkinLibraryError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  return router
}

export function installSkinLibrary(
  app: Express,
  privacyOf: (request: Request) => Promise<Privacy>,
  store: SkinLibraryStore = new SkinLibraryStore(),
): void {
  app.use('/api/skin-library', createSkinLibraryRouter(privacyOf, store))
}
