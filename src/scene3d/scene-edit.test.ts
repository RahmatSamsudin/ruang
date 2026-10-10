import { describe, expect, it } from 'vitest'
import { EMPTY_PATCH, type BoxItem, type PropItem, type ScenePatch, type WindowItem } from './scene.ts'
import { canDelete, deleteItem, editKeyAction, GRID, isEditable, moveItem, ROTATION_STEP, rotateBy, rotateItem, setItemLevel, snap } from './scene-edit.ts'

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
