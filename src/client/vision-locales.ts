/** Copy dictionaries for the Vision Bridge Settings section. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  tab: '视觉',
  loading: '正在读取视觉设置…',
  error: '暂时无法读取视觉设置。',
  retry: '重试',
  endpoint: '视觉模型',
  endpointHint: 'OpenAI 兼容的多模态接口。密钥只保存在本机，页面不会回显。',
  baseURL: 'Base URL',
  model: '模型 ID',
  apiKey: 'API Key',
  apiKeyHint: '已保存密钥时留空表示保持不变。',
  apiKeySet: '已保存密钥',
  apiKeyMissing: '尚未保存密钥',
  test: '测试连接',
  testing: '正在测试…',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存。',
  saveFailed: '保存失败。',
  targets: '为以下模型开启外挂视觉',
  targetsHint: '开启后，聊天里的图片会先交给上面的视觉模型识别，再把描述交给该文本模型。已自带视觉的模型不会走外挂。',
  emptyCatalog: '当前没有可配置的模型渠道。',
  nativeTag: '原生视觉',
  wrapTag: '外挂',
  expand: '展开',
  collapse: '收起',
  modelCountUnit: '个模型',
} satisfies Record<string, string>

/** Vision settings locale key union. */
export type VisionSettingsLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  tab: 'Vision',
  loading: 'Reading vision settings…',
  error: 'Vision settings are temporarily unavailable.',
  retry: 'Retry',
  endpoint: 'Vision model',
  endpointHint: 'An OpenAI-compatible multimodal endpoint. The key stays on this machine and is never shown.',
  baseURL: 'Base URL',
  model: 'Model ID',
  apiKey: 'API key',
  apiKeyHint: 'Leave blank to keep the stored key.',
  apiKeySet: 'Key saved',
  apiKeyMissing: 'No key saved',
  test: 'Test connection',
  testing: 'Testing…',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  saveFailed: 'Save failed.',
  targets: 'Enable wrapped vision for these models',
  targetsHint: 'When enabled, chat images are described by the vision model above, then the description is sent to this text model. Models that already accept images are not wrapped.',
  emptyCatalog: 'No model providers are available.',
  nativeTag: 'Native vision',
  wrapTag: 'Wrapped',
  expand: 'Expand',
  collapse: 'Collapse',
  modelCountUnit: 'models',
} satisfies Record<VisionSettingsLocaleKey, string>
