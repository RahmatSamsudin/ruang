# Scene Editor 2c: Structure Editing and Storey Shell Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Office 3D edit mode, make structure items (floors, walls, glass, boxes) selectable and editable, allow placing new structure elements, provide dedicated ObjectPanel property controls, and support multi-storey management with exterior shell views.

**Architecture:** Broaden `EditableItem` in `scene.ts` and `scene-edit.ts` so structure meshes participate in editor selection and manipulation. Extend pure operations in `scene-edit.ts` (`moveItem`, `rotateItem`, `duplicateItem`, `deleteItem`, `setItemLevel`, `addStructureItem`, `addStorey`) to transform structure geometry immutably. Specialized sub-panels in `ObjectPanel.tsx` handle geometry coordinates, dimensions, procedural surfaces, and visibility views. An active `ViewMode` toggle (`Cutaway` vs `Shell`) and `Add Storey` control in `EditorBar.tsx` enable exterior facade editing and vertical expansion. The server remains unchanged; `API_VERSION` stays 14.

**Tech Stack:** React 19, React Three Fiber 9, three 0.186, vitest (jsdom for UI tests), TypeScript strict, eslint.

**Spec:** `docs/superpowers/specs/2026-10-10-scene-editor-structure-design.md` (binding). Predecessors: `docs/superpowers/specs/2026-10-10-scene-editor-palette-design.md`, `docs/superpowers/specs/2026-10-10-scene-editor-core-design.md`.

## Global Constraints

- Server unchanged; `API_VERSION` stays 14. `MAX_ADDED` is 500 (`server/scene.ts`).
- Server `validateItem` checks for structure kinds:
  - `floor`: `min: tuple(2)`, `max: tuple(2)`, `y: num`, `surface: { type, repeat, color? }`, optional `roughness: unit (0..1)`.
  - `wall`: `from: tuple(2)`, `to: tuple(2)`, `y: num`, `height: positive`.
  - `glass`: `from: tuple(2)`, `to: tuple(2)`, `bottom: num`, `top: num`.
  - `box`: `position: tuple(3)`, `size: tuple(3, positive)`, `color: hex`, optional `radius: num`, `roughness: unit`, `opacity: unit`, `shadow: bool`.
  - Common: `level: num`, optional `view: oneOf(['cutaway', 'shell', 'both'])`.
- Grid step 0.25 m (`GRID`), duplicate offset 0.5 m (`DUPLICATE_OFFSET`), standard storey height 2.8 m (`FLOOR_HEIGHT`).
- Selection precedence: Props click-event handlers stop propagation; open floor clicks select floor slabs.
- Agent seats (`desk-N`, `bed-N`) and primary stairs (`stairs`) cannot be deleted (`canDelete` guard).
- All edits are pure `ScenePatch → ScenePatch` functions; no patch mutation.
- UI text is English. Code style: no semicolons, single quotes, 2-space indent.

## Review Focus

1. **Selection Precedence:** Furniture resting on floor slabs must be clickable without the underlying floor capturing the click.
2. **Floor & Wall Geometry Math:** Shifting floors updates both `min` and `max`; shifting walls updates both `from` and `to`. Rotating floors swaps width and depth around the center; rotating walls pivots 90° around the segment midpoint.
3. **Storey Shell Views:** Adding a storey automatically adds a base floor slab and creates shell perimeter walls for the lower level so viewing the upper storey renders a closed building below.
4. **Number Validation & Clamping:** All coordinate, size, and elevation inputs reject non-finite/NaN values, clamp to bounds on blur, and maintain valid ordering (`min < max`, `bottom < top`).
5. **Server Schema Compliance:** Every duplicated or added structure element satisfies `server/scene.ts` validation without errors.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/scene3d/scene.ts` | Widen `EditableItem`, add type guards (`isFloor`, `isWall`, `isGlass`, `isBox`). |
| `src/scene3d/scene-edit.ts` | Pure structure operations (`moveItem`, `rotateItem`, `duplicateItem`, field setters, `addStructureItem`, `addStorey`). |
| `src/scene3d/scene-edit.test.ts` | Unit tests for all pure structure operations, geometry transforms, and shell generation. |
| `src/scene3d/edit-layer.tsx` | Selection visuals (outlines, wireframes), drag handling, and magnetic vertex snapping. |
| `src/scene3d/scene-renderer.tsx` | Wrap structure nodes (`FloorNode`, `WallNode`, `GlassNode`, `BoxNode`) with `EditTarget`. |
| `src/pages/ObjectPanel.tsx` | Specialized controls for floor bounds/surfaces, wall endpoints/height, glass levels, and box dimensions. |
| `src/pages/ObjectPanel.test.tsx` | Component unit tests (jsdom) for structure property forms, inputs, and validation. |
| `src/pages/EditorBar.tsx` | Add `ViewModeToggle` (`Cutaway` vs `Shell`) and `Add Storey` action. |
| `src/scene3d/use-scene-editor.ts` | Editor hook state for view mode (`cutaway` / `shell`) and storey management actions. |
| `src/pages/Office3D.tsx` | Wire view mode filtering, level additions, and selection routing. |
| `server/scene.test.ts` | Server validation check for structure additions and shell overrides. |

---

### Task 1: Data Model, Type Guards, and Pure Operations for Structure

**Files:**
- Modify: `src/scene3d/scene.ts`
- Modify: `src/scene3d/scene-edit.ts`
- Modify: `src/scene3d/scene-edit.test.ts`

**Interfaces:**
- Consumes: `FloorItem`, `WallItem`, `GlassItem`, `BoxItem`, `SceneItem`, `ScenePatch` from `scene.ts`.
- Produces:
  - `scene.ts`: `EditableItem = PropItem | WindowItem | FloorItem | WallItem | GlassItem | BoxItem`, `isFloor`, `isWall`, `isGlass`, `isBox`.
  - `scene-edit.ts`: structure-aware `moveItem`, `rotateItem`, `duplicateItem`, `deleteItem`, `setItemLevel`, `setFloorBounds`, `setFloorSurface`, `setWallGeometry`, `setGlassGeometry`, `setBoxTransform`, `setItemView`.

- [ ] **Step 1: Widen `EditableItem` and add type guards in `src/scene3d/scene.ts`**

```ts
export type EditableItem = PropItem | WindowItem | FloorItem | WallItem | GlassItem | BoxItem

export const isFloor = (item: SceneItem): item is FloorItem => item.kind === 'floor'
export const isWall = (item: SceneItem): item is WallItem => item.kind === 'wall'
export const isGlass = (item: SceneItem): item is GlassItem => item.kind === 'glass'
export const isBox = (item: SceneItem): item is BoxItem => item.kind === 'box'
export const isProp = (item: SceneItem): item is PropItem => item.kind === 'prop'
export const isWindow = (item: SceneItem): item is WindowItem => item.kind === 'window'
```

- [ ] **Step 2: Update `isEditable` and `canDelete` in `src/scene3d/scene-edit.ts`**

Make all scene items editable. Protect `stairs` alongside agent seat IDs:
```ts
export const isEditable = (_item: SceneItem): _item is EditableItem => true
export const canDelete = (item: SceneItem): boolean => !isSeatId(item.id) && item.id !== 'stairs'
```

- [ ] **Step 3: Implement structure-aware `moveItem` in `src/scene3d/scene-edit.ts`**

Calculate translation deltas `(dx, dz)` and apply to kind-specific geometry:
- `floor`: `min: [min[0] + dx, min[1] + dz]`, `max: [max[0] + dx, max[1] + dz]`.
- `wall` / `glass`: `from: [from[0] + dx, from[1] + dz]`, `to: [to[0] + dx, to[1] + dz]`.
- `box`: `position: [position[0] + dx, position[1], position[2] + dz]`.

- [ ] **Step 4: Implement structure-aware `rotateItem` and `rotateBy` in `src/scene3d/scene-edit.ts`**

- `floor`: Rotate 90° around center `[(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]`:
  Compute half-width and half-depth, swap them, and recalculate `min` and `max`.
- `wall` / `glass`: Rotate 90° around segment midpoint `[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]`:
  Pivot vector `(to - from)` by 90° (`[-dz, dx]`).
- `box`: Swap dimensions `size[0]` and `size[2]`.

- [ ] **Step 5: Implement structure-aware `duplicateItem` in `src/scene3d/scene-edit.ts`**

When duplicating an `EditableItem`:
- Verify `patch.added.length < MAX_ADDED`.
- Assign new ID via `nextAddedId(patch, items)`.
- Offset coordinates by `+DUPLICATE_OFFSET` (0.5 m).
- Copy kind-specific fields with clean typing, ensuring only server-allowed fields are written.

- [ ] **Step 6: Implement structure property setters in `src/scene3d/scene-edit.ts`**

- `setFloorBounds(patch, item, min, max)`: Updates slab coordinates, ensuring `min[0] <= max[0]` and `min[1] <= max[1]`.
- `setFloorSurface(patch, item, surface, roughness?)`: Updates surface type, repeat, color, roughness.
- `setWallGeometry(patch, item, from, to, height, y?)`: Updates wall endpoints and height.
- `setGlassGeometry(patch, item, from, to, bottom, top)`: Updates glass endpoints and elevations.
- `setBoxProps(patch, item, size, color, options)`: Updates box dimensions, color, opacity, radius, roughness.
- `setItemView(patch, item, view)`: Sets `view` to `'cutaway'`, `'shell'`, or `'both'`.

- [ ] **Step 7: Write unit tests in `src/scene3d/scene-edit.test.ts`**

Test:
- `moveItem` with floor translates both min and max coordinates.
- `moveItem` with wall translates both from and to coordinates.
- `rotateItem` with floor swaps width and depth around center.
- `rotateItem` with wall pivots endpoints 90° around midpoint.
- `duplicateItem` creates a valid floor/wall/glass/box offset by 0.5 m.
- `canDelete` protects `stairs` and `desk-1`/`bed-1`, but allows deleting structure.
- Property setters update fields via overrides for stock items and in-place for added items.

*Verification:* `npx vitest run src/scene3d/scene-edit.test.ts`

---

### Task 2: Storey Management and Shell Generation Pure Operations

**Files:**
- Modify: `src/scene3d/scene-edit.ts`
- Modify: `src/scene3d/scene-edit.test.ts`

**Interfaces:**
- Consumes: `levelsOf`, `FLOOR_HEIGHT`, `SceneItem`, `ScenePatch`.
- Produces: `addStorey(patch, items, bounds): { patch, level }`, `generateStoreyShell(patch, items, fromLevel): ScenePatch`.

- [ ] **Step 1: Implement `generateStoreyShell` in `src/scene3d/scene-edit.ts`**

Inspects `items` on `fromLevel`:
- Finds perimeter wall segments (`item.kind === 'wall'`).
- For each exterior wall, creates or updates a matching shell wall with `view: 'shell'`, full height 2.6 m, and `y = fromLevel`.
- Returns the updated `ScenePatch`.

- [ ] **Step 2: Implement `addStorey` in `src/scene3d/scene-edit.ts`**

- Calculates new level height: `newLevel = Math.max(...levelsOf(items)) + FLOOR_HEIGHT`.
- Adds a base floor slab on `newLevel` spanning the building bounds (`minX, minZ` to `maxX, maxZ`).
- Calls `generateStoreyShell` for the storey below so it renders a closed exterior shell when viewed from `newLevel`.
- Returns `{ patch, level: newLevel }`.

- [ ] **Step 3: Update `setItemLevel` for all structure kinds in `src/scene3d/scene-edit.ts`**

Shifts vertical coordinate by delta `(newLevel - item.level)`:
- `floor`: shifts `y`.
- `wall`: shifts `y`.
- `glass`: shifts both `bottom` and `top`.
- `box`: shifts `position[1]`.
- `prop` / `window`: shifts `position[1]`.

- [ ] **Step 4: Write unit tests in `src/scene3d/scene-edit.test.ts`**

Test:
- `addStorey` calculates correct new level (e.g. 5.6 m above 2.8 m).
- `addStorey` adds a floor slab on the new level.
- `generateStoreyShell` generates full-height shell walls with `view: 'shell'`.
- `setItemLevel` correctly shifts Y coordinates across all structure kinds.

*Verification:* `npx vitest run src/scene3d/scene-edit.test.ts`

---

### Task 3: Structure Creation Primitives in Palette & Placement

**Files:**
- Modify: `src/scene3d/scene-edit.ts`
- Modify: `src/pages/PropPalette.tsx`
- Modify: `src/scene3d/edit-layer.tsx`
- Modify: `src/scene3d/use-scene-editor.ts`

**Interfaces:**
- Consumes: `addStructureItem`, `SceneEditor`.
- Produces: Structure placement tools (`Floor`, `Wall`, `Glass`, `Box`).

- [ ] **Step 1: Implement `addStructureItem` in `src/scene3d/scene-edit.ts`**

Defines sensible architectural defaults for new structure elements:
- `floor`: 4 m × 4 m slab centered at placement point `[x, z]`, wood surface, `y = 0.005`.
- `wall`: 4 m length along X axis `[x - 2, z]` to `[x + 2, z]`, height 2.6 m.
- `glass`: 3 m length along X axis `[x - 1.5, z]` to `[x + 1.5, z]`, bottom 0, top 2.2 m.
- `box`: 1 m × 1 m × 1 m box at `[x, 0.5, z]`, neutral gray color `#a0a0a0`.
Guarded by `MAX_ADDED`.

- [ ] **Step 2: Add Structure section to `PropPalette.tsx`**

Add top-level buttons or a dedicated "Structure" section in the palette:
- `Floor slab` (creates default floor).
- `Wall segment` (creates default wall).
- `Glass divider` (creates default glass).
- `Box shape` (creates default box).

- [ ] **Step 3: Update `PlacementLayer` in `src/scene3d/edit-layer.tsx`**

When placing a structure primitive:
- Render a semi-transparent ghost representing the structure item (plane for floor, box outline for wall/glass/box).
- Snap ghost position to the 0.25 m world grid (free with Alt).
- Short click calls `addStructureItem` and selects the newly placed element.

*Verification:* `npx vitest run src/scene3d/scene-edit.test.ts`

---

### Task 4: ObjectPanel Structure Forms & Validation

**Files:**
- Modify: `src/pages/ObjectPanel.tsx`
- Modify: `src/pages/ObjectPanel.test.tsx`

**Interfaces:**
- Consumes: `EditableItem`, `levels`, update callbacks.
- Produces: Form sections for `floor`, `wall`, `glass`, `box`, plus `ViewSelect`.

- [ ] **Step 1: Create `FloorPanel` component in `src/pages/ObjectPanel.tsx`**

Expose:
- Dimensions: Width (m), Depth (m), Center X (m), Center Z (m), Elevation Y (m).
- Surface selector: `<select>` with options `wood`, `tile`, `carpet`, `grass`, `asphalt`, `paving`.
- Repeat X, Repeat Z: integer number inputs.
- Carpet Color: `<input type="color">` (rendered only when surface is `carpet`).
- Roughness: numeric input (0.0 to 1.0, step 0.05).
- Floor/Level selector and View selector.

- [ ] **Step 2: Create `WallPanel` component in `src/pages/ObjectPanel.tsx`**

Expose:
- Endpoints: From X, From Z, To X, To Z.
- Height: number input (0.1 to 10.0 m) with preset buttons: Stub (0.55 m), Partition (0.9 m), Full (2.6 m).
- Elevation Y.
- Readout: Length (m) and Angle (°).
- Floor/Level selector and View selector.

- [ ] **Step 3: Create `GlassPanel` component in `src/pages/ObjectPanel.tsx`**

Expose:
- Endpoints: From X, From Z, To X, To Z.
- Elevations: Bottom Y, Top Y.
- Readout: Height (m) (`top - bottom`).
- Floor/Level selector and View selector.

- [ ] **Step 4: Create `BoxPanel` component in `src/pages/ObjectPanel.tsx`**

Expose:
- Position: X, Y, Z.
- Dimensions: Size X, Size Y, Size Z.
- Material: Color hex picker, Opacity slider (0.0 to 1.0), Corner Radius input, Roughness slider, Shadow checkbox.
- Floor/Level selector and View selector.

- [ ] **Step 5: Write unit tests in `src/pages/ObjectPanel.test.tsx`** (`// @vitest-environment jsdom`)

Test:
- Correct sub-panel renders for floor, wall, glass, and box items.
- Changing surface dropdown triggers `onProp` / `onSurfaceChange`.
- Typing invalid/negative numbers reverts on blur.
- View dropdown triggers `onViewChange` with `'cutaway'`, `'shell'`, or `'both'`.
- Duplicate button triggers `onDuplicate`.
- Delete button is enabled for structure items.

*Verification:* `npx vitest run src/pages/ObjectPanel.test.tsx`

---

### Task 5: 3D Selection Feedback, Hit Testing, and View Mode Toggle

**Files:**
- Modify: `src/scene3d/scene-renderer.tsx`
- Modify: `src/scene3d/edit-layer.tsx`
- Modify: `src/pages/EditorBar.tsx`
- Modify: `src/pages/Office3D.tsx`
- Modify: `src/scene3d/use-scene-editor.ts`

**Interfaces:**
- Consumes: `wrap` in `SceneRenderer`, `viewMode`, `addStorey`.
- Produces: Selectable structure in 3D canvas, Cutaway/Shell view toggle in EditorBar.

- [ ] **Step 1: Wrap structure nodes in `src/scene3d/scene-renderer.tsx`**

Pass `wrap(item, node)` around `FloorNode`, `WallNode`, `GlassNode`, and `BoxNode` when `wrap` is provided.

- [ ] **Step 2: Add selection visual feedback in `src/scene3d/edit-layer.tsx`**

In `EditTarget`:
- When selected:
  - `floor`: render a glowing border outline mesh along the slab rectangle edges.
  - `wall`: render highlighted top edge and end lines.
  - `glass`: render translucent cyan bounding edges.
  - `box`: render wireframe bounding box (`<boxHelper>` or line segments).
- Ensure prop click handlers call `event.stopPropagation()` so clicking a chair on a floor slab selects the chair, not the floor.

- [ ] **Step 3: Add `ViewModeToggle` and `Add Storey` in `src/pages/EditorBar.tsx`**

- Add View toggle button: `👁 Cutaway` vs `🏢 Shell`.
- Add `+ Add Storey` button next to level switcher.
- Tooltips explaining behavior.

- [ ] **Step 4: Wire view mode and storey addition in `src/pages/Office3D.tsx`**

- In `Office3D.tsx`, filter `drawItems` by active `viewMode`:
  - When `viewMode === 'shell'`, show shell items on the viewed level.
  - When `viewMode === 'cutaway'`, show cutaway items (default).
- Wire `Add Storey` click to call `editor.apply(patch => addStorey(patch, items, bounds))` and select the new floor.

*Verification:* `npx vitest run src/pages/ObjectPanel.test.tsx`

---

### Task 6: Server Compliance and End-to-End Verification

**Files:**
- Modify: `server/scene.test.ts`

- [ ] **Step 1: Add server validation tests in `server/scene.test.ts`**

Add tests verifying:
- `validatePatch` accepts added floors with all surface types (`wood`, `tile`, `carpet`, `grass`, `asphalt`, `paving`).
- `validatePatch` accepts added walls, glass dividers, and boxes with all optional properties.
- `validatePatch` accepts overrides toggling `view` (`cutaway`, `shell`, `both`) and changing level heights.
- Patches generated by `addStorey` pass server validation cleanly.

- [ ] **Step 2: Run full automated verification suite**

Run all checks from repository root:
1. `npm test` — all vitest unit and component tests pass.
2. `npm run lint` — eslint passes cleanly with 0 errors.
3. `npm run build` — TypeScript compiles UI and server cleanly, Vite builds client bundle.

- [ ] **Step 3: Browser verification checklist (CDP / manual)**

1. Open Office 3D, click **Edit**.
2. Click the main floor slab: verify outline appears and `ObjectPanel` displays `Floor` controls.
3. Change floor surface from `wood` to `tile`: confirm visual texture updates.
4. Click an exterior wall: verify `Wall` controls appear, adjust height to 1.1 m, confirm wall shortens.
5. Place a new `Box shape` from palette, change color to `#3b82f6` in panel.
6. Click **+ Add Storey**: confirm Lantai 3 appears in HUD, Lantai 2 gains shell walls, navigate to Lantai 3.
7. Switch view mode toggle to `Shell`: inspect exterior shell walls.
8. Click **Save**: reload page, verify all structure edits persist.
9. Click **Reset**: confirm office reverts to defaults.
