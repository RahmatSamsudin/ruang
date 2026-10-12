import { Fragment, type ComponentType, type ReactNode } from 'react'
import { AcOutdoorUnit, AirConditioner, ArcadeCabinet, Armchair, BaksoStall, BathroomFittings, Beanbag, Bed, Bookshelf, CarromTable, ClothesLine, CoffeeTable, FlagPole, FloorCushion, Fridge, GalonDispenser, Hammock, KopiStall, LowTable, MeetingTable, Nightstand, OfficeLight, PantryCounter, PingPongTable, Plant, Railing, RattanChair, RBox, SideTable, Sofa, Staircase, StreetLamp, StringLights, Television, Tree, WallClock, Wardrobe, WaterTank, WorkDesk } from './props.tsx'
import { visibleAt, type BoxItem, type FloorItem, type GlassItem, type PropItem, type PropType, type SceneItem, type Surface, type WallItem, type WindowItem } from './scene.ts'
import { asphalt, carpet, grass, pavingStones, tileFloor, woodFloor } from './textures.ts'

// Draws scene items (scene.ts) with the procedural props and primitives. Which items are drawn
// depends on the level in view; see visibleAt.

const WALL = '#efe6d6'
const WALL_TOP = '#d9cdb8'
const THICK = 0.25

// Props take different extra props (color, size, length, ...), so the registry is loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, react-refresh/only-export-components
export const PROP_COMPONENTS: Record<PropType, ComponentType<any>> = {
  AcOutdoorUnit, AirConditioner, ArcadeCabinet, Armchair, BaksoStall, BathroomFittings, Beanbag, Bed, Bookshelf, CarromTable, ClothesLine,
  CoffeeTable, FlagPole, FloorCushion, Fridge, GalonDispenser, Hammock, KopiStall, LowTable, MeetingTable, Nightstand, OfficeLight,
  PantryCounter, PingPongTable, Plant, Railing, RattanChair, SideTable, Sofa, Staircase, StreetLamp, StringLights, Television, Tree,
  WallClock, Wardrobe, WaterTank, WorkDesk,
}

function surfaceTexture({ type, repeat, color }: Surface) {
  switch (type) {
    case 'wood': return woodFloor(repeat)
    case 'tile': return tileFloor(repeat)
    case 'carpet': return carpet(color ?? '#888888', repeat)
    case 'grass': return grass(repeat)
    case 'asphalt': return asphalt(repeat)
    case 'paving': return pavingStones(repeat)
  }
}

function PropNode({ item, night, active }: { item: PropItem; night: boolean; active: boolean }) {
  const Component = PROP_COMPONENTS[item.type]
  if (!Component) return null // a type from a newer or older save: skip it rather than crash the office
  // item.props first, so a save can never override position, rotation, night or active.
  return <Component {...item.props} position={item.position} rotation={item.rotation} night={night} active={active}/>
}

function FloorNode({ item }: { item: FloorItem }) {
  const [x1, z1] = item.min
  const [x2, z2] = item.max
  return <mesh position={[(x1 + x2) / 2, item.y, (z1 + z2) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
    <planeGeometry args={[Math.abs(x2 - x1), Math.abs(z2 - z1)]}/>
    <meshStandardMaterial map={surfaceTexture(item.surface)} color="#ffffff" roughness={item.roughness ?? 0.8}/>
  </mesh>
}

function WallNode({ item }: { item: WallItem }) {
  const [x1, z1] = item.from
  const [x2, z2] = item.to
  const length = Math.hypot(x2 - x1, z2 - z1)
  const angle = Math.atan2(z2 - z1, x2 - x1)
  return <group position={[(x1 + x2) / 2, item.y, (z1 + z2) / 2]} rotation={[0, -angle, 0]}>
    <RBox position={[0, item.height / 2, 0]} size={[length + THICK, item.height, THICK]} radius={0.02} color={WALL} roughness={0.9}/>
    <RBox position={[0, item.height + 0.02, 0]} size={[length + THICK + 0.02, 0.05, THICK + 0.04]} radius={0.01} color={WALL_TOP}/>
  </group>
}

/** An axis-aligned glass pane: along x when the pane runs mostly in x, otherwise along z. */
function GlassNode({ item }: { item: GlassItem }) {
  const [x1, z1] = item.from
  const [x2, z2] = item.to
  const height = item.top - item.bottom
  const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1)
  return <RBox position={[(x1 + x2) / 2, (item.bottom + item.top) / 2, (z1 + z2) / 2]} size={alongX ? [Math.abs(x2 - x1), height, 0.05] : [0.05, height, Math.abs(z2 - z1)]} radius={0.01} color="#cfe8ee" opacity={0.25} roughness={0.05} shadow={false}/>
}

function WindowNode({ item, night }: { item: WindowItem; night: boolean }) {
  const width = item.width ?? 1.8
  return <group position={item.position} rotation={[0, item.rotation ?? 0, 0]}>
    <RBox position={[0, 0, 0]} size={[width + 0.12, 1.22, 0.12]} radius={0.02} color="#5a4636"/>
    <mesh position={[0, 0, 0.065]}><planeGeometry args={[width, 1.1]}/><meshStandardMaterial color={night ? '#2d3f5c' : '#9fd3ea'} emissive={night ? '#1c2c4a' : '#6fb6d6'} emissiveIntensity={0.35} roughness={0.05} metalness={0.2}/></mesh>
    <RBox position={[0, 0, 0.08]} size={[0.05, 1.1, 0.03]} radius={0.01} color="#5a4636"/>
  </group>
}

function BoxNode({ item }: { item: BoxItem }) {
  return <RBox position={item.position} size={item.size} radius={item.radius} color={item.color} roughness={item.roughness} opacity={item.opacity} shadow={item.shadow}/>
}

function SceneNode({ item, night, active }: { item: SceneItem; night: boolean; active: boolean }) {
  switch (item.kind) {
    case 'prop': return <PropNode item={item} night={night} active={active}/>
    case 'floor': return <FloorNode item={item}/>
    case 'wall': return <WallNode item={item}/>
    case 'glass': return <GlassNode item={item}/>
    case 'window': return <WindowNode item={item} night={night}/>
    case 'box': return <BoxNode item={item}/>
    default: return null
  }
}

/**
 * The items visible from `level`. `deskActive(id)` says whether the seat of a `desk-N` item is
 * occupied. `wrap` lets the editor surround an item's node (for picking) without the renderer
 * knowing about editing.
 */
export function SceneRenderer({ items, level, night, deskActive, wrap, viewMode = 'cutaway' }: { items: SceneItem[]; level: number; night: boolean; deskActive?: (id: string) => boolean; wrap?: (item: SceneItem, node: ReactNode) => ReactNode; viewMode?: 'cutaway' | 'shell' }) {
  return <group>
    {items.filter((item) => visibleAt(item, level, viewMode)).map((item) => {
      const node = <SceneNode item={item} night={night} active={deskActive?.(item.id) ?? false}/>
      return <Fragment key={item.id}>{wrap ? wrap(item, node) : node}</Fragment>
    })}
  </group>
}
