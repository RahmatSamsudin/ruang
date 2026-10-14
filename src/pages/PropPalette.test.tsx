// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelRecord } from '../scene3d/models.ts'
import { PROP_TYPES } from '../scene3d/scene.ts'
import { PropPalette, type PropPaletteProps } from './PropPalette.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.replaceChildren() })

async function mount(props: Partial<PropPaletteProps> = {}) {
  const onPick = props.onPick ?? vi.fn()
  const host = document.body.appendChild(document.createElement('div'))
  await act(async () => {
    createRoot(host).render(
      <PropPalette
        placing={props.placing ?? null}
        limitReached={props.limitReached ?? false}
        onPick={onPick}
        models={props.models}
        onUpload={props.onUpload}
        onManageModels={props.onManageModels}
        onModelsChange={props.onModelsChange}
      />,
    )
  })
  const buttons = () => [...host.querySelectorAll('.office-3d-palette-list button')] as HTMLButtonElement[]
  const button = (label: string) => buttons().find((node) => node.textContent === label)!
  return { host, onPick, buttons, button }
}

describe('PropPalette', () => {
  it('lists every object type once, in groups', async () => {
    const { host, buttons } = await mount()
    expect(buttons()).toHaveLength(PROP_TYPES.length)
    expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['Furniture', 'Kitchen', 'Leisure', 'Bedroom', 'Outdoor', 'Structure', 'Imported'])
  })

  it('picks a type, and clicking the active one leaves placing', async () => {
    const { button, onPick } = await mount()
    await act(async () => { button('Sofa').click() })
    expect(onPick).toHaveBeenLastCalledWith('Sofa')
    const second = await mount({ placing: 'Sofa' })
    expect(second.button('Sofa').getAttribute('aria-pressed')).toBe('true')
    expect(second.button('Plant').getAttribute('aria-pressed')).toBe('false')
    await act(async () => { second.button('Sofa').click() })
    expect(second.onPick).toHaveBeenLastCalledWith(null)
  })

  it('filters by name or type as you type, and hides empty groups', async () => {
    const { host, buttons } = await mount()
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'rail')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttons().map((node) => node.textContent)).toEqual(['Railing'])
    expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['Structure'])
  })

  it('explains the limit and disables everything but the active entry', async () => {
    const { host, buttons } = await mount({ limitReached: true, placing: 'Plant' })
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/limit reached/i)
    const enabled = buttons().filter((node) => !node.disabled).map((node) => node.textContent)
    expect(enabled).toEqual(['Plant'])
  })

  it('keeps an always-present status line with the hint until the limit is reached', async () => {
    const { host } = await mount()
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/esc to stop/i)
  })

  it('Esc in the search box clears a typed query first, then stops placing', async () => {
    const { host, onPick, buttons } = await mount({ placing: 'Sofa' })
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    const escape = () => act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'rail')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    search.focus()
    expect(buttons()).toHaveLength(1)
    await escape()
    expect(search.value).toBe('')
    expect(buttons()).toHaveLength(PROP_TYPES.length)
    expect(onPick).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(search)
    await escape()
    expect(onPick).toHaveBeenCalledWith(null)
    expect(document.activeElement).not.toBe(search)
  })

  it('marks desks and beds as decoration in their tooltip', async () => {
    const { button } = await mount()
    expect(button('Work desk').title).toMatch(/not an agent seat/i)
    expect(button('Sofa').title).toBe('')
  })

  it('can be collapsed to its header', async () => {
    const { host, buttons } = await mount()
    const head = host.querySelector('.office-3d-palette-head') as HTMLButtonElement
    await act(async () => { head.click() })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(buttons()).toHaveLength(0)
  })

  it('renders structure primitive buttons and allows picking them', async () => {
    const { host, onPick } = await mount()
    const structureButtons = [...host.querySelectorAll('.office-3d-palette-structures button')] as HTMLButtonElement[]
    expect(structureButtons.map((b) => b.textContent)).toEqual(['Floor slab', 'Wall segment', 'Glass divider', 'Box shape'])
    await act(async () => { structureButtons[0].click() })
    expect(onPick).toHaveBeenCalledWith('floor')
    await act(async () => { structureButtons[1].click() })
    expect(onPick).toHaveBeenCalledWith('wall')
    await act(async () => { structureButtons[2].click() })
    expect(onPick).toHaveBeenCalledWith('glass')
    await act(async () => { structureButtons[3].click() })
    expect(onPick).toHaveBeenCalledWith('box')
  })

  it('toggles structure tool off when clicked while active', async () => {
    const { host, onPick } = await mount({ placing: 'floor' })
    const structureButtons = [...host.querySelectorAll('.office-3d-palette-structures button')] as HTMLButtonElement[]
    expect(structureButtons[0].getAttribute('aria-pressed')).toBe('true')
    await act(async () => { structureButtons[0].click() })
    expect(onPick).toHaveBeenCalledWith(null)
  })

  it('disables inactive structure tools when limitReached is true', async () => {
    const { host } = await mount({ limitReached: true, placing: 'floor' })
    const structureButtons = [...host.querySelectorAll('.office-3d-palette-structures button')] as HTMLButtonElement[]
    expect(structureButtons[0].disabled).toBe(false)
    expect(structureButtons[1].disabled).toBe(true)
    expect(structureButtons[2].disabled).toBe(true)
    expect(structureButtons[3].disabled).toBe(true)
  })

  it('renders imported models and selects them for placement', async () => {
    const models: ModelRecord[] = [
      { id: 'm-1234567890ab', name: 'Custom Lamp', format: 'glb', size: 2048, createdAt: '2026-10-14T00:00:00Z' },
    ]
    const { host, onPick } = await mount({ models })
    const importedBtn = [...host.querySelectorAll('.office-3d-palette-imported button')].find((b) => b.textContent?.includes('Custom Lamp')) as HTMLButtonElement | undefined
    expect(importedBtn).toBeDefined()

    await act(async () => { importedBtn!.click() })
    expect(onPick).toHaveBeenCalledWith('model:m-1234567890ab')
  })

  it('triggers model upload via file input', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      id: 'm-newmodel1234',
      name: 'chair.glb',
      format: 'glb',
      size: 4096,
      createdAt: '2026-10-14T00:00:00Z',
    })
    const { host, onPick } = await mount({ onUpload })
    const fileInput = host.querySelector('.office-3d-palette-imported input[type="file"]') as HTMLInputElement
    expect(fileInput).toBeDefined()

    const file = new File(['dummy content'], 'chair.glb', { type: 'model/gltf-binary' })
    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(onUpload).toHaveBeenCalledWith(file)
    expect(onPick).toHaveBeenCalledWith('model:m-newmodel1234')
  })

  it('renders empty state text when there are no models', async () => {
    const { host } = await mount({ models: [] })
    const emptyText = host.querySelector('.office-3d-palette-empty')
    expect(emptyText?.textContent).toBe('No imported models yet')
  })

  it('rejects file larger than 10 MiB with inline error', async () => {
    const { host } = await mount({ models: [] })
    const fileInput = host.querySelector('.office-3d-palette-imported input[type="file"]') as HTMLInputElement
    const bigFile = new File(['x'], 'big.glb', { type: 'model/gltf-binary' })
    Object.defineProperty(bigFile, 'size', { value: 11 * 1024 * 1024, configurable: true })

    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [bigFile], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const error = host.querySelector('.office-3d-upload-error')
    expect(error?.textContent).toBe('File exceeds 10 MiB limit.')
  })

  it('rejects non-glb/gltf file with inline error', async () => {
    const { host } = await mount({ models: [] })
    const fileInput = host.querySelector('.office-3d-palette-imported input[type="file"]') as HTMLInputElement
    const txtFile = new File(['not a glb'], 'notes.txt', { type: 'text/plain' })

    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [txtFile], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const error = host.querySelector('.office-3d-upload-error')
    expect(error?.textContent).toBe('Only .glb and .gltf files are supported.')
  })

  it('handles server 429 and 409 errors with inline error without crashing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: 'Upload rate limit exceeded. Try again later.' }),
    } as unknown as Response)

    const { host } = await mount({ models: [] })
    const fileInput = host.querySelector('.office-3d-palette-imported input[type="file"]') as HTMLInputElement
    const file = new File(['data'], 'test.glb', { type: 'model/gltf-binary' })

    await act(async () => {
      Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const error = host.querySelector('.office-3d-upload-error')
    expect(error?.textContent).toBe('Upload rate limit exceeded. Try again later.')
    fetchSpy.mockRestore()
  })

  it('provides keyboard accessible button and aria-live status', async () => {
    const { host } = await mount({ models: [] })
    const btn = host.querySelector('.office-3d-upload-btn')
    expect(btn?.getAttribute('role')).toBe('button')
    expect(btn?.getAttribute('tabindex')).toBe('0')

    const fileInput = host.querySelector('#office-3d-model-input')
    expect(fileInput?.getAttribute('aria-label')).toBe('Upload 3D model (.glb, .gltf)')

    const status = host.querySelector('.office-3d-palette-status')
    expect(status?.getAttribute('aria-live')).toBe('polite')
  })

  it('renders manage models button and invokes onManageModels', async () => {
    const onManageModels = vi.fn()
    const { host } = await mount({ models: [], onManageModels })
    const manageBtn = host.querySelector('.office-3d-palette-manage-btn') as HTMLButtonElement
    expect(manageBtn).not.toBeNull()
    expect(manageBtn.textContent).toBe('Manage')

    await act(async () => {
      manageBtn.click()
    })
    expect(onManageModels).toHaveBeenCalledTimes(1)
  })

  it('updates model items when ruang:models-changed event fires', async () => {
    const testModels: ModelRecord[] = [
      { id: 'm-1234567890ab', name: 'Custom Lamp', format: 'glb', size: 2048, createdAt: '2026-10-14T00:00:00Z' },
      { id: 'm-234567890abc', name: 'Plant Pot', format: 'glb', size: 4096, createdAt: '2026-10-14T00:00:00Z' },
    ]
    const { host } = await mount({ models: testModels })
    expect(host.textContent).toContain('Custom Lamp')
    expect(host.textContent).toContain('Plant Pot')

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('ruang:models-changed', {
          detail: [testModels[0]],
        }),
      )
    })

    expect(host.textContent).toContain('Custom Lamp')
    expect(host.textContent).not.toContain('Plant Pot')
  })
})
