import { useEffect, useRef } from 'react'
import type { Vec3 } from '../office3d-layout.ts'
import { levelName } from '../scene3d/level-names.ts'
import { PROP_CATALOG, type Field } from '../scene3d/prop-catalog.ts'
import { canDelete, type EditableItem } from '../scene3d/scene-edit.ts'
import type { BoxItem, FloorItem, GlassItem, SceneView, Surface, SurfaceType, WallItem } from '../scene3d/scene.ts'

const LIMIT = 1000
const fmt = (value: number): string => String(Math.round(value * 100) / 100)
const degrees = (radians: number | undefined): number => Math.round(((radians ?? 0) * 180) / Math.PI) % 360

/** A number input that commits on blur or Enter; empty, non-numeric or out-of-range text reverts. */
function NumberField({ id, label, value, step, min, max, onCommit }: { id: string; label: string; value: number; step: number; min?: number; max?: number; onCommit: (value: number) => void }) {
  return <label>{label}
    <input type="number" step={step} defaultValue={fmt(value)} key={`${id}:${value}`}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const next = Number(text)
        if (text === '' || !Number.isFinite(next) || Math.abs(next) > LIMIT) { event.currentTarget.value = fmt(value); return }
        const clamped = min !== undefined && next < min ? min : max !== undefined && next > max ? max : next
        if (clamped !== Number(fmt(value))) onCommit(clamped)
      }}/>
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
    return <NumberField key={spec.key} id={`${item.id}:${spec.key}`} label={spec.label} value={typeof current === 'number' ? current : spec.min} step={spec.step} onCommit={(next) => onProp(spec.key, Math.min(Math.max(next, spec.min), spec.max))}/>
  }
  return <>{(entry.fields ?? []).map(field)}</>
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
  onView?: (view?: SceneView) => void
  onFloorBounds?: (min: [number, number], max: [number, number], y?: number) => void
  onFloorSurface?: (surface: Surface, roughness?: number) => void
  onWallGeometry?: (from: [number, number], to: [number, number], height: number, y?: number) => void
  onGlassGeometry?: (from: [number, number], to: [number, number], bottom: number, top: number) => void
  onBoxProps?: (size: Vec3, color: string, options?: { radius?: number; roughness?: number; opacity?: number; shadow?: boolean; position?: Vec3 }) => void
}

function FloorPanel({ item, levels, canDuplicate, onMove, onLevel, onDuplicate, onDelete, onView, onFloorBounds, onFloorSurface }: ObjectPanelProps & { item: FloorItem }) {
  const width = Math.max(0.1, item.max[0] - item.min[0])
  const depth = Math.max(0.1, item.max[1] - item.min[1])
  const cx = (item.min[0] + item.max[0]) / 2
  const cz = (item.min[1] + item.max[1]) / 2
  const deletable = canDelete(item)

  const updateBounds = (nextMin: [number, number], nextMax: [number, number], nextY = item.y) => {
    if (onFloorBounds) onFloorBounds(nextMin, nextMax, nextY)
  }

  return <>
    <h3>Floor <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:cx`} label="Center X (m)" value={cx} step={0.05} onCommit={(next) => onMove(next, cz)}/>
      <NumberField id={`${item.id}:cz`} label="Center Z (m)" value={cz} step={0.05} onCommit={(next) => onMove(cx, next)}/>
      <NumberField id={`${item.id}:w`} label="Width (m)" value={width} step={0.25} min={0.25} onCommit={(w) => updateBounds([cx - w / 2, item.min[1]], [cx + w / 2, item.max[1]])}/>
      <NumberField id={`${item.id}:d`} label="Depth (m)" value={depth} step={0.25} min={0.25} onCommit={(d) => updateBounds([item.min[0], cz - d / 2], [item.max[0], cz + d / 2])}/>
      <NumberField id={`${item.id}:y`} label="Elevation Y (m)" value={item.y} step={0.05} onCommit={(y) => updateBounds(item.min, item.max, y)}/>
    </div>
    <label>Surface Material
      <select value={item.surface.type} onChange={(e) => onFloorSurface?.({ ...item.surface, type: e.target.value as SurfaceType }, item.roughness)}>
        {SURFACE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </label>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:rx`} label="Repeat X" value={item.surface.repeat[0]} step={1} min={1} onCommit={(rx) => onFloorSurface?.({ ...item.surface, repeat: [Math.round(rx), item.surface.repeat[1]] }, item.roughness)}/>
      <NumberField id={`${item.id}:rz`} label="Repeat Z" value={item.surface.repeat[1]} step={1} min={1} onCommit={(rz) => onFloorSurface?.({ ...item.surface, repeat: [item.surface.repeat[0], Math.round(rz)] }, item.roughness)}/>
      <NumberField id={`${item.id}:rough`} label="Roughness" value={item.roughness ?? 0.55} step={0.05} min={0} max={1} onCommit={(rough) => onFloorSurface?.(item.surface, rough)}/>
    </div>
    {item.surface.type === 'carpet' && (
      <ColorField label="Carpet Color" value={item.surface.color && HEX.test(item.surface.color) ? item.surface.color : '#3b82f6'} onCommit={(c) => onFloorSurface?.({ ...item.surface, color: c }, item.roughness)}/>
    )}
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={onView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function WallPanel({ item, levels, canDuplicate, onRotate, onLevel, onDuplicate, onDelete, onView, onWallGeometry }: ObjectPanelProps & { item: WallItem }) {
  const deletable = canDelete(item)
  const len = Math.hypot(item.to[0] - item.from[0], item.to[1] - item.from[1])
  const angle = Math.round((Math.atan2(item.to[1] - item.from[1], item.to[0] - item.from[0]) * 180) / Math.PI)

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
      <NumberField id={`${item.id}:h`} label="Height (m)" value={item.height} step={0.1} min={0.1} onCommit={(h) => update(item.from, item.to, h)}/>
      <NumberField id={`${item.id}:y`} label="Elevation Y (m)" value={item.y} step={0.05} onCommit={(y) => update(item.from, item.to, item.height, y)}/>
    </div>
    <div className="office-3d-objpanel-presets">
      <span>Presets:</span>
      <button type="button" onClick={() => update(item.from, item.to, 0.55)}>Stub (0.55m)</button>
      <button type="button" onClick={() => update(item.from, item.to, 0.9)}>Partition (0.9m)</button>
      <button type="button" onClick={() => update(item.from, item.to, 2.6)}>Full (2.6m)</button>
    </div>
    <p className="office-3d-objpanel-meta">Length: {fmt(len)} m | Angle: {angle}°</p>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={onView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" onClick={() => onRotate(90)} title="Rotate wall 90°">Rotate 90°</button>
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function GlassPanel({ item, levels, canDuplicate, onRotate, onLevel, onDuplicate, onDelete, onView, onGlassGeometry }: ObjectPanelProps & { item: GlassItem }) {
  const deletable = canDelete(item)
  const height = item.top - item.bottom

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
      <NumberField id={`${item.id}:bot`} label="Bottom Y (m)" value={item.bottom} step={0.05} onCommit={(bot) => update(item.from, item.to, bot)}/>
      <NumberField id={`${item.id}:top`} label="Top Y (m)" value={item.top} step={0.05} onCommit={(top) => update(item.from, item.to, item.bottom, top)}/>
    </div>
    <p className="office-3d-objpanel-meta">Height: {fmt(height)} m</p>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={onView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" onClick={() => onRotate(90)} title="Rotate glass 90°">Rotate 90°</button>
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

function BoxPanel({ item, levels, canDuplicate, onMove, onLevel, onDuplicate, onDelete, onView, onBoxProps }: ObjectPanelProps & { item: BoxItem }) {
  const deletable = canDelete(item)

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
      <NumberField id={`${item.id}:sx`} label="Size X (m)" value={item.size[0]} step={0.1} min={0.1} onCommit={(sx) => update([sx, item.size[1], item.size[2]])}/>
      <NumberField id={`${item.id}:sy`} label="Size Y (m)" value={item.size[1]} step={0.1} min={0.1} onCommit={(sy) => update([item.size[0], sy, item.size[2]])}/>
      <NumberField id={`${item.id}:sz`} label="Size Z (m)" value={item.size[2]} step={0.1} min={0.1} onCommit={(sz) => update([item.size[0], item.size[1], sz])}/>
    </div>
    <ColorField label="Color" value={HEX.test(item.color) ? item.color : '#a0a0a0'} onCommit={(c) => update(item.size, c)}/>
    <div className="office-3d-objpanel-grid">
      <NumberField id={`${item.id}:op`} label="Opacity" value={item.opacity ?? 1} step={0.05} min={0} max={1} onCommit={(op) => update(item.size, item.color, { opacity: op })}/>
      <NumberField id={`${item.id}:r`} label="Roughness" value={item.roughness ?? 0.5} step={0.05} min={0} max={1} onCommit={(r) => update(item.size, item.color, { roughness: r })}/>
      <NumberField id={`${item.id}:rad`} label="Corner Radius" value={item.radius ?? 0} step={0.05} min={0} onCommit={(rad) => update(item.size, item.color, { radius: rad })}/>
    </div>
    <label>
      <input type="checkbox" checked={item.shadow ?? false} onChange={(e) => update(item.size, item.color, { shadow: e.target.checked })}/>
      Cast Shadow
    </label>
    <FloorSelector value={item.level} levels={levels} onChange={onLevel}/>
    <ViewSelector value={item.view} onChange={onView}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} onClick={onDelete}>Delete</button>
    </div>
  </>
}

/** Position, rotation, floor, properties, duplicate and delete for the selected object. */
export function ObjectPanel(props: ObjectPanelProps) {
  const { item, levels, canDuplicate, onMove, onRotate, onLevel, onDuplicate, onProp, onDelete, onView } = props

  if (!item) {
    return <aside className="office-3d-objpanel" aria-label="Selected object">
      <p className="office-3d-objpanel-empty">Click any object, wall, or floor slab to edit its properties. Press Esc to deselect.</p>
    </aside>
  }

  if (item.kind === 'floor') return <aside className="office-3d-objpanel" aria-label="Selected object"><FloorPanel {...props} item={item}/></aside>
  if (item.kind === 'wall') return <aside className="office-3d-objpanel" aria-label="Selected object"><WallPanel {...props} item={item}/></aside>
  if (item.kind === 'glass') return <aside className="office-3d-objpanel" aria-label="Selected object"><GlassPanel {...props} item={item}/></aside>
  if (item.kind === 'box') return <aside className="office-3d-objpanel" aria-label="Selected object"><BoxPanel {...props} item={item}/></aside>

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
    <ViewSelector value={item.view} onChange={onView}/>
    <PropFields item={item} onProp={onProp}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} title={canDuplicate ? 'Duplicate (Ctrl/Cmd+D)' : 'Limit reached (500 added objects)'} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} title={deletable ? 'Delete (Del)' : 'Desks and beds follow the number of agents'} onClick={onDelete}>Delete</button>
    </div>
  </aside>
}
