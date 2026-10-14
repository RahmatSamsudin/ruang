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

export interface PropPaletteProps {
  placing: PlaceableType | null
  limitReached: boolean
  /** A type to start (or switch) placing it; null when the active entry is clicked again. */
  onPick: (type: PlaceableType | null) => void
  /** Optional models list override (for testing or external state). */
  models?: ModelRecord[]
  /** Optional upload handler callback (e.g. for testing). */
  onUpload?: (file: File) => Promise<ModelRecord>
}

/** The list of objects that can be placed, grouped, searchable and collapsible. Starts collapsed on narrow-ish screens so it does not crowd the view. */
export function PropPalette({ placing, limitReached, onPick, models: propModels, onUpload }: PropPaletteProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1000)
  const [internalModels, setInternalModels] = useState<ModelRecord[]>([])
  const models = propModels ?? internalModels
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)

  useEffect(() => {
    if (propModels) return
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

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''
    setUploadError(null)
    if (file.size > 15 * 1024 * 1024) {
      setUploadError('File exceeds 15 MB limit.')
      return
    }
    if (models.length >= 50) {
      setUploadError('Model limit reached (max 50).')
      return
    }
    setUploading(true)
    try {
      if (onUpload) {
        const record = await onUpload(file)
        setInternalModels((prev) => [record, ...prev])
        onPick(`model:${record.id}`)
      } else {
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
          setInternalModels((prev) => [data.model, ...prev])
          onPick(`model:${data.model.id}`)
        }
      }
    } catch (err: unknown) {
      setUploadError((err as Error).message || 'Upload failed')
    } finally {
      setUploading(false)
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
          <h4>Imported</h4>
          <div className="office-3d-palette-upload">
            <label className="office-3d-upload-btn">
              <input
                type="file"
                accept=".glb,.gltf"
                style={{ display: 'none' }}
                disabled={uploading || limitReached || models.length >= 50}
                onChange={handleUpload}
              />
              {uploading ? 'Uploading...' : '+ Upload Model'}
            </label>
            {uploadError && <span className="office-3d-upload-error" role="alert">{uploadError}</span>}
          </div>
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
