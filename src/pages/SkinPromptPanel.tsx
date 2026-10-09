import { useEffect, useRef, useState } from 'react'
import type { SkinEditorHandle } from './SkinEditor'
import {
  base64ToBytes,
  bytesToBase64,
  decodePngBytes,
} from './skin-editor-state'

export type SkinPart = 'all' | 'head' | 'body' | 'arms' | 'legs'

export interface SkinPromptPanelProps {
  editorRef: React.RefObject<SkinEditorHandle | null>
  agentId?: string
  initialPrompt?: string
  initialPart?: SkinPart
  onPromptChange?: (prompt: string) => void
  onPartChange?: (part: SkinPart) => void
  onGenerated?: (rgba: Uint8ClampedArray) => void
}

export function SkinPromptPanel({
  editorRef,
  agentId,
  initialPrompt = '',
  initialPart = 'all',
  onPromptChange,
  onPartChange,
  onGenerated,
}: SkinPromptPanelProps) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [part, setPart] = useState<SkinPart>(initialPart)
  const [isGenerating, setIsGenerating] = useState(false)
  const [stage, setStage] = useState<'preview' | 'convert' | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMountedRef = useRef(true)

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current)
      elapsedIntervalRef.current = null
    }
    if (isMountedRef.current) {
      setIsGenerating(false)
      setStage(null)
    }
  }

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
      if (elapsedIntervalRef.current) clearInterval(elapsedIntervalRef.current)
    }
  }, [])

  const handlePromptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setPrompt(val)
    onPromptChange?.(val)
  }

  const handlePartChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as SkinPart
    setPart(val)
    onPartChange?.(val)
  }

  const pollJob = async (jobId: string) => {
    try {
      const res = await fetch(`/api/skins/generate/${encodeURIComponent(jobId)}`)
      if (!isMountedRef.current) return

      if (res.status === 404) {
        stopPolling()
        setError('Generation expired')
        return
      }

      if (!res.ok) {
        stopPolling()
        setError('Generator returned unusable output, try again/rephrase')
        return
      }

      const data = await res.json()
      if (!isMountedRef.current) return

      if (data.status === 'queued' || data.status === 'running') {
        if (data.stage === 'preview' || data.stage === 'convert') {
          setStage(data.stage)
        }
        return
      }

      if (data.status === 'error') {
        stopPolling()
        if (data.error === 'timeout') {
          setError('Generator timed out')
        } else if (data.error === 'flow offline') {
          setError('Image generator offline')
        } else if (data.error === 'block offline') {
          setError('Skin converter offline (BLOCK service not running)')
        } else if (data.error === 'daily cap') {
          setError('Daily generation limit reached')
        } else {
          setError('Generator returned unusable output, try again/rephrase')
        }
        return
      }

      if (data.status === 'done') {
        stopPolling()
        if (data.png) {
          try {
            const pngBytes = base64ToBytes(data.png)
            const rgba = await decodePngBytes(pngBytes)
            editorRef.current?.loadPixels(rgba, { undoable: true })
            onGenerated?.(rgba)
          } catch {
            setError('Generator returned unusable output, try again/rephrase')
          }
        }
      }
    } catch {
      if (isMountedRef.current) {
        stopPolling()
        setError('Generator returned unusable output, try again/rephrase')
      }
    }
  }

  const handleGenerate = async () => {
    const trimmed = prompt.trim()
    if (!trimmed || trimmed.length > 300) {
      setError('Prompt must be 1 to 300 characters')
      return
    }

    setError(null)
    setIsGenerating(true)
    setStage(null)
    setElapsed(0)

    try {
      let baseBase64: string | undefined
      try {
        const currentPng = editorRef.current?.getPng()
        if (currentPng && currentPng.length > 0) {
          baseBase64 = bytesToBase64(currentPng)
        }
      } catch {
        // Safe fallback if editor PNG cannot be retrieved
      }

      const res = await fetch('/api/skins/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: trimmed,
          part,
          ...(agentId ? { agent: agentId } : {}),
          ...(baseBase64 ? { base: baseBase64 } : {}),
        }),
      })

      if (!isMountedRef.current) return

      if (res.status === 202) {
        const data = await res.json()
        const jobId = data.jobId

        elapsedIntervalRef.current = setInterval(() => {
          if (isMountedRef.current) {
            setElapsed((prev) => prev + 1)
          }
        }, 1000)

        pollIntervalRef.current = setInterval(() => {
          void pollJob(jobId)
        }, 2000)
        return
      }

      setIsGenerating(false)
      if (res.status === 423) {
        let msg = 'Profile is locked. Unlock it in Settings to modify skins.'
        try {
          const data = await res.json()
          if (data && data.error) msg = data.error
        } catch {
          /* ignore */
        }
        setError(msg)
      } else if (res.status === 400) {
        let msg = 'Prompt must be 1 to 300 characters'
        try {
          const data = await res.json()
          if (data.error) msg = data.error
        } catch {
          /* ignore */
        }
        setError(msg)
      } else if (res.status === 409) {
        setError('Another skin is generating, try again shortly')
      } else if (res.status === 429) {
        let isDailyCap = false
        try {
          const data = await res.json()
          if (data.error === 'daily cap') isDailyCap = true
        } catch {
          /* ignore */
        }
        setError(
          isDailyCap
            ? 'Daily generation limit reached'
            : 'Too many generate requests, wait a minute',
        )
      } else if (res.status === 502) {
        setError('Generator returned unusable output, try again/rephrase')
      } else if (res.status === 503) {
        let isBlockOffline = false
        try {
          const data = await res.json()
          if (data && data.error === 'block offline') {
            isBlockOffline = true
          }
        } catch {
          /* ignore */
        }
        setError(
          isBlockOffline
            ? 'Skin converter offline (BLOCK service not running)'
            : 'Image generator offline',
        )
      } else if (res.status === 504) {
        setError('Generator timed out')
      } else {
        setError('Generator returned unusable output, try again/rephrase')
      }
    } catch {
      if (isMountedRef.current) {
        setIsGenerating(false)
        setError('Image generator offline')
      }
    }
  }

  const handleCancel = () => {
    stopPolling()
  }

  return (
    <div className="skin-prompt-panel">
      <div className="skin-prompt-header">
        <span className="skin-prompt-title">PROMPT GENERATOR</span>
        <span className="skin-prompt-counter">{prompt.length}/300</span>
      </div>

      <textarea
        className="skin-prompt-textarea"
        value={prompt}
        maxLength={300}
        placeholder="Describe agent appearance, costume, or style (e.g. cyberpunk hacker with neon visor)..."
        onChange={handlePromptChange}
        disabled={isGenerating}
        rows={2}
      />

      <div className="skin-prompt-controls">
        <div className="skin-prompt-part-group">
          <label htmlFor="skin-part-select" className="skin-prompt-part-label">
            Part:
          </label>
          <select
            id="skin-part-select"
            className="skin-prompt-select"
            value={part}
            onChange={handlePartChange}
            disabled={isGenerating}
          >
            <option value="all">All</option>
            <option value="head">Head</option>
            <option value="body">Body</option>
            <option value="arms">Arms</option>
            <option value="legs">Legs</option>
          </select>
        </div>

        <div className="skin-prompt-actions">
          {isGenerating ? (
            <div className="skin-prompt-status" role="status" aria-live="polite">
              <span className="skin-prompt-spinner" aria-hidden="true">
                ⏳
              </span>
              <span>
                {stage === 'preview'
                  ? `${elapsed}s · Rendering preview…`
                  : stage === 'convert'
                    ? `${elapsed}s · Converting to skin…`
                    : `${elapsed}s · Generating via Google Flow (can take 1-3 min)`}
              </span>
              <button
                type="button"
                className="refresh-button"
                onClick={handleCancel}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="primary-button"
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
            >
              Generate
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="skin-generate-error" role="alert">
          <span>⚠ {error}</span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
