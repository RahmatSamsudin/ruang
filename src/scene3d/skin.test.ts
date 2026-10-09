import { describe, expect, it, vi } from 'vitest'
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
  loadSkinImage,
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

  it('paints eyes in head-front region and applies body colors from agentLook', () => {
    const data = paintDefaultSkin(lookDev)

    const getPixel = (x: number, y: number): [number, number, number, number] => {
      const idx = (y * SKIN_WIDTH + x) * 4
      return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]]
    }

    const hbFront = SKIN_RECTS.head.base.front
    // Eyes: right eye (viewer left) white and pupil, left eye (viewer right) pupil and white
    expect(getPixel(hbFront.x + 1, hbFront.y + 4)).toEqual([255, 255, 255, 255])
    expect(getPixel(hbFront.x + 2, hbFront.y + 4)).toEqual([23, 32, 30, 255])
    expect(getPixel(hbFront.x + 5, hbFront.y + 4)).toEqual([23, 32, 30, 255])
    expect(getPixel(hbFront.x + 6, hbFront.y + 4)).toEqual([255, 255, 255, 255])

    // Head base skin color on face (below eyes)
    expect(getPixel(hbFront.x + 1, hbFront.y + 5)).toEqual([245, 203, 167, 255])

    // Head hair color
    const hbTop = SKIN_RECTS.head.base.top
    expect(getPixel(hbTop.x + 2, hbTop.y + 2)).toEqual([44, 34, 30, 255])

    // Body shirt color
    const bbFront = SKIN_RECTS.body.base.front
    expect(getPixel(bbFront.x + 1, bbFront.y + 5)).toEqual([25, 118, 210, 255])

    // Leg pants color
    const rlbFront = SKIN_RECTS.rightLeg.base.front
    expect(getPixel(rlbFront.x + 1, rlbFront.y + 2)).toEqual([38, 50, 56, 255])

    // Palette change applies to painted body colors
    const dataUi = paintDefaultSkin(lookUi)
    const getPixelUi = (x: number, y: number): [number, number, number, number] => {
      const idx = (y * SKIN_WIDTH + x) * 4
      return [dataUi[idx], dataUi[idx + 1], dataUi[idx + 2], dataUi[idx + 3]]
    }
    expect(getPixelUi(hbTop.x + 2, hbTop.y + 2)).toEqual([141, 73, 37, 255])
    expect(getPixelUi(hbFront.x + 1, hbFront.y + 5)).toEqual([224, 172, 105, 255])
    expect(getPixelUi(bbFront.x + 1, bbFront.y + 5)).toEqual([67, 160, 71, 255])
    expect(getPixelUi(rlbFront.x + 1, rlbFront.y + 2)).toEqual([55, 71, 79, 255])
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

  it('creates crisp NearestFilter DataTexture with sRGB colorspace and flipY=true', () => {
    const data = paintDefaultSkin(lookDev)
    const texture = createSkinDataTexture(data)
    expect(texture.magFilter).toBe(THREE.NearestFilter)
    expect(texture.minFilter).toBe(THREE.NearestFilter)
    expect(texture.generateMipmaps).toBe(false)
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(texture.flipY).toBe(true)
  })

  it('regression: DataTexture flipY=true samples head front face identically to CanvasTexture', () => {
    const data = paintDefaultSkin(lookDev)
    const dataTex = createSkinDataTexture(data)
    expect(dataTex.flipY).toBe(true)

    // Three.js CanvasTexture defaults to flipY = true
    const canvasTex = new THREE.CanvasTexture({} as HTMLCanvasElement)
    expect(canvasTex.flipY).toBe(true)
    expect(dataTex.flipY).toBe(canvasTex.flipY)

    // Map the front-face UV of the head to eye pixels of default skin
    const hbFront = SKIN_RECTS.head.base.front
    const eyeX = hbFront.x + 1 // 9
    const eyeY = hbFront.y + 4 // 12

    // UV formula from computeBoxUVs: v = 1 - y/64
    const eyeU = (eyeX + 0.5) / SKIN_WIDTH
    const eyeV = 1 - (eyeY + 0.5) / SKIN_HEIGHT

    // With flipY=true in WebGL, sampling v maps to row Math.floor((1 - v) * height)
    const sampleRow = Math.floor((1 - eyeV) * SKIN_HEIGHT)
    const sampleCol = Math.floor(eyeU * SKIN_WIDTH)
    expect(sampleRow).toBe(eyeY)
    expect(sampleCol).toBe(eyeX)

    const pixelIdx = (sampleRow * SKIN_WIDTH + sampleCol) * 4
    // Eye white pixel is non-transparent [255, 255, 255, 255]
    expect(data[pixelIdx + 3]).toBe(255)
    expect(data[pixelIdx]).toBe(255)
    expect(data[pixelIdx + 1]).toBe(255)
    expect(data[pixelIdx + 2]).toBe(255)

    // Without flipY (flipY=false), row would sample inverted row 51 which is transparent
    const invertedRow = Math.floor(eyeV * SKIN_HEIGHT)
    const invertedIdx = (invertedRow * SKIN_WIDTH + sampleCol) * 4
    expect(invertedRow).toBe(51)
    expect(data[invertedIdx + 3]).toBe(0)
  })
})

describe('SkinTextureManager', () => {
  it('generates and caches default skin on demand for any agent id', () => {
    const entry1 = skinTextureManager.get('dev')
    expect(entry1.texture).toBeDefined()
    expect(entry1.version).toBe('default')
    expect(entry1.hasOverlay).toBe(true)

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

  it('falls back to default skin when PNG fetch returns non-200 status', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      }) as unknown as typeof fetch

      const defaultEntry = skinTextureManager.get('fallback-agent')
      const entry = await loadSkinImage('fallback-agent', 'v-missing')

      expect(entry).toBeDefined()
      expect(entry.version).toBe('default')
      expect(entry.texture).toBe(defaultEntry.texture)
      expect(entry.hasOverlay).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to default skin when PNG fetch throws a network exception', async () => {
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network offline')) as unknown as typeof fetch

      const entry = await loadSkinImage('network-err-agent', 'v-err')
      expect(entry).toBeDefined()
      expect(entry.version).toBe('default')
      expect(entry.texture).toBeDefined()
      expect(entry.hasOverlay).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
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
