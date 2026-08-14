import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type { VisionBridgeSnapshot, VisionSaveRequest, VisionTestResult } from '../vision-types.ts'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './VisionSettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface VisionSettingsTabInjected {
  snapshot: () => Promise<VisionBridgeSnapshot>
  save: (request: VisionSaveRequest) => Promise<void>
  testConnection: (request: {
    baseURL: string
    model: string
    apiKey?: string
  }) => Promise<VisionTestResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type VisionSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.vision'>
  & InjectFace<VisionSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: VisionBridgeSnapshot }

function targetKey(provider: string, model: string): string {
  return `${provider}\0${model}`
}

function enabledMap(snapshot: VisionBridgeSnapshot): Record<string, boolean> {
  const next: Record<string, boolean> = {}
  for (const target of snapshot.targets) {
    next[targetKey(target.provider, target.model)] = target.enabled
  }
  return next
}

/** Render the vision endpoint form and per-model wrap toggles. */
export function VisionSettingsTab({
  snapshot,
  save,
  testConnection,
  t,
}: VisionSettingsTabProps): ReactNode {
  const formId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [baseURL, setBaseURL] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [hasApiKey, setHasApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<VisionTestResult | { kind: 'ok'; message: string } | null>(null)

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => snapshot()).then(
      (value) => {
        if (!current) return
        setState({ status: 'ready', snapshot: value })
        setBaseURL(value.vision.baseURL)
        setModel(value.vision.model)
        setApiKey('')
        setHasApiKey(value.vision.hasApiKey)
        setEnabled(enabledMap(value))
      },
      () => {
        if (!current) return
        setState({ status: 'error' })
      },
    )
    return () => {
      current = false
    }
  }, [snapshot, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setNotice(null)
    setRequest(value => value + 1)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (state.status !== 'ready') return
    setSaving(true)
    setNotice(null)
    try {
      const targets = state.snapshot.catalog.flatMap(group => group.models.map(entry => ({
        provider: group.provider,
        model: entry.id,
        enabled: !entry.nativeVision && enabled[targetKey(group.provider, entry.id)] === true,
      })))
      const vision = {
        baseURL: baseURL.trim(),
        model: model.trim(),
        ...(apiKey.length === 0 ? {} : { apiKey }),
      }
      await save({ vision, targets })
      setApiKey('')
      setNotice({ kind: 'ok', message: t('saved') })
      setRequest(value => value + 1)
    } catch {
      setNotice({ kind: 'error', message: t('saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setNotice(null)
    try {
      const result = await testConnection({
        baseURL: baseURL.trim(),
        model: model.trim(),
        ...(apiKey.length === 0 ? {} : { apiKey }),
      })
      setNotice(result)
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : t('saveFailed'),
      })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || saving || testing}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <form className={css.form} onSubmit={(event) => { void submit(event) }}>
          <div className={css.catalogHeading}>
            <h3>{t('endpoint')}</h3>
          </div>
          <p className={css.hint}>{t('endpointHint')}</p>
          <div className={css.field}>
            <label htmlFor={`${formId}-baseURL`}>{t('baseURL')}</label>
            <Input
              id={`${formId}-baseURL`}
              value={baseURL}
              placeholder="https://api.siliconflow.cn/v1"
              onChange={(event) => {
                setBaseURL(event.currentTarget.value)
              }}
            />
          </div>
          <div className={css.field}>
            <label htmlFor={`${formId}-model`}>{t('model')}</label>
            <Input
              id={`${formId}-model`}
              value={model}
              placeholder="Qwen/Qwen3-VL-32B-Instruct"
              onChange={(event) => {
                setModel(event.currentTarget.value)
              }}
            />
          </div>
          <div className={css.field}>
            <label htmlFor={`${formId}-apiKey`}>{t('apiKey')}</label>
            <input
              id={`${formId}-apiKey`}
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.currentTarget.value)
              }}
            />
            <p className={css.hint}>{hasApiKey ? t('apiKeySet') : t('apiKeyMissing')} {t('apiKeyHint')}</p>
          </div>
          <div className={css.catalogHeading}>
            <h3>{t('targets')}</h3>
          </div>
          <p className={css.hint}>{t('targetsHint')}</p>
          {state.snapshot.catalog.length === 0 ? <p className={css.status}>{t('emptyCatalog')}</p> : null}
          {state.snapshot.catalog.length > 0 ? (
            <ul className={css.groups}>
              {state.snapshot.catalog.map((group) => (
                <li key={group.provider} className={css.card}>
                  <div className={css.cardHeader}>
                    <strong className={css.cardTitle}>{group.providerName}</strong>
                    <span className={css.providerId}>{group.provider}</span>
                  </div>
                  <div className={css.models}>
                    {group.models.map((entry) => {
                      const key = targetKey(group.provider, entry.id)
                      return (
                        <label key={entry.id} className={css.check}>
                          <input
                            type="checkbox"
                            disabled={entry.nativeVision}
                            checked={entry.nativeVision || enabled[key] === true}
                            onChange={(event) => {
                              const checked = event.currentTarget.checked
                              setEnabled(current => ({ ...current, [key]: checked }))
                            }}
                          />
                          <span className={css.checkLabel}>{entry.name}</span>
                          <span className={css.configTag}>
                            {entry.nativeVision ? t('nativeTag') : t('wrapTag')}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {notice !== null ? (
            <p className={css.notice} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : undefined}>
              {notice.message}
            </p>
          ) : null}
          <div className={css.actions}>
            <Button variant="primary" size="sm" disabled={saving} type="submit">
              {saving ? t('saving') : t('save')}
            </Button>
            <Button
              size="sm"
              disabled={testing || saving}
              type="button"
              onClick={() => { void test() }}
            >
              {testing ? t('testing') : t('test')}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  )
}
