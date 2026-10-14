// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoxItem, FloorItem, GlassItem, ModelItem, PropItem, WallItem, WindowItem } from '../scene3d/scene.ts'
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

  it('shows decorative disclaimer notice for Staircase prop', async () => {
    const staircase: PropItem = { kind: 'prop', id: 'stair-1', level: 0, type: 'Staircase', position: [0, 0, 0] }
    const { host } = await mount(staircase)
    expect(host.textContent).toContain('Decorative in 2c')
  })
})

describe('ObjectPanel structure items', () => {
  const floor: FloorItem = {
    kind: 'floor',
    id: 'floor-test',
    level: 0,
    min: [-4, -4],
    max: [4, 4],
    y: 0,
    surface: { type: 'wood', repeat: [2, 2] },
    roughness: 0.55,
  }
  const wall: WallItem = {
    kind: 'wall',
    id: 'wall-test',
    level: 0,
    from: [-4, 0],
    to: [4, 0],
    y: 0,
    height: 2.6,
  }
  const glass: GlassItem = {
    kind: 'glass',
    id: 'glass-test',
    level: 0,
    from: [-2, 1],
    to: [2, 1],
    bottom: 0,
    top: 2.2,
  }
  const box: BoxItem = {
    kind: 'box',
    id: 'box-test',
    level: 0,
    position: [1, 0.5, 2],
    size: [2, 1, 2],
    color: '#a0a0a0',
    opacity: 0.8,
    roughness: 0.4,
    radius: 0.1,
    shadow: true,
  }

  async function mountStructure(item: FloorItem | WallItem | GlassItem | BoxItem, extraHandlers: Record<string, unknown> = {}) {
    const handlers = {
      onMove: vi.fn(),
      onRotate: vi.fn(),
      onLevel: vi.fn(),
      onDelete: vi.fn(),
      onDuplicate: vi.fn(),
      onProp: vi.fn(),
      onView: vi.fn(),
      onFloorBounds: vi.fn(),
      onFloorSurface: vi.fn(),
      onWallGeometry: vi.fn(),
      onGlassGeometry: vi.fn(),
      onBoxProps: vi.fn(),
      ...extraHandlers,
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => { root.render(<ObjectPanel item={item} levels={[0, 2.8]} canDuplicate={true} {...handlers}/>) })
    const input = (label: string) => [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('input')!
    const type = async (field: HTMLInputElement, value: string) => {
      await act(async () => { field.value = value; field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    }
    return { host, root, handlers, input, type }
  }

  it('renders floor properties and commits dimensions, elevation and surface changes', async () => {
    const { host, handlers, input, type } = await mountStructure(floor)
    expect(host.textContent).toContain('Floor')
    expect(host.textContent).toContain('floor-test')
    expect(input('Width').value).toBe('8')
    expect(input('Depth').value).toBe('8')
    await type(input('Width'), '10')
    expect(handlers.onFloorBounds).toHaveBeenCalledWith([-5, -4], [5, 4], 0)
    await type(input('Elevation Y'), '0.5')
    expect(handlers.onFloorBounds).toHaveBeenCalledWith([-4, -4], [4, 4], 0.5)

    const surfaceSelect = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Surface Material'))!.querySelector('select')!
    await act(async () => { surfaceSelect.value = 'tile'; surfaceSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(handlers.onFloorSurface).toHaveBeenCalledWith({ type: 'tile', repeat: [2, 2] }, 0.55)
  })

  it('FloorPanel on Lantai 3 editing width keeps storey y', async () => {
    const floorL3: FloorItem = {
      ...floor,
      id: 'floor-l3',
      level: 5.6,
      y: 5.6,
    }
    const { handlers, input, type } = await mountStructure(floorL3)
    await type(input('Width'), '10')
    expect(handlers.onFloorBounds).toHaveBeenCalledWith([-5, -4], [5, 4], 5.6)
  })

  it('renders wall properties, presets and commits geometry and rotate 90', async () => {
    const { host, handlers, input, type } = await mountStructure(wall)
    expect(host.textContent).toContain('Wall')
    expect(host.textContent).toContain('wall-test')
    expect(input('Height').value).toBe('2.6')
    expect(host.textContent).toContain('Length: 8 m')

    const stubBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Stub'))!
    await act(async () => { stubBtn.click() })
    expect(handlers.onWallGeometry).toHaveBeenCalledWith([-4, 0], [4, 0], 0.55, 0)

    await type(input('Height'), '3')
    expect(handlers.onWallGeometry).toHaveBeenCalledWith([-4, 0], [4, 0], 3, 0)

    const rotateBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Rotate 90°')!
    await act(async () => { rotateBtn.click() })
    expect(handlers.onRotate).toHaveBeenCalledWith(90)
  })

  it('renders glass properties and commits bottom/top elevation', async () => {
    const { host, handlers, input, type } = await mountStructure(glass)
    expect(host.textContent).toContain('Glass')
    expect(host.textContent).toContain('glass-test')
    expect(host.textContent).toContain('Height: 2.2 m')

    await type(input('Top Y'), '2.5')
    expect(handlers.onGlassGeometry).toHaveBeenCalledWith([-2, 1], [2, 1], 0, 2.5)
  })

  it('renders box properties and commits dimensions, appearance and shadow checkbox', async () => {
    const { host, handlers, input, type } = await mountStructure(box)
    expect(host.textContent).toContain('Box')
    expect(host.textContent).toContain('box-test')
    expect(input('Size X').value).toBe('2')
    expect(input('Size Y').value).toBe('1')
    expect(input('Size Z').value).toBe('2')

    await type(input('Size X'), '3')
    expect(handlers.onBoxProps).toHaveBeenCalledWith([3, 1, 2], '#a0a0a0', expect.objectContaining({ opacity: 0.8 }))

    const shadowBox = [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('Cast Shadow'))!.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { shadowBox.click() })
    expect(handlers.onBoxProps).toHaveBeenCalledWith([2, 1, 2], '#a0a0a0', expect.objectContaining({ shadow: false }))
  })

  it('renders model properties and commits position, rotation, and scale', async () => {
    const model: ModelItem = {
      kind: 'model',
      id: 'added-1',
      level: 0,
      modelId: 'm-0123456789ab',
      position: [1.5, 0, 2.5],
      rotation: 0,
      scale: 1.2,
    }
    const handlers = {
      canDuplicate: true,
      onMove: vi.fn(),
      onRotate: vi.fn(),
      onLevel: vi.fn(),
      onDuplicate: vi.fn(),
      onProp: vi.fn(),
      onDelete: vi.fn(),
      onScale: vi.fn(),
    }
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    await act(async () => {
      root.render(<ObjectPanel item={model} levels={[0, 2.8]} {...handlers} />)
    })
    expect(host.textContent).toContain('Model')
    expect(host.textContent).toContain('added-1')

    const input = (label: string) => [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('input')!
    const type = async (field: HTMLInputElement, value: string) => {
      await act(async () => {
        field.value = value
        field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      })
    }

    expect(input('Scale').value).toBe('1.2')
    await type(input('Scale'), '2.5')
    expect(handlers.onScale).toHaveBeenCalledWith(2.5)

    await type(input('X').value ? input('X') : input('X (m)'), '3.0')
    expect(handlers.onMove).toHaveBeenCalledWith(3, 2.5)

    const deleteBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!
    await act(async () => { deleteBtn.click() })
    expect(handlers.onDelete).toHaveBeenCalled()
  })
  it('triggers onSurfaceChange and supports carpet color picker', async () => {
    const onSurfaceChange = vi.fn()
    const { host, root, handlers } = await mountStructure(floor, { onSurfaceChange })
    const surfaceSelect = [...host.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Surface Material'))!.querySelector('select')!
    await act(async () => {
      surfaceSelect.value = 'carpet'
      surfaceSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onSurfaceChange).toHaveBeenCalledWith({ type: 'carpet', repeat: [2, 2], color: '#687787' }, 0.55)

    const carpetFloor: FloorItem = { ...floor, surface: { type: 'carpet', repeat: [2, 2], color: '#687787' } }
    await act(async () => { root.render(<ObjectPanel item={carpetFloor} levels={[0, 2.8]} canDuplicate {...handlers} onSurfaceChange={onSurfaceChange}/>) })
    const colorInput = host.querySelector('input[type="color"]') as HTMLInputElement
    expect(colorInput).not.toBeNull()
    await act(async () => {
      colorInput.value = '#ff0000'
      colorInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onSurfaceChange).toHaveBeenCalledWith({ type: 'carpet', repeat: [2, 2], color: '#ff0000' }, 0.55)
  })

  it('triggers onViewChange or onView with shell or cutaway', async () => {
    const onViewChange = vi.fn()
    const { host } = await mountStructure(wall, { onViewChange })
    const viewSelect = [...host.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith('View'))!.querySelector('select')!
    await act(async () => {
      viewSelect.value = 'shell'
      viewSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onViewChange).toHaveBeenCalledWith('shell')
    await act(async () => {
      viewSelect.value = 'cutaway'
      viewSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onViewChange).toHaveBeenCalledWith('cutaway')
  })

  it('allows duplicate and delete for structure items', async () => {
    const { host, handlers } = await mountStructure(glass)
    const dupBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Duplicate')!
    await act(async () => { dupBtn.click() })
    expect(handlers.onDuplicate).toHaveBeenCalled()

    const delBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Delete')!
    expect(delBtn.disabled).toBe(false)
    await act(async () => { delBtn.click() })
    expect(handlers.onDelete).toHaveBeenCalled()
  })

  it('reverts invalid or non-numeric input on blur in structure fields and alerts', async () => {
    const { host, handlers, input, type } = await mountStructure(floor)
    await type(input('Width'), 'invalid')
    expect(input('Width').value).toBe('8')
    expect(handlers.onFloorBounds).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Invalid number')
  })
})
