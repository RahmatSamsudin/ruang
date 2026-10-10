export interface EditorBarProps {
  canUndo: boolean
  canRedo: boolean
  dirty: boolean
  saving: boolean
  error: string | null
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onReset: () => void
  onDone: () => void
}

/** The bar shown while editing the office: undo/redo, save state, save, reset and done. */
export function EditorBar({ canUndo, canRedo, dirty, saving, error, onUndo, onRedo, onSave, onReset, onDone }: EditorBarProps) {
  return <div className="office-3d-editbar" role="toolbar" aria-label="Office editor">
    <div className="office-3d-editbar-row">
      <button type="button" disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl/Cmd+Z)">↶ Undo</button>
      <button type="button" disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl/Cmd+Shift+Z)">↷ Redo</button>
      <span className={`office-3d-editstate${dirty ? ' unsaved' : ''}`}>{dirty ? '● unsaved' : 'saved'}</span>
      <button type="button" disabled={!dirty || saving} onClick={onSave}>{saving ? 'Saving…' : 'Save'}</button>
      <button type="button" disabled={saving} onClick={onReset} title="Remove every saved edit and go back to the stock office">Reset to default</button>
      <button type="button" disabled={saving} onClick={onDone}>Done</button>
    </div>
    <small>Walking routes don't follow moved furniture yet (desks and beds do).</small>
    {error && <small className="office-3d-editerror" role="alert">{error}</small>}
  </div>
}
