import type { Vec3 } from '../office3d-layout.ts'

// The 3D office as data: a flat list of items, a saved patch against it, and the rules for which
// items are drawn from which level. The default scene is generated in default-scene.ts and the
// patch is stored by the server (server/scene.ts mirrors these shapes by hand).

/** Components a scene item may name. server/scene.ts keeps the same list; its test checks they match. */
export const PROP_TYPES = [
  'AcOutdoorUnit', 'AirConditioner', 'ArcadeCabinet', 'Armchair', 'BaksoStall', 'BathroomFittings', 'Beanbag', 'Bed',
  'Bookshelf', 'CarromTable', 'ClothesLine', 'CoffeeTable', 'FlagPole', 'FloorCushion', 'Fridge', 'GalonDispenser',
  'Hammock', 'KopiStall', 'LowTable', 'MeetingTable', 'Nightstand', 'OfficeLight', 'PantryCounter', 'PingPongTable',
  'Plant', 'Railing', 'RattanChair', 'SideTable', 'Sofa', 'Staircase', 'StreetLamp', 'StringLights', 'Television',
  'Tree', 'WallClock', 'Wardrobe', 'WaterTank', 'WorkDesk',
] as const
export type PropType = typeof PROP_TYPES[number]
export type PropValue = number | string | boolean

/** The most items a saved patch may add. server/scene.ts keeps the same number; its test checks they match. */
export const MAX_ADDED = 500

/** `cutaway` (default): drawn when its own level is viewed. `shell`: drawn from higher levels. `both`: either. */
export type SceneView = 'cutaway' | 'shell' | 'both'
export type SurfaceType = 'wood' | 'tile' | 'carpet' | 'grass' | 'asphalt' | 'paving'
export interface Surface { type: SurfaceType; repeat: [number, number]; color?: string }

interface Base { id: string; /** Base height of the storey this item belongs to. */ level: number; view?: SceneView }
export interface PropItem extends Base { kind: 'prop'; type: PropType; position: Vec3; rotation?: number; props?: Record<string, PropValue> }
export interface FloorItem extends Base { kind: 'floor'; min: [number, number]; max: [number, number]; y: number; surface: Surface; roughness?: number }
export interface WallItem extends Base { kind: 'wall'; from: [number, number]; to: [number, number]; y: number; height: number }
export interface GlassItem extends Base { kind: 'glass'; from: [number, number]; to: [number, number]; bottom: number; top: number }
export interface WindowItem extends Base { kind: 'window'; position: Vec3; rotation?: number; width?: number }
export interface BoxItem extends Base { kind: 'box'; position: Vec3; size: Vec3; color: string; radius?: number; roughness?: number; opacity?: number; shadow?: boolean }
export type SceneItem = PropItem | FloorItem | WallItem | GlassItem | WindowItem | BoxItem

export interface ScenePatch {
  version: 1
  /** Fields to merge into the item with that id; `null` deletes it (desks and beds cannot be deleted). */
  overrides: Record<string, Partial<SceneItem> | null>
  added: SceneItem[]
}
export const EMPTY_PATCH: ScenePatch = { version: 1, overrides: {}, added: [] }

/** Viewing `active` draws its cut-away items and the shell items of the levels below it. */
export function visibleAt(item: SceneItem, active: number): boolean {
  if (item.level > active) return false
  const view = item.view ?? 'cutaway'
  return item.level === active ? view !== 'shell' : view !== 'cutaway'
}

export const levelsOf = (items: SceneItem[]): number[] => [...new Set(items.map((item) => item.level))].sort((a, b) => a - b)

/** The level (from the sorted `levels`) a given height belongs to. Each level extends down to the midpoint with the level below it, so an agent halfway up the stairs counts as upstairs. */
export function levelAt(levels: number[], y: number): number {
  let found = levels[0] ?? 0
  for (let i = 1; i < levels.length; i++) if (y > (levels[i - 1] + levels[i]) / 2) found = levels[i]
  return found
}

/** The seat number of a `desk-N` id (anything else, such as `tree-1`, has none). */
export const deskSeatNumber = (id: string): number | undefined => {
  const match = /^desk-(\d+)$/.exec(id)
  return match ? Number(match[1]) : undefined
}

// One desk and one bed per agent come from the crew, so a patch can move them but not remove them.
const SEAT_ID = /^(desk|bed)-\d+$/
/** True for the crew's `desk-N` / `bed-N` ids. */
export const isSeatId = (id: string): boolean => SEAT_ID.test(id)

export function applyPatch(items: SceneItem[], patch?: ScenePatch): SceneItem[] {
  if (!patch) return items
  const overrides = typeof patch.overrides === 'object' && patch.overrides !== null ? patch.overrides : {}
  const result: SceneItem[] = []
  for (const item of items) {
    const override = Object.hasOwn(overrides, item.id) ? overrides[item.id] : undefined
    if (override === null) {
      if (SEAT_ID.test(item.id)) result.push(item)
      continue
    }
    result.push(typeof override === 'object' ? { ...item, ...override, id: item.id, kind: item.kind } as SceneItem : item)
  }
  const taken = new Set(items.map((item) => item.id))
  for (const added of Array.isArray(patch.added) ? patch.added : []) {
    if (typeof added !== 'object' || added === null || typeof added.id !== 'string') continue
    if (taken.has(added.id) || SEAT_ID.test(added.id)) continue
    taken.add(added.id)
    result.push(added)
  }
  return result
}

/** Positions of `desk-N` / `bed-N` items in numeric order of N. */
export function seatPositions(items: SceneItem[], prefix: 'desk' | 'bed'): Vec3[] {
  const own = new RegExp(`^${prefix}-(\\d+)$`)
  return items
    .flatMap((item) => (item.kind === 'prop' && own.test(item.id) ? [{ n: Number(own.exec(item.id)![1]), position: item.position }] : []))
    .sort((a, b) => a.n - b.n)
    .map((seat) => seat.position)
}
