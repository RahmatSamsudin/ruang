// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Office, OfficeDetail } from './Office.tsx'
import type { ActivitySnapshot, ChannelSnapshot, OfficeSnapshot, OfficeStation } from '../types.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('OfficeDetail POV buttons', () => {
  it('renders both POV buttons with accessible labels when onPov is provided', async () => {
    const onPov = vi.fn()
    const onClose = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<OfficeDetail station={sampleStation} onClose={onClose} onPov={onPov} />)
    })

    const firstBtn = document.querySelector<HTMLButtonElement>('button[aria-label="View as coder in first person"]')
    const thirdBtn = document.querySelector<HTMLButtonElement>('button[aria-label="View as coder in third person"]')

    expect(firstBtn).not.toBeNull()
    expect(firstBtn?.getAttribute('type')).toBe('button')
    expect(firstBtn?.textContent).toContain('👁 1st Person')

    expect(thirdBtn).not.toBeNull()
    expect(thirdBtn?.getAttribute('type')).toBe('button')
    expect(thirdBtn?.textContent).toContain('🎥 3rd Person')

    await act(async () => {
      firstBtn?.click()
    })
    expect(onPov).toHaveBeenCalledWith('first')

    await act(async () => {
      thirdBtn?.click()
    })
    expect(onPov).toHaveBeenCalledWith('third')

    await act(async () => {
      root.unmount()
    })
  })

  it('hides both POV buttons when onPov is not provided (e.g. WebGL unavailable)', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<OfficeDetail station={sampleStation} onClose={vi.fn()} />)
    })

    const firstBtn = document.querySelector('button[aria-label="View as coder in first person"]')
    const thirdBtn = document.querySelector('button[aria-label="View as coder in third person"]')

    expect(firstBtn).toBeNull()
    expect(thirdBtn).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('clicking POV button in 2D switches to 3D, sets pov, and closes OfficeDetail', async () => {
    window.localStorage.setItem('mc.officeView', '2d')
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      ((contextId: string) => (contextId.includes('webgl') ? ({} as WebGLRenderingContext) : null)) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )

    vi.stubGlobal('fetch', vi.fn((path: string) =>
      Promise.resolve(new Response(JSON.stringify(path === '/api/office' ? officeSnapshot : path === '/api/activity' ? activitySnapshot : channelsSnapshot)))
    ))

    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(<Office />)
      await Promise.resolve()
    })

    // Initially in 2D
    const stage = document.querySelector('.office-stage')
    expect(stage?.classList.contains('view-2d')).toBe(true)

    // Open detail dialog by clicking station
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label^="coder"]')
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger?.click()
    })

    // Ensure dialog is open
    expect(document.querySelector('.office-detail')).not.toBeNull()

    // Click 1st Person POV button
    const firstBtn = document.querySelector<HTMLButtonElement>('button[aria-label="View as coder in first person"]')
    expect(firstBtn).not.toBeNull()
    await act(async () => {
      firstBtn?.click()
    })

    // Dialog should be closed
    expect(document.querySelector('.office-detail')).toBeNull()

    // View should switch to 3D and persist in localStorage
    expect(stage?.classList.contains('view-3d')).toBe(true)
    expect(window.localStorage.getItem('mc.officeView')).toBe('3d')

    await act(async () => {
      root.unmount()
    })
  })
})
