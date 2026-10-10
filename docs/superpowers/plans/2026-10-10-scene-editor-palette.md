# Scene Editor 2b: Object Palette, Duplicate and Properties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Office 3D edit mode, let the user place any of the 38 object types from a palette, duplicate the selected object (button and Ctrl/Cmd+D), and edit an object's size/length/colour parameters.

**Architecture:** A catalogue (`prop-catalog.ts`) describes every object type (label, group, mounting height, default props, editable fields). Four pure operations in `scene-edit.ts` (`nextAddedId`, `addProp`, `duplicateItem`, `setItemProp`, plus `placePoint`) turn a `ScenePatch` into a new one, so undo/redo/save need no change. The editor hook gains a `placing` state and a generic `addWith` that applies an add as one undo step and selects the new item. A `PlacementLayer` inside the canvas draws a ghost that follows the pointer and turns a short click into a placement; `PropPalette` and an extended `ObjectPanel` are plain DOM. The server is unchanged.

**Tech Stack:** React 19, React Three Fiber 9, three 0.186, vitest (jsdom for components), TypeScript strict, eslint (react-hooks v5).

**Spec:** `docs/superpowers/specs/2026-10-10-scene-editor-palette-design.md` (binding). Predecessors: `docs/superpowers/specs/2026-10-10-scene-editor-core-design.md` and the code it produced (`src/scene3d/scene-edit.ts`, `use-scene-editor.ts`, `edit-layer.tsx`, `src/pages/ObjectPanel.tsx`, `EditorBar.tsx`, `Office3D.tsx`).

## Global Constraints

- Server unchanged; `API_VERSION` stays 14. `MAX_ADDED` is 500 (server `server/scene.ts` `MAX_ADDED`); the UI mirrors it in `src/scene3d/scene.ts` and a server test checks the two agree.
- Server `props` rule the UI must satisfy: at most 16 keys, key matches `/^[A-Za-z]{1,24}$/`, value is a finite number with `|n| ≤ 100`, a boolean, or a string of at most 64 chars. Colours are `#rrggbb`. Every position number is finite with `|n| ≤ 1000`.
- Ids of added items: `added-<n>`; ids `desk-N` / `bed-N` are reserved (server rejects them in `added`).
- Grid step 0.25 m (`GRID`), duplicate offset 0.5 m, click-vs-drag threshold 4 px, palette collapsed below 1000 px viewport width, editor UI hidden at ≤700 px (existing `editingActive`).
- UI text is English. Code style: no semicolons, single quotes, 2-space indent, comment density like the surrounding files (comments explain why, short).
- Every edit is a pure `ScenePatch → ScenePatch` function; nothing mutates a patch.
- Run from the repo root of the worktree. Verification commands: `npx tsc -b`, `npm run lint`, `npm test`. A pre-existing flaky test in `server/skin-library.test.ts` ("auto-archives skins generated via Flow/BLOCK provider") may fail intermittently; rerun once and report it, do not touch it.

## Review Focus

Input classes the spec implies but the obvious tests would miss, most likely first:

1. **The 500-object limit:** the 500th placement works, the 501st is refused with a visible reason, in both Place and Duplicate (Task 2 tests `addProp`/`duplicateItem` at the limit; Task 4 palette/panel tests the disabled states).
2. **Ids never collide:** after deleting an added item or undoing, a new item must not reuse an id that a saved override or stock item still uses (Task 2 `nextAddedId` tests include override keys of deleted stock items).
3. **Duplicating odd originals:** an off-bounds stock tree, an item at the bounds edge, a window, an item with `view: 'both'`, a stock item that has an override (the copy takes the *drawn* values and the original's override must not follow the copy) (Task 2 tests).
4. **Camera vs placing:** a left-drag must orbit (not place), a right-drag must pan (not exit), a short click places, Esc/right-click/clicking the active palette entry exits (Task 5 browser pass).
5. **Typing in the palette search** must not trigger R / Delete / Ctrl+D shortcuts (existing `typing` guard in `Office3D` key handler; Task 5 browser pass).

---

### Task 1: Catalogue and the `MAX_ADDED` constant

**Files:**
- Create: `src/scene3d/prop-catalog.ts`
- Create: `src/scene3d/prop-catalog.test.ts`
- Modify: `src/scene3d/scene.ts` (add `MAX_ADDED` after `PROP_TYPES`)
- Modify: `server/scene.test.ts` (mirror test)

**Interfaces:**
- Consumes: `PROP_TYPES`, `PropType`, `PropValue` from `src/scene3d/scene.ts`.
- Produces:
  - `scene.ts`: `export const MAX_ADDED = 500`.
  - `prop-catalog.ts`: `type PropGroup`, `GROUPS: readonly PropGroup[]`, `type Field`, `interface PropEntry { label: string; group: PropGroup; y: number; note?: string; defaults?: Record<string, PropValue>; fields?: Field[] }`, `PROP_CATALOG: Record<PropType, PropEntry>`.

- [ ] **Step 1: Add `MAX_ADDED` to `src/scene3d/scene.ts`**

Insert directly after the line `export type PropValue = number | string | boolean`:

```ts
/** The most items a saved patch may add. server/scene.ts keeps the same number; its test checks they match. */
export const MAX_ADDED = 500
```

- [ ] **Step 2: Write the failing catalogue test** — `src/scene3d/prop-catalog.test.ts`

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run src/scene3d/prop-catalog.test.ts`
Expected: FAIL (module `./prop-catalog.ts` not found).

- [ ] **Step 4: Write the catalogue** — `src/scene3d/prop-catalog.ts`

```ts
import type { PropType, PropValue } from './scene.ts'

// What the editor knows about each object type: how it is listed in the palette, how high a new one
// is mounted, which props its component needs (and cannot default itself), and which of them the
// object panel lets you edit. Typed as a Record so a new PropType without an entry fails to compile.

export const GROUPS = ['Furniture', 'Kitchen', 'Leisure', 'Bedroom', 'Outdoor', 'Structure'] as const
export type PropGroup = typeof GROUPS[number]

export type Field =
  | { key: string; label: string; kind: 'number'; min: number; max: number; step: number }
  | { key: string; label: string; kind: 'color' }

export interface PropEntry {
  label: string
  group: PropGroup
  /** Height above the floor level a new one is placed at (0, or the wall/ceiling height the stock scene uses). */
  y: number
  /** Shown as the palette tooltip. */
  note?: string
  /** Props copied into a new item, so what is saved is what is drawn. */
  defaults?: Record<string, PropValue>
  fields?: Field[]
}

const number = (key: string, label: string, min: number, max: number, step: number): Field => ({ key, label, kind: 'number', min, max, step })
const size = (min: number, max: number): Field => number('size', 'Size', min, max, 0.1)
const length = (max: number): Field => number('length', 'Length (m)', 0.5, max, 0.25)
const color: Field = { key: 'color', label: 'Color', kind: 'color' }
const SEAT_NOTE = 'Decoration, not an agent seat'

export const PROP_CATALOG: Record<PropType, PropEntry> = {
  AcOutdoorUnit: { label: 'Outdoor AC unit', group: 'Outdoor', y: 0 },
  AirConditioner: { label: 'Air conditioner', group: 'Structure', y: 2.3 },
  ArcadeCabinet: { label: 'Arcade cabinet', group: 'Leisure', y: 0, defaults: { color: '#c62828' }, fields: [color] },
  Armchair: { label: 'Armchair', group: 'Furniture', y: 0, defaults: { color: '#d9784a' }, fields: [color] },
  BaksoStall: { label: 'Bakso stall', group: 'Outdoor', y: 0 },
  BathroomFittings: { label: 'Bathroom fittings', group: 'Bedroom', y: 0 },
  Beanbag: { label: 'Beanbag', group: 'Leisure', y: 0, defaults: { color: '#e76f51' }, fields: [color] },
  Bed: { label: 'Bed', group: 'Bedroom', y: 0, note: SEAT_NOTE, defaults: { color: '#3d7fd6' }, fields: [color] },
  Bookshelf: { label: 'Bookshelf', group: 'Furniture', y: 0 },
  CarromTable: { label: 'Carrom table', group: 'Leisure', y: 0 },
  ClothesLine: { label: 'Clothes line', group: 'Outdoor', y: 0, defaults: { length: 2.4 }, fields: [length(6)] },
  CoffeeTable: { label: 'Coffee table', group: 'Furniture', y: 0 },
  FlagPole: { label: 'Flag pole', group: 'Outdoor', y: 0 },
  FloorCushion: { label: 'Floor cushion', group: 'Leisure', y: 0, defaults: { color: '#e9c46a' }, fields: [color] },
  Fridge: { label: 'Fridge', group: 'Kitchen', y: 0 },
  GalonDispenser: { label: 'Water dispenser', group: 'Kitchen', y: 0 },
  Hammock: { label: 'Hammock', group: 'Leisure', y: 0 },
  KopiStall: { label: 'Kopi stall', group: 'Outdoor', y: 0 },
  LowTable: { label: 'Low table', group: 'Furniture', y: 0 },
  MeetingTable: { label: 'Meeting table', group: 'Furniture', y: 0 },
  Nightstand: { label: 'Nightstand', group: 'Bedroom', y: 0 },
  OfficeLight: { label: 'Ceiling light', group: 'Structure', y: 2.4 },
  PantryCounter: { label: 'Pantry counter', group: 'Kitchen', y: 0 },
  PingPongTable: { label: 'Ping-pong table', group: 'Leisure', y: 0 },
  Plant: { label: 'Plant', group: 'Furniture', y: 0, defaults: { size: 1 }, fields: [size(0.4, 2.5)] },
  Railing: { label: 'Railing', group: 'Structure', y: 0, defaults: { length: 2 }, fields: [length(20)] },
  RattanChair: { label: 'Rattan chair', group: 'Furniture', y: 0 },
  SideTable: { label: 'Side table', group: 'Furniture', y: 0 },
  Sofa: { label: 'Sofa', group: 'Furniture', y: 0, defaults: { color: '#5b6f8c' }, fields: [color] },
  Staircase: {
    label: 'Staircase', group: 'Structure', y: 0, defaults: { run: 3, rise: 2.8, width: 0.9 },
    fields: [number('run', 'Run (m, − flips)', -20, 20, 0.25), number('rise', 'Rise (m)', 0.5, 6, 0.1), number('width', 'Width (m)', 0.5, 4, 0.1)],
  },
  StreetLamp: { label: 'Street lamp', group: 'Outdoor', y: 0 },
  StringLights: { label: 'String lights', group: 'Structure', y: 2.15, defaults: { length: 3 }, fields: [length(20)] },
  Television: { label: 'Television', group: 'Leisure', y: 1.35 },
  Tree: { label: 'Tree', group: 'Outdoor', y: 0, defaults: { size: 1 }, fields: [size(0.5, 3)] },
  WallClock: { label: 'Wall clock', group: 'Structure', y: 2.35 },
  Wardrobe: { label: 'Wardrobe', group: 'Bedroom', y: 0 },
  WaterTank: { label: 'Water tank', group: 'Outdoor', y: 0 },
  WorkDesk: { label: 'Work desk', group: 'Furniture', y: 0, note: SEAT_NOTE },
}
```

- [ ] **Step 5: Add the server mirror test** — in `server/scene.test.ts`, add `MAX_ADDED` to the existing import from `./scene.js` (`import { installScene, MAX_ADDED, MAX_OVERRIDES, ... } from './scene.js'`) and add this test inside the same `describe` that holds `keeps its prop type list in step with the UI` (right after it):

```ts
  it('keeps its added-item limit in step with the UI', async () => {
    const source = await readFile(new URL('../src/scene3d/scene.ts', import.meta.url), 'utf8')
    const match = /export const MAX_ADDED = (\d+)/.exec(source)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBe(MAX_ADDED)
  })
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/scene3d/prop-catalog.test.ts server/scene.test.ts`
Expected: PASS (all). Then `npx tsc -b` and `npm run lint`: clean.

- [ ] **Step 7: Commit**

```bash
git add src/scene3d/prop-catalog.ts src/scene3d/prop-catalog.test.ts src/scene3d/scene.ts server/scene.test.ts
git commit -m "feat(editor): object catalogue for the palette"
```

---

### Task 2: Pure operations for adding, duplicating and editing props

**Files:**
- Modify: `src/scene3d/scene-edit.ts`
- Modify: `src/scene3d/scene-edit.test.ts`

**Interfaces:**
- Consumes: `PROP_CATALOG` (Task 1); `MAX_ADDED`, `PropItem`, `PropType`, `PropValue`, `SceneItem`, `ScenePatch` from `./scene.ts`; existing `Bounds`, `EditableItem`, `snap`, `round4`, `clamp`, `clampAround`, `patchItem` inside `scene-edit.ts`.
- Produces (all exported from `scene-edit.ts`):
  - `DUPLICATE_OFFSET = 0.5`
  - `interface AddResult { patch: ScenePatch; id: string | null }` (`id` is null when nothing was added)
  - `nextAddedId(patch: ScenePatch, items: SceneItem[]): string`
  - `placePoint(point: [number, number], free: boolean, bounds: Bounds): [number, number]`
  - `addProp(patch: ScenePatch, items: SceneItem[], type: PropType, x: number, z: number, level: number, bounds: Bounds): AddResult`
  - `duplicateItem(patch: ScenePatch, items: SceneItem[], item: EditableItem, bounds: Bounds): AddResult`
  - `setItemProp(patch: ScenePatch, item: EditableItem, key: string, value: PropValue): ScenePatch`
  - `EditKeyAction` gains `'duplicate'`; `editKeyAction` returns it for Ctrl/Cmd+D.

`items` is the scene as drawn now (`applyPatch(defaultScene(layout), patch)`); it only supplies the ids already in use.

- [ ] **Step 1: Add the failing tests** — append to `src/scene3d/scene-edit.test.ts`. First extend the imports at the top of the file:

```ts
import { addProp, canDelete, deleteItem, dragTarget, duplicateItem, editKeyAction, GRID, isEditable, moveItem, nextAddedId, placePoint, ROTATION_STEP, rotateBy, rotateItem, setItemLevel, setItemProp, snap } from './scene-edit.ts'
import { MAX_ADDED } from './scene.ts'
```

(the existing import line from `./scene-edit.ts` is replaced by the one above; keep the other imports.) Then append at the end of the file:

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/scene3d/scene-edit.test.ts`
Expected: FAIL (the new exports do not exist).

- [ ] **Step 3: Implement** — in `src/scene3d/scene-edit.ts`:

Replace the first import line with:

```ts
import { PROP_CATALOG } from './prop-catalog.ts'
import { isSeatId, MAX_ADDED, type PropItem, type PropType, type PropValue, type SceneItem, type ScenePatch, type WindowItem } from './scene.ts'
```

Add after the `setItemLevel` function:

```ts
export const DUPLICATE_OFFSET = 0.5

/** The result of an operation that adds an item: `id` is null when nothing was added (limit reached). */
export interface AddResult { patch: ScenePatch; id: string | null }

/** `added-<n>` with the smallest n that no stock item, added item or override refers to. `items` is the scene as drawn. */
export function nextAddedId(patch: ScenePatch, items: SceneItem[]): string {
  const used = new Set<string>([...items.map((item) => item.id), ...patch.added.map((item) => item.id), ...Object.keys(patch.overrides)])
  let n = 1
  while (used.has(`added-${n}`)) n += 1
  return `added-${n}`
}

/** Where a new object lands for a pointer on the floor: grid-snapped (free with Alt) and clamped to the bounds. */
export function placePoint(point: [number, number], free: boolean, bounds: Bounds): [number, number] {
  const pick = (value: number, min: number, max: number) => round4(clamp(free ? value : snap(value), min, max))
  return [pick(point[0], bounds.minX, bounds.maxX), pick(point[1], bounds.minZ, bounds.maxZ)]
}

/** A new prop of `type` on `level`, mounted at the catalogue height with the catalogue defaults. */
export function addProp(patch: ScenePatch, items: SceneItem[], type: PropType, x: number, z: number, level: number, bounds: Bounds): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const entry = PROP_CATALOG[type]
  const [px, pz] = placePoint([x, z], true, bounds)
  const id = nextAddedId(patch, items)
  const item: PropItem = { kind: 'prop', id, type, level, position: [px, round4(level + entry.y), pz], ...(entry.defaults ? { props: { ...entry.defaults } } : {}) }
  return { patch: { ...patch, added: [...patch.added, item] }, id }
}

/** A copy of an editable item as drawn now, half a metre over; the bounds are widened to include the original so items outside them (trees) can be copied. */
export function duplicateItem(patch: ScenePatch, items: SceneItem[], item: EditableItem, bounds: Bounds): AddResult {
  if (patch.added.length >= MAX_ADDED) return { patch, id: null }
  const id = nextAddedId(patch, items)
  const [x, y, z] = item.position
  const copy = {
    ...item,
    id,
    position: [round4(clampAround(x + DUPLICATE_OFFSET, bounds.minX, bounds.maxX, x)), y, round4(clampAround(z + DUPLICATE_OFFSET, bounds.minZ, bounds.maxZ, z))],
    ...(item.kind === 'prop' && item.props ? { props: { ...item.props } } : {}),
  } as EditableItem
  return { patch: { ...patch, added: [...patch.added, copy] }, id }
}

/** Sets one prop (size, length, colour...) of a prop item. The whole props object is written, so a stock item's override replaces its props with the edited copy. */
export function setItemProp(patch: ScenePatch, item: EditableItem, key: string, value: PropValue): ScenePatch {
  if (item.kind !== 'prop' || item.props?.[key] === value) return patch
  return patchItem(patch, item.id, { props: { ...item.props, [key]: value } })
}
```

Change the `EditKeyAction` type and `editKeyAction`:

```ts
export type EditKeyAction = 'undo' | 'redo' | 'delete' | 'rotate+' | 'rotate-' | 'deselect' | 'duplicate'
```

and inside `editKeyAction`, in the `if (event.ctrlKey || event.metaKey)` block add before the final `return`:

```ts
    if (key === 'd') return 'duplicate'
```

so the block reads:

```ts
  if (event.ctrlKey || event.metaKey) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
    if (key === 'd') return 'duplicate'
    return key === 'y' ? 'redo' : null
  }
```

Also update the stale doc comment on `EditableItem`: replace `Structure waits for the 2b handles.` with `Structure waits for the floors-and-walls sub-project (2c).`

- [ ] **Step 4: Run tests, types, lint**

Run: `npx vitest run src/scene3d/scene-edit.test.ts` → PASS. `npx tsc -b` and `npm run lint` → clean. If `window1`/`lamp`/`sofa`/`bounds`/`deepFreeze` names differ in the test file, use the ones already defined at its top (they are: `sofa`, `lamp`, `bed`, `desk`, `window1`, `box`, `bounds`, `deepFreeze`).

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/scene-edit.ts src/scene3d/scene-edit.test.ts
git commit -m "feat(editor): pure operations to add, duplicate and edit props"
```

---

### Task 3: Placing state and `addWith` in the editor hook

**Files:**
- Modify: `src/scene3d/use-scene-editor.ts`
- Modify: `src/scene3d/use-scene-editor.test.tsx`

**Interfaces:**
- Consumes: `PropType` from `./scene.ts`; `AddResult` from `./scene-edit.ts`.
- Produces on `SceneEditor`:
  - `placing: PropType | null`
  - `startPlacing(type: PropType): void` (also deselects)
  - `stopPlacing(): void`
  - `addWith(make: (patch: ScenePatch) => AddResult): void` — applies an add as one undo step and selects the new id; does nothing when `id` is null or the patch is unchanged.
  - `placing` is cleared by `enter`, `exit`, successful `reset`, `undo` and `redo`.

- [ ] **Step 1: Add the failing tests** — in `src/scene3d/use-scene-editor.test.tsx`, append a new `describe` (use the existing `mount`, `json` helpers and `edit`):

```tsx
describe('placing and adding', () => {
  const item = { kind: 'prop' as const, id: 'added-1', type: 'Plant' as const, level: 0, position: [1, 0, 1] as [number, number, number] }
  const addOne = (patch: ScenePatch) => ({ patch: { ...patch, added: [...patch.added, item] }, id: 'added-1' as string | null })

  it('startPlacing deselects and stopPlacing clears the mode', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.select('sofa'))
    await run((e) => e.startPlacing('Sofa'))
    expect(editor().placing).toBe('Sofa')
    expect(editor().selectedId).toBeNull()
    await run((e) => e.stopPlacing())
    expect(editor().placing).toBeNull()
  })

  it('addWith adds as one undo step and selects the new item, staying in placing mode', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.startPlacing('Plant'))
    await run((e) => e.addWith(addOne))
    expect(editor().draft.added).toEqual([item])
    expect(editor().selectedId).toBe('added-1')
    expect(editor().placing).toBe('Plant')
    expect(editor().dirty).toBe(true)
    await run((e) => e.undo())
    expect(editor().draft.added).toEqual([])
    expect(editor().canUndo).toBe(false)
    expect(editor().placing).toBeNull()
  })

  it('addWith ignores a result without an id', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.addWith((patch) => ({ patch, id: null })))
    expect(editor().canUndo).toBe(false)
    expect(editor().selectedId).toBeNull()
  })

  it('leaves placing mode on redo, Done and reset', async () => {
    const { editor, run, request } = await mount(vi.fn(async () => json({ ok: true })))
    await run((e) => e.enter())
    await run((e) => e.addWith(addOne))
    await run((e) => e.undo())
    await run((e) => e.startPlacing('Sofa'))
    await run((e) => e.redo())
    expect(editor().placing).toBeNull()
    await run((e) => e.startPlacing('Sofa'))
    await run((e) => e.exit())
    expect(editor().placing).toBeNull()
    await run((e) => e.enter())
    await run((e) => e.startPlacing('Sofa'))
    await run((e) => e.reset())
    expect(request).toHaveBeenCalled()
    expect(editor().placing).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/scene3d/use-scene-editor.test.tsx`
Expected: FAIL (`startPlacing is not a function`).

- [ ] **Step 3: Implement** — in `src/scene3d/use-scene-editor.ts`:

1. Imports: `import { EMPTY_PATCH, type PropType, type ScenePatch } from './scene.ts'` and `import type { AddResult } from './scene-edit.ts'`.
2. `State`: add `placing: PropType | null` after `drag`. `fresh`: add `placing: null` (the object literal in `fresh` becomes `{ editing: false, draft: patch, baseline: patch, past: [], future: [], selectedId: null, drag: null, placing: null, saving: false, error: null }`).
3. `SceneEditor` interface: add

```ts
  placing: PropType | null
```
after `drag`, and after `redo: () => void` add:

```ts
  startPlacing: (type: PropType) => void
  stopPlacing: () => void
  /** Applies an add (place or duplicate) as one undo step and selects the new item. */
  addWith: (make: (patch: ScenePatch) => AddResult) => void
```
4. Implementations (after `select`):

```ts
  const startPlacing = useCallback((type: PropType) => setState((s) => ({ ...s, placing: type, selectedId: null })), [])
  const stopPlacing = useCallback(() => setState((s) => (s.placing ? { ...s, placing: null } : s)), [])
  const addWith = useCallback((make: (patch: ScenePatch) => AddResult) => setState((s) => {
    const { patch, id } = make(s.draft)
    if (id === null || patch === s.draft) return s
    return { ...s, draft: patch, past: [...s.past, s.draft].slice(-MAX_HISTORY), future: [], selectedId: id, error: null }
  }), [])
```
5. `undo` and `redo`: add `placing: null` to the returned state in each (inside the object spread: `{ ...s, draft: ..., past: ..., future: ..., placing: null }`).
6. Return object: add `placing: state.placing`, and `startPlacing, stopPlacing, addWith` to the list.

`exit`, `enter` and `reset` already rebuild state with `fresh(...)`, which clears `placing`.

- [ ] **Step 4: Run tests, types, lint**

Run: `npx vitest run src/scene3d/use-scene-editor.test.tsx` → PASS. `npx tsc -b`, `npm run lint` → clean (`Office3D` still compiles: it only reads the interface).

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/use-scene-editor.ts src/scene3d/use-scene-editor.test.tsx
git commit -m "feat(editor): placing mode and one-step add in the editing session"
```

---

### Task 4: Palette component and the extended object panel

**Files:**
- Create: `src/pages/PropPalette.tsx`
- Create: `src/pages/PropPalette.test.tsx`
- Modify: `src/pages/ObjectPanel.tsx`
- Modify: `src/pages/ObjectPanel.test.tsx`
- Modify: `src/styles.css` (append rules)

**Interfaces:**
- Consumes: `PROP_CATALOG`, `GROUPS`, `Field` (Task 1); `MAX_ADDED`, `PropType` from `../scene3d/scene.ts`; existing `ObjectPanel` internals.
- Produces:
  - `PropPalette({ placing, limitReached, onPick }: { placing: PropType | null; limitReached: boolean; onPick: (type: PropType | null) => void })` — `onPick(type)` to start/switch placing, `onPick(null)` when the active entry is clicked again.
  - `ObjectPanelProps` gains `canDuplicate: boolean`, `onDuplicate: () => void`, `onProp: (key: string, value: number | string) => void`.

- [ ] **Step 1: Write the failing palette test** — `src/pages/PropPalette.test.tsx`

```tsx
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROP_TYPES } from '../scene3d/scene.ts'
import { PropPalette } from './PropPalette.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.replaceChildren() })

async function mount(props: { placing?: Parameters<typeof PropPalette>[0]['placing']; limitReached?: boolean } = {}) {
  const onPick = vi.fn()
  const host = document.body.appendChild(document.createElement('div'))
  await act(async () => { createRoot(host).render(<PropPalette placing={props.placing ?? null} limitReached={props.limitReached ?? false} onPick={onPick}/>) })
  const buttons = () => [...host.querySelectorAll('.office-3d-palette-list button')] as HTMLButtonElement[]
  const button = (label: string) => buttons().find((node) => node.textContent === label)!
  return { host, onPick, buttons, button }
}

describe('PropPalette', () => {
  it('lists every object type once, in groups', async () => {
    const { host, buttons } = await mount()
    expect(buttons()).toHaveLength(PROP_TYPES.length)
    expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['Furniture', 'Kitchen', 'Leisure', 'Bedroom', 'Outdoor', 'Structure'])
  })

  it('picks a type, and clicking the active one leaves placing', async () => {
    const { button, onPick } = await mount()
    await act(async () => { button('Sofa').click() })
    expect(onPick).toHaveBeenLastCalledWith('Sofa')
    const second = await mount({ placing: 'Sofa' })
    expect(second.button('Sofa').getAttribute('aria-pressed')).toBe('true')
    expect(second.button('Plant').getAttribute('aria-pressed')).toBe('false')
    await act(async () => { second.button('Sofa').click() })
    expect(second.onPick).toHaveBeenLastCalledWith(null)
  })

  it('filters by name or type as you type, and hides empty groups', async () => {
    const { host, buttons } = await mount()
    const search = host.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'rail')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttons().map((node) => node.textContent)).toEqual(['Railing'])
    expect([...host.querySelectorAll('h4')].map((node) => node.textContent)).toEqual(['Structure'])
  })

  it('explains the limit and disables everything but the active entry', async () => {
    const { host, buttons } = await mount({ limitReached: true, placing: 'Plant' })
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/limit reached/i)
    const enabled = buttons().filter((node) => !node.disabled).map((node) => node.textContent)
    expect(enabled).toEqual(['Plant'])
  })

  it('marks desks and beds as decoration in their tooltip', async () => {
    const { button } = await mount()
    expect(button('Work desk').title).toMatch(/not an agent seat/i)
    expect(button('Sofa').title).toBe('')
  })

  it('can be collapsed to its header', async () => {
    const { host, buttons } = await mount()
    const head = host.querySelector('.office-3d-palette-head') as HTMLButtonElement
    await act(async () => { head.click() })
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(buttons()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/pages/PropPalette.test.tsx` → FAIL (module missing).

- [ ] **Step 3: Write the palette** — `src/pages/PropPalette.tsx`

```tsx
import { useMemo, useState } from 'react'
import { GROUPS, PROP_CATALOG } from '../scene3d/prop-catalog.ts'
import { MAX_ADDED, PROP_TYPES, type PropType } from '../scene3d/scene.ts'

export interface PropPaletteProps {
  placing: PropType | null
  limitReached: boolean
  /** A type to start (or switch) placing it; null when the active entry is clicked again. */
  onPick: (type: PropType | null) => void
}

/** The list of objects that can be placed, grouped, searchable and collapsible. Starts collapsed on narrow-ish screens so it does not crowd the view. */
export function PropPalette({ placing, limitReached, onPick }: PropPaletteProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1000)
  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (type: PropType) => needle === '' || PROP_CATALOG[type].label.toLowerCase().includes(needle) || type.toLowerCase().includes(needle)
    return GROUPS.map((group) => ({
      group,
      types: PROP_TYPES.filter((type) => PROP_CATALOG[type].group === group && matches(type)).sort((a, b) => PROP_CATALOG[a].label.localeCompare(PROP_CATALOG[b].label)),
    })).filter((section) => section.types.length > 0)
  }, [query])
  return <aside className="office-3d-palette" aria-label="Object palette">
    <button type="button" className="office-3d-palette-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '▾' : '▸'} Objects</button>
    {open && <>
      <input type="search" placeholder="Search objects" aria-label="Search objects" value={query} onChange={(event) => setQuery(event.target.value)}/>
      {limitReached ? <p role="status" className="office-3d-palette-note">Limit reached ({MAX_ADDED} added objects)</p> : <p className="office-3d-palette-note">Click the floor to place, Esc to stop.</p>}
      <div className="office-3d-palette-list">
        {sections.map(({ group, types }) => <section key={group}>
          <h4>{group}</h4>
          {types.map((type) => <button type="button" key={type} aria-pressed={placing === type} disabled={limitReached && placing !== type} title={PROP_CATALOG[type].note ?? ''} onClick={() => onPick(placing === type ? null : type)}>{PROP_CATALOG[type].label}</button>)}
        </section>)}
      </div>
    </>}
  </aside>
}
```

- [ ] **Step 4: Run the palette tests**

Run: `npx vitest run src/pages/PropPalette.test.tsx` → PASS.

- [ ] **Step 5: Add failing object-panel tests** — in `src/pages/ObjectPanel.test.tsx`:

1. In `mount`, extend the handlers and the render call:

```tsx
async function mount(item: PropItem | WindowItem, canDuplicate = true) {
  const handlers = { onMove: vi.fn(), onRotate: vi.fn(), onLevel: vi.fn(), onDelete: vi.fn(), onDuplicate: vi.fn(), onProp: vi.fn() }
  const host = document.body.appendChild(document.createElement('div'))
  await act(async () => { createRoot(host).render(<ObjectPanel item={item} levels={[0, 2.8]} canDuplicate={canDuplicate} {...handlers}/>) })
```
(keep the rest of `mount`: `input`, `type`, return) and change the import to `import type { PropItem, WindowItem } from '../scene3d/scene.ts'`. Existing tests call `mount(sofa)` and keep working.

2. Append tests:

```tsx
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

  it('has no property fields for a window or a type without any', async () => {
    const { host } = await mount({ kind: 'window', id: 'w1', level: 0, position: [0, 1.5, 0] })
    expect(host.querySelector('input[type="color"]')).toBeNull()
    expect(host.querySelectorAll('input[type="number"]')).toHaveLength(3)
  })
})
```

Note the `input(label)` helper finds a `<label>` whose text starts with the label; the new rows must therefore render as `<label>Text<input/></label>` like the existing ones.

- [ ] **Step 6: Run to see them fail**

Run: `npx vitest run src/pages/ObjectPanel.test.tsx` → FAIL (new props/rows missing).

- [ ] **Step 7: Extend `src/pages/ObjectPanel.tsx`**

1. Imports: `import { useEffect, useRef } from 'react'`, `import { PROP_CATALOG, type Field } from '../scene3d/prop-catalog.ts'`.
2. Add (after `NumberField`):

```tsx
/** A colour picker that commits when the picker closes (the native `change`), so dragging through colours is one undo step. */
function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit
  useEffect(() => {
    const node = input.current
    if (!node) return
    const onChange = () => commit.current(node.value)
    node.addEventListener('change', onChange)
    return () => node.removeEventListener('change', onChange)
  }, [])
  return <label>{label}<input type="color" ref={input} defaultValue={value} key={value}/></label>
}

const HEX = /^#[0-9a-fA-F]{6}$/

function PropFields({ item, onProp }: { item: EditableItem; onProp: (key: string, value: number | string) => void }) {
  if (item.kind !== 'prop') return null
  const entry = PROP_CATALOG[item.type]
  const field = (spec: Field) => {
    const current = item.props?.[spec.key] ?? entry.defaults?.[spec.key]
    if (spec.kind === 'color') return <ColorField key={spec.key} label={spec.label} value={typeof current === 'string' && HEX.test(current) ? current : '#888888'} onCommit={(value) => onProp(spec.key, value)}/>
    return <NumberField key={spec.key} id={`${item.id}:${spec.key}`} label={spec.label} value={typeof current === 'number' ? current : spec.min} step={spec.step} onCommit={(next) => onProp(spec.key, Math.min(Math.max(next, spec.min), spec.max))}/>
  }
  return <>{(entry.fields ?? []).map(field)}</>
}
```

3. `ObjectPanelProps`: add

```ts
  canDuplicate: boolean
  onDuplicate: () => void
  onProp: (key: string, value: number | string) => void
```
4. Destructure them in `ObjectPanel({ item, levels, canDuplicate, onMove, onRotate, onLevel, onDuplicate, onProp, onDelete })`. After the `Floor` label and before the Delete button render the fields and the buttons:

```tsx
    <PropFields item={item} onProp={onProp}/>
    <div className="office-3d-objpanel-actions">
      <button type="button" disabled={!canDuplicate} title={canDuplicate ? 'Duplicate (Ctrl/Cmd+D)' : 'Limit reached (500 added objects)'} onClick={onDuplicate}>Duplicate</button>
      <button type="button" className="danger" disabled={!deletable} title={deletable ? 'Delete (Del)' : 'Desks and beds follow the number of agents'} onClick={onDelete}>Delete</button>
    </div>
```
and remove the old standalone Delete button. Update the doc comment to "Position, rotation, floor, properties, duplicate and delete for the selected object."

- [ ] **Step 8: CSS** — append to `src/styles.css` (after the last editor rules, before or after the `@media (max-width: 700px)` editor line; then extend that media rule's selector list with `.office-3d-palette`):

```css
.office-3d-palette { background: rgba(18, 26, 24, 0.86); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 8px; color: #f4efe6; display: grid; font-size: 12px; gap: 6px; grid-template-rows: auto; left: 10px; max-height: calc(100% - 170px); overflow: hidden; padding: 8px; position: absolute; top: 150px; width: 210px; z-index: 3; }
.office-stage .office-3d-palette { max-height: calc(100% - 300px); top: 230px; }
.office-3d-palette-head { background: transparent; border: 0; color: inherit; cursor: pointer; font: inherit; font-weight: 600; padding: 0; text-align: left; }
.office-3d-palette input[type="search"] { background: #101815; border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 4px; color: #f4efe6; font: inherit; padding: 3px 5px; width: 100%; }
.office-3d-palette-note { color: #b7c9bf; margin: 0; }
.office-3d-palette-list { display: grid; gap: 4px; overflow-y: auto; }
.office-3d-palette-list h4 { color: #b7c9bf; font-size: 11px; letter-spacing: .05em; margin: 6px 0 2px; text-transform: uppercase; }
.office-3d-palette-list section { display: flex; flex-wrap: wrap; gap: 4px; }
.office-3d-palette-list section h4 { flex-basis: 100%; }
.office-3d-palette-list button { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 6px; color: inherit; cursor: pointer; font: inherit; padding: 3px 8px; }
.office-3d-palette-list button[aria-pressed="true"] { background: #f4d35e; border-color: #f4d35e; color: #1c1f24; }
.office-3d-palette-list button:disabled { cursor: not-allowed; opacity: .45; }
.office-3d-objpanel-actions { display: flex; gap: 6px; }
.office-3d-objpanel-actions button { flex: 1; }
.office-3d-objpanel input[type="color"] { height: 26px; padding: 1px 2px; }
```

and change the final media rule to:

```css
@media (max-width: 700px) { .office-3d-editbar, .office-3d-objpanel, .office-3d-palette, .office-3d-tools .edit-toggle { display: none; } }
```

- [ ] **Step 9: Run tests, types, lint**

Run: `npx vitest run src/pages` → PASS. `npx tsc -b` will fail on `Office3D.tsx` because `ObjectPanel` now requires the new props; that is fixed in Task 5. To keep this commit green, give the three new `ObjectPanelProps` temporary call-site values in `src/pages/Office3D.tsx` on the existing `<ObjectPanel .../>` element: `canDuplicate={false} onDuplicate={() => {}} onProp={() => {}}` (Task 5 replaces them). Then `npx tsc -b`, `npm run lint`, `npm test` → clean.

- [ ] **Step 10: Commit**

```bash
git add src/pages/PropPalette.tsx src/pages/PropPalette.test.tsx src/pages/ObjectPanel.tsx src/pages/ObjectPanel.test.tsx src/pages/Office3D.tsx src/styles.css
git commit -m "feat(editor): object palette and property fields in the panel"
```

---

### Task 5: Placement layer and Office 3D integration

**Files:**
- Modify: `src/scene3d/edit-layer.tsx` (add `PlacementLayer`)
- Modify: `src/pages/Office3D.tsx`
- Modify: `README.md` (section "Editing the office")

**Interfaces:**
- Consumes: Task 1–4 outputs; `PROP_COMPONENTS` from `./scene-renderer.tsx`; `placePoint`, `addProp`, `duplicateItem`, `setItemProp` from `scene-edit.ts`; `editor.placing/startPlacing/stopPlacing/addWith`.
- Produces: `PlacementLayer({ type, level, bounds, night, onPlace, onExit })` in `edit-layer.tsx`.

This task is DOM/WebGL glue with no jsdom harness (the same reason Office3D has no unit tests); it is verified by `tsc`, lint and the browser pass in Step 6. Keep each handler small.

- [ ] **Step 1: Add `PlacementLayer` to `src/scene3d/edit-layer.tsx`**

Extend the imports at the top:

```tsx
import { PROP_CATALOG } from './prop-catalog.ts'
import { PROP_COMPONENTS } from './scene-renderer.tsx'
import { dragTarget, placePoint, type Bounds, type EditableItem } from './scene-edit.ts'
import type { PropType } from './scene.ts'
```
(replacing the existing `import { dragTarget, type Bounds, type EditableItem } from './scene-edit.ts'`.)

Append at the end of the file:

```tsx
const CLICK_SLOP = 4

/**
 * While placing: a translucent ghost of the object follows the pointer across the floor of the viewed
 * level (grid snap, Alt for free). A press-and-release under 4 px places it; a longer drag is the camera.
 * Right-click (without dragging) or Esc (handled by the page) leaves placing. Listeners sit on the canvas
 * element, not on scene objects, so existing items never take the click.
 */
export function PlacementLayer({ type, level, bounds, night, onPlace, onExit }: { type: PropType; level: number; bounds: Bounds; night: boolean; onPlace: (x: number, z: number) => void; onExit: () => void }) {
  const { camera, gl } = useThree()
  const entry = PROP_CATALOG[type]
  const Component = PROP_COMPONENTS[type]
  const ghost = useRef<THREE.Group>(null)
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), [])
  const ray = useMemo(() => new THREE.Raycaster(), [])
  const hit = useMemo(() => new THREE.Vector3(), [])
  const latest = useRef({ bounds, onPlace, onExit })
  latest.current = { bounds, onPlace, onExit }

  // Make the ghost translucent and unpickable once its meshes exist.
  useEffect(() => {
    ghost.current?.traverse((object) => {
      object.raycast = () => {}
      const material = (object as THREE.Mesh).material
      for (const one of Array.isArray(material) ? material : material ? [material] : []) { one.transparent = true; one.opacity = 0.55; one.needsUpdate = true }
    })
  }, [type])

  useEffect(() => {
    const canvas = gl.domElement
    plane.constant = -level
    const target = (event: PointerEvent): [number, number] | null => {
      const rect = canvas.getBoundingClientRect()
      ray.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera)
      return ray.ray.intersectPlane(plane, hit) ? placePoint([hit.x, hit.z], event.altKey, latest.current.bounds) : null
    }
    let down: { id: number; button: number; x: number; y: number } | null = null
    const onMove = (event: PointerEvent) => {
      const at = target(event)
      if (!ghost.current) return
      ghost.current.visible = at !== null
      if (at) ghost.current.position.set(at[0], level, at[1])
    }
    const onDown = (event: PointerEvent) => { down = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY } }
    const onUp = (event: PointerEvent) => {
      const start = down
      down = null
      if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= CLICK_SLOP) return
      if (start.button === 2) { latest.current.onExit(); return }
      if (start.button !== 0) return
      const at = target(event)
      if (at) latest.current.onPlace(at[0], at[1])
    }
    const onContext = (event: Event) => event.preventDefault()
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('contextmenu', onContext)
    canvas.style.cursor = 'crosshair'
    return () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('contextmenu', onContext)
      canvas.style.cursor = ''
    }
  }, [camera, gl, hit, level, plane, ray])

  return <group ref={ghost} visible={false}>
    <Component {...entry.defaults} position={[0, entry.y, 0]} night={night} active={false}/>
  </group>
}
```

- [ ] **Step 2: Wire it into `src/pages/Office3D.tsx`**

Make these edits (read the file first; the strings below exist verbatim):

1. Imports.
   - scene-edit import → `import { addProp, canDelete, deleteItem, duplicateItem, editKeyAction, isEditable, moveItem, rotateBy, rotateItem, ROTATION_STEP, setItemLevel, setItemProp, type EditKeyAction } from '../scene3d/scene-edit.ts'`
   - edit-layer import → `import { EditTarget, PlacementLayer, type EditHandlers } from '../scene3d/edit-layer.tsx'`
   - scene import → add `MAX_ADDED` to the list from `'../scene3d/scene.ts'`.
   - next to the `ObjectPanel`/`EditorBar` imports add `import { PropPalette } from './PropPalette.tsx'`.
2. After the line `const editingActive = editor.editing && !narrow` add:

```tsx
  // Placing is part of editing; it ends when the editor UI is hidden (narrow viewport) or editing stops.
  const placing = editingActive ? editor.placing : null
  const limitReached = editor.draft.added.length >= MAX_ADDED
```
3. `runEditAction`: replace `else if (action === 'deselect') editor.select(null)` with

```tsx
    else if (action === 'deselect') { if (editor.placing) editor.stopPlacing(); else editor.select(null) }
```
and insert before the `else if (action === 'delete')` branch:

```tsx
    else if (action === 'duplicate') { if (!limitReached) editor.addWith((patchNow) => duplicateItem(patchNow, items, selected, bounds)) }
```
(the `else if (!selected) return` line stays before it, so duplicate needs a selection.)
4. Canvas: change `onPointerMissed={editingActive ? () => editor.select(null) : undefined}` to `onPointerMissed={editingActive && !placing ? () => editor.select(null) : undefined}`; in `SceneRenderer`'s `wrap` prop change the condition `editingActive ?` to `editingActive && !placing ?`; right after the `<SceneRenderer .../>` element add:

```tsx
      {placing && <PlacementLayer type={placing} level={level} bounds={bounds} night={theme === 'dark'} onPlace={(x, z) => editor.addWith((patchNow) => addProp(patchNow, items, placing, x, z, level, bounds))} onExit={editor.stopPlacing}/>}
```
5. Render the palette next to the editor bar: after the `{editor.editing && <EditorBar .../>}` line add

```tsx
    {editor.editing && <PropPalette placing={placing} limitReached={limitReached} onPick={(type) => (type ? editor.startPlacing(type) : editor.stopPlacing())}/>}
```
6. On the `<ObjectPanel .../>` element replace the temporary `canDuplicate={false} onDuplicate={() => {}} onProp={() => {}}` with

```tsx
canDuplicate={!limitReached} onDuplicate={() => editor.addWith((patchNow) => duplicateItem(patchNow, items, selected, bounds))} onProp={(key, value) => editor.apply((patchNow) => setItemProp(patchNow, selected, key, value))}
```

- [ ] **Step 3: README** — in the "Editing the office" section of `README.md`, add after the existing list of what you can do:

```
- **Add objects.** The *Objects* palette (left, collapsed on narrow screens) lists every object type. Pick one, then click the floor: it is placed on the floor you are viewing, snapped to 0.25 m (hold Alt for free placement). You stay in placing mode for the next one until you press Esc, right-click, or click the active entry again. Dragging still moves the camera. Desks and beds you add are decoration, not agent seats.
- **Duplicate** the selected object with the *Duplicate* button or Ctrl/Cmd+D (the copy is half a metre over).
- **Properties.** Size, length, run/rise/width and colour appear in the object panel for the objects that have them, including the stock ones.
- At most 500 added objects can be saved.
```
and update the sentence that says editing covers moving/rotating/deleting so it no longer claims new objects are unsupported (search the section for "no editor"/"cannot add" wording and fix it).

- [ ] **Step 4: Static checks**

Run: `npx tsc -b`, `npm run lint`, `npm test`. Expected: all clean/green (apart from the known flaky skin-library test). `npm run build` must succeed.

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/edit-layer.tsx src/pages/Office3D.tsx README.md
git commit -m "feat(editor): place objects from the palette, duplicate and edit properties in Office 3D"
```

- [ ] **Step 6: Browser verification (controller, after the task review)**

Build and serve the worktree on a spare port with a temporary data dir, then drive headless Chromium (CDP script as in 2a). Check and record: (a) palette visible at 1600 px, collapsed at 900 px, not overlapping the floors list, edit bar or office panel; (b) pick Sofa → ghost follows, click places `added-1` and the panel opens for it, a second click places `added-2`, Esc leaves placing; (c) left-drag orbits without placing, right-drag pans without leaving placing; (d) switching to the upper floor and placing puts the object on that floor; (e) Duplicate via button and via Ctrl+D; (f) Railing length and Sofa colour edits, one undo step each; (g) typing "r" in the palette search does not rotate the selected object; (h) Save, reload, objects persist; (i) placing a Staircase, a StringLights, a WallClock and a Television renders sensibly; (j) no page errors.

---

## Self-Review (done while writing)

- **Spec coverage:** catalogue (T1), pure ops incl. id/limit/clamp rules (T2), hook `placing`/`addWith` (T3), palette, Duplicate, property fields, limit notices (T4), placement layer + integration + keyboard + README (T5). Spec's "server-side test that every catalogue default is accepted by `validatePatch`" is replaced by a mirror of the server's `props` rule inside `prop-catalog.test.ts`: `server/` and `src/` are separate TypeScript programs (the server one cannot import `src` files), so a direct import is not possible; the limit constant has a real mirror test (T1 Step 5).
- **Placeholders:** none; Task 4 Step 9 names the temporary Office3D props explicitly and Task 5 replaces them.
- **Type consistency:** `AddResult`, `addWith(make)`, `onPick(type|null)`, `ObjectPanelProps` additions and `PlacementLayer` props are used with the same names in all tasks.
