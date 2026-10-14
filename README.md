# Ruang · Hermes 3D Virtual Office

*Ruang* is Indonesian for "room" or "space". It is a 3D virtual office and mission control for your local [Hermes Agent](https://hermes-agent.nousresearch.com) and OpenCode crew. See who is working and what they are doing, plus the Kanban board, cron jobs, sessions, memory, folders and logs, all in one place. Everything is read through the `hermes` CLI; Ruang is read-only toward Hermes and never changes anything in Hermes profiles (custom agent skins and the saved office scene are stored separately in Ruang's own data directory).

![The 3D office: an agent at work at its desk, and idle agents playing ping-pong and console games in the game room](docs/screenshots/office.png)

![Mission control statistics in the evening theme](docs/screenshots/mission-control.png)

## Install

Works on macOS, Linux and Windows through WSL2. You need the Hermes Agent CLI (`hermes`) installed; `opencode` is optional. The installer downloads its own Node.js if you do not have Node.js 20 or newer.

```bash
curl -fsSL https://raw.githubusercontent.com/yugienugraha/ruang/main/install.sh | bash
```

Then start it and open http://127.0.0.1:3001:

```bash
ruang                        # or: ruang --port 3005
```

- **Run it in the background, and at boot (Linux):** add `--service` to install a systemd user service:
  `curl -fsSL https://raw.githubusercontent.com/yugienugraha/ruang/main/install.sh | bash -s -- --service`
  To keep it running after you log out, also run `loginctl enable-linger $USER`.
- **Update:** run the install command again.
- **Remove:** add `--uninstall` (`... | bash -s -- --uninstall`).
- **Other options:** `--version v0.2.0` installs a specific release; `--from-source` builds the latest `main` (needs `git`). See `install.sh --help`.
- **On a server:** Ruang listens on `127.0.0.1` only. From your laptop, run `ssh -L 3001:127.0.0.1:3001 user@server`, then open http://127.0.0.1:3001.

Everything goes into `~/.local/share/ruang`, plus the `ruang` command in `~/.local/bin`. Installs made under the project's earlier names (`mission-control`, `majujaya`) are cleaned up automatically. No sudo is used and nothing is installed system-wide. Prefer to read the script before running it? `curl -fsSL https://raw.githubusercontent.com/yugienugraha/ruang/main/install.sh -o install.sh`, read it, then `bash install.sh`.

**With your own Node.js 20+:** download `ruang.tgz` from the [latest release](https://github.com/yugienugraha/ruang/releases/latest) and run `npm install -g ./ruang.tgz`. Once the package is on npm this becomes `npm install -g ruang` (or `npx ruang`).

## Development

Requires Node.js 20+ and `hermes` on the `PATH` of the shell that starts the server.

```bash
git clone https://github.com/yugienugraha/ruang.git
cd ruang
npm install
npm run dev        # API on 127.0.0.1:3001 + Vite UI (open the URL Vite prints, usually http://localhost:5173)
```

Production from a checkout (single process, serves the built UI and the API):

```bash
npm run build      # builds the UI into dist/ and the server into build/server/
npm start          # open http://127.0.0.1:3001
```

Checks: `npm run lint`, `npm test`, `npm run build`.

**After pulling new code** run `npm install && npm run build` and restart `npm start` (a running `npm start` keeps serving the old API; `npm run dev` restarts the API by itself). The UI checks `/api/health` and shows a *Restart needed* banner when the server is older than the page. Set `RUANG_PORT` (or pass `--port`) to change the port. The server binds to `127.0.0.1` only. The older `MISSION_CONTROL_*` settings still work.

**Releasing:** bump the version and push the tag, for example `npm version 0.2.1 && git push origin main --follow-tags`. The *Release* workflow then lints, tests, builds and attaches `ruang.tgz` to a GitHub release, which the installer picks up. To also publish to npm, add an `NPM_TOKEN` repository secret.

## Pages

- **Agents**: every agent on this machine, with model, gateway state and what it is doing in the office. Agents are discovered, not configured: every Hermes profile from `hermes profile list` is an agent, plus OpenCode when it is installed. New profiles appear automatically, and each agent gets its own character colours derived from its name.
- **Office** (home page): the office fills the screen below the header. A HUD across the top shows crew active, gateways running, running/open tasks, the next cron run and (when any) failed CLI reads; chips link to their page. The **Panel** button opens one side panel with three tabs: **Crew** (crew snapshot and a clickable list of stations), **Stats** (statistics across every source, token usage, the Kanban status breakdown, runtime and what is up next; tiles link to their pages) and **Activity** (unattributed session metadata and messaging channels). The **Tasks**, **Calendar** and **Tokens** buttons open the Task Board, a month calendar of cron runs or token usage over the office, without leaving it (Esc or ✕ closes them; *Open full page* goes to the page). `#/dashboard` opens the Office.

  The view switches between **3D** (the default) and **2D**, remembered per browser; browsers without WebGL stay on 2D. The 3D view (three.js via React Three Fiber, loaded only when used) is an office of several rooms with an Indonesian touch:
  - the workspace: hot desking, with one unlabeled desk per agent in two rows (the building widens for a larger crew), and a meeting table with gorengan (fried snacks) on it
  - a lounge behind a glass partition, where the sofa faces a TV on the back wall
  - a game room through a door from the lounge: ping-pong, two arcade machines, a console corner with beanbags, and a karambol (carrom) board
  - a pantry with a galon (water-jug) dispenser
  - split ACs on the walls (outdoor units behind the building) and suspended cool-white LED office lights
  - the Merah Putih flag at the corner of the grounds
  - in the alley beside the building, out of the main view: a bakso (meatball soup) cart and a kopi keliling (coffee bike), each with its vendor

  It follows the theme: day in light mode, evening in dark mode, when the office lights, street lamps and cart lamps light up. The office building, rooms and furniture use procedural textures with no external 3D model files, while agent characters render with classic 3D character skins (procedural defaults or custom 64x64 PNG textures; see *Agent skins*). Drag to rotate, scroll to zoom, and pan with right-drag, two fingers, the arrow keys, or the **Geser** button (which makes a plain drag pan). Panning stays within the grounds, and **Reset view** returns to the starting view.

  The building has two floors; the buttons at the top left of the 3D view (or Page Up / Page Down) switch between them, each showing how many agents are on it. **Lantai 1** is the office. **Lantai 2**, up the stairs by the entrance, has a dorm bedroom with one bed per agent, a lesehan corner, a bathroom, and a ruko-style balcony with rattan chairs, a hammock, a clothes line and string lights; the lower floor turns into a closed building below it, and agents outside on the ground stay in view. Idle agents also go upstairs to sleep, nap in the hammock or sit on the balcony; the **💤 Tidur** button sends every idle agent to bed (remembered per browser, like the floor). Sleeping is decorative only, like the rest of the idle wandering.
  Each agent has its own desk. An agent replying to a chat walks to the meeting table; one running a cron job, tools or a Kanban task sits at its desk with a speech bubble saying what it is doing. Agents walk along the aisle and use the entrance, never through furniture or walls. Idle agents do not just sit: every 32 seconds each one moves on to another stop, such as relaxing in the lounge, ping-pong, arcade games or the console in the game room, getting water from the galon, the kitchen, bakso on the cart's stools, coffee at the bike, or a stroll to the flag or the bookshelf. A dashed bubble says where they are. This wandering is decorative only (the same clock-based route for everyone), and the Idle state itself comes from the server. Click an agent for its detail dialog, with four tabs: **Overview** (state, task, provenance, freshness), **Folder** (that agent's own folder, read-only, as on the Folders page), **Memory** (its SOUL.md, MEMORY.md, USER.md and context files) and **Skin** (custom 3D character skin, 64x64 pixel editor, PNG import/export, save/reset, and AI prompt generation; see *Agent skins* below).
- **Task Board**: Hermes Kanban in board order (triage → todo → scheduled → ready → running → blocked → review → done) with search, assignee filter and priority. Tasks from every Kanban board are shown (not only the current one), with a board filter when there is more than one. Each column is at most as tall as the screen and scrolls on its own, so the board's sideways scrollbar stays in view; the strip above the board scrolls it (‹ ›) or jumps to a column by its status chip. Click a card for its full detail from `hermes kanban show <id> --json`: description, result or latest summary, workspace, branch, skills, model, timestamps, dependencies (clickable), runs, comments and activity. Free text is secret-redacted; only ids on the board snapshot can be opened.
- **Calendar**: a month calendar of the cron runs of every agent (each job is labelled with its agent, and the calendar can be filtered by agent) (upcoming runs from today, repeating jobs, overdue runs and last-run outcomes, read from 5-field cron expressions and `every …` intervals, in the Hermes host's local time), plus the list of jobs with status, next run, overdue and last-run outcome. Paused jobs only show their last run.
- **Activity**: the 20 most recent sessions with search.
- **Memory**: per agent, what it carries into every session (following the Hermes memory and context-file docs):
  - `SOUL.md` (identity, system-prompt slot #1)
  - `memories/MEMORY.md` (agent notes) and `memories/USER.md` (user profile), split into their `§` entries, with a usage bar against the configured limit (defaults 2,200 / 1,375 chars from `memory.*` in `config.yaml`) and a warning above 80%
  - context files present in the profile (`HERMES.md`, `.hermes.md`, `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`)
  - the memory settings (enabled stores, `write_approval`, external provider)

  OpenCode shows its global `AGENTS.md`/`CLAUDE.md`. Entries are searchable. Everything is read through the Folders safety layer, so it is read-only, confined to the agent's folder and secret-redacted. `#/knowledge` opens this page.
- **Folders**: one folder per agent, and only that agent's folder: a Hermes profile `<name>` → `~/.hermes/profiles/<name>`, OpenCode → `~/.opencode`. Browse sub-folders and view files read-only. See *Folders* below.
- **Logs**: tails of `hermes logs agent|gateway|errors` with level filter, search and follow mode, plus an audit of every command the server ran (the *Command audit* tab).
- **Settings**: the optional access code and profile lock. See *Access code* and *Profile lock* below.

**Token usage** (the **Usage** page in the menu, the **◔ Tokens** button in the Office, and the Panel's Stats tab) adds up `hermes insights` of every agent, because Hermes keeps sessions per profile. Pick 24 hours, 7 days or 30 days to see:
- total tokens, input/output, estimated cost, sessions, messages and tool calls for the whole crew, plus the top consumer
- **By agent**: every agent ranked by tokens with its share of the total; hover for input/output, sessions, cost and its biggest session
- **By kind of work**: tokens per session source, such as Kanban tasks, cron jobs, Telegram or the terminal
- **By model** and **Top tools**, across all agents

The agent dialog in the Office shows that agent's tokens over 7 days and its rank. Per-source and per-model counts include cache tokens, so they can add up to more than the total. An agent whose insights cannot be read shows as *Not Available* while the others still count. Tokens per Kanban task are not available: Hermes does not record them per task.

Navigation is a drawer, closed by default like a game menu: open it with the ☰ button or the **M** key, and close it with Esc, a click outside, or by choosing a page. A dot on ☰ flags failed CLI reads or stopped gateways. The header has one light/dark theme toggle (remembered per browser) and Refresh. All pages poll automatically, keep the last good data (marked stale) if a refresh fails, and have a manual refresh. "Refresh all" bypasses the 10-second server cache for anything older than 2 seconds. Pages are addressable by URL hash (for example `#/task-board`).

## Access code

Off by default. Turn it on in **Settings → Access code** to ask for a code every time Ruang is opened in a browser. It works like an API key rather than a username and password:

1. Choose **Generate** (a random code such as `ruang-7KQ4-M2XD-9PWT-H6RA`) or **Custom** (at least 12 characters, typed twice).
2. **Download .txt** or **Copy** it. The code is only shown while you set it, and Ruang has no password reset, so the downloaded file is your backup.
3. Tick *I have saved this code*, optionally *Remember this device for 7 days*, and turn it on.

Every browser then shows an unlock screen first. Without *Remember*, a session ends when the browser closes (and after 12 hours at most). **Change code** and **Turn off** need the current code; changing or removing it signs out every browser. **Lock this browser** ends the current session.

Lost the code? On the machine that runs Ruang:

```bash
ruang access-code off      # remove it, then set a new one in Settings
ruang access-code new      # or print a new random code
ruang access-code status
```

How it is protected:
- Only a scrypt hash of the code is stored, with a random secret that signs sessions, in `~/.config/ruang/access.json` (mode `0600`; `RUANG_CONFIG_DIR` or `XDG_CONFIG_HOME` move it). The code itself is never stored, logged or kept in the browser.
- The server enforces it: while locked, every `/api` route except `/api/health` and the unlock route answers `401`, so no Hermes data reaches the browser. The UI shell itself is static and carries no data.
- Sessions use an `HttpOnly`, `SameSite=Strict` cookie. Changes need a same-page request header, so other sites cannot make them.
- After 5 wrong codes, each further try from the same address waits longer (1 s, doubling, up to 5 minutes).
- A damaged `access.json` keeps Ruang locked rather than open; `ruang access-code off` clears it.
- This write touches Ruang's own config, never Hermes.

Ruang listens on `127.0.0.1`, so the code matters when you reach it from other devices, for example through an SSH tunnel, Tailscale or a reverse proxy. Over plain HTTP the code crosses the network unencrypted; use an HTTPS tunnel or Tailscale for that.

## Profile lock

Off by default. In **Settings → Profile lock**, pick the agents to lock and set one 6-digit PIN, like app lock on a phone. A locked agent still works and still appears in the office (with 🔒 by its name, and its state such as Working or Idle), but its private data stays hidden until the PIN opens that agent in this browser for 15 minutes:

| Data | While locked |
|---|---|
| Folder and file contents, memory (SOUL.md, MEMORY.md, USER.md, context files) | refused (HTTP 423); the Folder and Memory tabs ask for the PIN |
| Kanban tasks assigned to it | the card stays, titled *🔒 Private task*; its details ask for the PIN |
| Its cron jobs | the schedule stays, named *🔒 Private job* |
| Live activity and current task in the office | generic (*🔒 Working*, *On a break*) |
| Sessions, logs and the latest session (these come from the `default` profile) | hidden when `default` is locked |
| Token usage | totals stay; its biggest session is hidden |

Unlocking one agent does not unlock the others, and **🔒 Lock again** closes it early. Changing the locked agents, the PIN or turning the lock off needs the current PIN; a new PIN locks every agent again. The server enforces all of this per request, not just the page.

- Only a scrypt hash of the PIN is stored, in `~/.config/ruang/profile-lock.json` (mode `0600`), next to the access code.
- Unlocks are signed, per agent, in an `HttpOnly`, `SameSite=Strict` cookie that expires after 15 minutes.
- After 5 wrong PINs each try waits longer (1 s, doubling, up to 5 minutes); after 10 wrong PINs, an hour.
- A damaged lock file keeps every agent locked. Lost the PIN? On the machine: `ruang profile-lock off` (and `ruang profile-lock status`).
- The lock covers what Ruang shows. Anyone with a shell on the machine can still read `~/.hermes` directly, and Hermes itself is unchanged.

## Office scene

The 3D office is rendered from a scene document: the built-in office (generated from your crew size) plus an optional saved patch of edits. The patch lives in `scene.json` under `$RUANG_DATA_DIR` (default `~/.local/share/ruang`; file mode `0600`, written atomically) and is shared by everyone who opens this Ruang. A missing, unreadable or invalid file simply means "no edits": the stock office renders.

| Route | Purpose |
|---|---|
| `GET /api/scene` | The saved patch `{ "version": 1, "overrides": { "<item id>": { ...fields } \| null }, "added": [ ...items ] }` (empty when nothing is saved). |
| `PUT /api/scene` | Replace the patch (`application/json`, max 256 KiB, same-origin only, strictly validated). |
| `DELETE /api/scene` | Reset to the stock office. |

### 3D models and asset I/O

Import your own 3D models into the office, manage them in a library, and export the office.

**Importing models.** Use *+ Upload Model* in the *Imported* group of the *Objects* palette, or in the model library opened from **📦 Models** in the editor toolbar.

- Accepted: binary `.glb`, and single-file `.gltf` with embedded data (data URIs). A `.gltf` must be glTF 2.x.
- Limit: 10 MiB per file by default (`RUANG_MODEL_MAX_BYTES`, see the environment table).
- Rejected: Draco, KTX2 and meshopt compression, and external buffer or image URIs.
- Imported models appear in the palette's *Imported* group. The client normalises each model so its largest bounding-box side is 1.5 units times the placement scale.
- The server keeps at most 100 models.

**Model library.** **📦 Models** lists the library with a search box. Each model has an *Export* link (downloads the original file) and a *Delete* button with an inline confirmation. A model that a scene item uses cannot be deleted; the server answers 409 with the ids of the items that use it.

**Export.** The editor toolbar has these export controls:

- *Export* on a model card: the original `.glb` or `.gltf` file, unchanged.
- *Export scene (.glb)*: the whole office as one binary `.glb` (`ruang-scene-<yyyymmdd-hhmm>.glb`). Items marked `userData.noExport` are left out.
- *Export Bundle*: a `ruang-bundle` JSON file (`ruang-bundle-<yyyymmdd-hhmm>.json`) with the scene patch and the models it uses, base64-encoded.

**Import Bundle.** *Import bundle* in the toolbar takes a `.json` bundle. Rules:

- Caps: 40 MiB file, 20 models, 500 items, 10 MiB per decoded model.
- Each model is uploaded as a new library model with a new server id. Nothing in the library is overwritten, so importing the same bundle twice creates copies.
- Item ids that collide with existing ids are re-numbered, and placed items are re-pointed to the new model ids.
- Bundle overrides are ignored on import to protect existing office items (import is append-only).
- The import is one undoable edit. If an upload fails, the models already uploaded are deleted again.

**Storage.** Models live in `$RUANG_DATA_DIR/models` (default `~/.local/share/ruang/models`). The directory is `0700`, the files and `index.json` are `0600`, and writes are atomic.

**Scene patch version 2.** Model items use patch version 2 (`modelId`). Version 1 patches still load; saving writes version 2.

| Route | Purpose | Status codes |
|---|---|---|
| `GET /api/models` | List the library: `{ models: [{ id, name, format, size, createdAt }] }`. | 200 |
| `POST /api/models?name=<filename>` | Upload one model. Body is the raw file; `Content-Type` must be `model/gltf-binary`, `model/gltf+json` or `application/octet-stream`. | 201; 400 invalid file; 409 library full; 413 too large; 415 wrong content type; 429 rate limit (10 per minute per IP) |
| `GET /api/models/:id/file` | Download the original file (`attachment`, `nosniff`). | 200; 404 |
| `DELETE /api/models/:id` | Delete a model. | 204; 404; 409 with `usedBy` when a scene item uses it |

All model routes sit behind the access code. `POST` and `DELETE` also check the same origin, as the skin routes do.

**Non-goals:** Draco, KTX2 and meshopt compression; external URIs; multi-file glTF; editing a model's geometry; sharing models between Ruang installs except through a bundle.

`overrides` merge fields into a built-in item by id (`null` deletes it; the crew's `desk-N` and `bed-N` can be moved but not deleted). The patch can be edited in the app (see *Editing the office*) or by hand. Agent routes (idle stops, walking paths) do not follow moved furniture other than desks and beds.

Notes for editing the patch by hand:

- `level` is the base height of the item's storey (0 or 2.8 in the stock office). Every distinct `level` value becomes a floor tab. Moving an item to another floor means changing both its `level` and its y.
- Overrides are a shallow merge: an override of `props` replaces the whole `props` object, so give all of its keys.
- Item ids are listed in `src/scene3d/default-scene.ts`.

### Editing the office

Press **✎ Edit** (bottom right of the 3D office) to rearrange it from the UI. Click an object or window to select it (a yellow box appears), drag it to move it (movement happens in 0.25 m steps from where the object started; hold **Alt** for free placement), press **R** / **Shift+R** to rotate by +15° / -15°, **Delete** or **Backspace** to remove it, **Esc** to deselect, **Ctrl/Cmd+Z** to undo and **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** to redo. The panel at the top right has exact X, Z, rotation and floor fields. Desks and beds can be moved but not deleted (they follow the number of agents). **Save** writes your changes to the shared scene (see *Office scene*), **Reset to default** removes every saved edit, **Done** leaves edit mode (it asks if you have unsaved changes).

- **Add objects.** The *Objects* palette (left; it starts collapsed below 1000 px wide, and editing is unavailable at 700 px or narrower) lists every object type. Pick one, then click the floor: it is placed on the floor you are viewing, snapped to 0.25 m (hold Alt for free placement). You stay in placing mode for the next one until you press Esc, right-click, or click the active entry again. Dragging still moves the camera. Placing needs a pointer (mouse or touch); there is no keyboard path yet. Desks and beds you add are decoration, not agent seats.
- **Duplicate** the selected object with the *Duplicate* button or Ctrl/Cmd+D (the copy is half a metre over).
- **Properties.** Size, length, run/rise/width and colour appear in the object panel for the objects that have them, including the stock ones.
- At most 500 added objects can be saved.

Editing is unavailable when the window is 700 px wide or narrower. The editor handles objects and windows; floors, walls and glass cannot be added or edited yet. Agents' walking routes still follow the stock layout, so a moved sofa does not re-route them (desks and beds do move their agents' seats).

## Agent skins

Agents in the 3D office render with classic 3D character models using standard Minecraft 64x64 RGBA PNG skins (with optional second-layer overlays for hats, jackets, sleeves and pants, and classic 4px arms).

- **Default appearance:** When an agent has no saved skin, a unique appearance is painted client-side from `agentLook(id)` based on the agent's name. Nothing is saved to disk by default.
- **Skin tab & editor:** Clicking an agent in the Office opens its detail dialog. The **Skin** tab provides a live 3D character preview alongside an interactive 64x64 pixel canvas:
  - **Tools:** Pencil, Eraser, Fill bucket, and Eyedropper (color sampler).
  - **Color controls:** Color picker, palette swatches, and recent color history.
  - **Canvas helpers:** Undo and Redo (60-step history), Clear part (head, body, arms, legs, or all), Grid overlay toggle, and Outlines/Overlay toggle.
  - **Import & Export:** **Import PNG** loads any standard 64x64 RGBA PNG (validated up to 16 KiB); **Export PNG** downloads the current skin as `<id>.png`.
  - **Save & Reset:** **Save** writes the skin to Ruang's skin store (`PUT /api/skins/:id`); **Reset** deletes the saved skin (`DELETE /api/skins/:id`) and reverts immediately to the procedural default look.
- **Prompt generation:** An integrated prompt panel allows generating skins or partial outfits via text prompts (1 to 300 characters):
  - Choose a target part (`all`, `head`, `body`, `arms`, `legs`) to update the full skin or modify specific parts while preserving the rest of the existing skin.
  - Generation runs asynchronously: the panel displays an elapsed timer and job status (`queued`, `running`, `done`, `error`). The generated 64x64 texture loads directly into the editor for review and refinement before saving. Prompt generation never saves to disk automatically.
  - Rate-limited to 6 requests per minute per IP. Concurrency is limited to 1 active generation job server-wide (returns HTTP 409 busy if another job is in progress).

### Skin generation providers

Ruang supports three backend skin generation providers:

1. **BLOCK provider (`block`, default):**
   - High-fidelity two-stage pipeline combining Google Flow / Nano Banana Pro and a local BLOCK skin converter service (`http://127.0.0.1:8093`).
   - Stage 1 (`preview`): Prompts Google Flow with the dual-panel reference layout (`~/block-skin/ref_layout.png`) and model `nano-banana-pro` to render front and back Minecraft character views on pure white background.
   - Stage 2 (`convert`): Submits the rendered preview to the BLOCK service converter, which generates a 64x64 RGBA texture and merges selected body parts.
   - Requires both Google Flow service (`http://127.0.0.1:8092`) and BLOCK service (`http://127.0.0.1:8093`) running.
   - **Service startup:**
     ```bash
     ~/google-flow-mcp/flow-up.sh              # ensure Google Flow session
     ~/google-flow-mcp/image-service.sh start  # start Flow image service (port 8092)
     ~/block-skin/block-service.sh start       # start BLOCK converter service (port 8093)
     ```
2. **Google Flow direct provider (`flow`):**
   - Direct generation powered by Google Flow / Nano Banana through a local HTTP image service (`http://127.0.0.1:8092`) with uv-template rendering.
   - **Credits warning:** Each real generation spends Google Flow credits. Generation runs sequentially (1 job at a time server-wide) and typically takes 1–3 minutes.
   - **Service startup:** The Flow image service does not start automatically with Ruang. Start it manually before use:
     ```bash
     ~/google-flow-mcp/image-service.sh start
     ~/google-flow-mcp/image-service.sh status   # check health
     ~/google-flow-mcp/image-service.sh stop     # stop service
     ```
     Requires an active Google Flow session logged in via `flow-up.sh`.
3. **LLM provider (`llm`, fallback):**
   - Fallback provider that prompts an OpenAI-compatible LLM to output structured JSON pixel coordinates and colors, which the server renders into a 64x64 PNG.
   - Enabled by setting `RUANG_SKIN_PROVIDER=llm`.

### Skin storage and safety

- **Storage path:** Custom skins are stored as single PNG files named `<id>.png` under `$RUANG_DATA_DIR/skins` if `RUANG_DATA_DIR` is set, or `~/.local/share/ruang/skins` by default. Directory permissions are set to `0700` and file permissions to `0600`.
- **Atomic writes:** Files are written to temporary files and atomically renamed to prevent corruption and support shared multi-device access.
- **Read-only boundary:** Ruang writes only its own files: the access code and profile lock in `~/.config/ruang`, and skins and `scene.json` in `RUANG_DATA_DIR`. Ruang stays strictly read-only toward Hermes and never writes into `~/.hermes` or profile directories.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `RUANG_DATA_DIR` | `~/.local/share/ruang` | Base data directory; custom skins are stored under `$RUANG_DATA_DIR/skins` and edits to the office scene in `$RUANG_DATA_DIR/scene.json`. |
| `RUANG_MODEL_MAX_BYTES` | `10485760` | Maximum size of one uploaded 3D model in bytes (10 MiB). Non-numeric or non-positive values fall back to the default. |
| `RUANG_SKIN_PROVIDER` | `block` | Generation provider: `block` (BLOCK converter + Flow preview), `flow` (Google Flow direct), or `llm` (LLM pixel fallback). |
| `RUANG_BLOCK_URL` | `http://127.0.0.1:8093` | URL of the local BLOCK skin converter service. |
| `RUANG_BLOCK_REF_LAYOUT` | `~/block-skin/ref_layout.png` | Reference image path passed to Flow for character framing and style layout. |
| `RUANG_BLOCK_OUTPUT_DIR` | `~/.hermes/cache/ruang-skins-block` | Directory where the BLOCK converter writes generated 64x64 skins. |
| `RUANG_FLOW_URL` | `http://127.0.0.1:8092` | URL of the local Google Flow image service. |
| `RUANG_FLOW_OUTPUT_DIR` | `~/.hermes/cache/ruang-skins-flow` | Directory where the Flow image service writes generated images. |
| `RUANG_LLM_BASE_URL` | `http://127.0.0.1:20128/v1` | Base URL for OpenAI-compatible LLM endpoint (when using `llm` provider). |
| `RUANG_LLM_API_KEY` | *(empty)* | Optional API key for LLM endpoint. |
| `RUANG_LLM_MODEL` | `ag/gemini-3.8-flash-medium` | Model name for LLM pixel generation. |
| `RUANG_LLM_TIMEOUT_MS` | `90000` | Request timeout in milliseconds for LLM generation (90 seconds). |

Flow image service environment variables (configured for `image-service.mjs` / `image-service.sh`):

| Variable | Default | Description |
|---|---|---|
| `FLOW_IMAGE_MODEL` | `nano-banana-2-lite` | Google Flow image model (`nano-banana-pro`, `nano-banana-2`, `nano-banana-2-lite`). |
| `FLOW_IMAGE_DAILY_CAP` | `30` | Daily limit on real image generations to protect credits. |
| `FLOW_DRY_RUN` | `0` | Set to `1` to run test generations without consuming Google Flow credits. |

### Skin API

All skin routes are protected by the Access Code when enabled. Mutating endpoints (`PUT`, `DELETE`, `POST`) enforce same-origin validation (`Origin` header matching `Host`). Profiles locked via Profile Lock return HTTP 423 until unlocked.

| Method & Route | Description |
|---|---|
| `GET /api/skins` | Returns a JSON array of saved skins: `[{ id, version, updatedAt }]`. |
| `GET /api/skins/:id.png` | Returns the raw 64x64 PNG binary (`Content-Type: image/png`, `Cache-Control: no-store`) or 404 if not found. |
| `PUT /api/skins/:id` | Uploads and saves a 64x64 RGBA PNG (raw body, `Content-Type: image/png`, max 16 KiB); returns `{ id, version, updatedAt }`. |
| `DELETE /api/skins/:id` | Deletes the saved skin and resets the agent to its procedural default look; returns `{ ok: true }`. |
| `POST /api/skins/generate` | Starts async skin generation: body `{ prompt: string, part?: "all"\|"head"\|"body"\|"arms"\|"legs", base?: string }` (prompt 1..300 chars, optional base64 PNG). Returns `202 Accepted` with `{ jobId }`. Rate-limited to 6/min; returns `409` if another job is running. |
| `GET /api/skins/generate/:jobId` | Polls generation status; returns `{ status: "queued"\|"running"\|"done"\|"error", png?: string, notes?: string, error?: string }`. |

The server uses only these fixed, read-only commands:
- `hermes profile list` (the agents and their gateway states), `opencode --version`
- `hermes kanban boards list --json`, then `hermes kanban --board <slug> list --json` for each board with tasks (at most four at a time; plain `hermes kanban list --json` on Hermes versions without boards), and `hermes kanban --board <slug> show <id> --json` (task detail)
- `hermes -p <profile> cron list --all` for every profile in `hermes profile list` (Hermes keeps cron jobs per profile), `hermes sessions list --limit 20`, `hermes skills list --enabled-only`
- `hermes status --all`, `hermes logs <agent|gateway|errors> -n 200`
- for token usage, for every profile (at most four at a time): `hermes -p <profile> insights --days <1|7|30>`
- for live Office activity, for every profile (at most four at a time): `hermes -p <profile> logs agent -n 80 --since 3m` and `hermes -p <profile> sessions list --limit 3`

How they run:
- Commands run with `NO_COLOR=1` and a wide `COLUMNS` so the plain-text formats parse reliably.
- The default gateway state is derived from `hermes profile list`; no separate default gateway command is run.
- Each command is executed with `execFile` and an 8-second process timeout. Its endpoint result is cached for 10 seconds (insights: 60 seconds; logs: 5 seconds), and concurrent requests share one in-flight read.
- Browser input never reaches a shell command.

Only normalized data is exposed:
- profile/model, gateway state, OpenCode version
- Kanban title/status and recognized cron fields
- session title/preview/last-active/parseable ID
- recognized enabled-skill table fields
- configured messaging-platform names with a generic configured/connected state, and an integer active-session count when it is safely recognized

Log lines are the one intentional exception to "no raw output". They are returned after two redaction passes: Hermes's own secret redaction, then a second pass by the server (API keys, bearer tokens, `key=value` secrets, bot tokens). Home-directory paths are shortened to `~`, and the `hermes logs` header line (which contains a path) is dropped. Cron last-run error text is never returned, only ok/failed.

Otherwise, raw CLI output, process details, paths, configuration, credentials, authentication, API keys, environment files, provider details and session databases are never read or returned. A failed source is rendered as `Not Available`; an unknown individual field is rendered as `Unknown`.

`/api/tasks`, `/api/calendar`, `/api/activity` and `/api/knowledge` each return a source availability state and refresh time:
- Task Board is read-only and does not expose mutations.
- Calendar is cron-only, so it intentionally excludes general events.
- Activity is limited to session-list metadata and does not synthesize events.
- Knowledge is a curated catalog of enabled skills recognized from Hermes's Rich table.

Empty source results remain available and show truthful empty states; unparseable output and command failures are shown as `Not Available`. Hermes write actions are intentionally not implemented. The only things Ruang ever writes are its own optional access code, profile lock files (see *Access code* and *Profile lock*), and, in its own data directory, saved agent skins (see *Agent skins*) and the office scene file `scene.json` (see *Office scene*). Ruang never writes to Hermes profiles or folders.

## Office

`/api/office` is a read-only composition of the existing cached runtime, Kanban and activity reads. It has one station per agent (every Hermes profile, plus OpenCode when installed), in the order `hermes profile list` gives them. Desks are hot desks: there is one per agent and none carries a name. Character colours are derived from the agent name, so they are the same on every device. The 2D view lays out Workspace (desks and the meeting table) and Lounge for any number of agents with CSS only; no image or art assets are used.

Office state is one of `Idle`, `Working`, `Reviewing`, `Collaborating` or `Unknown` (`Offline` is reserved and not produced). The precedence is:
1. A fresh, unexpired internal explicit-state overlay can declare `Working`, `Reviewing` or `Collaborating`.
2. Live activity (below), labelled with the agent's running/review Kanban task when there is one.
3. A fresh Kanban task explicitly assigned to the agent maps `running` to `Working` and `review` to `Reviewing`.
4. A fresh actor-attributed active session maps to `Collaborating`.
5. Otherwise, the managed-idle policy applies.

A stopped gateway does not make an agent offline: it only means the agent is not listening on messaging platforms, and many agents are used from the CLI without one. It is shown on the Agents page and in the idle label (`On a break · gateway stopped`).

Managed Idle is a transparent server placement policy, not agent-reported presence. It resolves only when all of these hold:
- fresh runtime, Kanban and activity reads are available
- there is no fresh explicit overlay
- Kanban has no agent-attributed running/review task
- activity has no agent-attributed active session

It places the station in Lounge and labels it `Idle · managed placement`. Any unavailable or stale required input leaves the station `Unknown`. Gateway `Running`, generic sessions, unassigned Kanban tasks and OpenCode version availability cannot independently create an active state; OpenCode version availability is explicitly not a state signal.

Current task and recent activity require actor attribution. The Office only shows a Kanban task when its explicit assignee is the agent's profile name (or `opencode`). Hermes session-list metadata currently has no actor attribution, so the Activity panel labels it as unattributed session metadata and it is never assigned to a station. Failed task or activity sources keep the existing `Not Available` meaning: that is source availability, not an Office work state. Selecting a station opens an in-page, keyboard-accessible detail dialog with room, provenance and source freshness.

State placement is visualized without inventing work:
- `Working` and `Reviewing` are at a desk; `Collaborating` is at the meeting table (as many places as needed).
- `Idle` is in Lounge (in 3D, wandering the office).
- `Unknown` is shown at a desk with a labelled neutral presence.

The crew snapshot counts agents, active work (`Working`/`Reviewing`/`Collaborating`), managed idle and unknown separately. Gateway health (how many profiles report their gateway `Running`) is displayed as a separate metric. When a station has several Kanban tasks, the `running` one wins, then `review`, then the first open task.

`/api/channels` is a separate safe snapshot sourced only from the Messaging Platforms section and active-session count of `hermes status --all`; it never exposes unconfigured platforms or any other status content. The Office introduces no write endpoint, shell input or command beyond the fixed allowlist.

## Live activity in the Office

Every Hermes profile writes all of its work to its own `agent.log`: messaging replies (gateway), cron runs, tool calls and the agent loop. For every profile, the server reads the last 3 minutes of that log and the profile's most recent session (at most four profiles at a time, cached for 15 seconds):

- Gateway message lines together with agent-loop or tool lines, or a session active in the last 3 minutes, become `Collaborating` ("Replying to a chat", at the meeting table).
- `cron.*` becomes `Working` ("Running a scheduled job"); `tools.*` becomes `Working` ("Using tools"); `agent`/`run_agent` becomes `Working` ("Working on a request").
- OpenCode is `Working` when a recent agent log line shows it being driven.

Gateway polling noise and CLI housekeeping lines are ignored.

## Folders

Each agent resolves to its own folder:

| Agent | Folder |
|---|---|
| `default` | `<hermes root>/profiles/default`; only when that folder does not exist (stock Hermes layout), the Hermes root itself |
| every other Hermes profile | `<hermes root>/profiles/<name>` |
| OpenCode (listed only when its folder exists) | `~/.opencode`, then `~/.config/opencode` (`RUANG_OPENCODE_DIR` overrides) |

The Hermes root follows Hermes's own rules (`HERMES_HOME`, default `~/.hermes`); `RUANG_HERMES_ROOT` overrides it.
- A non-default agent that resolves to the Hermes root, or to a folder another agent already owns, is shown as unavailable with the reason instead of being opened.
- When one agent's folder contains another's (the stock root holds `profiles/`), that sub-folder is hidden and cannot be read through the outer agent.
- Cards and the breadcrumb show the real path.

`/api/folders` lists the agents; `/api/folders/<agent>/list?path=` and `/api/folders/<agent>/file?path=` browse one folder. The safety rules:
- Every path is resolved (including symlinks) and must stay inside that agent's folder.
- The `hermes-agent` install, `.git`, virtualenvs and caches are hidden.
- Credential-bearing and database files (`.env*`, `auth.json`, keys and certificates, names containing token/secret/password/credential, `*.db`/SQLite files) are listed but never read.
- Text previews are capped at 256 KB and pass through the same secret redaction as logs. Binary files are not previewed.

**Troubleshooting "This folder could not be read".** Ruang reads folders as the user that runs it. If a profile folder belongs to another user or has mode `700` (for example it was created by a gateway started with `sudo`/systemd as root), the card shows "No read permission for <user>" and opening it explains which user was refused. Check with `ls -ld ~/.hermes/profiles/<name>`. Fix it by giving the folder back to your user (`sudo chown -R $USER:$USER ~/.hermes/profiles/<name>`) or granting read access (`sudo setfacl -R -m u:$USER:rX ~/.hermes/profiles/<name>`).
