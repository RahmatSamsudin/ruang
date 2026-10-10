import { usePolling } from '../polling.ts'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

/**
 * The saved scene edits and a way to reload them now. Pending or failed requests mean "no edits":
 * the stock office still renders, and `ready` stays false so the editor is not entered on top of an unknown scene.
 */
export function useScenePatch(): { patch: ScenePatch; ready: boolean; refresh: () => void } {
  const request = usePolling<ScenePatch>('/api/scene', 30_000)
  return { patch: request.status === 'ready' ? request.data : EMPTY_PATCH, ready: request.status === 'ready', refresh: request.refresh }
}
