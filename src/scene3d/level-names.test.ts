import { describe, expect, it } from 'vitest'
import { FLOOR_HEIGHT } from '../office3d-layout.ts'
import { levelName } from './level-names.ts'

describe('levelName', () => {
  it('names the stock levels by height', () => {
    expect(levelName(0, 0).label).toBe('Kantor')
    expect(levelName(FLOOR_HEIGHT, 1).label).toBe('Kamar & Balkon')
    expect(levelName(FLOOR_HEIGHT, 1).title).toMatch(/^Lantai 2: bedroom/)
  })

  it('keeps the stock names when a level is added above, below or between', () => {
    expect(levelName(5.6, 2)).toEqual({ label: 'Lantai 3', title: 'Lantai 3' })
    expect(levelName(0, 1).label).toBe('Kantor')
    expect(levelName(FLOOR_HEIGHT, 2).label).toBe('Kamar & Balkon')
    expect(levelName(-2.8, 0)).toEqual({ label: 'Lantai 1', title: 'Lantai 1' })
    expect(levelName(0.6, 1)).toEqual({ label: 'Lantai 2', title: 'Lantai 2' })
  })
})
