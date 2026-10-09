// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkinPromptPanel } from './SkinPromptPanel'
import type { SkinEditorHandle } from './SkinEditor'
import { bytesToBase64 } from './skin-editor-state'
import { createTestSkinPng } from '../dev-mock'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

describe('SkinPromptPanel component and polling flow', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let mockEditorHandle: SkinEditorHandle
  const dummyBase64 = bytesToBase64(new Uint8Array(createTestSkinPng()))

  beforeEach(() => {
    vi.useFakeTimers()
    mockEditorHandle = {
      loadPixels: vi.fn(),
      getPixels: vi.fn().mockReturnValue(new Uint8ClampedArray(64 * 64 * 4)),
      getPng: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
      isDirty: vi.fn().mockReturnValue(false),
    }
    mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  const setupPanel = async (initialPrompt = 'Test skin') => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const editorRef = { current: mockEditorHandle }

    await act(async () => {
      root.render(
        <SkinPromptPanel
          editorRef={editorRef}
          initialPrompt={initialPrompt}
          initialPart="all"
        />,
      )
    })

    return { host, root }
  }

  const triggerGenerate = async () => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Generate',
    )
    expect(btn).toBeDefined()
    await act(async () => {
      btn?.click()
    })
  }

  it('handles successful generation and polling (done status)', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-1' }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'done', png: dummyBase64 }), { status: 200 }),
      )

    const { root } = await setupPanel()
    await triggerGenerate()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/skins/generate',
      expect.objectContaining({ method: 'POST' }),
    )

    // Advance 2s for poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/skins/generate/job-1')
    expect(mockEditorHandle.loadPixels).toHaveBeenCalledWith(
      expect.any(Uint8ClampedArray),
      { undoable: true },
    )

    await act(async () => {
      root.unmount()
    })
  })

  it('handles error status with timeout', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-2' }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'error', error: 'timeout' }), { status: 200 }),
      )

    const { root } = await setupPanel()
    await triggerGenerate()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Generator timed out')

    await act(async () => {
      root.unmount()
    })
  })

  it('handles other error status', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-3' }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'error', error: 'unusable output' }), { status: 200 }),
      )

    const { root } = await setupPanel()
    await triggerGenerate()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Generator returned unusable output, try again/rephrase')

    await act(async () => {
      root.unmount()
    })
  })

  it('cancels polling when Cancel button is clicked', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-4' }), { status: 202 }))
      .mockResolvedValue(new Response(JSON.stringify({ status: 'running' }), { status: 200 }))

    const { root } = await setupPanel()
    await triggerGenerate()

    const cancelBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    )
    expect(cancelBtn).toBeDefined()

    await act(async () => {
      cancelBtn?.click()
    })

    const fetchCount = mockFetch.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    // No further polling calls should occur after cancellation
    expect(mockFetch.mock.calls.length).toBe(fetchCount)

    await act(async () => {
      root.unmount()
    })
  })

  it('cleans up polling intervals on unmount', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-5' }), { status: 202 }))
      .mockResolvedValue(new Response(JSON.stringify({ status: 'running' }), { status: 200 }))

    const { root } = await setupPanel()
    await triggerGenerate()

    await act(async () => {
      root.unmount()
    })

    const fetchCount = mockFetch.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000)
    })

    expect(mockFetch.mock.calls.length).toBe(fetchCount)
  })

  it('handles 409 busy response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'busy' }), { status: 409 }),
    )

    const { root } = await setupPanel()
    await triggerGenerate()

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Another skin is generating, try again shortly')

    await act(async () => {
      root.unmount()
    })
  })

  it('handles 429 busy rate limit response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'busy' }), { status: 429 }),
    )

    const { root } = await setupPanel()
    await triggerGenerate()

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Too many generate requests, wait a minute')

    await act(async () => {
      root.unmount()
    })
  })

  it('handles 429 daily cap limit response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'daily cap' }), { status: 429 }),
    )

    const { root } = await setupPanel()
    await triggerGenerate()

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Daily generation limit reached')

    await act(async () => {
      root.unmount()
    })
  })

  it('handles 503 service unavailable response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'flow offline' }), { status: 503 }),
    )

    const { root } = await setupPanel()
    await triggerGenerate()

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Image generator offline')

    await act(async () => {
      root.unmount()
    })
  })

  it('handles 404 response on polling (generation expired)', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: 'job-6' }), { status: 202 }))
      .mockResolvedValueOnce(new Response('Not found', { status: 404 }))

    const { root } = await setupPanel()
    await triggerGenerate()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    const error = document.querySelector('.skin-generate-error')
    expect(error?.textContent).toContain('Generation expired')

    await act(async () => {
      root.unmount()
    })
  })
})
