import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@react-three/fiber', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@react-three/fiber')
  return {
    ...actual,
    useFrame: vi.fn(),
  }
})

import { FloorSelection, WallSelection, GlassSelection, SelectionFeedback } from './edit-layer.tsx'
import type { BoxItem, FloorItem, GlassItem, WallItem } from './scene.ts'

describe('Selection feedback components', () => {
  const dummyTarget = { current: null }

  it('renders perimeter border and corner brackets for FloorSelection', () => {
    const floor: FloorItem = {
      id: 'floor_1',
      kind: 'floor',
      level: 0,
      y: 0,
      min: [-5, -5],
      max: [5, 5],
      surface: { type: 'wood', repeat: [1, 1] },
      roughness: 0.5,
    }
    const html = renderToStaticMarkup(<FloorSelection item={floor}/>)
    expect(html).toContain('mesh')
    expect(html).toContain('boxGeometry')
    expect(html).toContain('#f5bd6d')
    expect(html).toContain('#f4d35e')
  })

  it('renders top edge highlight and helper for WallSelection', () => {
    const wall: WallItem = {
      id: 'wall_1',
      kind: 'wall',
      level: 0,
      y: 0,
      from: [0, 0],
      to: [4, 0],
      height: 2.8,
      view: 'both',
    }
    const html = renderToStaticMarkup(<WallSelection item={wall} target={dummyTarget}/>)
    expect(html).toContain('primitive')
    expect(html).toContain('#fde047')
  })

  it('renders primitive helper for GlassSelection', () => {
    const html = renderToStaticMarkup(<GlassSelection target={dummyTarget}/>)
    expect(html).toContain('primitive')
  })

  it('dispatches to appropriate selection feedback in SelectionFeedback', () => {
    const floor: FloorItem = {
      id: 'f1',
      kind: 'floor',
      level: 0,
      y: 0,
      min: [0, 0],
      max: [2, 2],
      surface: { type: 'tile', repeat: [1, 1] },
    }
    const wall: WallItem = {
      id: 'w1',
      kind: 'wall',
      level: 0,
      y: 0,
      from: [0, 0],
      to: [2, 0],
      height: 2.8,
      view: 'both',
    }
    const glass: GlassItem = {
      id: 'g1',
      kind: 'glass',
      level: 0,
      from: [0, 0],
      to: [2, 0],
      bottom: 0,
      top: 2.8,
    }
    const box: BoxItem = {
      id: 'b1',
      kind: 'box',
      level: 0,
      position: [0, 0, 0],
      size: [1, 1, 1],
      color: '#fff',
    }

    const floorHtml = renderToStaticMarkup(<SelectionFeedback item={floor} target={dummyTarget}/>)
    expect(floorHtml).toContain('#f4d35e')

    const wallHtml = renderToStaticMarkup(<SelectionFeedback item={wall} target={dummyTarget}/>)
    expect(wallHtml).toContain('#fde047')

    const glassHtml = renderToStaticMarkup(<SelectionFeedback item={glass} target={dummyTarget}/>)
    expect(glassHtml).toContain('primitive')

    const boxHtml = renderToStaticMarkup(<SelectionFeedback item={box} target={dummyTarget}/>)
    expect(boxHtml).toContain('primitive')
  })
})
