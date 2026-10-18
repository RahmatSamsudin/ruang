// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { agentCameraPose } from './agent-camera.ts'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

interface MockOrbitInstance {
  camera: THREE.Camera
  domElement: HTMLElement
  enabled: boolean
  enableRotate: boolean
  enablePan: boolean
  enableZoom: boolean
  enableDamping: boolean
  screenSpacePanning: boolean
  minDistance: number
  maxDistance: number
  minPolarAngle: number
  maxPolarAngle: number
  keyPanSpeed: number
  mouseButtons: { LEFT: number; RIGHT: number }
  touches: { ONE: number }
  target: THREE.Vector3
  update: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  listenToKeyEvents: ReturnType<typeof vi.fn>
  stopListenToKeyEvents: ReturnType<typeof vi.fn>
}

const mockOrbitInstances: MockOrbitInstance[] = []
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => {
  return {
    OrbitControls: vi.fn().mockImplementation((camera, domElement) => {
      const instance: MockOrbitInstance = {
        camera,
        domElement,
        enabled: true,
        enableRotate: true,
        enablePan: true,
        enableZoom: true,
        enableDamping: false,
        screenSpacePanning: false,
        minDistance: 0,
        maxDistance: 0,
        minPolarAngle: 0,
        maxPolarAngle: 0,
        keyPanSpeed: 0,
        mouseButtons: { LEFT: 0, RIGHT: 0 },
        touches: { ONE: 0 },
        target: new THREE.Vector3(),
        update: vi.fn(),
        dispose: vi.fn(),
        listenToKeyEvents: vi.fn(),
        stopListenToKeyEvents: vi.fn(),
      }
      mockOrbitInstances.push(instance)
      return instance
    }),
  }
})

let frameCallbacks: Array<(state: unknown, delta: number) => void> = []
const testCamera = new THREE.PerspectiveCamera()
const testGl = { domElement: document.createElement('canvas') }
const testSize = { width: 800, height: 600 }

vi.mock('@react-three/fiber', async () => {
  return {
    useThree: () => ({
      camera: testCamera,
      gl: testGl,
      size: testSize,
    }),
    useFrame: (cb: (state: unknown, delta: number) => void) => {
      frameCallbacks.push(cb)
    },
  }
})

// Import Controls and PovCamera after mocks are established
import { Controls, PovCamera, type CharacterAgentState } from '../pages/Office3D.tsx'
import { createLayout } from '../office3d-layout.ts'

describe('agentCameraPose', () => {
  const origin: [number, number, number] = [0, 0, 0]
  const offsetPos: [number, number, number] = [2, 1.5, -3]

  describe('first person mode', () => {
    it('calculates standing pose at heading 0', () => {
      const { position, lookAt } = agentCameraPose('first', origin, 0, false)
      expect(position[0]).toBeCloseTo(0, 5)
      expect(position[1]).toBeCloseTo(1.52, 5)
      expect(position[2]).toBeCloseTo(0.22, 5)

      expect(lookAt[0]).toBeCloseTo(0, 5)
      expect(lookAt[1]).toBeCloseTo(1.52, 5)
      expect(lookAt[2]).toBeCloseTo(5.22, 5)
    })

    it('calculates seated pose at heading 0', () => {
      const { position, lookAt } = agentCameraPose('first', origin, 0, true)
      expect(position[0]).toBeCloseTo(0, 5)
      expect(position[1]).toBeCloseTo(1.36, 5)
      expect(position[2]).toBeCloseTo(0.22, 5)

      expect(lookAt[0]).toBeCloseTo(0, 5)
      expect(lookAt[1]).toBeCloseTo(1.36, 5)
      expect(lookAt[2]).toBeCloseTo(5.22, 5)
    })

    it('calculates standing pose at heading PI / 2', () => {
      const { position, lookAt } = agentCameraPose('first', origin, Math.PI / 2, false)
      expect(position[0]).toBeCloseTo(0.22, 5)
      expect(position[1]).toBeCloseTo(1.52, 5)
      expect(position[2]).toBeCloseTo(0, 5)

      expect(lookAt[0]).toBeCloseTo(5.22, 5)
      expect(lookAt[1]).toBeCloseTo(1.52, 5)
      expect(lookAt[2]).toBeCloseTo(0, 5)
    })

    it('calculates seated pose at heading PI / 2', () => {
      const { position, lookAt } = agentCameraPose('first', origin, Math.PI / 2, true)
      expect(position[0]).toBeCloseTo(0.22, 5)
      expect(position[1]).toBeCloseTo(1.36, 5)
      expect(position[2]).toBeCloseTo(0, 5)

      expect(lookAt[0]).toBeCloseTo(5.22, 5)
      expect(lookAt[1]).toBeCloseTo(1.36, 5)
      expect(lookAt[2]).toBeCloseTo(0, 5)
    })

    it('calculates standing pose at heading PI', () => {
      const { position, lookAt } = agentCameraPose('first', origin, Math.PI, false)
      expect(position[0]).toBeCloseTo(0, 5)
      expect(position[1]).toBeCloseTo(1.52, 5)
      expect(position[2]).toBeCloseTo(-0.22, 5)

      expect(lookAt[0]).toBeCloseTo(0, 5)
      expect(lookAt[1]).toBeCloseTo(1.52, 5)
      expect(lookAt[2]).toBeCloseTo(-5.22, 5)
    })

    it('calculates seated pose at heading PI', () => {
      const { position, lookAt } = agentCameraPose('first', origin, Math.PI, true)
      expect(position[0]).toBeCloseTo(0, 5)
      expect(position[1]).toBeCloseTo(1.36, 5)
      expect(position[2]).toBeCloseTo(-0.22, 5)

      expect(lookAt[0]).toBeCloseTo(0, 5)
      expect(lookAt[1]).toBeCloseTo(1.36, 5)
      expect(lookAt[2]).toBeCloseTo(-5.22, 5)
    })

    it('accounts for base position and floor elevation', () => {
      const { position, lookAt } = agentCameraPose('first', offsetPos, 0, false)
      expect(position[0]).toBeCloseTo(2, 5)
      expect(position[1]).toBeCloseTo(1.5 + 1.52, 5)
      expect(position[2]).toBeCloseTo(-3 + 0.22, 5)

      expect(lookAt[0]).toBeCloseTo(2, 5)
      expect(lookAt[1]).toBeCloseTo(1.5 + 1.52, 5)
      expect(lookAt[2]).toBeCloseTo(-3 + 5.22, 5)
    })
  })

  describe('third person mode', () => {
    it('calculates standing and seated pose at heading 0', () => {
      const standing = agentCameraPose('third', origin, 0, false)
      expect(standing.position[0]).toBeCloseTo(0.35, 5)
      expect(standing.position[1]).toBeCloseTo(1.8, 5)
      expect(standing.position[2]).toBeCloseTo(-2.2, 5)

      expect(standing.lookAt[0]).toBeCloseTo(0, 5)
      expect(standing.lookAt[1]).toBeCloseTo(1.2, 5)
      expect(standing.lookAt[2]).toBeCloseTo(5, 5)

      const seated = agentCameraPose('third', origin, 0, true)
      expect(seated.position).toEqual(standing.position)
      expect(seated.lookAt).toEqual(standing.lookAt)
    })

    it('calculates pose at heading PI / 2', () => {
      const { position, lookAt } = agentCameraPose('third', origin, Math.PI / 2, false)
      expect(position[0]).toBeCloseTo(-2.2, 5)
      expect(position[1]).toBeCloseTo(1.8, 5)
      expect(position[2]).toBeCloseTo(-0.35, 5)

      expect(lookAt[0]).toBeCloseTo(5, 5)
      expect(lookAt[1]).toBeCloseTo(1.2, 5)
      expect(lookAt[2]).toBeCloseTo(0, 5)
    })

    it('calculates pose at heading PI', () => {
      const { position, lookAt } = agentCameraPose('third', origin, Math.PI, false)
      expect(position[0]).toBeCloseTo(-0.35, 5)
      expect(position[1]).toBeCloseTo(1.8, 5)
      expect(position[2]).toBeCloseTo(2.2, 5)

      expect(lookAt[0]).toBeCloseTo(0, 5)
      expect(lookAt[1]).toBeCloseTo(1.2, 5)
      expect(lookAt[2]).toBeCloseTo(-5, 5)
    })

    it('accounts for base position and floor elevation', () => {
      const { position, lookAt } = agentCameraPose('third', offsetPos, 0, false)
      expect(position[0]).toBeCloseTo(2 + 0.35, 5)
      expect(position[1]).toBeCloseTo(1.5 + 1.8, 5)
      expect(position[2]).toBeCloseTo(-3 - 2.2, 5)

      expect(lookAt[0]).toBeCloseTo(2, 5)
      expect(lookAt[1]).toBeCloseTo(1.5 + 1.2, 5)
      expect(lookAt[2]).toBeCloseTo(-3 + 5, 5)
    })
  })
})

describe('Controls orbit locking and restoration', () => {
  const layout = createLayout(4)
  let container: HTMLDivElement
  let keyTarget: HTMLDivElement

  beforeEach(() => {
    mockOrbitInstances.length = 0
    frameCallbacks = []
    container = document.createElement('div')
    keyTarget = document.createElement('div')
    document.body.appendChild(container)
    document.body.appendChild(keyTarget)
  })

  it('locks orbit flags when pov is set and restores them when cleared', async () => {
    const root = createRoot(container)

    // 1. Initial render with locked=false (free orbit camera)
    await act(async () => {
      root.render(
        React.createElement(Controls, {
          panMode: false,
          keyTarget,
          layout,
          elevation: 0,
          enabled: true,
          locked: false,
        }),
      )
    })

    expect(mockOrbitInstances.length).toBe(1)
    const orbit = mockOrbitInstances[0]

    expect(orbit.enabled).toBe(true)
    expect(orbit.enableRotate).toBe(true)
    expect(orbit.enablePan).toBe(true)
    expect(orbit.enableZoom).toBe(true)
    expect(orbit.listenToKeyEvents).toHaveBeenCalledWith(keyTarget)

    // 2. Lock controls (pov set)
    await act(async () => {
      root.render(
        React.createElement(Controls, {
          panMode: false,
          keyTarget,
          layout,
          elevation: 0,
          enabled: true,
          locked: true,
        }),
      )
    })

    expect(orbit.enabled).toBe(false)
    expect(orbit.enableRotate).toBe(false)
    expect(orbit.enablePan).toBe(false)
    expect(orbit.enableZoom).toBe(false)
    expect(orbit.stopListenToKeyEvents).toHaveBeenCalled()

    // 3. Frame update while locked does NOT update orbit or fight camera
    orbit.update.mockClear()
    const controlsFrame = frameCallbacks[0]
    expect(controlsFrame).toBeDefined()
    controlsFrame({ clock: { elapsedTime: 1 } }, 0.016)
    expect(orbit.update).not.toHaveBeenCalled()

    // 4. Restore controls (pov cleared)
    await act(async () => {
      root.render(
        React.createElement(Controls, {
          panMode: false,
          keyTarget,
          layout,
          elevation: 0,
          enabled: true,
          locked: false,
        }),
      )
    })

    expect(orbit.enabled).toBe(true)
    expect(orbit.enableRotate).toBe(true)
    expect(orbit.enablePan).toBe(true)
    expect(orbit.enableZoom).toBe(true)
    expect(orbit.listenToKeyEvents).toHaveBeenCalledTimes(2)

    await act(async () => {
      root.unmount()
    })
  })

  it('respects Edit-mode enabled=false when restored', async () => {
    const root = createRoot(container)

    // Locked initially
    await act(async () => {
      root.render(
        React.createElement(Controls, {
          panMode: false,
          keyTarget,
          layout,
          elevation: 0,
          enabled: false,
          locked: true,
        }),
      )
    })

    const orbit = mockOrbitInstances[0]
    expect(orbit.enabled).toBe(false)
    expect(orbit.enableRotate).toBe(false)
    expect(orbit.enablePan).toBe(false)

    // Unlock into edit mode with enabled=false (hovering/dragging furniture)
    await act(async () => {
      root.render(
        React.createElement(Controls, {
          panMode: false,
          keyTarget,
          layout,
          elevation: 0,
          enabled: false,
          locked: false,
        }),
      )
    })

    expect(orbit.enabled).toBe(true)
    expect(orbit.enableRotate).toBe(false)
    expect(orbit.enablePan).toBe(false)
    expect(orbit.enableZoom).toBe(true)

    await act(async () => {
      root.unmount()
    })
  })
})

describe('PovCamera follow and floor matching', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    frameCallbacks = []
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  it('follows agent live and triggers level change on floor transitions', async () => {
    const root = createRoot(container)
    const onLevelChange = vi.fn()

    const agentGroup = new THREE.Group()
    agentGroup.position.set(5, 0, 10)
    agentGroup.rotation.y = 0

    let seated = false
    const agentsMap = new Map<string, CharacterAgentState>([
      ['alpha', { group: agentGroup, isSeated: () => seated }],
    ])
    const agentsRef = { current: agentsMap }
    const levels = [0, 3]

    await act(async () => {
      root.render(
        React.createElement(PovCamera, {
          pov: { name: 'alpha', mode: 'first' },
          agents: agentsRef,
          levels,
          onLevelChange,
        }),
      )
    })

    const povFrame = frameCallbacks[frameCallbacks.length - 1]
    expect(povFrame).toBeDefined()

    // First frame snaps to standing pose
    povFrame({ clock: { elapsedTime: 1 } }, 0.016)
    expect(testCamera.position.x).toBeCloseTo(5, 3)
    expect(testCamera.position.y).toBeCloseTo(1.52, 3)
    expect(testCamera.position.z).toBeCloseTo(10.22, 3)
    expect(onLevelChange).toHaveBeenCalledWith(0)

    // Agent sits down: next frame moves towards seated height
    seated = true
    povFrame({ clock: { elapsedTime: 1.016 } }, 0.016)
    // Lerp from 1.52 towards 1.36: 1.52 + (1.36 - 1.52) * 0.25 = 1.48
    expect(testCamera.position.y).toBeCloseTo(1.48, 2)

    // Agent walks upstairs to level 1 (elevation 3)
    agentGroup.position.y = 3
    onLevelChange.mockClear()
    povFrame({ clock: { elapsedTime: 1.032 } }, 0.016)
    expect(onLevelChange).toHaveBeenCalledWith(1)

    await act(async () => {
      root.unmount()
    })
  })

  it('handles unknown pov agent or missing group gracefully without crashing', async () => {
    const root = createRoot(container)
    const onLevelChange = vi.fn()
    const agentsRef = { current: new Map<string, CharacterAgentState>() }

    await act(async () => {
      root.render(
        React.createElement(PovCamera, {
          pov: { name: 'ghost', mode: 'first' },
          agents: agentsRef,
          levels: [0, 3],
          onLevelChange,
        }),
      )
    })

    const povFrame = frameCallbacks[frameCallbacks.length - 1]
    expect(() => povFrame({ clock: { elapsedTime: 1 } }, 0.016)).not.toThrow()
    expect(onLevelChange).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })
  })
})
