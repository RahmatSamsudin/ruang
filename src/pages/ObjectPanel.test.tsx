// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropItem, WindowItem } from '../scene3d/scene.ts'
import { ObjectPanel } from './ObjectPanel.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const sofa: PropItem = { kind: 'prop', id: 'sofa', level: 0, type: 'Sofa', position: [4.6, 0, -1.3], rotation: Math.PI }
const desk: PropItem = { kind: 'prop', id: 'desk-1', level: 0, type: 'WorkDesk', position: [-2, 0, -3.5] }

afterEach(() => { document.body.replaceChildren() })

async function mount(item: PropItem | WindowItem, canDuplicate = true) {
  const handlers = { onMove: vi.fn(), onRotate: vi.fn(), onLevel: vi.fn(), onDelete: vi.fn(), onDuplicate: vi.fn(), onProp: vi.fn() }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  await act(async () => { root.render(<ObjectPanel item={item} levels={[0, 2.8]} canDuplicate={canDuplicate} {...handlers}/>) })
  const input = (label: string) => [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('input')!
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => { field.value = value; field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  }
  return { host, root, handlers, input, type }
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
    const handlers = { canDuplicate: true, onMove: vi.fn(), onRotate: vi.fn(), onLevel: vi.fn(), onDelete: vi.fn(), onDuplicate: vi.fn(), onProp: vi.fn() }
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

describe('ObjectPanel duplicate and properties', () => {
  const plant: PropItem = { kind: 'prop', id: 'added-1', level: 0, type: 'Plant', position: [1, 0, 1], props: { size: 1 } }
  const railing: PropItem = { kind: 'prop', id: 'added-2', level: 0, type: 'Railing', position: [0, 0, 0] }

  it('has a Duplicate button that can be disabled with a reason', async () => {
    const enabled = await mount(sofa)
    const button = [...enabled.host.querySelectorAll('button')].find((node) => node.textContent === 'Duplicate')!
    await act(async () => { button.click() })
    expect(enabled.handlers.onDuplicate).toHaveBeenCalledTimes(1)
    const full = await mount(sofa, false)
    const disabled = [...full.host.querySelectorAll('button')].filter((node) => node.textContent === 'Duplicate').at(-1)!
    expect(disabled.disabled).toBe(true)
    expect(disabled.title).toMatch(/limit/i)
  })

  it('shows the fields of the object type with the catalogue default when the prop is unset', async () => {
    const { input } = await mount(railing)
    expect(input('Length').value).toBe('2')
  })

  it('commits a number field clamped to its limits', async () => {
    const { handlers, input, type } = await mount(plant)
    await type(input('Size'), '1.5')
    expect(handlers.onProp).toHaveBeenLastCalledWith('size', 1.5)
    await type(input('Size'), '50')
    expect(handlers.onProp).toHaveBeenLastCalledWith('size', 2.5)
  })

  it('commits a colour on change, not on every drag of the picker', async () => {
    const { handlers, host } = await mount(sofa)
    const picker = host.querySelector('input[type="color"]') as HTMLInputElement
    expect(picker.value).toBe('#5b6f8c')
    await act(async () => { picker.value = '#112233'; picker.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(handlers.onProp).not.toHaveBeenCalled()
    await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(handlers.onProp).toHaveBeenLastCalledWith('color', '#112233')
  })

  it('keeps committing colours after the field remounts with a new value', async () => {
    const { handlers, host, root } = await mount(sofa)
    const picker = () => host.querySelector('input[type="color"]') as HTMLInputElement
    const choose = async (color: string) => { await act(async () => { picker().value = color; picker().dispatchEvent(new Event('change', { bubbles: true })) }) }
    await choose('#112233')
    expect(handlers.onProp).toHaveBeenLastCalledWith('color', '#112233')
    const recolored: PropItem = { ...sofa, props: { color: '#112233' } }
    await act(async () => { root.render(<ObjectPanel item={recolored} levels={[0, 2.8]} canDuplicate {...handlers}/>) })
    expect(picker().value).toBe('#112233')
    await choose('#445566')
    expect(handlers.onProp).toHaveBeenCalledTimes(2)
    expect(handlers.onProp).toHaveBeenLastCalledWith('color', '#445566')
  })

  it('has no property fields for a window or a type without any', async () => {
    const { host } = await mount({ kind: 'window', id: 'w1', level: 0, position: [0, 1.5, 0] })
    expect(host.querySelector('input[type="color"]')).toBeNull()
    expect(host.querySelectorAll('input[type="number"]')).toHaveLength(3)
  })
})
