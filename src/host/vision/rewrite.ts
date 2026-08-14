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

function formatCaption(block: Extract<ContentBlock, { type: 'image' }>, caption: string): string {
  const name = block.attachment.name
  const label = name === undefined || name.length === 0 ? 'image' : name
  return `[Image: ${label}]\n${caption}`
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
