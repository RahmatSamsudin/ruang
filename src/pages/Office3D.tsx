import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type MutableRefObject } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { officeStateBadge } from '../office-state.ts'
import { clampTarget, createLayout, FLOOR_HEIGHT, GAME_ROOM, idlePlan, placementFor, walkPath3, withMovedSeats, type OfficeLayout, type Placement, type Vec3 } from '../office3d-layout.ts'
import { defaultScene } from '../scene3d/default-scene.ts'
import { levelName } from '../scene3d/level-names.ts'
import { applyPatch, deskSeatNumber, levelAt, levelsOf, seatPositions, visibleAt } from '../scene3d/scene.ts'
import { EditTarget, type EditHandlers } from '../scene3d/edit-layer.tsx'
import { canDelete, deleteItem, editKeyAction, isEditable, moveItem, rotateBy, rotateItem, ROTATION_STEP, setItemLevel, type EditKeyAction } from '../scene3d/scene-edit.ts'
import { SceneRenderer } from '../scene3d/scene-renderer.tsx'
import { useSceneEditor } from '../scene3d/use-scene-editor.ts'
import { useScenePatch } from '../scene3d/use-scene.ts'
import { createSkinBoxGeometry, useSkinTexture, useSkins } from '../scene3d/skin.ts'
import type { OfficeStation } from '../types.ts'
import { EditorBar } from './EditorBar.tsx'
import { ObjectPanel } from './ObjectPanel.tsx'

// 3D view of the same Office snapshot the 2D view renders. Positions come from each station's
// room, roomPosition and seat, so the 3D office shows exactly the states the server derived.

type Registry<T> = MutableRefObject<Map<string, T>>

/** Ground-floor spots outside the building (gang, sidewalk, yard) stay in view from lantai 2. */
function outdoors(x: number, z: number, layout: OfficeLayout): boolean {
  const { minX, maxX, maxZ } = layout.building
  const inGameRoom = x > GAME_ROOM.minX && x < GAME_ROOM.maxX && z > GAME_ROOM.minZ && z < GAME_ROOM.maxZ
  return x < minX || z > maxZ || (x > maxX && !inGameRoom)
}

function Character({
  station,
  placement,
  layout,
  level,
  levels,
  onSelect,
  anchor,
  skinVersion,
}: {
  station: OfficeStation
  placement: Placement
  layout: OfficeLayout
  level: number
  levels: number[]
  onSelect: (station: OfficeStation, trigger: HTMLElement | null) => void
  anchor: (object: THREE.Object3D | null) => void
  skinVersion?: string
}) {
  const root = useRef<THREE.Group>(null)
  const body = useRef<THREE.Group>(null)
  const leftLeg = useRef<THREE.Mesh>(null)
  const rightLeg = useRef<THREE.Mesh>(null)
  const leftArm = useRef<THREE.Mesh>(null)
  const rightArm = useRef<THREE.Mesh>(null)
  const offline = station.state === 'Offline'
  const unknown = station.state === 'Unknown'
  const { texture, hasOverlay } = useSkinTexture(station.id, skinVersion)

  const baseMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.8,
    color: offline ? '#7b7f7d' : '#ffffff',
  }), [texture, offline])

  const overlayMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.8,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.FrontSide,
    color: offline ? '#7b7f7d' : '#ffffff',
  }), [texture, offline])

  useEffect(() => {
    return () => {
      baseMaterial.dispose()
      overlayMaterial.dispose()
    }
  }, [baseMaterial, overlayMaterial])

  // Only the first placement is applied as a prop; later changes are walked to via the aisle.
  const [start] = useState<Vec3>(() => placement.position)
  const path = useRef<THREE.Vector3[]>([])
  const destination = placement.position.join(',')
  useEffect(() => {
    const group = root.current
    if (!group) return
    path.current = walkPath3([group.position.x, group.position.y, group.position.z], placement.position, layout).map(([px, py, pz]) => new THREE.Vector3(px, py, pz))
    // placement.position is captured through `destination`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination])

  useFrame((state, delta) => {
    const group = root.current
    if (!group) return
    const time = state.clock.elapsedTime
    const next = path.current[0]
    let walking = false
    if (next) {
      const toNext = next.clone().sub(group.position)
      const distance = toNext.length()
      if (distance < 0.04) {
        path.current.shift()
      } else {
        walking = true
        group.position.add(toNext.clone().normalize().multiplyScalar(Math.min(distance, delta * 2.6)))
        if (Math.hypot(toNext.x, toNext.z) > 0.01) {
          const heading = Math.atan2(toNext.x, toNext.z)
          group.rotation.y += Math.atan2(Math.sin(heading - group.rotation.y), Math.cos(heading - group.rotation.y)) * 0.25
        }
      }
    }
    // Only the level in view is drawn; from higher levels the agents outside on the ground stay visible.
    const standingOn = levelAt(levels, group.position.y)
    group.visible = standingOn === level || (standingOn < level && outdoors(group.position.x, group.position.z, layout))
    if (!walking) group.rotation.y += Math.atan2(Math.sin(placement.facing - group.rotation.y), Math.cos(placement.facing - group.rotation.y)) * 0.12
    const swing = walking ? Math.sin(time * 10) * 0.6 : 0
    const arrived = !walking && path.current.length === 0
    const lying = arrived && placement.pose === 'lie'
    const onFloor = arrived && placement.pose === 'floor'
    // In bed (or the hammock) the body lines up with it exactly, not wherever the walk left it.
    if (lying) group.rotation.y = placement.facing
    const seated = !walking && (placement.seated || onFloor)
    if (leftLeg.current && rightLeg.current) {
      leftLeg.current.rotation.x = lying ? 0 : seated ? -Math.PI / 2.2 : swing
      rightLeg.current.rotation.x = lying ? 0 : seated ? -Math.PI / 2.2 : -swing
    }
    if (leftArm.current && rightArm.current) {
      const typing = !walking && (station.state === 'Working' || station.state === 'Reviewing')
      const talking = !walking && station.state === 'Collaborating'
      leftArm.current.rotation.x = lying ? 0 : walking ? -swing : typing ? -1.1 + Math.sin(time * 14) * 0.12 : talking ? -0.4 + Math.sin(time * 3) * 0.3 : 0
      rightArm.current.rotation.x = lying ? 0 : walking ? swing : typing ? -1.1 + Math.cos(time * 14) * 0.12 : 0
    }
    if (body.current) {
      // Lying down: the body tips back so the head rests towards the pillow (local -z).
      body.current.rotation.x += ((lying ? -Math.PI / 2 : 0) - body.current.rotation.x) * 0.2
      const talk = station.state === 'Collaborating' && !walking ? Math.abs(Math.sin(time * 5)) * 0.03 : 0
      const breathe = station.state === 'Idle' ? Math.sin(time * (lying ? 1.2 : 2)) * 0.015 : 0
      body.current.position.y = lying ? (placement.height ?? 0.5) + 0.16 + breathe : (onFloor ? -0.5 : seated ? -0.14 : 0) + talk + breathe
    }
  })

  return <group ref={root} position={start}>
    <group ref={body} onClick={(event) => { event.stopPropagation(); onSelect(station, null) }} onPointerOver={() => { document.body.style.cursor = 'pointer' }} onPointerOut={() => { document.body.style.cursor = '' }}>
      <mesh ref={leftLeg} position={[-0.11, 0.66, 0]} castShadow geometry={rightLegBaseGeometry} material={baseMaterial}>
        {hasOverlay && <mesh geometry={rightLegOverlayGeometry} material={overlayMaterial}/>}
      </mesh>
      <mesh ref={rightLeg} position={[0.11, 0.66, 0]} castShadow geometry={leftLegBaseGeometry} material={baseMaterial}>
        {hasOverlay && <mesh geometry={leftLegOverlayGeometry} material={overlayMaterial}/>}
      </mesh>
      <mesh position={[0, 0.98, 0]} castShadow geometry={bodyBaseGeometry} material={baseMaterial}>
        {hasOverlay && <mesh geometry={bodyOverlayGeometry} material={overlayMaterial}/>}
      </mesh>
      <mesh ref={leftArm} position={[-0.31, 1.2, 0]} castShadow geometry={rightArmBaseGeometry} material={baseMaterial}>
        {hasOverlay && <mesh geometry={rightArmOverlayGeometry} material={overlayMaterial}/>}
      </mesh>
      <mesh ref={rightArm} position={[0.31, 1.2, 0]} castShadow geometry={leftArmBaseGeometry} material={baseMaterial}>
        {hasOverlay && <mesh geometry={leftArmOverlayGeometry} material={overlayMaterial}/>}
      </mesh>
      <mesh position={[0, 1.5, 0]} castShadow geometry={headBaseGeometry} material={baseMaterial}>
        {hasOverlay && <mesh geometry={headOverlayGeometry} material={overlayMaterial}/>}
      </mesh>
      {unknown && <mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[0.45, 0.55, 24]}/><meshBasicMaterial color="#e9c47b" transparent opacity={0.85}/></mesh>}
      <object3D ref={anchor} position={[0, 2.05, 0]}/>
    </group>
  </group>
}

const headBaseGeometry = createSkinBoxGeometry(0.4, 0.4, 0.4, 'head', 'base')
const headOverlayGeometry = createSkinBoxGeometry(0.43, 0.43, 0.43, 'head', 'overlay')

const bodyBaseGeometry = createSkinBoxGeometry(0.48, 0.58, 0.3, 'body', 'base')
const bodyOverlayGeometry = createSkinBoxGeometry(0.51, 0.61, 0.33, 'body', 'overlay')

// Legs and arms pivot at hip / shoulder: origin translated to top.
const rightLegBaseGeometry = createSkinBoxGeometry(0.17, 0.62, 0.2, 'rightLeg', 'base', [0, -0.31, 0])
const rightLegOverlayGeometry = createSkinBoxGeometry(0.19, 0.64, 0.22, 'rightLeg', 'overlay', [0, -0.31, 0])

const leftLegBaseGeometry = createSkinBoxGeometry(0.17, 0.62, 0.2, 'leftLeg', 'base', [0, -0.31, 0])
const leftLegOverlayGeometry = createSkinBoxGeometry(0.19, 0.64, 0.22, 'leftLeg', 'overlay', [0, -0.31, 0])

const rightArmBaseGeometry = createSkinBoxGeometry(0.12, 0.52, 0.14, 'rightArm', 'base', [0, -0.26, 0])
const rightArmOverlayGeometry = createSkinBoxGeometry(0.14, 0.54, 0.16, 'rightArm', 'overlay', [0, -0.26, 0])

const leftArmBaseGeometry = createSkinBoxGeometry(0.12, 0.52, 0.14, 'leftArm', 'base', [0, -0.26, 0])
const leftArmOverlayGeometry = createSkinBoxGeometry(0.14, 0.54, 0.16, 'leftArm', 'overlay', [0, -0.26, 0])

/**
 * Screen-space labels: each frame, project every anchor into the canvas and move its DOM label
 * there directly (no React re-render). Labels live outside the Canvas, so they unmount cleanly
 * and use the page's own styles and focus handling.
 */
function LabelProjector({ anchors, labels }: { anchors: Registry<THREE.Object3D>; labels: Registry<HTMLElement> }) {
  const point = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera, size }) => {
    const projected: { element: HTMLElement; x: number; y: number; depth: number }[] = []
    for (const [key, object] of anchors.current) {
      const element = labels.current.get(key)
      if (!element) continue
      let shown = true
      for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) { shown = false; break }
      object.getWorldPosition(point).project(camera)
      const visible = shown && point.z < 1 && Math.abs(point.x) <= 1.1 && Math.abs(point.y) <= 1.1
      element.style.visibility = visible ? 'visible' : 'hidden'
      if (visible) projected.push({ element, x: ((point.x + 1) / 2) * size.width, y: ((1 - point.y) / 2) * size.height, depth: point.z })
    }
    // Nearest labels keep their spot; a farther label that would overlap one already placed is
    // lifted above it, so every agent stays readable and clickable.
    projected.sort((a, b) => a.depth - b.depth)
    const placed: { left: number; right: number; top: number; bottom: number }[] = []
    for (const label of projected) {
      const width = label.element.offsetWidth
      const height = label.element.offsetHeight
      const x = Math.min(Math.max(label.x, width / 2 + 4), size.width - width / 2 - 4)
      let bottom = label.y
      const left = x - width / 2
      const right = x + width / 2
      for (let guard = 0; guard < 6; guard += 1) {
        const hit = placed.find((box) => left < box.right && right > box.left && bottom - height < box.bottom && bottom > box.top)
        if (!hit) break
        bottom = hit.top - 4
      }
      placed.push({ left, right, top: bottom - height, bottom })
      label.element.style.transform = `translate(${x}px, ${Math.max(bottom, height + 4)}px) translate(-50%, -100%)`
      label.element.style.zIndex = String(Math.round((1 - label.depth) * 10_000))
    }
  })
  return null
}

export interface ViewHandle { reset: () => void }

/** Orbit (drag), pan (right-drag, two fingers, arrow keys or pan mode) and zoom, kept in bounds. */
const Controls = forwardRef<ViewHandle, { panMode: boolean; keyTarget: HTMLElement | null; layout: OfficeLayout; elevation: number; enabled: boolean }>(function Controls({ panMode, keyTarget, layout, elevation, enabled }, handle) {
  const { camera, gl, size } = useThree()
  const controls = useRef<OrbitControls | null>(null)
  const { target: cameraTarget, offset: cameraOffset } = layout.camera
  const target = useMemo(() => new THREE.Vector3(...cameraTarget), [cameraTarget])
  const frame = useMemo(() => () => {
    const aspect = size.width / Math.max(size.height, 1)
    const offset = new THREE.Vector3(...cameraOffset)
    // Narrow (portrait) views need to back off so the whole building fits across.
    offset.setLength(offset.length() * Math.max(1, 1.2 / aspect))
    const focus = target.clone().set(aspect < 1 ? cameraTarget[0] - 1.4 : cameraTarget[0], cameraTarget[1] + elevation, aspect < 1 ? 0.8 : cameraTarget[2])
    const orbit = controls.current
    // An undamped update applies and clears any momentum left from an earlier drag,
    // so it has to happen before the camera is placed, not after.
    if (orbit) { orbit.enableDamping = false; orbit.update() }
    camera.position.copy(focus).add(offset)
    camera.lookAt(focus)
    if (!orbit) return
    orbit.target.copy(focus)
    orbit.update()
    orbit.enableDamping = true
  }, [camera, size.width, size.height, target, cameraOffset, cameraTarget, elevation])

  useEffect(() => {
    const orbit = new OrbitControls(camera, gl.domElement)
    orbit.enableDamping = true
    orbit.screenSpacePanning = false // pan across the floor, not up into the sky
    orbit.minDistance = 5
    orbit.maxDistance = 48
    orbit.minPolarAngle = 0.2
    orbit.maxPolarAngle = 1.32
    orbit.keyPanSpeed = 25
    controls.current = orbit
    frame()
    return () => { orbit.dispose(); controls.current = null }
    // frame() only sets the initial view; re-running it on resize is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, gl])
  useEffect(() => {
    const orbit = controls.current
    // Rotate and pan only: the wheel keeps zooming while the pointer is over furniture in Edit mode.
    if (orbit) { orbit.enableRotate = enabled; orbit.enablePan = enabled }
  }, [enabled])
  useEffect(() => { frame() }, [frame])
  useEffect(() => {
    const orbit = controls.current
    if (!orbit) return
    orbit.mouseButtons.LEFT = panMode ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE
    orbit.mouseButtons.RIGHT = panMode ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN
    orbit.touches.ONE = panMode ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE
  }, [panMode])
  useEffect(() => {
    const orbit = controls.current
    if (!orbit || !keyTarget) return
    orbit.listenToKeyEvents(keyTarget)
    return () => orbit.stopListenToKeyEvents()
  }, [keyTarget])
  useImperativeHandle(handle, () => ({ reset: frame }), [frame])

  useFrame(() => {
    const orbit = controls.current
    if (!orbit) return
    orbit.update()
    const [x, z] = clampTarget(orbit.target.x, orbit.target.z, layout.pan)
    if (x !== orbit.target.x || z !== orbit.target.z) {
      const shift = new THREE.Vector3(x - orbit.target.x, 0, z - orbit.target.z)
      orbit.target.add(shift)
      camera.position.add(shift)
    }
  })
  return null
})

function register<T>(registry: Registry<T>, key: string) {
  return (value: T | null) => { if (value) registry.current.set(key, value); else registry.current.delete(key) }
}

/** Current time, refreshed every `interval` ms. */
function useClock(interval: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(timer)
  }, [interval])
  return now
}

/** True while the viewport is 700px wide or less (the editor UI is hidden there). */
function useNarrow(): boolean {
  const query = '(max-width: 700px)'
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const onChange = () => setNarrow(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return narrow
}

function useThemeName(): 'dark' | 'light' {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [theme, setTheme] = useState<'dark' | 'light'>(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** Day in the light theme; evening in the dark theme, when the lamps in the scene switch on. */
function Lighting({ theme }: { theme: 'dark' | 'light' }) {
  const day = theme === 'light'
  return <>
    <color attach="background" args={[day ? '#bfe0ef' : '#1a2335']}/>
    <fog attach="fog" args={[day ? '#bfe0ef' : '#1a2335', 38, 75]}/>
    <hemisphereLight args={[day ? '#fff4e0' : '#7f95bd', day ? '#5d7a4c' : '#1e2620', day ? 1.1 : 0.32]}/>
    <directionalLight position={[10, 16, 9]} intensity={day ? 2.4 : 0.75} color={day ? '#fff1d6' : '#ff9a5a'} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-camera-left={-16} shadow-camera-right={16} shadow-camera-top={16} shadow-camera-bottom={-16} shadow-camera-far={60}/>
    <ambientLight intensity={day ? 0.35 : 0.14} color={day ? '#ffffff' : '#8fa4d8'}/>
  </>
}

const FLOOR_KEY = 'mc.officeFloor'
const SLEEP_KEY = 'mc.officeSleep'

/** An on/off preference kept per browser. */
function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => { try { return localStorage.getItem(key) === '1' } catch { return false } })
  return [value, (next: boolean) => {
    setValue(next)
    try { localStorage.setItem(key, next ? '1' : '0') } catch { /* per-browser convenience only */ }
  }]
}

/** The level in view, as an index into the scene's levels, kept per browser (stored as index + 1, like before). */
function useLevelIndex(count: number): [number, (index: number) => void] {
  const [stored, setStored] = useState<number>(() => {
    try { return Math.max(0, Number(localStorage.getItem(FLOOR_KEY)) - 1) || 0 } catch { return 0 }
  })
  return [Math.min(stored, count - 1), (next: number) => {
    setStored(next)
    try { localStorage.setItem(FLOOR_KEY, String(next + 1)) } catch { /* per-browser convenience only */ }
  }]
}

export default function Office3D({ stations, onSelect, onDirtyChange }: { stations: OfficeStation[]; onSelect: (station: OfficeStation, trigger: HTMLElement | null) => void; onDirtyChange?: (dirty: boolean) => void }) {
  const anchors = useRef(new Map<string, THREE.Object3D>())
  const labels = useRef(new Map<string, HTMLElement>())
  const view = useRef<ViewHandle>(null)
  const [panMode, setPanMode] = useState(false)
  const [keyTarget, setKeyTarget] = useState<HTMLElement | null>(null)
  const theme = useThemeName()
  const [sleepMode, setSleepMode] = useStoredFlag(SLEEP_KEY)
  const now = useClock(2000)
  const skinsRequest = useSkins()
  const skins = skinsRequest.status === 'ready' ? skinsRequest.data.skins : undefined
  // One unlabeled desk per agent (hot desking); the building is sized for the crew.
  // The office is a scene: the stock office for this crew plus the saved edits. Agents sit at the
  // scene's desks and beds; their other stops and walking routes are still the stock ones.
  const { patch: savedPatch, ready: sceneReady, refresh: refreshScene } = useScenePatch()
  const editor = useSceneEditor(savedPatch, refreshScene)
  // Editing is inactive on narrow viewports, where the editor UI is hidden.
  const narrow = useNarrow()
  const editingActive = editor.editing && !narrow
  // While editing, the draft is the scene (the polled patch is ignored); otherwise the saved patch.
  const patch = editor.editing ? editor.draft : savedPatch
  const baseLayout = useMemo(() => createLayout(stations.length), [stations.length])
  const items = useMemo(() => applyPatch(defaultScene(baseLayout), patch), [baseLayout, patch])
  const layout = useMemo(() => withMovedSeats(baseLayout, seatPositions(items, 'desk'), seatPositions(items, 'bed')), [baseLayout, items])
  const levels = useMemo(() => levelsOf(items), [items])
  const [levelIndex, setLevelIndex] = useLevelIndex(levels.length)
  const level = levels[levelIndex] ?? 0
  const [hovering, setHovering] = useState(false)
  const [dragging, setDragging] = useState(false)
  const selectedItem = editor.selectedId ? items.find((item) => item.id === editor.selectedId) : undefined
  // A selection that is not drawn on the floor in view (floor switch, undone floor change) is not acted on.
  const selected = selectedItem && isEditable(selectedItem) && visibleAt(selectedItem, level) ? selectedItem : undefined
  // The live drag position is drawn but not fed to the layout, so agents do not chase a desk mid-drag.
  const drawItems = useMemo(() => {
    const drag = editor.drag
    return drag ? items.map((item) => (item.id === drag.id && isEditable(item) ? { ...item, position: [drag.x, item.position[1], drag.z] as Vec3 } : item)) : items
  }, [items, editor.drag])
  const bounds = layout.pan
  const edit: EditHandlers = {
    selectedId: selected?.id ?? null,
    bounds,
    select: editor.select,
    setHover: setHovering,
    setDragging,
    previewDrag: editor.previewDrag,
    commitMove: (item, x, z) => { editor.apply((patchNow) => moveItem(patchNow, item, x, z, bounds)); editor.endDrag() },
    cancelDrag: editor.endDrag,
  }
  const selectAgent: typeof onSelect = editingActive ? () => {} : onSelect
  const runEditAction = (action: EditKeyAction) => {
    if (action === 'undo') editor.undo()
    else if (action === 'redo') editor.redo()
    else if (action === 'deselect') editor.select(null)
    else if (!selected) return
    else if (action === 'delete') { if (!canDelete(selected)) return; editor.apply((patchNow) => deleteItem(patchNow, selected)); editor.select(null) }
    else editor.apply((patchNow) => rotateBy(patchNow, selected, action === 'rotate+' ? ROTATION_STEP : -ROTATION_STEP))
  }
  // Unsaved edits: tell the page (it asks before switching to 2D) and warn before the tab closes or reloads.
  const unsaved = editor.editing && editor.dirty
  useEffect(() => {
    onDirtyChange?.(unsaved)
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn); onDirtyChange?.(false) }
  }, [unsaved, onDirtyChange])
  const finishEditing = () => {
    if (editor.saving) return
    if (editor.dirty && !window.confirm('Discard unsaved changes?')) return
    setHovering(false)
    setDragging(false)
    document.body.style.cursor = ''
    editor.exit()
  }
  const resetEdits = () => {
    if (window.confirm('Reset the office to the default layout? This removes every saved edit.')) void editor.reset()
  }
  // Idle agents wander between the lounge, the game room, the pantry, the street food and
  // lantai 2 (decorative only), spread so no two share a spot. With sleep mode on, every idle
  // agent goes to bed upstairs instead.
  const idleSeats = stations.filter((station) => station.state === 'Idle' && station.room === 'Lounge').map((station) => station.seat)
  const plan = idlePlan(idleSeats, now, layout, sleepMode ? idleSeats : [])
  const wandering = (station: OfficeStation) => station.state === 'Idle' && station.room === 'Lounge' ? plan.get(station.seat) : undefined
  // Agents at the meeting table take the next free place around it.
  const meetingOrder = stations.filter((station) => station.roomPosition === 'meeting-area').map((station) => station.id)
  const placement = (station: OfficeStation) => wandering(station)?.placement ?? placementFor(station, layout, Math.max(0, meetingOrder.indexOf(station.id)))
  const levelCount = (value: number) => stations.filter((station) => levelAt(levels, placement(station).position[1]) === value).length
  const occupiedSeats = new Set(stations.filter((station) => station.room === 'Workspace' && station.roomPosition !== 'meeting-area' && station.state !== 'Offline').map((station) => station.seat))
  return <div className="office-3d" ref={setKeyTarget} tabIndex={0} role="region" aria-label="3D office. Drag to rotate, right-drag or two fingers to pan, scroll to zoom, arrow keys pan when focused. Page Up and Page Down change floors." onKeyDown={(event) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((event.target as HTMLElement).tagName)
    if (editingActive && !typing && !dragging) {
      const action = editKeyAction(event)
      if (action) { event.preventDefault(); runEditAction(action); return }
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); setLevelIndex(Math.min(Math.max(levelIndex + (event.key === 'PageUp' ? 1 : -1), 0), levels.length - 1)) }
  }}>
    <Canvas shadows dpr={[1, 2]} camera={{ position: [-3, 13, 16], fov: 40, near: 0.5, far: 150 }} gl={{ antialias: true }} onPointerMissed={editingActive ? () => editor.select(null) : undefined}>
      <Lighting theme={theme}/>
      <SceneRenderer items={drawItems} level={level} night={theme === 'dark'} deskActive={(id) => occupiedSeats.has(deskSeatNumber(id) ?? -1)} wrap={editingActive ? (item, node) => (isEditable(item) ? <EditTarget item={item} edit={edit}>{node}</EditTarget> : node) : undefined}/>
      {stations.map((station) => <Character key={station.id} station={station} placement={placement(station)} layout={layout} level={level} levels={levels} onSelect={selectAgent} anchor={register(anchors, `agent-${station.id}`)} skinVersion={skins?.[station.id]?.version}/>)}
      <LabelProjector anchors={anchors} labels={labels}/>
      <Controls key={layout.deskCount} ref={view} panMode={panMode} keyTarget={keyTarget} layout={layout} elevation={level} enabled={!(editingActive && (hovering || dragging))}/>
    </Canvas>
    <div className="office-3d-labels">
      {stations.map((station) => {
        const badge = officeStateBadge(station.state)
        const busy = ['Working', 'Reviewing', 'Collaborating'].includes(station.state)
        const idle = wandering(station)
        return <button key={station.id} ref={register(labels, `agent-${station.id}`)} type="button" className={`agent-tag-3d state-${station.state.toLowerCase()}`} onClick={(event) => selectAgent(station, event.currentTarget)} aria-label={`${station.name}. ${station.state}.${station.activity ? ` ${station.activity}.` : ''}${idle ? ` ${idle.placement.label ?? idle.stop.label}.` : ''} Open station details.`}>
          {busy && station.activity && <span className="speech speech-3d">{station.activity}</span>}
          {idle && <span className={`speech speech-3d speech-idle${idle.placement.pose === 'lie' ? ' speech-sleep' : ''}`}>{idle.placement.pose === 'lie' ? '💤 ' : ''}{idle.placement.label ?? idle.stop.label}</span>}
          <span className="agent-tag-row"><span className="pixel-station-name">{station.privacy === 'locked' ? '🔒 ' : ''}{station.name}</span><span className={`badge ${badge.tone}`}>{station.state === 'Idle' ? 'Idle' : station.state}</span></span>
        </button>
      })}
    </div>
    <div className="office-3d-floors" role="group" aria-label="Floors">
      {levels.map((height, index) => ({ height, index })).reverse().map(({ height, index }) => <button key={height} type="button" className={levelIndex === index ? 'active' : ''} aria-pressed={levelIndex === index} onClick={() => setLevelIndex(index)} title={`${levelName(height, index).title} (Page Up and Page Down change floors)`}>
        <b>{index + 1}</b><span>{levelName(height, index).label}</span><small>{levelCount(height)}</small>
      </button>)}
    </div>
    <div className="office-3d-tools">
      <button type="button" className={`edit-toggle${editor.editing ? ' active' : ''}`} aria-pressed={editor.editing} disabled={!editor.editing && !sceneReady} onClick={() => (editor.editing ? finishEditing() : editor.enter())} title={!editor.editing && !sceneReady ? 'Loading the saved layout…' : 'Rearrange the office'}>✎ Edit</button>
      <button type="button" className={sleepMode ? 'active sleep' : ''} aria-pressed={sleepMode} onClick={() => { setSleepMode(!sleepMode); if (!sleepMode && idleSeats.length > 0) setLevelIndex(Math.max(0, levels.indexOf(FLOOR_HEIGHT))) }} title="Send every idle agent to bed on lantai 2">💤 Tidur</button>
      <button type="button" className={panMode ? 'active' : ''} aria-pressed={panMode} onClick={() => setPanMode((value) => !value)} title="Drag moves the view instead of rotating it">✥ Geser</button>
      <button type="button" onClick={() => view.current?.reset()} title="Back to the starting view">↺ Reset view</button>
    </div>
    {editor.editing && <EditorBar canUndo={editor.canUndo} canRedo={editor.canRedo} dirty={editor.dirty} saving={editor.saving} error={editor.error} onUndo={editor.undo} onRedo={editor.redo} onSave={() => void editor.save()} onReset={resetEdits} onDone={finishEditing}/>}
    {editor.editing && selected && <ObjectPanel item={selected} levels={levels} canDuplicate={false} onDuplicate={() => {}} onProp={() => {}} onMove={(x, z) => editor.apply((patchNow) => moveItem(patchNow, selected, x, z, bounds))} onRotate={(degrees) => editor.apply((patchNow) => rotateItem(patchNow, selected, (degrees * Math.PI) / 180))} onLevel={(next) => { editor.apply((patchNow) => setItemLevel(patchNow, selected, next)); setLevelIndex(Math.max(0, levels.indexOf(next))) }} onDelete={() => { editor.apply((patchNow) => deleteItem(patchNow, selected)); editor.select(null); keyTarget?.focus() }}/>}
  </div>
}
