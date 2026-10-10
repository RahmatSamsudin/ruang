import type { PropType, PropValue } from './scene.ts'

// What the editor knows about each object type: how it is listed in the palette, how high a new one
// is mounted, which props its component needs (and cannot default itself), and which of them the
// object panel lets you edit. Typed as a Record so a new PropType without an entry fails to compile.

export const GROUPS = ['Furniture', 'Kitchen', 'Leisure', 'Bedroom', 'Outdoor', 'Structure'] as const
export type PropGroup = typeof GROUPS[number]

export type Field =
  | { key: string; label: string; kind: 'number'; min: number; max: number; step: number }
  | { key: string; label: string; kind: 'color' }

export interface PropEntry {
  label: string
  group: PropGroup
  /** Height above the floor level a new one is placed at (0, or the wall/ceiling height the stock scene uses). */
  y: number
  /** Shown as the palette tooltip. */
  note?: string
  /** Props copied into a new item, so what is saved is what is drawn. */
  defaults?: Record<string, PropValue>
  fields?: Field[]
}

const number = (key: string, label: string, min: number, max: number, step: number): Field => ({ key, label, kind: 'number', min, max, step })
const size = (min: number, max: number): Field => number('size', 'Size', min, max, 0.1)
// StringLights and ClothesLine break (NaN bulbs, clothes outside the posts) when very short, so they ask for a larger minimum.
const length = (max: number, min = 0.5): Field => number('length', 'Length (m)', min, max, 0.25)
const color: Field = { key: 'color', label: 'Color', kind: 'color' }
const SEAT_NOTE = 'Decoration, not an agent seat'

export const PROP_CATALOG: Record<PropType, PropEntry> = {
  AcOutdoorUnit: { label: 'Outdoor AC unit', group: 'Outdoor', y: 0 },
  AirConditioner: { label: 'Air conditioner', group: 'Structure', y: 2.3 },
  ArcadeCabinet: { label: 'Arcade cabinet', group: 'Leisure', y: 0, defaults: { color: '#c62828' }, fields: [color] },
  Armchair: { label: 'Armchair', group: 'Furniture', y: 0, defaults: { color: '#d9784a' }, fields: [color] },
  BaksoStall: { label: 'Bakso stall', group: 'Outdoor', y: 0 },
  BathroomFittings: { label: 'Bathroom fittings', group: 'Bedroom', y: 0 },
  Beanbag: { label: 'Beanbag', group: 'Leisure', y: 0, defaults: { color: '#e76f51' }, fields: [color] },
  Bed: { label: 'Bed', group: 'Bedroom', y: 0, note: SEAT_NOTE, defaults: { color: '#3d7fd6' }, fields: [color] },
  Bookshelf: { label: 'Bookshelf', group: 'Furniture', y: 0 },
  CarromTable: { label: 'Carrom table', group: 'Leisure', y: 0 },
  ClothesLine: { label: 'Clothes line', group: 'Outdoor', y: 0, defaults: { length: 2.4 }, fields: [length(6, 1.5)] },
  CoffeeTable: { label: 'Coffee table', group: 'Furniture', y: 0 },
  FlagPole: { label: 'Flag pole', group: 'Outdoor', y: 0 },
  FloorCushion: { label: 'Floor cushion', group: 'Leisure', y: 0, defaults: { color: '#e9c46a' }, fields: [color] },
  Fridge: { label: 'Fridge', group: 'Kitchen', y: 0 },
  GalonDispenser: { label: 'Water dispenser', group: 'Kitchen', y: 0 },
  Hammock: { label: 'Hammock', group: 'Leisure', y: 0 },
  KopiStall: { label: 'Kopi stall', group: 'Outdoor', y: 0 },
  LowTable: { label: 'Low table', group: 'Furniture', y: 0 },
  MeetingTable: { label: 'Meeting table', group: 'Furniture', y: 0 },
  Nightstand: { label: 'Nightstand', group: 'Bedroom', y: 0 },
  OfficeLight: { label: 'Ceiling light', group: 'Structure', y: 2.4 },
  PantryCounter: { label: 'Pantry counter', group: 'Kitchen', y: 0 },
  PingPongTable: { label: 'Ping-pong table', group: 'Leisure', y: 0 },
  Plant: { label: 'Plant', group: 'Furniture', y: 0, defaults: { size: 1 }, fields: [size(0.4, 2.5)] },
  Railing: { label: 'Railing', group: 'Structure', y: 0, defaults: { length: 2 }, fields: [length(20)] },
  RattanChair: { label: 'Rattan chair', group: 'Furniture', y: 0 },
  SideTable: { label: 'Side table', group: 'Furniture', y: 0 },
  Sofa: { label: 'Sofa', group: 'Furniture', y: 0, defaults: { color: '#5b6f8c' }, fields: [color] },
  Staircase: {
    label: 'Staircase', group: 'Structure', y: 0, defaults: { run: 3, rise: 2.8, width: 0.9 },
    fields: [number('run', 'Run (m, − flips)', -20, 20, 0.25), number('rise', 'Rise (m)', 0.5, 6, 0.1), number('width', 'Width (m)', 0.5, 4, 0.1)],
  },
  StreetLamp: { label: 'Street lamp', group: 'Outdoor', y: 0 },
  StringLights: { label: 'String lights', group: 'Structure', y: 2.15, defaults: { length: 3 }, fields: [length(20, 1)] },
  Television: { label: 'Television', group: 'Leisure', y: 1.35 },
  Tree: { label: 'Tree', group: 'Outdoor', y: 0, defaults: { size: 1 }, fields: [size(0.5, 3)] },
  WallClock: { label: 'Wall clock', group: 'Structure', y: 2.35 },
  Wardrobe: { label: 'Wardrobe', group: 'Bedroom', y: 0 },
  WaterTank: { label: 'Water tank', group: 'Outdoor', y: 0 },
  WorkDesk: { label: 'Work desk', group: 'Furniture', y: 0, note: SEAT_NOTE },
}
