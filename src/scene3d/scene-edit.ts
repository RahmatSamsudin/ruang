import type { Vec3 } from '../office3d-layout.ts'
import { PROP_CATALOG } from './prop-catalog.ts'
import {
  isSeatId,
  MAX_ADDED,
  type BoxItem,
  type FloorItem,
  type GlassItem,
  type PropItem,
  type PropType,
  type PropValue,
  type SceneItem,
  type ScenePatch,
  type SceneView,
  type Surface,
  type WallItem,
  type WindowItem,
} from './scene.ts'

// The editor's operations on a draft ScenePatch. Each takes the patch and the item as it is drawn
// now (defaults plus patch) and returns a new patch; nothing is mutated. Stock items change through
// `overrides[id]`, items the user added are edited in place in `added`.

/** Legacy type for ObjectPanel and EditTarget until Tasks 4 & 5 adapt them to structure items */
export type EditableItem = PropItem | WindowItem
export const isEditable = (item: SceneItem): item is EditableItem => Boolean(item)
/** Desks, beds, and the primary staircase cannot be deleted. */
export const canDelete = (item: SceneItem): boolean => !isSeatId(item.id) && item.id !== 'stairs'

export const GRID = 0.25
export const ROTATION_STEP = Math.PI / 12
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

const TAU = Math.PI * 2
// Four decimals keeps saved numbers small; `+ 0` turns -0 into 0.
const round4 = (value: number): number => Number(value.toFixed(4)) + 0
export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)
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

export function moveItem(patch: ScenePatch, item: SceneItem, x: number, z: number, bounds?: Bounds): ScenePatch {
  if (item.kind === 'floor') {
    const cx = (item.min[0] + item.max[0]) / 2
    const cz = (item.min[1] + item.max[1]) / 2
    const px = round4(bounds ? clampAround(x, bounds.minX, bounds.maxX, cx) : x)
    const pz = round4(bounds ? clampAround(z, bounds.minZ, bounds.maxZ, cz) : z)
    const dx = px - cx
    const dz = pz - cz
    if (dx === 0 && dz === 0) return patch
    const min: [number, number] = [round4(item.min[0] + dx), round4(item.min[1] + dz)]
    const max: [number, number] = [round4(item.max[0] + dx), round4(item.max[1] + dz)]
    return patchItem(patch, item.id, { min, max })
  }
  if (item.kind === 'wall' || item.kind === 'glass') {
    const mx = (item.from[0] + item.to[0]) / 2
    const mz = (item.from[1] + item.to[1]) / 2
    const px = round4(bounds ? clampAround(x, bounds.minX, bounds.maxX, mx) : x)
    const pz = round4(bounds ? clampAround(z, bounds.minZ, bounds.maxZ, mz) : z)
    const dx = px - mx
    const dz = pz - mz
    if (dx === 0 && dz === 0) return patch
    const from: [number, number] = [round4(item.from[0] + dx), round4(item.from[1] + dz)]
    const to: [number, number] = [round4(item.to[0] + dx), round4(item.to[1] + dz)]
    return patchItem(patch, item.id, { from, to })
  }
  if (item.kind === 'box' || item.kind === 'prop' || item.kind === 'window') {
    const px = round4(bounds ? clampAround(x, bounds.minX, bounds.maxX, item.position[0]) : x)
    const pz = round4(bounds ? clampAround(z, bounds.minZ, bounds.maxZ, item.position[2]) : z)
    if (px === item.position[0] && pz === item.position[2]) return patch
    return patchItem(patch, item.id, { position: [px, item.position[1], pz] })
  }
  return patch
}

/** Where a dragged object lands: movement snaps to the grid relative to where it started (items that sit off the grid, such as wall-mounted ones, keep their alignment and a click with jitter is a no-op), or is free with Alt; always clamped to the bounds (widened to include the origin, for items that start outside them). */
export function dragTarget(origin: [number, number], pointer: [number, number], free: boolean, bounds: Bounds): [number, number] {
  const step = (from: number, to: number) => from + (free ? to - from : snap(to - from))
  return [clampAround(step(origin[0], pointer[0]), bounds.minX, bounds.maxX, origin[0]), clampAround(step(origin[1], pointer[1]), bounds.minZ, bounds.maxZ, origin[1])]
}

export function rotateItem(patch: ScenePatch, item: SceneItem, radians: number): ScenePatch {
  if (item.kind === 'floor') {
    const cx = (item.min[0] + item.max[0]) / 2
    const cz = (item.min[1] + item.max[1]) / 2
    const hw = Math.abs(item.max[0] - item.min[0]) / 2
    const hd = Math.abs(item.max[1] - item.min[1]) / 2
    const min: [number, number] = [round4(cx - hd), round4(cz - hw)]
    const max: [number, number] = [round4(cx + hd), round4(cz + hw)]
    if (min[0] === item.min[0] && min[1] === item.min[1] && max[0] === item.max[0] && max[1] === item.max[1]) return patch
    return patchItem(patch, item.id, { min, max })
  }
  if (item.kind === 'wall' || item.kind === 'glass') {
    const mx = (item.from[0] + item.to[0]) / 2
    const mz = (item.from[1] + item.to[1]) / 2
    const dx = item.to[0] - item.from[0]
    const dz = item.to[1] - item.from[1]
    const sign = radians < 0 ? -1 : 1
    const rdx = -dz * sign
    const rdz = dx * sign
    const from: [number, number] = [round4(mx - rdx / 2), round4(mz - rdz / 2)]
    const to: [number, number] = [round4(mx + rdx / 2), round4(mz + rdz / 2)]
    return patchItem(patch, item.id, { from, to })
  }
  if (item.kind === 'box') {
    if (item.size[0] === item.size[2]) return patch
    const size: Vec3 = [item.size[2], item.size[1], item.size[0]]
    return patchItem(patch, item.id, { size })
  }
  if (item.kind === 'prop' || item.kind === 'window') {
    const norm = normalizeAngle(radians)
    if (norm === (item.rotation ?? 0)) return patch
    return patchItem(patch, item.id, { rotation: norm })
  }
  return patch
}

export function rotateBy(patch: ScenePatch, item: SceneItem, delta: number): ScenePatch {
  if (item.kind === 'prop' || item.kind === 'window') {
    return rotateItem(patch, item, (item.rotation ?? 0) + delta)
  }
  return rotateItem(patch, item, delta)
}

export function deleteItem(patch: ScenePatch, item: SceneItem): ScenePatch {
  if (!canDelete(item)) return patch
  if (patch.added.some((added) => added.id === item.id)) return { ...patch, added: patch.added.filter((added) => added.id !== item.id) }
  return { ...patch, overrides: { ...patch.overrides, [item.id]: null } }
}

/** Puts an item on another floor: its level changes and its height shifts by the same difference. */
export function setItemLevel(patch: ScenePatch, item: SceneItem, level: number): ScenePatch {
  if (level === item.level) return patch
  const dy = round4(level - item.level)
  if (item.kind === 'floor') {
    return patchItem(patch, item.id, { level, y: round4(item.y + dy) })
  }
  if (item.kind === 'wall') {
    return patchItem(patch, item.id, { level, y: round4(item.y + dy) })
  }
  if (item.kind === 'glass') {
    return patchItem(patch, item.id, { level, bottom: round4(item.bottom + dy), top: round4(item.top + dy) })
  }
  if (item.kind === 'box' || item.kind === 'prop' || item.kind === 'window') {
    const [x, y, z] = item.position
    return patchItem(patch, item.id, { level, position: [x, round4(y + dy), z] })
  }
  return patch
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
export function duplicateItem(patch: ScenePatch, items: SceneItem[], item: SceneItem, bounds: Bounds): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const id = nextAddedId(patch, items)

  if (item.kind === 'floor') {
    const min: [number, number] = [
      round4(clampAround(item.min[0] + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, item.min[0])),
      round4(clampAround(item.min[1] + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, item.min[1])),
    ]
    const max: [number, number] = [
      round4(clampAround(item.max[0] + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, item.max[0])),
      round4(clampAround(item.max[1] + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, item.max[1])),
    ]
    const copy: FloorItem = {
      kind: 'floor',
      id,
      level: item.level,
      min,
      max,
      y: item.y,
      surface: { ...item.surface },
      ...(item.roughness !== undefined ? { roughness: item.roughness } : {}),
      ...(item.view ? { view: item.view } : {}),
    }
    return { patch: { ...patch, added: [...patch.added, copy] }, id }
  }

  if (item.kind === 'wall') {
    const from: [number, number] = [
      round4(clampAround(item.from[0] + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, item.from[0])),
      round4(clampAround(item.from[1] + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, item.from[1])),
    ]
    const to: [number, number] = [
      round4(clampAround(item.to[0] + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, item.to[0])),
      round4(clampAround(item.to[1] + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, item.to[1])),
    ]
    const copy: WallItem = {
      kind: 'wall',
      id,
      level: item.level,
      from,
      to,
      y: item.y,
      height: item.height,
      ...(item.view ? { view: item.view } : {}),
    }
    return { patch: { ...patch, added: [...patch.added, copy] }, id }
  }

  if (item.kind === 'glass') {
    const from: [number, number] = [
      round4(clampAround(item.from[0] + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, item.from[0])),
      round4(clampAround(item.from[1] + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, item.from[1])),
    ]
    const to: [number, number] = [
      round4(clampAround(item.to[0] + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, item.to[0])),
      round4(clampAround(item.to[1] + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, item.to[1])),
    ]
    const copy: GlassItem = {
      kind: 'glass',
      id,
      level: item.level,
      from,
      to,
      bottom: item.bottom,
      top: item.top,
      ...(item.view ? { view: item.view } : {}),
    }
    return { patch: { ...patch, added: [...patch.added, copy] }, id }
  }

  if (item.kind === 'box') {
    const [x, y, z] = item.position
    const position: Vec3 = [
      round4(clampAround(x + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, x)),
      y,
      round4(clampAround(z + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, z)),
    ]
    const copy: BoxItem = {
      kind: 'box',
      id,
      level: item.level,
      position,
      size: [...item.size],
      color: item.color,
      ...(item.radius !== undefined ? { radius: item.radius } : {}),
      ...(item.roughness !== undefined ? { roughness: item.roughness } : {}),
      ...(item.opacity !== undefined ? { opacity: item.opacity } : {}),
      ...(item.shadow !== undefined ? { shadow: item.shadow } : {}),
      ...(item.view ? { view: item.view } : {}),
    }
    return { patch: { ...patch, added: [...patch.added, copy] }, id }
  }

  if (item.kind === 'prop') {
    const [x, y, z] = item.position
    const position: PropItem['position'] = [
      round4(clampAround(x + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, x)),
      y,
      round4(clampAround(z + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, z)),
    ]
    const copy: PropItem = {
      kind: 'prop',
      id,
      level: item.level,
      type: item.type,
      position,
      ...(item.rotation ? { rotation: item.rotation } : {}),
      ...(item.props ? { props: { ...item.props } } : {}),
      ...(item.view ? { view: item.view } : {}),
    }
    return { patch: { ...patch, added: [...patch.added, copy] }, id }
  }

  if (item.kind === 'window') {
    const [x, y, z] = item.position
    const position: WindowItem['position'] = [
      round4(clampAround(x + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, x)),
      y,
      round4(clampAround(z + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, z)),
    ]
    const copy: WindowItem = {
      kind: 'window',
      id,
      level: item.level,
      position,
      ...(item.rotation ? { rotation: item.rotation } : {}),
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.view ? { view: item.view } : {}),
    }
    return { patch: { ...patch, added: [...patch.added, copy] }, id }
  }

  return { patch, id: null }
}

/** Sets one prop (size, length, colour...) of a prop item. The whole props object is written, so a stock item's override replaces its props with the edited copy. */
export function setItemProp(patch: ScenePatch, item: SceneItem, key: string, value: PropValue): ScenePatch {
  if (item.kind !== 'prop' || item.props?.[key] === value) return patch
  return patchItem(patch, item.id, { props: { ...item.props, [key]: value } })
}

export function setFloorBounds(patch: ScenePatch, item: SceneItem, min: [number, number], max: [number, number]): ScenePatch {
  if (item.kind !== 'floor') return patch
  const normMin: [number, number] = [round4(Math.min(min[0], max[0])), round4(Math.min(min[1], max[1]))]
  const normMax: [number, number] = [round4(Math.max(min[0], max[0])), round4(Math.max(min[1], max[1]))]
  if (normMin[0] === item.min[0] && normMin[1] === item.min[1] && normMax[0] === item.max[0] && normMax[1] === item.max[1]) return patch
  return patchItem(patch, item.id, { min: normMin, max: normMax })
}

export function setFloorSurface(patch: ScenePatch, item: SceneItem, surface: Surface, roughness?: number): ScenePatch {
  if (item.kind !== 'floor') return patch
  const fields: Partial<FloorItem> = { surface: { ...surface } }
  if (roughness !== undefined) fields.roughness = round4(clamp(roughness, 0, 1))
  return patchItem(patch, item.id, fields)
}

export function setWallGeometry(patch: ScenePatch, item: SceneItem, from: [number, number], to: [number, number], height: number, y?: number): ScenePatch {
  if (item.kind !== 'wall') return patch
  const normFrom: [number, number] = [round4(from[0]), round4(from[1])]
  const normTo: [number, number] = [round4(to[0]), round4(to[1])]
  const h = round4(height)
  const fields: Partial<WallItem> = { from: normFrom, to: normTo, height: h }
  if (y !== undefined) fields.y = round4(y)
  return patchItem(patch, item.id, fields)
}

export function setGlassGeometry(patch: ScenePatch, item: SceneItem, from: [number, number], to: [number, number], bottom: number, top: number): ScenePatch {
  if (item.kind !== 'glass') return patch
  const normFrom: [number, number] = [round4(from[0]), round4(from[1])]
  const normTo: [number, number] = [round4(to[0]), round4(to[1])]
  const b = round4(Math.min(bottom, top))
  const t = round4(Math.max(bottom, top))
  return patchItem(patch, item.id, { from: normFrom, to: normTo, bottom: b, top: t })
}

export interface BoxPropsOptions {
  radius?: number
  roughness?: number
  opacity?: number
  shadow?: boolean
}

export function setBoxProps(patch: ScenePatch, item: SceneItem, size: Vec3, color: string, options?: BoxPropsOptions): ScenePatch {
  if (item.kind !== 'box') return patch
  const normSize: Vec3 = [round4(size[0]), round4(size[1]), round4(size[2])]
  const fields: Partial<BoxItem> = {
    size: normSize,
    color,
    ...(options?.radius !== undefined ? { radius: round4(options.radius) } : {}),
    ...(options?.roughness !== undefined ? { roughness: round4(clamp(options.roughness, 0, 1)) } : {}),
    ...(options?.opacity !== undefined ? { opacity: round4(clamp(options.opacity, 0, 1)) } : {}),
    ...(options?.shadow !== undefined ? { shadow: options.shadow } : {}),
  }
  return patchItem(patch, item.id, fields)
}

export const setBoxTransform = setBoxProps

export function setItemView(patch: ScenePatch, item: SceneItem, view?: SceneView): ScenePatch {
  if (item.view === view) return patch
  return patchItem(patch, item.id, { view })
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
