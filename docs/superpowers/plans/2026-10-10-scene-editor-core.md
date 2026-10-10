# Scene Editor Core (2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Edit mode to the 3D office: select, drag, rotate, delete and re-floor the objects (props and windows), with undo/redo, save and reset, on top of the existing scene patch API.

**Architecture:** The editor state is a draft `ScenePatch`; every operation is a pure function patch to patch (`scene-edit.ts`), held by a hook with undo/redo and save/reset (`use-scene-editor.ts`). What is drawn is always `applyPatch(defaultScene, draft)`. Pointer handling is an R3F wrapper around each editable item (`edit-layer.tsx`); the bar and the object panel are plain DOM components. The server is unchanged.

**Tech Stack:** TypeScript, React 19, React Three Fiber / three, Vitest (jsdom for components and the hook). `src/` only (`.ts`/`.tsx` import suffixes).

**Spec:** `docs/superpowers/specs/2026-10-10-scene-editor-core-design.md` (read it first).

## Global Constraints

- `src/` only: no change under `server/`; `API_VERSION` stays 14 in both files. No new dependencies.
- Import suffixes `.ts`/`.tsx` in `src/`; tests sit next to sources; tests needing a DOM start with `// @vitest-environment jsdom` and set `IS_REACT_ACT_ENVIRONMENT = true` (see `src/pages/SkinEditor.test.tsx`).
- UI labels are English (like the rest of the app). Grid is 0.25 m, rotation step 15° (`Math.PI / 12`), undo history capped at 100 steps.
- Editable kinds are only `prop` and `window`. `desk-N` / `bed-N` can be moved but never deleted.
- Every number the editor writes into a patch is finite and within ±1000 (the server rejects anything else); positions are clamped to `layout.pan`.
- The `default-scene` snapshots (`src/scene3d/__snapshots__/default-scene.test.ts.snap`) must not change.
- Every task leaves `npx tsc -b`, `npm run lint` and its own tests green; the full `npm test` is green before each commit. Commit only the files a task lists (`git add <files>`, never `git add -A`).
- Commit messages end with these two lines:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_016wWeU3GcBGyx7UYE38mQXj`
- Work happens in an isolated worktree on a new branch from local `main` (created at execution time); do not touch the uncommitted `.claude/` directory in the main checkout.

## Review Focus

Failure modes the spec implies that a person using the editor will hit, each pinned by a test in the task that owns the code:

1. Deleting a desk or a bed (key or button) must do nothing, and moving one must work (Task 1 tests; Task 3 disabled button).
2. A typed value that is empty, not a number, or beyond ±1000 in the object panel must be rejected and the field must revert (Task 3 test).
3. A failed save (HTTP 400/403 or a network error) must keep the draft, stay dirty and show a message; a second Save while one is in flight must be ignored (Task 2 tests).
4. Undo after Delete must bring the object back (and a stale selection must not crash the panel); leaving Edit with unsaved changes must ask first (Task 2 test for undo; Task 4 for the confirm and the derived selection).
5. Dragging or typing a position outside the office must clamp to the pan bounds, including with Alt (free placement) (Task 1 test; Task 4 wiring).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/scene3d/scene.ts` | add `isSeatId` (export of the seat id test) |
| `src/scene3d/scene-edit.ts` (new) | pure edit operations, `snap`, `editKeyAction`, `isEditable`, `canDelete` |
| `src/scene3d/scene-edit.test.ts` (new) | tests for the above |
| `src/scene3d/use-scene-editor.ts` (new) | the editor hook: draft, history, drag preview, save, reset |
| `src/scene3d/use-scene-editor.test.tsx` (new) | hook tests under jsdom |
| `src/pages/EditorBar.tsx`, `src/pages/ObjectPanel.tsx` (new) | DOM bar and object panel |
| `src/pages/EditorBar.test.tsx`, `src/pages/ObjectPanel.test.tsx` (new) | component tests |
| `src/styles.css` | bar and panel rules |
| `src/scene3d/scene-renderer.tsx` | optional `wrap` prop |
| `src/scene3d/edit-layer.tsx` (new) | `EditTarget` (pointer handling, selection box) and `EditHandlers` |
| `src/scene3d/use-scene.ts` | return `{ patch, refresh }` |
| `src/pages/Office3D.tsx` | Edit button, wiring, `Controls enabled`, shortcuts |
| `README.md` | document the editor |

---

### Task 1: Pure edit operations

**Suggested executor:** `haiku-worker` (complete code, pure functions).

**Files:**
- Modify: `src/scene3d/scene.ts` (one export), `src/scene3d/scene.test.ts` (one test)
- Create: `src/scene3d/scene-edit.ts`
- Test: `src/scene3d/scene-edit.test.ts`

**Interfaces:**
- Consumes: `PropItem`, `WindowItem`, `SceneItem`, `ScenePatch`, `EMPTY_PATCH` from `scene.ts`.
- Produces (exact names, later tasks import them): from `scene.ts`: `isSeatId(id: string): boolean`. From `scene-edit.ts`: `EditableItem`, `isEditable`, `canDelete`, `GRID`, `ROTATION_STEP`, `snap`, `Bounds`, `moveItem`, `rotateItem`, `rotateBy`, `deleteItem`, `setItemLevel`, `EditKeyAction`, `editKeyAction`.

- [ ] **Step 1: Write the failing tests**

Add to the end of `src/scene3d/scene.test.ts` (and add `isSeatId` to its import from `./scene.ts`):

```ts
describe('isSeatId', () => {
  it('recognises the crew desk and bed ids only', () => {
    expect(isSeatId('desk-3')).toBe(true)
    expect(isSeatId('bed-12')).toBe(true)
    expect(isSeatId('tree-1')).toBe(false)
    expect(isSeatId('desk-x')).toBe(false)
    expect(isSeatId('light-desk-1')).toBe(false)
  })
})
```

Create `src/scene3d/scene-edit.test.ts`:

```ts
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
    expect(rotateBy(EMPTY_PATCH, lamp, ROTATION_STEP).overrides['my-lamp']).toEqual({ rotation: 0.5236 })
    expect(rotateBy(EMPTY_PATCH, sofa, -ROTATION_STEP).overrides.sofa).toEqual({ rotation: 2.618 })
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scene3d/scene.test.ts src/scene3d/scene-edit.test.ts`
Expected: FAIL (`isSeatId` is not exported, `./scene-edit.ts` cannot be resolved).

- [ ] **Step 3: Write the implementation**

In `src/scene3d/scene.ts`, directly after the `const SEAT_ID = ...` line, add:

```ts
/** True for the crew's `desk-N` / `bed-N` ids. */
export const isSeatId = (id: string): boolean => SEAT_ID.test(id)
```

Create `src/scene3d/scene-edit.ts`:

```ts
import { isSeatId, type PropItem, type SceneItem, type ScenePatch, type WindowItem } from './scene.ts'

// The editor's operations on a draft ScenePatch. Each takes the patch and the item as it is drawn
// now (defaults plus patch) and returns a new patch; nothing is mutated. Stock items change through
// `overrides[id]`, items the user added are edited in place in `added`.

/** What the editor can select and move: props and windows. Structure waits for the 2b handles. */
export type EditableItem = PropItem | WindowItem
export const isEditable = (item: SceneItem): item is EditableItem => item.kind === 'prop' || item.kind === 'window'
/** Desks and beds follow the number of agents: they can be moved but not deleted. */
export const canDelete = (item: SceneItem): boolean => !isSeatId(item.id)

export const GRID = 0.25
export const ROTATION_STEP = Math.PI / 12
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

const TAU = Math.PI * 2
// Four decimals keeps saved numbers small; `+ 0` turns -0 into 0.
const round4 = (value: number): number => Number(value.toFixed(4)) + 0
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

export const snap = (value: number, step = GRID): number => round4(Math.round(value / step) * step)

function normalizeAngle(radians: number): number {
  const rounded = round4(((radians % TAU) + TAU) % TAU)
  return rounded >= round4(TAU) ? 0 : rounded
}

function patchItem(patch: ScenePatch, id: string, fields: Partial<SceneItem>): ScenePatch {
  if (patch.added.some((item) => item.id === id)) {
    return { ...patch, added: patch.added.map((item) => (item.id === id ? { ...item, ...fields } as SceneItem : item)) }
  }
  const current = patch.overrides[id]
  return { ...patch, overrides: { ...patch.overrides, [id]: { ...(current && typeof current === 'object' ? current : {}), ...fields } } }
}

export function moveItem(patch: ScenePatch, item: EditableItem, x: number, z: number, bounds?: Bounds): ScenePatch {
  const px = round4(bounds ? clamp(x, bounds.minX, bounds.maxX) : x)
  const pz = round4(bounds ? clamp(z, bounds.minZ, bounds.maxZ) : z)
  return patchItem(patch, item.id, { position: [px, item.position[1], pz] })
}

export const rotateItem = (patch: ScenePatch, item: EditableItem, radians: number): ScenePatch => patchItem(patch, item.id, { rotation: normalizeAngle(radians) })
export const rotateBy = (patch: ScenePatch, item: EditableItem, delta: number): ScenePatch => rotateItem(patch, item, (item.rotation ?? 0) + delta)

export function deleteItem(patch: ScenePatch, item: SceneItem): ScenePatch {
  if (!canDelete(item)) return patch
  if (patch.added.some((added) => added.id === item.id)) return { ...patch, added: patch.added.filter((added) => added.id !== item.id) }
  return { ...patch, overrides: { ...patch.overrides, [item.id]: null } }
}

/** Puts an item on another floor: its level changes and its height shifts by the same difference. */
export function setItemLevel(patch: ScenePatch, item: EditableItem, level: number): ScenePatch {
  if (level === item.level) return patch
  const [x, y, z] = item.position
  return patchItem(patch, item.id, { level, position: [x, round4(y + (level - item.level)), z] })
}

export type EditKeyAction = 'undo' | 'redo' | 'delete' | 'rotate+' | 'rotate-' | 'deselect'

export function editKeyAction(event: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): EditKeyAction | null {
  const key = event.key.toLowerCase()
  if (event.ctrlKey || event.metaKey) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
    return key === 'y' ? 'redo' : null
  }
  if (key === 'delete' || key === 'backspace') return 'delete'
  if (key === 'r') return event.shiftKey ? 'rotate-' : 'rotate+'
  return key === 'escape' ? 'deselect' : null
}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npx vitest run src/scene3d/scene.test.ts src/scene3d/scene-edit.test.ts && npx tsc -b && npm run lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/scene.ts src/scene3d/scene.test.ts src/scene3d/scene-edit.ts src/scene3d/scene-edit.test.ts
git commit -m "feat(editor): pure edit operations on the scene patch"
```
(append the two trailer lines from Global Constraints to the message).

---

### Task 2: The editor hook

**Suggested executor:** default model (hook state and async save, tested under jsdom).

**Files:**
- Create: `src/scene3d/use-scene-editor.ts`
- Test: `src/scene3d/use-scene-editor.test.tsx`

**Interfaces:**
- Consumes: `EMPTY_PATCH`, `ScenePatch` from `scene.ts`.
- Produces: `SceneEditor` (interface) and `useSceneEditor(saved: ScenePatch, refresh: () => void, request?: typeof fetch): SceneEditor`.
  `SceneEditor` fields: `editing`, `draft`, `selectedId`, `drag` (`{ id; x; z } | null`), `canUndo`, `canRedo`, `dirty`, `saving`, `error`, and functions `enter()`, `exit()`, `select(id | null)`, `apply(change: (patch) => ScenePatch)`, `undo()`, `redo()`, `previewDrag(id, x, z)`, `endDrag()`, `save(): Promise<void>`, `reset(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `src/scene3d/use-scene-editor.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'
import { useSceneEditor, type SceneEditor } from './use-scene-editor.ts'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const saved: ScenePatch = { version: 1, overrides: { sofa: { rotation: 1 } }, added: [] }
const edit = (n: number) => (patch: ScenePatch): ScenePatch => ({ ...patch, overrides: { ...patch.overrides, counter: { rotation: n } } })

afterEach(() => { document.body.replaceChildren() })

async function mount(request: ReturnType<typeof vi.fn> = vi.fn(), refresh = vi.fn()) {
  const out: { current: SceneEditor | null } = { current: null }
  function Harness() {
    const editor = useSceneEditor(saved, refresh, request as unknown as typeof fetch)
    useEffect(() => { out.current = editor })
    return null
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => { root.render(<Harness/>) })
  const editor = () => out.current!
  const run = (fn: (editor: SceneEditor) => unknown) => act(async () => { await fn(editor()) })
  return { editor, run, request, refresh }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('useSceneEditor', () => {
  it('starts from the saved patch when editing begins, and is not dirty', async () => {
    const { editor, run } = await mount()
    expect(editor().editing).toBe(false)
    await run((e) => e.enter())
    expect(editor().editing).toBe(true)
    expect(editor().draft).toEqual(saved)
    expect(editor().dirty).toBe(false)
    expect(editor().canUndo).toBe(false)
  })

  it('applies changes, undoes and redoes them in order, and drops redo after a new change', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    await run((e) => e.apply(edit(2)))
    expect(editor().dirty).toBe(true)
    expect(editor().draft.overrides.counter).toEqual({ rotation: 2 })
    await run((e) => e.undo())
    expect(editor().draft.overrides.counter).toEqual({ rotation: 1 })
    expect(editor().canRedo).toBe(true)
    await run((e) => e.redo())
    expect(editor().draft.overrides.counter).toEqual({ rotation: 2 })
    await run((e) => e.undo())
    await run((e) => e.apply(edit(3)))
    expect(editor().canRedo).toBe(false)
    await run((e) => e.undo())
    await run((e) => e.undo())
    expect(editor().draft).toEqual(saved)
    expect(editor().dirty).toBe(false)
    expect(editor().canUndo).toBe(false)
  })

  it('ignores a change that returns the same patch (nothing to undo)', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.apply((patch) => patch))
    expect(editor().canUndo).toBe(false)
    expect(editor().dirty).toBe(false)
  })

  it('keeps at most 100 undo steps', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    for (let n = 1; n <= 105; n += 1) await run((e) => e.apply(edit(n)))
    for (let n = 0; n < 100; n += 1) await run((e) => e.undo())
    expect(editor().canUndo).toBe(false)
    expect(editor().draft.overrides.counter).toEqual({ rotation: 5 })
  })

  it('keeps the live drag position out of the history until it ends', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.previewDrag('sofa', 3, 4))
    expect(editor().drag).toEqual({ id: 'sofa', x: 3, z: 4 })
    expect(editor().canUndo).toBe(false)
    await run((e) => e.endDrag())
    expect(editor().drag).toBeNull()
  })

  it('saves the draft with PUT, becomes clean, and refreshes the scene', async () => {
    const request = vi.fn().mockResolvedValue(json(saved))
    const { editor, run, refresh } = await mount(request)
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    await run((e) => e.save())
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]
    expect(url).toBe('/api/scene')
    expect(init).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(init.body)).toEqual(edit(1)(saved))
    expect(editor().dirty).toBe(false)
    expect(editor().saving).toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ignores a second save while one is in flight', async () => {
    let finish: (response: Response) => void = () => {}
    const request = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finish = resolve }))
    const { editor, run } = await mount(request)
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    let first: Promise<void> = Promise.resolve()
    await act(async () => { first = editor().save() })
    expect(editor().saving).toBe(true)
    await run((e) => e.save())
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => { finish(json(saved)); await first })
    expect(editor().saving).toBe(false)
  })

  it('keeps the draft and shows the server message when a save fails', async () => {
    const request = vi.fn().mockResolvedValue(json({ error: 'Forbidden.' }, 403))
    const { editor, run, refresh } = await mount(request)
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    await run((e) => e.save())
    expect(editor().error).toBe('Save failed: Forbidden.')
    expect(editor().dirty).toBe(true)
    expect(editor().saving).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps the draft and says so when the network fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('offline'))
    const { editor, run } = await mount(request)
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    await run((e) => e.save())
    expect(editor().error).toBe('offline')
    expect(editor().dirty).toBe(true)
    await run((e) => e.apply(edit(2)))
    expect(editor().error).toBeNull()
  })

  it('resets with DELETE to an empty patch, and keeps the draft if that fails', async () => {
    const request = vi.fn().mockResolvedValueOnce(json({ error: 'nope' }, 500)).mockResolvedValueOnce(json({ ok: true }))
    const { editor, run, refresh } = await mount(request)
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    await run((e) => e.reset())
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'DELETE' })
    expect(editor().error).toBe('Reset failed: nope')
    expect(editor().draft.overrides.counter).toEqual({ rotation: 1 })
    await run((e) => e.reset())
    expect(editor().draft).toEqual(EMPTY_PATCH)
    expect(editor().dirty).toBe(false)
    expect(editor().canUndo).toBe(false)
    expect(editor().editing).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('discards the draft on exit and starts from the saved patch again on enter', async () => {
    const { editor, run } = await mount()
    await run((e) => e.enter())
    await run((e) => e.apply(edit(1)))
    await run((e) => e.exit())
    expect(editor().editing).toBe(false)
    await run((e) => e.enter())
    expect(editor().draft).toEqual(saved)
    expect(editor().canUndo).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scene3d/use-scene-editor.test.tsx`
Expected: FAIL (cannot resolve `./use-scene-editor.ts`).

- [ ] **Step 3: Write the implementation**

Create `src/scene3d/use-scene-editor.ts`:

```ts
import { useCallback, useRef, useState } from 'react'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

// The editing session for the 3D office: a draft ScenePatch with undo/redo, a live drag position,
// and Save / Reset against /api/scene. Edits are pure patch to patch functions (scene-edit.ts).

const MAX_HISTORY = 100

interface State {
  editing: boolean
  draft: ScenePatch
  /** The patch as last saved (or loaded when editing began); `dirty` compares the draft with it. */
  baseline: ScenePatch
  past: ScenePatch[]
  future: ScenePatch[]
  selectedId: string | null
  drag: { id: string; x: number; z: number } | null
  saving: boolean
  error: string | null
}

const fresh = (patch: ScenePatch): State => ({ editing: false, draft: patch, baseline: patch, past: [], future: [], selectedId: null, drag: null, saving: false, error: null })
const same = (a: ScenePatch, b: ScenePatch): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

async function failure(response: Response, prefix: string): Promise<string> {
  const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  return typeof body?.error === 'string' ? `${prefix}: ${body.error}` : `${prefix} (HTTP ${response.status})`
}

export interface SceneEditor {
  editing: boolean
  draft: ScenePatch
  selectedId: string | null
  drag: { id: string; x: number; z: number } | null
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
  saving: boolean
  error: string | null
  enter: () => void
  exit: () => void
  select: (id: string | null) => void
  apply: (change: (patch: ScenePatch) => ScenePatch) => void
  undo: () => void
  redo: () => void
  previewDrag: (id: string, x: number, z: number) => void
  endDrag: () => void
  save: () => Promise<void>
  reset: () => Promise<void>
}

export function useSceneEditor(saved: ScenePatch, refresh: () => void, request?: typeof fetch): SceneEditor {
  const [state, setState] = useState<State>(() => fresh(saved))
  // Callbacks read the latest values through refs so they stay stable between renders.
  const latest = useRef(state)
  latest.current = state
  const savedRef = useRef(saved)
  savedRef.current = saved
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const requestRef = useRef(request)
  requestRef.current = request

  const enter = useCallback(() => setState({ ...fresh(savedRef.current), editing: true }), [])
  const exit = useCallback(() => setState((s) => fresh(s.baseline)), [])
  const select = useCallback((id: string | null) => setState((s) => ({ ...s, selectedId: id })), [])

  const apply = useCallback((change: (patch: ScenePatch) => ScenePatch) => setState((s) => {
    const next = change(s.draft)
    if (next === s.draft) return s
    return { ...s, draft: next, past: [...s.past, s.draft].slice(-MAX_HISTORY), future: [], error: null }
  }), [])
  const undo = useCallback(() => setState((s) => (s.past.length === 0 ? s : { ...s, draft: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [...s.future, s.draft] })), [])
  const redo = useCallback(() => setState((s) => (s.future.length === 0 ? s : { ...s, draft: s.future[s.future.length - 1], future: s.future.slice(0, -1), past: [...s.past, s.draft] })), [])

  const previewDrag = useCallback((id: string, x: number, z: number) => setState((s) => ({ ...s, drag: { id, x, z } })), [])
  const endDrag = useCallback(() => setState((s) => (s.drag ? { ...s, drag: null } : s)), [])

  const send = useCallback((init: RequestInit) => (requestRef.current ?? fetch)('/api/scene', init), [])

  const save = useCallback(async () => {
    const { draft, saving } = latest.current
    if (saving) return
    setState((s) => ({ ...s, saving: true, error: null }))
    try {
      const response = await send({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
      if (!response.ok) throw new Error(await failure(response, 'Save failed'))
      setState((s) => ({ ...s, baseline: draft, saving: false }))
      refreshRef.current()
    } catch (error) {
      setState((s) => ({ ...s, saving: false, error: error instanceof Error ? error.message : 'Save failed' }))
    }
  }, [send])

  const reset = useCallback(async () => {
    if (latest.current.saving) return
    setState((s) => ({ ...s, saving: true, error: null }))
    try {
      const response = await send({ method: 'DELETE' })
      if (!response.ok) throw new Error(await failure(response, 'Reset failed'))
      setState({ ...fresh(EMPTY_PATCH), editing: true })
      refreshRef.current()
    } catch (error) {
      setState((s) => ({ ...s, saving: false, error: error instanceof Error ? error.message : 'Reset failed' }))
    }
  }, [send])

  return {
    editing: state.editing, draft: state.draft, selectedId: state.selectedId, drag: state.drag,
    canUndo: state.past.length > 0, canRedo: state.future.length > 0,
    dirty: !same(state.draft, state.baseline), saving: state.saving, error: state.error,
    enter, exit, select, apply, undo, redo, previewDrag, endDrag, save, reset,
  }
}
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npx vitest run src/scene3d/use-scene-editor.test.tsx && npx tsc -b && npm run lint`
Expected: PASS. (If lint objects to the refs written during render, keep the pattern: `src/pages/SkinEditor.tsx` does the same. If the test file needs an `act` environment tweak, follow `SkinEditor.test.tsx`.)

- [ ] **Step 5: Commit**

```bash
git add src/scene3d/use-scene-editor.ts src/scene3d/use-scene-editor.test.tsx
git commit -m "feat(editor): editing session hook with undo/redo, save and reset"
```
(append the two trailer lines).

---

### Task 3: Editor bar and object panel

**Suggested executor:** `haiku-worker` writes the components from the code below; default-model review.

**Files:**
- Create: `src/pages/EditorBar.tsx`, `src/pages/ObjectPanel.tsx`
- Test: `src/pages/EditorBar.test.tsx`, `src/pages/ObjectPanel.test.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `EditableItem`, `canDelete` from `scene-edit.ts`; `levelName` from `level-names.ts`.
- Produces:
  `EditorBar({ canUndo, canRedo, dirty, saving, error, onUndo, onRedo, onSave, onReset, onDone })`;
  `ObjectPanel({ item, levels, onMove(x, z), onRotate(degrees), onLevel(level), onDelete })`.

- [ ] **Step 1: Write the failing tests**

Create `src/pages/EditorBar.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EditorBar } from './EditorBar.tsx'

const noop = () => {}
const bar = (props: Partial<Parameters<typeof EditorBar>[0]> = {}) => renderToStaticMarkup(
  <EditorBar canUndo={false} canRedo={false} dirty={false} saving={false} error={null} onUndo={noop} onRedo={noop} onSave={noop} onReset={noop} onDone={noop} {...props}/>,
)

describe('EditorBar', () => {
  it('disables Undo, Redo and Save when there is nothing to do', () => {
    const markup = bar()
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^<]*Undo/)
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^<]*Redo/)
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Save/)
    expect(markup).toContain('saved')
    expect(markup).toContain("Walking routes don&#x27;t follow moved furniture yet")
  })

  it('enables them once there are changes, and shows the unsaved marker', () => {
    const markup = bar({ canUndo: true, canRedo: true, dirty: true })
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*Undo/)
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Save/)
    expect(markup).toContain('unsaved')
  })

  it('shows Saving… and blocks Save and Reset while saving, and shows an error as an alert', () => {
    const saving = bar({ dirty: true, saving: true })
    expect(saving).toContain('Saving…')
    expect(saving).toMatch(/<button[^>]*disabled[^>]*>Saving…/)
    expect(saving).toMatch(/<button[^>]*disabled[^>]*>Reset to default/)
    expect(bar({ error: 'Save failed: Forbidden.' })).toMatch(/role="alert"[^>]*>Save failed: Forbidden\./)
  })
})
```

Create `src/pages/ObjectPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropItem } from '../scene3d/scene.ts'
import { ObjectPanel } from './ObjectPanel.tsx'

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const sofa: PropItem = { kind: 'prop', id: 'sofa', level: 0, type: 'Sofa', position: [4.6, 0, -1.3], rotation: Math.PI }
const desk: PropItem = { kind: 'prop', id: 'desk-1', level: 0, type: 'WorkDesk', position: [-2, 0, -3.5] }

afterEach(() => { document.body.replaceChildren() })

async function mount(item: PropItem) {
  const handlers = { onMove: vi.fn(), onRotate: vi.fn(), onLevel: vi.fn(), onDelete: vi.fn() }
  const host = document.body.appendChild(document.createElement('div'))
  await act(async () => { createRoot(host).render(<ObjectPanel item={item} levels={[0, 2.8]} {...handlers}/>) })
  const input = (label: string) => [...host.querySelectorAll('label')].find((node) => node.textContent?.startsWith(label))!.querySelector('input')!
  const type = async (field: HTMLInputElement, value: string) => {
    await act(async () => { field.value = value; field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  }
  return { host, handlers, input, type }
}

describe('ObjectPanel', () => {
  it('shows the object, its position, rotation and floor', async () => {
    const { host, input } = await mount(sofa)
    expect(host.textContent).toContain('Sofa')
    expect(host.textContent).toContain('sofa')
    expect(input('X').value).toBe('4.6')
    expect(input('Z').value).toBe('-1.3')
    expect(input('Rotation').value).toBe('180')
    const select = host.querySelector('select')!
    expect(select.value).toBe('0')
    expect([...select.options].map((option) => option.textContent)).toEqual(['Kantor', 'Kamar & Balkon'])
  })

  it('commits a typed X, Z and rotation when the field loses focus', async () => {
    const { handlers, input, type } = await mount(sofa)
    await type(input('X'), '5')
    expect(handlers.onMove).toHaveBeenLastCalledWith(5, -1.3)
    await type(input('Z'), '2.5')
    expect(handlers.onMove).toHaveBeenLastCalledWith(4.6, 2.5)
    await type(input('Rotation'), '90')
    expect(handlers.onRotate).toHaveBeenLastCalledWith(90)
  })

  it('does not commit an unchanged value, and rejects empty, non-numeric or out-of-range input', async () => {
    const { handlers, input, type } = await mount(sofa)
    await type(input('X'), '4.6')
    for (const bad of ['', 'abc', '5000', '-1001']) {
      await type(input('X'), bad)
      expect(input('X').value).toBe('4.6')
    }
    expect(handlers.onMove).not.toHaveBeenCalled()
  })

  it('moves the item to another floor from the select', async () => {
    const { host, handlers } = await mount(sofa)
    const select = host.querySelector('select')!
    await act(async () => { select.value = '2.8'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(handlers.onLevel).toHaveBeenCalledWith(2.8)
  })

  it('deletes ordinary objects but not desks or beds', async () => {
    const ordinary = await mount(sofa)
    const button = [...ordinary.host.querySelectorAll('button')].find((node) => node.textContent === 'Delete')!
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(ordinary.handlers.onDelete).toHaveBeenCalledTimes(1)
    document.body.replaceChildren()
    const seat = await mount(desk)
    const locked = [...seat.host.querySelectorAll('button')].find((node) => node.textContent === 'Delete')!
    expect(locked.disabled).toBe(true)
    expect(locked.title).toBe('Desks and beds follow the number of agents')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/EditorBar.test.tsx src/pages/ObjectPanel.test.tsx`
Expected: FAIL (components do not exist).

- [ ] **Step 3: Write the components**

Create `src/pages/EditorBar.tsx`:

```tsx
export interface EditorBarProps {
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
  saving: boolean
  error: string | null
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onReset: () => void
  onDone: () => void
}

/** The bar shown while editing the office: undo/redo, save state, save, reset and done. */
export function EditorBar({ canUndo, canRedo, dirty, saving, error, onUndo, onRedo, onSave, onReset, onDone }: EditorBarProps) {
  return <div className="office-3d-editbar" role="toolbar" aria-label="Office editor">
    <div className="office-3d-editbar-row">
      <button type="button" disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl/Cmd+Z)">↶ Undo</button>
      <button type="button" disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl/Cmd+Shift+Z)">↷ Redo</button>
      <span className={`office-3d-editstate${dirty ? ' unsaved' : ''}`}>{dirty ? '● unsaved' : 'saved'}</span>
      <button type="button" disabled={!dirty || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>
      <button type="button" disabled={saving} onClick={onReset} title="Remove every saved edit and go back to the stock office">Reset to default</button>
      <button type="button" onClick={onDone}>Done</button>
    </div>
    <small>Walking routes don't follow moved furniture yet (desks and beds do).</small>
    {error && <small className="office-3d-editerror" role="alert">{error}</small>}
  </div>
}
```

Create `src/pages/ObjectPanel.tsx`:

```tsx
import { levelName } from '../scene3d/level-names.ts'
import { canDelete, type EditableItem } from '../scene3d/scene-edit.ts'

const LIMIT = 1000
const fmt = (value: number): string => String(Math.round(value * 100) / 100)
const degrees = (radians: number | undefined): number => Math.round(((radians ?? 0) * 180) / Math.PI) % 360

/** A number input that commits on blur or Enter; empty, non-numeric or out-of-range text reverts. */
function NumberField({ label, value, step, onCommit }: { label: string; value: number; step: number; onCommit: (value: number) => void }) {
  return <label>{label}
    <input type="number" step={step} defaultValue={fmt(value)} key={value}
      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      onBlur={(event) => {
        const text = event.currentTarget.value.trim()
        const next = Number(text)
        if (text === '' || !Number.isFinite(next) || Math.abs(next) > LIMIT) { event.currentTarget.value = fmt(value); return }
        if (next !== Number(fmt(value))) onCommit(next)
      }}/>
  </label>
}

export interface ObjectPanelProps {
  item: EditableItem
  levels: number[]
  onMove: (x: number, z: number) => void
  onRotate: (degrees: number) => void
  onLevel: (level: number) => void
  onDelete: () => void
}

/** Position, rotation, floor and delete for the selected object. */
export function ObjectPanel({ item, levels, onMove, onRotate, onLevel, onDelete }: ObjectPanelProps) {
  const x = item.position[0]
  const z = item.position[2]
  const deletable = canDelete(item)
  return <aside className="office-3d-objpanel" aria-label="Selected object">
    <h3>{item.kind === 'prop' ? item.type : 'Window'} <small>{item.id}</small></h3>
    <div className="office-3d-objpanel-grid">
      <NumberField label="X (m)" value={x} step={0.05} onCommit={(next) => onMove(next, z)}/>
      <NumberField label="Z (m)" value={z} step={0.05} onCommit={(next) => onMove(x, next)}/>
      <NumberField label="Rotation (°)" value={degrees(item.rotation)} step={15} onCommit={onRotate}/>
    </div>
    <label>Floor
      <select value={item.level} onChange={(event) => onLevel(Number(event.target.value))}>
        {levels.map((level, index) => <option key={level} value={level}>{levelName(level, index).label}</option>)}
      </select>
    </label>
    <button type="button" className="danger" disabled={!deletable} title={deletable ? 'Delete (Del)' : 'Desks and beds follow the number of agents'} onClick={onDelete}>Delete</button>
  </aside>
}
```

Append to `src/styles.css` (after the `.office-3d-tools` rules, near line 500):

```css
.office-3d-editbar { align-items: center; background: rgba(18, 26, 24, 0.86); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 8px; color: #f4efe6; display: grid; font-size: 12px; gap: 4px; justify-items: center; left: 50%; padding: 6px 10px; position: absolute; top: 10px; transform: translateX(-50%); z-index: 3; }
.office-3d-editbar-row { align-items: center; display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
.office-3d-editbar button, .office-3d-objpanel button { background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 6px; color: inherit; cursor: pointer; font: inherit; padding: 4px 9px; }
.office-3d-editbar button:disabled, .office-3d-objpanel button:disabled { cursor: not-allowed; opacity: .45; }
.office-3d-editstate { color: #b7c9bf; }
.office-3d-editstate.unsaved { color: #f5bd6d; }
.office-3d-editbar small { color: #b7c9bf; }
.office-3d-editerror { color: #ff9b94 !important; }
.office-3d-objpanel { background: rgba(18, 26, 24, 0.86); border: 1px solid rgba(255, 255, 255, 0.22); border-radius: 8px; color: #f4efe6; display: grid; font-size: 12px; gap: 8px; padding: 10px; position: absolute; right: 10px; top: 64px; width: 220px; z-index: 3; }
.office-3d-objpanel h3 { font-size: 13px; margin: 0; }
.office-3d-objpanel h3 small { color: #b7c9bf; font-weight: normal; margin-left: 4px; }
.office-3d-objpanel-grid { display: grid; gap: 6px; grid-template-columns: 1fr 1fr; }
.office-3d-objpanel label { color: #b7c9bf; display: grid; gap: 2px; }
.office-3d-objpanel input, .office-3d-objpanel select { background: #101815; border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 4px; color: #f4efe6; font: inherit; padding: 3px 5px; width: 100%; }
.office-3d-objpanel button.danger { border-color: #d9534f; color: #ff9b94; }
.office-stage:has(.office-panel) .office-3d-objpanel { right: min(424px, calc(100% - 12px)); }
@media (max-width: 700px) { .office-3d-editbar, .office-3d-objpanel, .office-3d-tools .edit-toggle { display: none; } }
```

- [ ] **Step 4: Run the tests, typecheck and lint**

Run: `npx vitest run src/pages/EditorBar.test.tsx src/pages/ObjectPanel.test.tsx && npx tsc -b && npm run lint`
Expected: PASS. (If the `renderToStaticMarkup` regexes do not match because React orders attributes differently, adjust the regexes, not the component; the assertions must still check disabled state per button.)

- [ ] **Step 5: Commit**

```bash
git add src/pages/EditorBar.tsx src/pages/EditorBar.test.tsx src/pages/ObjectPanel.tsx src/pages/ObjectPanel.test.tsx src/styles.css
git commit -m "feat(editor): editor bar and object panel"
```
(append the two trailer lines).

---

### Task 4: Wire the editor into Office 3D

**Suggested executor:** default model (integration; the pointer code cannot be unit-tested, so follow the code exactly and report any deviation).

**Files:**
- Modify: `src/scene3d/scene-renderer.tsx`, `src/scene3d/use-scene.ts`, `src/pages/Office3D.tsx`, `README.md`
- Create: `src/scene3d/edit-layer.tsx`

**Interfaces:**
- Consumes: everything produced by Tasks 1-3 (`scene-edit.ts`, `use-scene-editor.ts`, `EditorBar`, `ObjectPanel`).
- Produces: `SceneRenderer`'s optional `wrap?: (item: SceneItem, node: ReactNode) => ReactNode`; `EditHandlers` and `EditTarget` from `edit-layer.tsx`; `useScenePatch(): { patch: ScenePatch; refresh: () => void }`; `Controls` gets an `enabled: boolean` prop.

- [ ] **Step 1: Renderer `wrap` and `useScenePatch`**

In `src/scene3d/scene-renderer.tsx` change the imports to include `Fragment` and `ReactNode`:

```tsx
import { Fragment, type ComponentType, type ReactNode } from 'react'
```

and replace the `SceneRenderer` function with:

```tsx
/**
 * The items visible from `level`. `deskActive(id)` says whether the seat of a `desk-N` item is
 * occupied. `wrap` lets the editor surround an item's node (for picking) without the renderer
 * knowing about editing.
 */
export function SceneRenderer({ items, level, night, deskActive, wrap }: { items: SceneItem[]; level: number; night: boolean; deskActive?: (id: string) => boolean; wrap?: (item: SceneItem, node: ReactNode) => ReactNode }) {
  return <group>
    {items.filter((item) => visibleAt(item, level)).map((item) => {
      const node = <SceneNode item={item} night={night} active={deskActive?.(item.id) ?? false}/>
      return <Fragment key={item.id}>{wrap ? wrap(item, node) : node}</Fragment>
    })}
  </group>
}
```

Replace `src/scene3d/use-scene.ts` with:

```ts
import { usePolling } from '../polling.ts'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

/**
 * The saved scene edits and a way to reload them now. Pending or failed requests mean "no edits":
 * the stock office still renders.
 */
export function useScenePatch(): { patch: ScenePatch; refresh: () => void } {
  const request = usePolling<ScenePatch>('/api/scene', 30_000)
  return { patch: request.status === 'ready' ? request.data : EMPTY_PATCH, refresh: request.refresh }
}
```

- [ ] **Step 2: The edit layer**

Create `src/scene3d/edit-layer.tsx`:

```tsx
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useMemo, useRef, type ReactNode, type RefObject } from 'react'
import * as THREE from 'three'
import { snap, type Bounds, type EditableItem } from './scene-edit.ts'

/** What the 3D layer needs from the editor session (Office3D builds this from useSceneEditor). */
export interface EditHandlers {
  selectedId: string | null
  bounds: Bounds
  select: (id: string | null) => void
  /** True while the pointer is over an editable object, so the camera does not take the press. */
  setHover: (hover: boolean) => void
  setDragging: (dragging: boolean) => void
  previewDrag: (id: string, x: number, z: number) => void
  commitMove: (item: EditableItem, x: number, z: number) => void
  cancelDrag: () => void
}

/** A yellow box around the selected object, following its world bounds each frame. */
function SelectionBox({ target }: { target: RefObject<THREE.Group | null> }) {
  const box = useMemo(() => new THREE.Box3(), [])
  const helper = useMemo(() => new THREE.Box3Helper(box, new THREE.Color('#f5bd6d')), [box])
  useFrame(() => { if (target.current) box.setFromObject(target.current) })
  return <primitive object={helper}/>
}

/**
 * Makes one editable item pickable and draggable: press selects it, dragging moves it across the
 * horizontal plane at its own height (grid snap, Alt for free placement, clamped to the bounds).
 * The live position goes to previewDrag; one drag is one commitMove on release.
 */
export function EditTarget({ item, edit, children }: { item: EditableItem; edit: EditHandlers; children: ReactNode }) {
  const { camera, gl } = useThree()
  const group = useRef<THREE.Group>(null)
  const height = item.position[1]
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), [])
  const ray = useMemo(() => new THREE.Raycaster(), [])
  const hit = useMemo(() => new THREE.Vector3(), [])

  const pointOnPlane = (clientX: number, clientY: number): [number, number] | null => {
    const rect = gl.domElement.getBoundingClientRect()
    ray.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera)
    plane.constant = -height
    return ray.ray.intersectPlane(plane, hit) ? [hit.x, hit.z] : null
  }

  const onPointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (event.nativeEvent.button !== 0) return
    event.stopPropagation()
    edit.select(item.id)
    const start = pointOnPlane(event.nativeEvent.clientX, event.nativeEvent.clientY)
    if (!start) return
    const offset: [number, number] = [item.position[0] - start[0], item.position[2] - start[1]]
    const origin: [number, number] = [item.position[0], item.position[2]]
    let last = origin
    edit.setDragging(true)
    const move = (pointer: PointerEvent) => {
      const point = pointOnPlane(pointer.clientX, pointer.clientY)
      if (!point) return
      const raw: [number, number] = [point[0] + offset[0], point[1] + offset[1]]
      const free = pointer.altKey
      const x = Math.min(Math.max(free ? raw[0] : snap(raw[0]), edit.bounds.minX), edit.bounds.maxX)
      const z = Math.min(Math.max(free ? raw[1] : snap(raw[1]), edit.bounds.minZ), edit.bounds.maxZ)
      last = [x, z]
      edit.previewDrag(item.id, x, z)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      edit.setDragging(false)
      if (last[0] !== origin[0] || last[1] !== origin[1]) edit.commitMove(item, last[0], last[1])
      else edit.cancelDrag()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return <>
    <group ref={group} onPointerDown={onPointerDown}
      onPointerOver={(event) => { event.stopPropagation(); edit.setHover(true); document.body.style.cursor = 'grab' }}
      onPointerOut={() => { edit.setHover(false); document.body.style.cursor = '' }}>
      {children}
    </group>
    {edit.selectedId === item.id && <SelectionBox target={group}/>}
  </>
}
```

- [ ] **Step 3: Office3D wiring**

Edit `src/pages/Office3D.tsx`:

1. Imports. Keep the existing ones and add (next to the other `../scene3d/...` imports; keep `.ts`/`.tsx` suffixes):

```tsx
import { EditTarget, type EditHandlers } from '../scene3d/edit-layer.tsx'
import { deleteItem, editKeyAction, isEditable, moveItem, rotateBy, rotateItem, ROTATION_STEP, setItemLevel, type EditKeyAction } from '../scene3d/scene-edit.ts'
import { useSceneEditor } from '../scene3d/use-scene-editor.ts'
import { EditorBar } from './EditorBar.tsx'
import { ObjectPanel } from './ObjectPanel.tsx'
```

2. `Controls`: add `enabled: boolean` to the props type and destructuring (`{ panMode, keyTarget, layout, elevation, enabled }`), and add this effect directly after the effect that creates the `OrbitControls` (the one ending with `}, [camera, gl])`):

```tsx
  useEffect(() => {
    const orbit = controls.current
    if (orbit) orbit.enabled = enabled
  }, [enabled])
```

3. In `Office3D()`, replace `const patch = useScenePatch()` with:

```tsx
  const { patch: savedPatch, refresh: refreshScene } = useScenePatch()
  const editor = useSceneEditor(savedPatch, refreshScene)
  // While editing, the draft is the scene (the polled patch is ignored); otherwise the saved patch.
  const patch = editor.editing ? editor.draft : savedPatch
```

   and directly after the existing `const level = levels[levelIndex] ?? 0` line add:

```tsx
  const [hovering, setHovering] = useState(false)
  const [dragging, setDragging] = useState(false)
  const selectedItem = editor.selectedId ? items.find((item) => item.id === editor.selectedId) : undefined
  const selected = selectedItem && isEditable(selectedItem) ? selectedItem : undefined
  // The live drag position is drawn but not fed to the layout, so agents do not chase a desk mid-drag.
  const drawItems = useMemo(() => {
    const drag = editor.drag
    return drag ? items.map((item) => (item.id === drag.id && isEditable(item) ? { ...item, position: [drag.x, item.position[1], drag.z] as Vec3 } : item)) : items
  }, [items, editor.drag])
  const bounds = layout.pan
  const edit: EditHandlers = {
    selectedId: selected?.id ?? null,
    bounds,
    select: editor.select,
    setHover: setHovering,
    setDragging,
    previewDrag: editor.previewDrag,
    commitMove: (item, x, z) => { editor.apply((patchNow) => moveItem(patchNow, item, x, z, bounds)); editor.endDrag() },
    cancelDrag: editor.endDrag,
  }
  const selectAgent: typeof onSelect = editor.editing ? () => {} : onSelect
  const runEditAction = (action: EditKeyAction) => {
    if (action === 'undo') editor.undo()
    else if (action === 'redo') editor.redo()
    else if (action === 'deselect') editor.select(null)
    else if (!selected) return
    else if (action === 'delete') { editor.apply((patchNow) => deleteItem(patchNow, selected)); editor.select(null) }
    else editor.apply((patchNow) => rotateBy(patchNow, selected, action === 'rotate+' ? ROTATION_STEP : -ROTATION_STEP))
  }
  const finishEditing = () => {
    if (editor.dirty && !window.confirm('Discard unsaved changes?')) return
    setHovering(false)
    setDragging(false)
    document.body.style.cursor = ''
    editor.exit()
  }
  const resetEdits = () => {
    if (window.confirm('Reset the office to the default layout? This removes every saved edit.')) void editor.reset()
  }
```

4. Replace the root `<div className="office-3d" ...>`'s `onKeyDown` with:

```tsx
onKeyDown={(event) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((event.target as HTMLElement).tagName)
    if (editor.editing && !typing) {
      const action = editKeyAction(event)
      if (action) { event.preventDefault(); runEditAction(action); return }
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); setLevelIndex(Math.min(Math.max(levelIndex + (event.key === 'PageUp' ? 1 : -1), 0), levels.length - 1)) }
  }}
```

5. `<Canvas ...>`: add `onPointerMissed={editor.editing ? () => editor.select(null) : undefined}`. Replace the `<SceneRenderer .../>` line with:

```tsx
      <SceneRenderer items={drawItems} level={level} night={theme === 'dark'} deskActive={(id) => occupiedSeats.has(deskSeatNumber(id) ?? -1)} wrap={editor.editing ? (item, node) => (isEditable(item) ? <EditTarget item={item} edit={edit}>{node}</EditTarget> : node) : undefined}/>
```

   In each `<Character ... onSelect={onSelect} .../>` use `onSelect={selectAgent}`; in the label button use `onClick={(event) => selectAgent(station, event.currentTarget)}`. On `<Controls ...>` add `enabled={!(editor.editing && (hovering || dragging))}`.

6. In the tools div, add as the first button:

```tsx
      <button type="button" className={`edit-toggle${editor.editing ? ' active' : ''}`} aria-pressed={editor.editing} onClick={() => (editor.editing ? finishEditing() : editor.enter())} title="Rearrange the office">✎ Edit</button>
```

   and after the tools div (still inside the `.office-3d` root, after the canvas wrapper so the canvas stays its first child) add:

```tsx
    {editor.editing && <EditorBar canUndo={editor.canUndo} canRedo={editor.canRedo} dirty={editor.dirty} saving={editor.saving} error={editor.error} onUndo={editor.undo} onRedo={editor.redo} onSave={() => void editor.save()} onReset={resetEdits} onDone={finishEditing}/>}
    {editor.editing && selected && <ObjectPanel item={selected} levels={levels} onMove={(x, z) => editor.apply((patchNow) => moveItem(patchNow, selected, x, z, bounds))} onRotate={(degrees) => editor.apply((patchNow) => rotateItem(patchNow, selected, (degrees * Math.PI) / 180))} onLevel={(next) => { editor.apply((patchNow) => setItemLevel(patchNow, selected, next)); setLevelIndex(Math.max(0, levels.indexOf(next))) }} onDelete={() => { editor.apply((patchNow) => deleteItem(patchNow, selected)); editor.select(null) }}/>}
```

- [ ] **Step 4: README**

Add this section to `README.md` right after the "Office scene" section (before `## Agent skins`):

```markdown
### Editing the office

Press **✎ Edit** (bottom right of the 3D office) to rearrange it from the UI. Click an object or window to select it (a yellow box appears), drag it to move it (it snaps to a 0.25 m grid; hold **Alt** for free placement), press **R** (or **Shift+R**) to rotate by 15°, **Delete** to remove it, **Esc** to deselect, **Ctrl/Cmd+Z** and **Ctrl/Cmd+Shift+Z** to undo and redo. The panel at the top right has exact X, Z, rotation and floor fields. Desks and beds can be moved but not deleted (they follow the number of agents). **Save** writes your changes to the shared scene (see *Office scene*), **Reset to default** removes every saved edit, **Done** leaves edit mode (it asks if you have unsaved changes).

This first editor handles objects and windows only. Floors, walls, glass and new objects come later. Agents' walking routes still follow the stock layout, so a moved sofa does not re-route them (desks and beds do move their agents' seats).
```

- [ ] **Step 5: Verify**

Run: `npx tsc -b && npm run lint && npm test`
Expected: all PASS; the full suite includes the unchanged `default-scene` snapshots. If `tsc` rejects a snippet against the actual file, adapt minimally and list every deviation in the report. Also run the dev server smoke check: `RUANG_PORT=3099 npm run dev` in the background, `curl -s http://127.0.0.1:3099/api/scene`, stop it; say plainly that you did not load the page in a browser (the controller does the browser check).

- [ ] **Step 6: Commit**

```bash
git add src/scene3d/scene-renderer.tsx src/scene3d/use-scene.ts src/scene3d/edit-layer.tsx src/pages/Office3D.tsx README.md
git commit -m "feat(editor): Edit mode in Office 3D (select, drag, rotate, delete, floors, save)"
```
(append the two trailer lines).

---

### Task 5: Whole-branch verification (controller)

**Executor:** the controller (needs a browser).

- [ ] **Step 1: CI parity.** `npm run lint && npx tsc -b && npm test && npm run build`. Expected: all PASS.
- [ ] **Step 2: Real interaction check.** Build, start the app from the worktree on a spare port with a scratch `RUANG_DATA_DIR` (and the real Hermes data), and drive headless Chromium over CDP: open the Office, press `✎ Edit`, drag the sofa (mouse down/move/up on its screen position, found from a screenshot), check the object panel shows it and the sofa moved on a second screenshot, press `R`, press `Delete` on a plant and `Ctrl+Z` to bring it back, change the Floor select, Save, reload the page and confirm the saved patch (GET `/api/scene`) and that the sofa is where it was dropped, then Reset to default (accept the confirm) and confirm `GET /api/scene` is empty. Also confirm the camera still orbits when dragging empty space in edit mode, and that a desk's Delete button is disabled.
- [ ] **Step 3: Refresh the graph.** `graphify update .`.
- [ ] **Step 4: Whole-branch review** by the most capable reviewer, then one fix wave if needed.
