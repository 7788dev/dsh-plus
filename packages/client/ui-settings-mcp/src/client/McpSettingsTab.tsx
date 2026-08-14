import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import type {
  McpServerUpsertRequest,
  McpServerView,
  McpSettingsSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button,
  IconPlusOutline16,
  IconTrashOutline16,
  Input,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpSettingsLocaleKey } from './locales.ts'
import css from './McpSettingsTab.module.css'

/** Registration-side Remote face used by the section. */
export interface McpSettingsTabInjected {
  /** Read the current MCP catalog. */
  list: () => Promise<McpSettingsSnapshot>
  /** Create or replace one Settings-owned server. */
  upsert: (request: McpServerUpsertRequest) => Promise<void>
  /** Delete one Settings-owned server. */
  remove: (serverName: string) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type McpSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpSettingsTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: McpSettingsSnapshot }

type Draft = {
  serverName: string
  enabled: boolean
  transport: 'stdio' | 'streamable-http'
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

const PHASE_KEYS = {
  pending: 'pending',
  loading: 'loadingPhase',
  active: 'active',
  failed: 'failed',
  unloading: 'unloading',
} satisfies Record<Exclude<McpServerView['fiberPhase'], null>, McpSettingsLocaleKey>

/** Host `list` interval while an enabled mcp-client fiber is still settling. */
const POLL_MS = 400

const SETTLING_PHASES = new Set<McpServerView['fiberPhase']>(['pending', 'loading', 'unloading'])

/** True while any enabled child fiber has not reached active or failed. */
function catalogIsSettling(snapshot: McpSettingsSnapshot): boolean {
  return snapshot.servers.some(server => server.enabled && SETTLING_PHASES.has(server.fiberPhase))
}

const EMPTY_DRAFT: Draft = {
  serverName: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
}

type Editor = null | 'create' | { readonly serverName: string }

/** Localized accessible label for one mcp-client fiber phase. */
function phaseLabel(phase: McpServerView['fiberPhase'], t: McpSettingsTabProps['t']): string {
  return phase === null ? t('unobserved') : t(PHASE_KEYS[phase])
}

/** Parse KEY=value lines; empty text means omit (keep stored map). */
function parseKv(text: string): Record<string, string> | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const row = line.trim()
    if (row.length === 0) continue
    const eq = row.indexOf('=')
    if (eq <= 0) throw new Error('invalid-kv')
    result[row.slice(0, eq)] = row.slice(eq + 1)
  }
  return result
}

/** Split argument lines, dropping blanks. */
function parseArgs(text: string): string[] {
  return text.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
}

function draftFrom(server: McpServerView): Draft {
  return {
    ...EMPTY_DRAFT,
    serverName: server.serverName,
    enabled: server.enabled,
    transport: server.transport,
    command: server.transport === 'stdio' ? server.command : '',
    argsText: server.transport === 'stdio' ? server.args.join('\n') : '',
    url: server.transport === 'streamable-http' ? server.url : '',
  }
}

function toUpsert(draft: Draft, previousName?: string): McpServerUpsertRequest {
  const env = parseKv(draft.envText)
  const headers = parseKv(draft.headersText)
  const serverName = draft.serverName.trim()
  const rename = previousName !== undefined && previousName !== serverName
    ? { fromServerName: previousName }
    : {}
  if (draft.transport === 'stdio') {
    return {
      transport: 'stdio',
      serverName,
      enabled: draft.enabled,
      command: draft.command.trim(),
      args: parseArgs(draft.argsText),
      ...rename,
      ...(env === undefined ? {} : { env }),
    }
  }
  return {
    transport: 'streamable-http',
    serverName,
    enabled: draft.enabled,
    url: draft.url.trim(),
    ...rename,
    ...(headers === undefined ? {} : { headers }),
  }
}

/** Render the MCP server catalog and Settings-owned editor. */
export function McpSettingsTab({ list, upsert, remove, t }: McpSettingsTabProps): ReactNode {
  const formId = useId()
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [editing, setEditing] = useState<Editor>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [formError, setFormError] = useState<McpSettingsLocaleKey | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let ready = false
    const pull = (): void => {
      void Promise.resolve().then(() => list()).then(
        (snapshot) => {
          if (!current) return
          ready = true
          setState({ status: 'ready', snapshot })
          if (catalogIsSettling(snapshot)) timer = setTimeout(pull, POLL_MS)
        },
        () => {
          if (!current) return
          if (ready) {
            timer = setTimeout(pull, POLL_MS)
            return
          }
          setState({ status: 'error' })
        },
      )
    }
    pull()
    return () => {
      current = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [list, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  const reload = (): void => {
    setEditing(null)
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setPendingDelete(null)
    setRequest(value => value + 1)
  }

  const closeDelete = (): void => {
    if (removing) return
    setPendingDelete(null)
    setFormError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    setFormError(null)
    setSaving(true)
    try {
      const previousName = editing !== null && editing !== 'create' ? editing.serverName : undefined
      await upsert(toUpsert(draft, previousName))
      reload()
    } catch (error) {
      setFormError(error instanceof Error && error.message === 'invalid-kv' ? 'invalidKv' : 'saveFailed')
    } finally {
      setSaving(false)
    }
  }

  const destroy = async (serverName: string): Promise<void> => {
    setFormError(null)
    setRemoving(true)
    try {
      await remove(serverName)
      reload()
    } catch {
      setFormError('removeFailed')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className={css.section} aria-busy={state.status === 'loading' || saving || removing}>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className={css.failure}>
          <p role="alert">{t('error')}</p>
          <button type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <div className={css.toolbar}>
            <div className={css.catalogHeading}>
              <h3>{t('catalog')}</h3>
              <span data-mcp-count={state.snapshot.servers.length}>{state.snapshot.servers.length}</span>
            </div>
            <Button
              variant="primary"
              size="sm"
              icon={<IconPlusOutline16 />}
              onClick={() => {
                setEditing('create')
                setDraft(EMPTY_DRAFT)
                setFormError(null)
              }}
            >
              {t('add')}
            </Button>
          </div>
          {state.snapshot.servers.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
          {state.snapshot.servers.length > 0 ? (
            <ul className={css.cards}>
              {state.snapshot.servers.map((server) => {
                const status = phaseLabel(server.fiberPhase, t)
                const running = server.fiberPhase === 'active'
                const toolCount = typeof server.toolCount === 'number' ? server.toolCount : 0
                const toolCountLabel = `${String(toolCount)} ${t('toolCountUnit')}`
                return (
                  <li
                    key={`${server.origin}:${server.serverName}`}
                    className={css.card}
                    data-mcp-server={server.serverName}
                    data-mcp-running={running ? 'true' : 'false'}
                  >
                    <div className={css.cardHeader}>
                      <strong className={css.cardTitle}>{server.serverName}</strong>
                      <span className={css.cardTrailing}>
                        {server.enabled ? (
                          <span
                            className={css.statusDot}
                            data-phase={server.fiberPhase ?? 'unobserved'}
                            role="img"
                            aria-label={status}
                            title={status}
                          />
                        ) : null}
                        <span className={css.configTag} data-running={running ? 'true' : 'false'}>
                          {server.enabled ? status : t('disabledTag')}
                        </span>
                        <span className={css.configTag} data-mcp-tool-count={toolCount}>
                          {toolCountLabel}
                        </span>
                        {server.origin === 'settings' ? (
                          <span className={css.headerActions}>
                            <Button
                              size="sm"
                              onClick={() => {
                                setEditing({ serverName: server.serverName })
                                setDraft(draftFrom(server))
                                setFormError(null)
                              }}
                            >
                              {t('edit')}
                            </Button>
                            <Button
                              size="sm"
                              icon={<IconTrashOutline16 />}
                              onClick={() => {
                                setPendingDelete(server.serverName)
                                setFormError(null)
                              }}
                            >
                              {t('remove')}
                            </Button>
                          </span>
                        ) : null}
                      </span>
                    </div>
                    {server.origin === 'composition' ? (
                      <div className={css.cardBody}>
                        <p className={css.hint}>{t('compositionHint')}</p>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {editing !== null ? (
            <form className={css.form} onSubmit={(event) => { void submit(event) }}>
              <h4>{editing === 'create' ? t('add') : t('edit')}</h4>
              <div className={css.field}>
                <label htmlFor={`${formId}-name`}>{t('serverName')}</label>
                <Input
                  id={`${formId}-name`}
                  value={draft.serverName}
                  required
                  maxLength={32}
                  pattern="[A-Za-z0-9_-]{1,32}"
                  onChange={(event) => {
                    const serverName = event.currentTarget.value
                    setDraft(current => ({ ...current, serverName }))
                  }}
                />
              </div>
              <label className={css.check}>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked
                    setDraft(current => ({ ...current, enabled }))
                  }}
                />
                {t('enabled')}
              </label>
              <div className={css.field}>
                <label htmlFor={`${formId}-transport`}>{t('transport')}</label>
                <select
                  id={`${formId}-transport`}
                  value={draft.transport}
                  onChange={(event) => {
                    const transport = event.currentTarget.value === 'streamable-http' ? 'streamable-http' : 'stdio'
                    setDraft(current => ({ ...current, transport }))
                  }}
                >
                  <option value="stdio">{t('transportStdio')}</option>
                  <option value="streamable-http">{t('transportHttp')}</option>
                </select>
              </div>
              {draft.transport === 'stdio' ? (
                <>
                  <div className={css.field}>
                    <label htmlFor={`${formId}-command`}>{t('command')}</label>
                    <Input
                      id={`${formId}-command`}
                      value={draft.command}
                      required
                      onChange={(event) => {
                        const command = event.currentTarget.value
                        setDraft(current => ({ ...current, command }))
                      }}
                    />
                  </div>
                  <div className={css.field}>
                    <label htmlFor={`${formId}-args`}>{t('args')}</label>
                    <textarea
                      id={`${formId}-args`}
                      value={draft.argsText}
                      onChange={(event) => {
                        const argsText = event.currentTarget.value
                        setDraft(current => ({ ...current, argsText }))
                      }}
                    />
                  </div>
                  <div className={css.field}>
                    <label htmlFor={`${formId}-env`}>{t('env')}</label>
                    <textarea
                      id={`${formId}-env`}
                      value={draft.envText}
                      onChange={(event) => {
                        const envText = event.currentTarget.value
                        setDraft(current => ({ ...current, envText }))
                      }}
                    />
                    <p className={css.hint}>{t('envHint')}</p>
                  </div>
                </>
              ) : (
                <>
                  <div className={css.field}>
                    <label htmlFor={`${formId}-url`}>{t('url')}</label>
                    <Input
                      id={`${formId}-url`}
                      value={draft.url}
                      required
                      onChange={(event) => {
                        const url = event.currentTarget.value
                        setDraft(current => ({ ...current, url }))
                      }}
                    />
                  </div>
                  <div className={css.field}>
                    <label htmlFor={`${formId}-headers`}>{t('headers')}</label>
                    <textarea
                      id={`${formId}-headers`}
                      value={draft.headersText}
                      onChange={(event) => {
                        const headersText = event.currentTarget.value
                        setDraft(current => ({ ...current, headersText }))
                      }}
                    />
                    <p className={css.hint}>{t('headersHint')}</p>
                  </div>
                </>
              )}
              {formError !== null && pendingDelete === null ? <p role="alert">{t(formError)}</p> : null}
              <div className={css.actions}>
                <Button variant="primary" size="sm" disabled={saving} type="submit">{t('save')}</Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setEditing(null)
                    setFormError(null)
                  }}
                >
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
      {pendingDelete !== null ? (
        <Modal
          open
          onClose={closeDelete}
          title={t('deleteTitle', { name: pendingDelete })}
          closeLabel={t('close')}
          description={t('deleteDescription')}
          className={css.deleteDialog as string}
          footer={(
            <>
              <Button variant="outline" autoFocus disabled={removing} onClick={closeDelete}>
                {t('cancel')}
              </Button>
              <Button
                variant="outline"
                className={css.deleteConfirm}
                disabled={removing}
                onClick={() => { void destroy(pendingDelete) }}
              >
                {removing ? t('deleting') : t('deleteConfirm', { name: pendingDelete })}
              </Button>
            </>
          )}
        >
          {formError !== null ? <p role="alert">{t(formError)}</p> : null}
        </Modal>
      ) : null}
    </div>
  )
}
