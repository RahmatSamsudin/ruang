import { describe, expect, it } from 'vitest'
import { AISLE_Z, BUILDING, DESKS, ENTRANCE_X, GAME_DOOR, GAME_LANE_Z, GAME_ROOM, IDLE_ROUTE, IDLE_STOPS, IDLE_STOP_MS, LOUNGE_LANE_X, LOUNGE_SEATS, MEETING_TABLE, PAN_BOUNDS, createLayout, idlePlan, meetingSeat, SIDE_LANE_X, SIDEWALK_Z, clampTarget, idleStop, placementFor, walkPath, walkPath3, FLOOR_HEIGHT, STAIRS, BALCONY, floorOf, withMovedSeats, bedSpot, type Vec3 } from './office3d-layout.ts'
import type { OfficeStation } from './types.ts'

const station = (overrides: Partial<OfficeStation>): OfficeStation => ({
  id: 'default', name: 'default', role: 'Hermes profile', room: 'Workspace', roomPosition: 'assigned-desk',
  state: 'Working', currentTask: '', recentActivity: '', activity: '', seat: 1, provenance: '', freshness: '', ...overrides,
})

describe('3D office placement', () => {
  it('puts working agents at their own desk, seated', () => {
    const placement = placementFor(station({ seat: 2, state: 'Working' }))
    expect(placement.position[0]).toBe(DESKS[1][0])
    expect(placement.position[2]).toBeLessThan(DESKS[1][2])
    expect(placement.seated).toBe(true)
  })

  it('walks collaborating agents to the meeting table and idle agents to the lounge', () => {
    expect(placementFor(station({ state: 'Collaborating', roomPosition: 'meeting-area', seat: 3 }), undefined, 2).position).toEqual(meetingSeat(2).position)
    expect(placementFor(station({ state: 'Idle', room: 'Lounge', roomPosition: 'lounge-seat-2', seat: 2 }))).toMatchObject({ position: LOUNGE_SEATS[1], seated: true })
  })

  it('keeps offline and unknown agents standing at their desk and clamps odd seats', () => {
    expect(placementFor(station({ state: 'Offline', roomPosition: 'offline-station', seat: 1 })).seated).toBe(false)
    expect(placementFor(station({ state: 'Unknown', roomPosition: 'neutral-presence', seat: 9 })).position[0]).toBe(DESKS[2][0])
  })
})

describe('3D office movement', () => {
  it('walks via the aisle instead of through desks', () => {
    expect(walkPath([-7.2, -4.25], [-2, -4.25])).toEqual([[-7.2, AISLE_Z], [-2, AISLE_Z], [-2, -4.25]])
    // Lounge spots are reached via the lounge lane, past the TV cabinet.
    expect(walkPath([-7.2, -4.25], [4, -3.55])).toEqual([[-7.2, AISLE_Z], [LOUNGE_LANE_X, AISLE_Z], [LOUNGE_LANE_X, -3.55], [4, -3.55]])
    expect(walkPath([1, 1], [1.1, 1.1])).toEqual([[1.1, 1.1]])
  })

  it('keeps the panned view inside the grounds', () => {
    expect(clampTarget(100, -100)).toEqual([PAN_BOUNDS.maxX, PAN_BOUNDS.minZ])
    expect(clampTarget(1, 2)).toEqual([1, 2])
  })
})

describe('idle agents', () => {
  it('leave and enter the building through the entrance', () => {
    const out = walkPath([4, -3.55], [-4, 6.3])
    expect(out).toContainEqual([ENTRANCE_X, AISLE_Z])
    expect(out).toContainEqual([ENTRANCE_X, SIDEWALK_Z])
    expect(out.at(-1)).toEqual([-4, 6.3])
    const back = walkPath([-4, 6.3], [8.35, -0.4])
    expect(back).toContainEqual([ENTRANCE_X, SIDEWALK_Z])
    expect(back.findIndex(([x, z]) => x === ENTRANCE_X && z === SIDEWALK_Z)).toBeLessThan(back.findIndex(([x, z]) => x === ENTRANCE_X && z === AISLE_Z))
    // Every waypoint outside is on the sidewalk side, never through the front wall.
    for (const [x, z] of out) if (z > BUILDING.maxZ - 0.3 && z < BUILDING.maxZ + 0.3) expect(x).toBe(ENTRANCE_X)
  })

  it('reach the street food in the gang by the side lane, not through the building wall', () => {
    const bakso = IDLE_STOPS.find((stop) => stop.key === 'bakso')!.spots[0].position
    const path = walkPath([8.35, -0.4], [bakso[0], bakso[2]])
    expect(path).toContainEqual([ENTRANCE_X, SIDEWALK_Z])
    expect(path).toContainEqual([SIDE_LANE_X, SIDEWALK_Z])
    expect(path).toContainEqual([SIDE_LANE_X, bakso[2]])
    for (const [x, z] of path) expect(x < BUILDING.minX || z > BUILDING.maxZ || (x === ENTRANCE_X) || z === AISLE_Z || x === 8.35).toBe(true)
    const kopi = IDLE_STOPS.find((stop) => stop.key === 'kopi')!.spots[1].position
    expect(walkPath([bakso[0], bakso[2]], [kopi[0], kopi[2]])).toEqual([[SIDE_LANE_X, bakso[2]], [SIDE_LANE_X, kopi[2]], [kopi[0], kopi[2]]])
    for (const stop of IDLE_STOPS.filter((item) => ['bakso', 'kopi'].includes(item.key))) for (const { position } of stop.spots) expect(position[0]).toBeLessThan(SIDE_LANE_X)
  })

  it('enter the game room through its door, not through the lounge wall', () => {
    for (const key of ['game', 'arcade']) {
      for (const { position } of IDLE_STOPS.find((stop) => stop.key === key)!.spots) {
        const path = walkPath([4, -1.8], [position[0], position[2]])
        // Every crossing of the wall line x = GAME_ROOM.minX happens inside the door.
        let previous: [number, number] = [4, -1.8]
        for (const point of path) {
          if ((previous[0] - GAME_ROOM.minX) * (point[0] - GAME_ROOM.minX) < 0) {
            expect(point[1]).toBe(previous[1])
            expect(point[1]).toBeGreaterThan(GAME_DOOR.fromZ)
            expect(point[1]).toBeLessThan(GAME_DOOR.toZ)
            expect(point[1]).toBe(GAME_LANE_Z)
          }
          previous = point
        }
        expect(path.at(-1)).toEqual([position[0], position[2]])
      }
    }
  })

  it('rotate between stops over time, each seat on its own spot', () => {
    const seen = new Set<string>()
    for (let step = 0; step < IDLE_ROUTE.length; step += 1) seen.add(idleStop(1, step * IDLE_STOP_MS).stop.key)
    expect(seen).toEqual(new Set(IDLE_STOPS.map((stop) => stop.key)))
    for (let step = 0; step < IDLE_ROUTE.length; step += 1) {
      const plan = idlePlan([1, 2, 3], step * IDLE_STOP_MS)
      const spots = [1, 2, 3].map((seat) => plan.get(seat)!.placement.position.join(','))
      expect(new Set(spots).size).toBe(3)
    }
    expect(idleStop(1, 5)).toEqual(idleStop(1, IDLE_STOP_MS - 1))
  })
})

describe('office for any crew size', () => {
  it('has one desk per agent and widens the building to the left only when needed', () => {
    expect(createLayout(3).desks).toHaveLength(3)
    expect(createLayout(3).building.minX).toBe(BUILDING.minX)
    expect(createLayout(6).building.minX).toBe(BUILDING.minX)
    const twelve = createLayout(12)
    expect(twelve.desks).toHaveLength(12)
    expect(twelve.building.minX).toBeLessThan(BUILDING.minX)
    expect(new Set(twelve.desks.map((desk) => desk.join(','))).size).toBe(12)
    for (const [x] of twelve.desks) expect(x).toBeGreaterThan(twelve.building.minX + 1)
    // Everything in the gang moves with the wall, and the camera backs off to fit.
    expect(twelve.sideLaneX).toBeLessThan(twelve.building.minX)
    expect(twelve.baksoCart[0]).toBeLessThan(twelve.sideLaneX)
    expect(Math.hypot(...twelve.camera.offset)).toBeGreaterThan(Math.hypot(...createLayout(3).camera.offset))
  })

  it('gives every agent at the meeting table its own place on the aisle side', () => {
    const seats = Array.from({ length: 10 }, (_, index) => meetingSeat(index).position.join(','))
    expect(new Set(seats).size).toBe(10)
    for (let index = 0; index < 10; index += 1) expect(meetingSeat(index).position[2]).toBeLessThanOrEqual(MEETING_TABLE[2] + 0.001)
  })

  it('never puts two idle agents on the same spot while free spots remain', () => {
    const layout = createLayout(12)
    const seats = Array.from({ length: 12 }, (_, index) => index + 1)
    for (let step = 0; step < IDLE_ROUTE.length; step += 1) {
      const plan = idlePlan(seats, step * IDLE_STOP_MS, layout)
      const spots = seats.map((seat) => plan.get(seat)!.placement.position.join(','))
      expect(new Set(spots).size).toBe(12)
    }
  })
})

describe('lantai 2', () => {
  it('has one bed per agent upstairs, above the desks, none sharing a place', () => {
    const layout = createLayout(10)
    expect(layout.beds).toHaveLength(10)
    expect(new Set(layout.beds.map((bed) => bed.join(','))).size).toBe(10)
    for (const [x, y] of layout.beds) {
      expect(y).toBe(FLOOR_HEIGHT)
      expect(x).toBeGreaterThan(layout.building.minX + 0.5)
    }
  })

  it('goes up and down by the stairs, climbing them in order', () => {
    const desk: Vec3 = [-4.6, 0, -2.75]
    const bed: Vec3 = [-4.6, FLOOR_HEIGHT, -3.15]
    const up = walkPath3(desk, bed)
    const foot = up.findIndex(([x, y]) => x === STAIRS.lowX && y === 0)
    const head = up.findIndex(([x, y]) => x === STAIRS.highX && y === FLOOR_HEIGHT)
    expect(foot).toBeGreaterThan(-1)
    expect(head).toBe(foot + 1)
    // Nothing floats: before the stairs every point is on the ground, after them upstairs.
    expect(up.slice(0, foot + 1).every(([, y]) => y === 0)).toBe(true)
    expect(up.slice(head).every(([, y]) => y === FLOOR_HEIGHT)).toBe(true)
    expect(up[up.length - 1]).toBe(bed)
    const down = walkPath3(bed, desk)
    expect(down.findIndex(([x, y]) => x === STAIRS.highX && y === FLOOR_HEIGHT)).toBe(down.findIndex(([x, y]) => x === STAIRS.lowX && y === 0) - 1)
    expect(floorOf(down[down.length - 1])).toBe(1)
  })

  it('reaches the balcony through its door and the back row of beds between the columns', () => {
    const layout = createLayout(6)
    const balcony: Vec3 = [0.6 - 0.85, FLOOR_HEIGHT, 5.5]
    const path = walkPath3([-3, FLOOR_HEIGHT, 0.4], balcony, layout)
    // The step onto the balcony goes straight through the sliding door (x 6.2 to 7.4).
    const out = path.findIndex(([, , z]) => z > BALCONY.minZ)
    for (const [x] of [path[out - 1], path[out]]) expect(x > 6.2 && x < 7.4).toBe(true)
    const backBed = layout.beds[0]
    const toBed = walkPath3([backBed[0], FLOOR_HEIGHT, 0.4], [backBed[0], FLOOR_HEIGHT, backBed[2] + 0.95], layout)
    for (const [x, , z] of toBed.slice(0, -1)) if (z < -0.6) expect(Math.abs(x - backBed[0])).toBeGreaterThan(0.6)
  })

  it('sends sleepers to bed first and keeps everyone else off their beds', () => {
    const seats = [1, 2, 3, 4, 5, 6]
    for (let step = 0; step < IDLE_ROUTE.length; step += 1) {
      const plan = idlePlan(seats, step * IDLE_STOP_MS, createLayout(6), [2, 5])
      for (const seat of [2, 5]) {
        expect(plan.get(seat)!.stop.key).toBe('tidur')
        expect(plan.get(seat)!.placement.pose).toBe('lie')
      }
      expect(new Set(seats.map((seat) => plan.get(seat)!.placement.position.join(','))).size).toBe(6)
    }
  })
})

describe('moved seats', () => {
  it('takes desk and bed positions from an edited scene and re-derives the bed stops', () => {
    const base = createLayout(3)
    const desks: Vec3[] = [[-1, 0, -1], [-2, 0, -2], [-3, 0, -3]]
    const beds: Vec3[] = [[-1, FLOOR_HEIGHT, -4], [-2, FLOOR_HEIGHT, -4], [-3, FLOOR_HEIGHT, -4]]
    const moved = withMovedSeats(base, desks, beds)
    expect(moved.desks).toEqual(desks)
    expect(moved.beds).toEqual(beds)
    expect(moved.idleStops.find((stop) => stop.key === 'tidur')!.spots[0]).toEqual(bedSpot(beds[0]))
    expect(moved.camera).toBe(base.camera)
    expect(moved.building).toBe(base.building)
  })

  it('lies the agent on the bed at the bed\'s own height', () => {
    expect(bedSpot([1, FLOOR_HEIGHT, 2]).position).toEqual([1, FLOOR_HEIGHT, 2.95])
    expect(bedSpot([1, 0, 2]).position).toEqual([1, 0, 2.95])
  })

  it('keeps the generated seats when the scene does not have one per agent', () => {
    const base = createLayout(3)
    const moved = withMovedSeats(base, [[0, 0, 0]], [])
    expect(moved.desks).toEqual(base.desks)
    expect(moved.beds).toEqual(base.beds)
  })
})
