export const MAX_MODELS = 100

export interface ModelRecord {
  id: string
  name: string
  format: 'glb' | 'gltf'
  size: number
  createdAt: string
}
