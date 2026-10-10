import { describe, expect, it } from 'vitest'
import { applyPatch, deskSeatNumber, EMPTY_PATCH, levelAt, levelsOf, seatPositions, visibleAt, type PropItem, type SceneItem, type ScenePatch } from './scene.ts'

const prop = (id: string, level = 0, extra: Partial<PropItem> = {}): PropItem => ({ kind: 'prop', id, level, type: 'Plant', position: [0, level, 0], ...extra })
const patch = (overrides: ScenePatch['overrides'] = {}, added: SceneItem[] = []): ScenePatch => ({ version: 1, overrides, added })
const deepFreeze = <T,>(value: T): T => {
  if (typeof value === 'object' && value !== null) { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
  return value
}

describe('levels and views', () => {
  it('draws the cut-away of the active level and the shell of lower ones, never higher levels', () => {
    const cut = prop('cut', 0)
    const shell = prop('shell', 0, { view: 'shell' })
    const both = prop('both', 0, { view: 'both' })
    const upstairs = prop('up', 2.8)
    const ids = (active: number) => [cut, shell, both, upstairs].filter((item) => visibleAt(item, active)).map((item) => item.id)
    expect(ids(0)).toEqual(['cut', 'both'])
    expect(ids(2.8)).toEqual(['shell', 'both', 'up'])
  })

  it('derives sorted levels and finds the level an agent stands on', () => {
    expect(levelsOf([prop('a', 2.8), prop('b', 0), prop('c', 2.8)])).toEqual([0, 2.8])
    expect(levelAt([0, 2.8], 0)).toBe(0)
    expect(levelAt([0, 2.8], 0.3)).toBe(0)
    expect(levelAt([0, 2.8], 1.4)).toBe(0) // exactly the midpoint stays low, like the old y > H/2
    expect(levelAt([0, 2.8], 1.41)).toBe(2.8)
    expect(levelAt([0, 2.8], 2.8)).toBe(2.8)
    expect(levelAt([0, 2.8, 5.6], 4.19)).toBe(2.8) // 4.2 itself is a float coin-toss: (2.8 + 5.6) / 2 is 4.199999999999999
    expect(levelAt([0, 2.8, 5.6], 4.21)).toBe(5.6)
    expect(levelAt([0, 2.8, 5.6], 9)).toBe(5.6)
    expect(levelAt([0, 2.8], -3)).toBe(0)
    expect(levelAt([], 3)).toBe(0)
  })
})

describe('applyPatch', () => {
  const base = [prop('sofa'), prop('desk-1'), prop('bed-1', 2.8), prop('desk-2')]

  it('returns the items untouched for no patch or an empty one', () => {
    expect(applyPatch(base, undefined)).toBe(base)
    expect(applyPatch(base, EMPTY_PATCH)).toEqual(base)
  })

  it('moves, deletes and adds by id', () => {
    const items = [prop('sofa'), prop('lamp-1'), prop('desk-1')]
    const result = applyPatch(items, patch({ sofa: { position: [1, 0, 2] }, 'lamp-1': null }, [prop('extra')]))
    expect(result.find((item) => item.id === 'sofa')).toMatchObject({ position: [1, 0, 2], type: 'Plant' })
    expect(result.map((item) => item.id)).toEqual(['sofa', 'desk-1', 'extra'])
  })

  it('ignores overrides for ids that no longer exist', () => {
    expect(applyPatch(base, patch({ 'desk-9': null, ghost: { position: [5, 5, 5] } }))).toEqual(base)
  })

  it('keeps desks and beds when the patch deletes them, but still moves them', () => {
    const result = applyPatch(base, patch({ 'desk-1': null, 'bed-1': { position: [3, 2.8, 3] } }))
    expect(result.map((item) => item.id)).toEqual(['sofa', 'desk-1', 'bed-1', 'desk-2'])
    expect(result.find((item) => item.id === 'bed-1')).toMatchObject({ position: [3, 2.8, 3] })
  })

  it('never lets an override change id or kind', () => {
    const result = applyPatch(base, patch({ sofa: { id: 'x', kind: 'wall', position: [9, 0, 9] } as never }))
    expect(result[0]).toMatchObject({ id: 'sofa', kind: 'prop', position: [9, 0, 9] })
  })

  it('drops added items that collide with generated ids or look like desks and beds', () => {
    const result = applyPatch(base, patch({}, [prop('sofa'), prop('desk-9'), prop('bed-7'), prop('lamp'), prop('lamp')]))
    expect(result.map((item) => item.id)).toEqual(['sofa', 'desk-1', 'bed-1', 'desk-2', 'lamp'])
  })

  it('does not mutate its input', () => {
    const frozen = deepFreeze([prop('sofa'), prop('desk-1')])
    const frozenPatch = deepFreeze(patch({ sofa: { position: [1, 1, 1] }, 'desk-1': null }, [prop('lamp')]))
    expect(() => applyPatch(frozen, frozenPatch)).not.toThrow()
    expect(frozen[0].position).toEqual([0, 0, 0])
  })

  it('tolerates a malformed patch by ignoring the parts that are not usable', () => {
    expect(applyPatch(base, { version: 1 } as never)).toEqual(base)
    expect(applyPatch(base, { version: 1, overrides: { sofa: 'nope' }, added: 'nope' } as never)).toEqual(base)
    expect(applyPatch(base, null as never)).toBe(base)
    expect(applyPatch(base, { version: 1, overrides: {}, added: [null, 3, {}, { id: 5 }] } as never)).toEqual(base)
  })
})

describe('seatPositions', () => {
  it('lists desk or bed positions in numeric id order', () => {
    const items = [prop('desk-10', 0, { position: [10, 0, 0] }), prop('desk-2', 0, { position: [2, 0, 0] }), prop('desk-1', 0, { position: [1, 0, 0] }), prop('bed-1', 2.8, { position: [5, 2.8, 5] }), prop('desk-x')]
    expect(seatPositions(items, 'desk')).toEqual([[1, 0, 0], [2, 0, 0], [10, 0, 0]])
    expect(seatPositions(items, 'bed')).toEqual([[5, 2.8, 5]])
  })
})

describe('deskSeatNumber', () => {
  it('reads the seat of desk-N ids only', () => {
    expect(deskSeatNumber('desk-7')).toBe(7)
    expect(deskSeatNumber('tree-1')).toBeUndefined()
    expect(deskSeatNumber('desk-x')).toBeUndefined()
    expect(deskSeatNumber('desk-1-extra')).toBeUndefined()
  })
})
