import { isSeatId, type PropItem, type SceneItem, type ScenePatch, type WindowItem } from './scene.ts'

// The editor's operations on a draft ScenePatch. Each takes the patch and the item as it is drawn
// now (defaults plus patch) and returns a new patch; nothing is mutated. Stock items change through
// `overrides[id]`, items the user added are edited in place in `added`.

/** What the editor can select and move: props and windows. Structure waits for the 2b handles. */
export type EditableItem = PropItem | WindowItem
export const isEditable = (item: SceneItem): item is EditableItem => item.kind === 'prop' || item.kind === 'window'
/** Desks and beds follow the number of agents: they can be moved but not deleted. */
export const canDelete = (item: SceneItem): boolean => !isSeatId(item.id)

export const GRID = 0.25
export const ROTATION_STEP = Math.PI / 12
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

const TAU = Math.PI * 2
// Four decimals keeps saved numbers small; `+ 0` turns -0 into 0.
const round4 = (value: number): number => Number(value.toFixed(4)) + 0
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

export const snap = (value: number, step = GRID): number => round4(Math.round(value / step) * step)

function normalizeAngle(radians: number): number {
  const rounded = round4(((radians % TAU) + TAU) % TAU)
  return rounded >= round4(TAU) ? 0 : rounded
}

function patchItem(patch: ScenePatch, id: string, fields: Partial<SceneItem>): ScenePatch {
  if (patch.added.some((item) => item.id === id)) {
    return { ...patch, added: patch.added.map((item) => (item.id === id ? { ...item, ...fields } as SceneItem : item)) }
  }
  const current = patch.overrides[id]
  return { ...patch, overrides: { ...patch.overrides, [id]: { ...(current && typeof current === 'object' ? current : {}), ...fields } } }
}

export function moveItem(patch: ScenePatch, item: EditableItem, x: number, z: number, bounds?: Bounds): ScenePatch {
  const px = round4(bounds ? clamp(x, bounds.minX, bounds.maxX) : x)
  const pz = round4(bounds ? clamp(z, bounds.minZ, bounds.maxZ) : z)
  return patchItem(patch, item.id, { position: [px, item.position[1], pz] })
}

export const rotateItem = (patch: ScenePatch, item: EditableItem, radians: number): ScenePatch => patchItem(patch, item.id, { rotation: normalizeAngle(radians) })
export const rotateBy = (patch: ScenePatch, item: EditableItem, delta: number): ScenePatch => rotateItem(patch, item, (item.rotation ?? 0) + delta)

export function deleteItem(patch: ScenePatch, item: SceneItem): ScenePatch {
  if (!canDelete(item)) return patch
  if (patch.added.some((added) => added.id === item.id)) return { ...patch, added: patch.added.filter((added) => added.id !== item.id) }
  return { ...patch, overrides: { ...patch.overrides, [item.id]: null } }
}

/** Puts an item on another floor: its level changes and its height shifts by the same difference. */
export function setItemLevel(patch: ScenePatch, item: EditableItem, level: number): ScenePatch {
  if (level === item.level) return patch
  const [x, y, z] = item.position
  return patchItem(patch, item.id, { level, position: [x, round4(y + (level - item.level)), z] })
}

export type EditKeyAction = 'undo' | 'redo' | 'delete' | 'rotate+' | 'rotate-' | 'deselect'

export function editKeyAction(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): EditKeyAction | null {
  const key = event.key.toLowerCase()
  if (event.ctrlKey || event.metaKey) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
    return key === 'y' ? 'redo' : null
  }
  if (key === 'delete' || key === 'backspace') return 'delete'
  if (key === 'r') return event.shiftKey ? 'rotate-' : 'rotate+'
  return key === 'escape' ? 'deselect' : null
}
