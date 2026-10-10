import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express'
import { matchOriginHost } from './skins.js'

// The saved edits to the 3D office: a patch against the default scene the UI generates
// (src/scene3d/scene.ts defines the same shapes; keep the two in step).

export const MAX_SCENE_BYTES = 256 * 1024
export const MAX_ADDED = 500
export const MAX_OVERRIDES = 1000

export const SCENE_PROP_TYPES = [
  'AcOutdoorUnit', 'AirConditioner', 'ArcadeCabinet', 'Armchair', 'BaksoStall', 'BathroomFittings', 'Beanbag', 'Bed',
  'Bookshelf', 'CarromTable', 'ClothesLine', 'CoffeeTable', 'FlagPole', 'FloorCushion', 'Fridge', 'GalonDispenser',
  'Hammock', 'KopiStall', 'LowTable', 'MeetingTable', 'Nightstand', 'OfficeLight', 'PantryCounter', 'PingPongTable',
  'Plant', 'Railing', 'RattanChair', 'SideTable', 'Sofa', 'Staircase', 'StreetLamp', 'StringLights', 'Television',
  'Tree', 'WallClock', 'Wardrobe', 'WaterTank', 'WorkDesk',
] as const
const SURFACES = ['wood', 'tile', 'carpet', 'grass', 'asphalt', 'paving']

export interface ScenePatch {
  version: 1
  overrides: Record<string, Record<string, unknown> | null>
  added: Record<string, unknown>[]
}

export class SceneError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export function sceneFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.RUANG_DATA_DIR || join(homedir(), '.local', 'share', 'ruang'), 'scene.json')
}

type Check = (value: unknown) => boolean
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const num: Check = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000
const positive: Check = (value) => num(value) && (value as number) > 0
const unit: Check = (value) => num(value) && (value as number) >= 0 && (value as number) <= 1
const bool: Check = (value) => typeof value === 'boolean'
const tuple = (length: number, check: Check = num): Check => (value) => Array.isArray(value) && value.length === length && value.every(check)
const oneOf = (list: readonly string[]): Check => (value) => typeof value === 'string' && list.includes(value)
const color: Check = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
const surface: Check = (value) => isRecord(value) && Object.keys(value).every((key) => ['type', 'repeat', 'color'].includes(key)) && oneOf(SURFACES)(value.type) && tuple(2, positive)(value.repeat) && (value.color === undefined || color(value.color))
const propValues: Check = (value) => isRecord(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => /^[A-Za-z]{1,24}$/.test(key) && (num(item) || bool(item) || (typeof item === 'string' && item.length <= 64)))

const FIELDS: Record<string, Record<string, Check>> = {
  prop: { type: oneOf(SCENE_PROP_TYPES), position: tuple(3), rotation: num, props: propValues },
  floor: { min: tuple(2), max: tuple(2), y: num, surface, roughness: unit },
  wall: { from: tuple(2), to: tuple(2), y: num, height: positive },
  glass: { from: tuple(2), to: tuple(2), bottom: num, top: num },
  window: { position: tuple(3), rotation: num, width: positive },
  box: { position: tuple(3), size: tuple(3, positive), color, radius: num, roughness: unit, opacity: unit, shadow: bool },
}
const REQUIRED: Record<string, string[]> = {
  prop: ['type', 'position'], floor: ['min', 'max', 'y', 'surface'], wall: ['from', 'to', 'y', 'height'],
  glass: ['from', 'to', 'bottom', 'top'], window: ['position'], box: ['position', 'size', 'color'],
}
const COMMON: Record<string, Check> = { level: num, view: oneOf(['cutaway', 'shell', 'both']) }
// Overrides do not know the kind of the item they patch, so any field of any kind is allowed.
const ANY_FIELD: Record<string, Check> = Object.assign({}, ...Object.values(FIELDS), COMMON)

const ID = /^[A-Za-z0-9._-]{1,64}$/
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const SEAT_ID = /^(desk|bed)-\d+$/
const checkOf = (fields: Record<string, Check>, key: string): Check | undefined => (Object.hasOwn(fields, key) ? fields[key] : undefined)
const validId = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !FORBIDDEN_IDS.has(id)

function validateItem(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SceneError(`${where}: not an object.`)
  if (!validId(value.id)) throw new SceneError(`${where}: invalid id.`)
  if (SEAT_ID.test(value.id)) throw new SceneError(`${where}: ids like desk-N and bed-N are reserved for the crew's desks and beds.`)
  const kind = value.kind
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) throw new SceneError(`${where}: unknown kind.`)
  for (const [key, field] of Object.entries(value)) {
    if (key === 'id' || key === 'kind') continue
    const check = checkOf(COMMON, key) ?? checkOf(FIELDS[kind], key)
    if (!check || !check(field)) throw new SceneError(`${where}: invalid ${key}.`)
  }
  for (const key of ['level', ...REQUIRED[kind]]) if (!Object.hasOwn(value, key)) throw new SceneError(`${where}: missing ${key}.`)
  return value
}

function validateOverride(id: string, value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  if (!isRecord(value)) throw new SceneError(`overrides.${id}: must be an object or null.`)
  for (const [key, field] of Object.entries(value)) {
    if (key === 'id' || key === 'kind') throw new SceneError(`overrides.${id}: ${key} cannot be changed.`)
    const check = checkOf(ANY_FIELD, key)
    if (!check || !check(field)) throw new SceneError(`overrides.${id}: invalid ${key}.`)
  }
  return value
}

export function validatePatch(input: unknown): ScenePatch {
  if (!isRecord(input) || input.version !== 1) throw new SceneError('A scene patch is an object with version 1.')
  if (Object.keys(input).some((key) => !['version', 'overrides', 'added'].includes(key))) throw new SceneError('Unknown field in the scene patch.')
  const overrides = input.overrides ?? {}
  const added = input.added ?? []
  if (!isRecord(overrides)) throw new SceneError('overrides must be an object.')
  if (!Array.isArray(added)) throw new SceneError('added must be an array.')
  const ids = Object.keys(overrides)
  if (ids.length > MAX_OVERRIDES) throw new SceneError(`At most ${MAX_OVERRIDES} overrides.`)
  if (added.length > MAX_ADDED) throw new SceneError(`At most ${MAX_ADDED} added items.`)
  for (const id of ids) if (!validId(id)) throw new SceneError(`overrides: invalid id ${JSON.stringify(id)}.`)
  const items = added.map((item, index) => validateItem(item, `added[${index}]`))
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new SceneError('added: duplicate ids.')
  return { version: 1, overrides: Object.fromEntries(ids.map((id) => [id, validateOverride(id, overrides[id])])), added: items }
}

const emptyPatch = (): ScenePatch => ({ version: 1, overrides: {}, added: [] })

export class SceneStore {
  constructor(readonly file: string = sceneFile()) {}

  /** A missing, unreadable or invalid file reads as "no edits": the default office always renders. */
  async read(): Promise<ScenePatch> {
    try {
      return validatePatch(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      return emptyPatch()
    }
  }

  async write(patch: ScenePatch): Promise<void> {
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.scene.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(patch), { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => {})
  }

  async reset(): Promise<void> {
    await rm(this.file, { force: true })
  }
}

export function createSceneRouter(store: SceneStore = new SceneStore()): Router {
  const router = express.Router()

  router.use((request, response, next) => {
    if ((request.method === 'PUT' || request.method === 'DELETE') && !matchOriginHost(request.headers.origin, request.headers.host)) {
      response.status(403).json({ error: 'Forbidden.' })
      return
    }
    next()
  })

  router.get('/', async (_request, response, next) => {
    try {
      response.json(await store.read())
    } catch (error) {
      next(error)
    }
  })

  router.put('/', express.json({ limit: MAX_SCENE_BYTES }), async (request, response, next) => {
    if (!request.is('application/json')) {
      response.status(415).json({ error: 'Content-Type must be application/json.' })
      return
    }
    try {
      const patch = validatePatch(request.body)
      await store.write(patch)
      response.json(patch)
    } catch (error) {
      if (error instanceof SceneError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  router.delete('/', async (_request, response, next) => {
    try {
      await store.reset()
      response.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  // express.json reports oversized and malformed bodies as errors; answer them here, not as a 500.
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const type = (error as { type?: string } | null)?.type
    if (type === 'entity.too.large') { response.status(413).json({ error: 'Scene is too large.' }); return }
    if (type === 'entity.parse.failed') { response.status(400).json({ error: 'Invalid JSON.' }); return }
    next(error)
  })

  return router
}

export function installScene(app: Express, store: SceneStore = new SceneStore()): Router {
  const router = createSceneRouter(store)
  app.use('/api/scene', router)
  return router
}
