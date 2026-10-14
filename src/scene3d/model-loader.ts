import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const cache = new Map<string, Promise<THREE.Group>>()

/**
 * Loads a GLTF/GLB model from `/api/models/:id/file` with in-memory caching.
 * Resolves to the root THREE.Group of the loaded model.
 */
export function loadModel(modelId: string): Promise<THREE.Group> {
  const existing = cache.get(modelId)
  if (existing) return existing

  const promise = new Promise<THREE.Group>((resolve, reject) => {
    const loader = new GLTFLoader()
    loader.load(
      `/api/models/${encodeURIComponent(modelId)}/file`,
      (gltf) => {
        resolve(gltf.scene)
      },
      undefined,
      (err) => {
        cache.delete(modelId)
        reject(err)
      },
    )
  })

  cache.set(modelId, promise)
  return promise
}

/** Clears the in-memory model cache. Useful for tests or when models are updated. */
export function clearModelCache(): void {
  cache.clear()
}
