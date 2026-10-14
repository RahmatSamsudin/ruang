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

/** Clears the in-memory model cache. If modelId is provided, clears only that model. */
export function clearModelCache(modelId?: string): void {
  if (modelId) {
    cache.delete(modelId)
  } else {
    cache.clear()
  }
}

/**
 * Normalises a model group so its largest bounding box dimension is 1.5 units * scale,
 * centered on X and Z with the base (min Y) at Y = 0.
 */
export function normalizeModel(group: THREE.Group, scale = 1.0): THREE.Group {
  const clone = group.clone(true)
  const box = new THREE.Box3().setFromObject(clone)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  const maxDim = Math.max(size.x, size.y, size.z)
  const s = (maxDim > 0 ? 1.5 / maxDim : 1) * scale
  clone.scale.setScalar(s)
  clone.position.set(-center.x * s, -box.min.y * s, -center.z * s)
  return clone
}
