import { defineTool } from '@deepseek-ai/dsh-tools'

/** Wire name sent in tool-call chunks. Card title is {@link LOOK_AT_TOOL_TITLE}. */
export const LOOK_AT_TOOL_NAME = 'look_at_image'

/** Conversation card label, same role as a Curl command line. */
export const LOOK_AT_TOOL_TITLE = '识图'

export interface LookAtImageArg {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export function lookAtArgFromImage(image: {
  readonly attachment: {
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }
}): LookAtImageArg {
  const { attachment } = image
  return {
    attachmentId: String(attachment.attachmentId),
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    ...(attachment.name === undefined || attachment.name.length === 0 ? {} : { name: attachment.name }),
  }
}

export type CaptionImages = (
  images: readonly LookAtImageArg[],
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, string>>

function imageName(image: LookAtImageArg): string {
  return image.name === undefined || image.name.length === 0 ? 'image' : image.name
}

function formatCaptions(images: readonly LookAtImageArg[], captions: ReadonlyMap<string, string>): string {
  return images.map((image) => {
    const text = captions.get(image.attachmentId) ?? ''
    return `[Image: ${imageName(image)}]\n${text}`
  }).join('\n')
}

function lookAtTitle(images: readonly LookAtImageArg[]): string {
  const names = images.map(imageName).join(', ')
  return names.length === 0 ? LOOK_AT_TOOL_TITLE : `${LOOK_AT_TOOL_TITLE} ${names}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function imagesOf(args: unknown): LookAtImageArg[] {
  const record = asRecord(args)
  const raw = record === undefined ? undefined : record.images
  if (!Array.isArray(raw)) return []
  const images: LookAtImageArg[] = []
  for (const item of raw) {
    const image = asRecord(item)
    if (image === undefined) continue
    if (typeof image.attachmentId !== 'string' || typeof image.mediaType !== 'string') continue
    if (typeof image.bytes !== 'number' || typeof image.width !== 'number' || typeof image.height !== 'number') continue
    images.push({
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      ...(typeof image.name === 'string' ? { name: image.name } : {}),
    })
  }
  return images
}

/** Host-injected 识图 tool: captions pasted images; the text model must not call it. */
export function defineLookAtImageTool(captionImages: CaptionImages) {
  return defineTool({
    name: LOOK_AT_TOOL_NAME,
    description: [
      'Caption user-attached images for a text-only model.',
      'The host calls this automatically when the user pastes images.',
      'Do not call this tool yourself.',
    ].join(' '),
    parameters: {
      images: {
        type: 'array',
        required: true,
        description: 'Images to caption.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            attachmentId: {
              type: 'string',
              required: true,
              description: 'Attachment id of the image.',
            },
            mediaType: {
              type: 'string',
              required: true,
              description: 'MIME type of the image.',
            },
            bytes: {
              type: 'integer',
              required: true,
              description: 'Encoded byte length of the stored image.',
            },
            width: {
              type: 'integer',
              required: true,
              description: 'Intrinsic width in pixels.',
            },
            height: {
              type: 'integer',
              required: true,
              description: 'Intrinsic height in pixels.',
            },
            name: {
              type: 'string',
              description: 'Original filename, when known.',
            },
          },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const images = imagesOf(args)
      const captions = await captionImages(images, exec.signal)
      return formatCaptions(images, captions)
    },
    presentCall(args) {
      const images = imagesOf(args)
      return {
        card: 'generic',
        title: lookAtTitle(images),
        kind: 'fetch',
        rawInput: images.map(imageName).join(', '),
      }
    },
    presentResult(args) {
      return {
        card: 'generic',
        title: lookAtTitle(imagesOf(args)),
      }
    },
  })
}
