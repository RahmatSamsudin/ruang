# Workplace editor, sub-project 2a: editor core

Date: 2026-10-10. Status: draft, awaiting review.

## Context

The workplace editor is four sub-projects (see `2026-10-10-scene-as-data-design.md`): scene as data
(done, merged), **editor UI** (this spec, first half), model import, and agent navigation. The editor
UI itself is split in two:

- **2a (this spec): editor core.** An edit mode in Office 3D: select, drag, rotate, delete, change
  floor, undo/redo, save and reset, for the *objects* (props and windows) that already exist.
- 2b (later spec): a palette to place new objects, and creating/resizing floors and walls, including
  the shell views a new storey needs.

Sub-project 1 left everything in place: the office is `applyPatch(defaultScene(layout), patch)`, the
server stores the patch (`GET/PUT/DELETE /api/scene`, same-origin, validated), desks and beds can be
moved but not deleted, and every item has a `level` and absolute positions.

## Goals

- You can rearrange the office from the UI without curl: enter Edit, drag a sofa, rotate a plant,
  delete a plant, move a chair to another floor, undo, save, reset.
- Saved edits are shared (the existing patch on the server) and survive a reload.
- Nothing changes for people who never press Edit.

## Non-goals (2a)

- Placing new objects, creating or resizing floors, walls, glass or boxes (2b).
- Selecting or moving `floor`, `wall`, `glass` and `box` items: dragging the main floor or a roof
  by accident is easy and destructive, so structure is not selectable until 2b gives it handles.
- Multi-select, copy/paste, importing models (sub-project 3), agent routes that follow moved
  furniture (sub-project 4).
- Live co-editing. Last save wins (this is a single-owner tool).

## Approach

**Draft-patch, in place.** The editor lives in the existing Office 3D view. Its state is a draft
`ScenePatch`. Every operation is a pure function from a patch (plus the default scene) to a new
patch; what is drawn is always `applyPatch(defaults, draft)`, so there is one way to change the
scene. Undo/redo is a stack of earlier drafts. Save is `PUT /api/scene`, reset is
`DELETE /api/scene`. The server is unchanged and `API_VERSION` stays 14.

Rejected: mutating items directly and diffing a patch on save (error-prone for stock versus added
items), and a separate top-down editor page (two renderers, no 3D context, awkward multi-floor).

## UI

Labels are in English like the rest of the app.

```
┌ edit bar (top centre): [Undo] [Redo]  ● unsaved   [Save] [Reset to default] [Done]
│   note: "Walking routes don't follow moved furniture yet (desks and beds do)."
│                                                       ┌ object panel (top right) ┐
│        3D canvas                                      │ Sofa  ·  sofa            │
│  (drag an object = move it,                           │ X [ 4.60 ]  Z [ -1.30 ]  │
│   drag empty space = camera)                          │ Rotation [ 180 ]°        │
│                                                       │ Floor [ Kantor ▾ ]       │
│                                                       │ [ Delete ]               │
│                                                       └──────────────────────────┘
```

- **Entering.** A `✎ Edit` button joins the tools at the bottom right (next to Tidur, Geser, Reset
  view). The object panel and edit bar are absolutely positioned inside `.office-3d`; when the
  agent panel is open they shift left by the same rule the tools use. Hidden below 700 px width
  together with the tools (editing needs a pointer and room).
- **Select.** Click an editable object (a `prop` or `window`) to select it; a yellow box outlines it.
  Clicking empty space (R3F `onPointerMissed`) or pressing Esc deselects.
- **Move.** Drag a selected or unselected editable object across the horizontal plane at its own
  height. The grab offset is kept, so it does not jump. Movement snaps to 0.25 m steps relative to where the
  object started (so stock items that sit off the grid, such as wall-mounted ones, keep their
  alignment); hold Alt for free placement. Positions are clamped to the office's pan bounds (`layout.pan`) so an object can
  never be dropped out of reach. One drag is one undo step.
- **Camera.** While the pointer is over an editable object, or while dragging, orbit and pan are
  disabled (an `enabled` prop on `Controls`; wheel zoom still works), so the press-drag moves the
  object. The hover lock is not taken when a mouse button is already held (an orbit drag crossing
  an object). Everywhere else the camera works as before.
- **Rotate.** `R` rotates the selection by +15° (`Shift+R` by −15°), or type degrees in the panel.
- **Delete.** `Delete`/`Backspace` or the panel button. Desks and beds (`desk-N`, `bed-N`) cannot be
  deleted: the button is disabled with the tooltip "Desks and beds follow the number of agents".
- **Floor.** The panel's Floor select lists the scene's existing levels (named with `levelName`).
  Choosing one sets the item's `level` and shifts its y by the same difference, so it stands on that
  floor.
- **Undo/redo.** `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (and `Ctrl+Y`), up to 100 steps; the buttons in the
  bar do the same. Typing in the panel's fields is not captured by the shortcuts.
- **Agents.** They keep walking. While editing, clicking an agent or its label does nothing (it would
  open the detail dialog and fight the editor).
- **Save.** `Save` sends the draft; it is disabled when nothing changed. On success the draft equals
  the saved patch and the view refreshes at once. On failure (403, 400, network) the error is shown
  in the bar and the draft is kept.
- **Done.** Leaves edit mode. With unsaved changes it asks `window.confirm("Discard unsaved
  changes?")`.
- **Reset to default.** Asks `window.confirm`, then `DELETE /api/scene` and an empty draft.
- **Polling.** Outside edit mode the scene is polled as now. While editing, the polled patch is
  ignored and the draft wins; leaving edit mode shows the polled (saved) patch again.

## Design

New files (one responsibility each):

- `src/scene3d/scene-edit.ts` (pure, tested). `snap(value, step = 0.25)`; `isEditable(item)` (prop or
  window); `canDelete(item)`; `moveItem`, `rotateItem`, `deleteItem`, `setItemLevel`, each
  `(patch, defaults, items, id, ...) => ScenePatch`. Stock items change through `overrides[id]`
  (shallow-merged fields such as `position`, `rotation`, `level`); items in `added` are edited in
  place; deleting a stock item sets `overrides[id] = null` (a no-op for desks and beds); deleting an
  added item removes it. Moves keep the item's y; level changes shift y; rotation is stored in
  radians normalised to [0, 2π). Every number written is finite and within ±1000 so the server
  accepts it.
- `src/scene3d/use-scene-editor.ts` (hook, tested with a small component under jsdom). State:
  `editing`, `draft`, `selectedId`, undo/redo stacks, `dirty` (draft differs from the saved patch),
  `saving`, `error`, `drag` preview. API: `enter`, `exit`, `select`, `apply(fn)`, `undo`, `redo`,
  `save`, `reset`, plus `previewDrag(id, x, z)` / `endDrag()` for the live drag position, which is not
  written to history until the drag ends.
- `src/scene3d/edit-layer.tsx`. A `wrap(item, node)` function for the renderer that surrounds each
  editable item with a `<group>` carrying pointer handlers (hover, down, move, up), plus the
  selection box (`THREE.Box3Helper`). Drag maths: on pointer down, intersect the ray with the plane
  `y = item.position[1]`, remember the grab offset; on move, re-intersect and call `previewDrag`;
  on up, commit one `moveItem` (window-level `pointermove`/`pointerup` listeners so a fast drag
  that leaves the object still ends).
- `src/pages/EditorBar.tsx`, `src/pages/ObjectPanel.tsx`: plain DOM controls for the bar and panel
  (keyboard accessible, `aria-label`s, number inputs with step, a labelled select).
- Changes to existing files: `SceneRenderer` gets an optional `wrap?: (item, node) => ReactNode`;
  `Controls` in `Office3D.tsx` gets `enabled`; `Office3D.tsx` adds the Edit button and mounts the bar,
  panel and layer, ignores agent clicks while editing and routes the keyboard shortcuts;
  `useScenePatch` returns `{ patch, refresh }` (it already wraps `usePolling`); `styles.css` gets the
  bar/panel rules; the README documents the editor.

Data flow: pointer/keyboard/panel → `apply(op)` → new draft (history push) → `items =
applyPatch(defaults, draft)` (with the live drag position overlaid) → `SceneRenderer`. Seats stay
wired as before: `seatPositions(items, ...)` feeds `withMovedSeats`, so a moved desk or bed moves
the agent's seat immediately in the draft.

## Error handling

- A failed save keeps the draft, shows the message, and leaves `dirty` true.
- A scene request that is pending or failed means "stock office" outside edit mode (unchanged); the
  editor can still be entered and will save on top of whatever the server accepts.
- Out-of-range or non-finite typed values in the panel are rejected on blur (the field reverts);
  positions are clamped to the pan bounds.
- The selection is derived from the current items, so a stale selection shows no panel and re-selects itself if the item returns.

## Testing

- `scene-edit.test.ts`: `snap` (negative values, float noise, Alt/free), `isEditable`,
  `canDelete`, move/rotate/delete/setItemLevel for stock and added items, seats protected from
  deletion but movable, y preserved on move, y shifted on level change, rotation wrap, written
  numbers finite and bounded, the input patch is never mutated.
- `use-scene-editor.test.tsx` (jsdom): apply/undo/redo order and the 100-step cap, dirty tracking,
  drag preview not entering history until `endDrag`, save success and failure (mocked `fetch`; the
  browser adds the same-origin `Origin` header itself), reset, exit with and without changes, polling ignored while
  editing.
- Pointer handling in R3F is not unit-testable. It is verified with a headless-browser script
  (the same CDP approach used to compare the pre/post-refactor office): enter Edit, drag an object,
  rotate, delete, undo, save, reload, confirm the saved patch, reset.
- Existing tests, lint and build stay green; `default-scene` snapshots must not change.

## Risks

- **Pointer events on multi-mesh props.** Each prop is many meshes; handlers on the wrapping group
  rely on R3F bubbling. Meshes without handlers do not take part in picking, so glass panes do not
  block clicks on furniture behind them. Verified in the browser script.
- **Orbit controls racing the drag.** Disabling orbit on *hover* (before the press) avoids depending
  on listener order at press time.
- **Editing stock structure props.** Staircase, railings and string lights are props and therefore
  movable; moving them does not change agent walking (stock routes), which the bar says. Accepted.
- **Concurrent saves.** Last write wins. A second viewer's edit session can overwrite the first's;
  acceptable for a single-owner tool, revisit if Ruang gains multiple editors.
