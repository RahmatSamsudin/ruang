import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { agentLook } from '../agents.ts'
import { officeStateBadge } from '../office-state.ts'
import { usePolling } from '../polling.ts'
import { formatCompact, formatDateTime, formatNumber } from '../format.ts'
import type { Page } from '../routes.ts'
import type { ActivitySnapshot, ChannelSnapshot, DashboardSnapshot, OfficeRoom, OfficeSnapshot, OfficeStation, UsageSnapshot } from '../types.ts'
import { LoadingState, SourceStatus } from '../ui.tsx'
import { CalendarOverlayView } from './Calendar.tsx'
import { AgentFolder } from './Folders.tsx'
import { AgentMemoryView } from './Memory.tsx'
import { Stats } from './Stats.tsx'
import { TaskBoard } from './TaskBoard.tsx'
import { formatCost } from '../usage.ts'
import { RelockBar } from '../ProfileLock.tsx'
import { TokenUsage } from './TokenUsage.tsx'
import { SkinTab } from './SkinTab.tsx'
import type { PovMode } from '../scene3d/agent-camera.ts'

// The 3D view (three.js) is only downloaded when someone switches to it.
const Office3D = lazy(() => import('./Office3D.tsx'))
type OfficeView = '2d' | '3d'

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

/** 3D unless the viewer chose 2D before (or the browser has no WebGL, handled by the caller). */
function storedView(): OfficeView {
  try { return window.localStorage.getItem('mc.officeView') === '2d' ? '2d' : '3d' } catch { return '3d' }
}

type PanelTab = 'Crew' | 'Stats' | 'Activity'
const PANEL_TABS: PanelTab[] = ['Crew', 'Stats', 'Activity']

function storedPanel(): PanelTab | undefined {
  try {
    const value = window.localStorage.getItem('mc.officePanel')
    return PANEL_TABS.find((tab) => tab === value)
  } catch { return undefined }
}

class SceneBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

const ROOMS: OfficeRoom[] = ['Workspace', 'Lounge']

/** A pixel character dressed in the colours derived from the agent id. */
export function PixelCharacter({ agent }: { agent: string }) {
  const look = agentLook(agent)
  const style = { '--hair': look.hair, '--skin': look.skin, '--shirt': look.shirt, '--pants': look.pants } as CSSProperties
  return <span className="pixel-character" style={style} aria-hidden="true"><span className="character-hair"/><span className="character-head"><i/><b/></span><span className="character-torso"/><span className="character-arm left"/><span className="character-arm right"/><span className="character-leg left"/><span className="character-leg right"/></span>
}

function officeStateLabel(station: OfficeStation): string {
  return station.state === 'Idle' ? 'Idle · managed placement' : station.state
}

/** This agent's tokens over the last 7 days and its rank in the crew (Hermes profiles only). */
function AgentTokens({ agent }: { agent: string }) {
  const usage = usePolling<UsageSnapshot>('/api/usage?days=7', 0)
  if (usage.status !== 'ready' || !Array.isArray(usage.data.agents)) return <div><dt>Tokens (7 days)</dt><dd>{usage.status === 'pending' ? 'Loading…' : 'Not Available'}</dd></div>
  const ranked = usage.data.agents.filter((item) => item.usage)
  const index = ranked.findIndex((item) => item.agent === agent)
  const mine = ranked[index]?.usage
  return <div><dt>Tokens (7 days)</dt><dd>{mine ? `${formatNumber(mine.totalTokens)} · #${index + 1} of ${ranked.length}${mine.costUsd !== undefined ? ` · est. ${formatCost(mine.costUsd)}` : ''}${mine.topSession ? ` · biggest session ${formatCompact(mine.topSession.tokens)}` : ''}` : 'Not Available'}</dd></div>
}

type DetailTab = 'Overview' | 'Folder' | 'Memory' | 'Skin'
const DETAIL_TABS: DetailTab[] = ['Overview', 'Folder', 'Memory', 'Skin']

export interface OfficeDetailProps {
  station: OfficeStation
  onClose: () => void
  onPov?: (mode: PovMode) => void
}

export function OfficeDetail({ station, onClose, onPov }: OfficeDetailProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const [tab, setTab] = useState<DetailTab>('Overview')
  useEffect(() => { closeRef.current?.focus() }, [])
  const badge = officeStateBadge(station.state)
  const profile = station.id
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
    if (event.key !== 'Tab') return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
    if (!focusable?.length) { event.preventDefault(); return }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault()
      const target = event.shiftKey ? last : first
      target.focus()
    }
  }
  return <div className="office-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`office-detail${tab === 'Overview' ? '' : ' wide'}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="office-detail-title" onKeyDown={onKeyDown}>
      <button className="office-close" ref={closeRef} onClick={onClose} aria-label={`Close ${station.name} details`}>Close</button>
      <div className="detail-head">
        <div className="detail-avatar"><PixelCharacter agent={station.id}/></div>
        <div>
          <p className="eyebrow">STATION DETAIL</p>
          <h2 id="office-detail-title">{station.name}</h2>
          <span className={`badge ${badge.tone}`}>{officeStateLabel(station)}</span>
          {station.privacy === 'locked' && <span className="badge muted">🔒 Locked</span>}
          {onPov && (
            <div className="detail-pov-actions">
              <button
                type="button"
                className="detail-pov-btn"
                onClick={() => onPov('first')}
                aria-label={`View as ${station.name} in first person`}
              >
                👁 1st Person
              </button>
              <button
                type="button"
                className="detail-pov-btn"
                onClick={() => onPov('third')}
                aria-label={`View as ${station.name} in third person`}
              >
                🎥 3rd Person
              </button>
            </div>
          )}
        </div>
      </div>
      {profile && <div className="detail-tabs" role="tablist" aria-label={`${station.name} details`}>{DETAIL_TABS.map((item) => <button type="button" role="tab" key={item} aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>}
      <div role="tabpanel" aria-label={tab} className="detail-body">
        {tab === 'Overview' && <>{station.privacy === 'locked' && <p className="file-notice">🔒 {station.name} is locked: its task, activity, memory and files are private. Open the Folder or Memory tab to enter the PIN.</p>}
          {station.privacy === 'unlocked' && <RelockBar agent={station.id} minutes={15}/>}
          {station.activity && <p className="detail-activity">{station.activity}</p>}
          <dl className="office-detail-grid"><div><dt>Agent type</dt><dd>{station.role}</dd></div>{station.role !== 'OpenCode' && <AgentTokens agent={station.id}/>}<div><dt>Current room</dt><dd>{station.room} / {station.roomPosition}</dd></div><div><dt>Current task</dt><dd>{station.currentTask}</dd></div><div><dt>Recent activity</dt><dd>{station.recentActivity}</dd></div><div><dt>Source / provenance</dt><dd>{station.provenance}</dd></div><div><dt>Freshness</dt><dd>{station.freshness}</dd></div></dl></>}
        {tab === 'Folder' && profile && <AgentFolder profile={profile}/>}
        {tab === 'Memory' && profile && <AgentMemoryView profile={profile}/>}
        {tab === 'Skin' && <SkinTab agentId={station.id}/>}
      </div>
    </section>
  </div>
}

type OverlayKind = 'tasks' | 'calendar' | 'usage'
const OVERLAYS: Record<OverlayKind, { title: string; page: Page }> = { tasks: { title: 'Task Board', page: 'Task Board' }, calendar: { title: 'Calendar', page: 'Calendar' }, usage: { title: 'Token usage', page: 'Usage' } }

/** Task Board, the cron calendar or token usage shown over the office, without leaving it. */
function OfficeOverlay({ kind, onClose, onNavigate }: { kind: OverlayKind; onClose: () => void; onNavigate?: (page: Page) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeRef.current?.focus() }, [kind])
  const { title, page } = OVERLAYS[kind]
  return <section className={`office-overlay overlay-${kind}`} role="dialog" aria-modal="false" aria-labelledby="office-overlay-title" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header className="office-overlay-head">
      <h2 id="office-overlay-title">{title}</h2>
      {onNavigate && <button type="button" className="refresh-button" onClick={() => onNavigate(page)}>Open full page ↗</button>}
      <button type="button" ref={closeRef} className="icon-button" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
    </header>
    <div className="office-overlay-body">{kind === 'tasks' ? <TaskBoard/> : kind === 'calendar' ? <CalendarOverlayView/> : <TokenUsage/>}</div>
  </section>
}

interface HudItem { label: string; value: string; tone?: 'warn' | 'bad'; page?: Page; title?: string }

/** The few numbers worth seeing at a glance, over the office like a game HUD. */
function hudItems(office: OfficeSnapshot | undefined, dashboard: DashboardSnapshot | null | undefined): HudItem[] {
  const summary = office?.summary ?? dashboard?.office
  const items: HudItem[] = []
  if (summary) {
    items.push({ label: 'Crew active', value: `${summary.active}/${summary.declared}`, title: `${summary.idle} idle · ${summary.offline} offline · ${summary.unknown} unknown` })
    items.push({ label: 'Gateways', value: `${summary.gatewaysReachable}/${summary.gatewaysDeclared}`, title: 'Profiles whose Hermes gateway is running (CLI-only agents need none)', page: 'Agents' })
  }
  if (!dashboard) return items
  const { tasks, calendar, commands } = dashboard
  if (tasks.availability === 'available') {
    const open = Object.entries(tasks.byStatus).filter(([status]) => !['done', 'archived'].includes(status)).reduce((sum, [, count]) => sum + count, 0)
    items.push({ label: 'Tasks', value: `${tasks.byStatus.running ?? 0} running · ${open} open`, page: 'Task Board' })
  } else items.push({ label: 'Tasks', value: 'Not Available', tone: 'warn', page: 'Task Board' })
  if (calendar.availability === 'available') items.push({ label: 'Next cron', value: calendar.nextRun ? formatDateTime(calendar.nextRun) : '—', page: 'Calendar' })
  if (commands.failed > 0) items.push({ label: 'CLI errors', value: String(commands.failed), tone: 'bad', page: 'Logs' })
  return items
}

export function Office({ dashboard, dashboardPending = false, onNavigate }: { dashboard?: DashboardSnapshot | null; dashboardPending?: boolean; onNavigate?: (page: Page) => void } = {}) {
  const snapshot = usePolling<OfficeSnapshot>('/api/office', 10_000)
  const activitySnapshot = usePolling<ActivitySnapshot>('/api/activity', 15_000)
  const channelsSnapshot = usePolling<ChannelSnapshot>('/api/channels', 30_000)
  const office = snapshot.status === 'ready' ? snapshot.data : undefined
  const activity = activitySnapshot.status === 'ready' ? activitySnapshot.data : undefined
  const channels = channelsSnapshot.status === 'ready' ? channelsSnapshot.data : undefined
  const [selectedName, setSelectedName] = useState<OfficeStation['name'] | undefined>()
  const selectedTrigger = useRef<HTMLElement | null>(null)
  const [chosenRoom, setChosenRoom] = useState<OfficeRoom | undefined>()
  const [view, setView] = useState<OfficeView>(() => typeof window === 'undefined' ? '2d' : storedView())
  const [webgl] = useState(() => typeof document === 'undefined' || webglAvailable())
  const [pov, setPov] = useState<{ name: string; mode: PovMode } | null>(null)
  const [panel, setPanel] = useState<PanelTab | undefined>(() => typeof window === 'undefined' ? undefined : storedPanel())
  const [overlay, setOverlay] = useState<OverlayKind | undefined>()
  const choosePanel = (next: PanelTab | undefined) => {
    setPanel(next)
    try { window.localStorage.setItem('mc.officePanel', next ?? 'closed') } catch { /* storage may be blocked */ }
  }
  const editDirty = useRef(false)
  const chooseView = (next: OfficeView) => {
    if (next !== view && editDirty.current && !window.confirm('Discard unsaved changes?')) return
    if (next !== '3d') {
      setPov(null)
    }
    setView(next)
    try { window.localStorage.setItem('mc.officeView', next) } catch { /* storage may be blocked */ }
  }
  const setEditDirty = useCallback((dirty: boolean) => { editDirty.current = dirty }, [])
  const show3d = view === '3d' && webgl
  const select3d = (station: OfficeStation, trigger: HTMLElement | null) => { selectedTrigger.current = trigger; setSelectedName(station.name) }
  const counts = Object.fromEntries(ROOMS.map((item) => [item, office?.stations.filter((station) => station.room === item).length ?? 0])) as Record<OfficeRoom, number>
  // Until the viewer picks a room, open wherever the crew currently is.
  const room: OfficeRoom = chosenRoom ?? (counts.Workspace === 0 && counts.Lounge > 0 ? 'Lounge' : 'Workspace')
  const stations = office?.stations.filter((station) => station.room === room) ?? []
  const selected = office?.stations.find((station) => station.name === selectedName)
  const sessions = activity?.sessions
  const channelSource = channels?.channels
  const closeDetail = () => {
    setSelectedName(undefined)
    selectedTrigger.current?.focus()
  }

  const handleStartPov = (mode: PovMode) => {
    if (!selected) return
    if (view !== '3d') {
      chooseView('3d')
    }
    setPov({ name: selected.name, mode })
    closeDetail()
  }

  useEffect(() => {
    if (pov && office && !office.stations.some((s) => s.name === pov.name)) {
      setPov(null)
    }
  }, [pov, office])

  useEffect(() => {
    if (!pov) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (selectedName || document.querySelector('.office-backdrop, .office-detail, [role="dialog"]')) return
      setPov(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pov, selectedName])
  if (snapshot.status === 'pending') return <LoadingState message="Reading office state..."/>
  const hud = hudItems(office, dashboard)
  // Hot desking: one unlabeled desk per agent.
  const deskCount = office?.stations.length ?? 0
  const stationButton2d = (station: OfficeStation) => { const badge = officeStateBadge(station.state); const busy = ['Working', 'Reviewing', 'Collaborating'].includes(station.state); return <button className={`pixel-station ${station.roomPosition} state-${station.state.toLowerCase()}`} key={station.id} onClick={(event) => { selectedTrigger.current = event.currentTarget; setSelectedName(station.name) }} aria-label={`${station.name}. ${officeStateLabel(station)}${station.activity ? `: ${station.activity}` : ''}. Open station details.`} title={station.activity || officeStateLabel(station)}>{busy && station.activity && <span className="speech" aria-hidden="true">{station.activity}</span>}<span className="pixel-station-name">{station.privacy === 'locked' ? '🔒 ' : ''}{station.name}</span><span className={`badge ${badge.tone}`}>{officeStateLabel(station)}</span>{station.state === 'Unknown' && <span className="neutral-label">NEUTRAL PRESENCE</span>}<PixelCharacter agent={station.id}/></button> }
  const stationButton = (station: OfficeStation) => { const badge = officeStateBadge(station.state); return <button type="button" className="crew-row" key={station.name} onClick={(event) => { selectedTrigger.current = event.currentTarget; setSelectedName(station.name) }} aria-label={`Details for ${station.name}: ${officeStateLabel(station)}`}><PixelCharacter agent={station.id}/><span><strong>{station.name}</strong><small>{station.activity || station.role}</small></span><span className={`badge ${badge.tone}`}>{station.state}</span></button> }
  return <section className={`office-stage view-${show3d ? '3d' : '2d'}`} aria-label="Visual Office">
    <div className="office-hud" role="list" aria-label="Key statistics">{hud.map((item) => { const body = <><span>{item.label}</span><b>{item.value}</b></>; return <div role="listitem" key={item.label}>{item.page && onNavigate ? <button type="button" className={`hud-chip${item.tone ? ` ${item.tone}` : ''}`} title={item.title ?? `Open ${item.page}`} onClick={() => onNavigate(item.page!)}>{body}</button> : <span className={`hud-chip${item.tone ? ` ${item.tone}` : ''}`} title={item.title}>{body}</span>}</div> })}</div>
    <div className="office-stage-tools">
      <div className="view-toggle" role="group" aria-label="Office view">{(['2d', '3d'] as const).map((item) => <button type="button" key={item} className={view === item ? 'active' : ''} aria-pressed={view === item} onClick={() => chooseView(item)} disabled={item === '3d' && !webgl} title={item === '3d' && !webgl ? 'WebGL is not available in this browser' : undefined}>{item.toUpperCase()}</button>)}</div>
      {(['tasks', 'calendar', 'usage'] as const).map((item) => <button type="button" key={item} className={`panel-toggle${overlay === item ? ' active' : ''}`} aria-pressed={overlay === item} onClick={() => setOverlay(overlay === item ? undefined : item)}>{item === 'tasks' ? '▦ Tasks' : item === 'calendar' ? '◷ Calendar' : '◔ Tokens'}</button>)}
      <button type="button" className={`panel-toggle${panel ? ' active' : ''}`} aria-expanded={Boolean(panel)} aria-controls="office-panel" onClick={() => choosePanel(panel ? undefined : 'Crew')}>◧ Panel</button>
    </div>
    <div className="office-canvas">
      {show3d ? <SceneBoundary fallback={<section className="empty-state"><h2>3D view unavailable</h2><p>The 3D office could not start on this device. Switch back to 2D.</p></section>}><Suspense fallback={<LoadingState message="Loading the 3D office..."/>}><Office3D stations={office?.stations ?? []} onSelect={select3d} onDirtyChange={setEditDirty} pov={pov} onPovChange={setPov} onOpenDetail={setSelectedName}/></Suspense></SceneBoundary> : <>{view === '3d' && !webgl && <p className="muted office-note">3D needs WebGL, which this browser does not provide. Showing 2D.</p>}<div className="room-tabs" role="tablist" aria-label="Office rooms">{ROOMS.map((item) => <button role="tab" aria-selected={room === item} className={room === item ? 'active' : ''} onClick={() => setChosenRoom(item)} key={item}>{item} <span className="room-count">{counts[item]}</span></button>)}</div>
        <div className="room-scroll"><section className={`pixel-room flow ${room.toLowerCase()}`} aria-label={`${room} room`}><div className="room-label"><span>{room}</span><small>{room === 'Workspace' ? `${deskCount} HOT DESK${deskCount === 1 ? '' : 'S'} + MEETING ROOM` : 'QUIET BREAK AREA'}</small></div>
          {room === 'Workspace' ? <>
            <div className="flow-desks">{Array.from({ length: deskCount }, (_, index) => {
              const atDesk = stations.find((station) => station.seat === index + 1 && station.roomPosition !== 'meeting-area')
              return <div className="flow-desk-cell" key={index}>{atDesk && stationButton2d(atDesk)}<div className={`ws-desk${atDesk && atDesk.state !== 'Offline' ? ' occupied' : ''}`} aria-hidden="true"><i/></div></div>
            })}</div>
            <div className="flow-meeting"><div className="meeting-table" aria-hidden="true"><span>MEETING</span></div><div className="flow-crew">{stations.filter((station) => station.roomPosition === 'meeting-area').map(stationButton2d)}</div></div>
          </> : <>
            <div className="flow-lounge-props" aria-hidden="true"><div className="pixel-tv"/><div className="lounge-chair"/><div className="lounge-sofa"/><div className="coffee-table"/><div className="lounge-chair"/><div className="pixel-plant"/></div>
            <div className="flow-crew">{stations.map(stationButton2d)}</div>
          </>}
          {room === 'Lounge' && stations.length === 0 && <p className="room-empty">No declared idle presence</p>}
          {room === 'Workspace' && stations.length === 0 && office && <p className="room-empty">Desks are empty · crew is in the Lounge</p>}
        </section></div></>}
      {snapshot.status === 'failed' && <section className="empty-state office-failed"><h2>Not Available</h2><p>The office source could not be reached.</p></section>}
    </div>
    {show3d && <small className="office-3d-hint">Drag to rotate · right-drag, two fingers or Geser to pan · scroll to zoom · click an agent for details</small>}
    {panel && <aside id="office-panel" className="office-panel" aria-label="Office panel" onKeyDown={(event) => { if (event.key === 'Escape' && !selected) { event.stopPropagation(); choosePanel(undefined) } }}>
      <div className="office-panel-head"><div className="panel-tabs" role="tablist" aria-label="Panel">{PANEL_TABS.map((tab) => <button type="button" role="tab" key={tab} aria-selected={panel === tab} className={panel === tab ? 'active' : ''} onClick={() => choosePanel(tab)}>{tab}</button>)}</div><button type="button" className="icon-button" onClick={() => choosePanel(undefined)} aria-label="Close panel">✕</button></div>
      <div className="office-panel-body" role="tabpanel" aria-label={panel}>
        {panel === 'Crew' && <>
          <SourceStatus source={office ? { availability: 'available', data: null } : undefined} fetchedAt={office?.fetchedAt} request={snapshot}/>
          <section className="office-summary"><p className="eyebrow">CREW SNAPSHOT</p><strong>{office?.summary.active ?? 0} active work</strong><span>{office?.summary.idle ?? 0} Idle (managed)</span><span>{office?.summary.unknown ?? 0} Unknown / {office?.summary.offline ?? 0} Offline</span><hr/><span>Gateways running: {office ? `${office.summary.gatewaysReachable} of ${office.summary.gatewaysDeclared}` : 'Not Available'}</span></section>
          <div className="crew-list">{office?.stations.map(stationButton)}</div>
          <small className="muted">Stations show only attributable work. Select one for its evidence and freshness.</small>
        </>}
        {panel === 'Stats' && <Stats dashboard={dashboard ?? null} pending={dashboardPending} onNavigate={onNavigate}/>}
        {panel === 'Activity' && <>
          <section className="office-feed"><p className="eyebrow">LIVE ACTIVITY</p><h2>Unattributed sessions</h2>{sessions?.availability === 'unavailable' ? <p>Not Available</p> : !sessions ? <p>Loading read-only metadata...</p> : sessions.data.length === 0 ? <p>No session metadata available.</p> : sessions.data.slice(0, 5).map((session) => <article key={session.id ?? session.title}><strong>{session.title}</strong><span>{session.lastActive}</span></article>)}<small>Generic session metadata never changes crew state.</small></section>
          <section className="office-feed"><p className="eyebrow">CHANNELS</p><h2>Messaging platforms</h2>{channelSource?.availability === 'unavailable' ? <p>Not Available</p> : !channelSource ? <p>Loading safe status...</p> : channelSource.data.length === 0 ? <p>No configured channels.</p> : channelSource.data.map((channel) => <article key={channel.name}><strong>{channel.name}</strong><span>{channel.status}</span></article>)}{channels?.activeSessions !== undefined && <small>{channels.activeSessions} active session{channels.activeSessions === 1 ? '' : 's'}</small>}</section>
        </>}
      </div>
    </aside>}
    {overlay && <OfficeOverlay kind={overlay} onClose={() => setOverlay(undefined)} onNavigate={onNavigate}/>}
    {selected && <OfficeDetail station={selected} onClose={closeDetail} onPov={webgl ? handleStartPov : undefined}/>}
  </section>
}
