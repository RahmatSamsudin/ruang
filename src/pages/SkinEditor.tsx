import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { agentLook } from '../agents'
import {
  SKIN_WIDTH,
  SKIN_HEIGHT,
  paintDefaultSkin,
  encodeRgbaToPng,
} from '../scene3d/skin'
import {
  SKIN_SIZE,
  BUFFER_LENGTH,
  DEFAULT_SWATCHES,
  UndoHistory,
  floodFill,
  clearPart,
  drawLine,
  setPixel,
  getPixel,
  hexToRgba,
  rgbaToHex,
  addRecentSwatch,
  validateSkinPng,
  decodePngBytes,
  arePixelBuffersEqual,
  type RgbaColor,
  type SkinTool,
  type ClearablePart,
} from './skin-editor-state'

export interface SkinEditorHandle {
  loadPixels: (rgba: Uint8ClampedArray | Uint8Array, options?: { undoable?: boolean }) => void
  getPixels: () => Uint8ClampedArray
  getPng: () => Uint8Array
  isDirty: () => boolean
}

export interface SkinEditorProps {
  id: string
  initialPng?: Uint8Array | null
  initialPixels?: Uint8ClampedArray | null
  initialDirty?: boolean
  onSave: (png: Uint8Array) => void | Promise<void>
  onReset: () => void | Promise<void>
  onDirtyChange?: (isDirty: boolean) => void
  children?: React.ReactNode
}

interface Coord {
  x: number
  y: number
}

function getPartLabelAt(x: number, y: number): string {
  if (x >= 0 && x < 64 && y >= 0 && y < 16) {
    return x < 32 ? 'Head (Base)' : 'Head (Hat Overlay)'
  }
  if (x >= 16 && x < 40 && y >= 16 && y < 32) return 'Body (Base)'
  if (x >= 16 && x < 40 && y >= 32 && y < 48) return 'Body (Jacket Overlay)'
  if (x >= 40 && x < 56 && y >= 16 && y < 32) return 'Right Arm (Base)'
  if (x >= 40 && x < 56 && y >= 32 && y < 48) return 'Right Arm (Sleeve Overlay)'
  if (x >= 0 && x < 16 && y >= 16 && y < 32) return 'Right Leg (Base)'
  if (x >= 0 && x < 16 && y >= 32 && y < 48) return 'Right Leg (Pants Overlay)'
  if (x >= 32 && x < 48 && y >= 48 && y < 64) return 'Left Arm (Base)'
  if (x >= 48 && x < 64 && y >= 48 && y < 64) return 'Left Arm (Sleeve Overlay)'
  if (x >= 16 && x < 32 && y >= 48 && y < 64) return 'Left Leg (Base)'
  if (x >= 0 && x < 16 && y >= 48 && y < 64) return 'Left Leg (Pants Overlay)'
  return 'Unused'
}

export const SkinEditor = forwardRef<SkinEditorHandle, SkinEditorProps>(function SkinEditor(
  {
    id,
    initialPng,
    initialPixels,
    initialDirty,
    onSave,
    onReset,
    onDirtyChange,
    children,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pixel buffers
  const pixelsRef = useRef<Uint8ClampedArray>(new Uint8ClampedArray(BUFFER_LENGTH))
  const savedSnapshotRef = useRef<Uint8ClampedArray>(new Uint8ClampedArray(BUFFER_LENGTH))
  const historyRef = useRef<UndoHistory>(new UndoHistory(pixelsRef.current, 60))

  // State
  const [tool, setTool] = useState<SkinTool>('pencil')
  const [currentColor, setCurrentColor] = useState<string>('#000000')
  const [recentSwatches, setRecentSwatches] = useState<string[]>(DEFAULT_SWATCHES)
  const [showGrid, setShowGrid] = useState<boolean>(true)
  const [showOutlines, setShowOutlines] = useState<boolean>(true)
  const [isDirty, setIsDirty] = useState<boolean>(false)
  const [canUndo, setCanUndo] = useState<boolean>(false)
  const [canRedo, setCanRedo] = useState<boolean>(false)
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [hoverCoord, setHoverCoord] = useState<Coord | null>(null)

  // Drawing stroke ref
  const isDrawingRef = useRef<boolean>(false)
  const strokeSnapshotRef = useRef<Uint8ClampedArray | null>(null)
  const strokeModifiedRef = useRef<boolean>(false)
  const lastCoordRef = useRef<Coord | null>(null)

  // Redraw canvas from pixel buffer
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    try {
      const imgData =
        typeof ImageData !== 'undefined'
          ? new ImageData(new Uint8ClampedArray(pixelsRef.current), SKIN_SIZE, SKIN_SIZE)
          : ctx.createImageData
            ? ctx.createImageData(SKIN_SIZE, SKIN_SIZE)
            : null
      if (imgData) {
        if (typeof ImageData === 'undefined' && imgData.data) {
          imgData.data.set(pixelsRef.current)
        }
        ctx.putImageData(imgData, 0, 0)
      }
    } catch {
      // Safe fallback if canvas context is a mock or non-standard environment
    }
  }, [])

  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange

  const updateDirtyAndHistoryState = useCallback(() => {
    const dirty = !arePixelBuffersEqual(pixelsRef.current, savedSnapshotRef.current)
    setIsDirty(dirty)
    onDirtyChangeRef.current?.(dirty)
    setCanUndo(historyRef.current.canUndo())
    setCanRedo(historyRef.current.canRedo())
  }, [])

  // Initial load
  useEffect(() => {
    let cancelled = false

    const loadInitial = async () => {
      let buffer: Uint8ClampedArray
      if (initialPixels) {
        buffer = new Uint8ClampedArray(initialPixels)
      } else if (initialPng && initialPng.length > 0) {
        try {
          buffer = await decodePngBytes(initialPng)
        } catch {
          buffer = paintDefaultSkin(agentLook(id))
        }
      } else {
        buffer = paintDefaultSkin(agentLook(id))
      }

      if (cancelled) return
      pixelsRef.current = new Uint8ClampedArray(buffer)
      if (initialDirty) {
        if (initialPng && initialPng.length > 0) {
          try {
            savedSnapshotRef.current = await decodePngBytes(initialPng)
          } catch {
            savedSnapshotRef.current = paintDefaultSkin(agentLook(id))
          }
        } else {
          savedSnapshotRef.current = paintDefaultSkin(agentLook(id))
        }
      } else {
        savedSnapshotRef.current = new Uint8ClampedArray(buffer)
      }
      historyRef.current.reset(buffer)
      renderCanvas()
      setCanUndo(false)
      setCanRedo(false)
      const dirty = Boolean(initialDirty)
      setIsDirty(dirty)
      onDirtyChangeRef.current?.(dirty)
      setImportError(null)
      setSaveError(null)
    }

    void loadInitial()
    return () => {
      cancelled = true
    }
  }, [id, initialPng, initialPixels, initialDirty, renderCanvas])

  const getEncodedPng = useCallback(() => {
    if (canvasRef.current && typeof canvasRef.current.toDataURL === 'function') {
      try {
        const dataUrl = canvasRef.current.toDataURL('image/png')
        const b64 = dataUrl.split(',')[1]
        if (b64) {
          const bin = atob(b64)
          const u8 = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
          return u8
        }
      } catch {
        // fallback
      }
    }
    return encodeRgbaToPng(SKIN_WIDTH, SKIN_HEIGHT, pixelsRef.current)
  }, [])

  // Imperative handle for C5 / external controllers
  useImperativeHandle(
    ref,
    () => ({
      loadPixels(rgba: Uint8ClampedArray | Uint8Array, options?: { undoable?: boolean }) {
        const target = new Uint8ClampedArray(BUFFER_LENGTH)
        target.set(rgba.subarray(0, BUFFER_LENGTH))
        if (options?.undoable !== false) {
          historyRef.current.push(target)
        } else {
          historyRef.current.reset(target)
          savedSnapshotRef.current = new Uint8ClampedArray(target)
        }
        pixelsRef.current = target
        renderCanvas()
        updateDirtyAndHistoryState()
      },
      getPixels() {
        return new Uint8ClampedArray(pixelsRef.current)
      },
      getPng: getEncodedPng,
      isDirty() {
        return !arePixelBuffersEqual(pixelsRef.current, savedSnapshotRef.current)
      },
    }),
    [getEncodedPng, renderCanvas, updateDirtyAndHistoryState],
  )

  const handleColorChange = (hex: string) => {
    setCurrentColor(hex)
    setRecentSwatches((prev) => addRecentSwatch(prev, hex))
  }

  const handleUndo = useCallback(() => {
    const prev = historyRef.current.undo()
    if (prev) {
      pixelsRef.current = prev
      renderCanvas()
      updateDirtyAndHistoryState()
    }
  }, [renderCanvas, updateDirtyAndHistoryState])

  const handleRedo = useCallback(() => {
    const next = historyRef.current.redo()
    if (next) {
      pixelsRef.current = next
      renderCanvas()
      updateDirtyAndHistoryState()
    }
  }, [renderCanvas, updateDirtyAndHistoryState])

  // Keyboard shortcuts (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Tools)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          handleRedo()
        } else {
          handleUndo()
        }
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        handleRedo()
        return
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'p' || e.key === 'P') setTool('pencil')
        if (e.key === 'e' || e.key === 'E') setTool('eraser')
        if (e.key === 'b' || e.key === 'B') setTool('bucket')
        if (e.key === 'i' || e.key === 'I') setTool('eyedropper')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

  // Coordinate mapping from mouse/touch event to 64x64 pixel space
  const getCanvasCoord = (e: React.PointerEvent<HTMLCanvasElement>): Coord | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * SKIN_SIZE)
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * SKIN_SIZE)
    if (x < 0 || x >= SKIN_SIZE || y < 0 || y >= SKIN_SIZE) return null
    return { x, y }
  }

  // Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const coord = getCanvasCoord(e)
    if (!coord) return
    if (typeof e.currentTarget.setPointerCapture === 'function') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // Safe fallback in test or restricted environments
      }
    }

    if (tool === 'eyedropper') {
      const pixel = getPixel(pixelsRef.current, coord.x, coord.y)
      if (pixel[3] > 0) {
        const hex = rgbaToHex(pixel[0], pixel[1], pixel[2])
        handleColorChange(hex)
      }
      return
    }

    if (tool === 'bucket') {
      const colorToFill: RgbaColor = hexToRgba(currentColor, 255)
      const clone = new Uint8ClampedArray(pixelsRef.current)
      const changed = floodFill(clone, coord.x, coord.y, colorToFill)
      if (changed) {
        historyRef.current.push(clone)
        pixelsRef.current = clone
        renderCanvas()
        updateDirtyAndHistoryState()
        setRecentSwatches((prev) => addRecentSwatch(prev, currentColor))
      }
      return
    }

    // Pencil or Eraser: start a continuous stroke
    isDrawingRef.current = true
    strokeSnapshotRef.current = new Uint8ClampedArray(pixelsRef.current)
    strokeModifiedRef.current = false
    lastCoordRef.current = coord

    const paintColor: RgbaColor = tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(currentColor, 255)
    setPixel(pixelsRef.current, coord.x, coord.y, paintColor)
    strokeModifiedRef.current = true
    renderCanvas()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const coord = getCanvasCoord(e)
    setHoverCoord(coord)

    if (!isDrawingRef.current || !coord || !lastCoordRef.current) return

    const paintColor: RgbaColor = tool === 'eraser' ? [0, 0, 0, 0] : hexToRgba(currentColor, 255)
    drawLine(pixelsRef.current, lastCoordRef.current.x, lastCoordRef.current.y, coord.x, coord.y, paintColor)
    strokeModifiedRef.current = true
    lastCoordRef.current = coord
    renderCanvas()
  }

  const endStroke = () => {
    if (!isDrawingRef.current) return
    isDrawingRef.current = false
    if (strokeModifiedRef.current && strokeSnapshotRef.current) {
      // Stroke is recorded as exactly ONE undo step
      historyRef.current.push(pixelsRef.current)
      updateDirtyAndHistoryState()
      if (tool === 'pencil') {
        setRecentSwatches((prev) => addRecentSwatch(prev, currentColor))
      }
    }
    strokeSnapshotRef.current = null
    strokeModifiedRef.current = false
    lastCoordRef.current = null
  }

  const handlePointerUp = () => {
    endStroke()
  }

  const handlePointerCancel = () => {
    endStroke()
  }

  const handlePointerLeave = () => {
    setHoverCoord(null)
    if (isDrawingRef.current) {
      endStroke()
    }
  }

  const handleClearPart = (part: ClearablePart) => {
    const clone = new Uint8ClampedArray(pixelsRef.current)
    const modified = clearPart(clone, part)
    if (modified) {
      historyRef.current.push(clone)
      pixelsRef.current = clone
      renderCanvas()
      updateDirtyAndHistoryState()
    }
  }

  const handleResetToDefault = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      await onReset()
      const defaultData = paintDefaultSkin(agentLook(id))
      historyRef.current.push(defaultData)
      pixelsRef.current = defaultData
      savedSnapshotRef.current = new Uint8ClampedArray(defaultData)
      renderCanvas()
      updateDirtyAndHistoryState()
      setImportError(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to reset skin')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSave = async () => {
    const png = getEncodedPng()
    setIsSaving(true)
    setSaveError(null)
    try {
      await onSave(png)
      savedSnapshotRef.current = new Uint8ClampedArray(pixelsRef.current)
      updateDirtyAndHistoryState()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save skin')
    } finally {
      setIsSaving(false)
    }
  }

  const handleExport = () => {
    const png = getEncodedPng()
    const blob = new Blob([png as unknown as BlobPart], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${id}-skin.png`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const buffer = await file.arrayBuffer()
      const bytes = new Uint8Array(buffer)
      const validation = validateSkinPng(bytes)
      if (!validation.valid) {
        setImportError(validation.error ?? 'Invalid skin PNG (must be 64x64)')
        return
      }

      const decoded = await decodePngBytes(bytes)
      historyRef.current.push(decoded)
      pixelsRef.current = decoded
      renderCanvas()
      updateDirtyAndHistoryState()
      setImportError(null)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import skin image')
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <div className="skin-editor">
      <div className="skin-editor-header">
        <div className="skin-editor-title-row">
          <div className="skin-editor-agent">
            <span className="skin-editor-agent-label">AGENT SKIN</span>
            <strong className="skin-editor-agent-id">{id}</strong>
            {isDirty && <span className="badge amber">Unsaved</span>}
          </div>
          <div className="skin-editor-actions">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png"
              style={{ display: 'none' }}
              onChange={handleFileImport}
              data-testid="skin-file-input"
            />
            <button
              type="button"
              className="refresh-button"
              onClick={() => fileInputRef.current?.click()}
              title="Import 64x64 PNG image"
            >
              Import PNG
            </button>
            <button
              type="button"
              className="refresh-button"
              onClick={handleExport}
              title="Export 64x64 PNG image"
            >
              Export PNG
            </button>
            <button
              type="button"
              className="refresh-button"
              onClick={handleResetToDefault}
              disabled={isSaving}
              title="Reset skin to default appearance derived from agent id"
            >
              Reset to default
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={handleSave}
              disabled={isSaving}
              title="Save skin changes"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {(importError || saveError) && (
          <div className="skin-import-error" role="alert">
            <span>⚠ {importError || saveError}</span>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                setImportError(null)
                setSaveError(null)
              }}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="skin-editor-main">
        {/* Left: 64x64 Pixel Canvas with Checkerboard, Outlines & Grid */}
        <div className="skin-canvas-container">
          <div className="skin-canvas-wrapper">
            <canvas
              ref={canvasRef}
              width={SKIN_SIZE}
              height={SKIN_SIZE}
              className="skin-canvas"
              style={{ touchAction: 'none' }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              onPointerLeave={handlePointerLeave}
              data-testid="skin-pixel-canvas"
            />

            {/* Crisp SVG overlay for Grid and Body Part Outlines */}
            <svg
              className="skin-canvas-svg"
              viewBox="0 0 64 64"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {showGrid && (
                <defs>
                  <pattern id="skin-grid-pattern" width="1" height="1" patternUnits="userSpaceOnUse">
                    <path
                      d="M 1 0 L 0 0 0 1"
                      fill="none"
                      stroke="rgba(255, 255, 255, 0.14)"
                      strokeWidth="0.06"
                    />
                  </pattern>
                </defs>
              )}
              {showGrid && <rect width="64" height="64" fill="url(#skin-grid-pattern)" />}

              {showOutlines && (
                <g className="skin-outlines-group">
                  {/* Head Base */}
                  <rect x="0" y="0" width="32" height="16" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.2" />
                  <text x="1" y="3" fill="rgba(255, 255, 255, 0.45)" fontSize="2" fontFamily="monospace">HEAD</text>

                  {/* Head Overlay (Hat) */}
                  <rect x="32" y="0" width="32" height="16" fill="none" stroke="rgba(244, 211, 94, 0.4)" strokeWidth="0.2" strokeDasharray="0.8 0.4" />
                  <text x="33" y="3" fill="rgba(244, 211, 94, 0.55)" fontSize="2" fontFamily="monospace">HAT</text>

                  {/* Body Base */}
                  <rect x="16" y="16" width="24" height="16" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.2" />
                  <text x="17" y="19" fill="rgba(255, 255, 255, 0.45)" fontSize="2" fontFamily="monospace">BODY</text>

                  {/* Body Overlay (Jacket) */}
                  <rect x="16" y="32" width="24" height="16" fill="none" stroke="rgba(244, 211, 94, 0.4)" strokeWidth="0.2" strokeDasharray="0.8 0.4" />
                  <text x="17" y="35" fill="rgba(244, 211, 94, 0.55)" fontSize="2" fontFamily="monospace">JACKET</text>

                  {/* Right Arm Base */}
                  <rect x="40" y="16" width="16" height="16" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.2" />
                  <text x="41" y="19" fill="rgba(255, 255, 255, 0.45)" fontSize="2" fontFamily="monospace">R.ARM</text>

                  {/* Right Arm Overlay (Sleeve) */}
                  <rect x="40" y="32" width="16" height="16" fill="none" stroke="rgba(244, 211, 94, 0.4)" strokeWidth="0.2" strokeDasharray="0.8 0.4" />
                  <text x="41" y="35" fill="rgba(244, 211, 94, 0.55)" fontSize="2" fontFamily="monospace">R.SLEEVE</text>

                  {/* Right Leg Base */}
                  <rect x="0" y="16" width="16" height="16" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.2" />
                  <text x="1" y="19" fill="rgba(255, 255, 255, 0.45)" fontSize="2" fontFamily="monospace">R.LEG</text>

                  {/* Right Leg Overlay (Pants) */}
                  <rect x="0" y="32" width="16" height="16" fill="none" stroke="rgba(244, 211, 94, 0.4)" strokeWidth="0.2" strokeDasharray="0.8 0.4" />
                  <text x="1" y="35" fill="rgba(244, 211, 94, 0.55)" fontSize="2" fontFamily="monospace">R.PANTS</text>

                  {/* Left Leg Base */}
                  <rect x="16" y="48" width="16" height="16" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.2" />
                  <text x="17" y="51" fill="rgba(255, 255, 255, 0.45)" fontSize="2" fontFamily="monospace">L.LEG</text>

                  {/* Left Leg Overlay (Pants) */}
                  <rect x="0" y="48" width="16" height="16" fill="none" stroke="rgba(244, 211, 94, 0.4)" strokeWidth="0.2" strokeDasharray="0.8 0.4" />
                  <text x="1" y="51" fill="rgba(244, 211, 94, 0.55)" fontSize="2" fontFamily="monospace">L.PANTS</text>

                  {/* Left Arm Base */}
                  <rect x="32" y="48" width="16" height="16" fill="none" stroke="rgba(255, 255, 255, 0.3)" strokeWidth="0.2" />
                  <text x="33" y="51" fill="rgba(255, 255, 255, 0.45)" fontSize="2" fontFamily="monospace">L.ARM</text>

                  {/* Left Arm Overlay (Sleeve) */}
                  <rect x="48" y="48" width="16" height="16" fill="none" stroke="rgba(244, 211, 94, 0.4)" strokeWidth="0.2" strokeDasharray="0.8 0.4" />
                  <text x="49" y="51" fill="rgba(244, 211, 94, 0.55)" fontSize="2" fontFamily="monospace">L.SLEEVE</text>
                </g>
              )}
            </svg>
          </div>

          <div className="skin-canvas-footer">
            <span className="skin-coords-display">
              {hoverCoord
                ? `X: ${hoverCoord.x.toString().padStart(2, '0')}  Y: ${hoverCoord.y.toString().padStart(2, '0')} · ${getPartLabelAt(hoverCoord.x, hoverCoord.y)}`
                : '64×64 RGBA'}
            </span>
            <div className="skin-view-options">
              <label className="skin-checkbox-label">
                <input
                  type="checkbox"
                  checked={showGrid}
                  onChange={(e) => setShowGrid(e.target.checked)}
                />
                <span>Grid</span>
              </label>
              <label className="skin-checkbox-label">
                <input
                  type="checkbox"
                  checked={showOutlines}
                  onChange={(e) => setShowOutlines(e.target.checked)}
                />
                <span>Outlines</span>
              </label>
            </div>
          </div>
        </div>

        {/* Right: Tools, Palette, Clear Part & Undo/Redo */}
        <div className="skin-sidebar">
          {/* Drawing Tools */}
          <div className="skin-section">
            <span className="skin-section-title">TOOLS</span>
            <div className="skin-tools-grid">
              <button
                type="button"
                className={`skin-tool-button ${tool === 'pencil' ? 'active' : ''}`}
                onClick={() => setTool('pencil')}
                title="Pencil (P)"
              >
                ✏ Pencil
              </button>
              <button
                type="button"
                className={`skin-tool-button ${tool === 'eraser' ? 'active' : ''}`}
                onClick={() => setTool('eraser')}
                title="Eraser (E)"
              >
                ⌫ Eraser
              </button>
              <button
                type="button"
                className={`skin-tool-button ${tool === 'bucket' ? 'active' : ''}`}
                onClick={() => setTool('bucket')}
                title="Bucket Fill (B)"
              >
                🪣 Fill
              </button>
              <button
                type="button"
                className={`skin-tool-button ${tool === 'eyedropper' ? 'active' : ''}`}
                onClick={() => setTool('eyedropper')}
                title="Eyedropper (I)"
              >
                💧 Pick
              </button>
            </div>
          </div>

          {/* History */}
          <div className="skin-section">
            <span className="skin-section-title">HISTORY</span>
            <div className="skin-history-row">
              <button
                type="button"
                className="skin-tool-button"
                disabled={!canUndo}
                onClick={handleUndo}
                title="Undo (Ctrl+Z)"
              >
                ↺ Undo
              </button>
              <button
                type="button"
                className="skin-tool-button"
                disabled={!canRedo}
                onClick={handleRedo}
                title="Redo (Ctrl+Y)"
              >
                ↻ Redo
              </button>
            </div>
          </div>

          {/* Color & Swatches */}
          <div className="skin-section">
            <div className="skin-color-header">
              <span className="skin-section-title">COLOR</span>
              <span className="skin-hex-value">{currentColor.toUpperCase()}</span>
            </div>
            <div className="skin-picker-container">
              <input
                type="color"
                value={currentColor}
                onChange={(e) => handleColorChange(e.target.value)}
                className="skin-color-input"
                aria-label="Color input"
              />
              <div
                className="skin-swatch-current"
                style={{ backgroundColor: currentColor }}
                aria-hidden="true"
              />
            </div>
            <div className="skin-palette-grid" role="group" aria-label="Recent color swatches">
              {recentSwatches.map((hex, index) => (
                <button
                  key={`${hex}-${index}`}
                  type="button"
                  className={`skin-palette-item ${currentColor.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`}
                  style={{ backgroundColor: hex }}
                  onClick={() => handleColorChange(hex)}
                  title={hex}
                  aria-label={`Color swatch ${hex}`}
                />
              ))}
            </div>
          </div>

          {/* Clear Part */}
          <div className="skin-section">
            <span className="skin-section-title">CLEAR PART</span>
            <div className="skin-clear-grid">
              <button
                type="button"
                className="skin-tool-button"
                onClick={() => handleClearPart('head')}
                title="Clear Head (base and hat overlay)"
              >
                Head
              </button>
              <button
                type="button"
                className="skin-tool-button"
                onClick={() => handleClearPart('body')}
                title="Clear Body (base and jacket overlay)"
              >
                Body
              </button>
              <button
                type="button"
                className="skin-tool-button"
                onClick={() => handleClearPart('arms')}
                title="Clear Arms (base and sleeves)"
              >
                Arms
              </button>
              <button
                type="button"
                className="skin-tool-button"
                onClick={() => handleClearPart('legs')}
                title="Clear Legs (base and pants)"
              >
                Legs
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* C5 prompt box container */}
      {children && <div className="skin-editor-bottom">{children}</div>}
    </div>
  )
})

export default SkinEditor
