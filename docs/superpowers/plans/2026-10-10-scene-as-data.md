# Scene as Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the 3D office from a data document (default scene + a server-persisted patch) instead of hard-coded JSX, with data-driven floor levels, so a later editor can change it.

**Architecture:** `defaultScene(layout)` generates a flat list of items (props, floor slabs, walls, glass, windows, boxes) with stable ids; `applyPatch` merges a saved patch (`overrides` by id, `added` items); `SceneRenderer` draws the items visible from the active level. The server stores only the patch in `$RUANG_DATA_DIR/scene.json` behind `GET/PUT/DELETE /api/scene`. Desk and bed positions flow back into the agent layout.

**Tech Stack:** TypeScript, React 19, React Three Fiber / three, Express 5, Vitest. Two TS projects: `server/` (NodeNext, `.js` import suffixes) and `src/` (Bundler, `.ts`/`.tsx` suffixes).

**Spec:** `docs/superpowers/specs/2026-10-10-scene-as-data-design.md` (read it first).

## Global Constraints

- `API_VERSION` goes 12 → 13 in **both** `server/api-version.ts` and `src/api-version.ts`.
- Server body cap for `PUT /api/scene`: 256 KiB (`MAX_SCENE_BYTES = 256 * 1024`). `scene.json` is written atomically (temp file + rename) with mode `0600`, directory `0700`, under `RUANG_DATA_DIR` (default `~/.local/share/ruang`).
- Ruang stays read-only toward Hermes; the only new write is `scene.json` in Ruang's own data dir.
- Mutating routes check the origin with `matchOriginHost` (as `server/skins.ts` does).
- Import suffixes: `.js` in `server/`, `.ts`/`.tsx` in `src/`. Tests sit next to sources; UI tests needing a DOM start with `// @vitest-environment jsdom`.
- `applyPatch` and every redaction/merge returns copies; shared snapshots are never mutated.
- Every task must leave `npx vitest run <its tests>`, `npm run lint` and `npx tsc -b` green.
- Do not touch the unrelated uncommitted skin files (`server/skins.ts`, `server/skins.test.ts`, `src/pages/SkinTab.tsx`) or `.claude/`. Commit only the files a task lists (`git add <files>`, never `git add -A`).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

## Review Focus

Inputs the spec implies that a user will meet, each pinned by a test in the task that owns the code:

1. `scene.json` corrupt, unreadable or from a future version → the default office still renders (Task 2 test: a corrupt or invalid file reads as an empty patch; Task 1 test: a malformed or null patch is ignored by `applyPatch`; Task 5: a pending or failed request uses `EMPTY_PATCH`).
2. A patch that targets ids that no longer exist (crew shrank, stock office changed) → ignored, never an error (Task 1).
3. A patch that deletes `desk-N` / `bed-N`, or adds an item with such an id → the desk or bed count still follows the crew (Task 1, Task 4's `withMovedSeats` count check).
4. An override that tries to change `kind` or `id`, or uses ids like `__proto__` → rejected on write (Task 2) and ignored on apply (Task 1).
5. An oversized or non-JSON body, or numbers that overflow (`1e999`) → 413 / 415 / 400, never a 500 and never a partial write (Task 2).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/scene3d/scene.ts` (new) | Types, `PROP_TYPES`, `visibleAt`, `levelsOf`, `levelAt`, `applyPatch`, `seatPositions`, `EMPTY_PATCH` |
| `src/scene3d/scene.test.ts` (new) | Tests for the above |
| `server/scene.ts` (new) | `validatePatch`, `SceneStore`, router, `installScene` |
| `server/scene.test.ts` (new) | Route, validation and store tests, plus the prop-type drift guard |
| `src/scene3d/props.tsx` | Add `BaksoStall`, `KopiStall` composites |
| `src/scene3d/scene-renderer.tsx` (new) | `SceneRenderer`: item → component mapping |
| `src/scene3d/scene-renderer.test.ts` (new) | Registry covers every prop type |
| `src/scene3d/default-scene.ts` (new) | `defaultScene(layout)`: today's office as data |
| `src/scene3d/default-scene.test.ts` (new) | Parity tests against `createLayout` and view rules |
| `src/office3d-layout.ts` | Add `withMovedSeats` |
| `src/pages/Office3D.tsx` | Use scene + levels; drop `Environment` and the separate desk render |
| `src/scene3d/environment.tsx` | Deleted (Task 5) |
| `server/index.ts`, `server/api-version.ts`, `src/api-version.ts`, `README.md` | Wiring, version bump, docs |

---

### Task 1: Scene types and patch logic

**Suggested executor:** `haiku-worker` (pure, fully specified code).

**Files:**
- Create: `src/scene3d/scene.ts`
- Test: `src/scene3d/scene.test.ts`

**Interfaces:**
- Consumes: `Vec3` from `src/office3d-layout.ts`.
- Produces (later tasks import these exact names):
  `PROP_TYPES`, `PropType`, `PropValue`, `SceneView`, `Surface`, `SurfaceType`, `PropItem`, `FloorItem`, `WallItem`, `GlassItem`, `WindowItem`, `BoxItem`, `SceneItem`, `ScenePatch`, `EMPTY_PATCH`, `visibleAt(item, active)`, `levelsOf(items)`, `levelAt(levels, y)`, `applyPatch(items, patch?)`, `seatPositions(items, 'desk' | 'bed')`.

- [ ] **Step 1: Write the failing tests**

Create `src/scene3d/scene.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { applyPatch, EMPTY_PATCH, levelAt, levelsOf, seatPositions, visibleAt, type PropItem, type SceneItem, type ScenePatch } from './scene.ts'

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
    expect(levelAt([0, 2.8], 1.4)).toBe(0)
    expect(levelAt([0, 2.8], 2.8)).toBe(2.8)
    expect(levelAt([0, 2.8, 5.6], 9)).toBe(5.6)
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
  })
})

describe('seatPositions', () => {
  it('lists desk or bed positions in numeric id order', () => {
    const items = [prop('desk-10', 0, { position: [10, 0, 0] }), prop('desk-2', 0, { position: [2, 0, 0] }), prop('desk-1', 0, { position: [1, 0, 0] }), prop('bed-1', 2.8, { position: [5, 2.8, 5] }), prop('desk-x')]
    expect(seatPositions(items, 'desk')).toEqual([[1, 0, 0], [2, 0, 0], [10, 0, 0]])
    expect(seatPositions(items, 'bed')).toEqual([[5, 2.8, 5]])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scene3d/scene.test.ts`
Expected: FAIL (cannot resolve `./scene.ts`).

- [ ] **Step 3: Write the implementation**

Create `src/scene3d/scene.ts`:

```ts
import type { Vec3 } from '../office3d-layout.ts'

// The 3D office as data: a flat list of items, a saved patch against it, and the rules for which
// items are drawn from which level. The default scene is generated in default-scene.ts and the
// patch is stored by the server (server/scene.ts mirrors these shapes by hand).

/** Components a scene item may name. server/scene.ts keeps the same list; its test checks they match. */
export const PROP_TYPES = [
  'AcOutdoorUnit', 'AirConditioner', 'ArcadeCabinet', 'Armchair', 'BaksoStall', 'BathroomFittings', 'Beanbag', 'Bed',
  'Bookshelf', 'CarromTable', 'ClothesLine', 'CoffeeTable', 'FlagPole', 'FloorCushion', 'Fridge', 'GalonDispenser',
  'Hammock', 'KopiStall', 'LowTable', 'MeetingTable', 'Nightstand', 'OfficeLight', 'PantryCounter', 'PingPongTable',
  'Plant', 'Railing', 'RattanChair', 'SideTable', 'Sofa', 'Staircase', 'StreetLamp', 'StringLights', 'Television',
  'Tree', 'WallClock', 'Wardrobe', 'WaterTank', 'WorkDesk',
] as const
export type PropType = typeof PROP_TYPES[number]
export type PropValue = number | string | boolean

/** `cutaway` (default): drawn when its own level is viewed. `shell`: drawn from higher levels. `both`: either. */
export type SceneView = 'cutaway' | 'shell' | 'both'
export type SurfaceType = 'wood' | 'tile' | 'carpet' | 'grass' | 'asphalt' | 'paving'
export interface Surface { type: SurfaceType; repeat: [number, number]; color?: string }

interface Base { id: string; /** Base height of the storey this item belongs to. */ level: number; view?: SceneView }
export interface PropItem extends Base { kind: 'prop'; type: PropType; position: Vec3; rotation?: number; props?: Record<string, PropValue> }
export interface FloorItem extends Base { kind: 'floor'; min: [number, number]; max: [number, number]; y: number; surface: Surface; roughness?: number }
export interface WallItem extends Base { kind: 'wall'; from: [number, number]; to: [number, number]; y: number; height: number }
export interface GlassItem extends Base { kind: 'glass'; from: [number, number]; to: [number, number]; bottom: number; top: number }
export interface WindowItem extends Base { kind: 'window'; position: Vec3; rotation?: number; width?: number }
export interface BoxItem extends Base { kind: 'box'; position: Vec3; size: Vec3; color: string; radius?: number; roughness?: number; opacity?: number; shadow?: boolean }
export type SceneItem = PropItem | FloorItem | WallItem | GlassItem | WindowItem | BoxItem

export interface ScenePatch {
  version: 1
  /** Fields to merge into the item with that id; `null` deletes it (desks and beds cannot be deleted). */
  overrides: Record<string, Partial<SceneItem> | null>
  added: SceneItem[]
}
export const EMPTY_PATCH: ScenePatch = { version: 1, overrides: {}, added: [] }

/** Viewing `active` draws its cut-away items and the shell items of the levels below it. */
export function visibleAt(item: SceneItem, active: number): boolean {
  if (item.level > active) return false
  const view = item.view ?? 'cutaway'
  return item.level === active ? view !== 'shell' : view !== 'cutaway'
}

export const levelsOf = (items: SceneItem[]): number[] => [...new Set(items.map((item) => item.level))].sort((a, b) => a - b)

/** The level (from the sorted `levels`) a given height is on. */
export function levelAt(levels: number[], y: number): number {
  let found = levels[0] ?? 0
  for (const level of levels) if (y >= level - 1e-6) found = level
  return found
}

// One desk and one bed per agent come from the crew, so a patch can move them but not remove them.
const SEAT_ID = /^(desk|bed)-\d+$/

export function applyPatch(items: SceneItem[], patch?: ScenePatch): SceneItem[] {
  if (!patch) return items
  const overrides = typeof patch.overrides === 'object' && patch.overrides !== null ? patch.overrides : {}
  const result: SceneItem[] = []
  for (const item of items) {
    const override = Object.hasOwn(overrides, item.id) ? overrides[item.id] : undefined
    if (override === null) {
      if (SEAT_ID.test(item.id)) result.push(item)
      continue
    }
    result.push(typeof override === 'object' ? { ...item, ...override, id: item.id, kind: item.kind } as SceneItem : item)
  }
  const taken = new Set(items.map((item) => item.id))
  for (const added of Array.isArray(patch.added) ? patch.added : []) {
    if (taken.has(added.id) || SEAT_ID.test(added.id)) continue
    taken.add(added.id)
    result.push(added)
  }
  return result
}

/** Positions of `desk-N` / `bed-N` items in numeric order of N. */
export function seatPositions(items: SceneItem[], prefix: 'desk' | 'bed'): Vec3[] {
  const own = new RegExp(`^${prefix}-(\\d+)$`)
  return items
    .flatMap((item) => (item.kind === 'prop' && own.test(item.id) ? [{ n: Number(own.exec(item.id)![1]), position: item.position }] : []))
    .sort((a, b) => a.n - b.n)
    .map((seat) => seat.position)
}
```

Note: `PROP_TYPES = [ ... ]` must stay a single bracketed block of single-quoted names (Task 2's drift test parses it with a regex).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scene3d/scene.test.ts && npx tsc -b && npm run lint`
Expected: all PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/scene.ts src/scene3d/scene.test.ts
git commit -m "$(cat <<'EOF'
feat(scene): scene item types, levels and patch logic

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Scene server API, version bump, docs

**Suggested executor:** default model (validation and file-safety code on a trust boundary).

**Files:**
- Create: `server/scene.ts`
- Test: `server/scene.test.ts`
- Modify: `server/index.ts`, `server/api-version.ts`, `src/api-version.ts`, `README.md`

**Interfaces:**
- Consumes: `matchOriginHost` from `server/skins.ts`. Reads `src/scene3d/scene.ts` as text (drift test only).
- Produces: `MAX_SCENE_BYTES`, `SCENE_PROP_TYPES`, `SceneError`, `validatePatch(input): ScenePatch`, `SceneStore` (`read()`, `write(patch)`, `reset()`), `createSceneRouter(store?)`, `installScene(app, store?)`. HTTP: `GET /api/scene` → `{version:1,overrides,added}`; `PUT /api/scene` (JSON body) → the saved patch; `DELETE /api/scene` → `{ok:true}`.

- [ ] **Step 1: Write the failing tests**

Create `server/scene.test.ts`:

```ts
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installScene, MAX_SCENE_BYTES, SCENE_PROP_TYPES, SceneStore, validatePatch } from './scene.js'

const sofa = { id: 'my-sofa', kind: 'prop', level: 0, type: 'Sofa', position: [1, 0, 2] }
const good = { version: 1, overrides: { sofa: { position: [3, 0, 4], rotation: 1.5 }, 'wall-back': null }, added: [sofa] }

describe('scene patch validation', () => {
  it('accepts a normal patch and the empty patch', () => {
    expect(validatePatch(good)).toEqual(good)
    expect(validatePatch({ version: 1 })).toEqual({ version: 1, overrides: {}, added: [] })
  })

  const bad: [string, unknown][] = [
    ['not an object', []],
    ['wrong version', { version: 2 }],
    ['unknown top-level key', { version: 1, extra: true }],
    ['unknown kind', { version: 1, added: [{ ...sofa, kind: 'rocket' }] }],
    ['inherited kind name', { version: 1, added: [{ ...sofa, kind: 'constructor' }] }],
    ['unknown prop type', { version: 1, added: [{ ...sofa, type: 'Rocket' }] }],
    ['short position', { version: 1, added: [{ ...sofa, position: [1, 2] }] }],
    ['overflowing number', { version: 1, added: [{ ...sofa, position: [1e999, 0, 0] }] }],
    ['huge number', { version: 1, added: [{ ...sofa, position: [1e6, 0, 0] }] }],
    ['unknown field', { version: 1, added: [{ ...sofa, hacked: 1 }] }],
    ['missing required field', { version: 1, added: [{ id: 'x', kind: 'prop', level: 0, type: 'Sofa' }] }],
    ['bad id', { version: 1, added: [{ ...sofa, id: '../x' }] }],
    ['generated seat id', { version: 1, added: [{ ...sofa, id: 'desk-9' }] }],
    ['duplicate added ids', { version: 1, added: [sofa, sofa] }],
    ['override changing kind', { version: 1, overrides: { sofa: { kind: 'wall' } } }],
    ['override changing id', { version: 1, overrides: { sofa: { id: 'x' } } }],
    ['override with a bad value', { version: 1, overrides: { sofa: { position: 'here' } } }],
    ['override that is not an object', { version: 1, overrides: { sofa: 5 } }],
    ['prototype id in overrides', JSON.parse('{"version":1,"overrides":{"__proto__":null}}')],
    ['bad colour', { version: 1, added: [{ id: 'b', kind: 'box', level: 0, position: [0, 0, 0], size: [1, 1, 1], color: 'red' }] }],
    ['bad surface', { version: 1, added: [{ id: 'f', kind: 'floor', level: 0, y: 0, min: [0, 0], max: [1, 1], surface: { type: 'lava', repeat: [1, 1] } }] }],
    ['too many added items', { version: 1, added: Array.from({ length: 501 }, (_, index) => ({ ...sofa, id: `s${index}` })) }],
  ]
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => validatePatch(input)).toThrow()
    })
  }

  it('keeps its prop type list in step with the UI', async () => {
    const source = await readFile(new URL('../src/scene3d/scene.ts', import.meta.url), 'utf8')
    const block = /PROP_TYPES = \[([^\]]*)\]/s.exec(source)
    expect(block).not.toBeNull()
    const ui = [...block![1].matchAll(/'(\w+)'/g)].map((match) => match[1])
    expect([...ui].sort()).toEqual([...SCENE_PROP_TYPES].sort())
  })
})

describe('scene api routes', () => {
  let tmp: string
  let file: string
  let base: string
  let close: () => void

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ruang-scene-test-'))
    file = join(tmp, 'data', 'scene.json')
    const app = express()
    installScene(app, new SceneStore(file))
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })
  afterEach(async () => {
    close()
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  const put = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/scene`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: base, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  it('starts empty, saves, reads back, and resets idempotently', async () => {
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 1, overrides: {}, added: [] })
    const saved = await put(good)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(good)
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual(good)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readdir(join(tmp, 'data'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reset = await fetch(`${base}/api/scene`, { method: 'DELETE', headers: { origin: base } })
      expect(reset.status).toBe(200)
      expect(await reset.json()).toEqual({ ok: true })
    }
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 1, overrides: {}, added: [] })
  })

  it('refuses writes without a matching origin', async () => {
    expect((await put(good, { origin: 'http://evil.example' })).status).toBe(403)
    const noOrigin = await fetch(`${base}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) })
    expect(noOrigin.status).toBe(403)
    expect((await fetch(`${base}/api/scene`, { method: 'DELETE' })).status).toBe(403)
  })

  it('answers 415 for non-JSON, 413 for oversized and 400 for broken or invalid bodies, and writes nothing', async () => {
    expect((await put('hello', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await put(JSON.stringify({ version: 1, pad: 'a'.repeat(MAX_SCENE_BYTES + 10) }))).status).toBe(413)
    expect((await put('{not json')).status).toBe(400)
    expect((await put({ version: 1, added: [{ ...sofa, type: 'Rocket' }] })).status).toBe(400)
    expect((await put('')).status).toBe(400)
    await expect(stat(file)).rejects.toThrow()
  })

  it('reads a corrupt or invalid file as the empty patch instead of failing', async () => {
    await put(good)
    await writeFile(file, '{corrupt')
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 1, overrides: {}, added: [] })
    await writeFile(file, JSON.stringify({ version: 1, added: [{ ...sofa, type: 'Rocket' }] }))
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 1, overrides: {}, added: [] })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/scene.test.ts`
Expected: FAIL (cannot resolve `./scene.js`).

- [ ] **Step 3: Write the server module**

Create `server/scene.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express'
import { matchOriginHost } from './skins.js'

// The saved edits to the 3D office: a patch against the default scene the UI generates
// (src/scene3d/scene.ts defines the same shapes; keep the two in step).

export const MAX_SCENE_BYTES = 256 * 1024
export const MAX_ADDED = 500
export const MAX_OVERRIDES = 1000

export const SCENE_PROP_TYPES = [
  'AcOutdoorUnit', 'AirConditioner', 'ArcadeCabinet', 'Armchair', 'BaksoStall', 'BathroomFittings', 'Beanbag', 'Bed',
  'Bookshelf', 'CarromTable', 'ClothesLine', 'CoffeeTable', 'FlagPole', 'FloorCushion', 'Fridge', 'GalonDispenser',
  'Hammock', 'KopiStall', 'LowTable', 'MeetingTable', 'Nightstand', 'OfficeLight', 'PantryCounter', 'PingPongTable',
  'Plant', 'Railing', 'RattanChair', 'SideTable', 'Sofa', 'Staircase', 'StreetLamp', 'StringLights', 'Television',
  'Tree', 'WallClock', 'Wardrobe', 'WaterTank', 'WorkDesk',
] as const
const SURFACES = ['wood', 'tile', 'carpet', 'grass', 'asphalt', 'paving']

export interface ScenePatch {
  version: 1
  overrides: Record<string, Record<string, unknown> | null>
  added: Record<string, unknown>[]
}

export class SceneError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export function sceneFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.RUANG_DATA_DIR || join(homedir(), '.local', 'share', 'ruang'), 'scene.json')
}

type Check = (value: unknown) => boolean
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const num: Check = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000
const positive: Check = (value) => num(value) && (value as number) > 0
const unit: Check = (value) => num(value) && (value as number) >= 0 && (value as number) <= 1
const bool: Check = (value) => typeof value === 'boolean'
const tuple = (length: number, check: Check = num): Check => (value) => Array.isArray(value) && value.length === length && value.every(check)
const oneOf = (list: readonly string[]): Check => (value) => typeof value === 'string' && list.includes(value)
const color: Check = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
const surface: Check = (value) => isRecord(value) && Object.keys(value).every((key) => ['type', 'repeat', 'color'].includes(key)) && oneOf(SURFACES)(value.type) && tuple(2, positive)(value.repeat) && (value.color === undefined || color(value.color))
const propValues: Check = (value) => isRecord(value) && Object.keys(value).length <= 16 && Object.entries(value).every(([key, item]) => /^[A-Za-z]{1,24}$/.test(key) && (num(item) || bool(item) || (typeof item === 'string' && item.length <= 64)))

const FIELDS: Record<string, Record<string, Check>> = {
  prop: { type: oneOf(SCENE_PROP_TYPES), position: tuple(3), rotation: num, props: propValues },
  floor: { min: tuple(2), max: tuple(2), y: num, surface, roughness: unit },
  wall: { from: tuple(2), to: tuple(2), y: num, height: positive },
  glass: { from: tuple(2), to: tuple(2), bottom: num, top: num },
  window: { position: tuple(3), rotation: num, width: positive },
  box: { position: tuple(3), size: tuple(3, positive), color, radius: num, roughness: unit, opacity: unit, shadow: bool },
}
const REQUIRED: Record<string, string[]> = {
  prop: ['type', 'position'], floor: ['min', 'max', 'y', 'surface'], wall: ['from', 'to', 'y', 'height'],
  glass: ['from', 'to', 'bottom', 'top'], window: ['position'], box: ['position', 'size', 'color'],
}
const COMMON: Record<string, Check> = { level: num, view: oneOf(['cutaway', 'shell', 'both']) }
// Overrides do not know the kind of the item they patch, so any field of any kind is allowed.
const ANY_FIELD: Record<string, Check> = Object.assign({}, ...Object.values(FIELDS), COMMON)

const ID = /^[A-Za-z0-9._-]{1,64}$/
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const SEAT_ID = /^(desk|bed)-\d+$/
const checkOf = (fields: Record<string, Check>, key: string): Check | undefined => (Object.hasOwn(fields, key) ? fields[key] : undefined)
const validId = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !FORBIDDEN_IDS.has(id)

function validateItem(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SceneError(`${where}: not an object.`)
  if (!validId(value.id)) throw new SceneError(`${where}: invalid id.`)
  if (SEAT_ID.test(value.id)) throw new SceneError(`${where}: ids like desk-N and bed-N are reserved for the crew's desks and beds.`)
  const kind = value.kind
  if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) throw new SceneError(`${where}: unknown kind.`)
  for (const [key, field] of Object.entries(value)) {
    if (key === 'id' || key === 'kind') continue
    const check = checkOf(COMMON, key) ?? checkOf(FIELDS[kind], key)
    if (!check || !check(field)) throw new SceneError(`${where}: invalid ${key}.`)
  }
  for (const key of ['level', ...REQUIRED[kind]]) if (!Object.hasOwn(value, key)) throw new SceneError(`${where}: missing ${key}.`)
  return value
}

function validateOverride(id: string, value: unknown): Record<string, unknown> | null {
  if (value === null) return null
  if (!isRecord(value)) throw new SceneError(`overrides.${id}: must be an object or null.`)
  for (const [key, field] of Object.entries(value)) {
    if (key === 'id' || key === 'kind') throw new SceneError(`overrides.${id}: ${key} cannot be changed.`)
    const check = checkOf(ANY_FIELD, key)
    if (!check || !check(field)) throw new SceneError(`overrides.${id}: invalid ${key}.`)
  }
  return value
}

export function validatePatch(input: unknown): ScenePatch {
  if (!isRecord(input) || input.version !== 1) throw new SceneError('A scene patch is an object with version 1.')
  if (Object.keys(input).some((key) => !['version', 'overrides', 'added'].includes(key))) throw new SceneError('Unknown field in the scene patch.')
  const overrides = input.overrides ?? {}
  const added = input.added ?? []
  if (!isRecord(overrides)) throw new SceneError('overrides must be an object.')
  if (!Array.isArray(added)) throw new SceneError('added must be an array.')
  const ids = Object.keys(overrides)
  if (ids.length > MAX_OVERRIDES) throw new SceneError(`At most ${MAX_OVERRIDES} overrides.`)
  if (added.length > MAX_ADDED) throw new SceneError(`At most ${MAX_ADDED} added items.`)
  for (const id of ids) if (!validId(id)) throw new SceneError(`overrides: invalid id ${JSON.stringify(id)}.`)
  const items = added.map((item, index) => validateItem(item, `added[${index}]`))
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new SceneError('added: duplicate ids.')
  return { version: 1, overrides: Object.fromEntries(ids.map((id) => [id, validateOverride(id, overrides[id])])), added: items }
}

const emptyPatch = (): ScenePatch => ({ version: 1, overrides: {}, added: [] })

export class SceneStore {
  constructor(readonly file: string = sceneFile()) {}

  /** A missing, unreadable or invalid file reads as "no edits": the default office always renders. */
  async read(): Promise<ScenePatch> {
    try {
      return validatePatch(JSON.parse(await readFile(this.file, 'utf8')))
    } catch {
      return emptyPatch()
    }
  }

  async write(patch: ScenePatch): Promise<void> {
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.scene.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(patch), { mode: 0o600 })
    await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, this.file)
    await chmod(this.file, 0o600).catch(() => {})
  }

  async reset(): Promise<void> {
    await rm(this.file, { force: true })
  }
}

export function createSceneRouter(store: SceneStore = new SceneStore()): Router {
  const router = express.Router()

  router.use((request, response, next) => {
    if ((request.method === 'PUT' || request.method === 'DELETE') && !matchOriginHost(request.headers.origin, request.headers.host)) {
      response.status(403).json({ error: 'Forbidden.' })
      return
    }
    next()
  })

  router.get('/', async (_request, response, next) => {
    try {
      response.json(await store.read())
    } catch (error) {
      next(error)
    }
  })

  router.put('/', express.json({ limit: MAX_SCENE_BYTES }), async (request, response, next) => {
    if (!request.is('application/json')) {
      response.status(415).json({ error: 'Content-Type must be application/json.' })
      return
    }
    try {
      const patch = validatePatch(request.body)
      await store.write(patch)
      response.json(patch)
    } catch (error) {
      if (error instanceof SceneError) {
        response.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  router.delete('/', async (_request, response, next) => {
    try {
      await store.reset()
      response.json({ ok: true })
    } catch (error) {
      next(error)
    }
  })

  // express.json reports oversized and malformed bodies as errors; answer them here, not as a 500.
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    const type = (error as { type?: string } | null)?.type
    if (type === 'entity.too.large') { response.status(413).json({ error: 'Scene is too large.' }); return }
    if (type === 'entity.parse.failed') { response.status(400).json({ error: 'Invalid JSON.' }); return }
    next(error)
  })

  return router
}

export function installScene(app: Express, store: SceneStore = new SceneStore()): Router {
  const router = createSceneRouter(store)
  app.use('/api/scene', router)
  return router
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run server/scene.test.ts`
Expected: PASS. If a "rejects …" case unexpectedly passes validation, fix the validator (not the test).

- [ ] **Step 5: Wire the router, bump the API version, document it**

In `server/index.ts`, add the import next to the other `install…` imports:

```ts
import { installScene } from './scene.js'
```

and register it right after `installSkinLibrary(app, privacyOf, skinLibStore)` (before the `/api` 404 catch-all):

```ts
installScene(app)
```

In `server/api-version.ts` and `src/api-version.ts` change `12` to `13` (open each file, they hold a single constant).

In `README.md`, insert this section immediately before the `## Agent skins` heading, and add the `scene.json` mention to the `RUANG_DATA_DIR` row of the env table (change "custom skins are stored under `$RUANG_DATA_DIR/skins`" to "custom skins are stored under `$RUANG_DATA_DIR/skins` and edits to the office scene in `$RUANG_DATA_DIR/scene.json`"):

```markdown
## Office scene

The 3D office is rendered from a scene document: the built-in office (generated from your crew size) plus an optional saved patch of edits. The patch lives in `scene.json` under `$RUANG_DATA_DIR` (default `~/.local/share/ruang`; file mode `0600`, written atomically) and is shared by everyone who opens this Ruang. A missing, unreadable or invalid file simply means "no edits": the stock office renders.

| Route | Purpose |
|---|---|
| `GET /api/scene` | The saved patch `{ "version": 1, "overrides": { "<item id>": { ...fields } \| null }, "added": [ ...items ] }` (empty when nothing is saved). |
| `PUT /api/scene` | Replace the patch (`application/json`, max 256 KiB, same-origin only, strictly validated). |
| `DELETE /api/scene` | Reset to the stock office. |

`overrides` merge fields into a built-in item by id (`null` deletes it; the crew's `desk-N` and `bed-N` can be moved but not deleted). There is no editor yet: the patch is edited by hand or by a later release. Agent routes (idle stops, walking paths) do not follow moved furniture other than desks and beds.
```

- [ ] **Step 6: Run the checks and commit**

Run: `npx vitest run server/scene.test.ts src/api-version.test.ts && npx tsc -b && npm run lint`
Expected: PASS.

```bash
git add server/scene.ts server/scene.test.ts server/index.ts server/api-version.ts src/api-version.ts README.md
git commit -m "$(cat <<'EOF'
feat(scene): GET/PUT/DELETE /api/scene backed by scene.json

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: SceneRenderer and stall composites

**Suggested executor:** `haiku-worker` for the mechanical mapping, default-model review.

**Files:**
- Modify: `src/scene3d/props.tsx` (append two composites)
- Create: `src/scene3d/scene-renderer.tsx`
- Test: `src/scene3d/scene-renderer.test.ts`

**Interfaces:**
- Consumes: Task 1's `SceneItem`, `PROP_TYPES`, `PropType`, `Surface`, `visibleAt`; components from `props.tsx`; texture functions from `textures.ts`.
- Produces: `PROP_COMPONENTS: Record<PropType, ComponentType<any>>`; `SceneRenderer({ items, level, night, deskActive? })`. `deskActive(id)` tells a `WorkDesk` item (`desk-N`) whether its seat is occupied.

- [ ] **Step 1: Write the failing test**

Create `src/scene3d/scene-renderer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROP_TYPES } from './scene.ts'
import { PROP_COMPONENTS } from './scene-renderer.tsx'

describe('scene renderer', () => {
  it('has a component for every prop type a scene may name', () => {
    expect(Object.keys(PROP_COMPONENTS).sort()).toEqual([...PROP_TYPES].sort())
    for (const component of Object.values(PROP_COMPONENTS)) expect(typeof component).toBe('function')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/scene3d/scene-renderer.test.ts`
Expected: FAIL (cannot resolve `./scene-renderer.tsx`).

- [ ] **Step 3: Add the stall composites**

Append to `src/scene3d/props.tsx` (after `KopiSepeda`/`Vendor` exist in the file; the end of the file is fine):

```tsx
/** The bakso cart with its vendor: the unit the scene places (rotated to face the building). */
export function BaksoStall({ position, rotation = 0, night = false }: { position: Vec3; rotation?: number; night?: boolean }) {
  return <Group position={position} rotation={rotation}>
    <Gerobak position={[0, 0, 0]} night={night}/>
    <Vendor position={[-1.6, 0, 0]} rotation={Math.PI / 2} shirt="#f1f1ec" hat="peci"/>
  </Group>
}

/** The kopi bike with its vendor. */
export function KopiStall({ position, rotation = 0, night = false }: { position: Vec3; rotation?: number; night?: boolean }) {
  return <Group position={position} rotation={rotation}>
    <KopiSepeda position={[0, 0, 0]} night={night}/>
    <Vendor position={[-1.35, 0, -0.1]} rotation={Math.PI / 2} shirt="#2f6d8f" hat="cap"/>
  </Group>
}
```

- [ ] **Step 4: Write the renderer**

Create `src/scene3d/scene-renderer.tsx`:

```tsx
import type { ComponentType } from 'react'
import { AcOutdoorUnit, AirConditioner, ArcadeCabinet, Armchair, BaksoStall, BathroomFittings, Beanbag, Bed, Bookshelf, CarromTable, ClothesLine, CoffeeTable, FlagPole, FloorCushion, Fridge, GalonDispenser, Hammock, KopiStall, LowTable, MeetingTable, Nightstand, OfficeLight, PantryCounter, PingPongTable, Plant, Railing, RattanChair, RBox, SideTable, Sofa, Staircase, StreetLamp, StringLights, Television, Tree, WallClock, Wardrobe, WaterTank, WorkDesk } from './props.tsx'
import { visibleAt, type BoxItem, type FloorItem, type GlassItem, type PropItem, type PropType, type SceneItem, type Surface, type WallItem, type WindowItem } from './scene.ts'
import { asphalt, carpet, grass, pavingStones, tileFloor, woodFloor } from './textures.ts'

// Draws scene items (scene.ts) with the procedural props and primitives. Which items are drawn
// depends on the level in view; see visibleAt.

const WALL = '#efe6d6'
const WALL_TOP = '#d9cdb8'
const THICK = 0.25

// Props take different extra props (color, size, length, ...), so the registry is loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PROP_COMPONENTS: Record<PropType, ComponentType<any>> = {
  AcOutdoorUnit, AirConditioner, ArcadeCabinet, Armchair, BaksoStall, BathroomFittings, Beanbag, Bed, Bookshelf, CarromTable, ClothesLine,
  CoffeeTable, FlagPole, FloorCushion, Fridge, GalonDispenser, Hammock, KopiStall, LowTable, MeetingTable, Nightstand, OfficeLight,
  PantryCounter, PingPongTable, Plant, Railing, RattanChair, SideTable, Sofa, Staircase, StreetLamp, StringLights, Television, Tree,
  WallClock, Wardrobe, WaterTank, WorkDesk,
}

function surfaceTexture({ type, repeat, color }: Surface) {
  switch (type) {
    case 'wood': return woodFloor(repeat)
    case 'tile': return tileFloor(repeat)
    case 'carpet': return carpet(color ?? '#888888', repeat)
    case 'grass': return grass(repeat)
    case 'asphalt': return asphalt(repeat)
    case 'paving': return pavingStones(repeat)
  }
}

function PropNode({ item, night, active }: { item: PropItem; night: boolean; active: boolean }) {
  const Component = PROP_COMPONENTS[item.type]
  if (!Component) return null // a type from a newer or older save: skip it rather than crash the office
  // item.props first, so a save can never override position, rotation, night or active.
  return <Component {...item.props} position={item.position} rotation={item.rotation} night={night} active={active}/>
}

function FloorNode({ item }: { item: FloorItem }) {
  const [x1, z1] = item.min
  const [x2, z2] = item.max
  return <mesh position={[(x1 + x2) / 2, item.y, (z1 + z2) / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
    <planeGeometry args={[Math.abs(x2 - x1), Math.abs(z2 - z1)]}/>
    <meshStandardMaterial map={surfaceTexture(item.surface)} color="#ffffff" roughness={item.roughness ?? 0.8}/>
  </mesh>
}

function WallNode({ item }: { item: WallItem }) {
  const [x1, z1] = item.from
  const [x2, z2] = item.to
  const length = Math.hypot(x2 - x1, z2 - z1)
  const angle = Math.atan2(z2 - z1, x2 - x1)
  return <group position={[(x1 + x2) / 2, item.y, (z1 + z2) / 2]} rotation={[0, -angle, 0]}>
    <RBox position={[0, item.height / 2, 0]} size={[length + THICK, item.height, THICK]} radius={0.02} color={WALL} roughness={0.9}/>
    <RBox position={[0, item.height + 0.02, 0]} size={[length + THICK + 0.02, 0.05, THICK + 0.04]} radius={0.01} color={WALL_TOP}/>
  </group>
}

/** An axis-aligned glass pane: along x when the pane runs mostly in x, otherwise along z. */
function GlassNode({ item }: { item: GlassItem }) {
  const [x1, z1] = item.from
  const [x2, z2] = item.to
  const height = item.top - item.bottom
  const alongX = Math.abs(x2 - x1) >= Math.abs(z2 - z1)
  return <RBox position={[(x1 + x2) / 2, (item.bottom + item.top) / 2, (z1 + z2) / 2]} size={alongX ? [Math.abs(x2 - x1), height, 0.05] : [0.05, height, Math.abs(z2 - z1)]} radius={0.01} color="#cfe8ee" opacity={0.25} roughness={0.05} shadow={false}/>
}

function WindowNode({ item, night }: { item: WindowItem; night: boolean }) {
  const width = item.width ?? 1.8
  return <group position={item.position} rotation={[0, item.rotation ?? 0, 0]}>
    <RBox position={[0, 0, 0]} size={[width + 0.12, 1.22, 0.12]} radius={0.02} color="#5a4636"/>
    <mesh position={[0, 0, 0.065]}><planeGeometry args={[width, 1.1]}/><meshStandardMaterial color={night ? '#2d3f5c' : '#9fd3ea'} emissive={night ? '#1c2c4a' : '#6fb6d6'} emissiveIntensity={0.35} roughness={0.05} metalness={0.2}/></mesh>
    <RBox position={[0, 0, 0.08]} size={[0.05, 1.1, 0.03]} radius={0.01} color="#5a4636"/>
  </group>
}

function BoxNode({ item }: { item: BoxItem }) {
  return <RBox position={item.position} size={item.size} radius={item.radius} color={item.color} roughness={item.roughness} opacity={item.opacity} shadow={item.shadow}/>
}

function SceneNode({ item, night, active }: { item: SceneItem; night: boolean; active: boolean }) {
  switch (item.kind) {
    case 'prop': return <PropNode item={item} night={night} active={active}/>
    case 'floor': return <FloorNode item={item}/>
    case 'wall': return <WallNode item={item}/>
    case 'glass': return <GlassNode item={item}/>
    case 'window': return <WindowNode item={item} night={night}/>
    case 'box': return <BoxNode item={item}/>
    default: return null
  }
}

/** The items visible from `level`. `deskActive(id)` says whether the seat of a `desk-N` item is occupied. */
export function SceneRenderer({ items, level, night, deskActive }: { items: SceneItem[]; level: number; night: boolean; deskActive?: (id: string) => boolean }) {
  return <group>
    {items.filter((item) => visibleAt(item, level)).map((item) => <SceneNode key={item.id} item={item} night={night} active={deskActive?.(item.id) ?? false}/>)}
  </group>
}
```

Notes for the implementer: `RBox` defaults (`radius = 0.04`, `shadow = true`) apply when the optional values are `undefined`. `environment.tsx` still exists and is untouched in this task. If lint objects to `export const PROP_COMPONENTS` and a component in one file (react-refresh rule), keep the export (the test needs it) and add the minimal eslint-disable comment the rule's message asks for.

- [ ] **Step 5: Run the checks**

Run: `npx vitest run src/scene3d/scene-renderer.test.ts && npx tsc -b && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scene3d/props.tsx src/scene3d/scene-renderer.tsx src/scene3d/scene-renderer.test.ts
git commit -m "$(cat <<'EOF'
feat(scene): SceneRenderer draws scene items with the procedural props

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Default scene and `withMovedSeats`

**Suggested executor:** default model (large mechanical conversion that must match `environment.tsx` exactly; the reviewer diffs it against that file).

**Files:**
- Create: `src/scene3d/default-scene.ts`
- Test: `src/scene3d/default-scene.test.ts`
- Modify: `src/office3d-layout.ts` (add `withMovedSeats`), `src/office3d-layout.test.ts` (add its test)

**Interfaces:**
- Consumes: Task 1 types and `visibleAt`, `seatPositions`, `levelsOf`; `OfficeLayout`, `createLayout`, layout constants.
- Produces: `defaultScene(layout: OfficeLayout): SceneItem[]`; `withMovedSeats(layout, desks: Vec3[], beds: Vec3[]): OfficeLayout`.

Conversion rule: every element in `src/scene3d/environment.tsx` (`Building`, `GameRoom`, `BuildingShell`, `UpperFloor`, `Outdoors`) and the `WorkDesk` render in `Office3D.tsx` becomes exactly one item below; coordinates, sizes, colours and rotations are copied unchanged.

- [ ] **Step 1: Write the failing tests**

Create `src/scene3d/default-scene.test.ts`:

```ts
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
        expect(JSON.parse(JSON.stringify(items))).toEqual(items)
      })

      it('puts every wall, floor and prop inside finite coordinates', () => {
        for (const item of items) expect(JSON.stringify(item)).not.toMatch(/null|NaN|Infinity/)
      })
    })
  }

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
```

Append to `src/office3d-layout.test.ts` (add `withMovedSeats` and `bedSpot` to its existing import list from `./office3d-layout.ts`):

```ts
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

  it('keeps the generated seats when the scene does not have one per agent', () => {
    const base = createLayout(3)
    const moved = withMovedSeats(base, [[0, 0, 0]], [])
    expect(moved.desks).toEqual(base.desks)
    expect(moved.beds).toEqual(base.beds)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scene3d/default-scene.test.ts src/office3d-layout.test.ts`
Expected: FAIL (`default-scene.ts` missing, `withMovedSeats` not exported).

- [ ] **Step 3: Add `withMovedSeats` to the layout**

In `src/office3d-layout.ts`, after `createLayout` (before `MEETING_RINGS`), add:

```ts
/**
 * The layout with desks and beds taken from an edited scene, so agents sit where the desks and
 * beds are. A scene without exactly one of each per agent leaves the generated seats alone.
 */
export function withMovedSeats(layout: OfficeLayout, desks: Vec3[], beds: Vec3[]): OfficeLayout {
  const movedBeds = beds.length === layout.beds.length ? beds : layout.beds
  return {
    ...layout,
    desks: desks.length === layout.desks.length ? desks : layout.desks,
    beds: movedBeds,
    idleStops: idleStops(layout.building, layout.baksoCart, layout.kopiBike, movedBeds),
  }
}
```

- [ ] **Step 4: Write the default scene**

Create `src/scene3d/default-scene.ts`:

```ts
import { ARCADES, BALCONY, BALCONY_DOOR, BALCONY_TABLE, BATHROOM, BEANBAGS, CARROM, COFFEE_TABLE, ENTRANCE_X, FLAG, FLOOR_HEIGHT, GAME_DOOR, GAME_ROOM, GAME_TV, HAMMOCK, LESEHAN_TABLE, LOUNGE_PARTITION_END_Z, MEETING_TABLE, PARTITION_X, PING_PONG, SOFA, STAIRS, STALL_ROTATION, TV, type OfficeLayout, type Vec3 } from '../office3d-layout.ts'
import type { PropType, PropValue, SceneItem, SceneView, Surface } from './scene.ts'

// The stock office as data, generated for the crew size in `layout`. Each call below is one element
// of what used to be hard-coded JSX in environment.tsx (and the desks in Office3D.tsx). Coordinates
// are written relative to the scope's level and stored absolute. View per scope:
//   cut   : lantai 1 as a cut-away (drawn when lantai 1 is viewed)
//   shell : lantai 1 closed up (drawn from lantai 2)
//   both  : drawn either way (stairs, back/left walls, the outdoors)
//   up    : lantai 2 (y is relative to FLOOR_HEIGHT)

const WALL = '#efe6d6'
const WALL_TOP = '#d9cdb8'
const WALL_HEIGHT = 2.6
const GLASS_TOP = WALL_HEIGHT - 0.2
const H = FLOOR_HEIGHT

type P2 = [number, number]
const wood = (repeat: P2 = [4, 4]): Surface => ({ type: 'wood', repeat })
const tile = (repeat: P2): Surface => ({ type: 'tile', repeat })
const rug = (color: string, repeat: P2): Surface => ({ type: 'carpet', color, repeat })
const paving = (repeat: P2): Surface => ({ type: 'paving', repeat })

function scope(items: SceneItem[], level: number, view: SceneView = 'cutaway') {
  const tag = { level, ...(view === 'cutaway' ? {} : { view }) }
  const lift = ([x, y, z]: Vec3): Vec3 => [x, level + y, z]
  return {
    prop(id: string, type: PropType, position: Vec3, extra: { rotation?: number; props?: Record<string, PropValue> } = {}) {
      items.push({ kind: 'prop', id, type, position: lift(position), ...extra, ...tag })
    },
    floor(id: string, y: number, [cx, cz]: P2, [w, d]: P2, surface: Surface, roughness?: number) {
      items.push({ kind: 'floor', id, y: level + y, min: [cx - w / 2, cz - d / 2], max: [cx + w / 2, cz + d / 2], surface, ...(roughness === undefined ? {} : { roughness }), ...tag })
    },
    wall(id: string, from: P2, to: P2, height = WALL_HEIGHT) {
      items.push({ kind: 'wall', id, from, to, y: level, height, ...tag })
    },
    glass(id: string, from: P2, to: P2, bottom: number, top = GLASS_TOP) {
      items.push({ kind: 'glass', id, from, to, bottom: level + bottom, top: level + top, ...tag })
    },
    window(id: string, position: Vec3, rotation = 0, width?: number) {
      items.push({ kind: 'window', id, position: lift(position), ...(rotation === 0 ? {} : { rotation }), ...(width === undefined ? {} : { width }), ...tag })
    },
    box(id: string, position: Vec3, size: Vec3, color: string, extra: { radius?: number; roughness?: number; opacity?: number } = {}) {
      items.push({ kind: 'box', id, position: lift(position), size, color, ...extra, ...tag })
    },
  }
}

export function defaultScene(layout: OfficeLayout): SceneItem[] {
  const { minX, maxX, minZ, maxZ } = layout.building
  const g = GAME_ROOM
  const items: SceneItem[] = []
  const cut = scope(items, 0)
  const shell = scope(items, 0, 'shell')
  const both = scope(items, 0, 'both')
  const up = scope(items, H)

  // --- Lantai 1, cut-away: floors, walls, windows ------------------------------------------------
  cut.floor('floor-main', 0.005, [(minX + maxX) / 2, (minZ + maxZ) / 2], [maxX - minX, maxZ - minZ], wood(), 0.55)
  cut.floor('floor-pantry', 0.01, [8.35, 1.4], [2.3, 5.4], tile([3, 5]), 0.35)
  cut.floor('rug-lounge', 0.012, [4.6, -2.9], [4.4, 2.8], rug('#5b7c8c', [2, 2]))
  cut.floor('rug-meeting', 0.012, [-5.2, 2.2], [3.6, 3], rug('#8a4b3c', [2, 2]))
  both.wall('wall-back', [minX, minZ], [maxX, minZ])
  both.wall('wall-left', [minX, minZ], [minX, maxZ])
  cut.wall('wall-right-a', [maxX, minZ], [maxX, GAME_DOOR.fromZ], 1.1)
  cut.wall('wall-right-b', [maxX, GAME_DOOR.toZ], [maxX, maxZ], 1.1)
  cut.glass('glass-right-a', [maxX, minZ], [maxX, GAME_DOOR.fromZ], 1.1)
  cut.glass('glass-right-b', [maxX, GAME_DOOR.toZ], [maxX, g.maxZ], 1.1)
  cut.wall('wall-partition', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  cut.glass('glass-partition', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  cut.wall('wall-front-a', [minX, maxZ], [4.9, maxZ], 0.55)
  cut.wall('wall-front-b', [6.7, maxZ], [maxX, maxZ], 0.55)
  cut.wall('wall-meeting', [-3.2, 1], [-3.2, maxZ], 0.9)
  cut.box('glass-meeting', [-3.2, 1.35, 2.6], [0.06, 0.9, 3.2], '#cfe8ee', { radius: 0.01, opacity: 0.3, roughness: 0.05 })
  ;[1.3, 2.3, 3.3].forEach((z, index) => cut.prop(`planter-${index + 1}`, 'Plant', [0.9, 0, z], { props: { size: 0.8 } }))
  ;[-7, -3.6, 1.4, 6.6].forEach((x, index) => cut.window(`window-back-${index + 1}`, [x, 1.55, minZ + 0.14]))
  ;[-3, 0.6].forEach((z, index) => cut.window(`window-left-${index + 1}`, [minX + 0.14, 1.55, z], Math.PI / 2, 1.6))

  // --- Lantai 1: workspace, lounge, pantry -------------------------------------------------------
  layout.desks.forEach((position, index) => cut.prop(`desk-${index + 1}`, 'WorkDesk', position, { props: { withChair: true } }))
  cut.prop('meeting-table', 'MeetingTable', MEETING_TABLE)
  cut.prop('bookshelf-1', 'Bookshelf', [minX + 0.35, 0, -0.9], { rotation: Math.PI / 2 })
  cut.prop('plant-1', 'Plant', [minX + 0.5, 0, -4.6])
  cut.prop('plant-2', 'Plant', [-0.4, 0, -4.7], { props: { size: 0.9 } })
  cut.prop('wall-clock', 'WallClock', [-3.6, 2.35, minZ + 0.14])
  cut.prop('sofa', 'Sofa', SOFA, { rotation: Math.PI })
  // Armchairs sit exactly behind the lounge seats agents use (LOUNGE_SEATS 2 and 3).
  cut.prop('armchair-1', 'Armchair', [2.1, 0, -2.9], { rotation: Math.PI / 2, props: { color: '#d9784a' } })
  cut.prop('armchair-2', 'Armchair', [7.1, 0, -2.9], { rotation: -Math.PI / 2, props: { color: '#3d7fd6' } })
  cut.prop('coffee-table', 'CoffeeTable', COFFEE_TABLE)
  cut.box('tv-cabinet', [TV[0], 0.3, TV[2]], [1.8, 0.6, 0.45], '#6b4a32', { radius: 0.03 })
  cut.prop('tv', 'Television', [TV[0], 1.35, minZ + 0.17])
  cut.prop('plant-3', 'Plant', [2.1, 0, -4.6])
  cut.prop('galon', 'GalonDispenser', [maxX - 0.45, 0, -0.4], { rotation: -Math.PI / 2 })
  cut.prop('fridge', 'Fridge', [maxX - 0.5, 0, 0.6], { rotation: -Math.PI / 2 })
  cut.prop('pantry-counter', 'PantryCounter', [maxX - 0.45, 0, 2.6], { rotation: -Math.PI / 2 })
  cut.prop('ac-1', 'AirConditioner', [-5.3, 2.3, minZ + 0.125])
  cut.prop('ac-2', 'AirConditioner', [TV[0], 2.3, minZ + 0.125])
  cut.prop('ac-3', 'AirConditioner', [minX + 0.125, 2.3, 2.6], { rotation: Math.PI / 2 })
  layout.desks.forEach(([x, , z], index) => cut.prop(`light-desk-${index + 1}`, 'OfficeLight', [x, 2.4, z + 0.2]))
  cut.prop('light-meeting', 'OfficeLight', [MEETING_TABLE[0], 2.3, MEETING_TABLE[2]])
  cut.prop('light-coffee', 'OfficeLight', [COFFEE_TABLE[0], 2.4, COFFEE_TABLE[2] + 0.4])
  cut.prop('light-pantry', 'OfficeLight', [8.2, 2.4, 1.2])
  both.prop('stairs', 'Staircase', [STAIRS.lowX, 0, STAIRS.z], { props: { run: STAIRS.highX - STAIRS.lowX, rise: FLOOR_HEIGHT, width: STAIRS.width } })

  // --- Game room wing (cut-away) -----------------------------------------------------------------
  cut.floor('floor-game', 0.006, [(g.minX + g.maxX) / 2, (g.minZ + g.maxZ) / 2], [g.maxX - g.minX, g.maxZ - g.minZ], rug('#3b4170', [3, 3]), 0.9)
  both.wall('game-wall-back', [g.minX, g.minZ], [g.maxX, g.minZ])
  both.wall('game-wall-right', [g.maxX, g.minZ], [g.maxX, g.maxZ])
  cut.wall('game-wall-front', [g.minX, g.maxZ], [g.maxX, g.maxZ], 0.55)
  cut.window('game-window', [g.maxX - 0.14, 1.55, -2.2], -Math.PI / 2, 1.6)
  cut.prop('ping-pong', 'PingPongTable', PING_PONG)
  ARCADES.forEach((position, index) => cut.prop(`arcade-${index + 1}`, 'ArcadeCabinet', position, { props: { color: index === 0 ? '#c62828' : '#1d4ed8' } }))
  cut.box('game-tv-stand', [GAME_TV[0], 0.25, GAME_TV[2] + 0.2], [1.8, 0.5, 0.4], '#1f2328', { radius: 0.03 })
  cut.box('game-console', [GAME_TV[0] - 0.3, 0.55, GAME_TV[2] + 0.2], [0.36, 0.08, 0.26], '#f2f2f2', { radius: 0.02 })
  cut.prop('game-tv', 'Television', [GAME_TV[0], 1.35, GAME_TV[2] + 0.02])
  BEANBAGS.forEach((position, index) => cut.prop(`beanbag-${index + 1}`, 'Beanbag', position, { props: { color: index === 0 ? '#e76f51' : '#2a9d8f' } }))
  cut.prop('carrom', 'CarromTable', CARROM)
  cut.prop('plant-game', 'Plant', [g.maxX - 0.5, 0, g.maxZ - 0.5], { props: { size: 0.9 } })
  cut.prop('ac-game', 'AirConditioner', [(g.minX + g.maxX) / 2 - 0.6, 2.3, g.minZ + 0.125])
  cut.prop('light-game-1', 'OfficeLight', [PING_PONG[0], 2.4, PING_PONG[2]])
  cut.prop('light-game-2', 'OfficeLight', [ARCADES[0][0] + 0.5, 2.4, -3.6])
  cut.prop('light-game-3', 'OfficeLight', [GAME_TV[0], 2.4, -3.6])

  // --- Lantai 1 closed up, seen from lantai 2 ----------------------------------------------------
  shell.wall('wall-right-shell', [maxX, minZ], [maxX, maxZ])
  shell.wall('wall-front-shell-a', [minX, maxZ], [4.9, maxZ])
  shell.wall('wall-front-shell-b', [6.7, maxZ], [maxX, maxZ])
  shell.glass('glass-entrance', [4.9, maxZ], [6.7, maxZ], 0, 2.3)
  shell.box('entrance-lintel', [ENTRANCE_X, 2.45, maxZ], [1.9, 0.3, 0.3], WALL_TOP, { radius: 0.02 })
  ;[-7, -3.6, -0.2, 2.6, 8.1].forEach((x, index) => { if (x > minX + 1) shell.window(`window-front-${index + 1}`, [x, 1.45, maxZ + 0.14]) })
  ;[-3, 0.6, 3].forEach((z, index) => shell.window(`window-side-${index + 1}`, [minX - 0.14, 1.45, z], -Math.PI / 2, 1.6))
  shell.wall('game-wall-front-shell', [g.minX, g.maxZ], [g.maxX, g.maxZ])
  ;[11, 13.8].forEach((x, index) => shell.window(`game-window-front-${index + 1}`, [x, 1.45, g.maxZ + 0.14], 0, 1.4))
  shell.box('game-roof', [(g.minX + g.maxX) / 2, WALL_HEIGHT + 0.08, (g.minZ + g.maxZ) / 2], [g.maxX - g.minX + 0.3, 0.16, g.maxZ - g.minZ + 0.3], '#9a9a94', { radius: 0.02, roughness: 0.95 })
  shell.prop('water-tank', 'WaterTank', [14.2, WALL_HEIGHT + 0.16, -3.8])
  shell.prop('ac-outdoor-roof', 'AcOutdoorUnit', [11.2, WALL_HEIGHT + 0.16, -4.3])

  // --- Lantai 2: slab, walls, bedroom, lesehan, bathroom, balcony --------------------------------
  const hole = { minX: STAIRS.highX, maxX: STAIRS.lowX, minZ: STAIRS.z - STAIRS.width / 2 - 0.05, maxZ: STAIRS.z + STAIRS.width / 2 + 0.05 }
  // The slab, leaving the stairwell open: [minX, maxX, minZ, maxZ] pieces (the last is the balcony).
  const slab: [number, number, number, number][] = [
    [minX, maxX, minZ, hole.minZ], [minX, hole.minX, hole.minZ, hole.maxZ], [hole.maxX, maxX, hole.minZ, hole.maxZ], [minX, maxX, hole.maxZ, maxZ],
    [minX, maxX, BALCONY.minZ, BALCONY.maxZ],
  ]
  // Balcony columns run down to the sidewalk (ruko style); the beam carries the string lights.
  ;[minX + 0.15, (minX + maxX) / 2, maxX - 0.15].forEach((x, index) => up.box(`balcony-post-${index + 1}`, [x, (2.3 - H) / 2, BALCONY.maxZ - 0.12], [0.18, H + 2.3, 0.18], WALL, { radius: 0.02 }))
  up.box('balcony-beam', [(minX + maxX) / 2, 2.3, BALCONY.maxZ - 0.12], [maxX - minX, 0.12, 0.14], WALL_TOP, { radius: 0.02 })
  slab.forEach(([x1, x2, z1, z2], index) => up.box(`slab-${index + 1}`, [(x1 + x2) / 2, -0.11, (z1 + z2) / 2], [x2 - x1, 0.22, z2 - z1], '#cfc6b5', { radius: 0.01 }))
  slab.slice(0, 4).forEach(([x1, x2, z1, z2], index) => up.floor(`deck-${index + 1}`, 0.005, [(x1 + x2) / 2, (z1 + z2) / 2], [x2 - x1, z2 - z1], wood(), 0.55))
  up.floor('deck-balcony', 0.005, [(minX + maxX) / 2, (BALCONY.minZ + BALCONY.maxZ) / 2], [maxX - minX, BALCONY.maxZ - BALCONY.minZ], tile([6, 1]), 0.5)
  up.floor('rug-bedroom', 0.012, [(minX + PARTITION_X) / 2, -2.4], [PARTITION_X - minX - 0.4, 5], rug('#6d5a8c', [3, 3]))
  up.floor('rug-lesehan', 0.012, [LESEHAN_TABLE[0], LESEHAN_TABLE[2]], [3.4, 2.8], rug('#8c3b3b', [2, 2]))
  up.floor('floor-bathroom', 0.012, [(BATHROOM.minX + BATHROOM.maxX) / 2, (BATHROOM.minZ + BATHROOM.maxZ) / 2], [BATHROOM.maxX - BATHROOM.minX, BATHROOM.maxZ - BATHROOM.minZ], tile([2, 2]), 0.3)
  // Walls: full at the back and sides, glass sliding doors onto the balcony.
  up.wall('up-wall-back', [minX, minZ], [maxX, minZ])
  up.wall('up-wall-left', [minX, minZ], [minX, maxZ])
  up.wall('up-wall-right', [maxX, minZ], [maxX, maxZ])
  up.wall('up-front-a', [minX, maxZ], [BALCONY_DOOR.fromX, maxZ], 0.3)
  up.wall('up-front-b', [BALCONY_DOOR.toX, maxZ], [maxX, maxZ], 0.3)
  up.glass('up-glass-a', [minX, maxZ], [BALCONY_DOOR.fromX, maxZ], 0.3, 2.2)
  up.glass('up-glass-b', [BALCONY_DOOR.toX, maxZ], [maxX, maxZ], 0.3, 2.2)
  ;[-6, -2.4, 2.6].forEach((x, index) => { if (x > minX + 1) up.window(`up-window-${index + 1}`, [x, 1.55, minZ + 0.14]) })
  up.window('up-window-right', [maxX - 0.14, 1.55, 0.6], -Math.PI / 2, 1.6)
  // Bedroom: one bed per agent, a glass partition, wardrobes and bedside tables.
  up.wall('up-partition', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  up.glass('up-partition-glass', [PARTITION_X, minZ], [PARTITION_X, LOUNGE_PARTITION_END_Z], 0.9)
  const blankets = ['#3d7fd6', '#e76f51', '#2a9d8f', '#e9c46a', '#8d5bc1', '#d64545']
  layout.beds.forEach(([x, , z], index) => up.prop(`bed-${index + 1}`, 'Bed', [x, 0, z], { props: { color: blankets[index % blankets.length] } }))
  layout.beds.forEach(([x, , z], index) => { if (z < -3) up.prop(`nightstand-${index + 1}`, 'Nightstand', [x - 0.85, 0, minZ + 0.4]) })
  up.prop('wardrobe-1', 'Wardrobe', [minX + 0.4, 0, 1.4], { rotation: Math.PI / 2 })
  up.prop('wardrobe-2', 'Wardrobe', [minX + 0.4, 0, 2.8], { rotation: Math.PI / 2 })
  up.prop('up-ac', 'AirConditioner', [(minX + PARTITION_X) / 2, 2.3, minZ + 0.125])
  // Lesehan corner.
  up.prop('low-table', 'LowTable', [LESEHAN_TABLE[0], 0, LESEHAN_TABLE[2]])
  ;([[-1, 0, '#e9c46a'], [1, 0, '#2a9d8f'], [0, -0.85, '#e76f51'], [0, 0.85, '#3d7fd6']] as [number, number, string][]).forEach(([dx, dz, color], index) => up.prop(`cushion-${index + 1}`, 'FloorCushion', [LESEHAN_TABLE[0] + dx, 0, LESEHAN_TABLE[2] + dz], { props: { color } }))
  up.prop('up-bookshelf', 'Bookshelf', [6.5, 0, minZ + 0.3])
  up.prop('up-plant-1', 'Plant', [1.1, 0, minZ + 0.5], { props: { size: 0.9 } })
  up.prop('up-plant-2', 'Plant', [7.1, 0, 1.4])
  // Bathroom: kamar mandi with a bak mandi.
  up.wall('bathroom-wall-a', [BATHROOM.minX, minZ], [BATHROOM.minX, BATHROOM.maxZ], 1.9)
  up.wall('bathroom-wall-b', [BATHROOM.minX, BATHROOM.maxZ], [8, BATHROOM.maxZ], 1)
  up.wall('bathroom-wall-c', [8.9, BATHROOM.maxZ], [maxX, BATHROOM.maxZ], 1)
  up.prop('bathroom-fittings', 'BathroomFittings', [8.2, 0, -2.6])
  // Railing around the stairwell.
  up.prop('railing-stairwell-a', 'Railing', [(hole.minX + hole.maxX) / 2, 0, hole.minZ], { props: { length: hole.maxX - hole.minX } })
  up.prop('railing-stairwell-b', 'Railing', [hole.maxX, 0, STAIRS.z], { rotation: Math.PI / 2, props: { length: hole.maxZ - hole.minZ } })
  const doorX = (BALCONY_DOOR.fromX + BALCONY_DOOR.toX) / 2
  layout.beds.forEach(([x, , z], index) => { if (index % 2 === 0) up.prop(`up-light-bed-${index + 1}`, 'OfficeLight', [x, 2.4, z + 0.6]) })
  up.prop('up-light-lesehan', 'OfficeLight', [LESEHAN_TABLE[0], 2.4, LESEHAN_TABLE[2]])
  up.prop('up-light-door', 'OfficeLight', [doorX, 2.4, 2])
  // Balcony.
  up.prop('balcony-railing-front', 'Railing', [(minX + maxX) / 2, 0, BALCONY.maxZ - 0.05], { props: { length: maxX - minX } })
  up.prop('balcony-railing-left', 'Railing', [minX + 0.05, 0, (BALCONY.minZ + BALCONY.maxZ) / 2], { rotation: Math.PI / 2, props: { length: BALCONY.maxZ - BALCONY.minZ } })
  up.prop('balcony-railing-right', 'Railing', [maxX - 0.05, 0, (BALCONY.minZ + BALCONY.maxZ) / 2], { rotation: Math.PI / 2, props: { length: BALCONY.maxZ - BALCONY.minZ } })
  up.prop('side-table', 'SideTable', [BALCONY_TABLE[0], 0, BALCONY_TABLE[2]])
  up.prop('rattan-chair-1', 'RattanChair', [BALCONY_TABLE[0] - 0.85, 0, BALCONY_TABLE[2]], { rotation: Math.PI / 2 })
  up.prop('rattan-chair-2', 'RattanChair', [BALCONY_TABLE[0] + 0.85, 0, BALCONY_TABLE[2]], { rotation: -Math.PI / 2 })
  up.prop('hammock', 'Hammock', [HAMMOCK[0], 0, HAMMOCK[2]])
  up.prop('clothes-line', 'ClothesLine', [Math.max(minX + 1.6, -3.2), 0, 6.15])
  up.prop('balcony-plant-1', 'Plant', [maxX - 0.5, 0, BALCONY.minZ + 0.5], { props: { size: 0.9 } })
  up.prop('balcony-plant-2', 'Plant', [minX + 0.5, 0, BALCONY.minZ + 0.5], { props: { size: 0.9 } })
  up.prop('string-lights', 'StringLights', [(minX + maxX) / 2, 2.15, BALCONY.maxZ - 0.12], { props: { length: maxX - minX - 0.6 } })

  // --- Outdoors (drawn from either floor). The grounds grow with the building to the left. -------
  const shift = minX + 9.5
  both.floor('lawn', -0.02, [shift / 2, 2], [60 - shift, 44], { type: 'grass', repeat: [14, 12] }, 1)
  both.floor('sidewalk', -0.005, [shift / 2, 7.1], [34 - shift, 5], paving([14, 2]), 0.9)
  both.floor('road', -0.01, [shift / 2, 12.1], [60 - shift, 5], { type: 'asphalt', repeat: [8, 1] }, 0.95)
  both.floor('entrance-path', 0, [5.8, 4.7], [1.8, 1], paving([14, 2]))
  both.floor('gang', -0.008, [layout.gangCenterX, -0.4], [3.6, 10], paving([2, 5]), 0.9)
  both.prop('flag', 'FlagPole', FLAG)
  both.prop('bakso-stall', 'BaksoStall', layout.baksoCart, { rotation: STALL_ROTATION })
  both.prop('kopi-stall', 'KopiStall', layout.kopiBike, { rotation: STALL_ROTATION })
  both.prop('ac-outdoor-1', 'AcOutdoorUnit', [-5.3, 0, minZ - 0.45], { rotation: Math.PI })
  both.prop('ac-outdoor-2', 'AcOutdoorUnit', [TV[0] - 1.6, 0, minZ - 0.45], { rotation: Math.PI })
  both.prop('street-lamp-1', 'StreetLamp', [-8, 0, 9.3])
  both.prop('street-lamp-2', 'StreetLamp', [4, 0, 9.3])
  ;([[-12.8 + shift, -7.4, 1.3], [13.5, -7.2, 1.2], [-14.8 + shift, 2.6, 1.1], [18.6, 4.8, 1.3], [-10.5 + shift, 7.5, 1], [12, 8, 1.1], [-2, -8.5, 1.2], [6, -8, 1.1]] as [number, number, number][])
    .forEach(([x, z, size], index) => both.prop(`tree-${index + 1}`, 'Tree', [x, 0, z], { props: { size } }))

  return items
}
```

- [ ] **Step 5: Verify against `environment.tsx`**

Run: `npx vitest run src/scene3d/default-scene.test.ts src/office3d-layout.test.ts`
Expected: PASS.

Then do a manual completeness pass: open `src/scene3d/environment.tsx` and tick off every JSX element (`Floor`, `Wall`, `Glass`, `GlassZ`, `Window`, `RBox`, each prop component, each `.map`) against the calls above. Anything missing or with different numbers is a bug in `default-scene.ts`. Report any element you could not map.

- [ ] **Step 6: Check and commit**

Run: `npx tsc -b && npm run lint`
Expected: PASS.

```bash
git add src/scene3d/default-scene.ts src/scene3d/default-scene.test.ts src/office3d-layout.ts src/office3d-layout.test.ts
git commit -m "$(cat <<'EOF'
feat(scene): the stock office as a generated scene, withMovedSeats

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Office 3D renders from the scene

**Suggested executor:** default model (edits a 400-line component; must keep agent behaviour intact).

**Files:**
- Create: `src/scene3d/use-scene.ts`
- Modify: `src/pages/Office3D.tsx`
- Delete: `src/scene3d/environment.tsx`

**Interfaces:**
- Consumes: `usePolling` (`src/polling.ts`), `defaultScene`, `applyPatch`, `levelsOf`, `levelAt`, `seatPositions`, `EMPTY_PATCH`, `ScenePatch`, `SceneRenderer`, `withMovedSeats`, `createLayout`.
- Produces: `useScenePatch(): ScenePatch` (the saved patch, or the empty patch while loading or on any failure).

- [ ] **Step 1: Add the scene hook**

Create `src/scene3d/use-scene.ts`:

```ts
import { usePolling } from '../polling.ts'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

/** The saved scene edits. Pending or failed requests mean "no edits": the stock office still renders. */
export function useScenePatch(): ScenePatch {
  const request = usePolling<ScenePatch>('/api/scene', 30_000)
  return request.status === 'ready' ? request.data : EMPTY_PATCH
}
```

- [ ] **Step 2: Switch `Office3D.tsx` to the scene**

Make these edits in `src/pages/Office3D.tsx`.

1. Imports. Replace the layout/environment/props imports with:

```tsx
import { clampTarget, createLayout, FLOOR_HEIGHT, GAME_ROOM, idlePlan, placementFor, walkPath3, withMovedSeats, type OfficeLayout, type Placement, type Vec3 } from '../office3d-layout.ts'
import { defaultScene } from '../scene3d/default-scene.ts'
import { applyPatch, levelAt, levelsOf, seatPositions } from '../scene3d/scene.ts'
import { SceneRenderer } from '../scene3d/scene-renderer.tsx'
import { useScenePatch } from '../scene3d/use-scene.ts'
```

(`floorOf`, `type Floor`, `Environment` and `WorkDesk` are no longer imported. `FLOOR_HEIGHT` stays: the sleep button uses it in step 7. If lint reports any other import as unused, remove it.)

2. `Character`: replace the `floor: Floor` prop with `level: number` and `levels: number[]` (destructure and type both), then replace the two visibility lines in `useFrame`

```tsx
    const upstairs = group.position.y > FLOOR_HEIGHT / 2
    group.visible = floor === 2 ? upstairs || outdoors(group.position.x, group.position.z, layout) : !upstairs
```

with

```tsx
    const standingOn = levelAt(levels, group.position.y)
    group.visible = standingOn === level || (standingOn < level && outdoors(group.position.x, group.position.z, layout))
```

and update the comment above them to: `// Only the level in view is drawn; from higher levels the agents outside on the ground stay visible.`

3. Delete the `FLOORS` constant and the `Floor`-based `useFloor`; keep `FLOOR_KEY` and `SLEEP_KEY`. Add, in their place:

```tsx
/** Names for the two stock levels; levels a scene adds are called "Lantai N". */
const STOCK_LEVELS = [
  { label: 'Kantor', title: 'Lantai 1: office, lounge, pantry and game room' },
  { label: 'Kamar & Balkon', title: 'Lantai 2: bedroom, lesehan and balcony' },
]
const levelName = (index: number) => STOCK_LEVELS[index] ?? { label: `Lantai ${index + 1}`, title: `Lantai ${index + 1}` }

/** The level in view, as an index into the scene's levels, kept per browser (stored as index + 1, like before). */
function useLevelIndex(count: number): [number, (index: number) => void] {
  const [stored, setStored] = useState<number>(() => {
    try { return Math.max(0, Number(localStorage.getItem(FLOOR_KEY)) - 1) || 0 } catch { return 0 }
  })
  return [Math.min(stored, count - 1), (next: number) => {
    setStored(next)
    try { localStorage.setItem(FLOOR_KEY, String(next + 1)) } catch { /* per-browser convenience only */ }
  }]
}
```

4. In `Office3D()`, replace the layout lines and the floor state. Remove `const [floor, setFloor] = useFloor()` and replace

```tsx
  const layout = useMemo(() => createLayout(stations.length), [stations.length])
```

with

```tsx
  // The office is a scene: the stock office for this crew plus the saved edits. Agents sit at the
  // scene's desks and beds; their other stops and walking routes are still the stock ones.
  const patch = useScenePatch()
  const baseLayout = useMemo(() => createLayout(stations.length), [stations.length])
  const items = useMemo(() => applyPatch(defaultScene(baseLayout), patch), [baseLayout, patch])
  const layout = useMemo(() => withMovedSeats(baseLayout, seatPositions(items, 'desk'), seatPositions(items, 'bed')), [baseLayout, items])
  const levels = useMemo(() => levelsOf(items), [items])
  const [levelIndex, setLevelIndex] = useLevelIndex(levels.length)
  const level = levels[levelIndex] ?? 0
```

Place this block where the old `layout` line was, and move `const skinsRequest = …` lines as they are. Replace `floorCount`:

```tsx
  const levelCount = (value: number) => stations.filter((station) => levelAt(levels, placement(station).position[1]) === value).length
```

5. The Page Up/Down handler:

```tsx
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); setLevelIndex(Math.min(Math.max(levelIndex + (event.key === 'PageUp' ? 1 : -1), 0), levels.length - 1)) }
```

6. Canvas contents. Replace the `<Environment …/>` line and the `{floor === 1 && layout.desks.map(…WorkDesk…)}` line with

```tsx
      <SceneRenderer items={items} level={level} night={theme === 'dark'} deskActive={(id) => occupiedSeats.has(Number(id.slice(5)))}/>
```

(`desk-N` ids become seat N; `occupiedSeats` already holds 1-based seat numbers.) In the `Character` element replace `floor={floor}` with `level={level} levels={levels}`. On `Controls` replace `elevation={floor === 2 ? FLOOR_HEIGHT : 0}` with `elevation={level}`.

7. The floor switcher and sleep button. Replace the `office-3d-floors` block with:

```tsx
    <div className="office-3d-floors" role="group" aria-label="Floors">
      {levels.map((height, index) => ({ height, index })).reverse().map(({ height, index }) => <button key={height} type="button" className={levelIndex === index ? 'active' : ''} aria-pressed={levelIndex === index} onClick={() => setLevelIndex(index)} title={`${levelName(index).title} (Page Up and Page Down change floors)`}>
        <b>{index + 1}</b><span>{levelName(index).label}</span><small>{levelCount(height)}</small>
      </button>)}
    </div>
```

and in the sleep button replace `setFloor(2)` with `setLevelIndex(Math.max(0, levels.indexOf(FLOOR_HEIGHT)))`.

- [ ] **Step 3: Delete the old environment**

Run: `grep -rn "scene3d/environment\|from './environment" src && git rm src/scene3d/environment.tsx`
Expected: the grep prints nothing before the removal (only `Office3D.tsx` imported it, and step 2 removed that). If it prints another importer, update that importer first.

- [ ] **Step 4: Verify everything still passes**

Run: `npx tsc -b && npm run lint && npm test`
Expected: all PASS (the full suite, including `office3d-layout.test.ts`, `office-detail.test.tsx` and the new scene tests).

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/use-scene.ts src/pages/Office3D.tsx
git commit -m "$(cat <<'EOF'
feat(scene): Office 3D renders from the scene; floors come from its levels

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

(`git rm` already staged the deletion of `environment.tsx`; it is included in this commit.)

---

### Task 6: Whole-branch verification (controller)

**Executor:** the controller (not a subagent): needs a browser to compare pictures.

- [ ] **Step 1: Full CI parity.** Run `npm run lint && npm test && npm run build`. Expected: all PASS, `dist/` and `build/server/` produced.
- [ ] **Step 2: Compare before and after.** Run the app from the pre-change commit (`git stash`-free: use `git worktree add ../ruang-before fecebe2` and `npm run dev` there on another port, or the installed build) and from this branch. With the 3D office open in both, screenshot lantai 1 and lantai 2 at the default camera and compare: walls, floors, rugs, furniture, windows, stairs, outdoors, vendors, trees must match, in both light and dark themes. Any difference is a bug in `default-scene.ts` or `scene-renderer.tsx`.
- [ ] **Step 3: Exercise the patch.** `curl -X PUT -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3001' --data '{"version":1,"overrides":{"sofa":{"position":[2,0,-1.3]},"desk-1":{"position":[-2,0,-1.5]}},"added":[{"id":"extra-plant","kind":"prop","level":0,"type":"Plant","position":[0,0,2]},{"id":"deck-3","kind":"floor","level":5.6,"y":5.6,"min":[-4,-4],"max":[4,4],"surface":{"type":"wood","repeat":[4,4]}}]}' http://127.0.0.1:3001/api/scene`. Reload: the sofa and desk moved, the plant appears, a third floor tab appears (empty slab; agents do not walk there yet). `DELETE /api/scene` restores the stock office.
- [ ] **Step 4: Refresh the graph.** Run `graphify update .` (per `CLAUDE.md`).
- [ ] **Step 5: Whole-branch review.** Dispatch the final reviewer over the full diff against the spec.
