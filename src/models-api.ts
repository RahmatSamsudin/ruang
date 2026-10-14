import type { ModelRecord } from './scene3d/models.ts'

export async function fetchModels(): Promise<ModelRecord[]> {
  const response = await fetch('/api/models')
  if (!response.ok) {
    throw new Error(`Failed to load models: ${response.status}`)
  }
  const data = await response.json()
  return Array.isArray(data.models) ? data.models : []
}

export interface DeleteModelResult {
  ok: boolean
  status: number
  usedBy?: string[]
  error?: string
}

export async function deleteModel(id: string): Promise<DeleteModelResult> {
  const response = await fetch(`/api/models/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (response.status === 409) {
    const data = await response.json().catch(() => ({}))
    return {
      ok: false,
      status: 409,
      usedBy: Array.isArray(data.usedBy) ? data.usedBy : [],
      error: data.error || 'Model is currently in use',
    }
  }
  if (response.status === 404 || response.status === 204 || response.ok) {
    return { ok: true, status: response.status }
  }
  const err = await response.json().catch(() => ({}))
  throw new Error(err.error || `Delete failed: ${response.status}`)
}

export function formatModelSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}
