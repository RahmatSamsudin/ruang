import { usePolling } from '../polling.ts'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

/**
 * The saved scene edits and a way to reload them now. Pending or failed requests mean "no edits":
 * the stock office still renders.
 */
export function useScenePatch(): { patch: ScenePatch; refresh: () => void } {
  const request = usePolling<ScenePatch>('/api/scene', 30_000)
  return { patch: request.status === 'ready' ? request.data : EMPTY_PATCH, refresh: request.refresh }
}
