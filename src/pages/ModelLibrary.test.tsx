// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelRecord } from '../scene3d/models.ts'
import type { SceneItem } from '../scene3d/scene.ts'
import { ModelLibrary } from './ModelLibrary.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const sampleModels: ModelRecord[] = [
  { id: 'm-111111111111', name: 'Meeting Chair', format: 'glb', size: 10240, createdAt: '2026-10-14T10:00:00.000Z' },
  { id: 'm-222222222222', name: 'Wooden Desk', format: 'gltf', size: 204800, createdAt: '2026-10-14T11:00:00.000Z' },
]

describe('ModelLibrary', () => {
  it('renders model list, count indicator, and metadata', async () => {
    const onClose = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={onClose} initialModels={sampleModels} />)
    })

    expect(host.textContent).toContain('Model Library')
    expect(host.textContent).toContain('2 / 100 models')
    expect(host.textContent).toContain('Meeting Chair')
    expect(host.textContent).toContain('Wooden Desk')
    expect(host.textContent).toContain('GLB')
    expect(host.textContent).toContain('GLTF')

    const downloadLinks = host.querySelectorAll('a.download-btn')
    expect(downloadLinks.length).toBe(2)
    expect(downloadLinks[0].getAttribute('href')).toBe('/api/models/m-111111111111/file')
    expect(downloadLinks[0].getAttribute('download')).toBe('Meeting Chair')
    expect(downloadLinks[0].textContent?.trim()).toBe('Export')
    expect(downloadLinks[0].classList.contains('export-btn')).toBe(true)
  })

  it('filters models by search query', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} />)
    })

    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'desk')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(host.textContent).toContain('Wooden Desk')
    expect(host.textContent).not.toContain('Meeting Chair')
  })

  it('handles delete flow with confirmation', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => ({}),
    } as Response)

    const onModelsChange = vi.fn()
    const onModelDeleted = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} onModelsChange={onModelsChange} onModelDeleted={onModelDeleted} />)
    })

    const deleteBtn = host.querySelector('.delete-btn') as HTMLButtonElement
    expect(deleteBtn).toBeDefined()
    await act(async () => {
      deleteBtn.click()
    })

    // Now confirmation buttons should appear
    const confirmBtn = host.querySelector('.confirm-delete') as HTMLButtonElement
    expect(confirmBtn).toBeDefined()
    await act(async () => {
      confirmBtn.click()
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/models/m-111111111111', { method: 'DELETE' })
    expect(onModelsChange).toHaveBeenCalledWith([sampleModels[1]])
    expect(onModelDeleted).toHaveBeenCalledWith('m-111111111111')
  })

  it('displays error when delete conflicts (409 in use)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Model is currently in use', usedBy: ['added-1', 'added-2'] }),
    } as Response)

    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} />)
    })

    const deleteBtn = host.querySelector('.delete-btn') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
    })

    const confirmBtn = host.querySelector('.confirm-delete') as HTMLButtonElement
    await act(async () => {
      confirmBtn.click()
    })

    expect(host.textContent).toContain('Cannot delete: Model is currently in use (used by: added-1, added-2)')
  })

  it('uploads a model via file input', async () => {
    const newModel: ModelRecord = {
      id: 'm-333333333333',
      name: 'lamp.glb',
      format: 'glb',
      size: 512,
      createdAt: '2026-10-14T12:00:00.000Z',
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ model: newModel }),
    } as Response)

    const onModelsChange = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} onModelsChange={onModelsChange} />)
    })

    const fileInput = host.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['binary'], 'lamp.glb', { type: 'model/gltf-binary' })
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onModelsChange).toHaveBeenCalledWith([newModel, ...sampleModels])
    expect(host.textContent).toContain('lamp.glb')
  })

  it('blocks delete client-side when model is used by an unsaved live placed item', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const items: SceneItem[] = [
      {
        id: 'live-item-1',
        kind: 'model',
        modelId: 'm-111111111111',
        x: 0,
        z: 0,
      } as unknown as SceneItem,
    ]

    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} items={items} />)
    })

    const deleteBtn = host.querySelector('.delete-btn') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
    })

    // Fetch should not be called, confirm prompt should not appear
    expect(fetchMock).not.toHaveBeenCalled()
    expect(host.querySelector('.confirm-delete')).toBeNull()
    expect(host.textContent).toContain('Used by 1 item(s) in the scene. Remove them first.')
  })

  it('cancels delete confirmation when Cancel button is clicked', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} />)
    })

    const deleteBtn = host.querySelector('.delete-btn') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
    })

    const cancelBtn = host.querySelector('.cancel-delete') as HTMLButtonElement
    expect(cancelBtn).not.toBeNull()
    await act(async () => {
      cancelBtn.click()
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(host.querySelector('.confirm-delete')).toBeNull()
    expect(host.querySelector('.delete-btn')).not.toBeNull()
  })

  it('treats 404 response on DELETE as already gone and removes row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    } as Response)

    const onModelsChange = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} initialModels={sampleModels} onModelsChange={onModelsChange} />)
    })

    const deleteBtn = host.querySelector('.delete-btn') as HTMLButtonElement
    await act(async () => {
      deleteBtn.click()
    })

    const confirmBtn = host.querySelector('.confirm-delete') as HTMLButtonElement
    await act(async () => {
      confirmBtn.click()
    })

    expect(onModelsChange).toHaveBeenCalledWith([sampleModels[1]])
  })

  it('displays fetch error and retries when initialModels is not provided', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ models: sampleModels }),
      } as Response)

    const host = document.body.appendChild(document.createElement('div'))
    await act(async () => {
      createRoot(host).render(<ModelLibrary onClose={vi.fn()} />)
    })

    expect(host.textContent).toContain('Failed to load models: Network error')
    const retryBtn = host.querySelector('.model-library-retry') as HTMLButtonElement
    expect(retryBtn).not.toBeNull()

    await act(async () => {
      retryBtn.click()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Meeting Chair')
  })
})
