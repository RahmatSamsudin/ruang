import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkinEditorHandle } from './SkinEditor'
import { decodePngBytes, renderSkinFrontView } from './skin-editor-state'

export interface SkinLibraryItem {
  id: string
  name: string
  prompt?: string
  createdAt?: string
  lastUsedAt?: string
}

export interface SkinLibraryProps {
  editorRef?: React.RefObject<SkinEditorHandle | null>
  activeSkinId?: string
  refreshTrigger?: number | string
  onSelect?: (item: SkinLibraryItem, pngBytes: Uint8Array) => void
}

export function SkinThumbnailCanvas({ id, name }: { id: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      if (cancelled) return
      renderSkinFrontView(ctx, img)
    }
    img.src = `/api/skin-library/${encodeURIComponent(id)}.png`

    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <canvas
      ref={canvasRef}
      className="skin-library-canvas"
      width={32}
      height={64}
      aria-label={`${name} preview`}
    />
  )
}

export function SkinLibrary({
  editorRef,
  activeSkinId,
  refreshTrigger,
  onSelect,
}: SkinLibraryProps) {
  const [items, setItems] = useState<SkinLibraryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')

  const fetchLibrary = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/skin-library')
      if (res.status === 423) {
        let msg = 'Profile is locked. Unlock it in Settings to modify skins.'
        try {
          const data = await res.json()
          if (data.error) msg = data.error
        } catch {
          /* ignore */
        }
        setError(msg)
        return
      }
      if (!res.ok) {
        setError(`Failed to load skin library (${res.status})`)
        return
      }
      const data = (await res.json()) as SkinLibraryItem[]
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skin library')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchLibrary()
  }, [fetchLibrary, refreshTrigger])

  const handleSelectSkin = async (item: SkinLibraryItem) => {
    setError(null)
    try {
      const res = await fetch(`/api/skin-library/${encodeURIComponent(item.id)}.png`)
      if (res.status === 423) {
        let msg = 'Profile is locked. Unlock it in Settings to modify skins.'
        try {
          const data = await res.json()
          if (data.error) msg = data.error
        } catch {
          /* ignore */
        }
        setError(msg)
        return
      }
      if (!res.ok) {
        setError(`Failed to load skin (${res.status})`)
        return
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      const rgba = await decodePngBytes(buf)
      if (editorRef?.current) {
        editorRef.current.loadPixels(rgba, { undoable: true })
      }
      onSelect?.(item, buf)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load skin')
    }
  }

  const handleStartRename = (item: SkinLibraryItem) => {
    setRenamingId(item.id)
    setRenameVal(item.name)
    setError(null)
  }

  const handleRenameKeyDown = async (
    e: React.KeyboardEvent<HTMLInputElement>,
    item: SkinLibraryItem,
  ) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setRenamingId(null)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const trimmed = renameVal.trim()
      if (!trimmed || trimmed.length > 40) {
        setError('Skin name must be between 1 and 40 characters.')
        return
      }
      if (trimmed === item.name) {
        setRenamingId(null)
        return
      }

      try {
        const res = await fetch(`/api/skin-library/${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        })
        if (res.status === 423) {
          let msg = 'Profile is locked. Unlock it in Settings to modify skins.'
          try {
            const data = await res.json()
            if (data.error) msg = data.error
          } catch {
            /* ignore */
          }
          setError(msg)
          return
        }
        if (!res.ok) {
          let msg = `Failed to rename skin (${res.status})`
          try {
            const data = await res.json()
            if (data.error) msg = data.error
          } catch {
            /* ignore */
          }
          setError(msg)
          return
        }
        const updated = (await res.json()) as SkinLibraryItem
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, name: updated.name } : it)),
        )
        setRenamingId(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to rename skin')
      }
    }
  }

  const handleDelete = async (item: SkinLibraryItem) => {
    if (!window.confirm(`Delete skin "${item.name}"?`)) {
      return
    }
    try {
      const res = await fetch(`/api/skin-library/${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
      })
      if (res.status === 423) {
        let msg = 'Profile is locked. Unlock it in Settings to modify skins.'
        try {
          const data = await res.json()
          if (data.error) msg = data.error
        } catch {
          /* ignore */
        }
        setError(msg)
        return
      }
      if (!res.ok && res.status !== 404) {
        let msg = `Failed to delete skin (${res.status})`
        try {
          const data = await res.json()
          if (data.error) msg = data.error
        } catch {
          /* ignore */
        }
        setError(msg)
        return
      }
      setItems((prev) => prev.filter((it) => it.id !== item.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete skin')
    }
  }

  return (
    <section className="skin-library-section" aria-label="Skin Library">
      <div className="skin-library-header">
        <h3 className="skin-library-title">Library</h3>
        {loading && <span className="skin-library-badge">Loading…</span>}
      </div>

      {error && (
        <div className="skin-library-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="skin-library-retry-btn"
            onClick={() => void fetchLibrary()}
          >
            Retry
          </button>
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="skin-library-loading">Loading library…</div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="skin-library-empty">No skins yet. Generate or save one.</div>
      )}

      {items.length > 0 && (
        <div className="skin-library-grid">
          {items.map((item) => {
            const isActive = activeSkinId === item.id
            const isRenaming = renamingId === item.id
            const tooltip = item.prompt ? `${item.name} — ${item.prompt}` : item.name

            return (
              <div
                key={item.id}
                className={`skin-library-item${isActive ? ' active' : ''}`}
                data-id={item.id}
              >
                <button
                  type="button"
                  className="skin-library-thumbnail"
                  title={tooltip}
                  aria-label={`Load skin ${item.name}`}
                  onClick={() => void handleSelectSkin(item)}
                >
                  <SkinThumbnailCanvas id={item.id} name={item.name} />
                </button>
                <div className="skin-library-info">
                  {isRenaming ? (
                    <input
                      type="text"
                      className="skin-library-rename-input"
                      value={renameVal}
                      maxLength={40}
                      autoFocus
                      aria-label={`Rename ${item.name}`}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onKeyDown={(e) => void handleRenameKeyDown(e, item)}
                    />
                  ) : (
                    <span className="skin-library-name" title={item.name}>
                      {item.name}
                    </span>
                  )}
                  <div className="skin-library-actions">
                    <button
                      type="button"
                      className="skin-library-action-btn"
                      onClick={() => handleStartRename(item)}
                      aria-label={`Rename ${item.name}`}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="skin-library-action-btn danger"
                      onClick={() => void handleDelete(item)}
                      aria-label={`Delete ${item.name}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
