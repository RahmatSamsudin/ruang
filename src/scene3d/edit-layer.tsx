import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useMemo, useRef, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { snap, type Bounds, type EditableItem } from './scene-edit.ts'

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
    edit.setDragging(true)
    const move = (pointer: PointerEvent) => {
      const point = pointOnPlane(pointer.clientX, pointer.clientY)
      if (!point) return
      const raw: [number, number] = [point[0] + offset[0], point[1] + offset[1]]
      const free = pointer.altKey
      const x = Math.min(Math.max(free ? raw[0] : snap(raw[0]), edit.bounds.minX), edit.bounds.maxX)
      const z = Math.min(Math.max(free ? raw[1] : snap(raw[1]), edit.bounds.minZ), edit.bounds.maxZ)
      last = [x, z]
      edit.previewDrag(item.id, x, z)
    }
    const up = () => {
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
      onPointerOver={(event) => { event.stopPropagation(); edit.setHover(true); document.body.style.cursor = 'grab' }}
      onPointerOut={() => { edit.setHover(false); document.body.style.cursor = '' }}>
      {children}
    </group>
    {edit.selectedId === item.id && <SelectionBox target={group}/>}
  </>
}
