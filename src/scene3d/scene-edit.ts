import { PROP_CATALOG } from './prop-catalog.ts'
import { isSeatId, MAX_ADDED, type PropItem, type PropType, type PropValue, type SceneItem, type ScenePatch, type WindowItem } from './scene.ts'

// The editor's operations on a draft ScenePatch. Each takes the patch and the item as it is drawn
// now (defaults plus patch) and returns a new patch; nothing is mutated. Stock items change through
// `overrides[id]`, items the user added are edited in place in `added`.

/** What the editor can select and move: props and windows. Structure waits for the floors-and-walls sub-project (2c). */
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
// Some stock items (trees) sit outside the pan bounds: widen them to include where the item is now, so an untouched axis never jumps.
const clampAround = (value: number, min: number, max: number, current: number): number => clamp(value, Math.min(min, current), Math.max(max, current))

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
  const px = round4(bounds ? clampAround(x, bounds.minX, bounds.maxX, item.position[0]) : x)
  const pz = round4(bounds ? clampAround(z, bounds.minZ, bounds.maxZ, item.position[2]) : z)
  if (px === item.position[0] && pz === item.position[2]) return patch
  return patchItem(patch, item.id, { position: [px, item.position[1], pz] })
}

/** Where a dragged object lands: movement snaps to the grid relative to where it started (items that sit off the grid, such as wall-mounted ones, keep their alignment and a click with jitter is a no-op), or is free with Alt; always clamped to the bounds (widened to include the origin, for items that start outside them). */
export function dragTarget(origin: [number, number], pointer: [number, number], free: boolean, bounds: Bounds): [number, number] {
  const step = (from: number, to: number) => from + (free ? to - from : snap(to - from))
  return [clampAround(step(origin[0], pointer[0]), bounds.minX, bounds.maxX, origin[0]), clampAround(step(origin[1], pointer[1]), bounds.minZ, bounds.maxZ, origin[1])]
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

export const DUPLICATE_OFFSET = 0.5

/** The result of an operation that adds an item: `id` is null when nothing was added (limit reached). */
export interface AddResult { patch: ScenePatch; id: string | null }

/** `added-<n>` with the smallest n that no stock item, added item or override refers to. `items` is the scene as drawn. */
export function nextAddedId(patch: ScenePatch, items: SceneItem[]): string {
  const used = new Set<string>([...items.map((item) => item.id), ...patch.added.map((item) => item.id), ...Object.keys(patch.overrides)])
  let n = 1
  while (used.has(`added-${n}`)) n += 1
  return `added-${n}`
}

/** Where a new object lands for a pointer on the floor: grid-snapped (free with Alt) and clamped to the bounds. */
export function placePoint(point: [number, number], free: boolean, bounds: Bounds): [number, number] {
  const pick = (value: number, min: number, max: number) => round4(clamp(free ? value : snap(value), min, max))
  return [pick(point[0], bounds.minX, bounds.maxX), pick(point[1], bounds.minZ, bounds.maxZ)]
}

/** A new prop of `type` on `level`, mounted at the catalogue height with the catalogue defaults. */
export function addProp(patch: ScenePatch, items: SceneItem[], type: PropType, x: number, z: number, level: number, bounds: Bounds): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const entry = PROP_CATALOG[type]
  const [px, pz] = placePoint([x, z], true, bounds)
  const id = nextAddedId(patch, items)
  const item: PropItem = { kind: 'prop', id, type, level, position: [px, round4(level + entry.y), pz], ...(entry.defaults ? { props: { ...entry.defaults } } : {}) }
  return { patch: { ...patch, added: [...patch.added, item] }, id }
}

/** A copy of an editable item as drawn now, half a metre over; the bounds are widened to include the original so items outside them (trees) can be copied. */
export function duplicateItem(patch: ScenePatch, items: SceneItem[], item: EditableItem, bounds: Bounds): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const id = nextAddedId(patch, items)
  const [x, y, z] = item.position
  const position: PropItem['position'] =[round4(clampAround(x + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, x)), y, round4(clampAround(z + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, z))]
  // Only the fields the server accepts for the kind: a hand-edited stock item may carry others, and the whole save would be refused.
  const common = { id, level: item.level, position, ...(item.view ? { view: item.view } : {}), ...(item.rotation !== undefined ? { rotation: item.rotation } : {}) }
  const copy: EditableItem = item.kind === 'prop'
    ? { kind: 'prop', type: item.type, ...common, ...(item.props ? { props: { ...item.props } } : {}) }
    : { kind: 'window', ...common, ...(item.width !== undefined ? { width: item.width } : {}) }
  return { patch: { ...patch, added: [...patch.added, copy] }, id }
}

/** Sets one prop (size, length, colour...) of a prop item. The whole props object is written, so a stock item's override replaces its props with the edited copy. */
export function setItemProp(patch: ScenePatch, item: EditableItem, key: string, value: PropValue): ScenePatch {
  if (item.kind !== 'prop' || item.props?.[key] === value) return patch
  return patchItem(patch, item.id, { props: { ...item.props, [key]: value } })
}

export type EditKeyAction = 'undo' | 'redo' | 'delete' | 'rotate+' | 'rotate-' | 'deselect' | 'duplicate'

export function editKeyAction(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): EditKeyAction | null {
  const key = event.key.toLowerCase()
  if (event.ctrlKey || event.metaKey) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
    if (key === 'd') return 'duplicate'
    return key === 'y' ? 'redo' : null
  }
  if (key === 'delete' || key === 'backspace') return 'delete'
  if (key === 'r') return event.shiftKey ? 'rotate-' : 'rotate+'
  return key === 'escape' ? 'deselect' : null
}
