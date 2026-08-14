import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
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
import { collectRequestImages, messagesHaveImage, rewriteOptions } from './rewrite.ts'
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
  static inject = ['llm', 'attachments']
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
    this.ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      return this.onStream(options, next)
    })
    const systemPrompt = this.ctx.get('systemPrompt')
    if (hasSection(systemPrompt)) {
      systemPrompt.section({
        name: 'vision-bridge',
        order: 80,
        text: 'Images in this conversation may appear as [Image: …] text blocks. Those blocks are detailed descriptions produced by an auxiliary vision model; treat them as what the user attached.',
      })
    }
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
    if (!(await this.shouldWrap(options))) {
      yield* next()
      return
    }
    const rewritten = await this.captionAndRewrite(options)
    yield* this.ctx.llm.stream(rewritten)
  }

  private visionConfig(): VisionClientConfig {
    const vision = this.document.vision
    if (!visionEndpointReady(vision)) {
      throw new Error('vision-bridge: configure a vision model before sending images')
    }
    return vision
  }

  private async captionAndRewrite(options: GenerateOptions): Promise<GenerateOptions> {
    const images = collectRequestImages(options.messages)
    const captions = new Map<string, string>()
    const pending: typeof images = []
    const seen = new Set<string>()
    for (const image of images) {
      const id = String(image.attachment.attachmentId)
      if (seen.has(id)) continue
      seen.add(id)
      const cached = this.captions.get(id)
      if (cached !== undefined) captions.set(id, cached)
      else pending.push(image)
    }
    const config = this.visionConfig()
    for (const image of pending) {
      const stored = await this.ctx.attachments.readImage(image.attachment, options.signal)
      const caption = await captionImage(config, {
        attachmentId: String(image.attachment.attachmentId),
        mediaType: stored.ref.mediaType,
        ...(image.attachment.name === undefined ? {} : { name: image.attachment.name }),
        data: stored.data,
      }, options.signal)
      const id = String(image.attachment.attachmentId)
      this.captions.set(id, caption)
      captions.set(id, caption)
    }
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
