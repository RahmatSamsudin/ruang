import { ARCADES, BALCONY, BALCONY_DOOR, BALCONY_TABLE, BATHROOM, BEANBAGS, CARROM, COFFEE_TABLE, ENTRANCE_X, FLAG, FLOOR_HEIGHT, GAME_DOOR, GAME_ROOM, GAME_TV, HAMMOCK, LESEHAN_TABLE, LOUNGE_PARTITION_END_Z, MEETING_TABLE, PARTITION_X, PING_PONG, SOFA, STAIRS, STALL_ROTATION, TV, type OfficeLayout, type Vec3 } from '../office3d-layout.ts'
import type { PropType, PropValue, SceneItem, SceneView, Surface } from './scene.ts'

// The stock office as data, generated for the crew size in `layout`. Each call below is one element
// of what used to be hard-coded JSX in environment.tsx (and the desks in Office3D.tsx). Coordinates
// are written relative to the scope's level and stored absolute. View per scope:
//   cut   : lantai 1 as a cut-away (drawn when lantai 1 is viewed)
//   shell : lantai 1 closed up (drawn from lantai 2)
//   both  : drawn either way (stairs, back/left walls, the outdoors)
//   up    : lantai 2 (y is relative to FLOOR_HEIGHT)

const WALL = '#efe6d6'
const WALL_TOP = '#d9cdb8'
const WALL_HEIGHT = 2.6
const GLASS_TOP = WALL_HEIGHT - 0.2
const H = FLOOR_HEIGHT

type P2 = [number, number]
const wood = (repeat: P2 = [4, 4]): Surface => ({ type: 'wood', repeat })
const tile = (repeat: P2): Surface => ({ type: 'tile', repeat })
const rug = (color: string, repeat: P2): Surface => ({ type: 'carpet', color, repeat })
const paving = (repeat: P2): Surface => ({ type: 'paving', repeat })

function scope(items: SceneItem[], level: number, view: SceneView = 'cutaway') {
  const tag = { level, ...(view === 'cutaway' ? {} : { view }) }
  const lift = ([x, y, z]: Vec3): Vec3 => [x, level + y, z]
  return {
    prop(id: string, type: PropType, position: Vec3, extra: { rotation?: number; props?: Record<string, PropValue> } = {}) {
      items.push({ kind: 'prop', id, type, position: lift(position), ...extra, ...tag })
    },
    floor(id: string, y: number, [cx, cz]: P2, [w, d]: P2, surface: Surface, roughness?: number) {
      items.push({ kind: 'floor', id, y: level + y, min: [cx - w / 2, cz - d / 2], max: [cx + w / 2, cz + d / 2], surface, ...(roughness === undefined ? {} : { roughness }), ...tag })
    },
    wall(id: string, from: P2, to: P2, height = WALL_HEIGHT) {
      items.push({ kind: 'wall', id, from, to, y: level, height, ...tag })
    },
    glass(id: string, from: P2, to: P2, bottom: number, top = GLASS_TOP) {
      items.push({ kind: 'glass', id, from, to, bottom: level + bottom, top: level + top, ...tag })
    },
    window(id: string, position: Vec3, rotation = 0, width?: number) {
      items.push({ kind: 'window', id, position: lift(position), ...(rotation === 0 ? {} : { rotation }), ...(width === undefined ? {} : { width }), ...tag })
    },
    box(id: string, position: Vec3, size: Vec3, color: string, extra: { radius?: number; roughness?: number; opacity?: number } = {}) {
      items.push({ kind: 'box', id, position: lift(position), size, color, ...extra, ...tag })
    },
  }
}

export function defaultScene(layout: OfficeLayout): SceneItem[] {
  const { minX, maxX, minZ, maxZ } = layout.building
  const g = GAME_ROOM
  const items: SceneItem[] = []
  const cut = scope(items, 0)
  const shell = scope(items, 0, 'shell')
  const both = scope(items, 0, 'both')
  const up = scope(items, H)

  // --- Lantai 1, cut-away: floors, walls, windows ------------------------------------------------
  cut.floor('floor-main', 0.005, [(minX + maxX) / 2, (minZ + maxZ) / 2], [maxX - minX, maxZ - minZ], wood(), 0.55)
  cut.floor('floor-pantry', 0.01, [8.35, 1.4], [2.3, 5.4], tile([3, 5]), 0.35)
  cut.floor('rug-lounge', 0.012, [4.6, -2.9], [4.4, 2.8], rug('#5b7c8c', [2, 2]))
  cut.floor('rug-meeting', 0.012, [-5.2, 2.2], [3.6, 3], rug('#8a4b3c', [2, 2]))
  both.wall('wall-back', [minX, minZ], [maxX, minZ])
  both.wall('wall-left', [minX, minZ], [minX, maxZ])
  cut.wall('wall-right-a', [maxX, minZ], [maxX, GAME_DOOR.fromZ], 1.1)
  cut.wall('wall-right-b', [maxX, GAME_DOOR.toZ], [maxX, maxZ], 1.1)
  cut.glass('glass-right-a', [maxX, minZ], [maxX, GAME_DOOR.fromZ], 1.1)
  cut.glass('glass-right-b', [maxX, GAME_DOOR.toZ], [maxX, g.maxZ], 1.1)
  cut.wall('wall-partition', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  cut.glass('glass-partition', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  cut.wall('wall-front-a', [minX, maxZ], [4.9, maxZ], 0.55)
  cut.wall('wall-front-b', [6.7, maxZ], [maxX, maxZ], 0.55)
  cut.wall('wall-meeting', [-3.2, 1], [-3.2, maxZ], 0.9)
  cut.box('glass-meeting', [-3.2, 1.35, 2.6], [0.06, 0.9, 3.2], '#cfe8ee', { radius: 0.01, opacity: 0.3, roughness: 0.05 })
  ;[1.3, 2.3, 3.3].forEach((z, index) => cut.prop(`planter-${index + 1}`, 'Plant', [0.9, 0, z], { props: { size: 0.8 } }))
  ;[-7, -3.6, 1.4, 6.6].forEach((x, index) => cut.window(`window-back-${index + 1}`, [x, 1.55, minZ + 0.14]))
  ;[-3, 0.6].forEach((z, index) => cut.window(`window-left-${index + 1}`, [minX + 0.14, 1.55, z], Math.PI / 2, 1.6))

  // --- Lantai 1: workspace, lounge, pantry -------------------------------------------------------
  layout.desks.forEach((position, index) => cut.prop(`desk-${index + 1}`, 'WorkDesk', position, { props: { withChair: true } }))
  cut.prop('meeting-table', 'MeetingTable', MEETING_TABLE)
  cut.prop('bookshelf-1', 'Bookshelf', [minX + 0.35, 0, -0.9], { rotation: Math.PI / 2 })
  cut.prop('plant-1', 'Plant', [minX + 0.5, 0, -4.6])
  cut.prop('plant-2', 'Plant', [-0.4, 0, -4.7], { props: { size: 0.9 } })
  cut.prop('wall-clock', 'WallClock', [-3.6, 2.35, minZ + 0.14])
  cut.prop('sofa', 'Sofa', SOFA, { rotation: Math.PI })
  // Armchairs sit exactly behind the lounge seats agents use (LOUNGE_SEATS 2 and 3).
  cut.prop('armchair-1', 'Armchair', [2.1, 0, -2.9], { rotation: Math.PI / 2, props: { color: '#d9784a' } })
  cut.prop('armchair-2', 'Armchair', [7.1, 0, -2.9], { rotation: -Math.PI / 2, props: { color: '#3d7fd6' } })
  cut.prop('coffee-table', 'CoffeeTable', COFFEE_TABLE)
  cut.box('tv-cabinet', [TV[0], 0.3, TV[2]], [1.8, 0.6, 0.45], '#6b4a32', { radius: 0.03 })
  cut.prop('tv', 'Television', [TV[0], 1.35, minZ + 0.17])
  cut.prop('plant-3', 'Plant', [2.1, 0, -4.6])
  cut.prop('galon', 'GalonDispenser', [maxX - 0.45, 0, -0.4], { rotation: -Math.PI / 2 })
  cut.prop('fridge', 'Fridge', [maxX - 0.5, 0, 0.6], { rotation: -Math.PI / 2 })
  cut.prop('pantry-counter', 'PantryCounter', [maxX - 0.45, 0, 2.6], { rotation: -Math.PI / 2 })
  cut.prop('ac-1', 'AirConditioner', [-5.3, 2.3, minZ + 0.125])
  cut.prop('ac-2', 'AirConditioner', [TV[0], 2.3, minZ + 0.125])
  cut.prop('ac-3', 'AirConditioner', [minX + 0.125, 2.3, 2.6], { rotation: Math.PI / 2 })
  layout.desks.forEach(([x, , z], index) => cut.prop(`light-desk-${index + 1}`, 'OfficeLight', [x, 2.4, z + 0.2]))
  cut.prop('light-meeting', 'OfficeLight', [MEETING_TABLE[0], 2.3, MEETING_TABLE[2]])
  cut.prop('light-coffee', 'OfficeLight', [COFFEE_TABLE[0], 2.4, COFFEE_TABLE[2] + 0.4])
  cut.prop('light-pantry', 'OfficeLight', [8.2, 2.4, 1.2])
  both.prop('stairs', 'Staircase', [STAIRS.lowX, 0, STAIRS.z], { props: { run: STAIRS.highX - STAIRS.lowX, rise: FLOOR_HEIGHT, width: STAIRS.width } })

  // --- Game room wing (cut-away) -----------------------------------------------------------------
  cut.floor('floor-game', 0.006, [(g.minX + g.maxX) / 2, (g.minZ + g.maxZ) / 2], [g.maxX - g.minX, g.maxZ - g.minZ], rug('#3b4170', [3, 3]), 0.9)
  both.wall('game-wall-back', [g.minX, g.minZ], [g.maxX, g.minZ])
  both.wall('game-wall-right', [g.maxX, g.minZ], [g.maxX, g.maxZ])
  cut.wall('game-wall-front', [g.minX, g.maxZ], [g.maxX, g.maxZ], 0.55)
  cut.window('game-window', [g.maxX - 0.14, 1.55, -2.2], -Math.PI / 2, 1.6)
  cut.prop('ping-pong', 'PingPongTable', PING_PONG)
  ARCADES.forEach((position, index) => cut.prop(`arcade-${index + 1}`, 'ArcadeCabinet', position, { props: { color: index === 0 ? '#c62828' : '#1d4ed8' } }))
  cut.box('game-tv-stand', [GAME_TV[0], 0.25, GAME_TV[2] + 0.2], [1.8, 0.5, 0.4], '#1f2328', { radius: 0.03 })
  cut.box('game-console', [GAME_TV[0] - 0.3, 0.55, GAME_TV[2] + 0.2], [0.36, 0.08, 0.26], '#f2f2f2', { radius: 0.02 })
  cut.prop('game-tv', 'Television', [GAME_TV[0], 1.35, GAME_TV[2] + 0.02])
  BEANBAGS.forEach((position, index) => cut.prop(`beanbag-${index + 1}`, 'Beanbag', position, { props: { color: index === 0 ? '#e76f51' : '#2a9d8f' } }))
  cut.prop('carrom', 'CarromTable', CARROM)
  cut.prop('plant-game', 'Plant', [g.maxX - 0.5, 0, g.maxZ - 0.5], { props: { size: 0.9 } })
  cut.prop('ac-game', 'AirConditioner', [(g.minX + g.maxX) / 2 - 0.6, 2.3, g.minZ + 0.125])
  cut.prop('light-game-1', 'OfficeLight', [PING_PONG[0], 2.4, PING_PONG[2]])
  cut.prop('light-game-2', 'OfficeLight', [ARCADES[0][0] + 0.5, 2.4, -3.6])
  cut.prop('light-game-3', 'OfficeLight', [GAME_TV[0], 2.4, -3.6])

  // --- Lantai 1 closed up, seen from lantai 2 ----------------------------------------------------
  shell.wall('wall-right-shell', [maxX, minZ], [maxX, maxZ])
  shell.wall('wall-front-shell-a', [minX, maxZ], [4.9, maxZ])
  shell.wall('wall-front-shell-b', [6.7, maxZ], [maxX, maxZ])
  shell.glass('glass-entrance', [4.9, maxZ], [6.7, maxZ], 0, 2.3)
  shell.box('entrance-lintel', [ENTRANCE_X, 2.45, maxZ], [1.9, 0.3, 0.3], WALL_TOP, { radius: 0.02 })
  ;[-7, -3.6, -0.2, 2.6, 8.1].forEach((x, index) => { if (x > minX + 1) shell.window(`window-front-${index + 1}`, [x, 1.45, maxZ + 0.14]) })
  ;[-3, 0.6, 3].forEach((z, index) => shell.window(`window-side-${index + 1}`, [minX - 0.14, 1.45, z], -Math.PI / 2, 1.6))
  shell.wall('game-wall-front-shell', [g.minX, g.maxZ], [g.maxX, g.maxZ])
  ;[11, 13.8].forEach((x, index) => shell.window(`game-window-front-${index + 1}`, [x, 1.45, g.maxZ + 0.14], 0, 1.4))
  shell.box('game-roof', [(g.minX + g.maxX) / 2, WALL_HEIGHT + 0.08, (g.minZ + g.maxZ) / 2], [g.maxX - g.minX + 0.3, 0.16, g.maxZ - g.minZ + 0.3], '#9a9a94', { radius: 0.02, roughness: 0.95 })
  shell.prop('water-tank', 'WaterTank', [14.2, WALL_HEIGHT + 0.16, -3.8])
  shell.prop('ac-outdoor-roof', 'AcOutdoorUnit', [11.2, WALL_HEIGHT + 0.16, -4.3])

  // --- Lantai 2: slab, walls, bedroom, lesehan, bathroom, balcony --------------------------------
  const hole = { minX: STAIRS.highX, maxX: STAIRS.lowX, minZ: STAIRS.z - STAIRS.width / 2 - 0.05, maxZ: STAIRS.z + STAIRS.width / 2 + 0.05 }
  // The slab, leaving the stairwell open: [minX, maxX, minZ, maxZ] pieces (the last is the balcony).
  const slab: [number, number, number, number][] = [
    [minX, maxX, minZ, hole.minZ], [minX, hole.minX, hole.minZ, hole.maxZ], [hole.maxX, maxX, hole.minZ, hole.maxZ], [minX, maxX, hole.maxZ, maxZ],
    [minX, maxX, BALCONY.minZ, BALCONY.maxZ],
  ]
  // Balcony columns run down to the sidewalk (ruko style); the beam carries the string lights.
  ;[minX + 0.15, (minX + maxX) / 2, maxX - 0.15].forEach((x, index) => up.box(`balcony-post-${index + 1}`, [x, (2.3 - H) / 2, BALCONY.maxZ - 0.12], [0.18, H + 2.3, 0.18], WALL, { radius: 0.02 }))
  up.box('balcony-beam', [(minX + maxX) / 2, 2.3, BALCONY.maxZ - 0.12], [maxX - minX, 0.12, 0.14], WALL_TOP, { radius: 0.02 })
  slab.forEach(([x1, x2, z1, z2], index) => up.box(`slab-${index + 1}`, [(x1 + x2) / 2, -0.11, (z1 + z2) / 2], [x2 - x1, 0.22, z2 - z1], '#cfc6b5', { radius: 0.01 }))
  slab.slice(0, 4).forEach(([x1, x2, z1, z2], index) => up.floor(`deck-${index + 1}`, 0.005, [(x1 + x2) / 2, (z1 + z2) / 2], [x2 - x1, z2 - z1], wood(), 0.55))
  up.floor('deck-balcony', 0.005, [(minX + maxX) / 2, (BALCONY.minZ + BALCONY.maxZ) / 2], [maxX - minX, BALCONY.maxZ - BALCONY.minZ], tile([6, 1]), 0.5)
  up.floor('rug-bedroom', 0.012, [(minX + PARTITION_X) / 2, -2.4], [PARTITION_X - minX - 0.4, 5], rug('#6d5a8c', [3, 3]))
  up.floor('rug-lesehan', 0.012, [LESEHAN_TABLE[0], LESEHAN_TABLE[2]], [3.4, 2.8], rug('#8c3b3b', [2, 2]))
  up.floor('floor-bathroom', 0.012, [(BATHROOM.minX + BATHROOM.maxX) / 2, (BATHROOM.minZ + BATHROOM.maxZ) / 2], [BATHROOM.maxX - BATHROOM.minX, BATHROOM.maxZ - BATHROOM.minZ], tile([2, 2]), 0.3)
  // Walls: full at the back and sides, glass sliding doors onto the balcony.
  up.wall('up-wall-back', [minX, minZ], [maxX, minZ])
  up.wall('up-wall-left', [minX, minZ], [minX, maxZ])
  up.wall('up-wall-right', [maxX, minZ], [maxX, maxZ])
  up.wall('up-front-a', [minX, maxZ], [BALCONY_DOOR.fromX, maxZ], 0.3)
  up.wall('up-front-b', [BALCONY_DOOR.toX, maxZ], [maxX, maxZ], 0.3)
  up.glass('up-glass-a', [minX, maxZ], [BALCONY_DOOR.fromX, maxZ], 0.3, 2.2)
  up.glass('up-glass-b', [BALCONY_DOOR.toX, maxZ], [maxX, maxZ], 0.3, 2.2)
  ;[-6, -2.4, 2.6].forEach((x, index) => { if (x > minX + 1) up.window(`up-window-${index + 1}`, [x, 1.55, minZ + 0.14]) })
  up.window('up-window-right', [maxX - 0.14, 1.55, 0.6], -Math.PI / 2, 1.6)
  // Bedroom: one bed per agent, a glass partition, wardrobes and bedside tables.
  up.wall('up-partition', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  up.glass('up-partition-glass', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  const blankets = ['#3d7fd6', '#e76f51', '#2a9d8f', '#e9c46a', '#8d5bc1', '#d64545']
  layout.beds.forEach(([x, , z], index) => up.prop(`bed-${index + 1}`, 'Bed', [x, 0, z], { props: { color: blankets[index % blankets.length] } }))
  layout.beds.forEach(([x, , z], index) => { if (z < -3) up.prop(`nightstand-${index + 1}`, 'Nightstand', [x - 0.85, 0, minZ + 0.4]) })
  up.prop('wardrobe-1', 'Wardrobe', [minX + 0.4, 0, 1.4], { rotation: Math.PI / 2 })
  up.prop('wardrobe-2', 'Wardrobe', [minX + 0.4, 0, 2.8], { rotation: Math.PI / 2 })
  up.prop('up-ac', 'AirConditioner', [(minX + PARTITION_X) / 2, 2.3, minZ + 0.125])
  // Lesehan corner.
  up.prop('low-table', 'LowTable', [LESEHAN_TABLE[0], 0, LESEHAN_TABLE[2]])
  ;([[-1, 0, '#e9c46a'], [1, 0, '#2a9d8f'], [0, -0.85, '#e76f51'], [0, 0.85, '#3d7fd6']] as [number, number, string][]).forEach(([dx, dz, color], index) => up.prop(`cushion-${index + 1}`, 'FloorCushion', [LESEHAN_TABLE[0] + dx, 0, LESEHAN_TABLE[2] + dz], { props: { color } }))
  up.prop('up-bookshelf', 'Bookshelf', [6.5, 0, minZ + 0.3])
  up.prop('up-plant-1', 'Plant', [1.1, 0, minZ + 0.5], { props: { size: 0.9 } })
  up.prop('up-plant-2', 'Plant', [7.1, 0, 1.4])
  // Bathroom: kamar mandi with a bak mandi.
  up.wall('bathroom-wall-a', [BATHROOM.minX, minZ], [BATHROOM.minX, BATHROOM.maxZ], 1.9)
  up.wall('bathroom-wall-b', [BATHROOM.minX, BATHROOM.maxZ], [8, BATHROOM.maxZ], 1)
  up.wall('bathroom-wall-c', [8.9, BATHROOM.maxZ], [maxX, BATHROOM.maxZ], 1)
  up.prop('bathroom-fittings', 'BathroomFittings', [8.2, 0, -2.6])
  // Railing around the stairwell.
  up.prop('railing-stairwell-a', 'Railing', [(hole.minX + hole.maxX) / 2, 0, hole.minZ], { props: { length: hole.maxX - hole.minX } })
  up.prop('railing-stairwell-b', 'Railing', [hole.maxX, 0, STAIRS.z], { rotation: Math.PI / 2, props: { length: hole.maxZ - hole.minZ } })
  const doorX = (BALCONY_DOOR.fromX + BALCONY_DOOR.toX) / 2
  layout.beds.forEach(([x, , z], index) => { if (index % 2 === 0) up.prop(`up-light-bed-${index + 1}`, 'OfficeLight', [x, 2.4, z + 0.6]) })
  up.prop('up-light-lesehan', 'OfficeLight', [LESEHAN_TABLE[0], 2.4, LESEHAN_TABLE[2]])
  up.prop('up-light-door', 'OfficeLight', [doorX, 2.4, 2])
  // Balcony.
  up.prop('balcony-railing-front', 'Railing', [(minX + maxX) / 2, 0, BALCONY.maxZ - 0.05], { props: { length: maxX - minX } })
  up.prop('balcony-railing-left', 'Railing', [minX + 0.05, 0, (BALCONY.minZ + BALCONY.maxZ) / 2], { rotation: Math.PI / 2, props: { length: BALCONY.maxZ - BALCONY.minZ } })
  up.prop('balcony-railing-right', 'Railing', [maxX - 0.05, 0, (BALCONY.minZ + BALCONY.maxZ) / 2], { rotation: Math.PI / 2, props: { length: BALCONY.maxZ - BALCONY.minZ } })
  up.prop('side-table', 'SideTable', [BALCONY_TABLE[0], 0, BALCONY_TABLE[2]])
  up.prop('rattan-chair-1', 'RattanChair', [BALCONY_TABLE[0] - 0.85, 0, BALCONY_TABLE[2]], { rotation: Math.PI / 2 })
  up.prop('rattan-chair-2', 'RattanChair', [BALCONY_TABLE[0] + 0.85, 0, BALCONY_TABLE[2]], { rotation: -Math.PI / 2 })
  up.prop('hammock', 'Hammock', [HAMMOCK[0], 0, HAMMOCK[2]])
  up.prop('clothes-line', 'ClothesLine', [Math.max(minX + 1.6, -3.2), 0, 6.15])
  up.prop('balcony-plant-1', 'Plant', [maxX - 0.5, 0, BALCONY.minZ + 0.5], { props: { size: 0.9 } })
  up.prop('balcony-plant-2', 'Plant', [minX + 0.5, 0, BALCONY.minZ + 0.5], { props: { size: 0.9 } })
  up.prop('string-lights', 'StringLights', [(minX + maxX) / 2, 2.15, BALCONY.maxZ - 0.12], { props: { length: maxX - minX - 0.6 } })

  // --- Outdoors (drawn from either floor). The grounds grow with the building to the left. -------
  const shift = minX + 9.5
  both.floor('lawn', -0.02, [shift / 2, 2], [60 - shift, 44], { type: 'grass', repeat: [14, 12] }, 1)
  both.floor('sidewalk', -0.005, [shift / 2, 7.1], [34 - shift, 5], paving([14, 2]), 0.9)
  both.floor('road', -0.01, [shift / 2, 12.1], [60 - shift, 5], { type: 'asphalt', repeat: [8, 1] }, 0.95)
  both.floor('entrance-path', 0, [5.8, 4.7], [1.8, 1], paving([14, 2]))
  both.floor('gang', -0.008, [layout.gangCenterX, -0.4], [3.6, 10], paving([2, 5]), 0.9)
  both.prop('flag', 'FlagPole', FLAG)
  both.prop('bakso-stall', 'BaksoStall', layout.baksoCart, { rotation: STALL_ROTATION })
  both.prop('kopi-stall', 'KopiStall', layout.kopiBike, { rotation: STALL_ROTATION })
  both.prop('ac-outdoor-1', 'AcOutdoorUnit', [-5.3, 0, minZ - 0.45], { rotation: Math.PI })
  both.prop('ac-outdoor-2', 'AcOutdoorUnit', [TV[0] - 1.6, 0, minZ - 0.45], { rotation: Math.PI })
  both.prop('street-lamp-1', 'StreetLamp', [-8, 0, 9.3])
  both.prop('street-lamp-2', 'StreetLamp', [4, 0, 9.3])
  ;([[-12.8 + shift, -7.4, 1.3], [13.5, -7.2, 1.2], [-14.8 + shift, 2.6, 1.1], [18.6, 4.8, 1.3], [-10.5 + shift, 7.5, 1], [12, 8, 1.1], [-2, -8.5, 1.2], [6, -8, 1.1]] as [number, number, number][])
    .forEach(([x, z, size], index) => both.prop(`tree-${index + 1}`, 'Tree', [x, 0, z], { props: { size } }))

  return items
}
