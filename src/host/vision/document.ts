/** On-disk Settings document for the Vision Bridge. */

export const VISION_BRIDGE_DOCUMENT_VERSION = 1
export const VISION_BRIDGE_DOCUMENT_FILENAME = 'vision-bridge.json'

export interface VisionEndpointRecord {
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
}

export interface VisionTargetRecord {
  readonly provider: string
  readonly model: string
  readonly enabled: boolean
}

export interface VisionBridgeDocument {
  readonly version: 1
  readonly vision: VisionEndpointRecord
  readonly targets: readonly VisionTargetRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`vision-bridge: unexpected ${label} key ${JSON.stringify(key)}`)
    }
  }
}

function parseString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`vision-bridge: ${label} must be a string`)
  }
  return value
}

/** Return an empty Settings document. */
export function emptyVisionBridgeDocument(): VisionBridgeDocument {
  return {
    version: 1,
    vision: { baseURL: '', apiKey: '', model: '' },
    targets: [],
  }
}

function parseVision(value: unknown): VisionEndpointRecord {
  if (!isRecord(value)) throw new Error('vision-bridge: document.vision must be an object')
  assertKnownKeys(value, ['baseURL', 'apiKey', 'model'], 'vision')
  return {
    baseURL: parseString(value.baseURL, 'vision.baseURL').trim(),
    apiKey: parseString(value.apiKey, 'vision.apiKey'),
    model: parseString(value.model, 'vision.model').trim(),
  }
}

function parseTarget(value: unknown, index: number): VisionTargetRecord {
  const label = `targets[${String(index)}]`
  if (!isRecord(value)) throw new Error(`vision-bridge: ${label} must be an object`)
  assertKnownKeys(value, ['provider', 'model', 'enabled'], label)
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`vision-bridge: ${label}.enabled must be a boolean`)
  }
  const provider = parseString(value.provider, `${label}.provider`).trim()
  const model = parseString(value.model, `${label}.model`).trim()
  if (provider.length === 0) throw new Error(`vision-bridge: ${label}.provider must be non-empty`)
  if (model.length === 0) throw new Error(`vision-bridge: ${label}.model must be non-empty`)
  return { provider, model, enabled: value.enabled }
}

/** Parse and validate a Settings document body. */
export function parseVisionBridgeDocument(text: string): VisionBridgeDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error('vision-bridge: document is not valid JSON', { cause })
  }
  if (!isRecord(parsed)) throw new Error('vision-bridge: document must be a JSON object')
  assertKnownKeys(parsed, ['version', 'vision', 'targets'], 'document')
  if (parsed.version !== 1) {
    throw new Error(`vision-bridge: unsupported document version ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.targets)) throw new Error('vision-bridge: document.targets must be an array')
  const vision = parsed.vision === undefined ? emptyVisionBridgeDocument().vision : parseVision(parsed.vision)
  const targets = parsed.targets.map((entry, index) => parseTarget(entry, index))
  return { version: 1, vision, targets: dedupeTargets(targets) }
}

function targetKey(provider: string, model: string): string {
  return `${provider}\0${model}`
}

function dedupeTargets(targets: readonly VisionTargetRecord[]): VisionTargetRecord[] {
  const seen = new Map<string, VisionTargetRecord>()
  for (const target of targets) seen.set(targetKey(target.provider, target.model), target)
  return [...seen.values()]
}

/** Serialize a Settings document as stable JSON. */
export function serializeVisionBridgeDocument(document: VisionBridgeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

export function visionEndpointReady(vision: VisionEndpointRecord): boolean {
  return vision.baseURL.length > 0 && vision.model.length > 0 && vision.apiKey.trim().length > 0
}

export function isTargetEnabled(
  targets: readonly VisionTargetRecord[],
  provider: string,
  model: string,
): boolean {
  return targets.some(target => target.provider === provider && target.model === model && target.enabled)
}

export function mergeVision(
  current: VisionEndpointRecord,
  next: { readonly baseURL: string; readonly model: string; readonly apiKey?: string },
): VisionEndpointRecord {
  const apiKey = next.apiKey === undefined || next.apiKey.length === 0 ? current.apiKey : next.apiKey
  return {
    baseURL: next.baseURL.trim(),
    model: next.model.trim(),
    apiKey,
  }
}
