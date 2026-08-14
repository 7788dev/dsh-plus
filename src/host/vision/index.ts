import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { CallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { captionImage, testVisionConnection, type VisionClientConfig } from './caption.ts'
import { decorateRemoteMethods } from './native-decorate.ts'
import {
  emptyVisionBridgeDocument,
  isTargetEnabled,
  mergeVision,
  parseVisionBridgeDocument,
  serializeVisionBridgeDocument,
  visionEndpointReady,
  type VisionBridgeDocument,
  type VisionTargetRecord,
} from './document.ts'
import { defineLookAtImageTool, lookAtArgFromImage, LOOK_AT_TOOL_NAME, type LookAtImageArg } from './look-at-tool.ts'
import {
  allImagesCaptioned,
  dropLookAtReplayState,
  hasLookAtToolSinceLastUser,
  messagesHaveImage,
  rewriteOptions,
  stripLookAtTool,
  uniqueRequestImages,
} from './rewrite.ts'
import type {
  VisionBridgeMutationResult,
  VisionBridgeSnapshot,
  VisionCatalogGroup,
  VisionSaveRequest,
  VisionTestRequest,
  VisionTestResult,
} from '../../vision-types.ts'

type ResolveModelInfo = (
  provider: string,
  model: string,
  signal?: AbortSignal,
) => Promise<LlmResolvedModelInfo>

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function hasSection(
  value: unknown,
): value is { section: (input: { name: string; order: number; text: string }) => void } {
  if (typeof value !== 'object' || value === null) return false
  if (!('section' in value)) return false
  return typeof value.section === 'function'
}

/**
 * Host Remote that stores the Vision Bridge document, claims image input for
 * opted-in text models, and captions images before those models see the turn.
 */
export class VisionBridgeGateway extends TypertRemoteService {
  static inject = ['llm', 'attachments', 'tools']
  static Config = z.object({ path: z.string().required() })

  private filename: string
  private document: VisionBridgeDocument = emptyVisionBridgeDocument()
  private chain: Promise<void> = Promise.resolve()
  private readonly captions = new Map<string, string>()
  private originalResolve: ResolveModelInfo | undefined

  constructor(ctx: ConstructorParameters<typeof TypertRemoteService>[0], config: { path: string }) {
    super(ctx, 'visionBridge')
    this.filename = resolve(config.path)
    runRemoteInitializers(this)
  }

  async [Service.init](): Promise<void> {
    this.document = await this.readDocument()
    this.installCapabilityClaim()
    this.installLookAtTool()
    this.ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      return this.onStream(options, next)
    })
    const systemPrompt = this.ctx.get('systemPrompt')
    if (hasSection(systemPrompt)) {
      systemPrompt.section({
        name: 'vision-bridge',
        order: 80,
        text: [
          'Images in this conversation appear as [Image: filename] text blocks after the 识图 (look_at_image) tool runs.',
          'Those blocks are already complete descriptions; treat them as what the user attached.',
          'Do not call look_at_image yourself. Do not announce that you are reviewing images, and do not restate the [Image] blocks.',
          'Answer the user\'s question directly. Your thinking stays in the normal reasoning channel.',
        ].join(' '),
      })
    }
  }

  private installLookAtTool(): void {
    this.ctx.effect(
      () => this.ctx.tools.register(defineLookAtImageTool((images, signal) => this.captionRefs(images, signal))),
      'vision-bridge: look_at_image tool',
    )
    this.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === LOOK_AT_TOOL_NAME) return { kind: 'allow' }
      return next()
    })
  }

  private installCapabilityClaim(): void {
    const llm = this.ctx.llm
    const original = llm.resolveModelInfo.bind(llm)
    this.originalResolve = original
    const patched: ResolveModelInfo = async (provider, model, signal) => {
      const info = await original(provider, model, signal)
      if (!this.shouldClaim(provider, model)) return info
      if (info.inputModalities !== undefined && info.inputModalities.includes('image')) return info
      const modalities = new Set(info.inputModalities ?? ['text'])
      modalities.add('text')
      modalities.add('image')
      return { ...info, inputModalities: [...modalities] }
    }
    llm.resolveModelInfo = patched
    this.ctx.effect(() => () => {
      if (llm.resolveModelInfo === patched) llm.resolveModelInfo = original
    }, 'vision-bridge: restore resolveModelInfo')
  }

  private shouldClaim(provider: string, model: string): boolean {
    return visionEndpointReady(this.document.vision)
      && isTargetEnabled(this.document.targets, provider, model)
  }

  private async isNativeVision(provider: string, model: string, signal?: AbortSignal): Promise<boolean> {
    const resolve = this.originalResolve ?? this.ctx.llm.resolveModelInfo.bind(this.ctx.llm)
    try {
      const info = await resolve(provider, model, signal)
      return info.inputModalities !== undefined && info.inputModalities.includes('image')
    } catch {
      return false
    }
  }

  private async shouldWrap(options: GenerateOptions): Promise<boolean> {
    if (!this.shouldClaim(options.provider, options.model)) return false
    if (!messagesHaveImage(options.messages)) return false
    if (await this.isNativeVision(options.provider, options.model, options.signal)) return false
    return true
  }

  private async *onStream(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const sanitized = dropLookAtReplayState(options)
    if (!(await this.shouldWrap(sanitized))) {
      if (sanitized === options) {
        yield* next()
        return
      }
      yield* this.ctx.llm.stream(sanitized)
      return
    }
    if (sanitized.purpose === 'compaction' || sanitized.purpose === 'session-title') {
      yield* this.ctx.llm.stream(await this.captionAndRewrite(sanitized))
      return
    }
    const alreadyCalled = hasLookAtToolSinceLastUser(sanitized.messages, LOOK_AT_TOOL_NAME)
    const cached = allImagesCaptioned(sanitized.messages, this.captions)
    if (!alreadyCalled && !cached) {
      yield* this.emitLookAtCall(sanitized)
      return
    }
    if (!cached) {
      const text = '识图超时或失败，请再发一次图片。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield* this.ctx.llm.stream(stripLookAtTool(await this.captionAndRewrite(sanitized), LOOK_AT_TOOL_NAME))
  }

  private async *emitLookAtCall(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const images = uniqueRequestImages(options.messages).map(lookAtArgFromImage)
    const args = JSON.stringify({ images })
    const id = CallId(randomUUID())
    const index = 0
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: LOOK_AT_TOOL_NAME, argumentsDelta: args }
    yield {
      type: 'block-end',
      index,
      block: { type: 'tool-call', id, name: LOOK_AT_TOOL_NAME, arguments: args },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }

  private visionConfig(): VisionClientConfig {
    const vision = this.document.vision
    if (!visionEndpointReady(vision)) {
      throw new Error('vision-bridge: configure a vision model before sending images')
    }
    return vision
  }

  /** Caption each unique image; reuse cache entries when present. */
  private async captionRefs(
    images: readonly LookAtImageArg[],
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const captions = new Map<string, string>()
    const config = this.visionConfig()
    await Promise.all(images.map(async (image) => {
      const id = String(image.attachmentId)
      const cached = this.captions.get(id)
      if (cached !== undefined) {
        captions.set(id, cached)
        return
      }
      const stored = await this.ctx.attachments.readImage({
        attachmentId: id,
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        ...(image.name === undefined ? {} : { name: image.name }),
      }, signal)
      const caption = await captionImage(config, {
        attachmentId: id,
        mediaType: stored.ref.mediaType,
        ...(image.name === undefined ? {} : { name: image.name }),
        data: stored.data,
      }, signal)
      const trimmed = caption.trim()
      if (trimmed.length === 0) throw new Error('vision-bridge: vision model returned empty content')
      this.captions.set(id, trimmed)
      captions.set(id, trimmed)
    }))
    return captions
  }

  private async captionAndRewrite(options: GenerateOptions): Promise<GenerateOptions> {
    const images = uniqueRequestImages(options.messages).map(lookAtArgFromImage)
    const captions = await this.captionRefs(images, options.signal)
    return rewriteOptions(options, captions)
  }

  snapshot(): Promise<VisionBridgeSnapshot> {
    return this.enqueue(async () => this.projectSnapshot())
  }

  save(request: VisionSaveRequest): Promise<VisionBridgeMutationResult> {
    return this.enqueue(async () => {
      const vision = request.vision === undefined
        ? this.document.vision
        : mergeVision(this.document.vision, request.vision)
      const targets = request.targets === undefined
        ? this.document.targets
        : normalizeTargets(request.targets)
      this.document = { version: 1, vision, targets }
      await this.persist()
      return { ok: true }
    })
  }

  testConnection(request: VisionTestRequest): Promise<VisionTestResult> {
    return this.enqueue(async () => {
      const apiKey = request.apiKey === undefined || request.apiKey.length === 0
        ? this.document.vision.apiKey
        : request.apiKey
      const config = {
        baseURL: request.baseURL.trim(),
        model: request.model.trim(),
        apiKey,
      }
      if (!visionEndpointReady(config)) {
        return { kind: 'error', message: 'Base URL, model, and API key are required.' }
      }
      return testVisionConnection(config)
    })
  }

  private async projectSnapshot(): Promise<VisionBridgeSnapshot> {
    return {
      vision: {
        baseURL: this.document.vision.baseURL,
        model: this.document.vision.model,
        hasApiKey: this.document.vision.apiKey.trim().length > 0,
      },
      targets: this.document.targets.map(target => ({
        provider: target.provider,
        model: target.model,
        enabled: target.enabled,
      })),
      catalog: await this.listCatalog(),
    }
  }

  private async listCatalog(): Promise<VisionCatalogGroup[]> {
    const groups: VisionCatalogGroup[] = []
    for (const provider of this.ctx.llm.listProviders()) {
      try {
        const models = await this.ctx.llm.listModels(provider.id)
        groups.push({
          provider: provider.id,
          providerName: provider.name,
          models: models.map(model => ({
            id: model.id,
            name: model.name,
            nativeVision: model.inputModalities !== undefined && model.inputModalities.includes('image'),
          })),
        })
      } catch (error) {
        this.ctx.logger.warn(`vision-bridge: failed to list models for ${provider.id}: ${String(error)}`)
      }
    }
    return groups
  }

  private async readDocument(): Promise<VisionBridgeDocument> {
    try {
      const text = await readFile(this.filename, 'utf8')
      return parseVisionBridgeDocument(text)
    } catch (error) {
      if (isEnoent(error)) return emptyVisionBridgeDocument()
      throw error
    }
  }

  private async persist(): Promise<void> {
    await writeFileAtomic(this.filename, serializeVisionBridgeDocument(this.document))
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }
}

function normalizeTargets(targets: readonly { provider: string; model: string; enabled: boolean }[]): VisionTargetRecord[] {
  const seen = new Map<string, VisionTargetRecord>()
  for (const target of targets) {
    const provider = target.provider.trim()
    const model = target.model.trim()
    if (provider.length === 0 || model.length === 0) continue
    seen.set(`${provider}\0${model}`, { provider, model, enabled: target.enabled })
  }
  return [...seen.values()]
}

const runRemoteInitializers = decorateRemoteMethods(VisionBridgeGateway, {
  snapshot: 'snapshot',
  save: 'save',
  testConnection: 'testConnection',
})

export default VisionBridgeGateway
