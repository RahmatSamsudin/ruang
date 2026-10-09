import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import {
  installSkinGenerate,
  resolveSkinProvider,
  buildBlockFlowPrompt,
  GenerateRateLimiter,
} from './skin-generate.js'
import { processBlockSkinImage } from './skin-flow.js'
import { encodePng, decodePng } from './skin-compose.js'

function validateFlowRefPaths(refPaths: unknown): { ok: boolean; status?: number; error?: string } {
  if (refPaths === undefined) return { ok: true }
  if (!Array.isArray(refPaths) || refPaths.length > 4) {
    return { ok: false, status: 400, error: 'bad input' }
  }
  const canonicalTmp = fs.realpathSync(os.tmpdir())
  for (const p of refPaths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      return { ok: false, status: 400, error: 'bad input' }
    }
    let realP: string
    try {
      realP = fs.realpathSync(p)
      const st = fs.statSync(realP)
      if (!st.isFile()) {
        return { ok: false, status: 400, error: 'bad input' }
      }
    } catch {
      return { ok: false, status: 400, error: 'bad input' }
    }
    const dir = path.dirname(realP)
    if (path.dirname(dir) !== canonicalTmp || !path.basename(dir).startsWith('ruang-flow-ref-')) {
      return { ok: false, status: 400, error: 'bad input' }
    }
  }
  return { ok: true }
}

describe('skin block provider', () => {
  let tmpDir: string
  let flowOutputDir: string
  let blockOutputDir: string
  let refLayoutPath: string
  let origProvider: string | undefined
  let origFlowUrl: string | undefined

  beforeEach(async () => {
    origProvider = process.env.RUANG_SKIN_PROVIDER
    origFlowUrl = process.env.RUANG_FLOW_URL
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'skin-block-test-'))
    flowOutputDir = path.join(tmpDir, 'flow-out')
    blockOutputDir = path.join(tmpDir, 'block-out')
    refLayoutPath = path.join(tmpDir, 'ref_layout.png')
    await fs.promises.mkdir(flowOutputDir, { recursive: true })
    await fs.promises.mkdir(blockOutputDir, { recursive: true })
    await fs.promises.writeFile(refLayoutPath, 'fake-ref-png')
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    if (origProvider !== undefined) {
      process.env.RUANG_SKIN_PROVIDER = origProvider
    } else {
      delete process.env.RUANG_SKIN_PROVIDER
    }
    if (origFlowUrl !== undefined) {
      process.env.RUANG_FLOW_URL = origFlowUrl
    } else {
      delete process.env.RUANG_FLOW_URL
    }
  })

  describe('resolveSkinProvider and prompt template', () => {
    it('defaults provider to block when env is unset or unrecognized', () => {
      delete process.env.RUANG_SKIN_PROVIDER
      expect(resolveSkinProvider(undefined)).toBe('block')
      expect(resolveSkinProvider('')).toBe('block')
      expect(resolveSkinProvider('unknown')).toBe('block')
    })

    it('resolves flow and llm from env', () => {
      expect(resolveSkinProvider('flow')).toBe('flow')
      expect(resolveSkinProvider('llm')).toBe('llm')
    })

    it('allows option override', () => {
      expect(resolveSkinProvider('llm', 'block')).toBe('block')
      expect(resolveSkinProvider('block', 'flow')).toBe('flow')
    })

    it('buildBlockFlowPrompt formats template correctly with user prompt', () => {
      const prompt = 'detective with trenchcoat'
      const formatted = buildBlockFlowPrompt(prompt)
      expect(formatted).toContain('LAYOUT AND STYLE REFERENCE')
      expect(formatted).toContain('Character to create: detective with trenchcoat.')
    })
  })

  describe('processBlockSkinImage', () => {
    it('returns 64x64 PNG for part "all"', () => {
      const rawData = Buffer.alloc(64 * 64 * 4, 100)
      const inputPng = encodePng(rawData, 64, 64)

      const result = processBlockSkinImage(inputPng, 'all', null)
      const decoded = decodePng(result)
      expect(decoded.width).toBe(64)
      expect(decoded.height).toBe(64)
    })

    it('throws error for non-64x64 PNG', () => {
      const rawData = Buffer.alloc(32 * 32 * 4, 100)
      const inputPng = encodePng(rawData, 32, 32)

      expect(() => processBlockSkinImage(inputPng, 'all', null)).toThrow(/unusable output/)
    })

    it('merges part "head" with baseDecoded', () => {
      const baseRaw = Buffer.alloc(64 * 64 * 4, 10)
      const baseDecoded = { width: 64, height: 64, data: baseRaw }

      const newRaw = Buffer.alloc(64 * 64 * 4, 200)
      const inputPng = encodePng(newRaw, 64, 64)

      const result = processBlockSkinImage(inputPng, 'head', baseDecoded)
      const decoded = decodePng(result)
      expect(decoded.width).toBe(64)
      expect(decoded.height).toBe(64)

      // Pixel in head area: x=8, y=8 -> index (8*64+8)*4
      const headIdx = (8 * 64 + 8) * 4
      expect(decoded.data[headIdx]).toBe(200)

      // Pixel in body/leg area: x=20, y=20 -> index (20*64+20)*4
      const bodyIdx = (20 * 64 + 20) * 4
      expect(decoded.data[bodyIdx]).toBe(10)
    })
  })

  describe('router integration with mocked fetch', () => {
    it('default provider block when env unset and block health returns 503 -> 503 block offline, exactly 1 health fetch', async () => {
      delete process.env.RUANG_SKIN_PROVIDER
      delete process.env.RUANG_FLOW_URL

      const flowCalls: string[] = []
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = url.toString()
        if (urlStr.includes('/health')) {
          return new Response(JSON.stringify({ ok: false }), { status: 503 })
        }
        if (urlStr.includes(':8092')) {
          flowCalls.push(urlStr)
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        blockRefLayoutPath: refLayoutPath,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'cyberpunk warrior' }),
        })

        expect(res.status).toBe(503)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('block offline')
        expect(flowCalls).toHaveLength(0)
        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(mockFetch.mock.calls[0][0].toString()).toContain('/health')
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('block health fetch throws connection refused -> 503 block offline, exactly 1 health fetch', async () => {
      delete process.env.RUANG_SKIN_PROVIDER
      delete process.env.RUANG_FLOW_URL

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        void url
        throw new Error('connect ECONNREFUSED 127.0.0.1:8093')
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        blockRefLayoutPath: refLayoutPath,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'cyberpunk warrior' }),
        })

        expect(res.status).toBe(503)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('block offline')
        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(mockFetch.mock.calls[0][0].toString()).toContain('/health')
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('block health returns 200 { ok: false } -> 503 block offline, exactly 1 health fetch', async () => {
      delete process.env.RUANG_SKIN_PROVIDER
      delete process.env.RUANG_FLOW_URL

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = url.toString()
        if (urlStr.includes('/health')) {
          return new Response(JSON.stringify({ ok: false }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        blockRefLayoutPath: refLayoutPath,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'cyberpunk warrior' }),
        })

        expect(res.status).toBe(503)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('block offline')
        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(mockFetch.mock.calls[0][0].toString()).toContain('/health')
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('concurrent request while first is in flight returns 409 and Flow POST called only once', async () => {
      delete process.env.RUANG_SKIN_PROVIDER
      delete process.env.RUANG_FLOW_URL

      let flowPostCount = 0
      let releaseFlow: (() => void) | undefined
      const flowWaitPromise = new Promise<void>((resolve) => {
        releaseFlow = resolve
      })

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.includes('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (urlStr.includes(':8092') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as Record<string, unknown>
          const validation = validateFlowRefPaths(body.reference_paths)
          if (!validation.ok) {
            return new Response(JSON.stringify({ error: validation.error }), { status: validation.status })
          }
          flowPostCount++
          await flowWaitPromise
          return new Response(JSON.stringify({ jobId: 'flow-job-concurrent' }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        blockRefLayoutPath: refLayoutPath,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const req1Promise = fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'job one' }),
        })

        await new Promise((r) => setTimeout(r, 50))

        const res2 = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'job two' }),
        })

        expect(res2.status).toBe(409)
        const body2 = (await res2.json()) as { error: string }
        expect(body2.error).toBe('busy')

        releaseFlow?.()
        const res1 = await req1Promise
        expect(res1.status).toBe(202)

        expect(flowPostCount).toBe(1)
      } finally {
        releaseFlow?.()
        await new Promise((r) => server.close(r))
      }
    })

    it('happy path flow -> block -> png for part "all" and part "head" merged with base', async () => {
      delete process.env.RUANG_SKIN_PROVIDER

      const flowRenderFile = path.join(flowOutputDir, 'flow-render.png')
      await fs.promises.writeFile(flowRenderFile, 'fake flow image content')

      const blockRaw = Buffer.alloc(64 * 64 * 4, 180)
      const blockSkinPng = encodePng(blockRaw, 64, 64)
      const blockSkinFile = path.join(blockOutputDir, 'block-skin.png')
      await fs.promises.writeFile(blockSkinFile, blockSkinPng)

      const flowPayloads: Array<Record<string, unknown>> = []
      const blockPayloads: Array<Record<string, unknown>> = []

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()

        if (urlStr.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }

        if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
          if (urlStr.includes(':8092')) {
            const body = JSON.parse(init.body as string) as Record<string, unknown>
            flowPayloads.push(body)
            const validation = validateFlowRefPaths(body.reference_paths)
            if (!validation.ok) {
              return new Response(JSON.stringify({ error: validation.error }), { status: validation.status })
            }
            return new Response(JSON.stringify({ jobId: 'flow-job-1' }), { status: 200 })
          }
          if (urlStr.includes(':8093')) {
            const body = JSON.parse(init.body as string) as Record<string, unknown>
            blockPayloads.push(body)
            return new Response(JSON.stringify({ jobId: 'block-job-1' }), { status: 200 })
          }
        }

        if (urlStr.includes('/jobs/flow-job-1')) {
          return new Response(
            JSON.stringify({ status: 'done', file: flowRenderFile }),
            { status: 200 },
          )
        }

        if (urlStr.includes('/jobs/block-job-1')) {
          return new Response(
            JSON.stringify({ status: 'done', file: blockSkinFile }),
            { status: 200 },
          )
        }

        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json({ limit: '10mb' }))
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        flowOutputDir,
        blockOutputDir,
        blockRefLayoutPath: refLayoutPath,
        flowPollIntervalMs: 10,
        blockPollIntervalMs: 10,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        // Test part "all"
        const postRes1 = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'space explorer', part: 'all' }),
        })
        expect(postRes1.status).toBe(202)
        const { jobId: jobId1 } = (await postRes1.json()) as { jobId: string }

        // Poll until done
        let skinPng1: string | null = null
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 20))
          const pollRes = await fetch(`${baseUrl}/api/skins/generate/${jobId1}`)
          const pollData = (await pollRes.json()) as { status: string; png?: string }
          if (pollData.status === 'done') {
            skinPng1 = pollData.png!
            break
          }
        }

        expect(skinPng1).toBeDefined()
        const decoded1 = decodePng(Buffer.from(skinPng1!, 'base64'))
        expect(decoded1.width).toBe(64)
        expect(decoded1.height).toBe(64)

        // Verify Flow payload used model: nano-banana-pro and reference_paths under tmpdir
        expect(flowPayloads[0].model).toBe('nano-banana-pro')
        const refPaths1 = flowPayloads[0].reference_paths as string[]
        expect(refPaths1).toHaveLength(1)
        expect(path.basename(path.dirname(refPaths1[0]))).toMatch(/^ruang-flow-ref-/)
        expect(path.basename(refPaths1[0])).toBe('ref_layout.png')
        // Cleaned up after job completed
        expect(fs.existsSync(path.dirname(refPaths1[0]))).toBe(false)
        expect(flowPayloads[0].prompt).toContain('Character to create: space explorer.')
        expect(flowPayloads[0].prompt).toContain('LAYOUT AND STYLE REFERENCE')

        // Verify Block payload used flow render output
        const realFlowOutput = await fs.promises.realpath(flowRenderFile)
        expect(blockPayloads[0].preview_path).toBe(realFlowOutput)

        // Test part "head" with base
        const baseBuf = Buffer.alloc(64 * 64 * 4, 30)
        const baseBase64 = encodePng(baseBuf, 64, 64).toString('base64')

        const postRes2 = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({
            prompt: 'golden helmet',
            part: 'head',
            base: baseBase64,
          }),
        })
        expect(postRes2.status).toBe(202)
        const { jobId: jobId2 } = (await postRes2.json()) as { jobId: string }

        let skinPng2: string | null = null
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 20))
          const pollRes = await fetch(`${baseUrl}/api/skins/generate/${jobId2}`)
          const pollData = (await pollRes.json()) as { status: string; png?: string }
          if (pollData.status === 'done') {
            skinPng2 = pollData.png!
            break
          }
        }

        expect(skinPng2).toBeDefined()
        const decoded2 = decodePng(Buffer.from(skinPng2!, 'base64'))
        expect(decoded2.width).toBe(64)
        expect(decoded2.height).toBe(64)
        // Head region replaced from block (180)
        expect(decoded2.data[(8 * 64 + 8) * 4]).toBe(180)
        // Body region preserved from base (30)
        expect(decoded2.data[(20 * 64 + 20) * 4]).toBe(30)

        const refPaths2 = flowPayloads[1].reference_paths as string[]
        expect(refPaths2).toHaveLength(1)
        expect(fs.existsSync(path.dirname(refPaths2[0]))).toBe(false)
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('stage field reports preview then convert during execution', async () => {
      const flowRenderFile = path.join(flowOutputDir, 'flow-stage.png')
      await fs.promises.writeFile(flowRenderFile, 'fake flow image content')

      let flowPollCount = 0
      let blockPollCount = 0

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
          if (urlStr.includes(':8092')) {
            const body = JSON.parse(init.body as string) as Record<string, unknown>
            const validation = validateFlowRefPaths(body.reference_paths)
            if (!validation.ok) {
              return new Response(JSON.stringify({ error: validation.error }), { status: validation.status })
            }
            return new Response(JSON.stringify({ jobId: 'flow-stage' }), { status: 200 })
          }
          if (urlStr.includes(':8093')) return new Response(JSON.stringify({ jobId: 'block-stage' }), { status: 200 })
        }
        if (urlStr.includes('/jobs/flow-stage')) {
          flowPollCount++
          if (flowPollCount < 3) {
            return new Response(JSON.stringify({ status: 'running' }), { status: 200 })
          }
          return new Response(JSON.stringify({ status: 'done', file: flowRenderFile }), { status: 200 })
        }
        if (urlStr.includes('/jobs/block-stage')) {
          blockPollCount++
          if (blockPollCount < 3) {
            return new Response(JSON.stringify({ status: 'running' }), { status: 200 })
          }
          const blockSkinFile = path.join(blockOutputDir, 'block-stage-skin.png')
          await fs.promises.writeFile(blockSkinFile, encodePng(Buffer.alloc(64 * 64 * 4, 100), 64, 64))
          return new Response(JSON.stringify({ status: 'done', file: blockSkinFile }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        flowOutputDir,
        blockOutputDir,
        blockRefLayoutPath: refLayoutPath,
        flowPollIntervalMs: 50,
        blockPollIntervalMs: 50,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const postRes = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'knight' }),
        })
        const { jobId } = (await postRes.json()) as { jobId: string }

        const stagesSeen = new Set<string>()
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 20))
          const pollRes = await fetch(`${baseUrl}/api/skins/generate/${jobId}`)
          const pollData = (await pollRes.json()) as { status: string; stage?: string }
          if (pollData.stage) {
            stagesSeen.add(pollData.stage)
          }
          if (pollData.status === 'done') break
        }

        expect(stagesSeen.has('preview')).toBe(true)
        expect(stagesSeen.has('convert')).toBe(true)
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('block job error results in job error', async () => {
      const flowRenderFile = path.join(flowOutputDir, 'flow-err.png')
      await fs.promises.writeFile(flowRenderFile, 'fake flow image content')

      let capturedRefPath: string | undefined

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
          if (urlStr.includes(':8092')) {
            const body = JSON.parse(init.body as string) as Record<string, unknown>
            capturedRefPath = (body.reference_paths as string[])?.[0]
            const validation = validateFlowRefPaths(body.reference_paths)
            if (!validation.ok) {
              return new Response(JSON.stringify({ error: validation.error }), { status: validation.status })
            }
            return new Response(JSON.stringify({ jobId: 'flow-err' }), { status: 200 })
          }
          if (urlStr.includes(':8093')) return new Response(JSON.stringify({ jobId: 'block-err' }), { status: 200 })
        }
        if (urlStr.includes('/jobs/flow-err')) {
          return new Response(JSON.stringify({ status: 'done', file: flowRenderFile }), { status: 200 })
        }
        if (urlStr.includes('/jobs/block-err')) {
          return new Response(
            JSON.stringify({ status: 'error', error: 'converter crashed' }),
            { status: 200 },
          )
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        flowOutputDir,
        blockOutputDir,
        blockRefLayoutPath: refLayoutPath,
        flowPollIntervalMs: 10,
        blockPollIntervalMs: 10,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const postRes = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'knight' }),
        })
        const { jobId } = (await postRes.json()) as { jobId: string }

        let errorMsg: string | null = null
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 20))
          const pollRes = await fetch(`${baseUrl}/api/skins/generate/${jobId}`)
          const pollData = (await pollRes.json()) as { status: string; error?: string }
          if (pollData.status === 'error') {
            errorMsg = pollData.error!
            break
          }
        }

        expect(errorMsg).toBe('converter crashed')
        expect(capturedRefPath).toBeDefined()
        expect(fs.existsSync(path.dirname(capturedRefPath!))).toBe(false)
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('block output outside block dir results in unusable output', async () => {
      const flowRenderFile = path.join(flowOutputDir, 'flow-escape.png')
      await fs.promises.writeFile(flowRenderFile, 'fake flow image content')

      const outsideFile = path.join(tmpDir, 'outside.png')
      await fs.promises.writeFile(outsideFile, encodePng(Buffer.alloc(64 * 64 * 4), 64, 64))

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (urlStr.endsWith('/jobs') && init?.method === 'POST') {
          if (urlStr.includes(':8092')) {
            const body = JSON.parse(init.body as string) as Record<string, unknown>
            const validation = validateFlowRefPaths(body.reference_paths)
            if (!validation.ok) {
              return new Response(JSON.stringify({ error: validation.error }), { status: validation.status })
            }
            return new Response(JSON.stringify({ jobId: 'flow-esc' }), { status: 200 })
          }
          if (urlStr.includes(':8093')) return new Response(JSON.stringify({ jobId: 'block-esc' }), { status: 200 })
        }
        if (urlStr.includes('/jobs/flow-esc')) {
          return new Response(JSON.stringify({ status: 'done', file: flowRenderFile }), { status: 200 })
        }
        if (urlStr.includes('/jobs/block-esc')) {
          return new Response(JSON.stringify({ status: 'done', file: outsideFile }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        flowOutputDir,
        blockOutputDir,
        blockRefLayoutPath: refLayoutPath,
        flowPollIntervalMs: 10,
        blockPollIntervalMs: 10,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const postRes = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'wizard' }),
        })
        const { jobId } = (await postRes.json()) as { jobId: string }

        let errorMsg: string | null = null
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 20))
          const pollRes = await fetch(`${baseUrl}/api/skins/generate/${jobId}`)
          const pollData = (await pollRes.json()) as { status: string; error?: string }
          if (pollData.status === 'error') {
            errorMsg = pollData.error!
            break
          }
        }

        expect(errorMsg).toBe('unusable output')
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('env flow and llm route as before', async () => {
      // 1. Test env flow
      process.env.RUANG_SKIN_PROVIDER = 'flow'

      let blockHealthCalled = false
      let flowPostCalled = false

      const mockFetchFlow = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.includes(':8093')) {
          blockHealthCalled = true
        }
        if (urlStr.includes(':8092') && init?.method === 'POST') {
          flowPostCalled = true
          return new Response(JSON.stringify({ jobId: 'flow-env-job' }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const appFlow = express()
      appFlow.use(express.json())
      installSkinGenerate(appFlow, {
        fetchFn: mockFetchFlow as unknown as typeof fetch,
        rateLimiter: new GenerateRateLimiter(),
      })

      const serverFlow = appFlow.listen(0, '127.0.0.1')
      await new Promise((r) => serverFlow.once('listening', r))
      const baseUrlFlow = `http://127.0.0.1:${(serverFlow.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrlFlow}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrlFlow },
          body: JSON.stringify({ prompt: 'ninja' }),
        })
        expect(res.status).toBe(202)
        expect(flowPostCalled).toBe(true)
        expect(blockHealthCalled).toBe(false)
      } finally {
        await new Promise((r) => serverFlow.close(r))
      }

      // 2. Test env llm
      process.env.RUANG_SKIN_PROVIDER = 'llm'

      const mockFetchLlm = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    palette: ['#ff0000'],
                    pixels: Array.from({ length: 64 }, () => Array.from({ length: 64 }, () => 0)),
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )

      const appLlm = express()
      appLlm.use(express.json())
      installSkinGenerate(appLlm, {
        apiKey: 'mock-key',
        fetchFn: mockFetchLlm as unknown as typeof fetch,
        rateLimiter: new GenerateRateLimiter(),
      })

      const serverLlm = appLlm.listen(0, '127.0.0.1')
      await new Promise((r) => serverLlm.once('listening', r))
      const baseUrlLlm = `http://127.0.0.1:${(serverLlm.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrlLlm}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrlLlm },
          body: JSON.stringify({ prompt: 'archer' }),
        })
        expect(res.status).toBe(202)
      } finally {
        await new Promise((r) => serverLlm.close(r))
      }
    })

    it('missing ref layout -> 500 block ref layout missing or unreadable and 0 Flow POSTs', async () => {
      let flowPostCount = 0
      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (urlStr.includes(':8092') && init?.method === 'POST') {
          flowPostCount++
          return new Response(JSON.stringify({ jobId: 'should-not-reach' }), { status: 200 })
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        blockRefLayoutPath: path.join(tmpDir, 'non-existent-ref-layout.png'),
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'test' }),
        })
        expect(res.status).toBe(500)
        const data = (await res.json()) as { error: string }
        expect(data.error).toBe('block ref layout missing or unreadable')
        expect(flowPostCount).toBe(0)
      } finally {
        await new Promise((r) => server.close(r))
      }
    })

    it('Flow 400 returns 502 flow rejected request and cleans up temp dir', async () => {
      let capturedRefPath: string | undefined
      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = url.toString()
        if (urlStr.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        if (urlStr.includes(':8092') && init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as { reference_paths?: string[] }
          capturedRefPath = body.reference_paths?.[0]
          return new Response(JSON.stringify({ error: 'bad input' }), { status: 400 })
        }
        return new Response('Not found', { status: 404 })
      })

      const app = express()
      app.use(express.json())
      installSkinGenerate(app, {
        fetchFn: mockFetch as unknown as typeof fetch,
        blockRefLayoutPath: refLayoutPath,
        rateLimiter: new GenerateRateLimiter(),
      })

      const server = app.listen(0, '127.0.0.1')
      await new Promise((r) => server.once('listening', r))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      try {
        const res = await fetch(`${baseUrl}/api/skins/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: baseUrl },
          body: JSON.stringify({ prompt: 'test' }),
        })
        expect(res.status).toBe(502)
        const data = (await res.json()) as { error: string }
        expect(data.error).toBe('flow rejected request')
        expect(capturedRefPath).toBeDefined()
        expect(fs.existsSync(path.dirname(capturedRefPath!))).toBe(false)
      } finally {
        await new Promise((r) => server.close(r))
      }
    })
  })
})
