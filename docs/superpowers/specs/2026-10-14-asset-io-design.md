# Workplace editor, sub-project 3: 3D asset import, library, and export

Date: 2026-10-14. Status: draft, awaiting review.

## Context

The workplace editor is four sub-projects (see `2026-10-10-scene-as-data-design.md`):
1. **Scene as data** (done): persistent `scene.json` patch store, custom office layout.
2. **Editor UI** (done): core manipulation (2a), object palette & properties (2b), structure & multi-storey shells (2c).
3. **Model import/export** (**this spec**): custom GLB/GLTF models, server model library, 3D placement, scene GLB export, and portable scene bundles.
4. **Agent navigation** (future): dynamic waypoints, seating anchors, and pathfinding around custom models.

Currently, the office only supports stock procedural props and architectural primitives (floors, walls, glass, boxes). Sub-project 3 introduces user-supplied 3D models into Ruang without sacrificing security, determinism, or lightweight rendering.

## Goals

- **Model Import & Storage**: upload `.glb` and single-file `.gltf` assets to a local server-side model library.
- **Strict Validation**: reject external URIs, complex compression extensions (Draco/KTX2/basisu), non-v2 specs, and files exceeding size/count limits.
- **Scene Model Items**: place imported models into the scene graph as `kind: 'model'` items, persisted in `ScenePatch.added`.
- **Consistent Normalization**: auto-scale models to a standardized 1.5 world-unit footprint with configurable uniform scale, centered on X/Z with bottom aligned to level elevation.
- **Export Capabilities**:
  - Download individual models from the library.
  - Export the live 3D scene graph as a standalone `.glb` file using `three/addons/exporters/GLTFExporter.js`.
  - Export and import self-contained `ruang-bundle` JSON files containing custom scene additions and base64 model payloads.
- **Editor UI**: "Imported" palette category, model library manager, export actions in EditorBar, styled with `styles.css` design tokens, responsive down to ~480px.

## Non-goals

- Animated models or skeletal rigs (static meshes only).
- Dynamic agent walking path recomputation around custom models (deferred to sub-project 4).
- Multi-user real-time collaborative editing.
- Remote URL fetching (all uploads are direct client-to-server payloads).
- Multi-file glTF assets (external `.bin` buffers or separate image textures are strictly rejected).

## Scope & Security Boundary

- **Supported Formats**: Binary glTF (`.glb`) and self-contained text glTF (`.gltf`).
- **Rejection Rules**:
  - `asset.version` must evaluate to `"2.0"`.
  - Rejection of extensions requiring specialized decoders: `Draco` (`KHR_draco_mesh_compression`), `KTX2` (`KHR_texture_basisu`), or generic Basis Universal. If present in `extensionsRequired` or `extensionsUsed`, upload fails with 400.
  - External URIs: any `buffers[].uri` or `images[].uri` must either be omitted or be an inline `data:` URI. External `http:`, `https:`, relative paths, or filesystem references trigger immediate rejection.
- **Storage Boundaries**:
  - Storage directory: `$RUANG_DATA_DIR/models/` (fallback `~/.local/share/ruang/models/`).
  - Atomic writes via temporary file and rename; file mode `0600`, directory mode `0700` (mirroring `server/skin-library.ts`).
  - Library capacity cap: default 100 models. Size cap: default `RUANG_MODEL_MAX_BYTES = 10485760` (10 MiB per model).
  - Never reads or writes outside `$RUANG_DATA_DIR`; never touches Hermes profiles.

## Data Model & Server API

### Model Record

```ts
export interface ModelRecord {
  id: string          // 'm-' followed by 12 lowercase hex characters (e.g., 'm-a1b2c3d4e5f6')
  name: string        // Sanitised filename: [A-Za-z0-9 ._-], max 64 chars, default 'model'
  format: 'glb' | 'gltf'
  size: number        // Integer byte size
  createdAt: string   // ISO 8601 timestamp
}
```

Metadata index is maintained at `$RUANG_DATA_DIR/models/index.json`. Model files are stored at `$RUANG_DATA_DIR/models/<id>.<format>`.

### REST Endpoints (`server/models.ts`)

All endpoints sit behind the existing access-code middleware, `matchOriginHost` validation, and standard rate limiting. Error responses strictly follow `{ error: string }`.

- `GET /api/models`: Returns `200 { models: ModelRecord[] }` sorted by `createdAt` descending.
- `POST /api/models?name=<filename>`:
  - Consumes raw body (`application/octet-stream`, `model/gltf-binary`, `model/gltf+json`).
  - Returns `201 { model: ModelRecord }`.
  - Error codes:
    - `400`: Invalid glTF/GLB structure, external URI, or unsupported extension.
    - `409`: Model library full (count >= 100).
    - `413`: Payload exceeds maximum size limit (default 10 MiB).
    - `415`: Unsupported Content-Type.
    - `429`: Rate limit exceeded.
- `GET /api/models/:id/file`:
  - `id` validated against `/^m-[0-9a-f]{12}$/`.
  - Headers: `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment; filename="<sanitised-name>.<ext>"`.
  - Returns binary bytes or `404 { error: 'Model not found' }`.
- `DELETE /api/models/:id`:
  - Checks if `id` is referenced by any `kind: 'model'` item in `scene.json`.
  - Returns `204 No Content` on success.
  - Returns `404 { error: 'Model not found' }` if missing.
  - Returns `409 { error: 'Model is currently in use', usedBy: string[] }` containing referencing scene item IDs.

## Scene Schema & Renderer

### Scene Item Schema (`src/scene3d/scene.ts`, `server/scene.ts`)

```ts
export interface ModelItem {
  id: string
  kind: 'model'
  level: number
  modelId: string              // References ModelRecord.id
  position: [number, number, number]
  rotation?: number            // Y-axis rotation in radians (default 0)
  scale?: number               // Uniform multiplier > 0 and <= 100 (default 1)
  view?: 'cutaway' | 'shell' | 'both'
}
```

- Validation: `modelId` matching `/^m-[0-9a-f]{12}$/` and `position` are required.
- Saved in `ScenePatch.added`.
- `ScenePatch` versioning:
  - Version bumped to 2: `{ version: 2, overrides: {...}, added: [...] }`.
  - Server accepts version 1 or 2 payloads, always normalizes and saves as version 2.
  - Client initializes `EMPTY_PATCH` with `version: 2`. Version 1 scenes load backward-compatibly without data loss.

### Normalization & Rendering (`src/scene3d/scene-renderer.tsx`)

1. **Geometry Normalization**:
   - Compute bounding box of imported root scene.
   - Calculate max bounding box dimension: `maxDim = Math.max(size.x, size.y, size.z)`.
   - Base scale factor: `s = (1.5 / maxDim) * (item.scale ?? 1.0)`.
   - Center geometry along X and Z relative to item position.
   - Align min-Y of bounding box flush with `position[1]`.
2. **Loading & Fallbacks**:
   - Three.js `GLTFLoader` fetches model data from `/api/models/:id/file`.
   - Loading placeholder: neutral bounding box mesh (1.5 m cube).
   - Error placeholder: red-tinted box mesh with warning state.

## Portability & Bundles

### Bundle Format (`ruang-bundle`)

```ts
export interface RuangBundle {
  format: 'ruang-bundle'
  version: 1
  exportedAt: string
  patch: {
    version: 2
    overrides: Record<string, unknown>
    added: SceneItem[]
  }
  models: Array<{
    id: string
    name: string
    format: 'glb' | 'gltf'
    dataBase64: string
  }>
}
```

- **Export Scope**: exports custom `added` scene items and only models actively referenced by those items.
- **Import Strategy**:
  - Client caps: bundle file <= 40 MiB, maximum 20 bundled models.
  - Upload models to `/api/models` sequentially, generating new server-side IDs (prevents overwriting local assets).
  - Remap `modelId` references in imported items to new server IDs.
  - Re-generate `id` for imported scene items that collide with existing items.
  - Append items into active patch and persist via `PUT /api/scene`.

### Scene GLB Export

- Dynamically loads `three/addons/exporters/GLTFExporter.js`.
- Exports live rendered scene graph (cloned and cleaned of editor helpers/wireframes) with `{ binary: true }`.
- Triggers instant browser download as `<office-name>-scene.glb`.

## UI & Integration

- **Palette**: "Imported" section in `PropPalette.tsx` showing library models as selectable thumbnail cards.
- **Library Dialog**: accessible from EditorBar; displays model name, file size, thumbnail/icon, download single GLB action, and delete button with dependency protection.
- **Upload Action**: drag-and-drop or file picker button on the palette; shows upload progress, file validation errors, and success notifications.
- **Styling**: strictly adheres to `styles.css` design tokens, flat aesthetics (no floating drop shadows), full dark/light theme support, responsive down to ~480px.
