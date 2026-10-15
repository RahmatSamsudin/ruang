import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installScene, MAX_ADDED, MAX_OVERRIDES, MAX_SCENE_BYTES, SCENE_PROP_TYPES, SCENE_SURFACES, SceneStore, validatePatch } from './scene.js'

const sofa = { id: 'my-sofa', kind: 'prop', level: 0, type: 'Sofa', position: [1, 0, 2] }
const validModel = { id: 'model-1', kind: 'model', level: 0, modelId: 'm-0123456789ab', position: [1, 0, 2], rotation: 1.5, scale: 2 }
const good = { version: 2, overrides: { sofa: { position: [3, 0, 4], rotation: 1.5 }, 'wall-back': null }, added: [sofa] }
const goodV1 = { version: 1, overrides: { sofa: { position: [3, 0, 4], rotation: 1.5 }, 'wall-back': null }, added: [sofa] }

describe('scene patch validation', () => {
  it('accepts a normal patch and the empty patch', () => {
    expect(validatePatch(good)).toEqual(good)
    expect(validatePatch(goodV1)).toEqual(good)
    expect(validatePatch({ version: 1 })).toEqual({ version: 2, overrides: {}, added: [] })
    expect(validatePatch({ version: 2 })).toEqual({ version: 2, overrides: {}, added: [] })
  })

  const bad: [string, unknown][] = [
    ['not an object', []],
    ['wrong version', { version: 3 }],
    ['unknown top-level key', { version: 2, extra: true }],
    ['unknown kind', { version: 2, added: [{ ...sofa, kind: 'rocket' }] }],
    ['inherited kind name', { version: 2, added: [{ ...sofa, kind: 'constructor' }] }],
    ['unknown prop type', { version: 2, added: [{ ...sofa, type: 'Rocket' }] }],
    ['short position', { version: 2, added: [{ ...sofa, position: [1, 2] }] }],
    ['overflowing number', { version: 2, added: [{ ...sofa, position: [Number('1e999'), 0, 0] }] }],
    ['huge number', { version: 2, added: [{ ...sofa, position: [1e6, 0, 0] }] }],
    ['unknown field', { version: 2, added: [{ ...sofa, hacked: 1 }] }],
    ['missing required field', { version: 2, added: [{ id: 'x', kind: 'prop', level: 0, type: 'Sofa' }] }],
    ['bad id', { version: 2, added: [{ ...sofa, id: '../x' }] }],
    ['generated seat id', { version: 2, added: [{ ...sofa, id: 'desk-9' }] }],
    ['duplicate added ids', { version: 2, added: [sofa, sofa] }],
    ['override changing kind', { version: 2, overrides: { sofa: { kind: 'wall' } } }],
    ['override changing id', { version: 2, overrides: { sofa: { id: 'x' } } }],
    ['override changing modelId', { version: 2, overrides: { 'model-1': { modelId: 'm-111111111111' } } }],
    ['override with a bad value', { version: 2, overrides: { sofa: { position: 'here' } } }],
    ['override that is not an object', { version: 2, overrides: { sofa: 5 } }],
    ['prototype id in overrides', JSON.parse('{"version":2,"overrides":{"__proto__":null}}')],
    ['bad colour', { version: 2, added: [{ id: 'b', kind: 'box', level: 0, position: [0, 0, 0], size: [1, 1, 1], color: 'red' }] }],
    ['bad surface', { version: 2, added: [{ id: 'f', kind: 'floor', level: 0, y: 0, min: [0, 0], max: [1, 1], surface: { type: 'lava', repeat: [1, 1] } }] }],
    ['prop value over the cap', { version: 2, added: [{ ...sofa, type: 'Railing', props: { length: 101 } }] }],
    ['model missing modelId', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, position: [0, 0, 0] }] }],
    ['model bad modelId pattern short', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'm-1234', position: [0, 0, 0] }] }],
    ['model bad modelId uppercase', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'm-0123456789AB', position: [0, 0, 0] }] }],
    ['model bad modelId prefix', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'x-0123456789ab', position: [0, 0, 0] }] }],
    ['model missing position', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'm-0123456789ab' }] }],
    ['model scale zero', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'm-0123456789ab', position: [0, 0, 0], scale: 0 }] }],
    ['model scale negative', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'm-0123456789ab', position: [0, 0, 0], scale: -1 }] }],
    ['model scale over 100', { version: 2, added: [{ id: 'm1', kind: 'model', level: 0, modelId: 'm-0123456789ab', position: [0, 0, 0], scale: 101 }] }],
    ['too many overrides', { version: 2, overrides: Object.fromEntries(Array.from({ length: MAX_OVERRIDES + 1 }, (_, index) => [`o${index}`, null])) }],
    ['too many added items', { version: 2, added: Array.from({ length: 501 }, (_, index) => ({ ...sofa, id: `s${index}` })) }],
  ]
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => validatePatch(input)).toThrow()
    })
  }

  it('accepts prop values up to 100 and exactly MAX_OVERRIDES overrides', () => {
    expect(() => validatePatch({ version: 2, added: [{ ...sofa, type: 'Railing', props: { length: 100 } }] })).not.toThrow()
    expect(() => validatePatch({ version: 2, overrides: Object.fromEntries(Array.from({ length: MAX_OVERRIDES }, (_, index) => [`o${index}`, null])) })).not.toThrow()
  })

  it('accepts valid model items and model overrides', () => {
    expect(validatePatch({ version: 2, added: [validModel] })).toEqual({ version: 2, overrides: {}, added: [validModel] })
    expect(validatePatch({ version: 2, overrides: { [validModel.id]: { position: [5, 1, 5], rotation: 3.14, scale: 0.5 } } })).toEqual({
      version: 2,
      overrides: { [validModel.id]: { position: [5, 1, 5], rotation: 3.14, scale: 0.5 } },
      added: [],
    })
  })

  it('keeps its surface list in step with the UI', async () => {
    const source = await readFile(new URL('../src/scene3d/scene.ts', import.meta.url), 'utf8')
    const block = /SurfaceType = ([^\n]*)/.exec(source)
    expect(block).not.toBeNull()
    const ui = [...block![1].matchAll(/'(\w+)'/g)].map((match) => match[1])
    expect([...ui].sort()).toEqual([...SCENE_SURFACES].sort())
  })

  it('keeps its prop type list in step with the UI', async () => {
    const source = await readFile(new URL('../src/scene3d/scene.ts', import.meta.url), 'utf8')
    const block = /PROP_TYPES = \[([^\]]*)\]/s.exec(source)
    expect(block).not.toBeNull()
    const ui = [...block![1].matchAll(/'(\w+)'/g)].map((match) => match[1])
    expect([...ui].sort()).toEqual([...SCENE_PROP_TYPES].sort())
  })

  it('keeps its added-item limit in step with the UI', async () => {
    const source = await readFile(new URL('../src/scene3d/scene.ts', import.meta.url), 'utf8')
    const match = /export const MAX_ADDED = (\d+)/.exec(source)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBe(MAX_ADDED)
  })

  it('accepts added floors with all surface types', () => {
    for (const surfaceType of SCENE_SURFACES) {
      const floorPatch = {
        version: 2,
        overrides: {},
        added: [
          {
            id: `floor-${surfaceType}`,
            kind: 'floor',
            level: 0,
            y: 0,
            min: [-5, -5],
            max: [5, 5],
            surface: {
              type: surfaceType,
              repeat: [2, 2],
              ...(surfaceType === 'carpet' ? { color: '#3b82f6' } : {}),
            },
            roughness: 0.5,
            view: 'cutaway',
          },
        ],
      }
      expect(validatePatch(floorPatch)).toEqual(floorPatch)
    }
  })

  it('accepts added walls, glass dividers, and boxes with all optional properties', () => {
    const structurePatch = {
      version: 2,
      overrides: {},
      added: [
        {
          id: 'wall-1',
          kind: 'wall',
          level: 0,
          y: 0,
          from: [0, 0],
          to: [5, 0],
          height: 2.6,
          view: 'both',
        },
        {
          id: 'glass-1',
          kind: 'glass',
          level: 0,
          from: [0, 0],
          to: [0, 4],
          bottom: 0,
          top: 2.6,
          view: 'cutaway',
        },
        {
          id: 'box-1',
          kind: 'box',
          level: 0,
          position: [1, 0, 1],
          size: [2, 1, 0.5],
          color: '#3b82f6',
          radius: 0.05,
          roughness: 0.4,
          opacity: 0.9,
          shadow: true,
          view: 'shell',
        },
      ],
    }
    expect(validatePatch(structurePatch)).toEqual(structurePatch)
  })

  it('accepts overrides toggling view and changing level heights', () => {
    const overridePatch = {
      version: 2,
      overrides: {
        'wall-front': { view: 'shell' },
        'wall-back': { view: 'cutaway' },
        'wall-left': { view: 'both' },
        'floor-main': { level: 2.8, y: 2.8 },
        'desk-1': { level: 2.8, position: [2, 2.8, 3] },
      },
      added: [],
    }
    expect(validatePatch(overridePatch)).toEqual(overridePatch)
  })

  it('validates patches generated by addStorey', async () => {
    const editModule = await import(new URL('../src/scene3d/scene-edit.ts', import.meta.url).href) as {
      addStorey: (
        patch: unknown,
        items: readonly unknown[],
        bounds?: unknown,
        options?: unknown,
      ) => { patch: unknown; level: number; id: string | null }
    }
    const { addStorey } = editModule
    const groundItems = [
      { id: 'floor-0', kind: 'floor', level: 0, y: 0, min: [0, 0], max: [10, 10], surface: { type: 'wood', repeat: [1, 1] } },
      { id: 'wall-perimeter', kind: 'wall', level: 0, y: 0, from: [0, 0], to: [10, 0], height: 2.6, view: 'cutaway' },
    ]
    const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }

    const resContinuous = addStorey({ version: 2, overrides: {}, added: [] }, groundItems, bounds)
    expect(validatePatch(resContinuous.patch)).toEqual(resContinuous.patch)

    const resCutout = addStorey({ version: 2, overrides: {}, added: [] }, groundItems, bounds, { stairwellCutout: true })
    expect(validatePatch(resCutout.patch)).toEqual(resCutout.patch)
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
    // Like server/index.ts: any error that reaches the app handler is a 500.
    app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
      void _next
      response.status(500).json({ error: 'Internal error' })
    })
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
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 2, overrides: {}, added: [] })
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
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 2, overrides: {}, added: [] })
  })

  it('accepts v1 patches and saves them upgraded to v2', async () => {
    const saved = await put(goodV1)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(good)
    expect(await (await fetch(`${base}/api/scene`)).json()).toEqual(good)
  })

  it('refuses writes without a matching origin', async () => {
    expect((await put(good, { origin: 'http://evil.example' })).status).toBe(403)
    const noOrigin = await fetch(`${base}/api/scene`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) })
    expect(noOrigin.status).toBe(403)
    expect((await fetch(`${base}/api/scene`, { method: 'DELETE' })).status).toBe(403)
  })

  it('answers 415 for non-JSON, 413 for oversized and 400 for broken or invalid bodies, and writes nothing', async () => {
    expect((await put('hello', { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await put(JSON.stringify({ version: 2, pad: 'a'.repeat(MAX_SCENE_BYTES + 10) }))).status).toBe(413)
    expect((await put('{not json')).status).toBe(400)
    expect((await put({ version: 2, added: [{ ...sofa, type: 'Rocket' }] })).status).toBe(400)
    expect((await put('')).status).toBe(400)
    await expect(stat(file)).rejects.toThrow()
  })

  it('answers an unsupported charset with a 4xx, never a 500, and writes nothing', async () => {
    const response = await put(good, { 'content-type': 'application/json; charset=iso-8859-1' })
    expect(response.status).toBe(415)
    await expect(stat(file)).rejects.toThrow()
  })

  it('removes its temp file when a write fails and leaves the target alone', async () => {
    await mkdir(file, { recursive: true }) // scene.json is a directory, so the final rename fails
    await expect(new SceneStore(file).write(validatePatch(good))).rejects.toThrow()
    expect((await stat(file)).isDirectory()).toBe(true)
    expect((await readdir(join(tmp, 'data'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('reads a corrupt or invalid file as the empty patch instead of failing, and warns about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await put(good)
      await writeFile(file, '{corrupt')
      expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 2, overrides: {}, added: [] })
      expect(warn).toHaveBeenCalledTimes(1)
      await writeFile(file, JSON.stringify({ version: 2, added: [{ ...sofa, type: 'Rocket' }] }))
      expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 2, overrides: {}, added: [] })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn when the file is simply missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await new SceneStore(join(tmp, 'nope', 'scene.json')).read()).toEqual({ version: 2, overrides: {}, added: [] })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects PUT with 400 and missing ids when a model item references an absent modelId, and accepts when present', async () => {
    // 1. Model m-0123456789ab is not in ModelStore -> rejects with 400 and lists missing ids
    const patchWithMissing = { version: 2, overrides: {}, added: [validModel] }
    const rejected = await put(patchWithMissing)
    expect(rejected.status).toBe(400)
    const errorBody = (await rejected.json()) as { error: string; missing: string[]; missingModelIds?: unknown }
    expect(errorBody.error).toContain('m-0123456789ab')
    expect(errorBody.missing).toEqual(['m-0123456789ab'])
    expect(errorBody.missingModelIds).toBeUndefined()

    // 2. Add model to ModelStore index -> PUT succeeds with 200
    const modelsDir = join(tmp, 'data', 'models')
    await mkdir(modelsDir, { recursive: true })
    const modelRecord = {
      id: validModel.modelId,
      name: 'model1.glb',
      format: 'glb',
      size: 1024,
      createdAt: new Date().toISOString(),
    }
    await writeFile(join(modelsDir, 'index.json'), JSON.stringify([modelRecord]))

    const accepted = await put(patchWithMissing)
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual(patchWithMissing)
  })

  it('saves, reads back, and round-trips structure items and storey additions unchanged', async () => {
    const editModule = await import(new URL('../src/scene3d/scene-edit.ts', import.meta.url).href) as {
      addStorey: (
        patch: unknown,
        items: readonly unknown[],
        bounds?: unknown,
        options?: unknown,
      ) => { patch: unknown; level: number; id: string | null }
    }
    const { addStorey } = editModule
    const groundItems = [
      { id: 'floor-0', kind: 'floor', level: 0, y: 0, min: [0, 0], max: [10, 10], surface: { type: 'wood', repeat: [1, 1] } },
      { id: 'wall-perimeter', kind: 'wall', level: 0, y: 0, from: [0, 0], to: [10, 0], height: 2.6, view: 'cutaway' },
    ]
    const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 }
    const storeyResult = addStorey({ version: 2, overrides: {}, added: [] }, groundItems, bounds, { stairwellCutout: true })

    const structurePatch = {
      version: 2,
      overrides: {
        'wall-perimeter': { view: 'shell' },
      },
      added: [
        {
          id: 'custom-floor',
          kind: 'floor',
          level: 0,
          y: 0,
          min: [-2, -2],
          max: [2, 2],
          surface: { type: 'tile', repeat: [2, 2] },
          roughness: 0.3,
        },
        {
          id: 'custom-wall',
          kind: 'wall',
          level: 0,
          y: 0,
          from: [0, 0],
          to: [3, 0],
          height: 2.6,
          view: 'cutaway',
        },
        {
          id: 'custom-glass',
          kind: 'glass',
          level: 0,
          from: [3, 0],
          to: [3, 3],
          bottom: 0,
          top: 2.6,
        },
        {
          id: 'custom-box',
          kind: 'box',
          level: 0,
          position: [1, 0, 1],
          size: [1, 1, 1],
          color: '#10b981',
          radius: 0.1,
          roughness: 0.5,
          opacity: 0.8,
          shadow: true,
        },
        ...(storeyResult.patch as { added: Record<string, unknown>[] }).added,
      ],
    }

    const saved = await put(structurePatch)
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual(structurePatch)

    const reloaded = await (await fetch(`${base}/api/scene`)).json()
    expect(reloaded).toEqual(structurePatch)
  })
})
