import { useCallback, useRef, useState } from 'react'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

// The editing session for the 3D office: a draft ScenePatch with undo/redo, a live drag position,
// and Save / Reset against /api/scene. Edits are pure patch to patch functions (scene-edit.ts).

const MAX_HISTORY = 100

interface State {
  editing: boolean
  draft: ScenePatch
  /** The patch as last saved (or loaded when editing began); `dirty` compares the draft with it. */
  baseline: ScenePatch
  past: ScenePatch[]
  future: ScenePatch[]
  selectedId: string | null
  drag: { id: string; x: number; z: number } | null
  saving: boolean
  error: string | null
}

const fresh = (patch: ScenePatch): State => ({ editing: false, draft: patch, baseline: patch, past: [], future: [], selectedId: null, drag: null, saving: false, error: null })
const same = (a: ScenePatch, b: ScenePatch): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

async function failure(response: Response, prefix: string): Promise<string> {
  const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  return typeof body?.error === 'string' ? `${prefix}: ${body.error}` : `${prefix} (HTTP ${response.status})`
}

export interface SceneEditor {
  editing: boolean
  draft: ScenePatch
  selectedId: string | null
  drag: { id: string; x: number; z: number } | null
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
  saving: boolean
  error: string | null
  enter: () => void
  exit: () => void
  select: (id: string | null) => void
  apply: (change: (patch: ScenePatch) => ScenePatch) => void
  undo: () => void
  redo: () => void
  previewDrag: (id: string, x: number, z: number) => void
  endDrag: () => void
  save: () => Promise<void>
  reset: () => Promise<void>
}

export function useSceneEditor(saved: ScenePatch, refresh: () => void, request?: typeof fetch): SceneEditor {
  const [state, setState] = useState<State>(() => fresh(saved))
  // Callbacks read the latest values through refs so they stay stable between renders.
  const latest = useRef(state)
  latest.current = state
  const savedRef = useRef(saved)
  savedRef.current = saved
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const requestRef = useRef(request)
  requestRef.current = request

  const enter = useCallback(() => setState({ ...fresh(savedRef.current), editing: true }), [])
  const exit = useCallback(() => setState((s) => fresh(s.baseline)), [])
  const select = useCallback((id: string | null) => setState((s) => ({ ...s, selectedId: id })), [])

  const apply = useCallback((change: (patch: ScenePatch) => ScenePatch) => setState((s) => {
    const next = change(s.draft)
    if (next === s.draft) return s
    return { ...s, draft: next, past: [...s.past, s.draft].slice(-MAX_HISTORY), future: [], error: null }
  }), [])
  const undo = useCallback(() => setState((s) => (s.past.length === 0 ? s : { ...s, draft: s.past[s.past.length - 1], past: s.past.slice(0, -1), future: [...s.future, s.draft] })), [])
  const redo = useCallback(() => setState((s) => (s.future.length === 0 ? s : { ...s, draft: s.future[s.future.length - 1], future: s.future.slice(0, -1), past: [...s.past, s.draft] })), [])

  const previewDrag = useCallback((id: string, x: number, z: number) => setState((s) => ({ ...s, drag: { id, x, z } })), [])
  const endDrag = useCallback(() => setState((s) => (s.drag ? { ...s, drag: null } : s)), [])

  const send = useCallback((init: RequestInit) => (requestRef.current ?? fetch)('/api/scene', init), [])

  const save = useCallback(async () => {
    const { draft, saving } = latest.current
    if (saving) return
    setState((s) => ({ ...s, saving: true, error: null }))
    try {
      const response = await send({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
      if (!response.ok) throw new Error(await failure(response, 'Save failed'))
      setState((s) => ({ ...s, baseline: draft, saving: false }))
      refreshRef.current()
    } catch (error) {
      setState((s) => ({ ...s, saving: false, error: error instanceof Error ? error.message : 'Save failed' }))
    }
  }, [send])

  const reset = useCallback(async () => {
    if (latest.current.saving) return
    setState((s) => ({ ...s, saving: true, error: null }))
    try {
      const response = await send({ method: 'DELETE' })
      if (!response.ok) throw new Error(await failure(response, 'Reset failed'))
      setState({ ...fresh(EMPTY_PATCH), editing: true })
      refreshRef.current()
    } catch (error) {
      setState((s) => ({ ...s, saving: false, error: error instanceof Error ? error.message : 'Reset failed' }))
    }
  }, [send])

  return {
    editing: state.editing, draft: state.draft, selectedId: state.selectedId, drag: state.drag,
    canUndo: state.past.length > 0, canRedo: state.future.length > 0,
    dirty: !same(state.draft, state.baseline), saving: state.saving, error: state.error,
    enter, exit, select, apply, undo, redo, previewDrag, endDrag, save, reset,
  }
}
