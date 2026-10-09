import { useCallback, useEffect, useRef, useState } from 'react'
import { SkinEditor, type SkinEditorHandle } from './SkinEditor'
import { SkinPromptPanel, type SkinPart } from './SkinPromptPanel'
import { SkinLibrary } from './SkinLibrary'
import { skinTextureManager, triggerSkinsRefresh } from '../scene3d/skin'
import { skinDraftStore } from './skin-draft'
import { computeSkinSha1Prefix } from './skin-editor-state'

export interface SkinTabProps {
  agentId: string
}

export function SkinTab({ agentId }: SkinTabProps) {
  const [loading, setLoading] = useState(true)
  const [initialPng, setInitialPng] = useState<Uint8Array | null>(null)
  const [initialPixels, setInitialPixels] = useState<Uint8ClampedArray | null>(null)
  const [initialDirty, setInitialDirty] = useState(false)
  const [activeSkinId, setActiveSkinId] = useState<string | undefined>(undefined)
  const [libraryRefresh, setLibraryRefresh] = useState(0)

  const editorRef = useRef<SkinEditorHandle | null>(null)
  const promptRef = useRef<string>('')
  const partRef = useRef<SkinPart>('all')
  const isDirtyRef = useRef<boolean>(false)
  const latestPixelsRef = useRef<Uint8ClampedArray | null>(null)

  useEffect(() => {
    let cancelled = false
    const draft = skinDraftStore.get(agentId)

    if (draft) {
      setInitialPixels(draft.pixels)
      setInitialDirty(draft.isDirty)
      latestPixelsRef.current = new Uint8ClampedArray(draft.pixels)
      promptRef.current = draft.prompt ?? ''
      partRef.current = draft.part ?? 'all'
      isDirtyRef.current = draft.isDirty
      setLoading(false)
      return
    }

    const loadSaved = async () => {
      try {
        const res = await fetch(`/api/skins/${encodeURIComponent(agentId)}.png`)
        if (cancelled) return
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer())
          setInitialPng(buf)
          void computeSkinSha1Prefix(buf).then(setActiveSkinId)
        } else {
          setInitialPng(null)
          setActiveSkinId(undefined)
        }
      } catch {
        if (!cancelled) {
          setInitialPng(null)
          setActiveSkinId(undefined)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadSaved()

    return () => {
      cancelled = true
    }
  }, [agentId])

  // Save draft on unmount if dirty
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const editor = editorRef.current
      const pixels = editor ? editor.getPixels() : latestPixelsRef.current
      if (pixels && isDirtyRef.current) {
        skinDraftStore.set(agentId, {
          pixels: new Uint8ClampedArray(pixels),
          isDirty: true,
          prompt: promptRef.current,
          part: partRef.current,
        })
      }
    }
  }, [agentId])

  const handleDirtyChange = useCallback(
    (dirty: boolean) => {
      isDirtyRef.current = dirty
      if (!dirty) {
        skinDraftStore.delete(agentId)
      } else if (editorRef.current) {
        const pixels = editorRef.current.getPixels()
        latestPixelsRef.current = new Uint8ClampedArray(pixels)
        skinDraftStore.set(agentId, {
          pixels,
          isDirty: true,
          prompt: promptRef.current,
          part: partRef.current,
        })
      }
    },
    [agentId],
  )

  const handleSave = async (png: Uint8Array) => {
    const res = await fetch(`/api/skins/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
      },
      body: new Blob([png as unknown as BlobPart], { type: 'image/png' }),
    })

    if (!res.ok) {
      let errMsg = 'Failed to save skin'
      try {
        const data = await res.json()
        if (data.error) errMsg = data.error
      } catch {
        /* ignore */
      }
      throw new Error(errMsg)
    }

    isDirtyRef.current = false
    skinDraftStore.delete(agentId)
    skinTextureManager.disposeAgent(agentId)
    triggerSkinsRefresh()
    void computeSkinSha1Prefix(png).then(setActiveSkinId)
    setLibraryRefresh((v) => v + 1)
  }

  const handleReset = async () => {
    const res = await fetch(`/api/skins/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
    })

    if (!res.ok && res.status !== 404) {
      let errMsg = 'Failed to reset skin'
      try {
        const data = await res.json()
        if (data.error) errMsg = data.error
      } catch {
        /* ignore */
      }
      throw new Error(errMsg)
    }

    isDirtyRef.current = false
    skinDraftStore.delete(agentId)
    skinTextureManager.disposeAgent(agentId)
    triggerSkinsRefresh()
    setActiveSkinId(undefined)
    setLibraryRefresh((v) => v + 1)
  }

  if (loading) {
    return <div className="skin-tab-loading">Loading skin...</div>
  }

  return (
    <div className="skin-tab-content">
      <SkinEditor
        ref={editorRef}
        id={agentId}
        initialPng={initialPng}
        initialPixels={initialPixels}
        initialDirty={initialDirty}
        onSave={handleSave}
        onReset={handleReset}
        onDirtyChange={handleDirtyChange}
      >
        <SkinPromptPanel
          editorRef={editorRef}
          agentId={agentId}
          initialPrompt={promptRef.current}
          initialPart={partRef.current}
          onPromptChange={(p) => {
            promptRef.current = p
          }}
          onPartChange={(pt) => {
            partRef.current = pt
          }}
          onGenerated={() => {
            setLibraryRefresh((v) => v + 1)
          }}
        />
        <SkinLibrary
          editorRef={editorRef}
          activeSkinId={activeSkinId}
          refreshTrigger={libraryRefresh}
        />
      </SkinEditor>
    </div>
  )
}
