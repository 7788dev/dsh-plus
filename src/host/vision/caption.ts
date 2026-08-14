/** OpenAI-compatible vision captioning against a configured VL endpoint. */

const TEST_TIMEOUT_MS = 30_000
const CAPTION_TIMEOUT_MS = 180_000

const CAPTION_PROMPT = [
  'Describe this image for a text-only assistant.',
  'Cover the scene, layout, and transcribe visible text exactly.',
  'Be concise. Do not mention that you are a vision model. Do not ask follow-up questions.',
].join(' ')

export interface VisionClientConfig {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
}

export interface VisionImageBytes {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
  readonly data: Uint8Array
}

function joinEndpoint(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/u, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function errorMessageFromBody(value: unknown, fallback: string): string {
  const record = asRecord(value)
  if (record === undefined) return fallback
  const error = asRecord(record.error)
  if (error !== undefined && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  if (typeof record.message === 'string' && record.message.length > 0) return record.message
  return fallback
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (record === undefined) continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}

function captionMessages(image: VisionImageBytes): unknown {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: CAPTION_PROMPT },
        {
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${bytesToBase64(image.data)}` },
        },
      ],
    },
  ]
}

function textFromCompletion(value: unknown): string {
  const record = asRecord(value)
  const choices = record === undefined ? undefined : record.choices
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  if (first === undefined) return ''
  const message = asRecord(first.message)
  if (message === undefined) return ''
  const content = textFromContent(message.content)
  if (content.length > 0) return content
  if (typeof message.reasoning_content === 'string') return message.reasoning_content
  return ''
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function bytesToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64')
}

async function authorizedJson(input: {
  readonly config: VisionClientConfig
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly body?: unknown
  readonly signal?: AbortSignal
}): Promise<{ readonly status: number; readonly value: unknown }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.config.apiKey.trim()}`,
  }
  if (input.body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(joinEndpoint(input.config.baseURL, input.path), {
    method: input.method,
    headers,
    signal: combineSignal(input.signal, TEST_TIMEOUT_MS),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  })
  const value = await readJson(response)
  return { status: response.status, value }
}

/** Probe the vision endpoint with GET /models. */
export async function testVisionConnection(
  config: VisionClientConfig,
  signal?: AbortSignal,
): Promise<{ readonly kind: 'ok'; readonly message: string } | { readonly kind: 'error'; readonly message: string }> {
  try {
    const { status, value } = await authorizedJson({
      config,
      path: '/models',
      method: 'GET',
      signal,
    })
    if (status < 200 || status >= 300) {
      return { kind: 'error', message: errorMessageFromBody(value, `HTTP ${String(status)}`) }
    }
    const record = asRecord(value)
    const data = record === undefined ? undefined : record.data
    const count = Array.isArray(data) ? data.length : undefined
    const suffix = count === undefined ? '' : ` (${String(count)} models)`
    return { kind: 'ok', message: `Connected${suffix}.` }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Caption one image with a non-streaming chat completion.
 * Streaming is unused here: the 识图 tool only shows the finished result.
 */
export async function captionImage(
  config: VisionClientConfig,
  image: VisionImageBytes,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(joinEndpoint(config.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    signal: combineSignal(signal, CAPTION_TIMEOUT_MS),
    body: JSON.stringify({
      model: config.model,
      stream: false,
      messages: captionMessages(image),
    }),
  })
  const value = await readJson(response)
  if (!response.ok) {
    throw new Error(`vision-bridge: vision model failed: ${errorMessageFromBody(value, `HTTP ${String(response.status)}`)}`)
  }
  const text = textFromCompletion(value).trim()
  if (text.length === 0) throw new Error('vision-bridge: vision model returned empty content')
  return text
}
