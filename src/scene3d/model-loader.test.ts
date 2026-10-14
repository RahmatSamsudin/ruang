// @vitest-environment jsdom
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { clearModelCache, loadModel, normalizeModel } from './model-loader.ts'

describe('model-loader normalization', () => {
  it('normalises a huge 1000-unit cube to 1.5 units with base at y = 0', () => {
    const group = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshBasicMaterial())
    group.add(mesh)

    const normalized = normalizeModel(group)
    const wrapper = new THREE.Group()
    wrapper.add(normalized)

    const box = new THREE.Box3().setFromObject(wrapper)
    const size = new THREE.Vector3()
    box.getSize(size)

    expect(size.x).toBeCloseTo(1.5, 3)
    expect(size.y).toBeCloseTo(1.5, 3)
    expect(size.z).toBeCloseTo(1.5, 3)
    expect(box.min.y).toBeCloseTo(0, 3)
  })

  it('normalises a tiny 0.001-unit cube to 1.5 units with base at y = 0', () => {
    const group = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), new THREE.MeshBasicMaterial())
    group.add(mesh)

    const normalized = normalizeModel(group)
    const wrapper = new THREE.Group()
    wrapper.add(normalized)

    const box = new THREE.Box3().setFromObject(wrapper)
    const size = new THREE.Vector3()
    box.getSize(size)

    expect(size.x).toBeCloseTo(1.5, 3)
    expect(size.y).toBeCloseTo(1.5, 3)
    expect(size.z).toBeCloseTo(1.5, 3)
    expect(box.min.y).toBeCloseTo(0, 3)
  })

  it('respects custom scale multipliers on normalization', () => {
    const group = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 10), new THREE.MeshBasicMaterial())
    group.add(mesh)

    const normalized = normalizeModel(group, 2.0)
    const wrapper = new THREE.Group()
    wrapper.add(normalized)

    const box = new THREE.Box3().setFromObject(wrapper)
    const size = new THREE.Vector3()
    box.getSize(size)

    // max dimension (y = 20) normalised to 1.5 * 2.0 = 3.0
    expect(size.y).toBeCloseTo(3.0, 3)
    expect(size.x).toBeCloseTo(1.5, 3)
    expect(box.min.y).toBeCloseTo(0, 3)
  })

  it('exports a programmatic mesh to GLB and loads/normalises it with correct bbox size', async () => {
    const sourceGroup = new THREE.Group()
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(50, 100, 25), new THREE.MeshBasicMaterial())
    sourceGroup.add(mesh)

    const exporter = new GLTFExporter()
    const glbBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      exporter.parse(
        sourceGroup,
        (res) => resolve(res as ArrayBuffer),
        (err) => reject(err),
        { binary: true },
      )
    })

    expect(glbBuffer).toBeInstanceOf(ArrayBuffer)
    expect(glbBuffer.byteLength).toBeGreaterThan(0)

    const loader = new GLTFLoader()
    const loadedGltf = await new Promise<GLTF>((resolve, reject) => {
      loader.parse(glbBuffer, '', (gltf) => resolve(gltf), (err) => reject(err))
    })

    const normalized = normalizeModel(loadedGltf.scene)
    const wrapper = new THREE.Group()
    wrapper.add(normalized)

    const box = new THREE.Box3().setFromObject(wrapper)
    const size = new THREE.Vector3()
    box.getSize(size)

    expect(size.y).toBeCloseTo(1.5, 3)
    expect(size.x).toBeCloseTo(0.75, 3)
    expect(size.z).toBeCloseTo(0.375, 3)
    expect(box.min.y).toBeCloseTo(0, 3)
  })

  it('clears specific model from cache via clearModelCache(id) or all models without id', async () => {
    let loadCalls = 0
    const dummyScene = new THREE.Group()
    const origLoad = GLTFLoader.prototype.load
    GLTFLoader.prototype.load = function (
      _url: string,
      onLoad: (gltf: GLTF) => void,
    ) {
      loadCalls++
      onLoad({ scene: dummyScene } as GLTF)
    }

    try {
      clearModelCache()
      // First load fetches
      const p1 = loadModel('m-model1')
      const p2 = loadModel('m-model1')
      expect(p1).toBe(p2)
      expect(loadCalls).toBe(1)

      // Load a second model
      loadModel('m-model2')
      expect(loadCalls).toBe(2)

      // Clear only m-model1
      clearModelCache('m-model1')

      // m-model2 is still cached
      loadModel('m-model2')
      expect(loadCalls).toBe(2)

      // m-model1 re-fetches
      loadModel('m-model1')
      expect(loadCalls).toBe(3)

      // Clear all
      clearModelCache()
      loadModel('m-model2')
      expect(loadCalls).toBe(4)
    } finally {
      GLTFLoader.prototype.load = origLoad
      clearModelCache()
    }
  })
})
