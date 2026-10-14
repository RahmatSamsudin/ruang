import { BUILDING, FLOOR_HEIGHT, type Vec3 } from '../office3d-layout.ts'
import { PROP_CATALOG } from './prop-catalog.ts'
import {
  isSeatId,
  levelsOf,
  MAX_ADDED,
  type BoxItem,
  type EditableItem,
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

// Pure geometric and patch operations for the scene editor. Every edit takes the scene as it is
// now (defaults plus patch) and returns a new patch; nothing is mutated. Stock items change through
// `overrides[id]`, items the user added are edited in place in `added`.

export type { EditableItem }
export const isEditable = (item: SceneItem): item is EditableItem => item !== null
/** Desks, beds, and the primary staircase cannot be deleted. */
export const canDelete = (item: SceneItem): boolean => !isSeatId(item.id) && item.id !== 'stairs'

export const GRID = 0.25
export const ROTATION_STEP = Math.PI / 12
export const WALL_HEIGHT = 2.6
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

const TAU = Math.PI * 2
// Four decimals keeps saved numbers small; `+ 0` turns -0 into 0.
const round4 = (value: number): number => Number(value.toFixed(4)) + 0
export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)
const safeNum = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback)
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
    if (Math.abs(radians) < 1e-6) return patch
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

export type StructureKind = 'floor' | 'wall' | 'glass' | 'box'

/** Adds a new structure primitive (floor slab, wall segment, glass partition, box shape) with architectural defaults. */
export function addStructureItem(
  patch: ScenePatch,
  items: SceneItem[],
  kind: StructureKind,
  x: number,
  z: number,
  level: number,
  bounds: Bounds,
): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const [px, pz] = placePoint([x, z], true, bounds)
  const id = nextAddedId(patch, items)
  const safeLevel = round4(safeNum(level, 0))

  if (kind === 'floor') {
    const item: FloorItem = {
      kind: 'floor',
      id,
      level: safeLevel,
      min: [round4(px - 2), round4(pz - 2)],
      max: [round4(px + 2), round4(pz + 2)],
      y: round4(safeLevel + 0.005),
      surface: { type: 'wood', repeat: [2, 2] },
      roughness: 0.55,
    }
    return { patch: { ...patch, added: [...patch.added, item] }, id }
  }

  if (kind === 'wall') {
    const item: WallItem = {
      kind: 'wall',
      id,
      level: safeLevel,
      from: [round4(px - 2), round4(pz)],
      to: [round4(px + 2), round4(pz)],
      y: safeLevel,
      height: 2.6,
    }
    return { patch: { ...patch, added: [...patch.added, item] }, id }
  }

  if (kind === 'glass') {
    const item: GlassItem = {
      kind: 'glass',
      id,
      level: safeLevel,
      from: [round4(px - 1.5), round4(pz)],
      to: [round4(px + 1.5), round4(pz)],
      bottom: safeLevel,
      top: round4(safeLevel + 2.2),
    }
    return { patch: { ...patch, added: [...patch.added, item] }, id }
  }

  if (kind === 'box') {
    const item: BoxItem = {
      kind: 'box',
      id,
      level: safeLevel,
      position: [px, round4(safeLevel + 0.5), pz],
      size: [1, 1, 1],
      color: '#a0a0a0',
      roughness: 0.5,
    }
    return { patch: { ...patch, added: [...patch.added, item] }, id }
  }

  return { patch, id: null }
}

/** Produces a copy of `item` offset to the drag center [dragX, dragZ] for live rendering in the editor canvas. */
export function dragPreviewItem(item: EditableItem, dragX: number, dragZ: number): EditableItem {
  if (item.kind === 'floor') {
    const cx = (item.min[0] + item.max[0]) / 2
    const cz = (item.min[1] + item.max[1]) / 2
    const dx = dragX - cx
    const dz = dragZ - cz
    return { ...item, min: [round4(item.min[0] + dx), round4(item.min[1] + dz)], max: [round4(item.max[0] + dx), round4(item.max[1] + dz)] }
  }
  if (item.kind === 'wall' || item.kind === 'glass') {
    const cx = (item.from[0] + item.to[0]) / 2
    const cz = (item.from[1] + item.to[1]) / 2
    const dx = dragX - cx
    const dz = dragZ - cz
    return { ...item, from: [round4(item.from[0] + dx), round4(item.from[1] + dz)], to: [round4(item.to[0] + dx), round4(item.to[1] + dz)] }
  }
  return { ...item, position: [dragX, item.position[1], dragZ] }
}

/** A copy of an editable item as drawn now, half a metre over; the bounds are widened to include the original so items outside them (trees) can be copied. */
export function duplicateItem(patch: ScenePatch, items: SceneItem[], item: SceneItem, bounds: Bounds): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const id = nextAddedId(patch, items)

  if (item.kind === 'floor') {
    const effMinX = Math.min(bounds.minX, item.min[0])
    const effMaxX = Math.max(bounds.maxX, item.max[0])
    const effMinZ = Math.min(bounds.minZ, item.min[1])
    const effMaxZ = Math.max(bounds.maxZ, item.max[1])
    const dx = clamp(DUPLICATE_OFFSET, effMinX - item.min[0], effMaxX - item.max[0])
    const dz = clamp(DUPLICATE_OFFSET, effMinZ - item.min[1], effMaxZ - item.max[1])
    const min: [number, number] = [round4(item.min[0] + dx), round4(item.min[1] + dz)]
    const max: [number, number] = [round4(item.max[0] + dx), round4(item.max[1] + dz)]
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
    const minX = Math.min(item.from[0], item.to[0])
    const maxX = Math.max(item.from[0], item.to[0])
    const minZ = Math.min(item.from[1], item.to[1])
    const maxZ = Math.max(item.from[1], item.to[1])
    const effMinX = Math.min(bounds.minX, minX)
    const effMaxX = Math.max(bounds.maxX, maxX)
    const effMinZ = Math.min(bounds.minZ, minZ)
    const effMaxZ = Math.max(bounds.maxZ, maxZ)
    const dx = clamp(DUPLICATE_OFFSET, effMinX - minX, effMaxX - maxX)
    const dz = clamp(DUPLICATE_OFFSET, effMinZ - minZ, effMaxZ - maxZ)
    const from: [number, number] = [round4(item.from[0] + dx), round4(item.from[1] + dz)]
    const to: [number, number] = [round4(item.to[0] + dx), round4(item.to[1] + dz)]
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
    const minX = Math.min(item.from[0], item.to[0])
    const maxX = Math.max(item.from[0], item.to[0])
    const minZ = Math.min(item.from[1], item.to[1])
    const maxZ = Math.max(item.from[1], item.to[1])
    const effMinX = Math.min(bounds.minX, minX)
    const effMaxX = Math.max(bounds.maxX, maxX)
    const effMinZ = Math.min(bounds.minZ, minZ)
    const effMaxZ = Math.max(bounds.maxZ, maxZ)
    const dx = clamp(DUPLICATE_OFFSET, effMinX - minX, effMaxX - maxX)
    const dz = clamp(DUPLICATE_OFFSET, effMinZ - minZ, effMaxZ - maxZ)
    const from: [number, number] = [round4(item.from[0] + dx), round4(item.from[1] + dz)]
    const to: [number, number] = [round4(item.to[0] + dx), round4(item.to[1] + dz)]
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

export function setFloorBounds(patch: ScenePatch, item: SceneItem, min: [number, number], max: [number, number], y?: number): ScenePatch {
  if (item.kind !== 'floor') return patch
  const minX = Math.min(safeNum(min[0]), safeNum(max[0]))
  const maxX = Math.max(safeNum(min[0]), safeNum(max[0]))
  const minZ = Math.min(safeNum(min[1]), safeNum(max[1]))
  const maxZ = Math.max(safeNum(min[1]), safeNum(max[1]))
  const width = clamp(maxX - minX, 0.5, 100)
  const depth = clamp(maxZ - minZ, 0.5, 100)
  const normMin: [number, number] = [round4(minX), round4(minZ)]
  const normMax: [number, number] = [round4(minX + width), round4(minZ + depth)]
  const clampedY = y !== undefined ? round4(item.level + clamp(safeNum(y, item.y) - item.level, -5, 5)) : undefined
  if (normMin[0] === item.min[0] && normMin[1] === item.min[1] && normMax[0] === item.max[0] && normMax[1] === item.max[1] && (clampedY === undefined || clampedY === item.y)) return patch
  const fields: Partial<FloorItem> = { min: normMin, max: normMax }
  if (clampedY !== undefined) fields.y = clampedY
  return patchItem(patch, item.id, fields)
}

export function setFloorSurface(patch: ScenePatch, item: SceneItem, surface: Surface, roughness?: number): ScenePatch {
  if (item.kind !== 'floor') return patch
  const fields: Partial<FloorItem> = { surface: { ...surface } }
  if (roughness !== undefined) fields.roughness = round4(clamp(safeNum(roughness), 0, 1))
  return patchItem(patch, item.id, fields)
}

export function setWallGeometry(patch: ScenePatch, item: SceneItem, from: [number, number], to: [number, number], height: number, y?: number): ScenePatch {
  if (item.kind !== 'wall') return patch
  const normFrom: [number, number] = [round4(safeNum(from[0])), round4(safeNum(from[1]))]
  let toX = safeNum(to[0])
  let toZ = safeNum(to[1])
  const dx = toX - normFrom[0]
  const dz = toZ - normFrom[1]
  const len = Math.hypot(dx, dz)
  if (len === 0) {
    toX = normFrom[0] + 0.25
    toZ = normFrom[1]
  } else if (len < 0.25) {
    toX = normFrom[0] + (dx / len) * 0.25
    toZ = normFrom[1] + (dz / len) * 0.25
  } else if (len > 100) {
    toX = normFrom[0] + (dx / len) * 100
    toZ = normFrom[1] + (dz / len) * 100
  }
  const normTo: [number, number] = [round4(toX), round4(toZ)]
  const h = round4(clamp(safeNum(height, 0.1), 0.1, 10.0))
  const fields: Partial<WallItem> = { from: normFrom, to: normTo, height: h }
  if (y !== undefined) fields.y = round4(safeNum(y))
  return patchItem(patch, item.id, fields)
}

export function setGlassGeometry(patch: ScenePatch, item: SceneItem, from: [number, number], to: [number, number], bottom: number, top: number): ScenePatch {
  if (item.kind !== 'glass') return patch
  const normFrom: [number, number] = [round4(safeNum(from[0])), round4(safeNum(from[1]))]
  let toX = safeNum(to[0])
  let toZ = safeNum(to[1])
  const dx = toX - normFrom[0]
  const dz = toZ - normFrom[1]
  const len = Math.hypot(dx, dz)
  if (len === 0) {
    toX = normFrom[0] + 0.25
    toZ = normFrom[1]
  } else if (len < 0.25) {
    toX = normFrom[0] + (dx / len) * 0.25
    toZ = normFrom[1] + (dz / len) * 0.25
  } else if (len > 100) {
    toX = normFrom[0] + (dx / len) * 100
    toZ = normFrom[1] + (dz / len) * 100
  }
  const normTo: [number, number] = [round4(toX), round4(toZ)]

  let bRel = clamp(safeNum(bottom, item.bottom) - item.level, -20, 20)
  let tRel = clamp(safeNum(top, item.top) - item.level, -20, 20)
  if (bRel > tRel) {
    const tmp = bRel
    bRel = tRel
    tRel = tmp
  }
  if (tRel - bRel < 0.1) {
    if (bRel + 0.1 <= 20) {
      tRel = bRel + 0.1
    } else {
      bRel = tRel - 0.1
    }
  }

  return patchItem(patch, item.id, { from: normFrom, to: normTo, bottom: round4(item.level + bRel), top: round4(item.level + tRel) })
}

export interface BoxPropsOptions {
  radius?: number
  roughness?: number
  opacity?: number
  shadow?: boolean
  position?: Vec3
}

export function setBoxProps(patch: ScenePatch, item: SceneItem, size: Vec3, color: string, options?: BoxPropsOptions): ScenePatch {
  if (item.kind !== 'box') return patch
  const normSize: Vec3 = [
    round4(clamp(safeNum(size[0], 0.05), 0.05, 50.0)),
    round4(clamp(safeNum(size[1], 0.05), 0.05, 50.0)),
    round4(clamp(safeNum(size[2], 0.05), 0.05, 50.0)),
  ]
  const fields: Partial<BoxItem> = {
    size: normSize,
    color,
    ...(options?.position !== undefined ? { position: [round4(safeNum(options.position[0])), round4(safeNum(options.position[1])), round4(safeNum(options.position[2]))] as Vec3 } : {}),
    ...(options?.radius !== undefined ? { radius: round4(clamp(safeNum(options.radius), 0, 0.5)) } : {}),
    ...(options?.roughness !== undefined ? { roughness: round4(clamp(safeNum(options.roughness), 0, 1)) } : {}),
    ...(options?.opacity !== undefined ? { opacity: round4(clamp(safeNum(options.opacity), 0, 1)) } : {}),
    ...(options?.shadow !== undefined ? { shadow: options.shadow } : {}),
  }
  return patchItem(patch, item.id, fields)
}

export function setItemView(patch: ScenePatch, item: SceneItem, view: SceneView = 'cutaway'): ScenePatch {
  const targetView: SceneView = view ?? 'cutaway'
  if (item.view === targetView) return patch
  return patchItem(patch, item.id, { view: targetView })
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

function appendItem(patch: ScenePatch, item: SceneItem): ScenePatch {
  if (patch.added.length >= MAX_ADDED) return patch
  return { ...patch, added: [...patch.added, item] }
}

function wallCovers(sw: WallItem, w: WallItem, eps = 0.05): boolean {
  if (sw.level !== w.level) return false
  if (sw.id === `${w.id}-shell`) return true

  // Exact endpoint match (either direction)
  const matchDirect =
    Math.abs(sw.from[0] - w.from[0]) <= eps &&
    Math.abs(sw.from[1] - w.from[1]) <= eps &&
    Math.abs(sw.to[0] - w.to[0]) <= eps &&
    Math.abs(sw.to[1] - w.to[1]) <= eps
  const matchRev =
    Math.abs(sw.from[0] - w.to[0]) <= eps &&
    Math.abs(sw.from[1] - w.to[1]) <= eps &&
    Math.abs(sw.to[0] - w.from[0]) <= eps &&
    Math.abs(sw.to[1] - w.from[1]) <= eps
  if (matchDirect || matchRev) return true

  // Both on constant X (vertical on 2D plane)
  const swX = Math.abs(sw.from[0] - sw.to[0]) <= eps
  const wX = Math.abs(w.from[0] - w.to[0]) <= eps
  if (swX && wX && Math.abs(sw.from[0] - w.from[0]) <= eps) {
    const swMinZ = Math.min(sw.from[1], sw.to[1])
    const swMaxZ = Math.max(sw.from[1], sw.to[1])
    const wMinZ = Math.min(w.from[1], w.to[1])
    const wMaxZ = Math.max(w.from[1], w.to[1])
    return swMinZ <= wMinZ + eps && swMaxZ >= wMaxZ - eps
  }

  // Both on constant Z (horizontal on 2D plane)
  const swZ = Math.abs(sw.from[1] - sw.to[1]) <= eps
  const wZ = Math.abs(w.from[1] - w.to[1]) <= eps
  if (swZ && wZ && Math.abs(sw.from[1] - w.from[1]) <= eps) {
    const swMinX = Math.min(sw.from[0], sw.to[0])
    const swMaxX = Math.max(sw.from[0], sw.to[0])
    const wMinX = Math.min(w.from[0], w.to[0])
    const wMaxX = Math.max(w.from[0], w.to[0])
    return swMinX <= wMinX + eps && swMaxX >= wMaxX - eps
  }

  return false
}

/**
 * Inspects items on `fromLevel` and ensures perimeter walls have matching full-height (2.6m) shell walls
 * with `view: 'shell'`, so lower storeys appear closed when viewed from above.
 */
/**
 * Resolves the bounding box for a storey's footprint.
 * Derives from the union of active floors and walls on that level.
 * On a degenerate extent (e.g. single axis-aligned wall or 0 depth/width),
 * uses passed bounds before hardcoded BUILDING.
 */
export function resolveStoreyBounds(
  items: readonly SceneItem[],
  level: number,
  bounds?: Bounds,
): Bounds {
  const EPSILON = 0.05
  const storeyWalls = items.filter((it): it is WallItem => it.level === level && it.kind === 'wall')
  const storeyFloors = items.filter(
    (it): it is FloorItem =>
      it.level === level &&
      it.kind === 'floor' &&
      !/balcony|lawn|sidewalk|road|gang/i.test(it.id),
  )

  const xs = [
    ...storeyFloors.flatMap((f) => [f.min[0], f.max[0]]),
    ...storeyWalls.flatMap((w) => [w.from[0], w.to[0]]),
  ]
  const zs = [
    ...storeyFloors.flatMap((f) => [f.min[1], f.max[1]]),
    ...storeyWalls.flatMap((w) => [w.from[1], w.to[1]]),
  ]

  let storeyB: Bounds | null = null
  if (xs.length > 0 && zs.length > 0) {
    storeyB = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    }
  }

  const isDegenerate = (box?: Bounds | null): boolean =>
    !box || Math.abs(box.maxX - box.minX) <= EPSILON || Math.abs(box.maxZ - box.minZ) <= EPSILON

  // On degenerate or missing extent, use passed bounds before hardcoded BUILDING
  if (!storeyB || isDegenerate(storeyB)) {
    return bounds && !isDegenerate(bounds) ? bounds : BUILDING
  }

  // If outer bounds like camera pan was passed, prefer storey footprint
  if (bounds && !isDegenerate(bounds)) {
    const isOuterBounds =
      bounds.minX < storeyB.minX - EPSILON ||
      bounds.maxX > storeyB.maxX + EPSILON ||
      bounds.minZ < storeyB.minZ - EPSILON ||
      bounds.maxZ > storeyB.maxZ + EPSILON
    if (isOuterBounds) {
      return storeyB
    }
    const isStoreyExpanded =
      storeyB.minX < bounds.minX - EPSILON ||
      storeyB.maxX > bounds.maxX + EPSILON ||
      storeyB.minZ < bounds.minZ - EPSILON ||
      storeyB.maxZ > bounds.maxZ + EPSILON
    if (isStoreyExpanded) {
      return storeyB
    }
    return bounds
  }

  return storeyB
}

export function generateStoreyShell(
  patch: ScenePatch,
  items: readonly SceneItem[] = [],
  fromLevel?: number,
  bounds?: Bounds,
): ScenePatch {
  const allItems: SceneItem[] = [
    ...(items ?? []).flatMap((it) => {
      const o = patch.overrides[it.id]
      if (o === null) return []
      if (o && typeof o === 'object') return [{ ...it, ...o } as SceneItem]
      return [it]
    }),
    ...patch.added,
  ]

  const targetLevel = fromLevel ?? (levelsOf(allItems).length > 0 ? Math.max(...levelsOf(allItems)) : 0)

  // Collect all walls on targetLevel, respecting patch overrides
  const activeWalls = allItems.filter((it): it is WallItem => it.kind === 'wall' && it.level === targetLevel)
  if (activeWalls.length === 0) return patch

  const EPSILON = 0.05
  const b = resolveStoreyBounds(allItems, targetLevel, bounds)

  let nextPatch = patch

  for (const w of activeWalls) {
    const isPerimeter =
      (Math.abs(w.from[0] - b.minX) <= EPSILON && Math.abs(w.to[0] - b.minX) <= EPSILON) ||
      (Math.abs(w.from[0] - b.maxX) <= EPSILON && Math.abs(w.to[0] - b.maxX) <= EPSILON) ||
      (Math.abs(w.from[1] - b.minZ) <= EPSILON && Math.abs(w.to[1] - b.minZ) <= EPSILON) ||
      (Math.abs(w.from[1] - b.maxZ) <= EPSILON && Math.abs(w.to[1] - b.maxZ) <= EPSILON)

    if (!isPerimeter) continue

    // If w is already a shell wall:
    if (w.view === 'shell') {
      continue
    }

    // If w is already full height visible in both cutaway and shell views:
    if (w.view === 'both' && w.height === WALL_HEIGHT) {
      continue
    }

    // Check if an existing shell wall already covers w in activeWalls
    const existingShell = activeWalls.find(
      (sw) => sw.view === 'shell' && wallCovers(sw, w, EPSILON),
    )
    if (existingShell) {
      continue
    }

    // Otherwise create a new matching shell wall
    let shellId = `${w.id}-shell`
    const used = new Set<string>([
      ...(items ?? []).map((it) => it.id),
      ...nextPatch.added.map((it) => it.id),
      ...Object.keys(nextPatch.overrides),
    ])
    if (used.has(shellId)) {
      shellId = nextAddedId(nextPatch, (items ?? []) as SceneItem[])
    }

    const shellWall: WallItem = {
      kind: 'wall',
      id: shellId,
      level: targetLevel,
      from: [w.from[0], w.from[1]],
      to: [w.to[0], w.to[1]],
      y: targetLevel,
      height: WALL_HEIGHT,
      view: 'shell',
    }
    nextPatch = appendItem(nextPatch, shellWall)
    activeWalls.push(shellWall)
  }

  return nextPatch
}

export const DEFAULT_STAIRWELL_CUTOUT: Bounds = {
  minX: 1.8,
  maxX: 4.7,
  minZ: 2.95,
  maxZ: 3.95,
}

export interface AddStoreyOptions {
  stairwellCutout?: boolean | Bounds
}

export interface AddStoreyResult {
  patch: ScenePatch
  level: number
  id: string | null
}

/**
 * Adds a new storey:
 * 1. Calculates new level = highest level + FLOOR_HEIGHT (2.8m).
 * 2. Generates closed shell walls for the storey below so it renders properly when viewed from above.
 * 3. Adds a base floor slab on the new level spanning bounds (or storey below bounds), optionally leaving a stairwell cutout.
 * Returns `{ patch, level, id }`.
 */
export function addStorey(
  patch: ScenePatch,
  items: readonly SceneItem[] = [],
  bounds?: Bounds,
  options?: AddStoreyOptions,
): AddStoreyResult {
  const allItems: SceneItem[] = [
    ...(items ?? []).flatMap((it) => {
      const o = patch.overrides[it.id]
      if (o === null) return []
      if (o && typeof o === 'object') return [{ ...it, ...o } as SceneItem]
      return [it]
    }),
    ...patch.added,
  ]
  const levels = levelsOf(allItems)
  const highest = levels.length > 0 ? Math.max(...levels) : 0
  const newLevel = round4(highest + FLOOR_HEIGHT)
  const fromLevel = highest

  // 1. Generate closed shell walls for the storey below
  let nextPatch = generateStoreyShell(patch, allItems, fromLevel, bounds)

  // 2. Determine bounds for the new floor slab matching storey below
  const b = resolveStoreyBounds(allItems, fromLevel, bounds)

  // 3. Add base floor slab on newLevel
  if (nextPatch.added.length >= MAX_ADDED) {
    return { patch: nextPatch, level: newLevel, id: null }
  }

  const cutout = options?.stairwellCutout === true
    ? DEFAULT_STAIRWELL_CUTOUT
    : typeof options?.stairwellCutout === 'object' && options.stairwellCutout !== null
      ? options.stairwellCutout
      : null

  if (cutout) {
    const cutMinX = Math.min(cutout.minX, cutout.maxX)
    const cutMaxX = Math.max(cutout.minX, cutout.maxX)
    const cutMinZ = Math.min(cutout.minZ, cutout.maxZ)
    const cutMaxZ = Math.max(cutout.minZ, cutout.maxZ)

    const overlaps = cutMinX < b.maxX && cutMaxX > b.minX && cutMinZ < b.maxZ && cutMaxZ > b.minZ
    if (overlaps) {
      const hx1 = Math.max(b.minX, cutMinX)
      const hx2 = Math.min(b.maxX, cutMaxX)
      const hz1 = Math.max(b.minZ, cutMinZ)
      const hz2 = Math.min(b.maxZ, cutMaxZ)

      const rects: [number, number, number, number][] = []
      if (hz1 > b.minZ) rects.push([b.minX, b.maxX, b.minZ, hz1])
      if (b.maxZ > hz2) rects.push([b.minX, b.maxX, hz2, b.maxZ])
      if (hx1 > b.minX && hz2 > hz1) rects.push([b.minX, hx1, hz1, hz2])
      if (b.maxX > hx2 && hz2 > hz1) rects.push([hx2, b.maxX, hz1, hz2])

      let primaryId: string | null = null
      for (const [x1, x2, z1, z2] of rects) {
        if (x2 - x1 < 0.05 || z2 - z1 < 0.05) continue
        if (nextPatch.added.length >= MAX_ADDED) break
        const floorId = nextAddedId(nextPatch, (items ?? []) as SceneItem[])
        if (!primaryId) primaryId = floorId
        const slabFloor: FloorItem = {
          kind: 'floor',
          id: floorId,
          level: newLevel,
          min: [round4(x1), round4(z1)],
          max: [round4(x2), round4(z2)],
          y: newLevel,
          surface: { type: 'wood', repeat: [4, 4] },
          roughness: 0.55,
        }
        nextPatch = appendItem(nextPatch, slabFloor)
      }

      return { patch: nextPatch, level: newLevel, id: primaryId }
    }
  }

  const floorId = nextAddedId(nextPatch, (items ?? []) as SceneItem[])
  const newFloor: FloorItem = {
    kind: 'floor',
    id: floorId,
    level: newLevel,
    min: [round4(b.minX), round4(b.minZ)],
    max: [round4(b.maxX), round4(b.maxZ)],
    y: newLevel,
    surface: { type: 'wood', repeat: [4, 4] },
    roughness: 0.55,
  }

  nextPatch = appendItem(nextPatch, newFloor)
  return { patch: nextPatch, level: newLevel, id: floorId }
}
