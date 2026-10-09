// keep in sync with src/scene3d/skin.ts

export const SKIN_WIDTH = 64
export const SKIN_HEIGHT = 64

export type SkinPartName = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg'
export type SkinFaceName = 'top' | 'bottom' | 'right' | 'left' | 'front' | 'back'
export type SkinLayer = 'base' | 'overlay'
export type SkinPart = 'all' | 'head' | 'body' | 'arms' | 'legs'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
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

// Precomputed 64x64 mask: 1 = pixel is inside a layout face rect, 0 = outside (unused)
const layoutMask = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT)
for (const part of SKIN_PARTS) {
  for (const layer of SKIN_LAYERS) {
    for (const face of SKIN_FACES) {
      const rect = SKIN_RECTS[part][layer][face]
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          layoutMask[y * SKIN_WIDTH + x] = 1
        }
      }
    }
  }
}

export function isInsideLayout(x: number, y: number): boolean {
  if (x < 0 || x >= SKIN_WIDTH || y < 0 || y >= SKIN_HEIGHT) return false
  return layoutMask[y * SKIN_WIDTH + x] === 1
}

export function isCoordInPart(x: number, y: number, part: SkinPart): boolean {
  if (part === 'all') return true
  if (part === 'head') {
    return y >= 0 && y <= 15
  }
  if (part === 'body') {
    return x >= 16 && x <= 39 && y >= 16 && y <= 47
  }
  if (part === 'arms') {
    const isRightArm = x >= 40 && x <= 55 && y >= 16 && y <= 47
    const isLeftArm = x >= 32 && x <= 63 && y >= 48 && y <= 63
    return isRightArm || isLeftArm
  }
  if (part === 'legs') {
    const isRightLeg = x >= 0 && x <= 15 && y >= 16 && y <= 47
    const isLeftLeg = x >= 0 && x <= 31 && y >= 48 && y <= 63
    return isRightLeg || isLeftLeg
  }
  return false
}
