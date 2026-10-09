import * as THREE from 'three'
import { agentLook, type AgentLook } from '../agents'
import { usePolling, type Polled } from '../polling'
import { useEffect, useState } from 'react'

export const SKIN_WIDTH = 64
export const SKIN_HEIGHT = 64

export type SkinPartName = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg'
export type SkinFaceName = 'top' | 'bottom' | 'right' | 'left' | 'front' | 'back'
export type SkinLayer = 'base' | 'overlay'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface SkinsSnapshot {
  skins: Record<string, {
    version: string
    updatedAt: string
  }>
}

export const SKIN_PARTS: readonly SkinPartName[] = [
  'head',
  'body',
  'rightArm',
  'leftArm',
  'rightLeg',
  'leftLeg',
] as const

export const SKIN_FACES: readonly SkinFaceName[] = [
  'top',
  'bottom',
  'right',
  'left',
  'front',
  'back',
] as const

export const SKIN_LAYERS: readonly SkinLayer[] = ['base', 'overlay'] as const

// Three.js BoxGeometry face index order:
// Face 0: +X (character anatomical left)
// Face 1: -X (character anatomical right)
// Face 2: +Y (top)
// Face 3: -Y (bottom)
// Face 4: +Z (front)
// Face 5: -Z (back)
export const BOX_FACE_NAMES: readonly SkinFaceName[] = [
  'left',
  'right',
  'top',
  'bottom',
  'front',
  'back',
] as const

export const SKIN_RECTS: Record<SkinPartName, Record<SkinLayer, Record<SkinFaceName, Rect>>> = {
  head: {
    base: {
      top: { x: 8, y: 0, w: 8, h: 8 },
      bottom: { x: 16, y: 0, w: 8, h: 8 },
      right: { x: 0, y: 8, w: 8, h: 8 },
      front: { x: 8, y: 8, w: 8, h: 8 },
      left: { x: 16, y: 8, w: 8, h: 8 },
      back: { x: 24, y: 8, w: 8, h: 8 },
    },
    overlay: {
      top: { x: 40, y: 0, w: 8, h: 8 },
      bottom: { x: 48, y: 0, w: 8, h: 8 },
      right: { x: 32, y: 8, w: 8, h: 8 },
      front: { x: 40, y: 8, w: 8, h: 8 },
      left: { x: 48, y: 8, w: 8, h: 8 },
      back: { x: 56, y: 8, w: 8, h: 8 },
    },
  },
  body: {
    base: {
      top: { x: 20, y: 16, w: 8, h: 4 },
      bottom: { x: 28, y: 16, w: 8, h: 4 },
      right: { x: 16, y: 20, w: 4, h: 12 },
      front: { x: 20, y: 20, w: 8, h: 12 },
      left: { x: 28, y: 20, w: 4, h: 12 },
      back: { x: 32, y: 20, w: 8, h: 12 },
    },
    overlay: {
      top: { x: 20, y: 32, w: 8, h: 4 },
      bottom: { x: 28, y: 32, w: 8, h: 4 },
      right: { x: 16, y: 36, w: 4, h: 12 },
      front: { x: 20, y: 36, w: 8, h: 12 },
      left: { x: 28, y: 36, w: 4, h: 12 },
      back: { x: 32, y: 36, w: 8, h: 12 },
    },
  },
  rightArm: {
    base: {
      top: { x: 44, y: 16, w: 4, h: 4 },
      bottom: { x: 48, y: 16, w: 4, h: 4 },
      right: { x: 40, y: 20, w: 4, h: 12 },
      front: { x: 44, y: 20, w: 4, h: 12 },
      left: { x: 48, y: 20, w: 4, h: 12 },
      back: { x: 52, y: 20, w: 4, h: 12 },
    },
    overlay: {
      top: { x: 44, y: 32, w: 4, h: 4 },
      bottom: { x: 48, y: 32, w: 4, h: 4 },
      right: { x: 40, y: 36, w: 4, h: 12 },
      front: { x: 44, y: 36, w: 4, h: 12 },
      left: { x: 48, y: 36, w: 4, h: 12 },
      back: { x: 52, y: 36, w: 4, h: 12 },
    },
  },
  leftArm: {
    base: {
      top: { x: 36, y: 48, w: 4, h: 4 },
      bottom: { x: 40, y: 48, w: 4, h: 4 },
      right: { x: 32, y: 52, w: 4, h: 12 },
      front: { x: 36, y: 52, w: 4, h: 12 },
      left: { x: 40, y: 52, w: 4, h: 12 },
      back: { x: 44, y: 52, w: 4, h: 12 },
    },
    overlay: {
      top: { x: 52, y: 48, w: 4, h: 4 },
      bottom: { x: 56, y: 48, w: 4, h: 4 },
      right: { x: 48, y: 52, w: 4, h: 12 },
      front: { x: 52, y: 52, w: 4, h: 12 },
      left: { x: 56, y: 52, w: 4, h: 12 },
      back: { x: 60, y: 52, w: 4, h: 12 },
    },
  },
  rightLeg: {
    base: {
      top: { x: 4, y: 16, w: 4, h: 4 },
      bottom: { x: 8, y: 16, w: 4, h: 4 },
      right: { x: 0, y: 20, w: 4, h: 12 },
      front: { x: 4, y: 20, w: 4, h: 12 },
      left: { x: 8, y: 20, w: 4, h: 12 },
      back: { x: 12, y: 20, w: 4, h: 12 },
    },
    overlay: {
      top: { x: 4, y: 32, w: 4, h: 4 },
      bottom: { x: 8, y: 32, w: 4, h: 4 },
      right: { x: 0, y: 36, w: 4, h: 12 },
      front: { x: 4, y: 36, w: 4, h: 12 },
      left: { x: 8, y: 36, w: 4, h: 12 },
      back: { x: 12, y: 36, w: 4, h: 12 },
    },
  },
  leftLeg: {
    base: {
      top: { x: 20, y: 48, w: 4, h: 4 },
      bottom: { x: 24, y: 48, w: 4, h: 4 },
      right: { x: 16, y: 52, w: 4, h: 12 },
      front: { x: 20, y: 52, w: 4, h: 12 },
      left: { x: 24, y: 52, w: 4, h: 12 },
      back: { x: 28, y: 52, w: 4, h: 12 },
    },
    overlay: {
      top: { x: 4, y: 48, w: 4, h: 4 },
      bottom: { x: 8, y: 48, w: 4, h: 4 },
      right: { x: 0, y: 52, w: 4, h: 12 },
      front: { x: 4, y: 52, w: 4, h: 12 },
      left: { x: 8, y: 52, w: 4, h: 12 },
      back: { x: 12, y: 52, w: 4, h: 12 },
    },
  },
}

export const SKIN_PART_BOUNDS: Record<SkinPartName, Record<SkinLayer, Rect>> = {
  head: {
    base: { x: 0, y: 0, w: 32, h: 16 },
    overlay: { x: 32, y: 0, w: 32, h: 16 },
  },
  body: {
    base: { x: 16, y: 16, w: 24, h: 16 },
    overlay: { x: 16, y: 32, w: 24, h: 16 },
  },
  rightArm: {
    base: { x: 40, y: 16, w: 16, h: 16 },
    overlay: { x: 40, y: 32, w: 16, h: 16 },
  },
  leftArm: {
    base: { x: 32, y: 48, w: 16, h: 16 },
    overlay: { x: 48, y: 48, w: 16, h: 16 },
  },
  rightLeg: {
    base: { x: 0, y: 16, w: 16, h: 16 },
    overlay: { x: 0, y: 32, w: 16, h: 16 },
  },
  leftLeg: {
    base: { x: 16, y: 48, w: 16, h: 16 },
    overlay: { x: 0, y: 48, w: 16, h: 16 },
  },
}

/** Compute the 48 UV floats for a BoxGeometry corresponding to the given part and layer. */
export function computeBoxUVs(part: SkinPartName, layer: SkinLayer): Float32Array {
  const uvs = new Float32Array(48)
  const partRects = SKIN_RECTS[part][layer]

  BOX_FACE_NAMES.forEach((faceName, faceIdx) => {
    const rect = partRects[faceName]
    const u0 = rect.x / SKIN_WIDTH
    const u1 = (rect.x + rect.w) / SKIN_WIDTH
    const v0 = 1 - (rect.y + rect.h) / SKIN_HEIGHT
    const v1 = 1 - rect.y / SKIN_HEIGHT

    // 4 vertices per face in Three.js BoxGeometry plane order:
    // v0: top-left (u0, v1)
    // v1: top-right (u1, v1)
    // v2: bottom-left (u0, v0)
    // v3: bottom-right (u1, v0)
    const offset = faceIdx * 8
    uvs[offset + 0] = u0
    uvs[offset + 1] = v1
    uvs[offset + 2] = u1
    uvs[offset + 3] = v1
    uvs[offset + 4] = u0
    uvs[offset + 5] = v0
    uvs[offset + 6] = u1
    uvs[offset + 7] = v0
  })

  return uvs
}

/** Set custom skin UVs on a BoxGeometry. */
export function applySkinUVs(geometry: THREE.BoxGeometry, part: SkinPartName, layer: SkinLayer): THREE.BoxGeometry {
  const uvs = computeBoxUVs(part, layer)
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  return geometry
}

/** Create a UV-mapped BoxGeometry with optional pivot translation. */
export function createSkinBoxGeometry(
  width: number,
  height: number,
  depth: number,
  part: SkinPartName,
  layer: SkinLayer,
  translate?: [number, number, number],
): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(width, height, depth)
  if (translate) {
    geo.translate(...translate)
  }
  return applySkinUVs(geo, part, layer)
}

/** Check if overlay pixels in the skin texture have alpha > 0. */
export function hasOverlayPixels(data: Uint8ClampedArray | Uint8Array, part?: SkinPartName): boolean {
  const partsToCheck: SkinPartName[] = part ? [part] : (SKIN_PARTS as unknown as SkinPartName[])
  for (const p of partsToCheck) {
    const rects = SKIN_RECTS[p].overlay
    for (const face of BOX_FACE_NAMES) {
      const { x, y, w, h } = rects[face]
      for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
          const alphaIdx = (py * SKIN_WIDTH + px) * 4 + 3
          if (data[alphaIdx] > 0) {
            return true
          }
        }
      }
    }
  }
  return false
}

function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  const c = parseInt(hex.replace('#', ''), 16)
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255, alpha]
}

function fillRect(
  data: Uint8ClampedArray,
  x: number,
  y: number,
  w: number,
  h: number,
  color: [number, number, number, number],
): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const idx = (py * SKIN_WIDTH + px) * 4
      data[idx] = color[0]
      data[idx + 1] = color[1]
      data[idx + 2] = color[2]
      data[idx + 3] = color[3]
    }
  }
}

/** Paint default 64x64 Minecraft-layout skin client-side from agentLook palette. */
export function paintDefaultSkin(look: AgentLook): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SKIN_WIDTH * SKIN_HEIGHT * 4)

  const hair = hexToRgba(look.hair)
  const skin = hexToRgba(look.skin)
  const shirt = hexToRgba(look.shirt)
  const pants = hexToRgba(look.pants)
  const eyePupil: [number, number, number, number] = [23, 32, 30, 255] // #17201e
  const eyeWhite: [number, number, number, number] = [255, 255, 255, 255]
  const mouth: [number, number, number, number] = [154, 90, 68, 255] // #9a5a44
  const shoes: [number, number, number, number] = [34, 38, 42, 255]

  const fill = (rect: Rect, color: [number, number, number, number]) => {
    fillRect(data, rect.x, rect.y, rect.w, rect.h, color)
  }

  // 1. Head (base)
  const hb = SKIN_RECTS.head.base
  fill(hb.top, hair)
  fill(hb.bottom, skin)
  fill(hb.back, hair)

  // Right side: skin base + hair top & sideburn
  fill(hb.right, skin)
  fillRect(data, hb.right.x, hb.right.y, hb.right.w, 3, hair)
  fillRect(data, hb.right.x + 4, hb.right.y + 3, 4, 2, hair)

  // Left side: skin base + hair top & sideburn
  fill(hb.left, skin)
  fillRect(data, hb.left.x, hb.left.y, hb.left.w, 3, hair)
  fillRect(data, hb.left.x, hb.left.y + 3, 4, 2, hair)

  // Front: skin face + hair bangs + eyes + mouth
  fill(hb.front, skin)
  fillRect(data, hb.front.x, hb.front.y, hb.front.w, 2, hair)
  fillRect(data, hb.front.x + 3, hb.front.y + 2, 2, 1, hair)

  // Eyes in front face (x in 8..15, y in 8..15; y=12)
  // Character right eye (viewer left):
  fillRect(data, hb.front.x + 1, hb.front.y + 4, 1, 1, eyeWhite)
  fillRect(data, hb.front.x + 2, hb.front.y + 4, 1, 1, eyePupil)
  // Character left eye (viewer right):
  fillRect(data, hb.front.x + 5, hb.front.y + 4, 1, 1, eyePupil)
  fillRect(data, hb.front.x + 6, hb.front.y + 4, 1, 1, eyeWhite)
  // Mouth (y=14)
  fillRect(data, hb.front.x + 3, hb.front.y + 6, 2, 1, mouth)

  // 2. Body (base)
  const bb = SKIN_RECTS.body.base
  fill(bb.top, shirt)
  fill(bb.bottom, pants)
  fill(bb.back, shirt)
  fill(bb.right, shirt)
  fill(bb.left, shirt)
  fill(bb.front, shirt)
  // Collar detail
  fillRect(data, bb.front.x + 3, bb.front.y, 2, 1, skin)

  // 3. Right Arm (base)
  const rab = SKIN_RECTS.rightArm.base
  fill(rab.top, shirt)
  fill(rab.bottom, skin)
  fill(rab.right, shirt)
  fillRect(data, rab.right.x, rab.right.y + 8, rab.right.w, 4, skin)
  fill(rab.front, shirt)
  fillRect(data, rab.front.x, rab.front.y + 8, rab.front.w, 4, skin)
  fill(rab.left, shirt)
  fillRect(data, rab.left.x, rab.left.y + 8, rab.left.w, 4, skin)
  fill(rab.back, shirt)
  fillRect(data, rab.back.x, rab.back.y + 8, rab.back.w, 4, skin)

  // 4. Left Arm (base)
  const lab = SKIN_RECTS.leftArm.base
  fill(lab.top, shirt)
  fill(lab.bottom, skin)
  fill(lab.right, shirt)
  fillRect(data, lab.right.x, lab.right.y + 8, lab.right.w, 4, skin)
  fill(lab.front, shirt)
  fillRect(data, lab.front.x, lab.front.y + 8, lab.front.w, 4, skin)
  fill(lab.left, shirt)
  fillRect(data, lab.left.x, lab.left.y + 8, lab.left.w, 4, skin)
  fill(lab.back, shirt)
  fillRect(data, lab.back.x, lab.back.y + 8, lab.back.w, 4, skin)

  // 5. Right Leg (base)
  const rlb = SKIN_RECTS.rightLeg.base
  fill(rlb.top, pants)
  fill(rlb.bottom, shoes)
  fill(rlb.right, pants)
  fillRect(data, rlb.right.x, rlb.right.y + 10, rlb.right.w, 2, shoes)
  fill(rlb.front, pants)
  fillRect(data, rlb.front.x, rlb.front.y + 10, rlb.front.w, 2, shoes)
  fill(rlb.left, pants)
  fillRect(data, rlb.left.x, rlb.left.y + 10, rlb.left.w, 2, shoes)
  fill(rlb.back, pants)
  fillRect(data, rlb.back.x, rlb.back.y + 10, rlb.back.w, 2, shoes)

  // 6. Left Leg (base)
  const llb = SKIN_RECTS.leftLeg.base
  fill(llb.top, pants)
  fill(llb.bottom, shoes)
  fill(llb.right, pants)
  fillRect(data, llb.right.x, llb.right.y + 10, llb.right.w, 2, shoes)
  fill(llb.front, pants)
  fillRect(data, llb.front.x, llb.front.y + 10, llb.front.w, 2, shoes)
  fill(llb.left, pants)
  fillRect(data, llb.left.x, llb.left.y + 10, llb.left.w, 2, shoes)
  fill(llb.back, pants)
  fillRect(data, llb.back.x, llb.back.y + 10, llb.back.w, 2, shoes)

  // 7. Head Overlay (Hair volume and bangs)
  const ho = SKIN_RECTS.head.overlay
  fill(ho.top, hair)
  fill(ho.back, hair)
  fillRect(data, ho.right.x, ho.right.y, ho.right.w, 4, hair)
  fillRect(data, ho.left.x, ho.left.y, ho.left.w, 4, hair)
  fillRect(data, ho.front.x, ho.front.y, ho.front.w, 3, hair)
  fillRect(data, ho.front.x + 2, ho.front.y + 3, 2, 1, hair)

  // 8. Body Overlay (Jacket collar / edges)
  const bo = SKIN_RECTS.body.overlay
  const jacketTrim: [number, number, number, number] = [
    Math.min(255, shirt[0] + 35),
    Math.min(255, shirt[1] + 35),
    Math.min(255, shirt[2] + 35),
    255,
  ]
  fillRect(data, bo.front.x + 1, bo.front.y, 2, 3, jacketTrim)
  fillRect(data, bo.front.x + 5, bo.front.y, 2, 3, jacketTrim)

  return data
}

/** Create a DataTexture with pixelated nearest filter and sRGB color space. */
export function createSkinDataTexture(data: Uint8ClampedArray | Uint8Array): THREE.DataTexture {
  const clamped = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
  const texture = new THREE.DataTexture(clamped, SKIN_WIDTH, SKIN_HEIGHT, THREE.RGBAFormat)
  texture.flipY = true
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

export interface CachedTextureEntry {
  texture: THREE.Texture
  hasOverlay: boolean
  version: string
}

export class SkinTextureManager {
  private cache = new Map<string, CachedTextureEntry>()

  get(id: string, version?: string, look?: AgentLook): CachedTextureEntry {
    const key = `${id}:${version || 'default'}`
    const existing = this.cache.get(key)
    if (existing) {
      return existing
    }

    // Default skin entry
    const defaultKey = `${id}:default`
    let defaultEntry = this.cache.get(defaultKey)
    if (!defaultEntry) {
      const data = paintDefaultSkin(look ?? agentLook(id))
      const texture = createSkinDataTexture(data)
      const hasOverlay = hasOverlayPixels(data)
      defaultEntry = { texture, hasOverlay, version: 'default' }
      this.cache.set(defaultKey, defaultEntry)
    }

    return defaultEntry
  }

  set(id: string, version: string, texture: THREE.Texture, hasOverlay: boolean): void {
    const key = `${id}:${version}`
    // Clean up older custom versions for this agent
    for (const [existingKey, entry] of this.cache.entries()) {
      if (existingKey.startsWith(`${id}:`) && existingKey !== `${id}:default` && existingKey !== key) {
        entry.texture.dispose()
        this.cache.delete(existingKey)
      }
    }
    this.cache.set(key, { texture, hasOverlay, version })
  }

  has(id: string, version?: string): boolean {
    const key = `${id}:${version || 'default'}`
    return this.cache.has(key)
  }

  disposeAgent(id: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(`${id}:`)) {
        entry.texture.dispose()
        this.cache.delete(key)
      }
    }
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      entry.texture.dispose()
    }
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

export const skinTextureManager = new SkinTextureManager()

/** Load PNG skin image for an agent from /api/skins/:id.png, with fallback to default. */
export async function loadSkinImage(id: string, version: string): Promise<CachedTextureEntry> {
  const url = `/api/skins/${encodeURIComponent(id)}.png`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`Failed to load skin image: ${res.status}`)
    }
    const blob = await res.blob()

    // Environment-safe texture creation:
    if (typeof createImageBitmap !== 'undefined' && typeof document !== 'undefined') {
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = SKIN_WIDTH
      canvas.height = SKIN_HEIGHT
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Cannot get 2d context')
      ctx.drawImage(bitmap, 0, 0)
      const imgData = ctx.getImageData(0, 0, SKIN_WIDTH, SKIN_HEIGHT)
      const hasOverlay = hasOverlayPixels(imgData.data)

      const texture = new THREE.CanvasTexture(canvas)
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.generateMipmaps = false
      texture.colorSpace = THREE.SRGBColorSpace
      texture.needsUpdate = true

      skinTextureManager.set(id, version, texture, hasOverlay)
      return { texture, hasOverlay, version }
    } else {
      // Fallback for non-DOM / test environments
      const buffer = new Uint8Array(await blob.arrayBuffer())
      const data = new Uint8ClampedArray(SKIN_WIDTH * SKIN_HEIGHT * 4)
      if (buffer.length >= SKIN_WIDTH * SKIN_HEIGHT * 4) {
        data.set(buffer.subarray(0, data.length))
      }
      const hasOverlay = hasOverlayPixels(data)
      const texture = createSkinDataTexture(data)
      skinTextureManager.set(id, version, texture, hasOverlay)
      return { texture, hasOverlay, version }
    }
  } catch {
    // PNG load failure -> default skin, no crash
    return skinTextureManager.get(id, undefined)
  }
}

/** React hook to obtain skin texture and overlay presence for a given agent. */
export function useSkinTexture(id: string, version?: string): { texture: THREE.Texture; hasOverlay: boolean } {
  const [entry, setEntry] = useState<CachedTextureEntry>(() => skinTextureManager.get(id, version))

  useEffect(() => {
    const current = skinTextureManager.get(id, version)
    setEntry(current)

    if (version && !skinTextureManager.has(id, version)) {
      let cancelled = false
      loadSkinImage(id, version).then((loaded) => {
        if (!cancelled) {
          setEntry(loaded)
        }
      })
      return () => {
        cancelled = true
      }
    }
  }, [id, version])

  return entry
}

const SKINS_REFRESH_EVENT = 'ruang:skins-refresh'

export function triggerSkinsRefresh(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SKINS_REFRESH_EVENT))
  }
}

/** Poll /api/skins snapshot every 15s. Refreshes immediately on ruang:skins-refresh. */
export function useSkins(): Polled<SkinsSnapshot> {
  const polled = usePolling<SkinsSnapshot>('/api/skins', 15_000)
  const refresh = polled.refresh
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onRefresh = () => {
      refresh()
    }
    window.addEventListener(SKINS_REFRESH_EVENT, onRefresh)
    return () => {
      window.removeEventListener(SKINS_REFRESH_EVENT, onRefresh)
    }
  }, [refresh])
  return polled
}

// Lightweight dependency-free PNG encoder (RFC 1950 / RFC 1951 uncompressed DEFLATE):
const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  crcTable[i] = c
}

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function adler32(buf: Uint8Array): number {
  let s1 = 1
  let s2 = 0
  for (let i = 0; i < buf.length; i++) {
    s1 = (s1 + buf[i]) % 65521
    s2 = (s2 + s1) % 65521
  }
  return ((s2 << 16) | s1) >>> 0
}

/** Encode RGBA pixel data to a valid standard PNG image binary buffer. */
export function encodeRgbaToPng(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  // Raw scanlines: 1 filter byte (0 = none) + width * 4 bytes per scanline
  const scanlineLength = 1 + width * 4
  const rawData = new Uint8Array(height * scanlineLength)

  for (let y = 0; y < height; y++) {
    const rawOffset = y * scanlineLength
    rawData[rawOffset] = 0 // Filter type: None
    const rgbaOffset = y * width * 4
    rawData.set(rgba.subarray(rgbaOffset, rgbaOffset + width * 4), rawOffset + 1)
  }

  // ZLIB stream with non-compressed DEFLATE block:
  const rawLen = rawData.length
  // Header: 2 bytes zlib (0x78, 0x01)
  // DEFLATE block: 1 byte header (0x01 for final), 2 bytes LEN, 2 bytes NLEN, data
  // Checksum: 4 bytes Adler32
  const zlibLen = 2 + 5 + rawLen + 4
  const zlibData = new Uint8Array(zlibLen)
  zlibData[0] = 0x78
  zlibData[1] = 0x01
  zlibData[2] = 0x01 // BFINAL = 1, BTYPE = 00 (no compression)
  zlibData[3] = rawLen & 0xff
  zlibData[4] = (rawLen >> 8) & 0xff
  zlibData[5] = (~rawLen) & 0xff
  zlibData[6] = ((~rawLen) >> 8) & 0xff
  zlibData.set(rawData, 7)

  const adler = adler32(rawData)
  const adlerOffset = 7 + rawLen
  zlibData[adlerOffset + 0] = (adler >> 24) & 0xff
  zlibData[adlerOffset + 1] = (adler >> 16) & 0xff
  zlibData[adlerOffset + 2] = (adler >> 8) & 0xff
  zlibData[adlerOffset + 3] = adler & 0xff

  // Build PNG chunks: Signature + IHDR + IDAT + IEND
  // Signature (8 bytes)
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // IHDR: 13 bytes
  const ihdrData = new Uint8Array(13)
  ihdrData[0] = (width >> 24) & 0xff
  ihdrData[1] = (width >> 16) & 0xff
  ihdrData[2] = (width >> 8) & 0xff
  ihdrData[3] = width & 0xff
  ihdrData[4] = (height >> 24) & 0xff
  ihdrData[5] = (height >> 16) & 0xff
  ihdrData[6] = (height >> 8) & 0xff
  ihdrData[7] = height & 0xff
  ihdrData[8] = 8 // Bit depth: 8
  ihdrData[9] = 6 // Color type: 6 (RGBA)
  ihdrData[10] = 0 // Compression method: 0
  ihdrData[11] = 0 // Filter method: 0
  ihdrData[12] = 0 // Interlace method: 0

  function makeChunk(type: string, data: Uint8Array): Uint8Array {
    const chunk = new Uint8Array(4 + 4 + data.length + 4)
    const len = data.length
    chunk[0] = (len >> 24) & 0xff
    chunk[1] = (len >> 16) & 0xff
    chunk[2] = (len >> 8) & 0xff
    chunk[3] = len & 0xff

    for (let i = 0; i < 4; i++) {
      chunk[4 + i] = type.charCodeAt(i)
    }
    chunk.set(data, 8)

    const crcPayload = chunk.subarray(4, 8 + data.length)
    const crc = crc32(crcPayload)
    const crcOffset = 8 + data.length
    chunk[crcOffset + 0] = (crc >> 24) & 0xff
    chunk[crcOffset + 1] = (crc >> 16) & 0xff
    chunk[crcOffset + 2] = (crc >> 8) & 0xff
    chunk[crcOffset + 3] = crc & 0xff
    return chunk
  }

  const ihdrChunk = makeChunk('IHDR', ihdrData)
  const idatChunk = makeChunk('IDAT', zlibData)
  const iendChunk = makeChunk('IEND', new Uint8Array(0))

  const totalLength = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  const png = new Uint8Array(totalLength)
  let offset = 0
  png.set(signature, offset); offset += signature.length
  png.set(ihdrChunk, offset); offset += ihdrChunk.length
  png.set(idatChunk, offset); offset += idatChunk.length
  png.set(iendChunk, offset)

  return png
}
