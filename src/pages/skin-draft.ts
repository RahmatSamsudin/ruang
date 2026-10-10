import type { SkinPart } from './SkinPromptPanel'

export interface SkinDraft {
  pixels: Uint8ClampedArray
  isDirty: boolean
  prompt?: string
  part?: SkinPart
}

export const skinDraftStore = new Map<string, SkinDraft>()

/** Running generate jobs by agent, so leaving the tab resumes instead of restarting. */
export const skinJobStore = new Map<string, { jobId: string; startedAt: number }>()
