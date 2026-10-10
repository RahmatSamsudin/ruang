# Workplace editor, sub-project 2b: object palette, duplicate and properties

Date: 2026-10-10. Status: draft, awaiting review.

## Context

The workplace editor is four sub-projects (see `2026-10-10-scene-as-data-design.md`): scene as data
(done), editor UI (2a core, done; **2b this spec**), model import (3), agent navigation (4).

2a lets you select, drag, rotate, delete and re-floor the objects that already exist, with undo/redo,
save and reset. 2b adds the missing half for *objects*: put **new** ones in the office, **duplicate**
existing ones, and change their **properties** (size, length, colour).

2b is deliberately narrower than the original 2b idea: creating and resizing floors, walls and glass
(and the shell views a new storey needs) moves to a later sub-project (2c). Importing `.glb` models is
still sub-project 3.

Already in place and used as-is: `PROP_TYPES` (38 object types), `PropItem.props` (a free
`Record<string, number|string|boolean>` spread onto the component), `ScenePatch.added` (new items with
their own ids), server validation (`props` values: numbers within ±100 or strings or booleans, at most
16 keys; at most `MAX_ADDED` = 500 added items), the editor hook with draft/undo/redo/save, and the
`EditTarget`/drag machinery.

## Goals

- Put any of the 38 object types into the office from a palette, on the floor being viewed, as many as
  you like in a row.
- Duplicate the selected object with one action.
- Adjust the numeric and colour parameters of an object (stock or new) in the object panel.
- Saved, shared, undoable like every other edit. No server change; `API_VERSION` stays 14.

## Non-goals (2b)

- Floors, walls, glass, boxes, and the new-storey shell views (2c). Structure stays unselectable.
- Importing models (3); walking routes that avoid new objects (4).
- Multi-select, copy/paste across sessions, a "reset this object to default" control, editing a
  window's width or any item's height (Y). New objects get a sensible catalogue height (see below).
- New desks and beds as *agent seats*: seats stay the auto-generated `desk-N` / `bed-N`.

## Approach

All edits stay pure functions from a `ScenePatch` to a `ScenePatch` (the 2a rule), so undo/redo, save
and reset need no change. New code is a catalogue, three pure operations, a placement layer in the
canvas, a palette component and an extended object panel.

### Catalogue (`src/scene3d/prop-catalog.ts`)

`PROP_CATALOG: Record<PropType, PropEntry>`; the `Record` type makes a missing entry a compile error,
and a test also checks every `PROP_TYPES` key is present.

```ts
interface PropEntry {
  label: string                 // palette name, e.g. "Sofa"
  group: 'Furniture' | 'Kitchen' | 'Leisure' | 'Bedroom' | 'Outdoor' | 'Structure'
  y: number                     // height above the floor level a new one is placed at (0, or wall/ceiling height)
  defaults?: Record<string, PropValue>   // props a component needs (e.g. Railing length, Armchair colour)
  fields?: Field[]              // editable parameters shown in the object panel
}
type Field =
  | { key: string; label: string; kind: 'number'; min: number; max: number; step: number }
  | { key: string; label: string; kind: 'color' }
```

Rules:

- `defaults` has every prop the component requires and cannot default itself (Railing/StringLights
  `length`, Staircase `run`/`rise`/`width`, Armchair/ArcadeCabinet/Beanbag/FloorCushion `color`). They
  are copied into the new item's `props` so that what is saved is what is drawn.
- `y` for wall- and ceiling-mounted types (WallClock, Television, AirConditioner, OfficeLight,
  StringLights) comes from the heights the stock scene uses for them; everything else is `0`.
- `fields` only lists parameters the component really reads (`size`, `length`, `run`, `rise`, `width`,
  `color`; boolean props such as `withChair` are not exposed). Number bounds stay inside the server's ±100.
- Groups drive palette sections. WorkDesk and Bed are in "Furniture"/"Bedroom" with the note
  "decoration, not an agent seat" on their palette tooltip.

### Pure operations (`src/scene3d/scene-edit.ts`)

- `nextAddedId(patch, defaults: SceneItem[]): string` → `added-<n>`, the smallest `n` not used by any
  stock item, added item or override key (so `applyPatch`'s collision rule can never drop a new item).
- `addProp(patch, defaults, type, position: [x, z], level, bounds): { patch, id }` → appends a
  `PropItem` `{ kind:'prop', id, type, level, position:[x, level + entry.y, z], props: entry.defaults }`
  (rotation omitted), with x/z rounded and clamped to the bounds exactly like `moveItem`. Returns the
  same patch and `id: null` when `added.length` is already `MAX_ADDED`.
- `duplicateItem(patch, defaults, item, bounds): { patch, id }` → a copy of an **editable** item
  (`isEditable`: prop or window) with a new id, same level/type/rotation/props/y, shifted by
  `+DUPLICATE_OFFSET` (0.5 m) in X and Z, clamped to the bounds (widened to include the original, so
  an off-bounds stock item still duplicates). Same `MAX_ADDED` guard.
- `setItemProp(patch, item, key, value)` → writes `props[key]` for a prop (merging with the item's
  existing `props`; for stock items through an override, for added items in place). Other kinds: no-op.

`MAX_ADDED` is mirrored from the server by hand with a test that the two agree (the existing pattern
for `PROP_TYPES`).

### Editor session (`use-scene-editor.ts`)

Adds `placing: PropType | null`, `startPlacing(type)`, `stopPlacing()`, `place(x, z)` and
`duplicate()` on the `SceneEditor` interface. `place` and `duplicate` call `apply(...)` (one undo step
each) and select the new item. `placing` is session state, not part of the draft: it is cleared by
`Done`, `Reset`, undo/redo and unmount. Entering placing mode deselects.

### Placement layer (`src/scene3d/edit-layer.tsx`)

- `PlacementLayer`: while `placing` is set, a transparent horizontal plane at the viewed level's
  height catches pointer moves. A ghost of the real component (semi-transparent, using
  `PROP_COMPONENTS[type]` with the catalogue defaults) follows the pointer, snapped to the 0.25 m grid
  (free with Alt), clamped to the bounds. The cursor shows a crosshair.
- A **click** (pointer down and up less than 4 px apart) places; a drag orbits the camera as usual, so
  placing never fights the camera. Placing wins over selecting: a click on an existing object still
  places a new one there. Overlaps are allowed; the user is in charge of the layout.
- Esc, right-click (context menu suppressed while placing) or clicking the active palette entry leaves
  placing mode. Switching floors keeps the mode and moves the ghost plane to the new floor.
- Existing 2a handlers (select, drag) are inactive while placing; the camera lock for hover is off.

### Palette (`src/pages/PropPalette.tsx`)

A left-side panel in edit mode (same dark style as the object panel, collapsible, scrollable):
a search box, then sections by group, each entry a button with the type's label. The active entry is
highlighted (`aria-pressed`). At the limit a notice replaces the list header: "Limit reached (500
added objects)". A one-line hint: "Click the floor to place, Esc to stop". Hidden at ≤700 px like the
rest of the editor UI. Position: left edge, below the HUD chips (top 108 px), so it does not collide
with the edit bar (centred) or the object panel (right).

### Object panel (`src/pages/ObjectPanel.tsx`)

- New **Duplicate** button next to Delete (disabled at the limit, tooltip says why) and the shortcut
  Ctrl/Cmd+D (the key handler's existing skip for INPUT/SELECT/TEXTAREA applies; the browser's
  default "bookmark" action is prevented).
- Below Rotation/Floor, one row per `PROP_CATALOG[type].fields`: a number input (same commit-on-blur
  rules as X/Z: rejects empty/NaN, clamps to the field's `min`/`max`) or a colour input
  (`<input type="color">`, commits on change). The current value is `item.props?.[key]` falling back
  to `defaults?.[key]` falling back to blank for numbers when unknown. Fields are omitted for windows.
- `NumberField` keeps `key={`${item.id}:${value}`}` (2a fix) so a typed value never lands on another
  object.

### Behaviour notes

- Cutaway/shell: new props get `view` omitted (cutaway) and the viewed `level`; they appear on their
  floor like any prop of that level. A new prop on the roof level is still "cutaway" for that level.
- Agents: a new object does not change desks/beds/seats and does not change walking routes (README
  and the edit bar's existing note already say routes do not follow furniture).
- Save payload: items are plain `PropItem`s, so server validation accepts them unchanged; a save with
  more than 500 added is already rejected by the server and prevented in the UI.
- Keyboard: R / Shift+R, Delete, Ctrl+Z / Ctrl+Shift+Z keep working for the new selection;
  Esc while placing leaves placing first, a second Esc deselects.

## Testing

- `prop-catalog.test.ts`: every `PROP_TYPES` key has an entry; every field key is a string without
  spaces; number bounds are within ±100; every `defaults` value passes the server's `props` check.
- `scene-edit.test.ts`: `nextAddedId` (skips stock, added and override ids; never collides after a
  delete), `addProp` (position/level/y, clamping, defaults copied, `MAX_ADDED` guard, patch not
  mutated), `duplicateItem` (offset, clamping, off-bounds originals, props deep-copied, windows),
  `setItemProp` (stock via override, added in place, non-prop no-op).
- `use-scene-editor.test.tsx`: `place`/`duplicate` select the new item and are one undo step;
  `placing` clears on Done/Reset/undo.
- Component tests: `PropPalette` (groups, search filter, aria-pressed, limit notice), `ObjectPanel`
  (property rows per type, commit/clamp, Duplicate disabled at the limit).
- A server-side test that a patch containing catalogue-default `added` items for every type is
  accepted by `validateScene` (guards catalogue/server drift).
- Browser verification (CDP script as in 2a): place a Sofa and a Plant in a row, Esc, duplicate with
  the button and Ctrl+D, change a Railing length and a Sofa colour, undo/redo, save, reload and see
  them; check the palette does not overlap the edit bar or the office panel, and that placing on the
  upper floor puts the object on that floor.

## Risks and open points

- A component may misbehave with defaults the catalogue gets wrong (blank render or a crash). The
  render path already skips unknown types; a catalogue render test mounts every type with its
  defaults inside a `renderToStaticMarkup`-style harness where feasible, and the browser pass places
  a few unusual ones (Staircase, Railing, StringLights).
- Placing with a transparent plane means a click on empty sky does nothing; acceptable.
- The palette and the HUD compete for the left edge on mid-width screens (701 to about 1000 px); the
  palette is collapsible and starts collapsed below 1000 px.
