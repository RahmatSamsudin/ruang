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
