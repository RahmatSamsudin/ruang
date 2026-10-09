import { describe, expect, it } from 'vitest'
import {
  SKIN_SIZE,
  BUFFER_LENGTH,
  UndoHistory,
  floodFill,
  clearPart,
  validateSkinPng,
  decodeUncompressedPng,
  decodePngBytes,
  hexToRgba,
  rgbaToHex,
  colorsEqual,
  addRecentSwatch,
  getPixel,
  setPixel,
  type RgbaColor,
} from './skin-editor-state'
import { encodeRgbaToPng } from '../scene3d/skin'
import { createTestSkinData, createTestSkinPng } from '../dev-mock'

describe('Skin editor state: flood fill', () => {
  it('fills a contiguous 4-connected region of matching color', () => {
    const pixels = new Uint8ClampedArray(BUFFER_LENGTH)
    // Fill 10x10 square in center with red
    const red: RgbaColor = [255, 0, 0, 255]
    const blue: RgbaColor = [0, 0, 255, 255]
    for (let y = 10; y < 20; y++) {
      for (let x = 10; x < 20; x++) {
        setPixel(pixels, x, y, red)
      }
    }

    // Flood fill center with blue
    const changed = floodFill(pixels, 15, 15, blue)
    expect(changed).toBe(true)

    // All pixels in 10x10 should now be blue
    for (let y = 10; y < 20; y++) {
      for (let x = 10; x < 20; x++) {
        expect(getPixel(pixels, x, y)).toEqual(blue)
      }
    }

    // Surrounding pixels should remain transparent [0,0,0,0]
    expect(getPixel(pixels, 9, 9)).toEqual([0, 0, 0, 0])
    expect(getPixel(pixels, 20, 20)).toEqual([0, 0, 0, 0])
  })

  it('does not cross diagonal-only connections', () => {
    const pixels = new Uint8ClampedArray(BUFFER_LENGTH)
    const red: RgbaColor = [255, 0, 0, 255]
    const green: RgbaColor = [0, 255, 0, 255]

    // Place two red pixels diagonally
    setPixel(pixels, 5, 5, red)
    setPixel(pixels, 6, 6, red)

    floodFill(pixels, 5, 5, green)
    expect(getPixel(pixels, 5, 5)).toEqual(green)
    expect(getPixel(pixels, 6, 6)).toEqual(red) // Untouched because only 4-connected
  })

  it('returns false and performs no work when filling with the identical color', () => {
    const pixels = new Uint8ClampedArray(BUFFER_LENGTH)
    const red: RgbaColor = [255, 0, 0, 255]
    setPixel(pixels, 2, 2, red)

    const changed = floodFill(pixels, 2, 2, red)
    expect(changed).toBe(false)
  })

  it('safely handles out-of-bounds coordinates', () => {
    const pixels = new Uint8ClampedArray(BUFFER_LENGTH)
    const green: RgbaColor = [0, 255, 0, 255]
    expect(floodFill(pixels, -1, 10, green)).toBe(false)
    expect(floodFill(pixels, 64, 10, green)).toBe(false)
    expect(floodFill(pixels, 10, -5, green)).toBe(false)
    expect(floodFill(pixels, 10, 70, green)).toBe(false)
  })
})

describe('Skin editor state: undo/redo history limits', () => {
  it('supports >= 50 steps of undo/redo history and drops oldest on overflow', () => {
    const initial = new Uint8ClampedArray(BUFFER_LENGTH)
    const history = new UndoHistory(initial, 55)

    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(false)

    // Push 60 distinct steps (numbered in pixel 0)
    for (let i = 1; i <= 60; i++) {
      const step = new Uint8ClampedArray(BUFFER_LENGTH)
      step[0] = i
      history.push(step)
    }

    // Capacity is 55, so history length is capped at 55
    expect(history.historyLength()).toBe(55)
    expect(history.canUndo()).toBe(true)

    // Undo 55 times
    for (let expected = 59; expected >= 5; expected--) {
      const state = history.undo()
      expect(state).not.toBeNull()
      expect(state![0]).toBe(expected)
    }

    // Can no longer undo past capacity
    expect(history.canUndo()).toBe(false)
    expect(history.canRedo()).toBe(true)

    // Redo 55 times
    for (let expected = 6; expected <= 60; expected++) {
      const state = history.redo()
      expect(state).not.toBeNull()
      expect(state![0]).toBe(expected)
    }

    expect(history.canRedo()).toBe(false)
  })

  it('invalidates redo stack when a new edit is pushed', () => {
    const initial = new Uint8ClampedArray(BUFFER_LENGTH)
    const history = new UndoHistory(initial, 50)

    const step1 = new Uint8ClampedArray(BUFFER_LENGTH)
    step1[0] = 10
    history.push(step1)

    const step2 = new Uint8ClampedArray(BUFFER_LENGTH)
    step2[0] = 20
    history.push(step2)

    history.undo()
    expect(history.canRedo()).toBe(true)

    // Push new branch
    const step3 = new Uint8ClampedArray(BUFFER_LENGTH)
    step3[0] = 30
    history.push(step3)

    expect(history.canRedo()).toBe(false)
    expect(history.undo()![0]).toBe(10)
  })
})

describe('Skin editor state: clear part', () => {
  it('clears head region (base and overlay) while leaving other parts intact', () => {
    const testData = createTestSkinData()
    const headPixelSample = getPixel(testData, 12, 12) // Face center
    const bodyPixelSample = getPixel(testData, 20, 20) // Body
    expect(headPixelSample[3]).toBe(255)
    expect(bodyPixelSample[3]).toBe(255)

    const changed = clearPart(testData, 'head')
    expect(changed).toBe(true)

    // Head base (0..32, 0..16) and overlay (32..64, 0..16) should be empty
    expect(getPixel(testData, 12, 12)).toEqual([0, 0, 0, 0])
    expect(getPixel(testData, 42, 10)).toEqual([0, 0, 0, 0])

    // Body should be unchanged
    expect(getPixel(testData, 20, 20)).toEqual(bodyPixelSample)
  })

  it('clears body, arms, and legs independently', () => {
    const data = createTestSkinData()

    expect(clearPart(data, 'body')).toBe(true)
    // Body base rect (16..40, 16..32) should be transparent
    expect(getPixel(data, 20, 20)).toEqual([0, 0, 0, 0])

    expect(clearPart(data, 'arms')).toBe(true)
    expect(clearPart(data, 'legs')).toBe(true)
  })
})

describe('Skin editor state: import validation', () => {
  it('rejects buffers smaller than 33 bytes', () => {
    const tiny = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const res = validateSkinPng(tiny)
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/too small/i)
  })

  it('rejects files with invalid PNG signature', () => {
    const fake = new Uint8Array(50)
    fake.fill(0)
    const res = validateSkinPng(fake)
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/invalid signature/i)
  })

  it('rejects files with non-IHDR first chunk', () => {
    const corrupt = new Uint8Array(40)
    // Valid PNG signature
    corrupt.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    // Corrupt chunk type
    corrupt.set([0x00, 0x00, 0x00, 0x0d], 8)
    corrupt.set([0x58, 0x59, 0x5a, 0x57], 12) // "XYZW" instead of "IHDR"
    const res = validateSkinPng(corrupt)
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/invalid IHDR/i)
  })

  it('rejects PNGs with dimensions other than 64x64', () => {
    // Generate valid 32x32 PNG header
    const non64 = new Uint8Array(33)
    non64.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    non64.set([0x00, 0x00, 0x00, 0x0d], 8)
    non64.set([0x49, 0x48, 0x44, 0x52], 12) // "IHDR"
    // Width 32, Height 32
    non64.set([0x00, 0x00, 0x00, 0x20], 16)
    non64.set([0x00, 0x00, 0x00, 0x20], 20)

    const res = validateSkinPng(non64)
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/must be exactly 64x64/i)
    expect(res.width).toBe(32)
    expect(res.height).toBe(32)
  })

  it('accepts valid 64x64 skin PNG produced by encoder', () => {
    const png = createTestSkinPng()
    const res = validateSkinPng(png)
    expect(res.valid).toBe(true)
    expect(res.width).toBe(SKIN_SIZE)
    expect(res.height).toBe(SKIN_SIZE)
  })

  it('decodes uncompressed 64x64 PNG back to RGBA pixels losslessly', async () => {
    const original = createTestSkinData()
    const png = encodeRgbaToPng(SKIN_SIZE, SKIN_SIZE, original)
    const decoded = decodeUncompressedPng(png)

    expect(decoded.length).toBe(BUFFER_LENGTH)
    for (let i = 0; i < BUFFER_LENGTH; i++) {
      expect(decoded[i]).toBe(original[i])
    }

    const asyncDecoded = await decodePngBytes(png)
    expect(asyncDecoded.length).toBe(BUFFER_LENGTH)
    expect(asyncDecoded[0]).toBe(original[0])
  })
})

describe('Skin editor state: color utilities and palette', () => {
  it('converts hex to rgba and rgba to hex correctly', () => {
    expect(hexToRgba('#ff0000')).toEqual([255, 0, 0, 255])
    expect(hexToRgba('#00ff00', 128)).toEqual([0, 255, 0, 128])
    expect(hexToRgba('#00f')).toEqual([0, 0, 255, 255])
    expect(rgbaToHex(255, 0, 0)).toBe('#ff0000')
    expect(rgbaToHex(16, 32, 48)).toBe('#102030')
  })

  it('checks color equality accurately', () => {
    expect(colorsEqual([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true)
    expect(colorsEqual([1, 2, 3, 4], [1, 2, 3, 5])).toBe(false)
  })

  it('adds recent swatch to front, dedupes case-insensitively, and limits to 16 items', () => {
    const swatches = ['#ffffff', '#000000']
    const updated = addRecentSwatch(swatches, '#ff0000')
    expect(updated).toEqual(['#ff0000', '#ffffff', '#000000'])

    const deduped = addRecentSwatch(updated, '#FFFFFF')
    expect(deduped).toEqual(['#ffffff', '#ff0000', '#000000'])

    // Caps at 16
    let full = ['#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10', '#11', '#12', '#13', '#14', '#15', '#16']
    full = addRecentSwatch(full, '#new')
    expect(full.length).toBe(16)
    expect(full[0]).toBe('#new')
  })
})
