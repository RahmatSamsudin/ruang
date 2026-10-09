import {
  SKIN_WIDTH,
  SKIN_HEIGHT,
  paintDefaultSkin,
  encodeRgbaToPng,
  SKIN_RECTS,
  type SkinsSnapshot,
} from './scene3d/skin'

export const MOCK_TEST_AGENT_ID = 'dev'
export const MOCK_TEST_VERSION = 'test-c3-v1'

export const MOCK_SKINS_SNAPSHOT: SkinsSnapshot = {
  skins: {
    [MOCK_TEST_AGENT_ID]: {
      version: MOCK_TEST_VERSION,
      updatedAt: '2026-10-09T10:00:00.000Z',
    },
  },
}

/** Generate RGBA pixel buffer for the hand-made test skin with distinct cyberpunk palette and visor overlay. */
export function createTestSkinData(): Uint8ClampedArray {
  const data = paintDefaultSkin({
    hair: '#11151c',
    skin: '#f1c9a0',
    shirt: '#00e5ff', // Neon cyan jacket
    pants: '#6a1b9a', // Deep purple
  })

  // Add golden helmet / visor on overlay layer (head overlay)
  const ho = SKIN_RECTS.head.overlay
  const gold: [number, number, number, number] = [255, 215, 0, 255]
  const visor: [number, number, number, number] = [255, 40, 0, 255]

  // Paint visor on head overlay front face (y=11..12, x=41..46)
  for (let py = ho.front.y + 3; py < ho.front.y + 5; py++) {
    for (let px = ho.front.x + 1; px < ho.front.x + 7; px++) {
      const idx = (py * SKIN_WIDTH + px) * 4
      data[idx] = visor[0]
      data[idx + 1] = visor[1]
      data[idx + 2] = visor[2]
      data[idx + 3] = visor[3]
    }
  }

  // Paint golden headset on sides
  for (let py = ho.right.y + 2; py < ho.right.y + 6; py++) {
    for (let px = ho.right.x + 2; px < ho.right.x + 6; px++) {
      const idx = (py * SKIN_WIDTH + px) * 4
      data[idx] = gold[0]
      data[idx + 1] = gold[1]
      data[idx + 2] = gold[2]
      data[idx + 3] = gold[3]
    }
  }
  for (let py = ho.left.y + 2; py < ho.left.y + 6; py++) {
    for (let px = ho.left.x + 2; px < ho.left.x + 6; px++) {
      const idx = (py * SKIN_WIDTH + px) * 4
      data[idx] = gold[0]
      data[idx + 1] = gold[1]
      data[idx + 2] = gold[2]
      data[idx + 3] = gold[3]
    }
  }

  return data
}

/** Generate valid 64x64 PNG binary buffer for the hand-made test skin. */
export function createTestSkinPng(): Uint8Array {
  const data = createTestSkinData()
  return encodeRgbaToPng(SKIN_WIDTH, SKIN_HEIGHT, data)
}

/** Check if dev mock is active (only true during development, never in production). */
export function isDevMockActive(): boolean {
  return typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)
}

/** Install fetch interceptor for development only when upstream server does not provide /api/skins. */
export function installDevMock(): void {
  if (!isDevMockActive() || typeof window === 'undefined') return

  const originalFetch = window.fetch
  let testPngBlob: Blob | null = null

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

    const pathname = url.split('?')[0]
    if (pathname === '/api/skins') {
      try {
        const upstream = await originalFetch(input, init)
        if (upstream.ok) return upstream
      } catch {
        // Fall back to dev mock
      }
      return new Response(JSON.stringify(MOCK_SKINS_SNAPSHOT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (pathname === `/api/skins/${encodeURIComponent(MOCK_TEST_AGENT_ID)}.png`) {
      try {
        const upstream = await originalFetch(input, init)
        if (upstream.ok) return upstream
      } catch {
        // Fall back to dev mock
      }
      if (!testPngBlob) {
        const pngBytes = createTestSkinPng()
        testPngBlob = new Blob([pngBytes.buffer as ArrayBuffer], { type: 'image/png' })
      }
      return new Response(testPngBlob, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    }

    return originalFetch(input, init)
  }
}
