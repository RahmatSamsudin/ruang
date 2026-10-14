import { useEffect, useMemo, useState } from 'react'
import type { ModelRecord } from '../scene3d/models.ts'
import { GROUPS, PROP_CATALOG } from '../scene3d/prop-catalog.ts'
import { MAX_ADDED, PROP_TYPES, type PlaceableType, type PropType, type StructureType } from '../scene3d/scene.ts'

interface StructureTool {
  type: StructureType
  label: string
  note: string
}

const STRUCTURE_TOOLS: StructureTool[] = [
  { type: 'floor', label: 'Floor slab', note: 'Place a 4×4m floor slab' },
  { type: 'wall', label: 'Wall segment', note: 'Place a 4m wall segment' },
  { type: 'glass', label: 'Glass divider', note: 'Place a 3m glass divider' },
  { type: 'box', label: 'Box shape', note: 'Place a 1×1×1m box primitive' },
]

const MAX_MODEL_BYTES = 10 * 1024 * 1024

export interface PropPaletteProps {
  placing: PlaceableType | null
  limitReached: boolean
  /** A type to start (or switch) placing it; null when the active entry is clicked again. */
  onPick: (type: PlaceableType | null) => void
  /** Optional models list override (for testing or external state). */
  models?: ModelRecord[]
  /** Optional upload handler callback (e.g. for testing). */
  onUpload?: (file: File) => Promise<ModelRecord>
  /** Optional callback when model library opens or manages models. */
  onManageModels?: () => void
  /** Optional callback when models list is updated. */
  onModelsChange?: (models: ModelRecord[]) => void
}

/** The list of objects that can be placed, grouped, searchable and collapsible. Starts collapsed on narrow-ish screens so it does not crowd the view. */
export function PropPalette({ placing, limitReached, onPick, models: propModels, onUpload, onManageModels, onModelsChange }: PropPaletteProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1000)
  const [internalModels, setInternalModels] = useState<ModelRecord[]>(propModels ?? [])
  const models = internalModels
  const [uploading, setUploading] = useState(false)
  const [uploadingName, setUploadingName] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (propModels) {
      setInternalModels(propModels)
      return
    }
    let active = true
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: { models: ModelRecord[] }) => {
        if (active && Array.isArray(data.models)) setInternalModels(data.models)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [propModels])

  useEffect(() => {
    const handleModelsChanged = (e: Event) => {
      const custom = e as CustomEvent<ModelRecord[]>
      if (Array.isArray(custom.detail)) {
        setInternalModels(custom.detail)
      } else {
        fetch('/api/models')
          .then((res) => (res.ok ? res.json() : Promise.reject()))
          .then((data: { models: ModelRecord[] }) => {
            if (Array.isArray(data.models)) setInternalModels(data.models)
          })
          .catch(() => {})
      }
    }
    window.addEventListener('ruang:models-changed', handleModelsChanged)
    return () => {
      window.removeEventListener('ruang:models-changed', handleModelsChanged)
    }
  }, [])

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    setUploadError(null)
    setUploadSuccess(null)
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
      setUploadError('Only .glb and .gltf files are supported.')
      return
    }
    if (file.size > MAX_MODEL_BYTES) {
      setUploadError('File exceeds 10 MiB limit.')
      return
    }
    if (models.length >= 50) {
      setUploadError('Model limit reached (max 50).')
      return
    }
    setUploading(true)
    setUploadingName(file.name)
    try {
      if (onUpload) {
        const record = await onUpload(file)
        setInternalModels((prev) => [record, ...prev.filter((m) => m.id !== record.id)])
        setUploadSuccess(`Imported ${record.name}`)
        onPick(`model:${record.id}`)
      } else {
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
          try {
            const listRes = await fetch('/api/models')
            if (listRes.ok) {
              const listData = await listRes.json()
              if (Array.isArray(listData.models)) {
                setInternalModels(listData.models)
                onModelsChange?.(listData.models)
                window.dispatchEvent(new CustomEvent('ruang:models-changed', { detail: listData.models }))
              } else {
                const next = [data.model, ...models.filter((m) => m.id !== data.model.id)]
                setInternalModels(next)
                onModelsChange?.(next)
                window.dispatchEvent(new CustomEvent('ruang:models-changed', { detail: next }))
              }
            } else {
              const next = [data.model, ...models.filter((m) => m.id !== data.model.id)]
              setInternalModels(next)
              onModelsChange?.(next)
              window.dispatchEvent(new CustomEvent('ruang:models-changed', { detail: next }))
            }
          } catch {
            const next = [data.model, ...models.filter((m) => m.id !== data.model.id)]
            setInternalModels(next)
            onModelsChange?.(next)
            window.dispatchEvent(new CustomEvent('ruang:models-changed', { detail: next }))
          }
          setUploadSuccess(`Imported ${data.model.name}`)
          onPick(`model:${data.model.id}`)
        }
      }
    } catch (err: unknown) {
      setUploadError((err as Error).message || 'Upload failed')
    } finally {
      setUploading(false)
      setUploadingName(null)
    }
  }

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (type: PropType) => needle === '' || PROP_CATALOG[type].label.toLowerCase().includes(needle) || type.toLowerCase().includes(needle)
    return GROUPS.map((group) => ({
      group,
      types: PROP_TYPES.filter((type) => PROP_CATALOG[type].group === group && matches(type)).sort((a, b) => PROP_CATALOG[a].label.localeCompare(PROP_CATALOG[b].label)),
    })).filter((section) => section.types.length > 0)
  }, [query])

  const filteredModels = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === '' ? models : models.filter((m) => m.name.toLowerCase().includes(needle))
  }, [models, query])

  const showImported = query.trim() === '' || filteredModels.length > 0

  return <aside className="office-3d-palette" aria-label="Object palette">
    <button type="button" className="office-3d-palette-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '▾' : '▸'} Objects</button>
    {open && <>
      <div className="office-3d-palette-structures" role="toolbar" aria-label="Structure primitives">
        {STRUCTURE_TOOLS.map(({ type, label, note }) => (
          <button
            type="button"
            key={type}
            aria-pressed={placing === type}
            disabled={limitReached && placing !== type}
            title={note}
            onClick={() => onPick(placing === type ? null : type)}
          >
            {label}
          </button>
        ))}
      </div>
      <input type="search" placeholder="Search objects" aria-label="Search objects" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        if (query) setQuery('')
        else { onPick(null); event.currentTarget.blur() }
      }}/>
      <p role="status" className="office-3d-palette-note">{limitReached ? `Limit reached (${MAX_ADDED} added objects)` : 'Click the floor to place, Esc to stop.'}</p>
      <div className="office-3d-palette-list">
        {sections.map(({ group, types }) => <section key={group}>
          <h4>{group}</h4>
          {types.map((type) => <button type="button" key={type} aria-pressed={placing === type} disabled={limitReached && placing !== type} title={PROP_CATALOG[type].note ?? ''} onClick={() => onPick(placing === type ? null : type)}>{PROP_CATALOG[type].label}</button>)}
        </section>)}
        {showImported && <section key="Imported" className="office-3d-palette-imported">
          <div className="office-3d-palette-imported-header">
            <h4>Imported</h4>
            {onManageModels && (
              <button
                type="button"
                className="office-3d-palette-manage-btn"
                onClick={onManageModels}
                title="Manage imported models"
              >
                Manage
              </button>
            )}
          </div>
          <div className="office-3d-palette-upload">
            <label
              htmlFor="office-3d-model-input"
              className={`office-3d-upload-btn${uploading || limitReached || models.length >= 50 ? ' disabled' : ''}`}
              tabIndex={uploading || limitReached || models.length >= 50 ? -1 : 0}
              role="button"
              aria-disabled={uploading || limitReached || models.length >= 50}
              onKeyDown={(event) => {
                if (uploading || limitReached || models.length >= 50) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  document.getElementById('office-3d-model-input')?.click()
                }
              }}
            >
              <input
                id="office-3d-model-input"
                type="file"
                accept=".glb,.gltf"
                className="office-3d-file-input-hidden"
                aria-label="Upload 3D model (.glb, .gltf)"
                disabled={uploading || limitReached || models.length >= 50}
                onChange={handleUpload}
              />
              {uploading ? `Uploading ${uploadingName ?? ''}...` : '+ Upload Model'}
            </label>
            <div className="office-3d-palette-status" aria-live="polite">
              {uploadError && <span className="office-3d-upload-error" role="alert">{uploadError}</span>}
              {uploadSuccess && <span className="office-3d-upload-success">{uploadSuccess}</span>}
            </div>
          </div>
          {models.length === 0 && <p className="office-3d-palette-empty">No imported models yet</p>}
          {models.length > 0 && filteredModels.length === 0 && <p className="office-3d-palette-empty">No models matching &ldquo;{query}&rdquo;</p>}
          {filteredModels.map((m) => {
            const active = placing === `model:${m.id}`
            return (
              <button
                type="button"
                key={m.id}
                aria-pressed={active}
                disabled={limitReached && !active}
                title={`${m.name} (${(m.size / 1024).toFixed(1)} KB)`}
                onClick={() => onPick(active ? null : `model:${m.id}`)}
              >
                {m.name}
              </button>
            )
          })}
        </section>}
      </div>
    </>}
  </aside>
}
