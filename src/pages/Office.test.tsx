// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Office } from './Office.tsx'
import type { ActivitySnapshot, ChannelSnapshot, OfficeSnapshot, OfficeStation } from '../types.ts'

vi.mock('@react-three/fiber', () => ({
  Canvas: () => <div data-testid="mock-three-canvas" />,
  useFrame: vi.fn(),
  useThree: () => ({
    camera: { position: { set: vi.fn() }, lookAt: vi.fn() },
    scene: { add: vi.fn(), remove: vi.fn() },
    gl: { domElement: document.createElement('canvas') },
  }),
}))

const testEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
testEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const sampleStation: OfficeStation = {
  id: 'coder',
  name: 'coder',
  role: 'Hermes profile',
  room: 'Workspace',
  roomPosition: 'assigned-desk',
  state: 'Reviewing',
  currentTask: 'Review office behavior',
  recentActivity: 'No attributed recent activity',
  activity: 'Reviewing: Review office behavior',
  seat: 1,
  provenance: 'Gateway Running',
  freshness: 'Runtime current',
}

const officeSnapshot: OfficeSnapshot = {
  stations: [sampleStation],
  summary: { declared: 1, active: 1, idle: 0, offline: 0, unknown: 0, gatewaysReachable: 1, gatewaysDeclared: 1 },
  fetchedAt: '2026-09-27T12:00:00.000Z',
}
const activitySnapshot: ActivitySnapshot = { sessions: { availability: 'available', data: [] }, fetchedAt: officeSnapshot.fetchedAt }
const channelsSnapshot: ChannelSnapshot = { channels: { availability: 'available', data: [] }, fetchedAt: officeSnapshot.fetchedAt }

async function renderOffice(root: ReturnType<typeof createRoot>) {
  await act(async () => {
    root.render(<Office />)
  })
  await act(async () => {
    await import('./Office3D.tsx')
    await new Promise((r) => setTimeout(r, 20))
  })
}

beforeEach(() => {
  window.localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    ((contextId: string) => (contextId.includes('webgl') ? ({} as WebGLRenderingContext) : null)) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  )
  vi.stubGlobal('fetch', vi.fn((path: string) =>
    Promise.resolve(new Response(JSON.stringify(path === '/api/office' ? officeSnapshot : path === '/api/activity' ? activitySnapshot : channelsSnapshot)))
  ))
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('Office POV lifecycle and view switching', () => {
  it('clears POV when switching away from 3D to 2D, and does not restore stale POV on returning to 3D', async () => {
    window.localStorage.setItem('mc.officeView', '3d')
    window.localStorage.setItem('mc.officePanel', 'Crew')

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await renderOffice(root)

    // Confirm initial 3D stage
    const stage = document.querySelector('.office-stage')
    expect(stage?.classList.contains('view-3d')).toBe(true)

    // Open detail dialog via crew list row
    const crewRow = document.querySelector<HTMLButtonElement>('.crew-row')
    expect(crewRow).not.toBeNull()
    await act(async () => {
      crewRow?.click()
    })

    // Detail dialog should be open
    const povBtn = document.querySelector<HTMLButtonElement>('button[aria-label="View as coder in first person"]')
    expect(povBtn).not.toBeNull()

    // Enter POV
    await act(async () => {
      povBtn?.click()
    })

    // Detail dialog closed, POV HUD is visible in 3D
    expect(document.querySelector('.office-detail')).toBeNull()
    expect(document.querySelector('.office-pov-hud')).not.toBeNull()

    // Switch to 2D view
    const view2dBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.view-toggle button'))
      .find((b) => b.textContent?.trim() === '2D')
    expect(view2dBtn).toBeDefined()

    await act(async () => {
      view2dBtn?.click()
    })

    expect(stage?.classList.contains('view-2d')).toBe(true)
    expect(document.querySelector('.office-pov-hud')).toBeNull()

    // Switch back to 3D view
    const view3dBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.view-toggle button'))
      .find((b) => b.textContent?.trim() === '3D')
    expect(view3dBtn).toBeDefined()

    await act(async () => {
      view3dBtn?.click()
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 20))
    })

    expect(stage?.classList.contains('view-3d')).toBe(true)
    // POV HUD must be absent after 3D -> 2D -> 3D round-trip (stale POV not restored)
    expect(document.querySelector('.office-pov-hud')).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('Escape clears POV via single handler on Office when no dialog is open', async () => {
    window.localStorage.setItem('mc.officeView', '3d')
    window.localStorage.setItem('mc.officePanel', 'Crew')

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await renderOffice(root)

    // Enter POV
    const crewRow = document.querySelector<HTMLButtonElement>('.crew-row')
    await act(async () => {
      crewRow?.click()
    })
    const povBtn = document.querySelector<HTMLButtonElement>('button[aria-label="View as coder in first person"]')
    await act(async () => {
      povBtn?.click()
    })

    expect(document.querySelector('.office-pov-hud')).not.toBeNull()

    // Press Escape key
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    // POV HUD is cleared
    expect(document.querySelector('.office-pov-hud')).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('Escape does not clear POV while detail dialog is open, but closes dialog first', async () => {
    window.localStorage.setItem('mc.officeView', '3d')
    window.localStorage.setItem('mc.officePanel', 'Crew')

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await renderOffice(root)

    // Enter POV
    const crewRow = document.querySelector<HTMLButtonElement>('.crew-row')
    await act(async () => {
      crewRow?.click()
    })
    const povBtn = document.querySelector<HTMLButtonElement>('button[aria-label="View as coder in first person"]')
    await act(async () => {
      povBtn?.click()
    })
    expect(document.querySelector('.office-pov-hud')).not.toBeNull()

    // Open detail dialog from HUD Detail button
    const detailBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.office-pov-btn'))
      .find((b) => b.textContent?.trim() === 'Detail')
    expect(detailBtn).toBeDefined()
    await act(async () => {
      detailBtn?.click()
    })

    // Detail dialog is now open
    expect(document.querySelector('.office-detail')).not.toBeNull()

    // First Escape closes dialog (handled by OfficeDetail dialog onKeyDown)
    const detailDialog = document.querySelector<HTMLElement>('.office-detail')
    await act(async () => {
      detailDialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.office-detail')).toBeNull()
    // POV HUD is still active
    expect(document.querySelector('.office-pov-hud')).not.toBeNull()

    // Second Escape closes POV (handled by Office window keydown handler)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.office-pov-hud')).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })
})
