// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkinLibrary, type SkinLibraryItem } from './SkinLibrary'
import { renderSkinFrontView } from './skin-editor-state'
import type { SkinEditorHandle } from './SkinEditor'
import { createTestSkinPng } from '../dev-mock'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

describe('SkinLibrary component', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it('renders skin library list with thumbnail buttons and tooltips', async () => {
    const items: SkinLibraryItem[] = [
      { id: '111111111111', name: 'Knight', prompt: 'heroic knight' },
      { id: '222222222222', name: 'Wizard', prompt: 'wise wizard' },
    ]
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(items), { status: 200 }))

    await act(async () => {
      root.render(<SkinLibrary />)
    })
    await flush()

    expect(host.textContent).toContain('Knight')
    expect(host.textContent).toContain('Wizard')

    const grid = host.querySelector('.skin-library-grid')
    expect(grid).not.toBeNull()

    const itemEls = host.querySelectorAll('.skin-library-item')
    expect(itemEls).toHaveLength(2)

    const firstThumbBtn = itemEls[0].querySelector('button.skin-library-thumbnail') as HTMLButtonElement
    expect(firstThumbBtn).not.toBeNull()
    expect(firstThumbBtn.getAttribute('title')).toBe('Knight — heroic knight')
    expect(firstThumbBtn.getAttribute('aria-label')).toBe('Load skin Knight')

    const canvas = firstThumbBtn.querySelector('canvas.skin-library-canvas')
    expect(canvas).not.toBeNull()
  })

  it('renders empty state when library is empty', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))

    await act(async () => {
      root.render(<SkinLibrary />)
    })
    await flush()

    expect(host.textContent).toContain('No skins yet. Generate or save one.')
  })

  it('shows error state and retries fetching when Retry button is clicked', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Server exploded' }), { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: '111111111111', name: 'Knight' }]),
          { status: 200 },
        ),
      )

    await act(async () => {
      root.render(<SkinLibrary />)
    })
    await flush()

    expect(host.textContent).toContain('Failed to load skin library (500)')
    const retryBtn = host.querySelector('.skin-library-retry-btn') as HTMLButtonElement
    expect(retryBtn).not.toBeNull()

    await act(async () => {
      retryBtn.click()
    })
    await flush()

    expect(host.textContent).toContain('Knight')
    expect(host.querySelector('.skin-library-error')).toBeNull()
  })

  it('loads skin into editor as unsaved (dirty) and does NOT PUT when clicked', async () => {
    const items: SkinLibraryItem[] = [{ id: '111111111111', name: 'Knight' }]
    const dummyPng = new Uint8Array(createTestSkinPng())

    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/skin-library') {
        return new Response(JSON.stringify(items), { status: 200 })
      }
      if (url === '/api/skin-library/111111111111.png') {
        return new Response(dummyPng, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })

    const mockEditor: SkinEditorHandle = {
      loadPixels: vi.fn(),
      getPixels: vi.fn().mockReturnValue(new Uint8ClampedArray(64 * 64 * 4)),
      getPng: vi.fn().mockReturnValue(dummyPng),
      isDirty: vi.fn().mockReturnValue(false),
    }

    const editorRef = { current: mockEditor }
    const onSelect = vi.fn()

    await act(async () => {
      root.render(<SkinLibrary editorRef={editorRef} onSelect={onSelect} />)
    })
    await flush()

    const thumbBtn = host.querySelector('button.skin-library-thumbnail') as HTMLButtonElement
    expect(thumbBtn).not.toBeNull()

    await act(async () => {
      thumbBtn.click()
    })
    await flush()

    expect(mockEditor.loadPixels).toHaveBeenCalledWith(
      expect.any(Uint8ClampedArray),
      { undoable: true },
    )
    expect(onSelect).toHaveBeenCalledWith(items[0], expect.any(Uint8Array))

    // Verify NO PUT requests were made
    const putCalls = mockFetch.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
    )
    expect(putCalls).toHaveLength(0)
  })

  it('supports renaming with PATCH on Enter and cancels on Escape', async () => {
    const items: SkinLibraryItem[] = [{ id: '111111111111', name: 'Knight' }]
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/skin-library') {
        return new Response(JSON.stringify(items), { status: 200 })
      }
      if (url === '/api/skin-library/111111111111' && init?.method === 'PATCH') {
        const body = JSON.parse(init.body as string)
        return new Response(
          JSON.stringify({ id: '111111111111', name: body.name }),
          { status: 200 },
        )
      }
      return new Response('Not found', { status: 404 })
    })

    await act(async () => {
      root.render(<SkinLibrary />)
    })
    await flush()

    const renameBtn = host.querySelector('.skin-library-action-btn') as HTMLButtonElement
    expect(renameBtn.textContent).toBe('Rename')

    // 1. Start renaming, then cancel with Escape
    await act(async () => {
      renameBtn.click()
    })
    await flush()

    let input = host.querySelector('.skin-library-rename-input') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe('Knight')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()

    expect(host.querySelector('.skin-library-rename-input')).toBeNull()
    expect(host.textContent).toContain('Knight')
    expect(mockFetch).not.toHaveBeenCalledWith(
      '/api/skin-library/111111111111',
      expect.objectContaining({ method: 'PATCH' }),
    )

    // 2. Start renaming, edit value, then save with Enter
    const renameBtnAgain = host.querySelector('.skin-library-action-btn') as HTMLButtonElement
    await act(async () => {
      renameBtnAgain.click()
    })
    await flush()

    input = host.querySelector('.skin-library-rename-input') as HTMLInputElement
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      nativeSetter?.call(input, 'Paladin')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/skin-library/111111111111',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Paladin' }),
      }),
    )

    expect(host.querySelector('.skin-library-rename-input')).toBeNull()
    expect(host.textContent).toContain('Paladin')
  })

  it('deletes with confirm sends DELETE; cancelling confirm sends nothing', async () => {
    const items: SkinLibraryItem[] = [{ id: '111111111111', name: 'Knight' }]
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/skin-library') {
        return new Response(JSON.stringify(items), { status: 200 })
      }
      if (url === '/api/skin-library/111111111111' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      return new Response('Not found', { status: 404 })
    })

    const confirmSpy = vi.spyOn(window, 'confirm')

    await act(async () => {
      root.render(<SkinLibrary />)
    })
    await flush()

    const deleteBtn = host.querySelector('.skin-library-action-btn.danger') as HTMLButtonElement
    expect(deleteBtn.textContent).toBe('Delete')

    // 1. Cancel delete confirmation
    confirmSpy.mockReturnValueOnce(false)
    await act(async () => {
      deleteBtn.click()
    })
    await flush()

    expect(confirmSpy).toHaveBeenCalledWith('Delete skin "Knight"?')
    expect(mockFetch).not.toHaveBeenCalledWith(
      '/api/skin-library/111111111111',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(host.textContent).toContain('Knight')

    // 2. Confirm delete
    confirmSpy.mockReturnValueOnce(true)
    await act(async () => {
      deleteBtn.click()
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/skin-library/111111111111',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(host.textContent).not.toContain('Knight')
    expect(host.textContent).toContain('No skins yet. Generate or save one.')
  })

  it('shows profile-locked message when response is 423', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: '🔒 Profile locked: unlock with PIN' }), {
        status: 423,
      }),
    )

    await act(async () => {
      root.render(<SkinLibrary />)
    })
    await flush()

    expect(host.textContent).toContain('🔒 Profile locked: unlock with PIN')
  })

  it('refetches when refreshTrigger changes', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))

    await act(async () => {
      root.render(<SkinLibrary refreshTrigger={0} />)
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledTimes(1)

    await act(async () => {
      root.render(<SkinLibrary refreshTrigger={1} />)
    })
    await flush()

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('highlights the activeSkinId if provided', async () => {
    const items: SkinLibraryItem[] = [
      { id: '111111111111', name: 'Knight' },
      { id: '222222222222', name: 'Wizard' },
    ]
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(items), { status: 200 }))

    await act(async () => {
      root.render(<SkinLibrary activeSkinId="111111111111" />)
    })
    await flush()

    const item1 = host.querySelector('[data-id="111111111111"]')
    const item2 = host.querySelector('[data-id="222222222222"]')

    expect(item1?.classList.contains('active')).toBe(true)
    expect(item2?.classList.contains('active')).toBe(false)
  })

  it('renderSkinFrontView draws skin composite using nearest-neighbour scaling', () => {
    const mockCtx = {
      imageSmoothingEnabled: true,
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D

    const mockSource = {} as CanvasImageSource

    renderSkinFrontView(mockCtx, mockSource, 32, 64)

    expect(mockCtx.imageSmoothingEnabled).toBe(false)
    expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 32, 64)
    // Verify base + overlay composite draw calls
    expect(mockCtx.drawImage).toHaveBeenCalled()
    // Should draw head, hat, body, jacket, right arm, right sleeve, left arm, left sleeve, right leg, right pant, left leg, left pant
    expect((mockCtx.drawImage as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(6)
  })
})
