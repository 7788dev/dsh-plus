/** Minimal ambient types for Host compilation without installing DSH packages. */

declare module '@deepseek-ai/cordis' {
  export const Service: {
    readonly init: unique symbol
    new (ctx: Context, key?: string): {
      readonly ctx: Context
    }
  }
  export class Context {
    llm: import('@deepseek-ai/dsh-llm').LlmRuntimeLike
    attachments: {
      readImage(
        ref: {
          attachmentId: string
          mediaType: string
          bytes: number
          width: number
          height: number
          name?: string
        },
        signal?: AbortSignal,
      ): Promise<{ ref: { mediaType: string }; data: Uint8Array }>
    }
    tools: {
      register(definition: unknown): () => void
    }
    logger: { warn(message: string): void }
    get(name: string): unknown
    on(event: 'llm/stream', listener: (
      options: import('@deepseek-ai/dsh-llm').GenerateOptions,
      next: () => AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
    ) => AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>): void
    on(event: 'tools/pre-execute', listener: (
      exec: { name: string },
      next: () => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>,
    ) => Promise<{ kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string }>): void
    effect(dispose: () => void | (() => void), name?: string): void
  }
}

declare module '@deepseek-ai/schemastery' {
  const z: {
    object: (shape: Record<string, unknown>) => {
      required(): unknown
    }
    string: () => { required(): unknown }
  }
  export default z
}

declare module '@deepseek-ai/dsh-atomic-write' {
  export function writeFileAtomic(path: string, data: string): Promise<void>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  export function Remote(method: string): (
  value: unknown,
  context: {
    kind: string
    name: string | symbol
    static: boolean
    private: boolean
    access: { has(obj: object): boolean; get(obj: object): unknown }
    addInitializer(fn: (this: object) => void): void
  },
) => unknown
  export class TypertRemoteService {
    constructor(ctx: import('@deepseek-ai/cordis').Context, key: string)
    readonly ctx: import('@deepseek-ai/cordis').Context
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export interface ContentBlockMap {
    text: { type: 'text'; text: string }
    reasoning: { type: 'reasoning'; text: string }
    image: {
      type: 'image'
      attachment: {
        attachmentId: string
        mediaType: string
        bytes: number
        width: number
        height: number
        name?: string
      }
    }
    'tool-call': { type: 'tool-call'; id: string; name: string; arguments: string }
    'tool-result': { type: 'tool-result'; toolCallId: string; content: ContentBlock[]; isError?: boolean }
  }
  export type ContentBlock = ContentBlockMap[keyof ContentBlockMap]
  export interface Message {
    readonly id: string
    readonly role: 'system' | 'user' | 'assistant'
    readonly content: ContentBlock[]
    readonly source: unknown
  }
  export interface GenerateOptions {
    provider: string
    model: string
    reasoningEffort?: string
    messages: Message[]
    system?: string
    tools?: { name: string; description?: string; parameters?: unknown }[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
    sessionId?: string
    purpose?: 'compaction' | 'session-title'
  }
  export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'image' | 'tool-call' | 'tool-result' }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'usage'; usage: unknown }
    | {
      type: 'finish'
      reason: {
        kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'
        failure?: { message: string; code: string }
      }
      replayState?: unknown
    }
  export interface LlmResolvedModelInfo {
    provider: string
    id: string
    name: string
    inputModalities?: readonly string[]
  }
  export interface LlmRuntimeLike {
    listProviders(): { id: string; name: string }[]
    listModels(provider: string): Promise<{ id: string; name: string; inputModalities?: readonly string[] }[]>
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }
  export function contentHasImage(content: readonly ContentBlock[]): boolean
  export function freezeMessage<T extends Message>(message: T): T
  export function CallId(id: string): string
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(options: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: unknown
      render: (args: unknown, value: unknown) => unknown[]
    }
    timeoutMs?: number
    isConcurrencySafe?: (args: unknown) => boolean
    execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown>
    presentCall?: (args: unknown) => unknown
    presentResult?: (args: unknown, result: unknown) => unknown
  }): unknown
}
