import express, { type Express, type NextFunction, type Request, type Response, Router } from 'express'
import { isHidden, type Privacy } from './profile-lock.js'
import {
  ComposeError,
  composeSkinFromJson,
  decodePng,
  type SkinPart,
} from './skin-compose.js'
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
      throw new SkinGenerateError('Rate limit exceeded: maximum 6 generate calls per minute.', 429)
    }
    timestamps.push(now)
    this.requests.set(ip, timestamps)
  }

  reset(): void {
    this.requests.clear()
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
  fetchFn?: typeof fetch
  timeoutMs?: number
  baseUrl?: string
  apiKey?: string
  model?: string
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

export function createSkinGenerateRouter(options: SkinGenerateOptions = {}): Router {
  const router = Router()
  const limiter = options.rateLimiter ?? new GenerateRateLimiter()

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

    // 3. Validate prompt
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

    // 7. Generate skin
    try {
      const result = await generateSkin(prompt, part, baseDecoded, options)
      response.status(200).json(result)
    } catch (err: unknown) {
      if (err instanceof SkinGenerateError) {
        response.status(err.status).json({ error: err.message })
        return
      }
      response.status(502).json({ error: 'LLM output unusable.' })
    }
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
