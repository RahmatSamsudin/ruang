// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Office3D } from './Office3D.tsx'
import type { OfficeStation } from '../types.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('Office3D floating POV HUD', () => {
  it('does not render HUD when pov is not set', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Office3D
          stations={[sampleStation]}
          onSelect={vi.fn()}
        />
      )
    })

    expect(document.querySelector('.office-pov-hud')).toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('renders HUD with mode label, lock indicator, and 4 controls when pov is set', async () => {
    const onPovChange = vi.fn()
    const onSelect = vi.fn()
    const onOpenDetail = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Office3D
          stations={[sampleStation]}
          onSelect={onSelect}
          pov={{ name: 'coder', mode: 'first' }}
          onPovChange={onPovChange}
          onOpenDetail={onOpenDetail}
        />
      )
    })

    const hud = document.querySelector('.office-pov-hud')
    expect(hud).not.toBeNull()

    // Mode label & lock indicator
    const modeLabel = hud?.querySelector('.office-pov-mode')
    expect(modeLabel?.textContent).toBe('👁 1st Person: coder')

    const lockStatus = hud?.querySelector('.office-pov-lock')
    expect(lockStatus).not.toBeNull()
    expect(lockStatus?.getAttribute('role')).toBe('status')
    expect(lockStatus?.textContent).toContain('Kamera terkunci / Locked POV')

    // 4 controls
    const firstBtn = hud?.querySelector<HTMLButtonElement>('button:nth-of-type(1)')
    const thirdBtn = hud?.querySelector<HTMLButtonElement>('button:nth-of-type(2)')
    const detailBtn = hud?.querySelector<HTMLButtonElement>('button:nth-of-type(3)')
    const exitBtn = hud?.querySelector<HTMLButtonElement>('button:nth-of-type(4)')

    expect(firstBtn?.textContent).toBe('1st Person')
    expect(firstBtn?.getAttribute('aria-pressed')).toBe('true')
    expect(firstBtn?.classList.contains('active')).toBe(true)

    expect(thirdBtn?.textContent).toBe('3rd Person')
    expect(thirdBtn?.getAttribute('aria-pressed')).toBe('false')

    expect(detailBtn?.textContent).toBe('Detail')
    expect(exitBtn?.textContent).toBe('✕ Exit View')

    // Toggling mode to 3rd person
    await act(async () => {
      thirdBtn?.click()
    })
    expect(onPovChange).toHaveBeenCalledWith({ name: 'coder', mode: 'third' })

    // Clicking Detail invokes onSelect and onOpenDetail
    await act(async () => {
      detailBtn?.click()
    })
    expect(onSelect).toHaveBeenCalledWith(sampleStation, detailBtn)
    expect(onOpenDetail).toHaveBeenCalledWith('coder')

    // Clicking Exit View clears pov
    await act(async () => {
      exitBtn?.click()
    })
    expect(onPovChange).toHaveBeenCalledWith(null)

    await act(async () => {
      root.unmount()
    })
  })

  it('reflects third-person mode in label and aria-pressed', async () => {
    const onPovChange = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Office3D
          stations={[sampleStation]}
          onSelect={vi.fn()}
          pov={{ name: 'coder', mode: 'third' }}
          onPovChange={onPovChange}
        />
      )
    })

    const hud = document.querySelector('.office-pov-hud')
    expect(hud?.querySelector('.office-pov-mode')?.textContent).toBe('🎥 3rd Person: coder')

    const firstBtn = hud?.querySelector<HTMLButtonElement>('button:nth-of-type(1)')
    const thirdBtn = hud?.querySelector<HTMLButtonElement>('button:nth-of-type(2)')

    expect(firstBtn?.getAttribute('aria-pressed')).toBe('false')
    expect(thirdBtn?.getAttribute('aria-pressed')).toBe('true')
    expect(thirdBtn?.classList.contains('active')).toBe(true)

    // Switching back to 1st Person
    await act(async () => {
      firstBtn?.click()
    })
    expect(onPovChange).toHaveBeenCalledWith({ name: 'coder', mode: 'first' })

    await act(async () => {
      root.unmount()
    })
  })

  it('exits POV on Escape key press when dialog is not open', async () => {
    const onPovChange = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Office3D
          stations={[sampleStation]}
          onSelect={vi.fn()}
          pov={{ name: 'coder', mode: 'first' }}
          onPovChange={onPovChange}
        />
      )
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onPovChange).toHaveBeenCalledWith(null)

    await act(async () => {
      root.unmount()
    })
  })

  it('does NOT exit POV on Escape key press when OfficeDetail dialog is open', async () => {
    const onPovChange = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.className = 'office-detail'
    dialog.setAttribute('role', 'dialog')

    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Office3D
          stations={[sampleStation]}
          onSelect={vi.fn()}
          pov={{ name: 'coder', mode: 'first' }}
          onPovChange={onPovChange}
        />
      )
    })

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onPovChange).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })
  })

  it('clears pov if the followed station disappears from stations list', async () => {
    const onPovChange = vi.fn()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Office3D
          stations={[]} // coder is missing
          onSelect={vi.fn()}
          pov={{ name: 'coder', mode: 'first' }}
          onPovChange={onPovChange}
        />
      )
    })

    expect(onPovChange).toHaveBeenCalledWith(null)

    await act(async () => {
      root.unmount()
    })
  })
})
