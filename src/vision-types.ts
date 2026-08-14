/**
 * Public request and view vocabulary for the Vision Bridge settings Remote.
 * Types only, so generated Remote clients can consume it without Host runtime.
 */

/** Vision endpoint as shown to a trusted client. The API key never leaves the Host. */
export interface VisionEndpointView {
  readonly baseURL: string
  readonly model: string
  readonly hasApiKey: boolean
}

/** One provider/model pair the user opted into wrapping. */
export interface VisionTargetView {
  readonly provider: string
  readonly model: string
  readonly enabled: boolean
}

/** One model in the live LLM catalog. */
export interface VisionCatalogModel {
  readonly id: string
  readonly name: string
  /** True when the adapter already declares image input; the wrap will not intercept it. */
  readonly nativeVision: boolean
}

/** One provider route and the models it currently advertises. */
export interface VisionCatalogGroup {
  readonly provider: string
  readonly providerName: string
  readonly models: readonly VisionCatalogModel[]
}

/** Point-in-time projection returned by `visionBridge/snapshot`. */
export interface VisionBridgeSnapshot {
  readonly vision: VisionEndpointView
  readonly targets: readonly VisionTargetView[]
  readonly catalog: readonly VisionCatalogGroup[]
}

/** Replacement vision endpoint. Omitted `apiKey` keeps the stored secret. */
export interface VisionEndpointSave {
  readonly baseURL: string
  readonly model: string
  readonly apiKey?: string
}

/** Replacement wrap flag for one provider/model pair. */
export interface VisionTargetSave {
  readonly provider: string
  readonly model: string
  readonly enabled: boolean
}

/** Create or replace vision endpoint and/or wrap targets. Omitted fields stay stored. */
export interface VisionSaveRequest {
  readonly vision?: VisionEndpointSave
  readonly targets?: readonly VisionTargetSave[]
}

/** Acknowledgement after a durable Settings mutation. */
export interface VisionBridgeMutationResult {
  readonly ok: true
}

/** Draft or stored endpoint used by `visionBridge/testConnection`. */
export interface VisionTestRequest {
  readonly baseURL: string
  readonly model: string
  /** When omitted, the Host uses the stored key. */
  readonly apiKey?: string
}

/** Outcome of probing the vision endpoint. */
export type VisionTestResult =
  | { readonly kind: 'ok'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
