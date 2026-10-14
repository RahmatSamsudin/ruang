import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatModelSize } from '../models-api.ts'
import type { ModelRecord } from '../scene3d/models.ts'
import type { SceneItem } from '../scene3d/scene.ts'
import { Dialog } from '../ui.tsx'

export interface ModelLibraryProps {
  onClose: () => void
  initialModels?: ModelRecord[]
  onModelsChange?: (models: ModelRecord[]) => void
  items?: SceneItem[]
}

export function ModelLibrary({ onClose, initialModels, onModelsChange, items }: ModelLibraryProps) {
  const [models, setModels] = useState<ModelRecord[]>(initialModels ?? [])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [blockedId, setBlockedId] = useState<string | null>(null)
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null)
  const [statusAnnouncement, setStatusAnnouncement] = useState<string>('')

  const loadModels = useCallback(() => {
    setLoading(true)
    setFetchError(null)
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { models: ModelRecord[] }) => {
        if (Array.isArray(data.models)) {
          setModels(data.models)
          onModelsChange?.(data.models)
        }
      })
      .catch((err) => {
        setFetchError(`Failed to load models: ${err.message}`)
      })
      .finally(() => {
        setLoading(false)
      })
  }, [onModelsChange])

  useEffect(() => {
    if (initialModels) {
      setModels(initialModels)
    } else {
      loadModels()
    }
  }, [initialModels, loadModels])

  const getLiveUsages = (modelId: string) => {
    if (!items) return []
    return items.filter((item) => item.kind === 'model' && (item as { modelId?: string }).modelId === modelId)
  }

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    setError(null)
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
      setError('Only .glb and .gltf files are supported.')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('File exceeds 10 MiB limit.')
      return
    }
    if (models.length >= 50) {
      setError('Model limit reached (max 50).')
      return
    }
    setUploading(true)
    try {
      const contentType = lower.endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary'
      const response = await fetch(`/api/models?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: file,
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        throw new Error(err.error || `Upload failed: ${response.status}`)
      }
      const data = await response.json()
      if (data.model) {
        setModels((prev) => {
          const updated = [data.model, ...prev.filter((m) => m.id !== data.model.id)]
          onModelsChange?.(updated)
          window.dispatchEvent(new CustomEvent('ruang:models-changed', { detail: updated }))
          return updated
        })
        setStatusAnnouncement(`Model ${data.model.name} uploaded`)
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const startDelete = (model: ModelRecord) => {
    setError(null)
    setBlockedId(null)
    setBlockedMessage(null)
    const liveUsages = getLiveUsages(model.id)
    if (liveUsages.length > 0) {
      const count = liveUsages.length
      setBlockedId(model.id)
      setBlockedMessage(`Used by ${count} item(s) in the scene. Remove them first.`)
      return
    }
    setConfirmingId(model.id)
  }

  const handleDelete = async (id: string, name: string) => {
    setError(null)
    setDeletingId(id)
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (response.status === 409) {
        const data = await response.json().catch(() => ({}))
        const usedByList = Array.isArray(data.usedBy) ? data.usedBy : []
        const count = usedByList.length || 1
        const usedBy = usedByList.length > 0 ? ` (used by: ${usedByList.join(', ')})` : ''
        setError(`Cannot delete: Model is currently in use${usedBy}`)
        setBlockedId(id)
        setBlockedMessage(`Used by ${count} item(s) in the scene. Remove them first.`)
        setConfirmingId(null)
        return
      }
      if (response.status === 404 || response.status === 204 || response.ok) {
        setModels((prev) => {
          const updated = prev.filter((m) => m.id !== id)
          onModelsChange?.(updated)
          window.dispatchEvent(new CustomEvent('ruang:models-changed', { detail: updated }))
          return updated
        })
        setConfirmingId(null)
        setStatusAnnouncement(`Model ${name} deleted`)
        return
      }
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error || `Delete failed: ${response.status}`)
    } catch (err: unknown) {
      setError((err as Error).message || 'Delete failed')
      setConfirmingId(null)
    } finally {
      setDeletingId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? models : models.filter((m) => m.name.toLowerCase().includes(q))
  }, [models, query])

  return (
    <Dialog labelledBy="model-library-title" onClose={onClose} closeLabel="Close model library" className="wide">
      <div className="model-library">
        <div className="sr-only" aria-live="polite" role="status">
          {statusAnnouncement}
        </div>

        <header className="model-library-header">
          <h2 id="model-library-title">Model Library</h2>
          <span className="model-library-count">{models.length} / 50 models</span>
        </header>

        <div className="model-library-toolbar">
          <input
            type="search"
            placeholder="Search models..."
            aria-label="Search models"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="model-upload-btn">
            <input
              type="file"
              accept=".glb,.gltf"
              style={{ display: 'none' }}
              disabled={uploading || models.length >= 50}
              onChange={handleUpload}
            />
            {uploading ? 'Uploading...' : '+ Upload Model'}
          </label>
        </div>

        {fetchError && (
          <div className="model-library-fetch-error" role="alert">
            <span>{fetchError}</span>
            <button type="button" className="model-library-retry" onClick={loadModels}>
              Retry
            </button>
          </div>
        )}

        {error && (
          <div className="model-library-error" role="alert">
            {error}
          </div>
        )}

        <div className="model-library-grid">
          {loading ? (
            <p className="model-library-loading" role="status">Loading models...</p>
          ) : filtered.length === 0 ? (
            <p className="model-library-empty">No models found.</p>
          ) : (
            filtered.map((model) => (
              <div key={model.id} className="model-library-card">
                <div className="model-card-info">
                  <div className="model-card-name" title={model.name}>
                    {model.name}
                  </div>
                  <div className="model-card-meta">
                    <span className="model-card-format">{model.format.toUpperCase()}</span>
                    <span className="model-card-size">{formatModelSize(model.size)}</span>
                    <span className="model-card-date">
                      {new Date(model.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="model-card-actions">
                  <a
                    href={`/api/models/${encodeURIComponent(model.id)}/file`}
                    download={model.name}
                    className="download-btn export-btn"
                    title="Export model file"
                    aria-label={`Export ${model.name}`}
                  >
                    Export
                  </a>
                  {confirmingId === model.id ? (
                    <div className="model-card-confirm">
                      <span className="confirm-prompt">Delete {model.name}? Cannot be undone.</span>
                      <button
                        type="button"
                        className="danger confirm-delete"
                        disabled={deletingId === model.id}
                        onClick={() => handleDelete(model.id, model.name)}
                      >
                        {deletingId === model.id ? 'Deleting...' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        className="cancel-delete"
                        disabled={deletingId === model.id}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : blockedId === model.id ? (
                    <div className="model-card-blocked" role="alert">
                      <span>{blockedMessage}</span>
                      <button
                        type="button"
                        className="cancel-delete"
                        onClick={() => {
                          setBlockedId(null)
                          setBlockedMessage(null)
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="danger delete-btn"
                      onClick={() => startDelete(model)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </Dialog>
  )
}
