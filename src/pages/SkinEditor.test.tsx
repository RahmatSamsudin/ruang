// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { SkinEditor, type SkinEditorHandle } from './SkinEditor'
import { createTestSkinPng, createTestSkinData } from '../dev-mock'
import { BUFFER_LENGTH, validateSkinPng, getPixel } from './skin-editor-state'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

class MockImageData {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight?: number, maybeHeight?: number) {
    if (dataOrWidth instanceof Uint8ClampedArray) {
      this.data = dataOrWidth
      this.width = widthOrHeight!
      this.height = maybeHeight ?? widthOrHeight!
    } else {
      this.width = dataOrWidth
      this.height = widthOrHeight!
      this.data = new Uint8ClampedArray(this.width * this.height * 4)
    }
  }
}

if (typeof globalThis.ImageData === 'undefined') {
  // @ts-expect-error mock ImageData in jsdom
  globalThis.ImageData = MockImageData
}

beforeEach(() => {
  // Mock canvas 2D context for jsdom environment
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      putImageData: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(BUFFER_LENGTH) }),
    } as unknown as RenderingContext
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('SkinEditor parent re-render', () => {
  it('keeps edited pixels when the parent re-renders with a new onDirtyChange', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()
    const render = () =>
      root.render(<SkinEditor ref={ref} id="dev" initialPng={null} onSave={() => {}} onReset={() => {}} onDirtyChange={() => {}} />)

    await act(async () => { render() })
    const edited = new Uint8ClampedArray(BUFFER_LENGTH).fill(7)
    await act(async () => { ref.current?.loadPixels(edited, { undoable: true }) })

    await act(async () => { render() })
    await act(async () => { await Promise.resolve() })

    expect(Array.from(ref.current!.getPixels())).toEqual(Array.from(edited))
  })
})

describe('SkinEditor component interactive tests', () => {
  it('renders correctly with null initialPng and default controls', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <SkinEditor
          id="dev"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
        />,
      )
    })

    expect(host.textContent).toContain('AGENT SKIN')
    expect(host.textContent).toContain('dev')
    expect(host.querySelector('.badge.amber')).toBeNull() // Not unsaved initially

    const importBtn = host.querySelector('button[title*="Import"]')
    const exportBtn = host.querySelector('button[title*="Export"]')
    const resetBtn = host.querySelector('button[title*="Reset"]')
    const saveBtn = host.querySelector('button[title*="Save"]')

    expect(importBtn).not.toBeNull()
    expect(exportBtn).not.toBeNull()
    expect(resetBtn).not.toBeNull()
    expect(saveBtn).not.toBeNull()
  })

  it('exposes imperative handle methods and updates dirty state when loadPixels is called', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()
    const onDirtyChange = vi.fn()
    const onSave = vi.fn()

    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="coder"
          initialPng={null}
          onSave={onSave}
          onReset={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      )
    })

    expect(ref.current).not.toBeNull()
    expect(ref.current?.isDirty()).toBe(false)

    // Load new pixels into the editor
    const newPixels = createTestSkinData()
    // Modify one pixel so it differs from default skin
    newPixels[0] = 123
    newPixels[1] = 234

    await act(async () => {
      ref.current?.loadPixels(newPixels, { undoable: true })
    })

    expect(ref.current?.isDirty()).toBe(true)
    expect(onDirtyChange).toHaveBeenCalledWith(true)
    expect(host.querySelector('.badge.amber')?.textContent).toBe('Unsaved')

    // Test getPixels returns the loaded pixels
    const currentPixels = ref.current?.getPixels()
    expect(currentPixels?.[0]).toBe(123)
    expect(currentPixels?.[1]).toBe(234)

    // Test getPng returns valid 64x64 PNG
    const png = ref.current?.getPng()
    expect(png).toBeDefined()
    const validation = validateSkinPng(png!)
    expect(validation.valid).toBe(true)
    expect(validation.width).toBe(64)
    expect(validation.height).toBe(64)

    // Click Save button
    const saveBtn = host.querySelector<HTMLButtonElement>('.primary-button')!
    await act(async () => {
      saveBtn.click()
    })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(ref.current?.isDirty()).toBe(false)
    expect(host.querySelector('.badge.amber')).toBeNull()
  })

  it('handles reset to default skin and notifies onReset', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()
    const onReset = vi.fn()
    const initialPng = createTestSkinPng()

    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="designer"
          initialPng={initialPng}
          onSave={() => {}}
          onReset={onReset}
        />,
      )
    })

    const resetBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset to default'),
    )
    expect(resetBtn).toBeDefined()

    await act(async () => {
      resetBtn?.click()
    })

    expect(onReset).toHaveBeenCalledTimes(1)
    expect(ref.current?.isDirty()).toBe(false)
  })

  it('clears specific part regions when clear buttons are clicked', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()

    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="researcher"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
        />,
      )
    })

    // Click Clear Head button
    const clearHeadBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Head' && b.getAttribute('title')?.includes('Clear Head'),
    )
    expect(clearHeadBtn).toBeDefined()

    await act(async () => {
      clearHeadBtn?.click()
    })

    expect(ref.current?.isDirty()).toBe(true)
    const pixels = ref.current!.getPixels()
    // Face center pixel should now be transparent [0, 0, 0, 0]
    expect(getPixel(pixels, 12, 12)).toEqual([0, 0, 0, 0])

    // Undo should restore it
    const undoBtn = host.querySelector<HTMLButtonElement>('button[title*="Undo"]')!
    expect(undoBtn.disabled).toBe(false)

    await act(async () => {
      undoBtn.click()
    })

    const restoredPixels = ref.current!.getPixels()
    expect(getPixel(restoredPixels, 12, 12)[3]).toBeGreaterThan(0)
  })

  it('renders children slot at bottom for AI prompt integration', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <SkinEditor
          id="test-agent"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
        >
          <div id="c5-custom-slot">Prompt Bar Here</div>
        </SkinEditor>,
      )
    })

    const slot = host.querySelector('#c5-custom-slot')
    expect(slot).not.toBeNull()
    expect(slot?.textContent).toBe('Prompt Bar Here')
  })

  it('switches tools via keyboard shortcuts', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <SkinEditor
          id="test-agent"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
        />,
      )
    })

    // Initial tool is pencil
    expect(host.querySelector('.skin-tool-button.active')?.textContent).toContain('Pencil')

    // Press 'e' for eraser
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    })
    expect(host.querySelector('.skin-tool-button.active')?.textContent).toContain('Eraser')

    // Press 'b' for bucket
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }))
    })
    expect(host.querySelector('.skin-tool-button.active')?.textContent).toContain('Fill')

    // Press 'i' for eyedropper
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }))
    })
    expect(host.querySelector('.skin-tool-button.active')?.textContent).toContain('Pick')

    // Press 'p' for pencil
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }))
    })
    expect(host.querySelector('.skin-tool-button.active')?.textContent).toContain('Pencil')
  })

  it('displays import error alert when invalid PNG is selected', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <SkinEditor
          id="test-agent"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
        />,
      )
    })

    const fileInput = host.querySelector<HTMLInputElement>('[data-testid="skin-file-input"]')!
    expect(fileInput).not.toBeNull()

    // Create a mock invalid file
    const invalidFile = new File(['not-a-png-content'], 'test.png', { type: 'image/png' })

    await act(async () => {
      // Simulate file selection
      Object.defineProperty(fileInput, 'files', {
        value: [invalidFile],
        writable: true,
      })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const errorAlert = host.querySelector('.skin-import-error')
    expect(errorAlert).not.toBeNull()
    expect(errorAlert?.textContent).toMatch(/PNG|valid/i)
  })

  it('bundles an entire continuous drawing stroke into a single undo step', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()

    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="test-agent"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
        />,
      )
    })

    const canvas = host.querySelector<HTMLCanvasElement>('canvas')!
    expect(canvas).not.toBeNull()

    // Mock getBoundingClientRect
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 512,
      height: 512,
      right: 512,
      bottom: 512,
      x: 0,
      y: 0,
      toJSON: () => {},
    })

    // Capture initial pixel before drawing
    const initialPixel = getPixel(ref.current!.getPixels(), 5, 5)

    // Simulate multi-point pencil stroke: pointerDown -> move -> move -> pointerUp
    await act(async () => {
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 40, // x = 5 (40 / 512 * 64 = 5)
          clientY: 40, // y = 5
          pointerId: 1,
          bubbles: true,
        }),
      )
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 48, // x = 6
          clientY: 48, // y = 6
          pointerId: 1,
          bubbles: true,
        }),
      )
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 56, // x = 7
          clientY: 56, // y = 7
          pointerId: 1,
          bubbles: true,
        }),
      )
      canvas.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 56,
          clientY: 56,
          pointerId: 1,
          bubbles: true,
        }),
      )
    })

    // The stroke modified pixels (5,5), (6,6), (7,7)
    const pixelsAfterStroke = ref.current!.getPixels()
    const p5 = getPixel(pixelsAfterStroke, 5, 5)
    const p6 = getPixel(pixelsAfterStroke, 6, 6)
    const p7 = getPixel(pixelsAfterStroke, 7, 7)
    // Default color is black (#000000)
    expect(p5).toEqual([0, 0, 0, 255])
    expect(p6).toEqual([0, 0, 0, 255])
    expect(p7).toEqual([0, 0, 0, 255])

    // Exactly one single Undo click should undo the ENTIRE 3-point stroke back to initial
    const undoBtn = host.querySelector<HTMLButtonElement>('button[title*="Undo"]')!
    await act(async () => {
      undoBtn.click()
    })

    const pixelsAfterUndo = ref.current!.getPixels()
    expect(getPixel(pixelsAfterUndo, 5, 5)).toEqual(initialPixel)
    expect(ref.current!.isDirty()).toBe(false)
  })

  it('preserves painted pixels and canUndo across parent re-renders with new onDirtyChange identity (paint path)', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()

    let onDirtyChange = vi.fn()

    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="coder"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      )
    })

    const canvas = host.querySelector<HTMLCanvasElement>('canvas')!
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 512,
      height: 512,
      right: 512,
      bottom: 512,
      x: 0,
      y: 0,
      toJSON: () => {},
    })

    // Paint a pixel at (5, 5)
    await act(async () => {
      canvas.dispatchEvent(
        new PointerEvent('pointerdown', {
          clientX: 40,
          clientY: 40,
          pointerId: 1,
          bubbles: true,
        }),
      )
      canvas.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 40,
          clientY: 40,
          pointerId: 1,
          bubbles: true,
        }),
      )
    })

    expect(ref.current?.isDirty()).toBe(true)
    const paintedPixel = getPixel(ref.current!.getPixels(), 5, 5)
    expect(paintedPixel).toEqual([0, 0, 0, 255])
    const undoBtn = host.querySelector<HTMLButtonElement>('button[title*="Undo"]')!
    expect(undoBtn.disabled).toBe(false)

    // Simulate parent re-render with a NEW onDirtyChange callback reference
    onDirtyChange = vi.fn()
    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="coder"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      )
    })

    // Assert: pixels remain unchanged, canUndo is still true, isDirty is still true
    expect(getPixel(ref.current!.getPixels(), 5, 5)).toEqual([0, 0, 0, 255])
    expect(ref.current?.isDirty()).toBe(true)
    expect(undoBtn.disabled).toBe(false)

    // Changing agent id MUST still reload the editor
    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="designer"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      )
    })
    expect(undoBtn.disabled).toBe(true)
    expect(ref.current?.isDirty()).toBe(false)
  })

  it('preserves loadPixels across parent re-renders with new onDirtyChange identity (generator path)', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const ref = createRef<SkinEditorHandle>()

    let onDirtyChange = vi.fn()

    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="coder"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      )
    })

    // Simulate AI generator calling loadPixels with undoable: true
    const newPixels = createTestSkinData()
    newPixels[0] = 123
    newPixels[1] = 234
    newPixels[2] = 210
    newPixels[3] = 255

    await act(async () => {
      ref.current?.loadPixels(newPixels, { undoable: true })
    })

    expect(ref.current?.isDirty()).toBe(true)
    expect(ref.current?.getPixels()[0]).toBe(123)
    const undoBtn = host.querySelector<HTMLButtonElement>('button[title*="Undo"]')!
    expect(undoBtn.disabled).toBe(false)

    // Simulate parent re-render with a NEW onDirtyChange callback reference
    onDirtyChange = vi.fn()
    await act(async () => {
      root.render(
        <SkinEditor
          ref={ref}
          id="coder"
          initialPng={null}
          onSave={() => {}}
          onReset={() => {}}
          onDirtyChange={onDirtyChange}
        />,
      )
    })

    // Assert: pixels remain unchanged, canUndo is still true, isDirty is still true
    expect(ref.current?.getPixels()[0]).toBe(123)
    expect(ref.current?.getPixels()[1]).toBe(234)
    expect(ref.current?.isDirty()).toBe(true)
    expect(undoBtn.disabled).toBe(false)
  })
})
