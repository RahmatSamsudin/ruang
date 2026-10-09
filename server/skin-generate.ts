/**
 * Skin Generate API (F2):
 *
 * Provider: env RUANG_SKIN_PROVIDER=block|flow|llm (default block).
 *
 * POST /api/skins/generate
 *   Headers: Origin matching Host (403 Forbidden if mismatched)
 *   Body: JSON (max 64 KiB, 413 if exceeded)
 *     {
 *       prompt: string (1..300 chars, 400 if invalid),
 *       part?: "all" | "head" | "body" | "arms" | "legs" (default "all"),
 *       base?: string (base64-encoded 64x64 RGBA PNG, 400 if invalid)
 *     }
 *   Responses:
 *     202 { jobId: string }
 *     400 { error: string } (validation failure)
 *     403 { error: "Forbidden." } (origin mismatch)
 *     409 { error: "busy" } (job already active server-wide, max 1 active)
 *     413 { error: "Payload too large." }
 *     423 { error: string, locked: "profile", agent: string } (profile locked)
 *     429 { error: "busy" } (>6 calls/min rate limit hit)
 *     429 { error: "daily cap" } (Flow service daily credit cap hit)
 *     503 { error: "block offline" } (BLOCK service unreachable / 503 / health not ok)
 *     503 { error: "flow offline" } (Flow service unreachable / 503)
 *
 * GET /api/skins/generate/:jobId
 *   Responses:
 *     200 { status: "queued" | "running" | "done" | "error", stage?: "preview" | "convert", png?: string, error?: string, notes?: string }
 *     404 { error: "Job not found." } (unknown or expired > 10 min)
 *
 * Memory lifecycle:
 *   - Jobs kept in memory up to 10 min after creation then dropped.
 *   - Bounded map, max 50 entries, oldest evicted.
 *   - Max wait 5 min (8 min for block provider) -> status becomes error "timeout".
 *   - Generate NEVER saves to disk / skins DB.
 */

import express, { type Express, type NextFunction, type Request, type Response, Router } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isHidden, type Privacy } from './profile-lock.js'
import {
  ComposeError,
  composeSkinFromJson,
  decodePng,
  type SkinPart,
} from './skin-compose.js'
import { buildFlowPrompt, processBlockSkinImage, processFlowSkinImage } from './skin-flow.js'
import { createTemplatePng, upscale64To1024Png } from './skin-template.js'
import { matchOriginHost, MAX_SKIN_BYTES } from './skins.js'
import { SkinLibraryStore } from './skin-library.js'

export class SkinGenerateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class GenerateRateLimiter {
  private requests = new Map<string, number[]>()

  constructor(readonly windowMs = 60_000, readonly maxRequests = 6) {}

  check(ip: string): void {
    const now = Date.now()
    const timestamps = (this.requests.get(ip) ?? []).filter((t) => now - t < this.windowMs)
    if (timestamps.length >= this.maxRequests) {
      this.requests.set(ip, timestamps)
      throw new SkinGenerateError('busy', 429)
    }
    timestamps.push(now)
    this.requests.set(ip, timestamps)
  }

  reset(): void {
    this.requests.clear()
  }
}

export type SkinJobStatus = 'queued' | 'running' | 'done' | 'error'
export type SkinProvider = 'block' | 'flow' | 'llm'

export function resolveSkinProvider(envVal?: string, optVal?: SkinProvider): SkinProvider {
  if (optVal === 'llm' || optVal === 'flow' || optVal === 'block') {
    return optVal
  }
  if (envVal === 'llm') return 'llm'
  if (envVal === 'flow') return 'flow'
  return 'block'
}

export interface SkinJob {
  id: string
  status: SkinJobStatus
  createdAt: number
  updatedAt: number
  provider: SkinProvider
  stage?: 'preview' | 'convert'
  prompt: string
  part: SkinPart
  agent?: string
  png?: string
  error?: string
  notes?: string
  promise?: Promise<void>
  cleanup?: () => Promise<void>
}

export class SkinJobManager {
  private jobs = new Map<string, SkinJob>()
  private readonly maxEntries = 50
  private readonly ttlMs = 10 * 60 * 1000 // 10 minutes
  private readonly timeoutMs = 5 * 60 * 1000 // 5 minutes

  private getJobTimeoutMs(job: SkinJob): number {
    return job.provider === 'block' ? 8 * 60 * 1000 : this.timeoutMs
  }

  getActiveJob(): SkinJob | undefined {
    const now = Date.now()
    this.purgeExpired(now)
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') {
        if (now - job.createdAt > this.getJobTimeoutMs(job)) {
          job.status = 'error'
          job.error = 'timeout'
          job.updatedAt = now
          if (job.cleanup) {
            void job.cleanup()
          }
        } else {
          return job
        }
      }
    }
    return undefined
  }

  createJob(
    provider: SkinProvider,
    prompt: string,
    part: SkinPart,
    stage?: 'preview' | 'convert',
    agent?: string,
  ): SkinJob {
    const active = this.getActiveJob()
    if (active) {
      throw new SkinGenerateError('busy', 409)
    }

    const now = Date.now()
    const id = `job_${now}_${Math.random().toString(36).slice(2, 9)}`

    // Evict oldest entries if capacity reached
    while (this.jobs.size >= this.maxEntries) {
      const oldestKey = this.jobs.keys().next().value
      if (!oldestKey) break
      const oldJob = this.jobs.get(oldestKey)
      if (oldJob?.cleanup) {
        void oldJob.cleanup()
      }
      this.jobs.delete(oldestKey)
    }

    const job: SkinJob = {
      id,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      provider,
      ...(stage ? { stage } : {}),
      prompt,
      part,
      ...(agent ? { agent } : {}),
    }

    this.jobs.set(id, job)
    return job
  }

  getJob(id: string): SkinJob | undefined {
    const now = Date.now()
    this.purgeExpired(now)
    const job = this.jobs.get(id)
    if (!job) return undefined

    if (
      (job.status === 'queued' || job.status === 'running') &&
      now - job.createdAt > this.getJobTimeoutMs(job)
    ) {
      job.status = 'error'
      job.error = 'timeout'
      job.updatedAt = now
      if (job.cleanup) {
        void job.cleanup()
      }
    }

    return job
  }

  private purgeExpired(now: number): void {
    for (const [id, job] of this.jobs.entries()) {
      if (now - job.createdAt > this.ttlMs) {
        if (job.cleanup) {
          void job.cleanup()
        }
        this.jobs.delete(id)
      }
    }
  }

  reset(): void {
    for (const job of this.jobs.values()) {
      if (job.cleanup) {
        void job.cleanup()
      }
    }
    this.jobs.clear()
  }
}

export const SKIN_GENERATE_SYSTEM_PROMPT = `You are a Minecraft skin pixel artist.
You must generate skin pixel data in STRICT JSON format matching this schema:
{
  "palette": ["#rrggbb", ... up to 16 hex colors],
  "parts": {
    "head": {
      "front": [8 rows of 8 chars],
      "back": [8 rows of 8 chars],
      "top": [8 rows of 8 chars],
      "bottom": [8 rows of 8 chars],
      "left": [8 rows of 8 chars],
      "right": [8 rows of 8 chars]
    },
    "body": {
      "front": [12 rows of 8 chars],
      "back": [12 rows of 8 chars]
    },
    "arm": [12 rows of 4 chars],
    "leg": [12 rows of 4 chars]
  },
  "notes": "optional brief description"
}
Rules:
1. Each character in a row is a palette index ('0'-'9', 'a'-'f') referring to an index in "palette", or '.' for transparent.
2. Dimensions must be exact: head faces are 8x8, body front/back are 8x12, arm is 4x12, leg is 4x12.
3. Palette must have at most 16 colors.
4. Output STRICT JSON ONLY. No markdown, no commentary outside JSON.`

export function buildUserPrompt(prompt: string, part: SkinPart = 'all'): string {
  if (part === 'all') {
    return `Create a complete Minecraft skin for: ${prompt}`
  }
  return `Create the ${part} for a Minecraft skin based on: ${prompt}. Only provide the ${part} in the parts object.`
}

export function extractJsonFromLlmResponse(raw: string): unknown {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new SkinGenerateError('No JSON object found in LLM response.', 502)
  }
  const jsonSubstring = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(jsonSubstring)
  } catch (err) {
    throw new SkinGenerateError(`Malformed JSON: ${(err as Error).message}`, 502)
  }
}

export const BLOCK_PROMPT_TEMPLATE =
  'You are a Minecraft skin creator. The attached image [B] is a LAYOUT AND STYLE REFERENCE: copy its exact framing, camera angle (front panel about 24 degree yaw, 30 degree downward tilt, near-orthographic), blocky cuboid body, pixel granularity and shading style, but NOT its character. Character to create: <CHAR>. Hold nothing in the hands (no weapon). OUTPUT exactly ONE image: pure white background, two panels side by side, left = FRONT view, right = BACK view, same character in both. Minecraft default standing pose, arms straight down, legs parallel, feet on same baseline, full body visible, no text, no watermark. True pixel art, hard square pixel blocks, no anti-aliasing, no blur, no gradients, max 2-3 tones per material, hair as blocky masses.'

export function buildBlockFlowPrompt(userPrompt: string): string {
  // eslint-disable-next-line no-control-regex
  const sanitized = userPrompt.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 300)
  return BLOCK_PROMPT_TEMPLATE.replace('<CHAR>', sanitized)
}

export interface SkinGenerateOptions {
  privacyOf?: (request: Request) => Promise<Privacy>
  rateLimiter?: GenerateRateLimiter
  jobManager?: SkinJobManager
  libraryStore?: SkinLibraryStore
  fetchFn?: typeof fetch
  timeoutMs?: number
  baseUrl?: string
  apiKey?: string
  model?: string
  provider?: SkinProvider
  flowUrl?: string
  flowOutputDir?: string
  flowPollIntervalMs?: number
  blockUrl?: string
  blockOutputDir?: string
  blockPollIntervalMs?: number
  blockRefLayoutPath?: string
}

export async function archiveGeneratedJob(job: SkinJob, libraryStore?: SkinLibraryStore): Promise<void> {
  if (!job.png || !libraryStore) return
  try {
    const bytes = Buffer.from(job.png, 'base64')
    await libraryStore.archive({
      bytes,
      source: 'generated',
      prompt: job.prompt,
      agentId: job.agent,
    })
  } catch (error) {
    console.error('Skin library auto-archive failed:', error)
  }
}

function sanitizeMessage(msg: string, secret?: string): string {
  if (!secret) return msg
  return msg.split(secret).join('[REDACTED]')
}

export async function callChatCompletion(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  prompt: string,
  part: SkinPart,
  timeoutMs: number,
): Promise<string> {
  const cleanUrl = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: SKIN_GENERATE_SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(prompt, part) },
    ],
    temperature: 0.5,
  }

  let response: globalThis.Response
  try {
    response = await fetchFn(cleanUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err: unknown) {
    const error = err as Error
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new SkinGenerateError('Gateway timeout: LLM generation timed out.', 504)
    }
    throw new SkinGenerateError(sanitizeMessage(`LLM network error: ${error.message}`, apiKey), 502)
  }

  if (!response.ok) {
    throw new SkinGenerateError(`LLM returned status ${response.status}.`, 502)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new SkinGenerateError('Empty content from LLM completion.', 502)
  }

  return content
}

export async function generateSkin(
  prompt: string,
  part: SkinPart = 'all',
  baseDecoded: { width: number; height: number; data: Buffer } | null = null,
  options: SkinGenerateOptions = {},
): Promise<{ png: string; notes?: string }> {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const baseUrl = options.baseUrl ?? (process.env.RUANG_LLM_BASE_URL || 'http://127.0.0.1:20128/v1')
  const apiKey = options.apiKey ?? process.env.RUANG_LLM_API_KEY
  const model = options.model ?? (process.env.RUANG_LLM_MODEL || 'ag/gemini-3.8-flash-medium')
  const timeoutMs = options.timeoutMs ?? (process.env.RUANG_LLM_TIMEOUT_MS ? Number(process.env.RUANG_LLM_TIMEOUT_MS) : 90_000)

  let lastError: Error | null = null

  // 1 retry allowed on unusable output (2 attempts total)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const content = await callChatCompletion(fetchFn, baseUrl, apiKey, model, prompt, part, timeoutMs)
      const json = extractJsonFromLlmResponse(content)
      const pngBuffer = composeSkinFromJson(json, part, baseDecoded)
      const notes = typeof (json as { notes?: unknown })?.notes === 'string'
        ? (json as { notes: string }).notes
        : undefined

      return {
        png: pngBuffer.toString('base64'),
        notes,
      }
    } catch (err: unknown) {
      if (err instanceof SkinGenerateError && err.status === 504) {
        throw err // Timeout does not retry
      }
      lastError = err as Error
      if (attempt === 1) {
        continue // retry once
      }
    }
  }

  const message = lastError instanceof ComposeError || lastError instanceof SkinGenerateError
    ? lastError.message
    : 'LLM output unusable.'
  throw new SkinGenerateError(sanitizeMessage(message, apiKey), 502)
}

async function runFlowPoller(
  job: SkinJob,
  flowJobsUrl: string,
  flowJobId: string,
  outputDir: string,
  baseDecoded: { width: number; height: number; data: Buffer } | null,
  fetchFn: typeof fetch,
  pollIntervalMs = 200,
  libraryStore?: SkinLibraryStore,
): Promise<void> {
  const pollUrl = `${flowJobsUrl}/${flowJobId}`
  const startTime = Date.now()
  const timeoutMs = 5 * 60 * 1000 // 5 minutes max wait

  try {
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() - startTime > timeoutMs) {
        job.status = 'error'
        job.error = 'timeout'
        break
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs))

      let pollRes: globalThis.Response
      try {
        pollRes = await fetchFn(pollUrl, {
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        job.status = 'error'
        job.error = 'flow offline'
        break
      }

      if (pollRes.status === 404 || pollRes.status === 503 || !pollRes.ok) {
        job.status = 'error'
        job.error = 'flow offline'
        break
      }

      const flowData = (await pollRes.json()) as {
        status?: string
        file?: string
        error?: string
      }

      if (flowData.status === 'queued' || flowData.status === 'running') {
        job.status = flowData.status
        continue
      }

      if (flowData.status === 'error') {
        job.status = 'error'
        job.error = flowData.error || 'unusable output'
        break
      }

      if (flowData.status === 'done') {
        if (!flowData.file || typeof flowData.file !== 'string') {
          if (job.cleanup) {
            await job.cleanup()
            job.cleanup = undefined
          }
          job.status = 'error'
          job.error = 'unusable output'
          break
        }

        try {
          const realFile = await fs.promises.realpath(flowData.file)
          await fs.promises.mkdir(outputDir, { recursive: true })
          const realOutputDir = await fs.promises.realpath(outputDir)
          if (!realFile.startsWith(realOutputDir + path.sep) && realFile !== realOutputDir) {
            if (job.cleanup) {
              await job.cleanup()
              job.cleanup = undefined
            }
            job.status = 'error'
            job.error = 'unusable output'
            break
          }

          const st = await fs.promises.stat(realFile)
          if (st.size > 20 * 1024 * 1024) {
            if (job.cleanup) {
              await job.cleanup()
              job.cleanup = undefined
            }
            job.status = 'error'
            job.error = 'unusable output'
            break
          }

          const rawBytes = await fs.promises.readFile(realFile)
          const processedPng = processFlowSkinImage(rawBytes, job.part, baseDecoded)
          if (job.cleanup) {
            await job.cleanup()
            job.cleanup = undefined
          }
          job.png = processedPng.toString('base64')
          job.status = 'done'
          await archiveGeneratedJob(job, libraryStore)
        } catch {
          if (job.cleanup) {
            await job.cleanup()
            job.cleanup = undefined
          }
          job.status = 'error'
          job.error = 'unusable output'
        }
        break
      }

      job.status = 'error'
      job.error = 'unusable output'
      break
    }
  } finally {
    if (job.cleanup) {
      await job.cleanup()
      job.cleanup = undefined
    }
  }
}

async function runBlockPoller(
  job: SkinJob,
  flowJobsUrl: string,
  flowJobId: string,
  flowOutputDir: string,
  blockUrl: string,
  blockOutputDir: string,
  baseDecoded: { width: number; height: number; data: Buffer } | null,
  fetchFn: typeof fetch,
  flowPollIntervalMs = 200,
  blockPollIntervalMs = 200,
  libraryStore?: SkinLibraryStore,
): Promise<void> {
  const doCleanup = async () => {
    if (job.cleanup) {
      const fn = job.cleanup
      job.cleanup = undefined
      await fn()
    }
  }
  const fail = async (error: string) => {
    await doCleanup()
    job.status = 'error'
    job.error = error
  }

  const flowPollUrl = `${flowJobsUrl}/${flowJobId}`
  const blockJobsUrl = `${blockUrl.replace(/\/+$/, '')}/jobs`
  const startTime = Date.now()
  const totalTimeoutMs = 8 * 60 * 1000

  try {
    let flowOutputFile: string | null = null

    // Stage 1: Polling Flow for preview
    job.stage = 'preview'
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() - startTime > totalTimeoutMs) {
        await fail('timeout')
        return
      }

      await new Promise((r) => setTimeout(r, flowPollIntervalMs))

      let pollRes: globalThis.Response
      try {
        pollRes = await fetchFn(flowPollUrl, {
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        await fail('flow offline')
        return
      }

      if (pollRes.status === 404 || pollRes.status === 503 || !pollRes.ok) {
        await fail('flow offline')
        return
      }

      const flowData = (await pollRes.json()) as {
        status?: string
        file?: string
        error?: string
      }

      if (flowData.status === 'queued' || flowData.status === 'running') {
        job.status = flowData.status
        continue
      }

      if (flowData.status === 'error') {
        await fail(flowData.error || 'unusable output')
        return
      }

      if (flowData.status === 'done') {
        if (!flowData.file || typeof flowData.file !== 'string') {
          await fail('unusable output')
          return
        }

        try {
          const realFile = await fs.promises.realpath(flowData.file)
          await fs.promises.mkdir(flowOutputDir, { recursive: true })
          const realOutputDir = await fs.promises.realpath(flowOutputDir)
          if (!realFile.startsWith(realOutputDir + path.sep) && realFile !== realOutputDir) {
            await fail('unusable output')
            return
          }

          const st = await fs.promises.stat(realFile)
          if (st.size > 20 * 1024 * 1024) {
            await fail('unusable output')
            return
          }

          flowOutputFile = realFile
        } catch {
          await fail('unusable output')
          return
        }
        break
      }

      await fail('unusable output')
      return
    }

    if (!flowOutputFile || (job.status !== 'queued' && job.status !== 'running')) {
      await doCleanup()
      return
    }

    // Stage 2: POST to BLOCK service
    job.stage = 'convert'
    let blockPostRes: globalThis.Response
    try {
      blockPostRes = await fetchFn(blockJobsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview_path: flowOutputFile }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      await fail('block offline')
      return
    }

    if (!blockPostRes.ok) {
      await fail('block offline')
      return
    }

    let blockJobId: string
    try {
      const blockData = (await blockPostRes.json()) as { jobId?: string }
      if (!blockData.jobId) {
        throw new Error('missing jobId')
      }
      blockJobId = blockData.jobId
    } catch {
      await fail('block offline')
      return
    }

    // Stage 3: Polling BLOCK service
    const blockPollUrl = `${blockJobsUrl}/${blockJobId}`
    while (job.status === 'queued' || job.status === 'running') {
      if (Date.now() - startTime > totalTimeoutMs) {
        await fail('timeout')
        return
      }

      await new Promise((r) => setTimeout(r, blockPollIntervalMs))

      let blockPollRes: globalThis.Response
      try {
        blockPollRes = await fetchFn(blockPollUrl, {
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        await fail('block offline')
        return
      }

      if (blockPollRes.status === 404 || blockPollRes.status === 503 || !blockPollRes.ok) {
        await fail('block offline')
        return
      }

      const blockData = (await blockPollRes.json()) as {
        status?: string
        file?: string
        error?: string
      }

      if (blockData.status === 'queued' || blockData.status === 'running') {
        job.status = blockData.status
        continue
      }

      if (blockData.status === 'error') {
        await fail(blockData.error || 'unusable output')
        return
      }

      if (blockData.status === 'done') {
        if (!blockData.file || typeof blockData.file !== 'string') {
          await fail('unusable output')
          return
        }

        try {
          const realFile = await fs.promises.realpath(blockData.file)
          await fs.promises.mkdir(blockOutputDir, { recursive: true })
          const realBlockOutputDir = await fs.promises.realpath(blockOutputDir)
          if (!realFile.startsWith(realBlockOutputDir + path.sep) && realFile !== realBlockOutputDir) {
            await fail('unusable output')
            return
          }

          const st = await fs.promises.stat(realFile)
          if (st.size > 20 * 1024 * 1024) {
            await fail('unusable output')
            return
          }

          const rawBytes = await fs.promises.readFile(realFile)
          const processedPng = processBlockSkinImage(rawBytes, job.part, baseDecoded)
          await doCleanup()
          job.png = processedPng.toString('base64')
          job.status = 'done'
          await archiveGeneratedJob(job, libraryStore)
        } catch {
          await fail('unusable output')
        }
        return
      }

      await fail('unusable output')
      return
    }
  } finally {
    await doCleanup()
  }
}

export function createSkinGenerateRouter(options: SkinGenerateOptions = {}): Router {
  const router = Router()
  const limiter = options.rateLimiter ?? new GenerateRateLimiter()
  const jobManager = options.jobManager ?? new SkinJobManager()

  // JSON body parser with 64 KiB limit
  router.use(express.json({ limit: '64kb' }))

  // Catch body parser errors (e.g. 413 Payload Too Large)
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err && typeof err === 'object' && 'status' in err && (err as { status: unknown }).status === 413) {
      res.status(413).json({ error: 'Payload too large.' })
      return
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: unknown }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON payload.' })
      return
    }
    next(err)
  })

  // POST /api/skins/generate -> 202 {jobId}
  router.post('/', async (request: Request, response: Response): Promise<void> => {
    try {
    // 1. Origin header check
    if (!matchOriginHost(request.headers.origin, request.headers.host)) {
      response.status(403).json({ error: 'Forbidden.' })
      return
    }

    // 2. Profile lock check if agent is specified
    const agent = typeof request.body?.agent === 'string'
      ? request.body.agent
      : (typeof request.query?.agent === 'string' ? request.query.agent : undefined)

    if (agent && options.privacyOf) {
      try {
        const privacy = await options.privacyOf(request)
        if (isHidden(privacy, agent)) {
          response.status(423).json({
            error: `🔒 ${agent} is locked. Enter the PIN to see it.`,
            locked: 'profile',
            agent,
          })
          return
        }
      } catch {
        response.status(500).json({ error: 'Privacy check failed.' })
        return
      }
    }

    // 3. Validate prompt (1..300 characters)
    const prompt = request.body?.prompt
    if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 300) {
      response.status(400).json({ error: 'Prompt must be between 1 and 300 characters.' })
      return
    }

    // 4. Validate part
    const partRaw = request.body?.part ?? 'all'
    const validParts: SkinPart[] = ['all', 'head', 'body', 'arms', 'legs']
    if (!validParts.includes(partRaw as SkinPart)) {
      response.status(400).json({ error: 'Invalid part. Must be one of: all, head, body, arms, legs.' })
      return
    }
    const part = partRaw as SkinPart

    // 5. Validate base PNG if provided
    let baseDecoded: { width: number; height: number; data: Buffer } | null = null
    if (request.body?.base !== undefined) {
      const baseStr = request.body.base
      if (typeof baseStr !== 'string' || baseStr.trim().length === 0) {
        response.status(400).json({ error: 'Invalid base PNG.' })
        return
      }

      let baseBuffer: Buffer
      try {
        baseBuffer = Buffer.from(baseStr, 'base64')
      } catch {
        response.status(400).json({ error: 'Invalid base PNG.' })
        return
      }

      if (baseBuffer.length === 0 || baseBuffer.length > MAX_SKIN_BYTES) {
        response.status(400).json({ error: 'Invalid base PNG.' })
        return
      }

      try {
        baseDecoded = decodePng(baseBuffer)
      } catch {
        response.status(400).json({ error: 'Invalid base PNG.' })
        return
      }
    }

    // 6. Rate limiter check (max 6 requests / minute)
    const clientIp = request.ip || request.socket.remoteAddress || '127.0.0.1'
    try {
      limiter.check(clientIp)
    } catch (err: unknown) {
      if (err instanceof SkinGenerateError) {
        response.status(err.status).json({ error: err.message })
        return
      }
      throw err
    }

    // 7. Check if another job is already active server-wide
    const active = jobManager.getActiveJob()
    if (active) {
      response.status(409).json({ error: 'busy' })
      return
    }

    const provider: SkinProvider = resolveSkinProvider(process.env.RUANG_SKIN_PROVIDER, options.provider)
    const fetchFn = options.fetchFn ?? globalThis.fetch

    if (provider === 'llm') {
      const job = jobManager.createJob('llm', prompt, part, undefined, agent)
      job.status = 'running'
      job.promise = (async () => {
        try {
          const result = await generateSkin(prompt, part, baseDecoded, options)
          job.png = result.png
          job.notes = result.notes
          job.status = 'done'
          await archiveGeneratedJob(job, options.libraryStore)
        } catch (err: unknown) {
          job.status = 'error'
          if (err instanceof SkinGenerateError) {
            job.error = err.message
          } else {
            job.error = 'LLM output unusable.'
          }
        }
      })()

      response.status(202).json({ jobId: job.id })
      return
    }

    if (provider === 'flow') {
      // Flow provider
      const flowUrl = options.flowUrl ?? (process.env.RUANG_FLOW_URL || 'http://127.0.0.1:8092')
      const flowCleanUrl = `${flowUrl.replace(/\/+$/, '')}/jobs`
      const defaultFlowOutputDir = path.join(os.homedir(), '.hermes/cache/ruang-skins-flow')
      const flowOutputDir = options.flowOutputDir ?? (process.env.RUANG_FLOW_OUTPUT_DIR || defaultFlowOutputDir)

      let tmpDir: string
      try {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ruang-flow-ref-'))
        await fs.promises.chmod(tmpDir, 0o700)
      } catch {
        response.status(503).json({ error: 'flow offline' })
        return
      }

      const refPaths: string[] = []
      try {
        const templatePng = createTemplatePng()
        const templatePath = path.join(tmpDir, 'template.png')
        await fs.promises.writeFile(templatePath, templatePng)
        refPaths.push(templatePath)

        if (baseDecoded && part !== 'all') {
          const baseUpscaled = upscale64To1024Png(baseDecoded.data)
          const basePath = path.join(tmpDir, 'base.png')
          await fs.promises.writeFile(basePath, baseUpscaled)
          refPaths.push(basePath)
        }
      } catch {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        response.status(503).json({ error: 'flow offline' })
        return
      }

      const flowPrompt = buildFlowPrompt(prompt)
      let flowPostRes: globalThis.Response
      try {
        flowPostRes = await fetchFn(flowCleanUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: flowPrompt, reference_paths: refPaths }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        response.status(503).json({ error: 'flow offline' })
        return
      }

      if (flowPostRes.status === 429) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        response.status(429).json({ error: 'daily cap' })
        return
      }

      if (flowPostRes.status === 400) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        response.status(502).json({ error: 'flow rejected request' })
        return
      }

      if (flowPostRes.status === 503 || !flowPostRes.ok) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        response.status(503).json({ error: 'flow offline' })
        return
      }

      let flowJobId: string
      try {
        const flowData = (await flowPostRes.json()) as { jobId?: string }
        if (!flowData.jobId) {
          throw new Error('missing jobId')
        }
        flowJobId = flowData.jobId
      } catch {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
        response.status(503).json({ error: 'flow offline' })
        return
      }

      const job = jobManager.createJob('flow', prompt, part, undefined, agent)
      job.status = 'running'
      job.cleanup = async () => {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }

      void runFlowPoller(
        job,
        flowCleanUrl,
        flowJobId,
        flowOutputDir,
        baseDecoded,
        fetchFn,
        options.flowPollIntervalMs ?? 200,
        options.libraryStore,
      )

      response.status(202).json({ jobId: job.id })
      return
    }

    // Block provider (Flow preview -> BLOCK converter)
    const job = jobManager.createJob('block', prompt, part, 'preview', agent)
    job.status = 'running'

    const blockUrl = options.blockUrl ?? (process.env.RUANG_BLOCK_URL || 'http://127.0.0.1:8093')
    const blockHealthUrl = `${blockUrl.replace(/\/+$/, '')}/health`

    let healthRes: globalThis.Response
    try {
      healthRes = await fetchFn(blockHealthUrl, {
        signal: AbortSignal.timeout(2000),
      })
    } catch {
      job.status = 'error'
      job.error = 'block offline'
      job.updatedAt = Date.now()
      response.status(503).json({ error: 'block offline' })
      return
    }

    if (!healthRes.ok) {
      job.status = 'error'
      job.error = 'block offline'
      job.updatedAt = Date.now()
      response.status(503).json({ error: 'block offline' })
      return
    }

    try {
      const healthData = (await healthRes.json()) as { ok?: boolean }
      if (healthData.ok !== true) {
        job.status = 'error'
        job.error = 'block offline'
        job.updatedAt = Date.now()
        response.status(503).json({ error: 'block offline' })
        return
      }
    } catch {
      job.status = 'error'
      job.error = 'block offline'
      job.updatedAt = Date.now()
      response.status(503).json({ error: 'block offline' })
      return
    }

    const flowUrl = options.flowUrl ?? (process.env.RUANG_FLOW_URL || 'http://127.0.0.1:8092')
    const flowCleanUrl = `${flowUrl.replace(/\/+$/, '')}/jobs`
    const defaultFlowOutputDir = path.join(os.homedir(), '.hermes/cache/ruang-skins-flow')
    const flowOutputDir = options.flowOutputDir ?? (process.env.RUANG_FLOW_OUTPUT_DIR || defaultFlowOutputDir)
    const defaultBlockRefLayout = path.join(os.homedir(), 'block-skin', 'ref_layout.png')
    const blockRefLayoutPath =
      options.blockRefLayoutPath ?? (process.env.RUANG_BLOCK_REF_LAYOUT || defaultBlockRefLayout)

    try {
      await fs.promises.access(blockRefLayoutPath, fs.constants.R_OK)
      const st = await fs.promises.stat(blockRefLayoutPath)
      if (!st.isFile()) {
        throw new Error('not a file')
      }
    } catch {
      job.status = 'error'
      job.error = 'block ref layout missing or unreadable'
      job.updatedAt = Date.now()
      response.status(500).json({ error: 'block ref layout missing or unreadable' })
      return
    }

    let tmpDir: string
    let copiedRefPath: string
    try {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ruang-flow-ref-'))
      await fs.promises.chmod(tmpDir, 0o700)
      copiedRefPath = path.join(tmpDir, path.basename(blockRefLayoutPath) || 'ref_layout.png')
      await fs.promises.copyFile(blockRefLayoutPath, copiedRefPath)
    } catch {
      if (tmpDir!) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
      job.status = 'error'
      job.error = 'block ref layout missing or unreadable'
      job.updatedAt = Date.now()
      response.status(500).json({ error: 'block ref layout missing or unreadable' })
      return
    }

    job.cleanup = async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }

    const failJob = async (status: number, error: string) => {
      if (job.cleanup) {
        await job.cleanup()
        job.cleanup = undefined
      }
      job.status = 'error'
      job.error = error
      job.updatedAt = Date.now()
      response.status(status).json({ error })
    }

    const blockFlowPrompt = buildBlockFlowPrompt(prompt)

    let flowPostRes: globalThis.Response
    try {
      flowPostRes = await fetchFn(flowCleanUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: blockFlowPrompt,
          reference_paths: [copiedRefPath],
          model: 'nano-banana-pro',
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      await failJob(503, 'flow offline')
      return
    }

    if (flowPostRes.status === 429) {
      await failJob(429, 'daily cap')
      return
    }

    if (flowPostRes.status === 400) {
      await failJob(502, 'flow rejected request')
      return
    }

    if (flowPostRes.status === 503 || !flowPostRes.ok) {
      await failJob(503, 'flow offline')
      return
    }

    let flowJobId: string
    try {
      const flowData = (await flowPostRes.json()) as { jobId?: string }
      if (!flowData.jobId) {
        throw new Error('missing jobId')
      }
      flowJobId = flowData.jobId
    } catch {
      await failJob(503, 'flow offline')
      return
    }

    const defaultBlockOutputDir = path.join(os.homedir(), '.hermes/cache/ruang-skins-block')
    const blockOutputDir = options.blockOutputDir ?? (process.env.RUANG_BLOCK_OUTPUT_DIR || defaultBlockOutputDir)

    job.promise = runBlockPoller(
      job,
      flowCleanUrl,
      flowJobId,
      flowOutputDir,
      blockUrl,
      blockOutputDir,
      baseDecoded,
      fetchFn,
      options.flowPollIntervalMs ?? 200,
      options.blockPollIntervalMs ?? 200,
      options.libraryStore,
    )

    response.status(202).json({ jobId: job.id })
    } catch (err: unknown) {
      if (err instanceof SkinGenerateError) {
        response.status(err.status).json({ error: err.message })
        return
      }
      throw err
    }
  })

  // GET /api/skins/generate/:jobId -> 200 {status, png?, error?, notes?}; 404
  router.get('/:jobId', async (request: Request, response: Response): Promise<void> => {
    const rawJobId = request.params.jobId
    const jobId = Array.isArray(rawJobId) ? rawJobId[0] : rawJobId
    if (!jobId) {
      response.status(404).json({ error: 'Job not found.' })
      return
    }
    const job = jobManager.getJob(jobId)

    if (!job) {
      response.status(404).json({ error: 'Job not found.' })
      return
    }

    // LLM provider returns immediately with { status: 'running' } while job is in progress

    if (job.status === 'done') {
      response.status(200).json({
        status: 'done',
        png: job.png,
        ...(job.notes ? { notes: job.notes } : {}),
      })
      return
    }

    if (job.status === 'error') {
      response.status(200).json({
        status: 'error',
        error: job.error ?? 'unusable output',
      })
      return
    }

    response.status(200).json({
      status: job.status,
      ...(job.stage ? { stage: job.stage } : {}),
    })
  })

  // Reject unsupported methods on /generate
  router.all('/', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed.' })
  })

  // Error handling middleware: SkinGenerateError must never surface as 500
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (err instanceof SkinGenerateError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    next(err)
  })

  return router
}

export function installSkinGenerate(app: Express, options: SkinGenerateOptions = {}): Router {
  const router = createSkinGenerateRouter(options)
  app.use('/api/skins/generate', router)
  return router
}
