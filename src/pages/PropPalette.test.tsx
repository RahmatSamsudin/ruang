// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROP_TYPES } from '../scene3d/scene.ts'
import { PropPalette } from './PropPalette.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.replaceChildren() })

async function mount(props: { placing?: Parameters<typeof PropPalette>[0]['placing']; limitReached?: boolean } = {}) {
  const onPick = vi.fn()
  const host = document.body.appendChild(document.createElement('div'))
  await act(async () => { createRoot(host).render(<PropPalette placing={props.placing ?? null} limitReached={props.limitReached ?? false} onPick={onPick}/>) })
  const buttons = () => [...host.querySelectorAll('.office-3d-palette-list button')] as HTMLButtonElement[]
  const button = (label: string) => buttons().find((node) => node.textContent === label)!
  return { host, onPick, buttons, button }
}

describe('PropPalette', () => {
  it('lists every object type once, in groups', async () => {
    const { host, buttons } = await mount()
    expect(buttons()).toHaveLength(PROP_TYPES.length)
    expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['Furniture', 'Kitchen', 'Leisure', 'Bedroom', 'Outdoor', 'Structure'])
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
})
