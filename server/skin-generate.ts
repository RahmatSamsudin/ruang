/**
 * Skin Generate API (F2):
 *
 * Provider: env RUANG_SKIN_PROVIDER=flow|llm (default flow).
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
 *     503 { error: "flow offline" } (Flow service unreachable / 503)
 *
 * GET /api/skins/generate/:jobId
 *   Responses:
 *     200 { status: "queued" | "running" | "done" | "error", png?: string, error?: string, notes?: string }
 *     404 { error: "Job not found." } (unknown or expired > 10 min)
 *
 * Memory lifecycle:
 *   - Jobs kept in memory up to 10 min after creation then dropped.
 *   - Bounded map, max 50 entries, oldest evicted.
 *   - Max wait 5 min -> status becomes error "timeout".
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
import { buildFlowPrompt, processFlowSkinImage } from './skin-flow.js'
import { createTemplatePng, upscale64To1024Png } from './skin-template.js'
import { matchOriginHost, MAX_SKIN_BYTES } from './skins.js'

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
export type SkinProvider = 'flow' | 'llm'

export interface SkinJob {
  id: string
  status: SkinJobStatus
  createdAt: number
  updatedAt: number
  provider: SkinProvider
  prompt: string
  part: SkinPart
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

  getActiveJob(): SkinJob | undefined {
    const now = Date.now()
    this.purgeExpired(now)
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') {
        if (now - job.createdAt > this.timeoutMs) {
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

  createJob(provider: SkinProvider, prompt: string, part: SkinPart): SkinJob {
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
      prompt,
      part,
    }

    this.jobs.set(id, job)
    return job
  }

  getJob(id: string): SkinJob | undefined {
    const now = Date.now()
    this.purgeExpired(now)
    const job = this.jobs.get(id)
    if (!job) return undefined

    if ((job.status === 'queued' || job.status === 'running') && now - job.createdAt > this.timeoutMs) {
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

export interface SkinGenerateOptions {
  privacyOf?: (request: Request) => Promise<Privacy>
  rateLimiter?: GenerateRateLimiter
  jobManager?: SkinJobManager
  fetchFn?: typeof fetch
  timeoutMs?: number
  baseUrl?: string
  apiKey?: string
  model?: string
  provider?: SkinProvider
  flowUrl?: string
  flowOutputDir?: string
  flowPollIntervalMs?: number
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

    const provider: SkinProvider = options.provider ?? (process.env.RUANG_SKIN_PROVIDER === 'llm' ? 'llm' : 'flow')
    const fetchFn = options.fetchFn ?? globalThis.fetch

    if (provider === 'llm') {
      const job = jobManager.createJob('llm', prompt, part)
      job.status = 'running'
      job.promise = (async () => {
        try {
          const result = await generateSkin(prompt, part, baseDecoded, options)
          job.status = 'done'
          job.png = result.png
          job.notes = result.notes
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

    const job = jobManager.createJob('flow', prompt, part)
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
    )

    response.status(202).json({ jobId: job.id })
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

    // For LLM provider, wait for result so first GET completes
    if (job.provider === 'llm' && job.promise) {
      await job.promise
    }

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

    response.status(200).json({ status: job.status })
  })

  // Reject unsupported methods on /generate
  router.all('/', (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed.' })
  })

  return router
}

export function installSkinGenerate(app: Express, options: SkinGenerateOptions = {}): Router {
  const router = createSkinGenerateRouter(options)
  app.use('/api/skins/generate', router)
  return router
}
