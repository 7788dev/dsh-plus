/* Hand-written Typert Remote for the Vision Bridge Host service. */
import { z } from 'zod'

const snapshotResult = z.object({
  vision: z.object({
    baseURL: z.string().readonly(),
    model: z.string().readonly(),
    hasApiKey: z.boolean().readonly(),
  }).readonly(),
  targets: z.array(z.object({
    provider: z.string().readonly(),
    model: z.string().readonly(),
    enabled: z.boolean().readonly(),
  })).readonly(),
  catalog: z.array(z.object({
    provider: z.string().readonly(),
    providerName: z.string().readonly(),
    models: z.array(z.object({
      id: z.string().readonly(),
      name: z.string().readonly(),
      nativeVision: z.boolean().readonly(),
    })).readonly(),
  })).readonly(),
})

const saveParameter = z.object({
  vision: z.object({
    baseURL: z.string().readonly(),
    model: z.string().readonly(),
    apiKey: z.string().readonly().optional(),
  }).readonly().optional(),
  targets: z.array(z.object({
    provider: z.string().readonly(),
    model: z.string().readonly(),
    enabled: z.boolean().readonly(),
  })).readonly().optional(),
})

const saveResult = z.object({
  ok: z.literal(true).readonly(),
})

const testParameter = z.object({
  baseURL: z.string().readonly(),
  model: z.string().readonly(),
  apiKey: z.string().readonly().optional(),
})

const testResult = z.union([
  z.object({
    kind: z.literal('ok').readonly(),
    message: z.string().readonly(),
  }),
  z.object({
    kind: z.literal('error').readonly(),
    message: z.string().readonly(),
  }),
])

export const TYPERT_REMOTE = {
  package: 'dsh-plus',
  descriptors: [
    {
      id: 'dsh-plus#visionBridge/snapshot',
      service: 'visionBridge',
      namespace: 'visionBridge',
      method: 'snapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-plus/vision-types#VisionBridgeSnapshot',
        schema: snapshotResult,
      },
      sourceLocation: { file: 'src/host/vision/index.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-plus#visionBridge/save',
      service: 'visionBridge',
      namespace: 'visionBridge',
      method: 'save',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-plus/vision-types#VisionSaveRequest',
            schema: saveParameter,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-plus/vision-types#VisionBridgeMutationResult',
        schema: saveResult,
      },
      sourceLocation: { file: 'src/host/vision/index.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-plus#visionBridge/testConnection',
      service: 'visionBridge',
      namespace: 'visionBridge',
      method: 'testConnection',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: 'dsh-plus/vision-types#VisionTestRequest',
            schema: testParameter,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-plus/vision-types#VisionTestResult',
        schema: testResult,
      },
      sourceLocation: { file: 'src/host/vision/index.ts', line: 1, column: 1 },
    },
  ],
}

export default TYPERT_REMOTE
