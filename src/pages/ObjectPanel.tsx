import { levelName } from '../scene3d/level-names.ts'
import { canDelete, type EditableItem } from '../scene3d/scene-edit.ts'

const LIMIT = 1000
const fmt = (value: number): string => String(Math.round(value * 100) / 100)
const degrees = (radians: number | undefined): number => Math.round(((radians ?? 0) * 180) / Math.PI) % 360

/** A number input that commits on blur or Enter; empty, non-numeric or out-of-range text reverts. */
function NumberField({ label, value, step, onCommit }: { label: string; value: number; step: number; onCommit: (value: number) => void }) {
  return <label>{label}
    <input type="number" step={step} defaultValue={fmt(value)} key={value}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const next = Number(text)
        if (text === '' || !Number.isFinite(next) || Math.abs(next) > LIMIT) { event.currentTarget.value = fmt(value); return }
        if (next !== Number(fmt(value))) onCommit(next)
      }}/>
  </label>
}

export interface ObjectPanelProps {
  item: EditableItem
  levels: number[]
  onMove: (x: number, z: number) => void
  onRotate: (degrees: number) => void
  onLevel: (level: number) => void
  onDelete: () => void
}

/** Position, rotation, floor and delete for the selected object. */
export function ObjectPanel({ item, levels, onMove, onRotate, onLevel, onDelete }: ObjectPanelProps) {
  const x = item.position[0]
  const z = item.position[2]
  const deletable = canDelete(item)
  return <aside className="office-3d-objpanel" aria-label="Selected object">
    <h3>{item.kind === 'prop' ? item.type : 'Window'} <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField label="X (m)" value={x} step={0.05} onCommit={(next) => onMove(next, z)}/>
      <NumberField label="Z (m)" value={z} step={0.05} onCommit={(next) => onMove(x, next)}/>
      <NumberField label="Rotation (°)" value={degrees(item.rotation)} step={15} onCommit={onRotate}/>
    </div>
    <label>Floor
      <select value={item.level} onChange={(event) => onLevel(Number(event.target.value))}>
        {levels.map((level, index) => <option key={level} value={level}>{levelName(level, index).label}</option>)}
      </select>
    </label>
    <button type="button" className="danger" disabled={!deletable} title={deletable ? 'Delete (Del)' : 'Desks and beds follow the number of agents'} onClick={onDelete}>Delete</button>
  </aside>
}
