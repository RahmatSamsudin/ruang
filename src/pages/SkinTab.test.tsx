// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkinTab } from './SkinTab'
import { skinDraftStore } from './skin-draft'
import { skinTextureManager } from '../scene3d/skin'
import { createTestSkinPng } from '../dev-mock'
import { BUFFER_LENGTH, decodePngBytes, getPixel } from './skin-editor-state'

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

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('SkinTab component', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    skinDraftStore.clear()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return {
        putImageData: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(BUFFER_LENGTH) }),
      } as unknown as RenderingContext
    })

    mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/skins/generate')) {
        return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-123' }), { status: 200 }))
      }
      if (url.startsWith('/api/skins/')) {
        if (!init || !init.method || init.method === 'GET') {
          return Promise.resolve(new Response(new Uint8Array(createTestSkinPng()), { status: 200 }))
        }
        if (init.method === 'PUT') {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, version: 'v2' }), { status: 200 }))
        }
        if (init.method === 'DELETE') {
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        }
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
    skinDraftStore.clear()
  })

  it('renders loading state then editor once fetched', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledWith('/api/skins/developer.png')
    const editor = document.querySelector('.skin-editor')
    expect(editor).not.toBeNull()

    const promptPanel = document.querySelector('.skin-prompt-panel')
    expect(promptPanel).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('renders prompt generator panel with counter and controls', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    const textarea = document.querySelector<HTMLTextAreaElement>('.skin-prompt-textarea')
    expect(textarea).not.toBeNull()

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set
      nativeSetter?.call(textarea, 'Cyberpunk runner')
      textarea!.dispatchEvent(new Event('input', { bubbles: true }))
      textarea!.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const counter = document.querySelector('.skin-prompt-counter')
    expect(counter?.textContent).toContain('16/300')

    await act(async () => {
      root.unmount()
    })
  })

  it('saves skin via PUT /api/skins/:id and refreshes cache', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    const disposeSpy = vi.spyOn(skinTextureManager, 'disposeAgent')
    const refreshListener = vi.fn()
    window.addEventListener('ruang:skins-refresh', refreshListener)

    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    // Trigger clear head to dirty the editor
    const clearHeadBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Head' && b.getAttribute('title')?.includes('Clear Head'),
    )
    expect(clearHeadBtn).toBeDefined()
    await act(async () => {
      clearHeadBtn?.click()
    })
    await flush()

    const saveBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    )
    expect(saveBtn).toBeDefined()
    expect(saveBtn?.disabled).toBe(false)

    await act(async () => {
      saveBtn?.click()
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/skins/developer',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(disposeSpy).toHaveBeenCalledWith('developer')
    expect(refreshListener).toHaveBeenCalled()

    window.removeEventListener('ruang:skins-refresh', refreshListener)
    await act(async () => {
      root.unmount()
    })
  })

  it('resets skin via DELETE /api/skins/:id', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    const disposeSpy = vi.spyOn(skinTextureManager, 'disposeAgent')
    const refreshListener = vi.fn()
    window.addEventListener('ruang:skins-refresh', refreshListener)

    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    // Click reset
    const resetBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reset to default'),
    )
    expect(resetBtn).toBeDefined()

    await act(async () => {
      resetBtn?.click()
    })
    await flush()

    // In SkinEditor, if not dirty, reset directly calls onReset
    expect(mockFetch).toHaveBeenCalledWith('/api/skins/developer', { method: 'DELETE' })
    expect(disposeSpy).toHaveBeenCalledWith('developer')
    expect(refreshListener).toHaveBeenCalled()

    window.removeEventListener('ruang:skins-refresh', refreshListener)
    await act(async () => {
      root.unmount()
    })
  })

  it('persists draft across unmount and restores it on remount', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    // Clear Head to dirty the editor
    const clearHeadBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Head' && b.getAttribute('title')?.includes('Clear Head'),
    )
    expect(clearHeadBtn).toBeDefined()
    await act(async () => {
      clearHeadBtn?.click()
    })
    await flush()

    // Unmount while dirty
    await act(async () => {
      root.unmount()
    })

    expect(skinDraftStore.has('developer')).toBe(true)
    const draft = skinDraftStore.get('developer')
    expect(draft?.isDirty).toBe(true)

    mockFetch.mockClear()

    // Remount
    const root2 = createRoot(host)
    await act(async () => {
      root2.render(<SkinTab agentId="developer" />)
    })
    await flush()

    // When draft exists, GET /api/skins/:id.png should not be called
    expect(mockFetch).not.toHaveBeenCalledWith('/api/skins/developer.png')

    const saveBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    )
    expect(saveBtn?.disabled).toBe(false)

    await act(async () => {
      root2.unmount()
    })
  })

  it('preserves skin edits across parent re-renders and Save sends edited pixels in PUT body', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    // Clear Head to dirty the editor
    const clearHeadBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Head' && b.getAttribute('title')?.includes('Clear Head'),
    )
    expect(clearHeadBtn).toBeDefined()
    await act(async () => {
      clearHeadBtn?.click()
    })
    await flush()

    const undoBtn = host.querySelector<HTMLButtonElement>('button[title*="Undo"]')!
    expect(undoBtn.disabled).toBe(false)

    // Simulate Office polling causing parent re-render of SkinTab
    await act(async () => {
      root.render(<SkinTab agentId="developer" />)
    })
    await flush()

    // Undo should still be enabled (not wiped by re-render)
    expect(undoBtn.disabled).toBe(false)

    // Save should send PUT /api/skins/developer with the modified pixels
    const saveBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save',
    )
    expect(saveBtn?.disabled).toBe(false)

    await act(async () => {
      saveBtn?.click()
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/skins/developer',
      expect.objectContaining({ method: 'PUT' }),
    )

    // Assert on mocked fetch body contains cleared pixel at (12, 12)
    const putCall = mockFetch.mock.calls.find(
      (call) => call[0] === '/api/skins/developer' && call[1]?.method === 'PUT',
    )
    expect(putCall).toBeDefined()
    const bodyBlob = putCall![1]?.body as Blob
    expect(bodyBlob).toBeDefined()
    const arrayBuffer = await bodyBlob.arrayBuffer()
    const pngBytes = new Uint8Array(arrayBuffer)
    const decoded = await decodePngBytes(pngBytes)
    // Head center face pixel at (12, 12) was cleared to transparent [0, 0, 0, 0]
    expect(getPixel(decoded, 12, 12)).toEqual([0, 0, 0, 0])

    await act(async () => {
      root.unmount()
    })
  })
})
