import { useMemo, useState } from 'react'
import { GROUPS, PROP_CATALOG } from '../scene3d/prop-catalog.ts'
import { MAX_ADDED, PROP_TYPES, type PropType } from '../scene3d/scene.ts'

export interface PropPaletteProps {
  placing: PropType | null
  limitReached: boolean
  /** A type to start (or switch) placing it; null when the active entry is clicked again. */
  onPick: (type: PropType | null) => void
}

/** The list of objects that can be placed, grouped, searchable and collapsible. Starts collapsed on narrow-ish screens so it does not crowd the view. */
export function PropPalette({ placing, limitReached, onPick }: PropPaletteProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1000)
  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (type: PropType) => needle === '' || PROP_CATALOG[type].label.toLowerCase().includes(needle) || type.toLowerCase().includes(needle)
    return GROUPS.map((group) => ({
      group,
      types: PROP_TYPES.filter((type) => PROP_CATALOG[type].group === group && matches(type)).sort((a, b) => PROP_CATALOG[a].label.localeCompare(PROP_CATALOG[b].label)),
    })).filter((section) => section.types.length > 0)
  }, [query])
  return <aside
    className="office-3d-palette"
    aria-label="Object palette"
    ref={(el) => {
      if (!el) return
      el.onwheel = (event) => event.stopPropagation()
    }}
    onWheel={(event) => event.stopPropagation()}
  >
    <button type="button" className="office-3d-palette-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? '▾' : '▸'} Objects</button>
    {open && <>
      <input type="search" placeholder="Search objects" aria-label="Search objects" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // The page's Esc handling ignores inputs: the first Esc clears the search, the next one stops placing.
        if (query) setQuery('')
        else { onPick(null); event.currentTarget.blur() }
      }}/>
      <p role="status" className="office-3d-palette-note">{limitReached ? `Limit reached (${MAX_ADDED} added objects)` : 'Click the floor to place, Esc to stop.'}</p>
      <div className="office-3d-palette-list">
        {sections.map(({ group, types }) => <section key={group}>
          <h4>{group}</h4>
          {types.map((type) => <button type="button" key={type} aria-pressed={placing === type} disabled={limitReached && placing !== type} title={PROP_CATALOG[type].note ?? ''} onClick={() => onPick(placing === type ? null : type)}>{PROP_CATALOG[type].label}</button>)}
        </section>)}
      </div>
    </>}
  </aside>
}
