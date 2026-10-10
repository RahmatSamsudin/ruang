import { describe, expect, it } from 'vitest'
import { EMPTY_PATCH, MAX_ADDED, type BoxItem, type PropItem, type ScenePatch, type WindowItem } from './scene.ts'
import { addProp, canDelete, deleteItem, dragTarget, duplicateItem, editKeyAction, GRID, isEditable, moveItem, nextAddedId, placePoint, ROTATION_STEP, rotateBy, rotateItem, setItemLevel, setItemProp, snap } from './scene-edit.ts'

const sofa: PropItem = { kind: 'prop', id: 'sofa', level: 0, type: 'Sofa', position: [4.6, 0, -1.3], rotation: Math.PI }
const lamp: PropItem = { kind: 'prop', id: 'my-lamp', level: 0, type: 'Plant', position: [1, 0, 1] }
const bed: PropItem = { kind: 'prop', id: 'bed-1', level: 2.8, type: 'Bed', position: [-4, 2.8, -4.1] }
const desk: PropItem = { kind: 'prop', id: 'desk-2', level: 0, type: 'WorkDesk', position: [-2, 0, -3.5] }
const window1: WindowItem = { kind: 'window', id: 'window-back-1', level: 0, position: [-7, 1.55, -5.06] }
const box: BoxItem = { kind: 'box', id: 'game-roof', level: 0, position: [0, 2.7, 0], size: [1, 1, 1], color: '#999999' }
const withAdded: ScenePatch = { ...EMPTY_PATCH, added: [lamp] }
const bounds = { minX: -10, maxX: 10, minZ: -6, maxZ: 12 }

const deepFreeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

describe('snap', () => {
  it('snaps to the grid without float noise or negative zero', () => {
    expect(GRID).toBe(0.25)
    expect(snap(0.1)).toBe(0)
    expect(Object.is(snap(-0.1), 0)).toBe(true)
    expect(snap(0.13)).toBe(0.25)
    expect(snap(0.3)).toBe(0.25)
    expect(snap(0.375)).toBe(0.5)
    expect(snap(1.37)).toBe(1.25)
    expect(snap(-1.37)).toBe(-1.25)
    expect(snap(2, 0.5)).toBe(2)
  })
})

describe('which items the editor touches', () => {
  it('edits props and windows only, and never deletes desks or beds', () => {
    expect(isEditable(sofa)).toBe(true)
    expect(isEditable(window1)).toBe(true)
    expect(isEditable(box)).toBe(false)
    expect(canDelete(sofa)).toBe(true)
    expect(canDelete(desk)).toBe(false)
    expect(canDelete(bed)).toBe(false)
    expect(canDelete({ ...sofa, id: 'tree-1' })).toBe(true)
  })
})

describe('moveItem', () => {
  it('overrides a stock item, keeping its height and other overrides', () => {
    const start: ScenePatch = { ...EMPTY_PATCH, overrides: { sofa: { rotation: 1 } } }
    const moved = moveItem(start, { ...sofa, position: [4.6, 2.8, -1.3] }, 2, 3)
    expect(moved.overrides.sofa).toEqual({ rotation: 1, position: [2, 2.8, 3] })
    expect(start.overrides.sofa).toEqual({ rotation: 1 })
  })

  it('edits an added item in place instead of adding an override', () => {
    const moved = moveItem(withAdded, lamp, 5, 6)
    expect(moved.added[0]).toMatchObject({ id: 'my-lamp', position: [5, 0, 6] })
    expect(moved.overrides).toEqual({})
  })

  it('clamps to the bounds, also for free placement', () => {
    expect(moveItem(EMPTY_PATCH, sofa, 99, -99, bounds).overrides.sofa).toEqual({ position: [10, 0, -6] })
    expect(moveItem(EMPTY_PATCH, sofa, -99, 99, bounds).overrides.sofa).toEqual({ position: [-10, 0, 12] })
  })

  it('moves desks and beds and never mutates its input', () => {
    const frozen = deepFreeze({ ...EMPTY_PATCH, overrides: {}, added: [] })
    expect(moveItem(frozen, desk, 1, 1).overrides['desk-2']).toEqual({ position: [1, 0, 1] })
    expect(moveItem(frozen, bed, 1, 1).overrides['bed-1']).toEqual({ position: [1, 2.8, 1] })
  })

  it('rounds to four decimals so saved numbers stay small', () => {
    expect(moveItem(EMPTY_PATCH, sofa, 1.123456789, 2).overrides.sofa).toEqual({ position: [1.1235, 0, 2] })
  })

  it('returns the same patch when the position does not change (no empty undo step)', () => {
    expect(moveItem(EMPTY_PATCH, sofa, 4.6, -1.3)).toBe(EMPTY_PATCH)
    expect(moveItem(EMPTY_PATCH, sofa, 99, -1.3, { minX: -10, maxX: 4.6, minZ: -6, maxZ: 12 })).toBe(EMPTY_PATCH)
  })
})

describe('items outside the bounds', () => {
  const tree = { ...sofa, id: 'tree-7', position: [3, 0, -8.5] as [number, number, number] }
  const inside = { minX: -10, maxX: 10, minZ: -7, maxZ: 12 }

  it('moveItem keeps an untouched off-bounds axis and still moves back inside', () => {
    expect(moveItem(EMPTY_PATCH, tree, 3, -8.5, inside)).toBe(EMPTY_PATCH)
    expect(moveItem(EMPTY_PATCH, tree, 5, -8.5, inside).overrides['tree-7']).toEqual({ position: [5, 0, -8.5] })
    expect(moveItem(EMPTY_PATCH, tree, 3, 0, inside).overrides['tree-7']).toEqual({ position: [3, 0, 0] })
    expect(moveItem(EMPTY_PATCH, tree, 3, -99, inside)).toBe(EMPTY_PATCH) // may not go further out
  })

  it('dragTarget keeps an off-bounds origin on a click and still moves inside', () => {
    expect(dragTarget([3, -8.5], [3.05, -8.45], false, inside)).toEqual([3, -8.5])
    expect(dragTarget([3, -8.5], [3, -2], true, inside)).toEqual([3, -2])
    expect(dragTarget([3, 0], [3, -99], true, inside)).toEqual([3, -7])
  })
})

describe('dragTarget', () => {
  const wide = { minX: -10, maxX: 10, minZ: -6, maxZ: 12 }

  it('a click with jitter keeps an off-grid origin exactly', () => {
    expect(dragTarget([0.9, 1.3], [0.95, 1.32], false, wide)).toEqual([0.9, 1.3])
  })

  it('snaps the movement, not the position, to the grid', () => {
    const [x, z] = dragTarget([0.9, 1.3], [1.2, 1.3], false, wide)
    expect(x).toBeCloseTo(1.15, 6)
    expect(z).toBeCloseTo(1.3, 6)
  })

  it('rounds a 0.12 delta to 0 and a 0.13 delta to one step', () => {
    expect(dragTarget([0, 0], [0.12, 0], false, wide)[0]).toBe(0)
    expect(dragTarget([0, 0], [0.13, 0], false, wide)[0]).toBe(0.25)
  })

  it('free placement follows the raw delta', () => {
    const [x, z] = dragTarget([0.9, 1.3], [0.95, 1.32], true, wide)
    expect(x).toBeCloseTo(0.95, 6)
    expect(z).toBeCloseTo(1.32, 6)
  })

  it('clamps to the bounds on both axes, also when free', () => {
    expect(dragTarget([0, 0], [99, -99], false, wide)).toEqual([10, -6])
    expect(dragTarget([0, 0], [-99, 99], true, wide)).toEqual([-10, 12])
  })

  it('handles negative deltas', () => {
    const [x, z] = dragTarget([1, 1], [0.6, 0.3], false, wide)
    expect(x).toBeCloseTo(0.5, 6) // -0.4 rounds to -2 steps
    expect(z).toBeCloseTo(0.25, 6) // -0.7 rounds to -3 steps
  })
})

describe('rotateItem and rotateBy', () => {
  it('stores radians wrapped into [0, 2π)', () => {
    expect(rotateItem(EMPTY_PATCH, sofa, -Math.PI / 2).overrides.sofa).toEqual({ rotation: 4.7124 })
    expect(rotateItem(EMPTY_PATCH, sofa, Math.PI * 2).overrides.sofa).toEqual({ rotation: 0 })
    expect(rotateItem(EMPTY_PATCH, sofa, Math.PI * 4 + 1).overrides.sofa).toEqual({ rotation: 1 })
  })

  it('rotates relative to the current rotation, treating none as 0', () => {
    expect(rotateBy(EMPTY_PATCH, lamp, ROTATION_STEP).added.length).toBe(0)
    expect(rotateBy(EMPTY_PATCH, lamp, ROTATION_STEP).overrides['my-lamp']).toEqual({ rotation: 0.2618 })
    expect(rotateBy(EMPTY_PATCH, sofa, -ROTATION_STEP).overrides.sofa).toEqual({ rotation: 2.8798 })
  })
})

describe('deleteItem', () => {
  it('deletes a stock item with a null override, replacing earlier overrides', () => {
    const start: ScenePatch = { ...EMPTY_PATCH, overrides: { sofa: { position: [0, 0, 0] } } }
    expect(deleteItem(start, sofa).overrides.sofa).toBeNull()
  })

  it('removes an added item from the patch', () => {
    expect(deleteItem(withAdded, lamp).added).toEqual([])
  })

  it('leaves desks and beds alone and returns the same patch', () => {
    expect(deleteItem(EMPTY_PATCH, desk)).toBe(EMPTY_PATCH)
    expect(deleteItem(EMPTY_PATCH, bed)).toBe(EMPTY_PATCH)
  })
})

describe('setItemLevel', () => {
  it('moves an item to another floor, shifting its height by the difference', () => {
    expect(setItemLevel(EMPTY_PATCH, sofa, 2.8).overrides.sofa).toEqual({ level: 2.8, position: [4.6, 2.8, -1.3] })
    expect(setItemLevel(EMPTY_PATCH, bed, 0).overrides['bed-1']).toEqual({ level: 0, position: [-4, 0, -4.1] })
    expect(setItemLevel(EMPTY_PATCH, window1, 2.8).overrides['window-back-1']).toEqual({ level: 2.8, position: [-7, 4.35, -5.06] })
  })

  it('does nothing for the level the item is already on', () => {
    expect(setItemLevel(EMPTY_PATCH, sofa, 0)).toBe(EMPTY_PATCH)
  })
})

describe('editKeyAction', () => {
  const key = (name: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => editKeyAction({ key: name, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift })

  it('maps the editor shortcuts', () => {
    expect(key('z', { ctrl: true })).toBe('undo')
    expect(key('Z', { meta: true })).toBe('undo')
    expect(key('z', { ctrl: true, shift: true })).toBe('redo')
    expect(key('y', { ctrl: true })).toBe('redo')
    expect(key('Delete')).toBe('delete')
    expect(key('Backspace')).toBe('delete')
    expect(key('r')).toBe('rotate+')
    expect(key('R', { shift: true })).toBe('rotate-')
    expect(key('Escape')).toBe('deselect')
  })

  it('ignores everything else, including other Ctrl combinations', () => {
    expect(key('a')).toBeNull()
    expect(key('r', { ctrl: true })).toBeNull()
    expect(key('PageUp')).toBeNull()
  })
})

describe('nextAddedId', () => {
  it('takes the smallest free number, counting stock, added and overridden ids', () => {
    expect(nextAddedId(EMPTY_PATCH, [sofa])).toBe('added-1')
    expect(nextAddedId({ ...EMPTY_PATCH, added: [{ ...lamp, id: 'added-1' }] }, [])).toBe('added-2')
    expect(nextAddedId({ ...EMPTY_PATCH, overrides: { 'added-1': null } }, [])).toBe('added-2')
    expect(nextAddedId(EMPTY_PATCH, [{ ...sofa, id: 'added-1' }, { ...sofa, id: 'added-2' }])).toBe('added-3')
  })

  it('reuses a number only when nothing refers to it any more', () => {
    const one = { ...lamp, id: 'added-1' }
    const two = { ...lamp, id: 'added-2' }
    expect(nextAddedId({ ...EMPTY_PATCH, added: [two] }, [])).toBe('added-1')
    expect(nextAddedId({ ...EMPTY_PATCH, added: [one, two] }, [])).toBe('added-3')
  })
})

describe('placePoint', () => {
  it('snaps to the grid, or stays free with Alt, and clamps to the bounds', () => {
    expect(placePoint([1.13, 2.4], false, bounds)).toEqual([1.25, 2.5])
    expect(placePoint([1.13, 2.4], true, bounds)).toEqual([1.13, 2.4])
    expect(placePoint([99, -99], false, bounds)).toEqual([10, -6])
    expect(Object.is(placePoint([-0.05, 0], false, bounds)[0], 0)).toBe(true)
  })
})

describe('addProp', () => {
  it('adds a prop of the catalogue type at the viewed level with its mounting height and defaults', () => {
    const { patch, id } = addProp(EMPTY_PATCH, [], 'Sofa', 3, -2, 2.8, bounds)
    expect(id).toBe('added-1')
    expect(patch.added).toEqual([{ kind: 'prop', id: 'added-1', type: 'Sofa', level: 2.8, position: [3, 2.8, -2], props: { color: '#5b6f8c' } }])
    const clock = addProp(EMPTY_PATCH, [], 'WallClock', 1, 1, 0, bounds).patch.added[0] as PropItem
    expect(clock.position).toEqual([1, 2.35, 1])
    expect(clock.props).toBeUndefined()
  })

  it('rounds, clamps to the bounds and does not mutate or share the catalogue defaults', () => {
    const frozen = deepFreeze({ ...EMPTY_PATCH })
    const first = addProp(frozen, [], 'Plant', 99, -99.123456, 0, bounds)
    expect((first.patch.added[0] as PropItem).position).toEqual([10, 0, -6])
    expect(frozen.added).toEqual([])
    const a = addProp(EMPTY_PATCH, [], 'Plant', 0, 0, 0, bounds).patch.added[0] as PropItem
    const b = addProp(EMPTY_PATCH, [], 'Plant', 0, 0, 0, bounds).patch.added[0] as PropItem
    expect(a.props).not.toBe(b.props)
  })

  it('refuses the 501st added item and changes nothing', () => {
    const full = { ...EMPTY_PATCH, added: Array.from({ length: MAX_ADDED }, (_, n) => ({ ...lamp, id: `added-${n + 1}` })) }
    const result = addProp(full, [], 'Sofa', 0, 0, 0, bounds)
    expect(result.id).toBeNull()
    expect(result.patch).toBe(full)
    const almost = { ...EMPTY_PATCH, added: full.added.slice(1) }
    expect(addProp(almost, [], 'Sofa', 0, 0, 0, bounds).id).not.toBeNull()
  })
})

describe('duplicateItem', () => {
  it('copies the drawn item to a new id, offset by half a metre, with its own props', () => {
    const chair: PropItem = { kind: 'prop', id: 'armchair-1', level: 0, type: 'Armchair', position: [2.1, 0, -2.9], rotation: Math.PI / 2, props: { color: '#d9784a' } }
    const { patch, id } = duplicateItem(EMPTY_PATCH, [chair], chair, bounds)
    expect(id).toBe('added-1')
    const copy = patch.added[0] as PropItem
    expect(copy).toMatchObject({ kind: 'prop', id: 'added-1', type: 'Armchair', level: 0, rotation: Math.PI / 2, position: [2.6, 0, -2.4], props: { color: '#d9784a' } })
    expect(copy.props).not.toBe(chair.props)
    expect(patch.overrides).toEqual({})
  })

  it('takes the drawn values, so an overridden original does not leak its override to the copy', () => {
    const moved = { ...sofa, position: [5, 0, 5] as [number, number, number] }
    const { patch } = duplicateItem({ ...EMPTY_PATCH, overrides: { sofa: { position: [5, 0, 5] } } }, [moved], moved, bounds)
    expect((patch.added[0] as PropItem).position).toEqual([5.5, 0, 5.5])
    expect(patch.overrides).toEqual({ sofa: { position: [5, 0, 5] } })
  })

  it('keeps the view of a stair-like item and copies windows too', () => {
    const stairs: PropItem = { kind: 'prop', id: 'stairs', level: 0, view: 'both', type: 'Staircase', position: [4.7, 0, 3.45], props: { run: -2.9, rise: 2.8, width: 0.9 } }
    expect((duplicateItem(EMPTY_PATCH, [stairs], stairs, bounds).patch.added[0] as PropItem).view).toBe('both')
    const copy = duplicateItem(EMPTY_PATCH, [window1], window1, bounds).patch.added[0] as WindowItem
    expect(copy).toMatchObject({ kind: 'window', id: 'added-1', position: [-6.5, 1.55, -4.56] })
  })

  it('copies only the fields the server accepts for the kind', () => {
    const odd = { ...sofa, width: 1, size: [1, 1, 1] } as PropItem
    const copy = duplicateItem(EMPTY_PATCH, [odd], odd, bounds).patch.added[0]
    expect(copy).not.toHaveProperty('width')
    expect(copy).not.toHaveProperty('size')
    expect(copy).toMatchObject({ kind: 'prop', type: 'Sofa', rotation: Math.PI, level: 0 })
    const wide = { ...window1, width: 2, rotation: 1, view: 'both', props: { color: 'red' } } as WindowItem
    const windowCopy = duplicateItem(EMPTY_PATCH, [wide], wide, bounds).patch.added[0]
    expect(windowCopy).toMatchObject({ kind: 'window', width: 2, rotation: 1, view: 'both' })
    expect(windowCopy).not.toHaveProperty('props')
    expect(duplicateItem(EMPTY_PATCH, [window1], window1, bounds).patch.added[0]).not.toHaveProperty('width')
  })

  it('stays inside the bounds, but an item already outside them can still be copied', () => {
    const edge: PropItem = { ...lamp, id: 'edge', position: [10, 0, 12] }
    expect((duplicateItem(EMPTY_PATCH, [edge], edge, bounds).patch.added[0] as PropItem).position).toEqual([10, 0, 12])
    const tree: PropItem = { ...lamp, id: 'tree-7', type: 'Tree', position: [1, 0, -8.5] }
    expect((duplicateItem(EMPTY_PATCH, [tree], tree, bounds).patch.added[0] as PropItem).position).toEqual([1.5, 0, -8])
  })

  it('refuses at the limit', () => {
    const full = { ...EMPTY_PATCH, added: Array.from({ length: MAX_ADDED }, (_, n) => ({ ...lamp, id: `added-${n + 1}` })) }
    const result = duplicateItem(full, [], sofa, bounds)
    expect(result.id).toBeNull()
    expect(result.patch).toBe(full)
  })

  it('does not mutate its input', () => {
    const patch = deepFreeze({ ...EMPTY_PATCH })
    expect(() => duplicateItem(patch, deepFreeze([{ ...sofa }]), deepFreeze({ ...sofa }), bounds)).not.toThrow()
  })
})

describe('setItemProp', () => {
  it('writes the whole props object through an override for a stock item', () => {
    const chair: PropItem = { kind: 'prop', id: 'armchair-1', level: 0, type: 'Armchair', position: [2, 0, 2], props: { color: '#d9784a' } }
    const next = setItemProp(EMPTY_PATCH, chair, 'color', '#112233')
    expect(next.overrides['armchair-1']).toEqual({ props: { color: '#112233' } })
  })

  it('keeps the other props and edits added items in place', () => {
    const stairs: PropItem = { kind: 'prop', id: 'added-1', level: 0, type: 'Staircase', position: [0, 0, 0], props: { run: 3, rise: 2.8, width: 0.9 } }
    const next = setItemProp({ ...EMPTY_PATCH, added: [stairs] }, stairs, 'width', 1.2)
    expect((next.added[0] as PropItem).props).toEqual({ run: 3, rise: 2.8, width: 1.2 })
    expect(next.overrides).toEqual({})
  })

  it('is a no-op for an unchanged value or a window', () => {
    const chair: PropItem = { ...lamp, props: { size: 1 } }
    const patch = { ...EMPTY_PATCH, added: [chair] }
    expect(setItemProp(patch, chair, 'size', 1)).toBe(patch)
    expect(setItemProp(EMPTY_PATCH, window1, 'width', 3)).toBe(EMPTY_PATCH)
  })
})

describe('editKeyAction duplicate', () => {
  it('maps Ctrl/Cmd+D', () => {
    expect(editKeyAction({ key: 'd', ctrlKey: true, metaKey: false, shiftKey: false })).toBe('duplicate')
    expect(editKeyAction({ key: 'D', ctrlKey: false, metaKey: true, shiftKey: false })).toBe('duplicate')
    expect(editKeyAction({ key: 'd', ctrlKey: false, metaKey: false, shiftKey: false })).toBeNull()
  })
})
