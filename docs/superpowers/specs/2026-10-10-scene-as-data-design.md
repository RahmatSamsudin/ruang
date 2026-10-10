# Workplace editor, sub-project 1: scene as data

Date: 2026-10-10. Status: draft, awaiting review.

## Context

The goal is a workplace editor for the 3D Office: place built-in objects, import 3D models, and
create new floors, with everything (including the stock rooms and furniture) editable. That is
four sub-projects, each with its own spec, plan and build:

1. **Scene as data** (this spec): the office becomes a data document, persisted on the server.
2. Editor UI: edit mode, palette, select/move/rotate/delete, floor slabs and walls, undo.
3. Model import: upload `.glb`/`.gltf`, place like any other object.
4. Agent navigation: seats, idle stops and walk routes derived from role-tagged objects.

Today the building is hard-coded: `office3d-layout.ts` holds coordinates and agent routes,
`scene3d/environment.tsx` holds the walls, floors and furniture as JSX, and `Floor` is typed `1 | 2`.
The building grows with the crew (one desk and one bed per agent).

## Goals

- The office is rendered from a flat list of scene items, not from hard-coded JSX.
- The default scene (generated from the crew size) looks and behaves exactly like today's office.
- Edits are saved on the server as a patch against the default scene, shared by every viewer.
- Floors are data: any slab at a new height creates a new level, so the floor switcher is derived.

## Non-goals

- Any editing UI (sub-project 2). In this step the scene is changed by editing `scene.json`.
- Model import (3), and navigation derived from objects (4).
- Per-user scenes, scene history or versions beyond a schema `version` field.

## Scene model (`src/scene3d/scene.ts`)

`defaultScene(crewCount): SceneItem[]` replaces the JSX in `environment.tsx`. Every item has a
stable `id` (`desk-3`, `bed-2`, `sofa`, `wall-back`, `floor-lounge-rug`, ...).

Item kinds:

- `prop`: `{ type, position, rotation, scale?, color? }`, where `type` names an existing component
  in `props.tsx`.
- `floor`: a slab `{ min: [x, z], max: [x, z], y, surface }`. Surfaces: wood, tile, carpet + colour,
  grass, paving, asphalt (the existing procedural textures in `textures.ts`).
- `wall`, `glass`, `window`: `{ from, to, y, height }` plus `width` for windows.

All items carry `view: 'cutaway' | 'shell' | 'both'` (default `both`), the same split that exists
today between the lantai 1 cut-away and the closed shell seen from lantai 2. Walls on lower levels
draw at full height when a higher level is in view.

`SceneRenderer` maps items to the existing components. Textures stay procedural.

**Levels.** A level is a distinct slab `y`. The floor switcher in `Office3D.tsx` is built from the
sorted levels; the `Floor = 1 | 2` type and `floorOf` are replaced by a level index. The stock
scene has two levels (`y = 0` and `y = FLOOR_HEIGHT`), so the switcher is unchanged by default.

**Agents (this step only).** Desk and bed positions are read back from the (patched) scene into
`OfficeLayout.desks` and `OfficeLayout.beds`, so agents sit at moved desks and beds. Other idle
stops and the `walkPath3` routes keep their fixed coordinates until sub-project 4; a moved sofa
does not re-route agents. The UI notes this.

## Patch and persistence

Saved document (`$RUANG_DATA_DIR/scene.json`, default `~/.local/share/ruang/scene.json`):

```ts
{ version: 1, overrides: { [id: string]: Partial<SceneItem> | null }, added: SceneItem[] }
```

- `applyPatch(items, patch)` is pure: an override merges into the item with that id, `null`
  deletes it, `added` appends. It returns copies and never mutates.
- Ids in `overrides` that no longer exist are ignored, so crew changes and stock-office updates
  never invalidate a save.
- `desk-*` and `bed-*`: their count always follows the crew. They can be moved; a `null` override
  for them is ignored.
- Added item ids must not collide with generated ids (rejected on write).

## Server API (`server/scene.ts`, modelled on `skins.ts`)

- `GET /api/scene` returns the patch (empty patch if the file is missing or unreadable).
- `PUT /api/scene` replaces the patch. `DELETE /api/scene` resets to the default.
- Writes: origin check (`matchOriginHost`), body cap 256 KiB, strict schema validation, caps on
  item and override counts, finite numbers only, known prop types and surfaces only, atomic write
  (temp file + rename), mode 0600. Invalid input is a 400, never a partial write.
- Behind the access code when one is configured (all `/api` except health already is).
- Ruang's read-only boundary toward Hermes is unchanged; `scene.json` lives in `RUANG_DATA_DIR`
  like skins.
- `API_VERSION` 12 to 13 in both `server/api-version.ts` and `src/api-version.ts`.
- The UI fetches the scene with `usePolling`/the existing request helpers; if it fails, the
  default scene renders (never a blank office). Types are mirrored by hand in `src/types.ts`.
- README: document the file and the API.

## Testing

- **Parity:** `defaultScene(n)` for several crew sizes reproduces today's desk, bed and key prop
  positions and level heights (pinned against `createLayout` values), and the existing
  `office3d-layout.test.ts` stays green. Before/after screenshots of both floors are compared by
  eye, since the render itself is not unit-testable.
- **Patch:** `applyPatch` tests for move, delete, add, stale ids, protected desks and beds, id
  collisions, and no mutation of the input.
- **Levels:** levels derived from slabs; the default scene gives exactly two.
- **Server:** route tests in the style of `skins.test.ts`: validation failures, size cap, origin
  check, atomic write and permissions, reset, and a corrupt file falling back to an empty patch.

## Risks

- Converting about 290 lines of JSX (plus the grounds, vendors, stairs and railings) to data
  without visual regression. Mitigation: parity tests and screenshots; convert in the same order
  as `environment.tsx`, keeping groups such as the gerobak + vendor as single props.
- Items that depend on the crew-sized building (walls, outdoor grounds, lights above desks) are
  generated by `defaultScene`; a patch pins absolute values, so a later crew change will not move a
  wall the user already moved. Accepted.
- Agents may walk through moved furniture until sub-project 4. Accepted and stated in the UI.
