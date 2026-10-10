import { describe, expect, it } from 'vitest'
import { GROUPS, PROP_CATALOG } from './prop-catalog.ts'
import { PROP_TYPES } from './scene.ts'

// Mirrors the server's `props` check (server/scene.ts propValues): the UI must never save what the server rejects.
const serverAccepts = (props: Record<string, unknown>): boolean => Object.keys(props).length <= 16 && Object.entries(props).every(([key, value]) => /^[A-Za-z]{1,24}$/.test(key) && ((typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100) || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 64)))

describe('prop catalogue', () => {
  it('has an entry for every object type and nothing else', () => {
    expect(Object.keys(PROP_CATALOG).sort()).toEqual([...PROP_TYPES].sort())
  })

  it('uses known groups, labels and sane heights', () => {
    for (const [type, entry] of Object.entries(PROP_CATALOG)) {
      expect(GROUPS, type).toContain(entry.group)
      expect(entry.label.trim().length, type).toBeGreaterThan(0)
      expect(entry.y, type).toBeGreaterThanOrEqual(0)
      expect(entry.y, type).toBeLessThanOrEqual(3)
    }
  })

  it('has defaults the server accepts', () => {
    for (const [type, entry] of Object.entries(PROP_CATALOG)) {
      if (entry.defaults) expect(serverAccepts(entry.defaults), type).toBe(true)
    }
  })

  it('gives every editable field a default of the right kind inside its limits', () => {
    for (const [type, entry] of Object.entries(PROP_CATALOG)) {
      for (const field of entry.fields ?? []) {
        const value = entry.defaults?.[field.key]
        expect(value, `${type}.${field.key}`).toBeDefined()
        if (field.kind === 'number') {
          expect(typeof value, `${type}.${field.key}`).toBe('number')
          expect(field.min, type).toBeLessThan(field.max)
          expect(Math.abs(field.min), type).toBeLessThanOrEqual(100)
          expect(Math.abs(field.max), type).toBeLessThanOrEqual(100)
          expect(value as number, `${type}.${field.key}`).toBeGreaterThanOrEqual(field.min)
          expect(value as number, `${type}.${field.key}`).toBeLessThanOrEqual(field.max)
        } else {
          expect(value, `${type}.${field.key}`).toMatch(/^#[0-9a-fA-F]{6}$/)
        }
      }
    }
  })

  it('keeps the parameters components cannot default themselves', () => {
    expect(PROP_CATALOG.Railing.defaults).toHaveProperty('length')
    expect(PROP_CATALOG.StringLights.defaults).toHaveProperty('length')
    expect(PROP_CATALOG.Staircase.defaults).toEqual({ run: 3, rise: 2.8, width: 0.9 })
    for (const type of ['Armchair', 'ArcadeCabinet', 'Beanbag', 'FloorCushion'] as const) expect(PROP_CATALOG[type].defaults, type).toHaveProperty('color')
  })

  it('mounts wall and ceiling objects at the stock heights', () => {
    expect(PROP_CATALOG.WallClock.y).toBe(2.35)
    expect(PROP_CATALOG.Television.y).toBe(1.35)
    expect(PROP_CATALOG.AirConditioner.y).toBe(2.3)
    expect(PROP_CATALOG.OfficeLight.y).toBe(2.4)
    expect(PROP_CATALOG.StringLights.y).toBe(2.15)
    expect(PROP_CATALOG.Sofa.y).toBe(0)
  })

  it('warns that new desks and beds are decoration', () => {
    expect(PROP_CATALOG.WorkDesk.note).toMatch(/not an agent seat/i)
    expect(PROP_CATALOG.Bed.note).toMatch(/not an agent seat/i)
  })
})
