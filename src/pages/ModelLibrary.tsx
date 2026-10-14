import { useEffect, useMemo, useState } from 'react'
import type { ModelRecord } from '../scene3d/models.ts'
import { Dialog } from '../ui.tsx'

export interface ModelLibraryProps {
  onClose: () => void
  initialModels?: ModelRecord[]
  onModelsChange?: (models: ModelRecord[]) => void
}

export function ModelLibrary({ onClose, initialModels, onModelsChange }: ModelLibraryProps) {
  const [models, setModels] = useState<ModelRecord[]>(initialModels ?? [])
  const [query, setQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  useEffect(() => {
    if (initialModels) return
    let active = true
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { models: ModelRecord[] }) => {
        if (active && Array.isArray(data.models)) {
          setModels(data.models)
          onModelsChange?.(data.models)
        }
      })
      .catch((err) => {
        if (active) setError(`Failed to load models: ${err.message}`)
      })
    return () => {
      active = false
    }
  }, [initialModels, onModelsChange])

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    setError(null)
    if (file.size > 15 * 1024 * 1024) {
      setError('File exceeds 15 MB limit.')
      return
    }
    if (models.length >= 50) {
      setError('Model limit reached (max 50).')
      return
    }
    setUploading(true)
    try {
      const contentType = file.name.endsWith('.gltf') ? 'model/gltf+json' : 'model/gltf-binary'
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
        const updated = [data.model, ...models]
        setModels(updated)
        onModelsChange?.(updated)
      }
    } catch (err: unknown) {
      setError((err as Error).message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (id: string) => {
    setError(null)
    try {
      const response = await fetch(`/api/models/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (response.status === 409) {
        const data = await response.json().catch(() => ({}))
        const usedBy = Array.isArray(data.usedBy) && data.usedBy.length > 0 ? ` (used by: ${data.usedBy.join(', ')})` : ''
        setError(`Cannot delete: Model is currently in use${usedBy}`)
        setConfirmingId(null)
        return
      }
      if (!response.ok && response.status !== 204) {
        throw new Error(`Delete failed: ${response.status}`)
      }
      const updated = models.filter((m) => m.id !== id)
      setModels(updated)
      onModelsChange?.(updated)
      setConfirmingId(null)
    } catch (err: unknown) {
      setError((err as Error).message || 'Delete failed')
      setConfirmingId(null)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? models : models.filter((m) => m.name.toLowerCase().includes(q))
  }, [models, query])

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return (
    <Dialog labelledBy="model-library-title" onClose={onClose} closeLabel="Close model library" className="wide">
      <div className="model-library">
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

        {error && (
          <div className="model-library-error" role="alert">
            {error}
          </div>
        )}

        <div className="model-library-grid">
          {filtered.length === 0 ? (
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
                    <span className="model-card-size">{formatSize(model.size)}</span>
                    <span className="model-card-date">
                      {new Date(model.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="model-card-actions">
                  <a
                    href={`/api/models/${encodeURIComponent(model.id)}/file`}
                    download={model.name}
                    className="download-btn"
                    title="Download model file"
                  >
                    Download
                  </a>
                  {confirmingId === model.id ? (
                    <>
                      <button
                        type="button"
                        className="danger confirm-delete"
                        onClick={() => handleDelete(model.id)}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="cancel-delete"
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="danger delete-btn"
                      onClick={() => setConfirmingId(model.id)}
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
