// @vitest-environment jsdom
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob, exportSceneGlb, formatSceneGlbFilename, prepareSceneForExport } from './export-glb.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('export-glb', () => {
  it('formats filename as ruang-scene-<yyyymmdd-hhmm>.glb', () => {
    const d = new Date(2026, 9, 14, 15, 30) // Oct 14, 2026 15:30
    expect(formatSceneGlbFilename(d)).toBe('ruang-scene-20261014-1530.glb')
  })

  it('prepares scene by cloning valid objects and skipping editor helpers and userData.noExport', () => {
    const scene = new THREE.Scene()
    const validMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    validMesh.name = 'valid-object'

    const helper = new THREE.AxesHelper(5)
    const editorOverlay = new THREE.Group()
    editorOverlay.name = 'editor-gizmo'
    const transformGizmo = new THREE.Group()
    transformGizmo.name = 'TransformGizmo'

    const excludedGroup = new THREE.Group()
    excludedGroup.userData.noExport = true

    // Nested gizmo inside a valid parent group
    const parentGroup = new THREE.Group()
    parentGroup.name = 'parent-group'
    const nestedMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    nestedMesh.name = 'nested-mesh'
    const nestedGizmo = new THREE.Group()
    nestedGizmo.name = 'nested-gizmo'
    parentGroup.add(nestedMesh, nestedGizmo)

    scene.add(validMesh, helper, editorOverlay, transformGizmo, excludedGroup, parentGroup)

    const prepared = prepareSceneForExport(scene)
    expect(prepared.name).toBe('OfficeScene')
    expect(prepared.children.length).toBe(2)
    expect(prepared.children[0].name).toBe('valid-object')
    expect(prepared.children[1].name).toBe('parent-group')
    expect(prepared.children[1].children.length).toBe(1)
    expect(prepared.children[1].children[0].name).toBe('nested-mesh')
  })

  it('exports scene as a valid GLB binary blob and parses with GLTFLoader', async () => {
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x336699 }))
    mesh.name = 'office-desk'
    const gizmo = new THREE.Group()
    gizmo.name = 'TransformGizmo'
    scene.add(mesh, gizmo)

    const blob = await exportSceneGlb(scene, { binary: true })
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('model/gltf-binary')
    expect(blob.size).toBeGreaterThan(0)

    const buffer = await blob.arrayBuffer()
    const headerView = new DataView(buffer)
    const magic = String.fromCharCode(
      headerView.getUint8(0),
      headerView.getUint8(1),
      headerView.getUint8(2),
      headerView.getUint8(3),
    )
    expect(magic).toBe('glTF')
    const version = headerView.getUint32(4, true)
    expect(version).toBe(2)

    const loader = new GLTFLoader()
    const parsed = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(buffer, '', resolve, reject)
    })
    expect(parsed.scene).toBeDefined()

    let nodeCount = 0
    let hasGizmoNodes = false
    parsed.scene.traverse((node) => {
      nodeCount++
      if (node.name === 'TransformGizmo' || node.name.includes('gizmo') || node.type.includes('Helper')) {
        hasGizmoNodes = true
      }
    })
    expect(nodeCount).toBeGreaterThan(0)
    expect(hasGizmoNodes).toBe(false)
  })

  it('exports an empty scene without crashing', async () => {
    const scene = new THREE.Scene()
    const blob = await exportSceneGlb(scene, { binary: true })
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)

    const buffer = await blob.arrayBuffer()
    const loader = new GLTFLoader()
    const parsed = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(buffer, '', resolve, reject)
    })
    expect(parsed.scene).toBeDefined()
  })

  it('exports scene as a glTF JSON blob when binary: false', async () => {
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    scene.add(mesh)

    const blob = await exportSceneGlb(scene, { binary: false })
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('model/gltf+json')
    const text = await blob.text()
    const parsed = JSON.parse(text)
    expect(parsed.asset).toBeDefined()
    expect(parsed.asset.version).toBe('2.0')
  })

  it('triggers browser file download with downloadBlob', () => {
    const blob = new Blob(['sample data'], { type: 'text/plain' })
    const createObjectURL = vi.fn().mockReturnValue('blob:http://localhost/mock-url')
    const revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL

    const clickSpy = vi.fn()
    const origCreateElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName)
      if (tagName === 'a') {
        el.click = clickSpy
      }
      return el
    })

    downloadBlob(blob, 'scene.glb')

    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(clickSpy).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/mock-url')
  })
})
