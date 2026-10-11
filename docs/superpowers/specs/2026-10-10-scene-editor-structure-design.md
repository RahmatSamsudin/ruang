# Workplace editor, sub-project 2c: structure editing and storey shell views

Date: 2026-10-10. Status: draft, awaiting review.

## Context

The workplace editor is four sub-projects (see `2026-10-10-scene-as-data-design.md`): scene as data
(done), editor UI (2a core, done; 2b object palette and properties, done; **2c this spec**), model
import (3), agent navigation (4).

In 2a and 2b, structure items (`floor`, `wall`, `glass`, `box`) were deliberately excluded from selection
(`isEditable` returned false) because accidentally dragging a building slab or wall while arranging furniture
is disorienting and destructive.

Now in 2c, we provide the architectural toolset:
1. Make structure elements selectable, movable, resizable, duplicable, and deletable with dedicated controls.
2. Allow creating new floor slabs, walls, glass partitions, and boxes.
3. Manage building storeys: add upper levels (Lantai 3, 4...) and generate shell views (exterior walls,
   facades, roofs) so viewing higher floors does not leave lower storeys looking like empty open-air ruins.

As with 2a and 2b, all changes are saved into `scene.json` as pure `ScenePatch` deltas (`overrides` and
`added`). The server schema and validator in `server/scene.ts` already support all structure kinds and their
properties, so no server change or `API_VERSION` bump is required.

## Goals

- Select and manipulate all structure items (`floor`, `wall`, `glass`, `box`) in Office 3D edit mode.
- Translate (drag), rotate (pivot), duplicate, and delete structure elements with full undo/redo.
- Provide specialized property controls in `ObjectPanel` for each structure kind:
  - `floor`: min/max bounds, width, depth, elevation `y`, surface type (`wood`, `tile`, `carpet`, `grass`,
    `asphalt`, `paving`), texture repeat `[rx, rz]`, carpet color, roughness, level, and view mode.
  - `wall`: endpoints `from [x1, z1]` and `to [x2, z2]` (length and angle), height, elevation `y`, level,
    and view mode.
  - `glass`: endpoints `from [x1, z1]` and `to [x2, z2]`, bottom, top, level, and view mode.
  - `box`: position `[x, y, z]`, dimensions `size [sx, sy, sz]`, color hex, corner radius, roughness,
    opacity, shadow toggle, level, and view mode.
- Place new structure elements (`Floor slab`, `Wall`, `Glass divider`, `Box`) from the palette or structure
  primitives menu on the active level.
- Multi-storey management and shell views:
  - Add new storeys (`highestLevel + FLOOR_HEIGHT`) with an automated base floor slab.
  - Provide a `View Mode` toggle in `EditorBar` (`Cutaway` vs `Shell`) for the viewed level so exterior
    facades, roofs, and rooftop equipment can be inspected and edited directly.
  - Auto-generate perimeter shell walls for lower storeys when a new storey is added above them.
- Preserve Ruang's strict security and read-only boundaries: never write to Hermes profile directories;
  save exclusively to `scene.json`.

## Non-goals (2c)

- Importing custom 3D models (`.glb` / `.gltf` format) — deferred to sub-project 3.
- Modifying agent walking paths or stairs navigation — deferred to sub-project 4. Agent seats (`desk-N`,
  `bed-N`) remain anchored stations; furniture and structure edits do not dynamically recompute pathfinding.
- Freeform non-rectangular polygons for floor slabs: floors remain axis-aligned rectangles (`min`, `max`),
  matching the data model and stock layout. Complex shapes are composed of multiple rectangles.
- Curved walls or non-linear geometry: walls and glass remain straight segments defined by two 2D endpoints.
- Multi-object grouping or boolean CSG operations (cutting holes in slabs is done by tiling rectangular slabs,
  matching the stock stairwell implementation).

## Approach

All edits remain pure functions from a `ScenePatch` to a `ScenePatch` (`scene-edit.ts`), preserving the
editor's history stack (undo/redo, save, reset).

### 1. Data Model & Pure Operations (`src/scene3d/scene-edit.ts`, `scene.ts`)

#### Widening `EditableItem`
In `src/scene3d/scene-edit.ts`, `EditableItem` is broadened:
```ts
export type EditableItem = PropItem | WindowItem | FloorItem | WallItem | GlassItem | BoxItem
export const isEditable = (_item: SceneItem): _item is EditableItem => true
```
Every item in the scene becomes selectable and editable in edit mode.

#### Selection Precedence
Because furniture sits directly on top of floor slabs, clicking on a chair, desk, or rug must select the prop,
not the floor beneath it. R3F pointer events bubble from child meshes upward: props catch the pointer first and
stop propagation. Only clicks that miss props fall through to floor slabs.

#### Movement (`moveItem`)
Translating structure on the X/Z plane depends on kind:
- `prop` / `window`: updates `position: [x, y, z]`.
- `box`: updates `position: [x, y, z]`.
- `floor`: shifts both `min` and `max` by delta `(dx, dz)`:
  `min: [min[0] + dx, min[1] + dz]`, `max: [max[0] + dx, max[1] + dz]`.
- `wall` / `glass`: shifts both `from` and `to` by delta `(dx, dz)`:
  `from: [from[0] + dx, from[1] + dz]`, `to: [to[0] + dx, to[1] + dz]`.

#### Rotation (`rotateItem`, `rotateBy`)
- `prop` / `window`: rotates around Y axis by angle radians.
- `floor`: rotates 90° around its 2D center `[(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]`, swapping width
  and depth.
- `wall` / `glass`: rotates segment around its 2D midpoint by 90° (or `ROTATION_STEP` = 15°).
- `box`: swaps size dimensions `size[0]` (width) and `size[2]` (depth).

#### Duplication (`duplicateItem`)
Structure items duplicate with `+DUPLICATE_OFFSET` (0.5 m) in X and Z:
- `floor`: shifts `min` and `max` by `+0.5 m`.
- `wall` / `glass`: shifts `from` and `to` by `+0.5 m`.
- `box`: shifts `position[0]` and `position[2]` by `+0.5 m`.
- Preserves all visual and structural properties (`surface`, `height`, `size`, `color`, `view`, `level`).

#### Deletion (`deleteItem`)
- Stock agent seats (`isSeatId(id)`) remain protected from deletion.
- Structure items (floors, walls, glass, boxes) can be deleted, writing `overrides[id]: null` for stock items
  or filtering from `added`.
- Safety rule: deleting a floor slab does not delete items or seats resting on it.

### 2. Storey Management & Shell Views

#### The Storey Shell Problem
In Ruang, visibility is driven by `visibleAt(item, activeLevel)`:
```ts
export function visibleAt(item: SceneItem, active: number): boolean {
  if (item.level > active) return false
  const view = item.view ?? 'cutaway'
  return item.level === active ? view !== 'shell' : view !== 'cutaway'
}
```
- When viewing Lantai 1 (level 0), Lantai 1's `cutaway` and `both` items are drawn.
- When viewing Lantai 2 (level 2.8), Lantai 1's `cutaway` items are hidden, and Lantai 1's `shell` items
  (`wall-front-shell`, `wall-right-shell`, `entrance-lintel`, `game-roof`, outer windows) are drawn, presenting
  a closed building underneath Lantai 2.
- If a user adds Lantai 3 (level 5.6), Lantai 2 currently has NO `shell` items. Looking at Lantai 3 would make
  Lantai 2's walls and furniture disappear, leaving Lantai 3 floating above an empty ground storey.

#### Multi-Storey Architecture
1. **View Mode Toggle in `EditorBar`**:
   The editor gains an active view toggle: `Cutaway` vs `Shell`.
   - In `Cutaway` mode (default), the viewed level displays its cutaway interior (open walls, furniture).
   - In `Shell` mode, the viewed level displays its closed shell (full-height exterior walls, facade, roof).
   This allows direct inspection, placement, and editing of exterior shell elements on any level.
2. **Item View Property**:
   Every structure item in `ObjectPanel` exposes a `View` dropdown:
   - `Cutaway` (default for interior items): visible only when its own level is active.
   - `Shell`: visible only when higher levels are active.
   - `Both`: visible both on its own level and when viewed from above (used for exterior perimeter walls,
     lawns, stairs).
3. **Add Storey Action (`addStorey`)**:
   Adding a storey (`highestLevel + FLOOR_HEIGHT`):
   - Adds a floor slab on the new level spanning the building perimeter.
   - Automatically generates perimeter shell walls (`view: 'shell'`, height 2.6 m) for the storey below if none
     exist, closing the lower floor when viewed from the new storey.
   - Inserts the new level into `levelsOf(items)`, automatically updating the level switcher in the HUD.

### 3. UI Specification

#### ObjectPanel Controls

When a structure item is selected, `ObjectPanel` displays specialized controls based on `item.kind`:

1. **Floor Item (`FloorPanel`)**:
   - Header: Kind badge `Floor`, item ID.
   - Dimensions & Bounds:
     - Center X (m), Center Z (m), Width (m), Depth (m) (derived from `min` and `max`).
     - Elevation Y (m) relative to level.
   - Surface Material:
     - Surface Type select: `wood`, `tile`, `carpet`, `grass`, `asphalt`, `paving`.
     - Repeat X, Repeat Z (integer texture tiling frequency).
     - Carpet Color: color picker (shown only when surface type is `carpet`).
     - Roughness: numeric input (0.0 to 1.0, step 0.05).
   - Level & View:
     - Floor / Level select: moves slab to chosen level.
     - View select: `Cutaway`, `Shell`, `Both`.
   - Actions: Duplicate, Delete.

2. **Wall Item (`WallPanel`)**:
   - Header: Kind badge `Wall`, item ID.
   - Geometry:
     - From: X1 (m), Z1 (m).
     - To: X2 (m), Z2 (m).
     - Length (m) and Angle (deg) readouts.
     - Height: numeric input (0.1 m to 10.0 m, step 0.1 m). Default presets: Stub (0.55 m), Partition (0.9 m),
       Full (2.6 m).
     - Elevation Y (m) relative to level.
   - Level & View:
     - Floor / Level select.
     - View select: `Cutaway`, `Shell`, `Both`.
   - Actions: Duplicate, Rotate 90°, Delete.

3. **Glass Item (`GlassPanel`)**:
   - Header: Kind badge `Glass`, item ID.
   - Geometry:
     - From: X1 (m), Z1 (m).
     - To: X2 (m), Z2 (m).
     - Bottom Y (m), Top Y (m).
     - Height (m) readout (`top - bottom`).
   - Level & View:
     - Floor / Level select.
     - View select: `Cutaway`, `Shell`, `Both`.
   - Actions: Duplicate, Rotate 90°, Delete.

4. **Box Item (`BoxPanel`)**:
   - Header: Kind badge `Box`, item ID.
   - Transform:
     - Position X (m), Position Y (m), Position Z (m).
     - Size: Width X (m), Height Y (m), Depth Z (m).
   - Material & Appearance:
     - Color: hex color picker (`<input type="color">`) + hex text input.
     - Opacity: slider / number (0.0 to 1.0, step 0.05).
     - Corner Radius: numeric input (0.0 to 0.5 m, step 0.01 m).
     - Roughness: numeric input (0.0 to 1.0, step 0.05).
     - Shadow: toggle checkbox.
   - Level & View:
     - Floor / Level select.
     - View select: `Cutaway`, `Shell`, `Both`.
   - Actions: Duplicate, Delete.

#### Panel States
- **Empty State**: No item selected. Displays a contextual hint:
  *"Click any object, wall, or floor slab to edit its properties. Press Esc to deselect."*
- **Selected State**: Displays the form fields above. All numeric inputs validate on `blur` and Enter,
  clamping to acceptable bounds and rejecting non-finite values.
- **Error State**: Non-finite or out-of-range typed inputs revert immediately to the previous valid value
  on blur with a brief visual warning. Server save errors appear in `EditorBar`.

#### Narrow Viewport Handling
- Respects the existing responsive breakpoint: below 700 px viewport width, the editor HUD and panels are
  hidden (`editingActive` is false), matching 2a/2b.
- Between 700 px and 1000 px, `PropPalette` starts collapsed.
- `ObjectPanel` and `PropPalette` enforce `min-height: 0` and `overflow-y: auto`, ensuring all inputs remain
  accessible without overflowing constrained vertical screen space.

### 4. 3D Interaction & Edit Targets (`src/scene3d/edit-layer.tsx`)

- **Selection Visual Feedback**:
  - `floor`: subtle glowing outline along the perimeter edges of the slab.
  - `wall`: glowing top cap and vertical edge outlines.
  - `glass`: translucent cyan edge borders.
  - `box`: bounding box wireframe.
- **Snap Rules**:
  - Free drag with `Alt` key held.
  - Standard drag snaps to `GRID = 0.25 m`.
  - Wall endpoints feature magnetic vertex snapping: when dragged within 0.25 m of an existing wall endpoint,
    they snap to that vertex, ensuring tight wall joins and clean corners.

## Testing Strategy

- `scene-edit.test.ts`:
  - `moveItem` with `floor`, `wall`, `glass`, `box`: verifies coordinate math, boundary clamping, and immutability.
  - `rotateItem` / `rotateBy` with structure items: verifies 90° center swap for floors and midpoint pivot for walls.
  - `duplicateItem` with structure items: verifies correct offset (+0.5 m), server-valid fields, and `MAX_ADDED` cap.
  - `deleteItem` with structure items: verifies stock override to null and removal from added items.
  - `addStorey`: verifies level height calculation, floor slab creation, and perimeter shell wall generation.
- `ObjectPanel.test.tsx` (jsdom):
  - Renders proper controls for each structure kind (`floor`, `wall`, `glass`, `box`).
  - Verifies numeric clamping, surface material selection, carpet color display, and view mode updates.
  - Verifies Duplicate and Delete action dispatching.
- `server/scene.test.ts`:
  - Integration check verifying that scenes with added floors, walls, glass, boxes, and shell views are valid
    under `validatePatch`.
- Manual/CDP headless verification checklist:
  - Select and drag a floor slab, wall, glass divider, and box.
  - Add a new storey, switch to Lantai 3, confirm Lantai 2 renders its shell view.
  - Toggle between Cutaway and Shell view in `EditorBar`.
  - Save patch, reload page, confirm restored geometry.

---

## Decisions (formerly Open Questions)

Approved by the user on 2026-10-10: all recommended defaults below are accepted as-is.

### 1. Agents seated on a deleted floor
- **Question:** If a user deletes a floor slab that holds agent desks or beds, what happens to the agents?
- **Recommended Default:** Agent desks (`desk-N`) and beds (`bed-N`) remain strictly undeletable (`!isSeatId`).
  Floor slabs are visual structure only and do not anchor agent positions. Deleting a floor slab leaves desks
  and beds in place at their 3D coordinates. If a user deletes all structure on a floor level, the level remains
  valid as long as seats exist on it. If an entire custom storey with no seats is deleted, any stray decorative
  items on that level are removed or shifted to Ground Level (level 0).

### 2. Can stairs be edited?
- **Question:** In the stock office, `Staircase` is a prop (`type: 'Staircase'`) with props `{ run, rise, width }`.
  Can users move, resize, duplicate, or delete stairs?
- **Recommended Default:**
  - The primary stock staircase (`id: 'stairs'`) cannot be deleted (`canDelete` returns false), protecting the
    visual connection between Lantai 1 and Lantai 2.
  - Users may adjust stairs position and parameters (`run`, `rise`, `width`) in `ObjectPanel`.
  - A contextual notice is displayed on the Staircase panel: *"Decorative in 2c: agent walking paths between
    floors use the stock stairwell trajectory until navigation updates in sub-project 4."*
  - Users can duplicate or place additional staircases from the palette for upper storeys.

### 3. Snapping and grid rules
- **Question:** Props snap relative to their drag start position. Should structure elements snap to relative
  offsets or absolute world grid lines?
- **Recommended Default:**
  - Structure elements snap to the **absolute 0.25 m world grid** (with `Alt` providing free, unsnapped movement).
  - Absolute grid snapping ensures walls, partitions, and floor slabs align naturally with room boundaries.
  - In addition, wall endpoints within 0.25 m of another wall's endpoint snap directly to that endpoint (vertex
    magnetic snapping) to ensure seamless room corners without gaps.

### 4. Min and max sizes
- **Question:** What are the allowable size and coordinate bounds for structure elements?
- **Recommended Default:**
  - `Floor`: min dimensions 0.5 m × 0.5 m; max dimensions 100 m × 100 m; elevation Y within ±5 m.
  - `Wall`: min length 0.25 m, max length 100 m; height between 0.1 m and 10.0 m (stock presets: 0.55 m, 0.9 m, 2.6 m).
  - `Glass`: min length 0.25 m, max length 100 m; bottom/top within ±20 m; height (`top - bottom`) ≥ 0.1 m.
  - `Box`: size per axis between 0.05 m and 50.0 m; opacity between 0.0 and 1.0; corner radius between 0.0 and 0.5 m.
  - Coordinates: clamped to the existing office pan bounds (`bounds` in `office3d-layout.ts`).

### 5. How a new storey gets walls and shell
- **Question:** When a user creates a new storey (e.g. Lantai 3), how are its floor slab and lower storey shell
  constructed?
- **Recommended Default:**
  - The "Add Storey" action performs two coordinated operations:
    1. Creates a base floor slab (`floor`) on the new level (`y = highestLevel + FLOOR_HEIGHT`) matching the
       bounding box of the storey below, leaving a default cutout for the stairwell.
    2. Inspects the storey below. If the storey below has no exterior shell walls (`view: 'shell'`), it clones
       the perimeter walls of that storey with full height (2.6 m) and tags them `view: 'shell'`.
  - This ensures that navigating to the new storey immediately presents a complete, closed building shell below.

### 6. Undo granularity
- **Question:** How are granular interactions (dragging endpoints, typing in number inputs, color changes)
  grouped into undo/redo history steps?
- **Recommended Default:** Match the proven 2a/2b pattern:
  - 3D dragging: pointer moves update live visual state only; releasing the pointer (`pointerup`) pushes exactly
    one undo step.
  - Form inputs: text and number inputs update local draft state during typing; committing on `blur` or Enter
    pushes one undo step.
  - Discrete actions (Duplicate, Delete, Add Storey, Rotate 90°, Surface Type select): each action click pushes
    exactly one undo step.

### 7. Wall junctions: independent segments vs topological graph
- **Question:** Should joined walls share vertices in a topological graph or remain independent segments?
- **Recommended Default:** Remain independent segments (`WallItem: { from: [x1, z1], to: [x2, z2] }`).
  This matches the existing simple data model, requires zero server schema changes, and avoids complex edge-split
  and node-merging graph algorithms. Magnetic endpoint snapping gives the visual benefit of closed rooms without
  graph complexity.

### 8. Floor surface materials and custom textures
- **Question:** Should users be allowed to upload custom image textures for floors?
- **Recommended Default:** No. Support only the procedural surface types already implemented (`wood`, `tile`,
  `carpet`, `grass`, `asphalt`, `paving`) plus `repeat` and carpet `color`. This respects Ruang's strict
  read-only boundary, zero-external-asset architecture, and fast procedural rendering.

### 9. Box rotation: axis-aligned vs Y-rotation
- **Question:** Should `BoxItem` support free Y-axis rotation?
- **Recommended Default:** Keep `BoxItem` axis-aligned in 2c. Rotating a box swaps its X and Z size dimensions.
  `server/scene.ts` does not currently include `rotation` in `FIELDS.box`. Keeping it axis-aligned ensures
  100% backward compatibility with zero server changes and `API_VERSION` remaining 14.
