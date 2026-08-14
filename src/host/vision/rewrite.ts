import { contentHasImage, freezeMessage, type ContentBlock, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'

/** True when any message (including nested tool results) carries an image block. */
export function messagesHaveImage(messages: readonly Message[]): boolean {
  return messages.some(message => contentHasImage(message.content))
}

function collectImageBlocks(content: readonly ContentBlock[], into: Extract<ContentBlock, { type: 'image' }>[]): void {
  for (const block of content) {
    switch (block.type) {
      case 'image':
        into.push(block)
        break
      case 'tool-result':
        collectImageBlocks(block.content, into)
        break
      case 'text':
      case 'reasoning':
      case 'tool-call':
        break
      default: {
        const _exhaustive: never = block
        void _exhaustive
      }
    }
  }
}

/** Every image block in the request, including images nested in tool results. */
export function collectRequestImages(messages: readonly Message[]): Extract<ContentBlock, { type: 'image' }>[] {
  const images: Extract<ContentBlock, { type: 'image' }>[] = []
  for (const message of messages) collectImageBlocks(message.content, images)
  return images
}

/** Unique images in request order (attachment id). */
export function uniqueRequestImages(messages: readonly Message[]): Extract<ContentBlock, { type: 'image' }>[] {
  const unique: Extract<ContentBlock, { type: 'image' }>[] = []
  const seen = new Set<string>()
  for (const image of collectRequestImages(messages)) {
    const id = String(image.attachment.attachmentId)
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(image)
  }
  return unique
}

function isToolResultMessage(message: Message): boolean {
  return message.content.some(block => block.type === 'tool-result')
}

/** True when this turn already issued a look-at-image tool call (success or error). */
export function hasLookAtToolSinceLastUser(messages: readonly Message[], toolName: string): boolean {
  let from = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'user' && !isToolResultMessage(message)) from = index + 1
  }
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (message.content.some(block => block.type === 'tool-call' && block.name === toolName)) return true
  }
  return false
}

/** True when every image in the request already has a cached caption. */
export function allImagesCaptioned(
  messages: readonly Message[],
  captions: ReadonlyMap<string, string>,
): boolean {
  return uniqueRequestImages(messages).every(image => captions.has(String(image.attachment.attachmentId)))
}

/** Drop the host-injected look-at tool so the text model never calls it. */
export function stripLookAtTool(options: GenerateOptions, toolName: string): GenerateOptions {
  const tools = options.tools
  if (tools === undefined) return options
  const next = tools.filter(tool => {
    if (typeof tool !== 'object' || tool === null || !('name' in tool)) return true
    return tool.name !== toolName
  })
  if (next.length === tools.length) return options
  return next.length === 0 ? { ...options, tools: undefined } : { ...options, tools: next }
}

/** Prefix of the old look-at-image reasoning block; used to find poisoned history. */
export const LOOK_AT_PREFIX = '查看图片'

/** Filename shown in the look-at-image reasoning row and the rewritten `[Image:]` block. */
export function imageLabel(block: Extract<ContentBlock, { type: 'image' }>): string {
  const name = block.attachment.name
  return name === undefined || name.length === 0 ? 'image' : name
}

function formatCaption(block: Extract<ContentBlock, { type: 'image' }>, caption: string): string {
  return `[Image: ${imageLabel(block)}]\n${caption}`
}

function replaceImagesInContent(
  content: readonly ContentBlock[],
  captions: ReadonlyMap<string, string>,
): ContentBlock[] {
  const next: ContentBlock[] = []
  for (const block of content) {
    switch (block.type) {
      case 'image': {
        const caption = captions.get(String(block.attachment.attachmentId))
        if (caption === undefined) {
          throw new Error(`vision-bridge: missing caption for ${String(block.attachment.attachmentId)}`)
        }
        next.push({ type: 'text', text: formatCaption(block, caption) })
        break
      }
      case 'tool-result':
        next.push({ ...block, content: replaceImagesInContent(block.content, captions) })
        break
      case 'text':
      case 'reasoning':
      case 'tool-call':
        next.push(block)
        break
      default: {
        const _exhaustive: never = block
        void _exhaustive
      }
    }
  }
  return next
}

/** Copy the request with every image block replaced by caption text. */
export function rewriteOptions(
  options: GenerateOptions,
  captions: ReadonlyMap<string, string>,
): GenerateOptions {
  const messages = options.messages.map(message => freezeMessage({
    ...message,
    content: replaceImagesInContent(message.content, captions),
  }))
  return { ...options, messages }
}

type ModelSource = {
  readonly kind: 'model'
  readonly provider: string
  readonly model: string
  readonly replayState?: unknown
}

function modelSourceOf(message: Message): ModelSource | undefined {
  const source = message.source
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  if (record.kind !== 'model') return undefined
  if (typeof record.provider !== 'string' || typeof record.model !== 'string') return undefined
  return {
    kind: 'model',
    provider: record.provider,
    model: record.model,
    ...(record.replayState === undefined ? {} : { replayState: record.replayState }),
  }
}

function hasLookAtReasoning(message: Message): boolean {
  if (message.role !== 'assistant') return false
  return message.content.some(block => (
    block.type === 'reasoning' && block.text.startsWith(LOOK_AT_PREFIX)
  ))
}

/**
 * Drop adapter replay metadata on assistant turns that include look-at-image
 * reasoning. Injecting that block changes the assistant content list, so pi-ai
 * replay would fail with INVALID_REPLAY_STATE.
 */
export function dropLookAtReplayState(options: GenerateOptions): GenerateOptions {
  let changed = false
  const messages = options.messages.map(message => {
    if (!hasLookAtReasoning(message)) return message
    const source = modelSourceOf(message)
    if (source === undefined || source.replayState === undefined) return message
    changed = true
    return freezeMessage({
      ...message,
      source: {
        kind: 'model' as const,
        provider: source.provider,
        model: source.model,
      },
    })
  })
  return changed ? { ...options, messages } : options
}
