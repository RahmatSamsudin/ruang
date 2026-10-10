import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { PROP_CATALOG } from './prop-catalog.ts'
import { PROP_COMPONENTS } from './scene-renderer.tsx'
import { dragTarget, placePoint, type Bounds, type EditableItem } from './scene-edit.ts'
import type { PropType } from './scene.ts'

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

/** A yellow box around the selected object, following its world bounds each frame. */
function SelectionBox({ target }: { target: RefObject<THREE.Group | null> }) {
  const box = useMemo(() => new THREE.Box3(), [])
  const helper = useMemo(() => new THREE.Box3Helper(box, new THREE.Color('#f5bd6d')), [box])
  useEffect(() => () => { helper.dispose() }, [helper])
  useFrame(() => { if (target.current) box.setFromObject(target.current) })
  return <primitive object={helper}/>
}

/**
 * Makes one editable item pickable and draggable: press selects it, dragging moves it across the
 * horizontal plane at its own height (grid snap, Alt for free placement, clamped to the bounds).
 * The live position goes to previewDrag; one drag is one commitMove on release.
 */
export function EditTarget({ item, edit, children }: { item: EditableItem; edit: EditHandlers; children: ReactNode }) {
  const { camera, gl } = useThree()
  const group = useRef<THREE.Group>(null)
  const height = item.position[1]
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
    const offset: [number, number] = [item.position[0] - start[0], item.position[2] - start[1]]
    const origin: [number, number] = [item.position[0], item.position[2]]
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
    <group ref={group} onPointerDown={onPointerDown}
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
    {edit.selectedId === item.id && <SelectionBox target={group}/>}
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
export function PlacementLayer({ type, level, bounds, night, onPlace, onExit }: { type: PropType; level: number; bounds: Bounds; night: boolean; onPlace: (x: number, z: number) => void; onExit: () => void }) {
  const { camera, gl } = useThree()
  const entry = PROP_CATALOG[type]
  const Component = PROP_COMPONENTS[type]
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
    <Component {...entry.defaults} position={[0, entry.y, 0]} night={night} active={false}/>
  </group>
}
