/** OpenAI-compatible vision captioning against a configured VL endpoint. */

const DEFAULT_TIMEOUT_MS = 60_000

const CAPTION_PROMPT = [
  'Describe this image thoroughly so a text-only assistant can understand it.',
  'Cover the scene, objects, people, layout, and any visible text (transcribe exactly).',
  'Do not mention that you are a vision model. Do not ask follow-up questions.',
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

function combineSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
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
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const record = asRecord(item)
    if (record === undefined) continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('').trim()
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
    signal: combineSignal(input.signal),
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

/** Caption one image; throws when the vision endpoint refuses or returns empty text. */
export async function captionImage(
  config: VisionClientConfig,
  image: VisionImageBytes,
  signal?: AbortSignal,
): Promise<string> {
  const dataUrl = `data:${image.mediaType};base64,${bytesToBase64(image.data)}`
  const { status, value } = await authorizedJson({
    config,
    path: '/chat/completions',
    method: 'POST',
    signal,
    body: {
      model: config.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: CAPTION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    },
  })
  if (status < 200 || status >= 300) {
    throw new Error(`vision-bridge: vision model failed: ${errorMessageFromBody(value, `HTTP ${String(status)}`)}`)
  }
  const record = asRecord(value)
  const choices = record === undefined ? undefined : record.choices
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  const message = first === undefined ? undefined : asRecord(first.message)
  const text = message === undefined ? '' : textFromContent(message.content)
  if (text.length === 0) throw new Error('vision-bridge: vision model returned empty content')
  return text
}
