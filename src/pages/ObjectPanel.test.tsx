// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropItem } from '../scene3d/scene.ts'
import { ObjectPanel } from './ObjectPanel.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const sofa: PropItem = { kind: 'prop', id: 'sofa', level: 0, type: 'Sofa', position: [4.6, 0, -1.3], rotation: Math.PI }
const desk: PropItem = { kind: 'prop', id: 'desk-1', level: 0, type: 'WorkDesk', position: [-2, 0, -3.5] }

afterEach(() => { document.body.replaceChildren() })

async function mount(item: PropItem) {
  const handlers = { onMove: vi.fn(), onRotate: vi.fn(), onLevel: vi.fn(), onDelete: vi.fn() }
  const host = document.body.appendChild(document.createElement('div'))
  await act(async () => { createRoot(host).render(<ObjectPanel item={item} levels={[0, 2.8]} {...handlers}/>) })
  const input = (label: string) => [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('input')!
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => { field.value = value; field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  }
  return { host, handlers, input, type }
}

describe('ObjectPanel', () => {
  it('shows the object, its position, rotation and floor', async () => {
    const { host, input } = await mount(sofa)
    expect(host.textContent).toContain('Sofa')
    expect(host.textContent).toContain('sofa')
    expect(input('X').value).toBe('4.6')
    expect(input('Z').value).toBe('-1.3')
    expect(input('Rotation').value).toBe('180')
    const select = host.querySelector('select')!
    expect(select.value).toBe('0')
    expect([...select.options].map((option) => option.textContent)).toEqual(['Kantor', 'Kamar & Balkon'])
  })

  it('commits a typed X, Z and rotation when the field loses focus', async () => {
    const { handlers, input, type } = await mount(sofa)
    await type(input('X'), '5')
    expect(handlers.onMove).toHaveBeenLastCalledWith(5, -1.3)
    await type(input('Z'), '2.5')
    expect(handlers.onMove).toHaveBeenLastCalledWith(4.6, 2.5)
    await type(input('Rotation'), '90')
    expect(handlers.onRotate).toHaveBeenLastCalledWith(90)
  })

  it('does not commit an unchanged value, and rejects empty, non-numeric or out-of-range input', async () => {
    const { handlers, input, type } = await mount(sofa)
    await type(input('X'), '4.6')
    for (const bad of ['', 'abc', '5000', '-1001']) {
      await type(input('X'), bad)
      expect(input('X').value).toBe('4.6')
    }
    expect(handlers.onMove).not.toHaveBeenCalled()
  })

  it('remounts the fields when another object is selected, so typed text cannot follow the selection', async () => {
    const handlers = { onMove: vi.fn(), onRotate: vi.fn(), onLevel: vi.fn(), onDelete: vi.fn() }
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const other: PropItem = { ...desk, id: 'desk-2', position: [4.6, 0, -3.5] }
    await act(async () => { root.render(<ObjectPanel item={sofa} levels={[0]} {...handlers}/>) })
    const x = () => document.querySelector<HTMLInputElement>('input[type=number]')!
    await act(async () => { x().value = '9' })
    await act(async () => { root.render(<ObjectPanel item={other} levels={[0]} {...handlers}/>) })
    expect(x().value).toBe('4.6')
    expect(handlers.onMove).not.toHaveBeenCalled()
  })

  it('moves the item to another floor from the select', async () => {
    const { host, handlers } = await mount(sofa)
    const select = host.querySelector('select')!
    await act(async () => { select.value = '2.8'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(handlers.onLevel).toHaveBeenCalledWith(2.8)
  })

  it('deletes ordinary objects but not desks or beds', async () => {
    const ordinary = await mount(sofa)
    const button = [...ordinary.host.querySelectorAll('button')].find((node) => node.textContent === 'Delete')!
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(ordinary.handlers.onDelete).toHaveBeenCalledTimes(1)
    document.body.replaceChildren()
    const seat = await mount(desk)
    const locked = [...seat.host.querySelectorAll('button')].find((node) => node.textContent === 'Delete')!
    expect(locked.disabled).toBe(true)
    expect(locked.title).toBe('Desks and beds follow the number of agents')
  })
})
