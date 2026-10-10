import { useEffect, useRef } from 'react'
import { levelName } from '../scene3d/level-names.ts'
import { PROP_CATALOG, type Field } from '../scene3d/prop-catalog.ts'
import { canDelete, type EditableItem } from '../scene3d/scene-edit.ts'

const LIMIT = 1000
const fmt = (value: number): string => String(Math.round(value * 100) / 100)
const degrees = (radians: number | undefined): number => Math.round(((radians ?? 0) * 180) / Math.PI) % 360

/** A number input (remounted per object and value, so typed text never follows a new selection) that commits on blur or Enter; empty, non-numeric or out-of-range text reverts. */
function NumberField({ id, label, value, step, onCommit }: { id: string; label: string; value: number; step: number; onCommit: (value: number) => void }) {
  return <label>{label}
    <input type="number" step={step} defaultValue={fmt(value)} key={`${id}:${value}`}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const next = Number(text)
        if (text === '' || !Number.isFinite(next) || Math.abs(next) > LIMIT) { event.currentTarget.value = fmt(value); return }
        if (next !== Number(fmt(value))) onCommit(next)
      }}/>
  </label>
}

/** A colour picker that commits when the picker closes (the native `change`), so dragging through colours is one undo step. */
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
  }, [value]) // the input remounts (key) when the value changes, so rebind to the new node
  return <label>{label}<input type="color" ref={input} defaultValue={value} key={value}/></label>
}

const HEX = /^#[0-9a-fA-F]{6}$/

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
  item: EditableItem
  levels: number[]
  canDuplicate: boolean
  onMove: (x: number, z: number) => void
  onRotate: (degrees: number) => void
  onLevel: (level: number) => void
  onDuplicate: () => void
  onProp: (key: string, value: number | string) => void
  onDelete: () => void
}

/** Position, rotation, floor, properties, duplicate and delete for the selected object. */
export function ObjectPanel({ item, levels, canDuplicate, onMove, onRotate, onLevel, onDuplicate, onProp, onDelete }: ObjectPanelProps) {
  const x = item.position[0]
  const z = item.position[2]
  const deletable = canDelete(item)
  return <aside
    className="office-3d-objpanel"
    aria-label="Selected object"
    ref={(el) => {
      if (!el) return
      el.onwheel = (event) => event.stopPropagation()
    }}
    onWheel={(event) => event.stopPropagation()}
  >
    <h3>{item.kind === 'prop' ? item.type : 'Window'} <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField id={item.id} label="X (m)" value={x} step={0.05} onCommit={(next) => onMove(next, z)}/>
      <NumberField id={item.id} label="Z (m)" value={z} step={0.05} onCommit={(next) => onMove(x, next)}/>
      <NumberField id={item.id} label="Rotation (°)" value={degrees(item.rotation)} step={15} onCommit={onRotate}/>
    </div>
    <label>Floor
      <select value={item.level} onChange={(event) => onLevel(Number(event.target.value))}>
        {levels.map((level, index) => <option key={level} value={level}>{levelName(level, index).label}</option>)}
      </select>
    </label>
    <PropFields item={item} onProp={onProp}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} title={canDuplicate ? 'Duplicate (Ctrl/Cmd+D)' : 'Limit reached (500 added objects)'} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} title={deletable ? 'Delete (Del)' : 'Desks and beds follow the number of agents'} onClick={onDelete}>Delete</button>
    </div>
  </aside>
}
