import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EditorBar } from './EditorBar.tsx'

const noop = () => {}
const bar = (props: Partial<Parameters<typeof EditorBar>[0]> = {}) => renderToStaticMarkup(
  <EditorBar canUndo={false} canRedo={false} dirty={false} saving={false} error={null} onUndo={noop} onRedo={noop} onSave={noop} onReset={noop} onDone={noop} {...props}/>,
)

describe('EditorBar', () => {
  it('disables Undo, Redo and Save when there is nothing to do', () => {
    const markup = bar()
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^<]*Undo/)
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>[^<]*Redo/)
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Save/)
    expect(markup).toContain('saved')
    expect(markup).toContain("Walking routes don&#x27;t follow moved furniture yet")
  })

  it('enables them once there are changes, and shows the unsaved marker', () => {
    const markup = bar({ canUndo: true, canRedo: true, dirty: true })
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>[^<]*Undo/)
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Save/)
    expect(markup).toContain('unsaved')
  })

  it('shows Saving… and blocks Save, Reset and Done while saving, and shows an error as an alert', () => {
    const saving = bar({ dirty: true, saving: true })
    expect(saving).toContain('Saving…')
    expect(saving).toMatch(/<button[^>]*disabled[^>]*>Saving…/)
    expect(saving).toMatch(/<button[^>]*disabled[^>]*>Reset to default/)
    expect(saving).toMatch(/<button[^>]*disabled[^>]*>Done/)
    expect(bar({ error: 'Save failed: Forbidden.' })).toMatch(/role="alert"[^>]*>Save failed: Forbidden\./)
  })

  it('leaves Done enabled when not saving', () => {
    expect(bar()).not.toMatch(/<button[^>]*disabled[^>]*>Done/)
  })

  it('renders view mode button and add storey button when provided', () => {
    const markup = bar({ viewMode: 'cutaway', onViewModeChange: noop, onAddStorey: noop })
    expect(markup).toContain('Cutaway')
    expect(markup).toContain('+ Add Storey')

    const shellMarkup = bar({ viewMode: 'shell', onViewModeChange: noop })
    expect(shellMarkup).toContain('Shell')
  })

  it('renders model management and export/import actions when provided', () => {
    const markup = bar({
      onManageModels: noop,
      onExportGlb: noop,
      onExportBundle: noop,
      onImportBundle: noop,
    })
    expect(markup).toContain('📦 Models')
    expect(markup).toContain('⬇ Export GLB')
    expect(markup).toContain('⬇ Export Bundle')
    expect(markup).toContain('⬆ Import Bundle')
  })
})
