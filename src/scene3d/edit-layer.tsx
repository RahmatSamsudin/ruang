import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { PROP_CATALOG } from './prop-catalog.ts'
import { PROP_COMPONENTS } from './scene-renderer.tsx'
import { dragTarget, placePoint, type Bounds, type EditableItem } from './scene-edit.ts'
import { isStructureType, itemCenter, type FloorItem, type PlaceableType, type PropType, type WallItem } from './scene.ts'

/** What the 3D layer needs from the editor session (Office3D builds this from useSceneEditor). */
export interface EditHandlers {
  selectedId: string | null
  bounds: Bounds
  select: (id: string | null) => void
  /** True while the pointer is over an editable object, so the camera does not take the press. */
  setHover: (hover: boolean) => void
  setDragging: (dragging: boolean) => void
  previewDrag: (id: string, x: number, z: number) => void
  commitMove: (item: EditableItem, x: number, z: number) => void
  cancelDrag: () => void
}

/** A bounding box around the selected object, following its world bounds each frame. */
export function SelectionBox({ target, color = '#f5bd6d' }: { target: RefObject<THREE.Group | null>; color?: string }) {
  const box = useMemo(() => new THREE.Box3(), [])
  const helper = useMemo(() => {
    const h = new THREE.Box3Helper(box, new THREE.Color(color))
    h.raycast = () => {}
    return h
  }, [box, color])
  useEffect(() => () => { helper.dispose() }, [helper])
  useFrame(() => { if (target.current) box.setFromObject(target.current) })
  return <primitive object={helper}/>
}

/** Glowing perimeter border and corner brackets on the floor slab surface so the slab selection is distinct. */
export function FloorSelection({ item }: { item: FloorItem }) {
  const [x1, z1] = item.min
  const [x2, z2] = item.max
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const minZ = Math.min(z1, z2)
  const maxZ = Math.max(z1, z2)
  const w = maxX - minX
  const d = maxZ - minZ
  const y = item.y + 0.008
  const bw = 0.08
  const cornerLen = Math.min(w / 4, d / 4, 0.6)
  const cornerBw = 0.12

  return <group raycast={() => {}}>
    {/* Perimeter ribbons */}
    <mesh position={[(minX + maxX) / 2, y, minZ + bw / 2]} raycast={() => {}}>
      <boxGeometry args={[w, 0.006, bw]}/>
      <meshBasicMaterial color="#f5bd6d" transparent opacity={0.8}/>
    </mesh>
    <mesh position={[(minX + maxX) / 2, y, maxZ - bw / 2]} raycast={() => {}}>
      <boxGeometry args={[w, 0.006, bw]}/>
      <meshBasicMaterial color="#f5bd6d" transparent opacity={0.8}/>
    </mesh>
    <mesh position={[minX + bw / 2, y, (minZ + maxZ) / 2]} raycast={() => {}}>
      <boxGeometry args={[bw, 0.006, d]}/>
      <meshBasicMaterial color="#f5bd6d" transparent opacity={0.8}/>
    </mesh>
    <mesh position={[maxX - bw / 2, y, (minZ + maxZ) / 2]} raycast={() => {}}>
      <boxGeometry args={[bw, 0.006, d]}/>
      <meshBasicMaterial color="#f5bd6d" transparent opacity={0.8}/>
    </mesh>

    {/* Bright corner brackets */}
    <mesh position={[minX + cornerLen / 2, y + 0.002, minZ + cornerBw / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerLen, 0.006, cornerBw]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>
    <mesh position={[minX + cornerBw / 2, y + 0.002, minZ + cornerLen / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerBw, 0.006, cornerLen]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>

    <mesh position={[maxX - cornerLen / 2, y + 0.002, minZ + cornerBw / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerLen, 0.006, cornerBw]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>
    <mesh position={[maxX - cornerBw / 2, y + 0.002, minZ + cornerLen / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerBw, 0.006, cornerLen]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>

    <mesh position={[minX + cornerLen / 2, y + 0.002, maxZ - cornerBw / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerLen, 0.006, cornerBw]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>
    <mesh position={[minX + cornerBw / 2, y + 0.002, maxZ - cornerLen / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerBw, 0.006, cornerLen]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>

    <mesh position={[maxX - cornerLen / 2, y + 0.002, maxZ - cornerBw / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerLen, 0.006, cornerBw]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>
    <mesh position={[maxX - cornerBw / 2, y + 0.002, maxZ - cornerLen / 2]} raycast={() => {}}>
      <boxGeometry args={[cornerBw, 0.006, cornerLen]}/>
      <meshBasicMaterial color="#f4d35e" transparent opacity={0.95}/>
    </mesh>
  </group>
}

/** Highlighted top cap edge and bounding box for walls. */
export function WallSelection({ item, target }: { item: WallItem; target: RefObject<THREE.Group | null> }) {
  const [x1, z1] = item.from
  const [x2, z2] = item.to
  const length = Math.hypot(x2 - x1, z2 - z1)
  const angle = Math.atan2(z2 - z1, x2 - x1)
  const topY = item.y + item.height + 0.045

  return <group raycast={() => {}}>
    <SelectionBox target={target} color="#fbbf24"/>
    <group position={[(x1 + x2) / 2, topY, (z1 + z2) / 2]} rotation={[0, -angle, 0]} raycast={() => {}}>
      <mesh raycast={() => {}}>
        <boxGeometry args={[length + 0.22, 0.015, 0.22]}/>
        <meshBasicMaterial color="#fde047" transparent opacity={0.85}/>
      </mesh>
    </group>
  </group>
}

/** Translucent cyan bounding edges for glass dividers. */
export function GlassSelection({ target }: { target: RefObject<THREE.Group | null> }) {
  return <SelectionBox target={target} color="#38bdf8"/>
}

/** Wireframe / bounding highlight matching object kind. */
export function SelectionFeedback({ item, target }: { item: EditableItem; target: RefObject<THREE.Group | null> }) {
  if (item.kind === 'floor') return <FloorSelection item={item}/>
  if (item.kind === 'wall') return <WallSelection item={item} target={target}/>
  if (item.kind === 'glass') return <GlassSelection target={target}/>
  return <SelectionBox target={target} color="#f5bd6d"/>
}

/**
 * Makes one editable item pickable and draggable: press selects it, dragging moves it across the
 * horizontal plane at its own height (grid snap, Alt for free placement, clamped to the bounds).
 * The live position goes to previewDrag; one drag is one commitMove on release.
 */
export function EditTarget({ item, edit, children }: { item: EditableItem; edit: EditHandlers; children: ReactNode }) {
  const { camera, gl } = useThree()
  const group = useRef<THREE.Group>(null)
  const [cx, cy, cz] = itemCenter(item)
  const height = cy
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), [])
  const ray = useMemo(() => new THREE.Raycaster(), [])
  const hit = useMemo(() => new THREE.Vector3(), [])
  const { setHover } = edit
  const hovered = useRef(false)
  // R3F does not fire pointer-out when a hovered object unmounts (deleted, floor change), so release the hover lock here.
  useEffect(() => () => { if (hovered.current) { setHover(false); document.body.style.cursor = '' } }, [setHover])

  const pointOnPlane = (clientX: number, clientY: number): [number, number] | null => {
    const rect = gl.domElement.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera)
    plane.constant = -height
    return ray.ray.intersectPlane(plane, hit) ? [hit.x, hit.z] : null
  }

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.nativeEvent.button !== 0) return
    event.stopPropagation()
    edit.select(item.id)
    const start = pointOnPlane(event.nativeEvent.clientX, event.nativeEvent.clientY)
    if (!start) return
    const offset: [number, number] = [cx - start[0], cz - start[1]]
    const origin: [number, number] = [cx, cz]
    let last = origin
    const pointerId = event.nativeEvent.pointerId
    edit.setDragging(true)
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      // The button was released outside the page (alt-tab): the pointerup never came, so end the drag here.
      if (pointer.buttons === 0) { up(pointer); return }
      const point = pointOnPlane(pointer.clientX, pointer.clientY)
      if (!point) return
      const [x, z] = dragTarget(origin, [point[0] + offset[0], point[1] + offset[1]], pointer.altKey, edit.bounds)
      if (x === last[0] && z === last[1]) return
      last = [x, z]
      edit.previewDrag(item.id, x, z)
    }
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      edit.setDragging(false)
      if (last[0] !== origin[0] || last[1] !== origin[1]) edit.commitMove(item, last[0], last[1])
      else edit.cancelDrag()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return <>
    <group ref={group} userData={{ itemId: item.id }} onPointerDown={onPointerDown}
      onPointerOver={(event) => {
        event.stopPropagation()
        // Not while a button is held (an orbit drag crossing this object): the camera must not stop mid-drag.
        if (event.nativeEvent.buttons) return
        hovered.current = true
        edit.setHover(true)
        document.body.style.cursor = 'grab'
      }}
      onPointerOut={() => { hovered.current = false; edit.setHover(false); document.body.style.cursor = '' }}>
      {children}
    </group>
    {edit.selectedId === item.id && <SelectionFeedback item={item} target={group}/>}
  </>
}

const CLICK_SLOP = 4
const OUTSIDE_SLACK = 1

/**
 * While placing: a translucent ghost of the object follows the pointer across the floor of the viewed
 * level (grid snap, Alt for free). A press-and-release under 4 px places it; a longer drag is the camera.
 * Right-click (without dragging) or Esc (handled by the page) leaves placing. Listeners sit on the canvas
 * element, not on scene objects, so existing items never take the click.
 */
export function PlacementLayer({ type, level, bounds, night, onPlace, onExit }: { type: PlaceableType; level: number; bounds: Bounds; night: boolean; onPlace: (x: number, z: number) => void; onExit: () => void }) {
  const { camera, gl } = useThree()
  const isModel = typeof type === 'string' && type.startsWith('model:')
  const entry = isStructureType(type) || isModel ? null : PROP_CATALOG[type as PropType]
  const Component = isStructureType(type) || isModel ? null : PROP_COMPONENTS[type as PropType]
  const ghost = useRef<THREE.Group>(null)
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), [])
  const ray = useMemo(() => new THREE.Raycaster(), [])
  const hit = useMemo(() => new THREE.Vector3(), [])
  const latest = useRef({ bounds, onPlace, onExit })
  latest.current = { bounds, onPlace, onExit }

  // Make the ghost translucent and unpickable once its meshes exist.
  useEffect(() => {
    ghost.current?.traverse((object) => {
      object.raycast = () => {}
      const material = (object as THREE.Mesh).material
      for (const one of Array.isArray(material) ? material : material ? [material] : []) { one.transparent = true; one.opacity = 0.55; one.needsUpdate = true }
    })
  }, [type])

  useEffect(() => {
    const canvas = gl.domElement
    plane.constant = -level
    // The ghost may already be showing (floor switch) at the old height until the next pointermove.
    if (ghost.current) ghost.current.position.y = level
    // A hit more than a metre outside the office is not a placement (it would otherwise land on the edge).
    const farOutside = (b: Bounds) => hit.x < b.minX - OUTSIDE_SLACK || hit.x > b.maxX + OUTSIDE_SLACK || hit.z < b.minZ - OUTSIDE_SLACK || hit.z > b.maxZ + OUTSIDE_SLACK
    const target = (event: PointerEvent): [number, number] | null => {
      const rect = canvas.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera)
      if (!ray.ray.intersectPlane(plane, hit) || farOutside(latest.current.bounds)) return null
      return placePoint([hit.x, hit.z], event.altKey, latest.current.bounds)
    }
    let down: { id: number; button: number; x: number; y: number } | null = null
    const onMove = (event: PointerEvent) => {
      const at = target(event)
      if (!ghost.current) return
      ghost.current.visible = at !== null
      if (at) ghost.current.position.set(at[0], level, at[1])
    }
    const onDown = (event: PointerEvent) => {
      // A second finger (pinch or pan) is never a click, and it cancels the one already pending.
      if (!event.isPrimary || (down && down.id !== event.pointerId)) { down = null; return }
      down = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY }
    }
    const onUp = (event: PointerEvent) => {
      const start = down
      down = null
      if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= CLICK_SLOP) return
      if (start.button === 2) { latest.current.onExit(); return }
      if (start.button !== 0) return
      const at = target(event)
      if (at) latest.current.onPlace(at[0], at[1])
    }
    const onContext = (event: Event) => event.preventDefault()
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('contextmenu', onContext)
    canvas.style.cursor = 'crosshair'
    return () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.style.cursor = ''
    }
  }, [camera, gl, hit, level, plane, ray])

  return <group ref={ghost} visible={false}>
    {type === 'floor' && (
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <planeGeometry args={[4, 4]} />
        <meshStandardMaterial color="#e5e7eb" transparent opacity={0.55} />
      </mesh>
    )}
    {type === 'wall' && (
      <mesh position={[0, 1.3, 0]}>
        <boxGeometry args={[4, 2.6, 0.2]} />
        <meshStandardMaterial color="#cbd5e1" transparent opacity={0.55} />
      </mesh>
    )}
    {type === 'glass' && (
      <mesh position={[0, 1.1, 0]}>
        <boxGeometry args={[3, 2.2, 0.1]} />
        <meshStandardMaterial color="#38bdf8" transparent opacity={0.45} />
      </mesh>
    )}
    {type === 'box' && (
      <mesh position={[0, 0.5, 0]}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#a0a0a0" transparent opacity={0.55} />
      </mesh>
    )}
    {isModel && (
      <mesh position={[0, 0.75, 0]}>
        <boxGeometry args={[1.5, 1.5, 1.5]} />
        <meshStandardMaterial color="#888888" wireframe transparent opacity={0.5} />
      </mesh>
    )}
    {Component && entry && <Component {...entry.defaults} position={[0, entry.y, 0]} night={night} active={false}/>}
  </group>
}
