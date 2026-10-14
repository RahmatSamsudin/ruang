import type { ModelItem, SceneItem, ScenePatch } from './scene.ts'

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
    version: 2
    overrides: Record<string, Partial<SceneItem> | null>
    added: SceneItem[]
  }
  models: BundledModel[]
}

export const MAX_BUNDLE_SIZE_BYTES = 40 * 1024 * 1024 // 40 MiB
export const MAX_BUNDLE_MODELS = 20

/**
 * Helper to convert an ArrayBuffer / Uint8Array to base64 string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Helper to convert base64 string to Uint8Array.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const len = binary.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export interface ExportBundleOptions {
  fetchModel?: (modelId: string) => Promise<{ name: string; format: 'glb' | 'gltf'; bytes: Uint8Array } | null>
}

/**
 * Export active patch and referenced models into a RuangBundle.
 */
export async function exportBundle(
  patch: ScenePatch,
  options: ExportBundleOptions = {},
): Promise<RuangBundle> {
  const added = patch.added ?? []
  const modelIds = Array.from(
    new Set(
      added
        .filter((item): item is ModelItem => item.kind === 'model')
        .map((item) => item.modelId),
    ),
  )

  const models: BundledModel[] = []

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
        const metaRes = await fetch(`/api/models/${encodeURIComponent(modelId)}`)
        if (!metaRes.ok) continue
        const metaData = await metaRes.json()
        const modelRecord = metaData.model ?? metaData

        const fileRes = await fetch(`/api/models/${encodeURIComponent(modelId)}/file`)
        if (!fileRes.ok) continue
        const arrayBuffer = await fileRes.arrayBuffer()
        models.push({
          id: modelId,
          name: modelRecord.name || `${modelId}.glb`,
          format: modelRecord.format || 'glb',
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
      overrides: { ...patch.overrides },
      added: [...added],
    },
    models,
  }
}

export interface ImportBundleOptions {
  uploadModel?: (name: string, format: 'glb' | 'gltf', bytes: Uint8Array) => Promise<{ id: string }>
}

/**
 * Import a RuangBundle into the existing scene patch, remapping IDs to prevent collisions.
 */
export async function importBundle(
  bundleInput: RuangBundle | string,
  existingPatch: ScenePatch,
  options: ImportBundleOptions = {},
): Promise<ScenePatch> {
  let bundle: RuangBundle
  let rawJson = ''
  if (typeof bundleInput === 'string') {
    rawJson = bundleInput
    if (new Blob([bundleInput]).size > MAX_BUNDLE_SIZE_BYTES) {
      throw new Error(`Bundle exceeds maximum allowed size of 40 MiB`)
    }
    bundle = JSON.parse(bundleInput)
  } else {
    bundle = bundleInput
    rawJson = JSON.stringify(bundleInput)
    if (new Blob([rawJson]).size > MAX_BUNDLE_SIZE_BYTES) {
      throw new Error(`Bundle exceeds maximum allowed size of 40 MiB`)
    }
  }

  if (bundle.format !== 'ruang-bundle') {
    throw new Error(`Invalid bundle format: expected 'ruang-bundle', got '${bundle.format}'`)
  }
  if (bundle.version !== 1) {
    throw new Error(`Unsupported bundle version: expected 1, got ${bundle.version}`)
  }
  if (!bundle.patch || typeof bundle.patch !== 'object') {
    throw new Error(`Malformed bundle: missing patch object`)
  }

  const bundledModels = Array.isArray(bundle.models) ? bundle.models : []
  if (bundledModels.length > MAX_BUNDLE_MODELS) {
    throw new Error(`Bundle contains ${bundledModels.length} models, exceeding cap of ${MAX_BUNDLE_MODELS}`)
  }

  // Upload models sequentially and build oldId -> newId mapping
  const idMap = new Map<string, string>()

  for (const model of bundledModels) {
    const bytes = base64ToBytes(model.dataBase64)
    if (options.uploadModel) {
      const created = await options.uploadModel(model.name, model.format, bytes)
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
      idMap.set(model.id, newId)
    }
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

  const importedAdded = (bundle.patch.added ?? []).map((item) => {
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
  }
}
