import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installScene, MAX_ADDED, MAX_OVERRIDES, MAX_SCENE_BYTES, SCENE_PROP_TYPES, SCENE_SURFACES, SceneStore, validatePatch } from './scene.js'

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
    ['overflowing number', { version: 1, added: [{ ...sofa, position: [Number('1e999'), 0, 0] }] }],
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
    ['prop value over the cap', { version: 1, added: [{ ...sofa, type: 'Railing', props: { length: 101 } }] }],
    ['too many overrides', { version: 1, overrides: Object.fromEntries(Array.from({ length: MAX_OVERRIDES + 1 }, (_, index) => [`o${index}`, null])) }],
    ['too many added items', { version: 1, added: Array.from({ length: 501 }, (_, index) => ({ ...sofa, id: `s${index}` })) }],
  ]
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => validatePatch(input)).toThrow()
    })
  }

  it('accepts prop values up to 100 and exactly MAX_OVERRIDES overrides', () => {
    expect(() => validatePatch({ version: 1, added: [{ ...sofa, type: 'Railing', props: { length: 100 } }] })).not.toThrow()
    expect(() => validatePatch({ version: 1, overrides: Object.fromEntries(Array.from({ length: MAX_OVERRIDES }, (_, index) => [`o${index}`, null])) })).not.toThrow()
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
      expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 1, overrides: {}, added: [] })
      expect(warn).toHaveBeenCalledTimes(1)
      await writeFile(file, JSON.stringify({ version: 1, added: [{ ...sofa, type: 'Rocket' }] }))
      expect(await (await fetch(`${base}/api/scene`)).json()).toEqual({ version: 1, overrides: {}, added: [] })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not warn when the file is simply missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await new SceneStore(join(tmp, 'nope', 'scene.json')).read()).toEqual({ version: 1, overrides: {}, added: [] })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
