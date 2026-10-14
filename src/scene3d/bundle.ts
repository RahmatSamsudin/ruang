import { PROP_TYPES, type ModelItem, type SceneItem, type ScenePatch } from './scene.ts'

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
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/
const PROP_KEY_REGEX = /^[A-Za-z]{1,24}$/
const KNOWN_PROP_TYPES = new Set<string>(PROP_TYPES)
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

const isNum = (n: unknown, min = -Infinity, max = Infinity): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max

const isPos = (n: unknown): n is number => isNum(n, 0.001, 1000)
const isUnit = (n: unknown): n is number => isNum(n, 0, 1)

const isVec2 = (v: unknown): v is Vec2 =>
  Array.isArray(v) && v.length === 2 && isNum(v[0], -1000, 1000) && isNum(v[1], -1000, 1000)

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && isNum(v[0], -1000, 1000) && isNum(v[1], -1000, 1000) && isNum(v[2], -1000, 1000)

function validateSceneItem(item: unknown, index: number, availableModelIds: Set<string>): SceneItem {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`Item [${index}] must be an object`)
  }
  const obj = item as Record<string, unknown>
  const id = obj.id
  if (typeof id !== 'string' || !ID_REGEX.test(id) || FORBIDDEN_KEYS.has(id)) {
    throw new Error(`Item [${index}] has invalid id: ${String(id)}`)
  }
  if (SEAT_ID_REGEX.test(id)) {
    throw new Error(`Item [${index}] cannot use reserved seat id: ${id}`)
  }
  const kind = obj.kind
  if (typeof kind !== 'string' || !['prop', 'floor', 'wall', 'glass', 'window', 'box', 'model'].includes(kind)) {
    throw new Error(`Item ${id} has invalid kind: ${String(kind)}`)
  }

  if (obj.level !== undefined && !isNum(obj.level, -1000, 1000)) {
    throw new Error(`Item ${id} has invalid level`)
  }
  if (obj.view !== undefined && obj.view !== 'cutaway' && obj.view !== 'shell' && obj.view !== 'both') {
    throw new Error(`Item ${id} has invalid view`)
  }

  const allowedCommonKeys = new Set(['id', 'kind', 'level', 'view'])
  const extraKeys = new Set<string>()

  if (kind === 'prop') {
    extraKeys.add('type')
    extraKeys.add('position')
    extraKeys.add('rotation')
    extraKeys.add('props')

    if (typeof obj.type !== 'string' || !KNOWN_PROP_TYPES.has(obj.type)) {
      throw new Error(`Prop ${id} has unknown or invalid type: ${String(obj.type)}`)
    }
    if (!isVec3(obj.position)) {
      throw new Error(`Prop ${id} has invalid position`)
    }
    if (obj.rotation !== undefined && !isNum(obj.rotation, -360, 360)) {
      throw new Error(`Prop ${id} has invalid rotation`)
    }
    if (obj.props !== undefined) {
      if (typeof obj.props !== 'object' || obj.props === null || Array.isArray(obj.props)) {
        throw new Error(`Prop ${id} has invalid props record`)
      }
      const p = obj.props as Record<string, unknown>
      const keys = Object.keys(p)
      if (keys.length > 16) {
        throw new Error(`Prop ${id} props record exceeds 16 keys`)
      }
      for (const k of keys) {
        if (!PROP_KEY_REGEX.test(k) || FORBIDDEN_KEYS.has(k)) {
          throw new Error(`Prop ${id} props has invalid key: ${k}`)
        }
        const val = p[k]
        const validVal =
          typeof val === 'boolean' ||
          isNum(val, -100, 100) ||
          (typeof val === 'string' && val.length <= 64)
        if (!validVal) {
          throw new Error(`Prop ${id} props has invalid value for key: ${k}`)
        }
      }
    }
  } else if (kind === 'floor') {
    extraKeys.add('min')
    extraKeys.add('max')
    extraKeys.add('y')
    extraKeys.add('surface')
    extraKeys.add('roughness')

    if (!isVec2(obj.min) || !isVec2(obj.max) || !isNum(obj.y, -1000, 1000)) {
      throw new Error(`Floor ${id} has invalid coordinates`)
    }
    if (typeof obj.surface !== 'object' || obj.surface === null || Array.isArray(obj.surface)) {
      throw new Error(`Floor ${id} has invalid surface`)
    }
    const surf = obj.surface as Record<string, unknown>
    if (typeof surf.type !== 'string' || !KNOWN_SURFACES.has(surf.type)) {
      throw new Error(`Floor ${id} has invalid surface type`)
    }
    if (!Array.isArray(surf.repeat) || surf.repeat.length !== 2 || !isPos(surf.repeat[0]) || !isPos(surf.repeat[1])) {
      throw new Error(`Floor ${id} surface has invalid repeat`)
    }
    if (surf.color !== undefined && (typeof surf.color !== 'string' || !COLOR_REGEX.test(surf.color))) {
      throw new Error(`Floor ${id} surface has invalid color`)
    }
    if (obj.roughness !== undefined && !isUnit(obj.roughness)) {
      throw new Error(`Floor ${id} has invalid roughness`)
    }
  } else if (kind === 'wall') {
    extraKeys.add('from')
    extraKeys.add('to')
    extraKeys.add('y')
    extraKeys.add('height')

    if (!isVec2(obj.from) || !isVec2(obj.to) || !isNum(obj.y, -1000, 1000) || !isPos(obj.height)) {
      throw new Error(`Wall ${id} has invalid coordinates or height`)
    }
  } else if (kind === 'glass') {
    extraKeys.add('from')
    extraKeys.add('to')
    extraKeys.add('bottom')
    extraKeys.add('top')

    if (!isVec2(obj.from) || !isVec2(obj.to) || !isNum(obj.bottom, -1000, 1000) || !isNum(obj.top, -1000, 1000)) {
      throw new Error(`Glass ${id} has invalid coordinates`)
    }
  } else if (kind === 'window') {
    extraKeys.add('position')
    extraKeys.add('rotation')
    extraKeys.add('width')

    if (!isVec3(obj.position)) {
      throw new Error(`Window ${id} has invalid position`)
    }
    if (obj.rotation !== undefined && !isNum(obj.rotation, -360, 360)) {
      throw new Error(`Window ${id} has invalid rotation`)
    }
    if (obj.width !== undefined && !isPos(obj.width)) {
      throw new Error(`Window ${id} has invalid width`)
    }
  } else if (kind === 'box') {
    extraKeys.add('position')
    extraKeys.add('size')
    extraKeys.add('color')
    extraKeys.add('radius')
    extraKeys.add('roughness')
    extraKeys.add('opacity')
    extraKeys.add('shadow')

    if (!isVec3(obj.position)) {
      throw new Error(`Box ${id} has invalid position`)
    }
    if (!Array.isArray(obj.size) || obj.size.length !== 3 || !isPos(obj.size[0]) || !isPos(obj.size[1]) || !isPos(obj.size[2])) {
      throw new Error(`Box ${id} has invalid size`)
    }
    if (typeof obj.color !== 'string' || !COLOR_REGEX.test(obj.color)) {
      throw new Error(`Box ${id} has invalid color`)
    }
    if (obj.radius !== undefined && !isNum(obj.radius, 0, 100)) {
      throw new Error(`Box ${id} has invalid radius`)
    }
    if (obj.roughness !== undefined && !isUnit(obj.roughness)) {
      throw new Error(`Box ${id} has invalid roughness`)
    }
    if (obj.opacity !== undefined && !isUnit(obj.opacity)) {
      throw new Error(`Box ${id} has invalid opacity`)
    }
    if (obj.shadow !== undefined && typeof obj.shadow !== 'boolean') {
      throw new Error(`Box ${id} has invalid shadow`)
    }
  } else if (kind === 'model') {
    extraKeys.add('modelId')
    extraKeys.add('position')
    extraKeys.add('rotation')
    extraKeys.add('scale')

    if (typeof obj.modelId !== 'string' || !MODEL_ID_REGEX.test(obj.modelId)) {
      throw new Error(`Model item ${id} has invalid modelId: ${String(obj.modelId)}`)
    }
    if (!availableModelIds.has(obj.modelId)) {
      throw new Error(`Model item ${id} references modelId ${obj.modelId} not found in bundle models`)
    }
    if (obj.position !== undefined && !isVec3(obj.position)) {
      throw new Error(`Model item ${id} has invalid position`)
    }
    if (obj.rotation !== undefined && !isNum(obj.rotation, -360, 360)) {
      throw new Error(`Model item ${id} has invalid rotation`)
    }
    if (obj.scale !== undefined && (!isPos(obj.scale) || obj.scale > 100)) {
      throw new Error(`Model item ${id} has invalid scale`)
    }
  }

  for (const key of Object.keys(obj)) {
    if (!allowedCommonKeys.has(key) && !extraKeys.has(key)) {
      throw new Error(`Item ${id} contains forbidden or unexpected field "${key}"`)
    }
  }

  return obj as unknown as SceneItem
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
  ).slice(0, MAX_BUNDLE_MODELS)

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
      if (result) {
        models.push({
          id: modelId,
          name: result.name,
          format: result.format,
          dataBase64: bytesToBase64(result.bytes),
        })
      }
    } else {
      try {
        const fileRes = await fetch(`/api/models/${encodeURIComponent(modelId)}/file`)
        if (!fileRes.ok) continue
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
      } catch {
        // Skip model if fetch failed
      }
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
      items: [...added],
    },
    models,
  }
}

export interface ImportBundleOptions {
  uploadModel?: (name: string, format: 'glb' | 'gltf', bytes: Uint8Array) => Promise<{ id: string }>
  deleteModel?: (id: string) => Promise<void>
  onProgress?: (progress: { current: number; total: number; name: string }) => void
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
    for (const uploadedId of uploadedIds) {
      try {
        if (options.deleteModel) {
          await options.deleteModel(uploadedId)
        } else {
          await fetch(`/api/models/${encodeURIComponent(uploadedId)}`, { method: 'DELETE' })
        }
      } catch {
        // ignore rollback errors
      }
    }
    throw err
  }

  // Re-map items and resolve item ID collisions
  const existingAdded = existingPatch.added ?? []
  const usedIds = new Set<string>([
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

  const mergedOverrides = {
    ...(existingPatch.overrides ?? {}),
    ...(bundle.patch.overrides ?? {}),
  }

  return {
    version: 2,
    overrides: mergedOverrides,
    added: [...existingAdded, ...importedAdded],
    itemCount: importedAdded.length,
    modelCount: bundledModels.length,
    newModelIds: Array.from(idMap.values()),
  }
}
