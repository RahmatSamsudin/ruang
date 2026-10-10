import { describe, expect, it } from 'vitest'
import { PROP_TYPES } from './scene.ts'
import { PROP_COMPONENTS } from './scene-renderer.tsx'

describe('scene renderer', () => {
  it('has a component for every prop type a scene may name', () => {
    expect(Object.keys(PROP_COMPONENTS).sort()).toEqual([...PROP_TYPES].sort())
    for (const component of Object.values(PROP_COMPONENTS)) expect(typeof component).toBe('function')
  })
})
