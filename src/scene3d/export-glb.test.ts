// @vitest-environment jsdom
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob, exportSceneGlb, prepareSceneForExport } from './export-glb.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('export-glb', () => {
  it('prepares scene by cloning valid objects and skipping editor helpers', () => {
    const scene = new THREE.Scene()
    const validMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    validMesh.name = 'valid-object'

    const helper = new THREE.AxesHelper(5)
    const editorOverlay = new THREE.Group()
    editorOverlay.name = 'editor-gizmo'
    const transformGizmo = new THREE.Group()
    transformGizmo.name = 'TransformGizmo'

    scene.add(validMesh, helper, editorOverlay, transformGizmo)

    const prepared = prepareSceneForExport(scene)
    expect(prepared.name).toBe('OfficeScene')
    expect(prepared.children.length).toBe(1)
    expect(prepared.children[0].name).toBe('valid-object')
  })

  it('exports scene as a valid GLB binary blob', async () => {
    const scene = new THREE.Scene()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x336699 }))
    scene.add(mesh)

    const blob = await exportSceneGlb(scene, { binary: true })
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('model/gltf-binary')
    expect(blob.size).toBeGreaterThan(0)
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
