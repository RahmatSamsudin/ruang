import { usePolling } from '../polling.ts'
import { EMPTY_PATCH, type ScenePatch } from './scene.ts'

/** The saved scene edits. Pending or failed requests mean "no edits": the stock office still renders. */
export function useScenePatch(): ScenePatch {
  const request = usePolling<ScenePatch>('/api/scene', 30_000)
  return request.status === 'ready' ? request.data : EMPTY_PATCH
}
