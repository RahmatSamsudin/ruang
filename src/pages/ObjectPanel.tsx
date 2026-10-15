import { useEffect, useRef, useState } from 'react'
import type { Vec3 } from '../office3d-layout.ts'
import { levelName } from '../scene3d/level-names.ts'
import { PROP_CATALOG, type Field } from '../scene3d/prop-catalog.ts'
import { canDelete, type EditableItem } from '../scene3d/scene-edit.ts'
import type { BoxItem, FloorItem, GlassItem, ModelItem, SceneView, Surface, SurfaceType, WallItem } from '../scene3d/scene.ts'

const LIMIT = 1000
const fmt = (value: number): string => String(Math.round(value * 100) / 100)
const degrees = (radians: number | undefined): number => Math.round(((radians ?? 0) * 180) / Math.PI) % 360

/** A number input that commits on blur or Enter; empty, non-numeric or out-of-range text reverts with an inline error. */
function NumberField({ id, label, value, step, min, max, onCommit }: { id: string; label: string; value: number; step: number; min?: number; max?: number; onCommit: (value: number) => void }) {
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(null), 2500)
    return () => clearTimeout(timer)
  }, [error])

  return <label>{label}
    <input type="number" step={step} defaultValue={fmt(value)} key={`${id}:${value}`}
      className={error ? 'office-3d-input-error' : undefined}
      aria-invalid={error ? 'true' : undefined}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      onFocus={() => { if (error) setError(null) }}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const next = Number(text)
        if (text === '' || !Number.isFinite(next) || Math.abs(next) > LIMIT) {
          event.currentTarget.value = fmt(value)
          setError('Invalid number')
          return
        }
        const clamped = Math.min(Math.max(next, min ?? -LIMIT), max ?? LIMIT)
        if (clamped !== next) event.currentTarget.value = fmt(clamped)
        setError(null)
        if (clamped !== Number(fmt(value))) onCommit(clamped)
      }}/>
    {error && <span className="office-3d-field-error" role="alert" style={{ color: '#ff8080', fontSize: '10px' }}>{error}</span>}
  </label>
}

/** A colour picker that commits when the picker closes (the native `change`). */
function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => {
    const node = input.current
    if (!node) return
    const onChange = () => commit.current(node.value)
    node.addEventListener('change', onChange)
    return () => node.removeEventListener('change', onChange)
  }, [value])
  return <label>{label}<input type="color" ref={input} defaultValue={value} key={value}/></label>
}

const HEX = /^#[0-9a-fA-F]{6}$/
const SURFACE_TYPES: SurfaceType[] = ['wood', 'tile', 'carpet', 'grass', 'asphalt', 'paving']

function FloorSelector({ value, levels, onChange }: { value: number; levels: number[]; onChange: (level: number) => void }) {
  return <label>Floor
    <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
      {levels.map((level, index) => <option key={level} value={level}>{levelName(level, index).label}</option>)}
    </select>
  </label>
}

function ViewSelector({ value, onChange }: { value?: SceneView; onChange?: (view?: SceneView) => void }) {
  return <label>View
    <select value={value ?? 'cutaway'} onChange={(event) => onChange?.(event.target.value as SceneView)}>
      <option value="cutaway">Cutaway</option>
      <option value="shell">Shell</option>
      <option value="both">Both</option>
    </select>
  </label>
}

function PropFields({ item, onProp }: { item: EditableItem; onProp: (key: string, value: number | string) => void }) {
  if (item.kind !== 'prop') return null
  const entry = PROP_CATALOG[item.type]
  const field = (spec: Field) => {
    const current = item.props?.[spec.key] ?? entry.defaults?.[spec.key]
    if (spec.kind === 'color') return <ColorField key={spec.key} label={spec.label} value={typeof current === 'string' && HEX.test(current) ? current : '#888888'} onCommit={(value) => onProp(spec.key, value)}/>
    return <NumberField key={spec.key} id={`${item.id}:${spec.key}`} label={spec.label} value={typeof current === 'number' ? current : spec.min} step={spec.step} min={spec.min} max={spec.max} onCommit={(next) => onProp(spec.key, next)}/>
  }
  return <>
    {item.type === 'Staircase' && (
      <p className="office-3d-objpanel-notice">Decorative in 2c: agent walking paths between floors use the stock stairwell trajectory until navigation updates in sub-project 4.</p>
    )}
    {(entry.fields ?? []).map(field)}
  </>
}

export interface ObjectPanelProps {
  item: EditableItem | null
  levels: number[]
  canDuplicate: boolean
  onMove: (x: number, z: number) => void
  onRotate: (degrees: number) => void
  onLevel: (level: number) => void
  onDuplicate: () => void
  onProp: (key: string, value: number | string) => void
  onDelete: () => void
  onExport?: () => void
  onView?: (view?: SceneView) => void
  onScale?: (scale: number) => void
  onViewChange?: (view?: SceneView) => void
  onFloorBounds?: (min: [number, number], max: [number, number], y?: number) => void
  onFloorSurface?: (surface: Surface, roughness?: number) => void
  onSurfaceChange?: (surface: Surface, roughness?: number) => void
  onWallGeometry?: (from: [number, number], to: [number, number], height: number, y?: number) => void
  onGlassGeometry?: (from: [number, number], to: [number, number], bottom: number, top: number) => void
  onBoxProps?: (size: Vec3, color: string, options?: { radius?: number; roughness?: number; opacity?: number; shadow?: boolean; position?: Vec3 }) => void
}

function FloorPanel({ item, levels, canDuplicate, onMove, onLevel, onDuplicate, onProp, onDelete, onExport, onView, onViewChange, onFloorBounds, onFloorSurface, onSurfaceChange }: ObjectPanelProps & { item: FloorItem }) {
  const width = Math.max(0.1, item.max[0] - item.min[0])
  const depth = Math.max(0.1, item.max[1] - item.min[1])
  const cx = (item.min[0] + item.max[0]) / 2
  const cz = (item.min[1] + item.max[1]) / 2
  const deletable = canDelete(item)
  const handleView = onViewChange ?? onView

  const updateBounds = (nextMin: [number, number], nextMax: [number, number], nextY = item.y) => {
    if (onFloorBounds) onFloorBounds(nextMin, nextMax, nextY)
  }

  const handleSurface = (surface: Surface, roughness?: number) => {
    if (onSurfaceChange) onSurfaceChange(surface, roughness)
    else if (onFloorSurface) onFloorSurface(surface, roughness)
    else (onProp as ((key: string, value: unknown) => void) | undefined)?.('surface', surface)
  }

  return <>
    <h3>Floor <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:cx`} label="Center X (m)" value={cx} step={0.05} onCommit={(next) => onMove(next, cz)}/>
      <NumberField id={`${item.id}:cz`} label="Center Z (m)" value={cz} step={0.05} onCommit={(next) => onMove(cx, next)}/>
      <NumberField id={`${item.id}:w`} label="Width (m)" value={width} step={0.25} min={0.5} max={100} onCommit={(w) => updateBounds([cx - w / 2, item.min[1]], [cx + w / 2, item.max[1]])}/>
      <NumberField id={`${item.id}:d`} label="Depth (m)" value={depth} step={0.25} min={0.5} max={100} onCommit={(d) => updateBounds([item.min[0], cz - d / 2], [item.max[0], cz + d / 2])}/>
      <NumberField id={`${item.id}:y`} label="Elevation Y (m)" value={item.y} step={0.05} min={item.level - 5} max={item.level + 5} onCommit={(y) => updateBounds(item.min, item.max, y)}/>
    </div>
    <label>Surface Material
      <select value={item.surface.type} onChange={(e) => {
        const nextType = e.target.value as SurfaceType
        const repeat = item.surface.repeat ?? [2, 2]
        const roughness = item.roughness ?? 0.55
        if (nextType === 'carpet') {
          handleSurface({ type: 'carpet', repeat, color: item.surface.color && HEX.test(item.surface.color) ? item.surface.color : '#687787' }, roughness)
        } else {
          handleSurface({ type: nextType, repeat }, roughness)
        }
      }}>
        {SURFACE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </label>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:rx`} label="Repeat X" value={item.surface.repeat[0]} step={1} min={1} max={100} onCommit={(rx) => handleSurface({ ...item.surface, repeat: [Math.round(rx), item.surface.repeat[1]] }, item.roughness)}/>
      <NumberField id={`${item.id}:rz`} label="Repeat Z" value={item.surface.repeat[1]} step={1} min={1} max={100} onCommit={(rz) => handleSurface({ ...item.surface, repeat: [item.surface.repeat[0], Math.round(rz)] }, item.roughness)}/>
      <NumberField id={`${item.id}:rough`} label="Roughness" value={item.roughness ?? 0.55} step={0.05} min={0} max={1} onCommit={(rough) => handleSurface(item.surface, rough)}/>
    </div>
    {item.surface.type === 'carpet' && (
      <ColorField label="Carpet Color" value={item.surface.color && HEX.test(item.surface.color) ? item.surface.color : '#687787'} onCommit={(c) => handleSurface({ ...item.surface, color: c }, item.roughness)}/>
    )}
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={handleView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={!onExport} title="Download this object as a .glb" onClick={onExport}>Export GLB</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function WallPanel({ item, levels, canDuplicate, onRotate, onLevel, onDuplicate, onDelete, onExport, onView, onViewChange, onWallGeometry }: ObjectPanelProps & { item: WallItem }) {
  const deletable = canDelete(item)
  const len = Math.hypot(item.to[0] - item.from[0], item.to[1] - item.from[1])
  const angle = Math.round((Math.atan2(item.to[1] - item.from[1], item.to[0] - item.from[0]) * 180) / Math.PI)
  const handleView = onViewChange ?? onView

  const update = (from = item.from, to = item.to, height = item.height, y = item.y) => {
    onWallGeometry?.(from, to, height, y)
  }

  return <>
    <h3>Wall <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:fx`} label="From X (m)" value={item.from[0]} step={0.25} onCommit={(fx) => update([fx, item.from[1]])}/>
      <NumberField id={`${item.id}:fz`} label="From Z (m)" value={item.from[1]} step={0.25} onCommit={(fz) => update([item.from[0], fz])}/>
      <NumberField id={`${item.id}:tx`} label="To X (m)" value={item.to[0]} step={0.25} onCommit={(tx) => update(item.from, [tx, item.to[1]])}/>
      <NumberField id={`${item.id}:tz`} label="To Z (m)" value={item.to[1]} step={0.25} onCommit={(tz) => update(item.from, [item.to[0], tz])}/>
      <NumberField id={`${item.id}:h`} label="Height (m)" value={item.height} step={0.1} min={0.1} max={10.0} onCommit={(h) => update(item.from, item.to, h)}/>
      <NumberField id={`${item.id}:y`} label="Elevation Y (m)" value={item.y} step={0.05} min={item.level - 5} max={item.level + 5} onCommit={(y) => update(item.from, item.to, item.height, y)}/>
    </div>
    <div className="office-3d-objpanel-presets">
      <span>Presets:</span>
      <button type="button" onClick={() => update(item.from, item.to, 0.55)}>Stub (0.55m)</button>
      <button type="button" onClick={() => update(item.from, item.to, 0.9)}>Partition (0.9m)</button>
      <button type="button" onClick={() => update(item.from, item.to, 2.6)}>Full (2.6m)</button>
    </div>
    <p className="office-3d-objpanel-meta">Length: {fmt(len)} m | Angle: {angle}°</p>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={handleView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" onClick={() => onRotate(90)} title="Rotate wall 90°">Rotate 90°</button>
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={!onExport} title="Download this object as a .glb" onClick={onExport}>Export GLB</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function GlassPanel({ item, levels, canDuplicate, onRotate, onLevel, onDuplicate, onDelete, onExport, onView, onViewChange, onGlassGeometry }: ObjectPanelProps & { item: GlassItem }) {
  const deletable = canDelete(item)
  const height = item.top - item.bottom
  const handleView = onViewChange ?? onView

  const update = (from = item.from, to = item.to, bottom = item.bottom, top = item.top) => {
    onGlassGeometry?.(from, to, bottom, top)
  }

  return <>
    <h3>Glass <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:fx`} label="From X (m)" value={item.from[0]} step={0.25} onCommit={(fx) => update([fx, item.from[1]])}/>
      <NumberField id={`${item.id}:fz`} label="From Z (m)" value={item.from[1]} step={0.25} onCommit={(fz) => update([item.from[0], fz])}/>
      <NumberField id={`${item.id}:tx`} label="To X (m)" value={item.to[0]} step={0.25} onCommit={(tx) => update(item.from, [tx, item.to[1]])}/>
      <NumberField id={`${item.id}:tz`} label="To Z (m)" value={item.to[1]} step={0.25} onCommit={(tz) => update(item.from, [item.to[0], tz])}/>
      <NumberField id={`${item.id}:bot`} label="Bottom Y (m)" value={item.bottom} step={0.05} min={item.level - 20} max={item.level + 20} onCommit={(bot) => update(item.from, item.to, bot)}/>
      <NumberField id={`${item.id}:top`} label="Top Y (m)" value={item.top} step={0.05} min={item.level - 20} max={item.level + 20} onCommit={(top) => update(item.from, item.to, item.bottom, top)}/>
    </div>
    <p className="office-3d-objpanel-meta">Height: {fmt(height)} m</p>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={handleView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" onClick={() => onRotate(90)} title="Rotate glass 90°">Rotate 90°</button>
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={!onExport} title="Download this object as a .glb" onClick={onExport}>Export GLB</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function BoxPanel({ item, levels, canDuplicate, onMove, onLevel, onDuplicate, onDelete, onExport, onView, onViewChange, onBoxProps }: ObjectPanelProps & { item: BoxItem }) {
  const deletable = canDelete(item)
  const handleView = onViewChange ?? onView

  const update = (size = item.size, color = item.color, options?: { radius?: number; roughness?: number; opacity?: number; shadow?: boolean; position?: Vec3 }) => {
    onBoxProps?.(size, color, {
      radius: item.radius,
      roughness: item.roughness,
      opacity: item.opacity,
      shadow: item.shadow,
      position: item.position,
      ...options,
    })
  }

  return <>
    <h3>Box <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:x`} label="X (m)" value={item.position[0]} step={0.05} onCommit={(x) => onMove(x, item.position[2])}/>
      <NumberField id={`${item.id}:y`} label="Y (m)" value={item.position[1]} step={0.05} onCommit={(y) => update(item.size, item.color, { position: [item.position[0], y, item.position[2]] })}/>
      <NumberField id={`${item.id}:z`} label="Z (m)" value={item.position[2]} step={0.05} onCommit={(z) => onMove(item.position[0], z)}/>
      <NumberField id={`${item.id}:sx`} label="Size X (m)" value={item.size[0]} step={0.05} min={0.05} max={50.0} onCommit={(sx) => update([sx, item.size[1], item.size[2]])}/>
      <NumberField id={`${item.id}:sy`} label="Size Y (m)" value={item.size[1]} step={0.05} min={0.05} max={50.0} onCommit={(sy) => update([item.size[0], sy, item.size[2]])}/>
      <NumberField id={`${item.id}:sz`} label="Size Z (m)" value={item.size[2]} step={0.05} min={0.05} max={50.0} onCommit={(sz) => update([item.size[0], item.size[1], sz])}/>
    </div>
    <ColorField label="Color" value={HEX.test(item.color) ? item.color : '#a0a0a0'} onCommit={(c) => update(item.size, c)}/>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:op`} label="Opacity" value={item.opacity ?? 1} step={0.05} min={0} max={1} onCommit={(op) => update(item.size, item.color, { opacity: op })}/>
      <NumberField id={`${item.id}:r`} label="Roughness" value={item.roughness ?? 0.5} step={0.05} min={0} max={1} onCommit={(r) => update(item.size, item.color, { roughness: r })}/>
      <NumberField id={`${item.id}:rad`} label="Corner Radius (m)" value={item.radius ?? 0} step={0.05} min={0} max={0.5} onCommit={(rad) => update(item.size, item.color, { radius: rad })}/>
    </div>
    <label>
      <input type="checkbox" checked={item.shadow !== false} onChange={(e) => update(item.size, item.color, { shadow: e.target.checked })}/>
      Cast Shadow
    </label>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={handleView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={!onExport} title="Download this object as a .glb" onClick={onExport}>Export GLB</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function ModelPanel({ item, levels, canDuplicate, onMove, onRotate, onScale, onLevel, onDuplicate, onDelete, onExport, onView }: ObjectPanelProps & { item: ModelItem }) {
  const x = item.position[0]
  const z = item.position[2]
  const deletable = canDelete(item)
  return <>
    <h3>Model <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:x`} label="X (m)" value={x} step={0.05} onCommit={(next) => onMove(next, z)}/>
      <NumberField id={`${item.id}:z`} label="Z (m)" value={z} step={0.05} onCommit={(next) => onMove(x, next)}/>
      <NumberField id={`${item.id}:rot`} label="Rotation (°)" value={degrees(item.rotation)} step={15} onCommit={onRotate}/>
      <NumberField id={`${item.id}:scale`} label="Scale" value={item.scale ?? 1.0} step={0.1} min={0.01} max={100} onCommit={(scale) => onScale?.(scale)}/>
    </div>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={onView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} title={canDuplicate ? 'Duplicate (Ctrl/Cmd+D)' : 'Limit reached (500 added objects)'} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={!onExport} title="Download this object as a .glb" onClick={onExport}>Export GLB</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

/** Position, rotation, floor, properties, duplicate and delete for the selected object. */
export function ObjectPanel(props: ObjectPanelProps) {
  const { item, levels, canDuplicate, onMove, onRotate, onLevel, onDuplicate, onProp, onDelete, onExport, onView, onViewChange } = props
  const handleView = onViewChange ?? onView

  if (!item) {
    return <aside className="office-3d-objpanel" aria-label="Selected object">
      <p className="office-3d-objpanel-empty">Click any object, wall, or floor slab to edit its properties. Press Esc to deselect.</p>
    </aside>
  }

  if (item.kind === 'floor') return <aside className="office-3d-objpanel" aria-label="Selected object"><FloorPanel {...props} item={item}/></aside>
  if (item.kind === 'wall') return <aside className="office-3d-objpanel" aria-label="Selected object"><WallPanel {...props} item={item}/></aside>
  if (item.kind === 'glass') return <aside className="office-3d-objpanel" aria-label="Selected object"><GlassPanel {...props} item={item}/></aside>
  if (item.kind === 'box') return <aside className="office-3d-objpanel" aria-label="Selected object"><BoxPanel {...props} item={item}/></aside>
  if (item.kind === 'model') return <aside className="office-3d-objpanel" aria-label="Selected object"><ModelPanel {...props} item={item}/></aside>

  const x = item.position[0]
  const z = item.position[2]
  const deletable = canDelete(item)
  return <aside className="office-3d-objpanel" aria-label="Selected object">
    <h3>{item.kind === 'prop' ? item.type : 'Window'} <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={item.id} label="X (m)" value={x} step={0.05} onCommit={(next) => onMove(next, z)}/>
      <NumberField id={item.id} label="Z (m)" value={z} step={0.05} onCommit={(next) => onMove(x, next)}/>
      <NumberField id={item.id} label="Rotation (°)" value={degrees(item.rotation)} step={15} onCommit={onRotate}/>
    </div>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={handleView}/>
    <PropFields item={item} onProp={onProp}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} title={canDuplicate ? 'Duplicate (Ctrl/Cmd+D)' : 'Limit reached (500 added objects)'} onClick={onDuplicate}>Duplicate</button>
      <button type="button" disabled={!onExport} title="Download this object as a .glb" onClick={onExport}>Export GLB</button>
      <button type="button" className="danger" disabled={!deletable} title={deletable ? 'Delete (Del)' : 'Desks and beds follow the number of agents'} onClick={onDelete}>Delete</button>
    </div>
  </aside>
}

