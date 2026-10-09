import type { SkinPart } from './SkinPromptPanel'

export interface SkinDraft {
  pixels: Uint8ClampedArray
  isDirty: boolean
  prompt?: string
  part?: SkinPart
}

export const skinDraftStore = new Map<string, SkinDraft>()
