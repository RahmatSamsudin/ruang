import * as THREE from 'three'

export interface ExportGlbOptions {
  binary?: boolean
  filename?: string
  onlyVisible?: boolean
}

/**
 * Filter out helper and editor objects from scene before export.
 */
export function prepareSceneForExport(scene: THREE.Object3D): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'OfficeScene'

  const isExcluded = (obj: THREE.Object3D): boolean => {
    if (obj.userData?.noExport === true) return true
    if (
      obj.name.startsWith('editor-') ||
      obj.name === 'TransformGizmo' ||
      obj.name === 'edit-layer' ||
      obj.name === 'ghost' ||
      obj.name.toLowerCase().includes('gizmo') ||
      obj.type.includes('Helper')
    ) {
      return true
    }
    return false
  }

  scene.children.forEach((child) => {
    if (isExcluded(child)) {
      return
    }
    try {
      const cloned = child.clone(true)
      const toRemove: THREE.Object3D[] = []
      cloned.traverse((descendant) => {
        if (descendant !== cloned && isExcluded(descendant)) {
          toRemove.push(descendant)
        }
      })
      toRemove.forEach((node) => {
        node.parent?.remove(node)
      })
      root.add(cloned)
    } catch {
      // If cloning fails on an object, skip
    }
  })

  return root
}

/**
 * Format GLB filename matching DECISIONS: ruang-scene-<yyyymmdd-hhmm>.glb
 */
export function formatSceneGlbFilename(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const yyyy = date.getFullYear()
  const mm = pad(date.getMonth() + 1)
  const dd = pad(date.getDate())
  const hh = pad(date.getHours())
  const min = pad(date.getMinutes())
  return `ruang-scene-${yyyy}${mm}${dd}-${hh}${min}.glb`
}

/**
 * Export a Three.js scene/group as a GLB or glTF Blob.
 */
export async function exportSceneGlb(
  scene: THREE.Object3D,
  options: ExportGlbOptions = {},
): Promise<Blob> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js')
  const exporter = new GLTFExporter()

  const exportRoot = prepareSceneForExport(scene)
  const binary = options.binary ?? true

  return new Promise<Blob>((resolve, reject) => {
    exporter.parse(
      exportRoot,
      (gltf) => {
        try {
          if (gltf instanceof ArrayBuffer) {
            resolve(new Blob([gltf], { type: 'model/gltf-binary' }))
          } else {
            const json = JSON.stringify(gltf, null, 2)
            resolve(new Blob([json], { type: 'model/gltf+json' }))
          }
        } catch (err) {
          reject(err)
        }
      },
      (error) => {
        reject(error instanceof Error ? error : new Error(String(error)))
      },
      {
        binary,
        onlyVisible: options.onlyVisible ?? true,
      },
    )
  })
}

/**
 * Trigger browser file download for a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
