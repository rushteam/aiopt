// Add / edit a provider — a modal form over the global pool.
//
// The API key is write-only from the renderer's side: on edit we never receive the
// stored key (the field starts blank and, left blank, leaves the key untouched).
// Models are edited as rows: each has an id (the provider's real model name) and an
// optional alias — the shorter / agent-consistent name written to the agent instead
// of the id.
//
// Formats are a checkbox GROUP, not a single choice: a gateway commonly serves several
// dialects at one base URL, and a binding later picks whichever the agent speaks
// natively. "Detect" asks main to probe the base URL and ticks what answered (a union
// with the current ticks — it never unticks a choice the user made by hand).

import { useState, type FormEvent } from 'react';
import { elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import { Checkbox } from '../../components/ui/Checkbox';
import { Select } from '../../components/ui/Select';
import {
  API_FORMATS,
  DROPPABLE_REQUEST_FIELDS,
  normalizeApiFormats,
  normalizeDropFields,
  type ApiFormat,
  type ProviderModel,
} from '../../../shared/aiProviders';
import type { ProviderSummary } from '../../../shared/ipc-channels';
import {
  isOAuthStubKind,
  type OAuthSubscriptionKind,
  type ProviderCredentialMode,
} from '../../../shared/oauthProviders';
import {
  addProvider,
  detectProviderFormats,
  fetchProviderModels,
  refreshModelsDevCatalog,
  revealProviderKey,
  updateProvider,
} from '../../lib/providerStore';
import { providerErrorMessage } from './errors';
import { PROVIDER_PRESETS } from './presets';

// A single editable model row. Fields stay as strings (empty allowed while typing);
// blanks are dropped on submit.
type ModelRow = { id: string; alias: string };

function toRows(models: ProviderModel[]): ModelRow[] {
  return models.map((m) => ({ id: m.id, alias: m.alias ?? '' }));
}

function rowsToModels(rows: ModelRow[]): ProviderModel[] {
  const out: ProviderModel[] = [];
  for (const r of rows) {
    const id = r.id.trim();
    if (id === '') continue;
    const model: ProviderModel = { id };
    if (r.alias.trim() !== '') model.alias = r.alias.trim();
    out.push(model);
  }
  return out;
}

/**
 * Merge freshly-fetched models into the current rows: keep every existing row (and
 * its user-set alias) and append rows for ids not already present.
 */
function mergeRows(existing: ModelRow[], fetched: ProviderModel[]): ModelRow[] {
  const seen = new Set(existing.map((r) => r.id.trim()).filter((id) => id !== ''));
  const merged = [...existing];
  for (const m of fetched) {
    if (!seen.has(m.id)) merged.push({ id: m.id, alias: '' });
  }
  return merged;
}

export function ProviderFormDialog({
  provider,
  onClose,
}: {
  /** Present = edit mode; absent = add mode. */
  provider?: ProviderSummary;
  onClose: () => void;
}) {
  const t = useT();
  const editing = provider !== undefined;
  const [name, setName] = useState(provider?.name ?? '');
  // Starts EMPTY for a new provider: the user ticks what the endpoint serves (or lets
  // Detect do it), rather than inheriting a default that may be wrong for the URL.
  const [apiFormats, setApiFormats] = useState<ApiFormat[]>(provider?.apiFormats ?? []);
  const [detecting, setDetecting] = useState(false);
  const [detectMessage, setDetectMessage] = useState<
    { kind: 'ok' | 'none' | 'error'; text: string } | null
  >(null);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [credentialMode, setCredentialMode] = useState<ProviderCredentialMode>(
    provider?.credentialMode ?? 'api_key',
  );
  const [oauthClientId, setOauthClientId] = useState(provider?.oauth?.clientId ?? '');
  const [oauthAuthorizeUrl, setOauthAuthorizeUrl] = useState(provider?.oauth?.authorizeUrl ?? '');
  const [oauthTokenUrl, setOauthTokenUrl] = useState(provider?.oauth?.tokenUrl ?? '');
  const [oauthScopes, setOauthScopes] = useState(provider?.oauth?.scopes?.join(' ') ?? '');
  const [oauthKind, setOauthKind] = useState<OAuthSubscriptionKind>(
    provider?.oauth?.kind ?? 'openai_codex',
  );
  const [presetKey, setPresetKey] = useState('');
  const usesOAuth = credentialMode === 'oauth';
  const presetSelected = !editing && presetKey !== '';
  const showManualCredential = !editing && !presetSelected;
  const oauthSubscriptionPresets = PROVIDER_PRESETS.filter((p) => p.credentialMode === 'oauth');
  const apiKeyPresets = PROVIDER_PRESETS.filter((p) => p.credentialMode === 'api_key');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ModelRow[]>(toRows(provider?.models ?? []));
  const [notes, setNotes] = useState(provider?.notes ?? '');
  const [dropFields, setDropFields] = useState<string[]>(provider?.dropRequestFields ?? []);
  // The compatibility section starts open only when it already has something in it, so a
  // provider that strips nothing (the default, and the common case) shows a quiet one-line
  // summary instead of a wall of checkboxes.
  const [compatOpen, setCompatOpen] = useState((provider?.dropRequestFields?.length ?? 0) > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsCatalogHint, setModelsCatalogHint] = useState<string | null>(null);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // The eye can either reveal the stored key (edit mode, nothing typed yet) or just
  // toggle mask/plaintext of what's in the field. Revealing fetches the plaintext
  // main-side (a deliberate, gated boundary crossing) and drops it into the field so
  // it can be viewed and edited.
  async function onToggleKey(): Promise<void> {
    if (apiKey === '') {
      if (!provider?.hasKey) return;
      setRevealing(true);
      setKeyError(null);
      try {
        const plaintext = await revealProviderKey(provider.id);
        if (plaintext !== null) {
          setApiKey(plaintext);
          setShowKey(true);
        }
      } catch (err) {
        setKeyError(providerErrorMessage(t, err));
      } finally {
        setRevealing(false);
      }
      return;
    }
    setShowKey((v) => !v);
  }

  function applyPreset(key: string): void {
    setPresetKey(key);
    if (key === '') return;
    const preset = PROVIDER_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setName(preset.name);
    setApiFormats([...preset.apiFormats]);
    setDetectMessage(null);
    setBaseUrl(preset.baseUrl);
    setModels(toRows(preset.models));
    setCredentialMode(preset.credentialMode);
    if (preset.credentialMode === 'oauth' && preset.oauthKind) {
      setOauthKind(preset.oauthKind);
      setOauthClientId('');
      setOauthAuthorizeUrl('');
      setOauthTokenUrl('');
      setOauthScopes('');
    } else {
      setOauthKind('openai_codex');
    }
  }

  // Keep the selection in the shared allowlist's canonical order, so what we send matches
  // what main stores and the checkbox set never depends on click order.
  function toggleFormat(format: ApiFormat): void {
    setApiFormats((current) =>
      normalizeApiFormats(
        current.includes(format) ? current.filter((f) => f !== format) : [...current, format],
      ),
    );
  }

  // Probe the base URL and tick every format that answered. A union, not a replace: a
  // format the user ticked by hand stays ticked even if the probe could not confirm it
  // (an auth-fronted gateway answers 401 everywhere, and that is inconclusive, not "no").
  async function onDetectFormats(): Promise<void> {
    setDetecting(true);
    setDetectMessage(null);
    try {
      const detected = await detectProviderFormats({
        baseUrl,
        apiKey: apiKey === '' ? undefined : apiKey,
        providerId: editing ? provider.id : undefined,
      });
      if (detected.length === 0) {
        setDetectMessage({ kind: 'none', text: t('providers.form.detectNone') });
        return;
      }
      setApiFormats((current) => normalizeApiFormats([...current, ...detected]));
      setDetectMessage({
        kind: 'ok',
        text: `${t('providers.form.detectFound')} ${detected
          .map((f) => t(`providers.formats.${f}`))
          .join(' · ')}`,
      });
    } catch (err) {
      setDetectMessage({ kind: 'error', text: providerErrorMessage(t, err) });
    } finally {
      setDetecting(false);
    }
  }

  function updateRow(index: number, patch: Partial<ModelRow>): void {
    setModels((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addRow(): void {
    setModels((rows) => [...rows, { id: '', alias: '' }]);
  }

  function removeRow(index: number): void {
    setModels((rows) => rows.filter((_, i) => i !== index));
  }

  // Keep the selection in the shared allowlist's canonical order, so what we send matches
  // what main stores and the checkbox set never depends on click order.
  function toggleDropField(field: string): void {
    setDropFields((current) =>
      normalizeDropFields(
        current.includes(field) ? current.filter((f) => f !== field) : [...current, field],
      ),
    );
  }

  async function onLoadModels(): Promise<void> {
    setLoadingModels(true);
    setModelsError(null);
    setModelsCatalogHint(null);
    try {
      const result = await fetchProviderModels({
        apiFormats,
        baseUrl,
        // A freshly-typed key is sent; when editing and left blank, main resolves
        // the stored key by provider id. The key never comes back to the renderer.
        apiKey: apiKey === '' ? undefined : apiKey,
        providerId: editing ? provider.id : undefined,
      });
      const fetched = result.models;
      if (fetched.length === 0) {
        setModelsError(t('providers.form.loadModelsEmpty'));
        return;
      }
      setModels((current) => mergeRows(current, fetched));
      if (result.catalogSource === 'models_dev') {
        setModelsCatalogHint(t('providers.form.loadModelsFromCatalog'));
      } else if (result.modelsDev?.stale) {
        setModelsCatalogHint(t('providers.form.modelsDevStale'));
      }
    } catch (err) {
      setModelsError(providerErrorMessage(t, err));
    } finally {
      setLoadingModels(false);
    }
  }

  async function onRefreshModelsDev(): Promise<void> {
    setRefreshingCatalog(true);
    setModelsError(null);
    try {
      const status = await refreshModelsDevCatalog();
      setModelsCatalogHint(
        status.stale ? t('providers.form.modelsDevStale') : t('providers.form.modelsDevFresh'),
      );
    } catch (err) {
      setModelsError(providerErrorMessage(t, err));
    } finally {
      setRefreshingCatalog(false);
    }
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const parsedModels = rowsToModels(models);
    const oauthAccountPatch =
      editing && (provider.oauth?.accountLabel ?? provider.oauthAccountLabel)
        ? {
            accountLabel:
              provider.oauth?.accountLabel ?? provider.oauthAccountLabel ?? undefined,
          }
        : {};
    const oauthConfig = usesOAuth
      ? oauthKind === 'generic_pkce'
        ? {
            kind: 'generic_pkce' as const,
            clientId: oauthClientId.trim(),
            authorizeUrl: oauthAuthorizeUrl.trim(),
            tokenUrl: oauthTokenUrl.trim(),
            scopes:
              oauthScopes
                .split(/[\s,]+/)
                .map((s) => s.trim())
                .filter((s) => s !== '').length > 0
                ? oauthScopes
                    .split(/[\s,]+/)
                    .map((s) => s.trim())
                    .filter((s) => s !== '')
                : undefined,
            ...oauthAccountPatch,
          }
        : { kind: oauthKind, ...oauthAccountPatch }
      : undefined;
    try {
      if (editing) {
        await updateProvider({
          id: provider.id,
          name,
          apiFormats,
          baseUrl,
          models: parsedModels,
          notes,
          credentialMode,
          oauth: oauthConfig,
          // Blank field on edit = leave the stored key untouched.
          apiKey: usesOAuth ? undefined : apiKey === '' ? undefined : apiKey,
          // Always sent: it is a checkbox group, so an empty array must clear the set
          // rather than read as "unchanged".
          dropRequestFields: dropFields,
        });
      } else {
        await addProvider({
          name,
          apiFormats,
          baseUrl,
          models: parsedModels,
          notes: notes === '' ? undefined : notes,
          credentialMode,
          oauth: oauthConfig,
          apiKey: usesOAuth ? undefined : apiKey === '' ? undefined : apiKey,
          dropRequestFields: dropFields.length > 0 ? dropFields : undefined,
        });
      }
      onClose();
    } catch (err) {
      setError(providerErrorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  const oauthEndpointsOk =
    !usesOAuth ||
    oauthKind !== 'generic_pkce' ||
    (oauthClientId.trim() !== '' &&
      oauthAuthorizeUrl.trim() !== '' &&
      oauthTokenUrl.trim() !== '');

  const canSubmit =
    name.trim() !== '' &&
    baseUrl.trim() !== '' &&
    apiFormats.length > 0 &&
    rowsToModels(models).length > 0 &&
    oauthEndpointsOk &&
    !busy;

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true">
      <div style={panelStyle}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: fontSize['2xl'] }}>
            {editing ? t('providers.form.editTitle') : t('providers.form.addTitle')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('providers.form.close')}
            title={t('providers.form.close')}
            {...hoverBackground('transparent', token('surfaceHover'))}
            style={closeButtonStyle}
          >
            ×
          </button>
        </div>
        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: space.lg }}>
          <label style={fieldStyle}>
            {t('providers.fields.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            {t('providers.fields.baseUrl')}
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
              style={inputStyle}
            />
          </label>
          {!editing && (
            <label style={fieldStyle}>
              {t('providers.form.preset')}
              <Select
                value={presetKey}
                onChange={applyPreset}
                options={[{ value: '', label: t('providers.form.presetNone') }]}
                groups={[
                  {
                    label: t('providers.form.presetGroupApi'),
                    options: apiKeyPresets.map((p) => ({ value: p.key, label: p.name })),
                  },
                  {
                    label: t('providers.form.presetGroupOAuth'),
                    options: oauthSubscriptionPresets.map((p) => ({
                      value: p.key,
                      label: p.oauthKind === 'generic_pkce' ? t('providers.oauth.customPkce') : p.name,
                    })),
                  },
                ]}
              />
              <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                {presetSelected
                  ? usesOAuth
                    ? t('providers.form.presetOAuthHint')
                    : t('providers.form.presetApiHint')
                  : t('providers.form.presetCustomHint')}
              </span>
            </label>
          )}
          {showManualCredential && (
            <label style={fieldStyle}>
              {t('providers.fields.credentialMode')}
              <Select
                value={credentialMode}
                onChange={(next) => {
                  const mode = next as ProviderCredentialMode;
                  setCredentialMode(mode);
                  if (mode === 'oauth') {
                    setOauthKind('generic_pkce');
                    setOauthClientId('');
                    setOauthAuthorizeUrl('');
                    setOauthTokenUrl('');
                    setOauthScopes('');
                  }
                }}
                options={[
                  { value: 'api_key', label: t('providers.credential.apiKey') },
                  { value: 'oauth', label: t('providers.oauth.customPkce') },
                ]}
              />
            </label>
          )}
          {editing && (
            <label style={fieldStyle}>
              {t('providers.fields.credentialMode')}
              <Select
                value={credentialMode}
                disabled
                options={[
                  { value: 'api_key', label: t('providers.credential.apiKey') },
                  { value: 'oauth', label: t('providers.credential.oauth') },
                ]}
                onChange={() => {}}
              />
              <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                {t('providers.form.credentialModeLocked')}
              </span>
            </label>
          )}
          {usesOAuth && (
            <>
              {editing && (
                <label style={fieldStyle}>
                  {t('providers.fields.oauthService')}
                  <Select
                    value={oauthKind}
                    disabled
                    onChange={() => {}}
                    options={oauthSubscriptionPresets
                      .filter((p) => p.oauthKind)
                      .map((p) => ({
                        value: p.oauthKind!,
                        label: p.oauthKind === 'generic_pkce' ? t('providers.oauth.customPkce') : p.name,
                      }))}
                  />
                </label>
              )}
              {isOAuthStubKind(oauthKind) && (
                <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
                  {t('providers.form.oauthStubHint')}
                </p>
              )}
              {oauthKind === 'generic_pkce' && (showManualCredential || presetKey === 'oauth-generic-pkce') && (
                <>
                  <label style={fieldStyle}>
                    {t('providers.fields.oauthClientId')}
                    <input
                      value={oauthClientId}
                      onChange={(e) => setOauthClientId(e.target.value)}
                      style={inputStyle}
                      autoComplete="off"
                    />
                  </label>
                  <label style={fieldStyle}>
                    {t('providers.fields.oauthAuthorizeUrl')}
                    <input
                      value={oauthAuthorizeUrl}
                      onChange={(e) => setOauthAuthorizeUrl(e.target.value)}
                      placeholder="https://…/authorize"
                      style={inputStyle}
                    />
                  </label>
                  <label style={fieldStyle}>
                    {t('providers.fields.oauthTokenUrl')}
                    <input
                      value={oauthTokenUrl}
                      onChange={(e) => setOauthTokenUrl(e.target.value)}
                      placeholder="https://…/token"
                      style={inputStyle}
                    />
                  </label>
                  <label style={fieldStyle}>
                    {t('providers.fields.oauthScopes')}
                    <input
                      value={oauthScopes}
                      onChange={(e) => setOauthScopes(e.target.value)}
                      placeholder={t('providers.form.oauthScopesPlaceholder')}
                      style={inputStyle}
                    />
                  </label>
                </>
              )}
              <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>
                {t('providers.form.oauthHint')}
              </p>
            </>
          )}
          {!usesOAuth && (
          <div style={fieldStyle}>
            <span>{t('providers.fields.apiKey')}</span>
            <div style={{ display: 'flex', gap: space.sm }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editing ? t('providers.form.apiKeyKeep') : ''}
                autoComplete="off"
                style={{ ...inputStyle, flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                onClick={() => void onToggleKey()}
                disabled={revealing || (apiKey === '' && !provider?.hasKey)}
                aria-pressed={showKey}
                aria-label={showKey ? t('providers.form.hideKey') : t('providers.form.showKey')}
                title={showKey ? t('providers.form.hideKey') : t('providers.form.showKey')}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={{
                  ...iconButtonStyle,
                  cursor: apiKey === '' && !provider?.hasKey ? 'default' : 'pointer',
                  opacity: apiKey === '' && !provider?.hasKey ? 0.4 : 1,
                }}
              >
                <EyeIcon off={showKey} />
              </button>
            </div>
            {keyError && (
              <span role="alert" style={{ fontSize: fontSize.sm, color: token('danger') }}>
                {keyError}
              </span>
            )}
            {provider?.hasKey && apiKey === '' && (
              <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                {t('providers.form.keySavedHidden')}
              </span>
            )}
          </div>
          )}
          {/* Formats come AFTER the URL and key they describe: Detect needs both, and the
              order reads as "here is the endpoint — now, what does it speak?". A native
              fieldset so the group name is announced with its checkboxes. */}
          <fieldset style={formatGroupStyle}>
            <legend style={legendStyle}>{t('providers.fields.apiFormats')}</legend>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
              <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                {t('providers.form.apiFormatsHint')}
              </span>
              <button
                type="button"
                onClick={() => void onDetectFormats()}
                disabled={baseUrl.trim() === '' || detecting}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={buttonStyle('ghost')}
              >
                {detecting ? t('providers.form.detecting') : t('providers.form.detectFormats')}
              </button>
            </div>
            <div style={checkGridStyle}>
              {API_FORMATS.map((format) => (
                <label key={format} style={checkLabelStyle}>
                  <Checkbox
                    checked={apiFormats.includes(format)}
                    onChange={() => toggleFormat(format)}
                    aria-label={t(`providers.formats.${format}`)}
                  />
                  {t(`providers.formats.${format}`)}
                </label>
              ))}
            </div>
            {detectMessage && (
              <span
                role={detectMessage.kind === 'error' ? 'alert' : 'status'}
                style={{
                  fontSize: fontSize.sm,
                  color: detectMessage.kind === 'error' ? token('danger') : token('textMuted'),
                }}
              >
                {detectMessage.text}
              </span>
            )}
          </fieldset>
          <div style={fieldStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md, flexWrap: 'wrap' }}>
              <span>{t('providers.fields.models')}</span>
              <div style={{ display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => void onRefreshModelsDev()}
                  disabled={refreshingCatalog}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={buttonStyle('ghost')}
                >
                  {refreshingCatalog
                    ? t('providers.form.refreshingCatalog')
                    : t('providers.form.refreshCatalog')}
                </button>
                <button
                  type="button"
                  onClick={() => void onLoadModels()}
                  disabled={baseUrl.trim() === '' || loadingModels}
                  {...hoverBackground('transparent', token('surfaceHover'))}
                  style={buttonStyle('ghost')}
                >
                  {loadingModels ? t('providers.form.loadingModels') : t('providers.form.loadModels')}
                </button>
              </div>
            </div>
            {modelsCatalogHint && (
              <p style={{ margin: 0, fontSize: fontSize.sm, color: token('textMuted') }}>{modelsCatalogHint}</p>
            )}

            {models.length > 0 && (
              <div style={modelListStyle}>
                {models.map((row, i) => (
                  <div key={i} style={modelRowStyle}>
                    <input
                      value={row.id}
                      onChange={(e) => updateRow(i, { id: e.target.value })}
                      placeholder={t('providers.form.modelIdPlaceholder')}
                      aria-label={t('providers.fields.modelId')}
                      style={{ ...inputStyle, flex: '1.3 1 0', minWidth: 0 }}
                    />
                    <input
                      value={row.alias}
                      onChange={(e) => updateRow(i, { alias: e.target.value })}
                      placeholder={t('providers.form.modelAliasPlaceholder')}
                      aria-label={t('providers.fields.modelAlias')}
                      style={{ ...inputStyle, flex: '1 1 0', minWidth: 0 }}
                    />
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      aria-label={t('providers.form.removeModel')}
                      title={t('providers.form.removeModel')}
                      {...hoverBackground('transparent', token('surfaceHover'))}
                      style={iconButtonStyle}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={addRow}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={addRowStyle}
            >
              + {t('providers.form.addModel')}
            </button>
            <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
              {t('providers.form.aliasHint')}
            </span>
            {modelsError && (
              <span role="alert" style={{ color: token('danger'), fontSize: fontSize.sm }}>
                {modelsError}
              </span>
            )}
          </div>
          <label style={fieldStyle}>
            {t('providers.fields.notes')}
            <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} />
          </label>

          {/* Upstream compatibility — the escape hatch for a gateway that rejects a field
              it doesn't know. Collapsed by default: most providers need nothing here, and
              the checkboxes would otherwise dominate a form whose real subject is the
              endpoint and its models. */}
          <div style={fieldStyle}>
            <button
              type="button"
              onClick={() => setCompatOpen((v) => !v)}
              aria-expanded={compatOpen}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={disclosureStyle}
            >
              <Chevron open={compatOpen} />
              <span style={{ color: token('text') }}>{t('providers.fields.dropRequestFields')}</span>
              <span style={{ marginLeft: 'auto', color: token('textMuted'), fontSize: fontSize.sm }}>
                {dropFields.length === 0
                  ? t('providers.form.dropNone')
                  : dropFields.join(', ')}
              </span>
            </button>

            {compatOpen && (
              <div style={compatBodyStyle}>
                <span style={{ fontSize: fontSize.sm, color: token('textMuted') }}>
                  {t('providers.form.dropHint')}
                </span>

                {(['safe', 'sensitive'] as const).map((group) => (
                  <fieldset key={group} style={groupStyle}>
                    <legend style={legendStyle}>{t(`providers.form.dropGroup.${group}`)}</legend>
                    <span
                      style={{
                        fontSize: fontSize.sm,
                        // The sensitive group's caution is the one thing here that can cost
                        // the user a silently degraded response, so it carries `danger`
                        // rather than the muted body color the safe group's note uses.
                        color: group === 'sensitive' ? token('danger') : token('textMuted'),
                      }}
                    >
                      {t(`providers.form.dropGroupHint.${group}`)}
                    </span>
                    <div style={checkGridStyle}>
                      {DROPPABLE_REQUEST_FIELDS[group].map((field) => (
                        <label key={field} style={checkLabelStyle}>
                          <Checkbox
                            checked={dropFields.includes(field)}
                            onChange={() => toggleDropField(field)}
                            aria-label={field}
                          />
                          <code style={codeStyle}>{field}</code>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            )}
          </div>
          {error && (
            <p role="alert" style={{ margin: 0, color: token('danger'), fontSize: fontSize.base }}>
              {error}
            </p>
          )}
          <div style={{ display: 'flex', gap: space.md, justifyContent: 'flex-end', marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              {...hoverBackground('transparent', token('surfaceHover'))}
              style={buttonStyle('ghost')}
            >
              {t('providers.form.cancel')}
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              {...hoverBackground(token('accent'), token('accentHover'))}
              style={buttonStyle('accent')}
            >
              {busy ? t('providers.form.saving') : t('providers.form.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: token('overlay'),
  display: 'grid',
  placeItems: 'center',
  padding: space['2xl'],
  zIndex: 10,
} as const;

const panelStyle = {
  width: 'min(560px, 100%)',
  maxHeight: '100%',
  overflowY: 'auto',
  background: token('bg'),
  color: token('text'),
  border: `1px solid ${token('border')}`,
  borderRadius: radius.xl,
  boxShadow: elevation('modal'),
  padding: 20,
} as const;

// Title row + a corner close affordance, so the modal dismisses without hunting
// for the footer Cancel.
const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: space.md,
  marginBottom: 16,
} as const;

const closeButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: radius.sm,
  border: 'none',
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.xl,
  lineHeight: 1,
} as const;

const fieldStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  fontSize: fontSize.base,
  color: token('textMuted'),
} as const;

const inputStyle = {
  padding: '8px 10px',
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: token('surface'),
  color: token('text'),
  fontSize: fontSize.md,
} as const;

function buttonStyle(kind: 'accent' | 'ghost') {
  return {
    padding: '8px 16px',
    borderRadius: radius.md,
    border: `1px solid ${kind === 'accent' ? token('accent') : token('borderStrong')}`,
    background: kind === 'accent' ? token('accent') : 'transparent',
    color: kind === 'accent' ? token('accentText') : token('text'),
    cursor: 'pointer',
    fontSize: fontSize.md,
  } as const;
}

// Square icon button sized to sit flush beside the key input / a model row.
const iconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 38,
  padding: 0,
  borderRadius: radius.sm,
  border: `1px solid ${token('borderStrong')}`,
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
} as const;

const modelListStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.sm,
  maxHeight: 220,
  overflowY: 'auto',
  // A focused field's keyboard ring sits ~4px outside the input (global.css
  // :focus-visible = 2px outline at 2px offset). overflow-y:auto also clips
  // overflow-x, so without clearance the ring is shaved at the list's edges.
  // Pad every side ≥ the ring's reach; keep the right a touch wider so the trash
  // button (and its ring) also clear the reserved scrollbar gutter.
  scrollbarGutter: 'stable',
  padding: '5px',
  paddingRight: 12,
} as const;

const modelRowStyle = {
  display: 'flex',
  // Stretch (not center) so the trash button grows to the inputs' height and sits
  // flush beside them — same pattern the API-key row uses for its eye button.
  alignItems: 'stretch',
  gap: space.sm,
} as const;

// The compatibility section's disclosure row: a full-width, quiet header that reads as a
// label with a summary, not as a button competing with the form's real actions.
const disclosureStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: space.sm,
  width: '100%',
  padding: '6px 8px',
  borderRadius: radius.sm,
  // A divider, not a control outline: this row groups the section below it rather than
  // presenting a clickable boundary (the chevron carries the affordance). See DESIGN §1.1.
  border: `1px solid ${token('border')}`,
  background: 'transparent',
  color: token('textMuted'),
  cursor: 'pointer',
  fontSize: fontSize.base,
  textAlign: 'left',
} as const;

const compatBodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.lg,
  padding: `${space.md}px 2px 2px`,
} as const;

// The formats group sits in the form's main flow, so it takes the same footprint as a
// labelled field (no box of its own) — the legend IS the field label, and the hairline
// would otherwise read as a nested section like the collapsed compatibility block.
const formatGroupStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  margin: 0,
  padding: 0,
  border: 'none',
  minWidth: 0,
} as const;

// Native <fieldset>/<legend> so each group's name is announced with its checkboxes;
// the default chrome is stripped in favor of the app's own hairline.
const groupStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: space.xs,
  margin: 0,
  padding: space.md,
  borderRadius: radius.sm,
  border: `1px solid ${token('border')}`,
} as const;

// Shared by the formats group (where it stands in for a field label, hence the muted
// color that matches `fieldStyle`) and the compatibility groups (inside their own box).
const legendStyle = {
  padding: 0,
  marginBottom: space.xs,
  color: token('textMuted'),
  fontSize: fontSize.base,
} as const;

// Wraps to as many columns as fit, so adding a field to the allowlist never overflows.
const checkGridStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: `${space.xs}px ${space.xl}px`,
  marginTop: space.xs,
} as const;

const checkLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space.sm,
  color: token('text'),
  fontSize: fontSize.base,
  cursor: 'pointer',
} as const;

// A field name is a literal API parameter, so it is set in mono to separate it from copy.
const codeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: fontSize.sm,
} as const;

// A quiet dashed "add" affordance, distinct from the solid form buttons.
const addRowStyle = {
  alignSelf: 'flex-start',
  padding: '6px 12px',
  borderRadius: radius.sm,
  border: `1px dashed ${token('borderStrong')}`,
  background: 'transparent',
  color: token('text'),
  cursor: 'pointer',
  fontSize: fontSize.base,
} as const;

// Eye (reveal) / eye-off (mask) glyph. Stroke follows currentColor so it reads
// correctly in both themes; a slash overlays the eye when the key is shown.
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3" y1="3" x2="21" y2="21" />}
    </svg>
  );
}

// Disclosure chevron: points right when collapsed, down when open. Rotated rather than
// swapped so the transition reads as one control changing state.
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 120ms ease',
      }}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// Trash glyph for removing a model row.
function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14" />
    </svg>
  );
}
