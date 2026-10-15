import { PROP_TYPES, type ModelItem, type SceneItem, type ScenePatch } from './scene.ts'
import { defaultScene } from './default-scene.ts'
import { createLayout } from '../office3d-layout.ts'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]

export interface BundledModel {
  id: string
  name: string
  format: 'glb' | 'gltf'
  dataBase64: string
}

export interface RuangBundle {
  format: 'ruang-bundle'
  version: 1
  exportedAt: string
  patch: {
    version: 1 | 2
    overrides: Record<string, Partial<SceneItem> | null>
    added: SceneItem[]
    items?: SceneItem[]
  }
  models: BundledModel[]
}

export interface ImportBundleResult extends ScenePatch {
  itemCount: number
  modelCount: number
  newModelIds: string[]
}

export const MAX_BUNDLE_SIZE_BYTES = 40 * 1024 * 1024 // 40 MiB
export const MAX_BUNDLE_MODELS = 20
export const MAX_BUNDLE_ITEMS = 500
export const MAX_MODEL_DECODED_BYTES = 10 * 1024 * 1024 // 10 MiB

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/
const MODEL_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/
const SEAT_ID_REGEX = /^(desk|bed)-\d+$/
const KNOWN_SURFACES = new Set(['wood', 'tile', 'carpet', 'grass', 'asphalt', 'paving'])

export function formatBundleFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const h = pad(date.getHours())
  const min = pad(date.getMinutes())
  return `ruang-bundle-${y}${m}${d}-${h}${min}.json`
}

/**
 * Helper to convert an ArrayBuffer / Uint8Array to base64 string using chunks
 * to avoid call stack limits on large buffers.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 16384
  const len = bytes.byteLength
  for (let i = 0; i < len; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, len))
    binary += String.fromCharCode.apply(null, chunk as unknown as number[])
  }
  return btoa(binary)
}

/**
 * Helper to convert base64 string to Uint8Array with strict syntax checking.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, '')
  if (cleaned.length === 0 || cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new Error('Invalid base64 encoding')
  }
  let binary: string
  try {
    binary = atob(cleaned)
  } catch {
    throw new Error('Invalid base64 encoding')
  }
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Create a minimal valid GLB binary buffer with asset.version 2.0.
 */
export function createMinimalGlb(): Uint8Array {
  const jsonStr = JSON.stringify({ asset: { version: '2.0' } })
  const pad = (4 - (jsonStr.length % 4)) % 4
  const paddedJson = jsonStr + ' '.repeat(pad)
  const jsonBytes = new TextEncoder().encode(paddedJson)
  const totalLength = 12 + 8 + jsonBytes.length
  const buffer = new ArrayBuffer(totalLength)
  const view = new DataView(buffer)
  view.setUint32(0, 0x46546C67, true) // 'glTF'
  view.setUint32(4, 2, true)          // version 2
  view.setUint32(8, totalLength, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4E4F534A, true) // 'JSON'
  new Uint8Array(buffer, 20).set(jsonBytes)
  return new Uint8Array(buffer)
}

function checkPrototypeSafety(value: unknown, path = 'root'): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkPrototypeSafety(value[i], `${path}[${i}]`)
    }
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) {
    throw new Error(`Prototype safety violation at ${path}`)
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Forbidden key "${key}" detected at ${path}`)
    }
    checkPrototypeSafety((value as Record<string, unknown>)[key], `${path}.${key}`)
  }
}

export function validateModelBytes(bytes: Uint8Array, format: 'glb' | 'gltf', name: string): void {
  if (bytes.byteLength === 0) {
    throw new Error(`Model ${name} is empty`)
  }
  if (bytes.byteLength > MAX_MODEL_DECODED_BYTES) {
    throw new Error(`Model ${name} decoded size (${bytes.byteLength} bytes) exceeds cap of 10 MiB`)
  }
  if (format === 'glb') {
    if (bytes.byteLength < 20) {
      throw new Error(`Model ${name} is not a valid GLB: file too short (<20 bytes)`)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const magic = view.getUint32(0, true)
    // 0x46546C67 is 'glTF' in little-endian
    if (magic !== 0x46546C67) {
      throw new Error(`Model ${name} has invalid GLB magic header`)
    }
    const version = view.getUint32(4, true)
    if (version !== 2) {
      throw new Error(`Model ${name} has unsupported GLB version: ${version}`)
    }
    const totalLength = view.getUint32(8, true)
    if (totalLength !== bytes.byteLength) {
      throw new Error(`Model ${name} GLB header length (${totalLength}) does not match file size (${bytes.byteLength})`)
    }
    const chunkLength = view.getUint32(12, true)
    const chunkType = view.getUint32(16, true)
    // 0x4E4F534A is 'JSON' in little-endian
    if (chunkType !== 0x4E4F534A) {
      throw new Error(`Model ${name} GLB first chunk must be JSON`)
    }
    if (20 + chunkLength > bytes.byteLength) {
      throw new Error(`Model ${name} GLB chunk length exceeds file bounds`)
    }
    const jsonBytes = bytes.subarray(20, 20 + chunkLength)
    const jsonStr = new TextDecoder('utf-8').decode(jsonBytes)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new Error(`Model ${name} GLB contains invalid JSON chunk`)
    }
    const asset = parsed?.asset as Record<string, unknown> | undefined
    if (!asset || typeof asset.version !== 'string') {
      throw new Error(`Model ${name} GLB missing valid asset.version in JSON header`)
    }
  } else if (format === 'gltf') {
    let parsed: Record<string, unknown>
    try {
      const jsonStr = new TextDecoder('utf-8').decode(bytes)
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new Error(`Model ${name} is not valid glTF JSON`)
    }
    const asset = parsed?.asset as Record<string, unknown> | undefined
    if (!asset || typeof asset.version !== 'string') {
      throw new Error(`Model ${name} glTF missing valid asset.version`)
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type Check = (value: unknown) => boolean
const num: Check = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000
const positive: Check = (value) => num(value) && (value as number) > 0
const unit: Check = (value) => num(value) && (value as number) >= 0 && (value as number) <= 1
const bool: Check = (value) => typeof value === 'boolean'
const tuple = (length: number, check: Check = num): Check => (value) =>
  Array.isArray(value) && value.length === length && value.every(check)
const oneOf = (list: readonly string[]): Check => (value) =>
  typeof value === 'string' && list.includes(value)
const color: Check = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
const surface: Check = (value) =>
  isRecord(value) &&
  Object.keys(value).every((key) => ['type', 'repeat', 'color'].includes(key)) &&
  oneOf(Array.from(KNOWN_SURFACES))(value.type) &&
  tuple(2, positive)(value.repeat) &&
  (value.color === undefined || color(value.color))
const propValues: Check = (value) =>
  isRecord(value) &&
  Object.keys(value).length <= 16 &&
  Object.entries(value).every(
    ([key, item]) =>
      /^[A-Za-z]{1,24}$/.test(key) &&
      !FORBIDDEN_KEYS.has(key) &&
      ((num(item) && Math.abs(item as number) <= 100) || bool(item) || (typeof item === 'string' && item.length <= 64)),
  )

const modelIdCheck: Check = (value) =>
  typeof value === 'string' && MODEL_ID_REGEX.test(value) && !FORBIDDEN_KEYS.has(value)
const scaleCheck: Check = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100

const FIELDS: Record<string, Record<string, Check>> = {
  prop: { type: oneOf(PROP_TYPES), position: tuple(3), rotation: num, props: propValues },
  floor: { min: tuple(2), max: tuple(2), y: num, surface, roughness: unit },
  wall: { from: tuple(2), to: tuple(2), y: num, height: positive },
  glass: { from: tuple(2), to: tuple(2), bottom: num, top: num },
  window: { position: tuple(3), rotation: num, width: positive },
  box: { position: tuple(3), size: tuple(3, positive), color, radius: num, roughness: unit, opacity: unit, shadow: bool },
  model: { modelId: modelIdCheck, position: tuple(3), rotation: num, scale: scaleCheck },
}
const REQUIRED: Record<string, string[]> = {
  prop: ['type', 'position'],
  floor: ['min', 'max', 'y', 'surface'],
  wall: ['from', 'to', 'y', 'height'],
  glass: ['from', 'to', 'bottom', 'top'],
  window: ['position'],
  box: ['position', 'size', 'color'],
  model: ['modelId', 'position'],
}
const COMMON: Record<string, Check> = { level: num, view: oneOf(['cutaway', 'shell', 'both']) }
const checkOf = (fields: Record<string, Check>, key: string): Check | undefined =>
  Object.hasOwn(fields, key) ? fields[key] : undefined

const validId = (id: unknown): id is string =>
  typeof id === 'string' && ID_REGEX.test(id) && !FORBIDDEN_KEYS.has(id)

function validateSceneItem(item: unknown, index: number, availableModelIds: Set<string>): SceneItem {
  if (!isRecord(item)) {
    throw new Error(`Item [${index}] must be an object`)
  }
  const id = item.id
  if (!validId(id)) {
    throw new Error(`Item [${index}] has invalid id: ${String(id)}`)
  }
  if (SEAT_ID_REGEX.test(id)) {
    throw new Error(`Item [${index}] cannot use reserved seat id: ${id}`)
  }
  const kind = item.kind
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) {
    throw new Error(`Item ${id} has invalid kind: ${String(kind)}`)
  }

  for (const [key, field] of Object.entries(item)) {
    if (key === 'id' || key === 'kind') continue
    const check = checkOf(COMMON, key) ?? checkOf(FIELDS[kind], key)
    if (!check) {
      throw new Error(`Item ${id} contains forbidden or unexpected field "${key}"`)
    }
    if (!check(field)) {
      throw new Error(`Item ${id} has invalid ${key}`)
    }
  }

  for (const key of ['level', ...REQUIRED[kind]]) {
    if (!Object.hasOwn(item, key)) {
      throw new Error(`Item ${id} missing ${key}`)
    }
  }

  if (kind === 'model') {
    const modelId = item.modelId as string
    if (!availableModelIds.has(modelId)) {
      throw new Error(`Model item ${id} references modelId ${modelId} not found in bundle models`)
    }
  }

  return item as unknown as SceneItem
}

export interface ExportBundleOptions {
  fetchModel?: (modelId: string) => Promise<{ name: string; format: 'glb' | 'gltf'; bytes: Uint8Array } | null>
  includeModelIds?: string[]
}

/**
 * Export active patch and referenced models into a RuangBundle.
 * Exports only added items (live editor scene) + exactly the models referenced by model items (and any explicitly included model IDs).
 */
export async function exportBundle(
  patch: ScenePatch,
  options: ExportBundleOptions = {},
): Promise<RuangBundle> {
  const added = patch.added ?? []
  const modelIds = Array.from(
    new Set([
      ...added
        .filter((item): item is ModelItem => item.kind === 'model')
        .map((item) => item.modelId),
      ...(options.includeModelIds ?? []),
    ]),
  )

  if (modelIds.length > MAX_BUNDLE_MODELS) {
    throw new Error(`Referenced models count (${modelIds.length}) exceeds limit of ${MAX_BUNDLE_MODELS}.`)
  }

  const models: BundledModel[] = []

  let modelsListPromise: Promise<Array<{ id: string; name: string; format?: 'glb' | 'gltf' }>> | null = null
  if (!options.fetchModel && typeof fetch !== 'undefined') {
    modelsListPromise = fetch('/api/models')
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((data: { models?: Array<{ id: string; name: string; format?: 'glb' | 'gltf' }> }) => data.models ?? [])
      .catch(() => [])
  }

  for (const modelId of modelIds) {
    if (options.fetchModel) {
      const result = await options.fetchModel(modelId)
      if (!result) {
        throw new Error(`Failed to fetch model "${modelId}".`)
      }
      models.push({
        id: modelId,
        name: result.name,
        format: result.format,
        dataBase64: bytesToBase64(result.bytes),
      })
    } else {
      let fileRes: Response
      try {
        fileRes = await fetch(`/api/models/${encodeURIComponent(modelId)}/file`)
      } catch (err) {
        throw new Error(`Failed to fetch model "${modelId}": ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!fileRes.ok) {
        throw new Error(`Failed to fetch model "${modelId}" (${fileRes.status} ${fileRes.statusText || 'error'}).`)
      }
      const arrayBuffer = await fileRes.arrayBuffer()
      const contentType = fileRes.headers.get('content-type') || ''
      let format: 'glb' | 'gltf' = contentType.includes('json') ? 'gltf' : 'glb'
      let name = `${modelId}.${format}`

      if (modelsListPromise) {
        const list = await modelsListPromise
        const found = list.find((m) => m.id === modelId)
        if (found) {
          if (found.name) name = found.name
          if (found.format) format = found.format
        }
      }

      models.push({
        id: modelId,
        name,
        format,
        dataBase64: bytesToBase64(new Uint8Array(arrayBuffer)),
      })
    }
  }

  return {
    format: 'ruang-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    patch: {
      version: 2,
      overrides: {},
      added: [...added],
    },
    models,
  }
}

export interface ImportBundleOptions {
  uploadModel?: (name: string, format: 'glb' | 'gltf', bytes: Uint8Array) => Promise<{ id: string }>
  deleteModel?: (id: string) => Promise<void>
  onProgress?: (progress: { current: number; total: number; name: string }) => void
  throttleMs?: number
}

/**
 * Import a RuangBundle into the existing scene patch, remapping IDs to prevent collisions.
 * Validates strictly BEFORE any network calls; rolls back newly uploaded models on mid-import failure.
 */
export async function importBundle(
  bundleInput: RuangBundle | string,
  existingPatch: ScenePatch,
  options: ImportBundleOptions = {},
): Promise<ImportBundleResult> {
  let bundle: RuangBundle
  if (typeof bundleInput === 'string') {
    if (new Blob([bundleInput]).size > MAX_BUNDLE_SIZE_BYTES) {
      throw new Error(`Bundle exceeds maximum allowed size of 40 MiB`)
    }
    try {
      bundle = JSON.parse(bundleInput)
    } catch {
      throw new Error('Malformed bundle: invalid JSON')
    }
  } else {
    bundle = bundleInput
    const rawJson = JSON.stringify(bundleInput)
    if (new Blob([rawJson]).size > MAX_BUNDLE_SIZE_BYTES) {
      throw new Error(`Bundle exceeds maximum allowed size of 40 MiB`)
    }
  }

  checkPrototypeSafety(bundle, 'bundle')

  if (bundle.format !== 'ruang-bundle') {
    throw new Error(`Invalid bundle format: expected 'ruang-bundle', got '${bundle.format}'`)
  }
  if (bundle.version !== 1) {
    throw new Error(`Unsupported bundle version: expected 1, got ${bundle.version}`)
  }
  if (!bundle.patch || typeof bundle.patch !== 'object' || Array.isArray(bundle.patch)) {
    throw new Error(`Malformed bundle: missing patch object`)
  }
  if (bundle.patch.version !== 1 && bundle.patch.version !== 2) {
    throw new Error(`Unsupported patch version in bundle: expected 1 or 2, got ${bundle.patch.version}`)
  }

  const rawAdded = Array.isArray(bundle.patch.added)
    ? bundle.patch.added
    : Array.isArray(bundle.patch.items)
      ? bundle.patch.items
      : []
  if (rawAdded.length > MAX_BUNDLE_ITEMS) {
    throw new Error(`Bundle contains ${rawAdded.length} items, exceeding cap of ${MAX_BUNDLE_ITEMS}`)
  }

  const existingCount = existingPatch.added?.length ?? 0
  if (existingCount + rawAdded.length > MAX_BUNDLE_ITEMS) {
    throw new Error(`Import would result in ${existingCount + rawAdded.length} items, exceeding cap of ${MAX_BUNDLE_ITEMS}`)
  }

  const bundledModels = Array.isArray(bundle.models) ? bundle.models : []
  if (bundledModels.length > MAX_BUNDLE_MODELS) {
    throw new Error(`Bundle contains ${bundledModels.length} models, exceeding cap of ${MAX_BUNDLE_MODELS}`)
  }

  // Pre-validate all models strictly before network calls
  const availableModelIds = new Set<string>()
  const decodedModelBytes = new Map<string, Uint8Array>()

  for (let i = 0; i < bundledModels.length; i++) {
    const model = bundledModels[i]
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      throw new Error(`Bundle model [${i}] must be an object`)
    }
    if (typeof model.id !== 'string' || !MODEL_ID_REGEX.test(model.id)) {
      throw new Error(`Bundle model [${i}] has invalid id: ${String(model.id)}`)
    }
    if (availableModelIds.has(model.id)) {
      throw new Error(`Bundle contains duplicate model id: ${model.id}`)
    }
    if (typeof model.name !== 'string' || model.name.trim().length === 0 || model.name.length > 128) {
      throw new Error(`Bundle model ${model.id} has invalid name`)
    }
    if (model.format !== 'glb' && model.format !== 'gltf') {
      throw new Error(`Bundle model ${model.id} has unsupported format: ${String(model.format)}`)
    }
    if (typeof model.dataBase64 !== 'string') {
      throw new Error(`Bundle model ${model.id} missing base64 data`)
    }
    const bytes = base64ToBytes(model.dataBase64)
    validateModelBytes(bytes, model.format, model.name)
    availableModelIds.add(model.id)
    decodedModelBytes.set(model.id, bytes)
  }

  // Pre-validate all items strictly before network calls
  const validatedAdded = rawAdded.map((item, idx) => validateSceneItem(item, idx, availableModelIds))

  // ALL VALIDATION PASSED BEFORE ANY NETWORK CALL
  const idMap = new Map<string, string>()
  const uploadedIds: string[] = []

  try {
    for (let i = 0; i < bundledModels.length; i++) {
      const model = bundledModels[i]
      options.onProgress?.({
        current: i + 1,
        total: bundledModels.length,
        name: model.name,
      })
      const delay = options.throttleMs ?? (!options.uploadModel && bundledModels.length > 10 ? 6000 : 0)
      if (i > 0 && delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
      const bytes = decodedModelBytes.get(model.id) ?? base64ToBytes(model.dataBase64)
      if (options.uploadModel) {
        const created = await options.uploadModel(model.name, model.format, bytes)
        uploadedIds.push(created.id)
        idMap.set(model.id, created.id)
      } else {
        const contentType = model.format === 'gltf' ? 'model/gltf+json' : 'model/gltf-binary'
        const res = await fetch(`/api/models?name=${encodeURIComponent(model.name)}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: bytes as BodyInit,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(`Failed to upload model ${model.name}: ${err.error || res.status}`)
        }
        const data = await res.json()
        const newId = data.model?.id || data.id
        uploadedIds.push(newId)
        idMap.set(model.id, newId)
      }
    }
  } catch (err) {
    // Roll back uploaded models
    const orphanErrors: string[] = []
    for (const uploadedId of uploadedIds) {
      try {
        if (options.deleteModel) {
          await options.deleteModel(uploadedId)
        } else {
          const res = await fetch(`/api/models/${encodeURIComponent(uploadedId)}`, { method: 'DELETE' })
          if (!res.ok) {
            orphanErrors.push(uploadedId)
          }
        }
      } catch {
        orphanErrors.push(uploadedId)
      }
    }
    const origMsg = err instanceof Error ? err.message : String(err)
    if (orphanErrors.length > 0) {
      throw new Error(`${origMsg} (Rollback failed to delete orphan models: ${orphanErrors.join(', ')})`)
    }
    throw err
  }

  // Re-map items and resolve item ID collisions
  const existingAdded = existingPatch.added ?? []
  const baseItems = defaultScene(createLayout(16))
  const usedIds = new Set<string>([
    ...baseItems.map((item) => item.id),
    ...existingAdded.map((item) => item.id),
    ...Object.keys(existingPatch.overrides ?? {}),
  ])

  let nextIdCounter = 1
  const getUniqueId = (): string => {
    while (usedIds.has(`added-${nextIdCounter}`)) {
      nextIdCounter++
    }
    const id = `added-${nextIdCounter}`
    usedIds.add(id)
    return id
  }

  const importedAdded = validatedAdded.map((item) => {
    let id = item.id
    if (!id || usedIds.has(id)) {
      id = getUniqueId()
    } else {
      usedIds.add(id)
    }

    if (item.kind === 'model') {
      const remappedModelId = idMap.get(item.modelId) ?? item.modelId
      return {
        ...item,
        id,
        modelId: remappedModelId,
      } as ModelItem
    }

    return {
      ...item,
      id,
    }
  })

  return {
    version: 2,
    overrides: existingPatch.overrides ?? {},
    added: [...existingAdded, ...importedAdded],
    itemCount: importedAdded.length,
    modelCount: bundledModels.length,
    newModelIds: Array.from(idMap.values()),
  }
}
