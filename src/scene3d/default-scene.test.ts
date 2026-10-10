import { describe, expect, it } from 'vitest'
import { COFFEE_TABLE, createLayout, FLOOR_HEIGHT, MEETING_TABLE, PING_PONG, SOFA, STAIRS, TV } from '../office3d-layout.ts'
import { defaultScene } from './default-scene.ts'
import { levelsOf, seatPositions, visibleAt, type SceneItem } from './scene.ts'

const byId = (items: SceneItem[], id: string) => items.find((item) => item.id === id)

describe('default scene', () => {
  for (const crew of [1, 3, 6, 12]) {
    describe(`for ${crew} agents`, () => {
      const layout = createLayout(crew)
      const items = defaultScene(layout)

      it('has unique ids and exactly the two stock levels', () => {
        expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
        expect(levelsOf(items)).toEqual([0, FLOOR_HEIGHT])
      })

      it('has one desk and one bed per agent where the layout puts them', () => {
        expect(seatPositions(items, 'desk')).toEqual(layout.desks)
        expect(seatPositions(items, 'bed')).toEqual(layout.beds)
      })

      it('is plain data: a JSON round trip changes nothing', () => {
        expect(JSON.parse(JSON.stringify(items))).toStrictEqual(items)
      })

      it('puts every wall, floor and prop inside finite coordinates', () => {
        for (const item of items) expect(JSON.stringify(item)).not.toMatch(/null|NaN|Infinity/)
      })
    })
  }

  // The stock office has no other source of truth now: these snapshots lock every wall, floor and prop number.
  it('matches the committed stock scene for 3 and 12 agents', () => {
    expect(defaultScene(createLayout(3))).toMatchSnapshot()
    expect(defaultScene(createLayout(12))).toMatchSnapshot()
  })

  it('keeps the stock furniture where the layout puts it', () => {
    const items = defaultScene(createLayout(3))
    expect(byId(items, 'sofa')).toMatchObject({ kind: 'prop', type: 'Sofa', position: SOFA, rotation: Math.PI, level: 0 })
    expect(byId(items, 'meeting-table')).toMatchObject({ type: 'MeetingTable', position: MEETING_TABLE })
    expect(byId(items, 'coffee-table')).toMatchObject({ type: 'CoffeeTable', position: COFFEE_TABLE })
    expect(byId(items, 'ping-pong')).toMatchObject({ type: 'PingPongTable', position: PING_PONG })
    expect(byId(items, 'stairs')).toMatchObject({ type: 'Staircase', position: [STAIRS.lowX, 0, STAIRS.z], view: 'both', props: { rise: FLOOR_HEIGHT, width: STAIRS.width } })
    expect(byId(items, 'tv-cabinet')).toMatchObject({ kind: 'box', position: [TV[0], 0.3, TV[2]] })
    expect(byId(items, 'bed-1')).toMatchObject({ type: 'Bed', level: FLOOR_HEIGHT, position: [createLayout(3).beds[0][0], FLOOR_HEIGHT, createLayout(3).beds[0][2]] })
    expect(byId(items, 'bakso-stall')).toMatchObject({ type: 'BaksoStall', position: createLayout(3).baksoCart, rotation: Math.PI / 2 })
  })

  it('draws the cut-away from lantai 1 and the closed shell plus lantai 2 from above', () => {
    const items = defaultScene(createLayout(3))
    const shown = (level: number) => new Set(items.filter((item) => visibleAt(item, level)).map((item) => item.id))
    const ground = shown(0)
    const above = shown(FLOOR_HEIGHT)
    // Lantai 1 as a cut-away: furniture, low front walls, desks; no beds, no roof.
    for (const id of ['sofa', 'desk-1', 'wall-front-a', 'floor-main', 'wall-back', 'stairs', 'tree-1']) expect(ground.has(id), id).toBe(true)
    for (const id of ['bed-1', 'wall-front-shell-a', 'game-roof', 'deck-1']) expect(ground.has(id), id).toBe(false)
    // Lantai 2 on top of the closed shell: no lantai 1 furniture or cut-away walls.
    for (const id of ['bed-1', 'deck-1', 'wall-front-shell-a', 'game-roof', 'wall-back', 'stairs', 'tree-1', 'lawn']) expect(above.has(id), id).toBe(true)
    for (const id of ['sofa', 'desk-1', 'wall-front-a', 'floor-main']) expect(above.has(id), id).toBe(false)
  })

  it('widens the building walls with the crew', () => {
    const wall = (crew: number) => byId(defaultScene(createLayout(crew)), 'wall-back') as Extract<SceneItem, { kind: 'wall' }>
    expect(wall(12).from[0]).toBeLessThan(wall(3).from[0])
  })
})
