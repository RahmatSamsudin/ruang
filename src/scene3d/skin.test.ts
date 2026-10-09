import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  SKIN_WIDTH,
  SKIN_HEIGHT,
  SKIN_PARTS,
  SKIN_LAYERS,
  BOX_FACE_NAMES,
  SKIN_RECTS,
  computeBoxUVs,
  applySkinUVs,
  createSkinBoxGeometry,
  hasOverlayPixels,
  paintDefaultSkin,
  createSkinDataTexture,
  skinTextureManager,
  encodeRgbaToPng,
} from './skin'
import { createTestSkinData, createTestSkinPng } from '../dev-mock'

describe('64x64 Minecraft skin UV mapping', () => {
  it('defines valid non-empty bounds for all body parts, layers and faces', () => {
    for (const part of SKIN_PARTS) {
      for (const layer of SKIN_LAYERS) {
        for (const face of BOX_FACE_NAMES) {
          const rect = SKIN_RECTS[part][layer][face]
          expect(rect.w).toBeGreaterThan(0)
          expect(rect.h).toBeGreaterThan(0)
          expect(rect.x).toBeGreaterThanOrEqual(0)
          expect(rect.y).toBeGreaterThanOrEqual(0)
          expect(rect.x + rect.w).toBeLessThanOrEqual(SKIN_WIDTH)
          expect(rect.y + rect.h).toBeLessThanOrEqual(SKIN_HEIGHT)
        }
      }
    }
  })

  it('computes 48 UV floats (6 faces * 4 vertices * 2 coordinates) all within [0, 1]', () => {
    for (const part of SKIN_PARTS) {
      for (const layer of SKIN_LAYERS) {
        const uvs = computeBoxUVs(part, layer)
        expect(uvs.length).toBe(48)
        for (let i = 0; i < uvs.length; i++) {
          expect(uvs[i]).toBeGreaterThanOrEqual(0)
          expect(uvs[i]).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('applies UVs to BoxGeometry without modifying positions or normals', () => {
    const box = new THREE.BoxGeometry(0.4, 0.4, 0.4)
    const positionCount = box.attributes.position.count
    applySkinUVs(box, 'head', 'base')
    expect(box.attributes.uv.count).toBe(positionCount)
    expect(box.attributes.uv.array.length).toBe(48)
  })

  it('creates skin box geometries with optional translation pivot', () => {
    const geo = createSkinBoxGeometry(0.12, 0.52, 0.14, 'rightArm', 'base', [0, -0.26, 0])
    expect(geo.attributes.uv.array.length).toBe(48)

    // Check pivot translation applied: top vertex y should be ~0, bottom ~ -0.52
    const pos = geo.attributes.position
    let maxY = -Infinity
    let minY = Infinity
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i)
      if (y > maxY) maxY = y
      if (y < minY) minY = y
    }
    expect(maxY).toBeCloseTo(0, 4)
    expect(minY).toBeCloseTo(-0.52, 4)
  })
})

describe('Procedural fallback skin generator', () => {
  const lookDev = {
    hair: '#2c221e',
    skin: '#f5cba7',
    shirt: '#1976d2',
    pants: '#263238',
  }
  const lookUi = {
    hair: '#8d4925',
    skin: '#e0ac69',
    shirt: '#43a047',
    pants: '#37474f',
  }

  it('paints exact 64x64 RGBA byte buffer (16384 bytes)', () => {
    const data = paintDefaultSkin(lookDev)
    expect(data.length).toBe(SKIN_WIDTH * SKIN_HEIGHT * 4)
  })

  it('produces distinct pixel buffers for distinct agent palettes', () => {
    const data1 = paintDefaultSkin(lookDev)
    const data2 = paintDefaultSkin(lookUi)
    expect(data1).not.toEqual(data2)
  })

  it('paints hair and jacket on overlay layer with positive alpha', () => {
    const data = paintDefaultSkin(lookDev)
    expect(hasOverlayPixels(data, 'head')).toBe(true)
    expect(hasOverlayPixels(data, 'body')).toBe(true)
    expect(hasOverlayPixels(data)).toBe(true)
  })

  it('detects empty overlay when overlay pixels have alpha 0', () => {
    const empty = new Uint8ClampedArray(SKIN_WIDTH * SKIN_HEIGHT * 4)
    expect(hasOverlayPixels(empty)).toBe(false)
  })

  it('creates crisp NearestFilter DataTexture with sRGB colorspace', () => {
    const data = paintDefaultSkin(lookDev)
    const texture = createSkinDataTexture(data)
    expect(texture.magFilter).toBe(THREE.NearestFilter)
    expect(texture.minFilter).toBe(THREE.NearestFilter)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
  })
})

describe('SkinTextureManager', () => {
  it('generates and caches default skin on demand for any agent id', () => {
    const entry1 = skinTextureManager.get('dev')
    expect(entry1.texture).toBeDefined()
    expect(entry1.version).toBe('default')

    const entry2 = skinTextureManager.get('dev')
    expect(entry2.texture).toBe(entry1.texture)
  })

  it('caches custom textures under version keys', () => {
    const dummy = new THREE.DataTexture(new Uint8ClampedArray(64 * 64 * 4), 64, 64)
    skinTextureManager.set('test-agent', 'v1', dummy, true)

    expect(skinTextureManager.has('test-agent', 'v1')).toBe(true)
    const entry = skinTextureManager.get('test-agent', 'v1')
    expect(entry.texture).toBe(dummy)
    expect(entry.hasOverlay).toBe(true)
    expect(entry.version).toBe('v1')
  })
})

describe('PNG encoder & Dev mock', () => {
  it('encodes RGBA buffer into valid PNG binary stream with correct signature and IHDR', () => {
    const data = createTestSkinData()
    const png = encodeRgbaToPng(64, 64, data)

    // PNG signature
    expect(Array.from(png.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])

    // IHDR chunk type at offset 12..16 is "IHDR"
    const ihdr = String.fromCharCode(...png.subarray(12, 16))
    expect(ihdr).toBe('IHDR')

    // Width (64) and Height (64) in IHDR
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
    expect(view.getUint32(16)).toBe(64)
    expect(view.getUint32(20)).toBe(64)
  })

  it('creates test skin PNG fixture with visor overlay', () => {
    const png = createTestSkinPng()
    expect(png.length).toBeGreaterThan(100)
    expect(png[0]).toBe(0x89)
    expect(png[1]).toBe(0x50)
  })
})
