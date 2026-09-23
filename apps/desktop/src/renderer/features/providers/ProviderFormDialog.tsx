// Add / edit a provider — a modal form over the global pool.
//
// The API key is write-only from the renderer's side: on edit we never receive the
// stored key (the field starts blank and, left blank, leaves the key untouched).
// Models are edited as rows: each has an id (the provider's real model name) and an
// optional alias — the shorter / agent-consistent name written to the agent instead
// of the id.

import { useState, type FormEvent } from 'react';
import { elevation, token, fontSize, radius, space } from '../../themes/tokens';
import { hoverBackground } from '../../lib/hover';
import { useT } from '../../i18n';
import {
  API_FORMATS,
  DROPPABLE_REQUEST_FIELDS,
  normalizeDropFields,
  type ApiFormat,
  type ProviderModel,
} from '../../../shared/aiProviders';
import type { ProviderSummary } from '../../../shared/ipc-channels';
import {
  addProvider,
  fetchProviderModels,
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
  const [apiFormat, setApiFormat] = useState<ApiFormat>(provider?.apiFormat ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
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
    const preset = PROVIDER_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setName(preset.name);
    setApiFormat(preset.apiFormat);
    setBaseUrl(preset.baseUrl);
    setModels(toRows(preset.models));
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
    try {
      const fetched = await fetchProviderModels({
        apiFormat,
        baseUrl,
        // A freshly-typed key is sent; when editing and left blank, main resolves
        // the stored key by provider id. The key never comes back to the renderer.
        apiKey: apiKey === '' ? undefined : apiKey,
        providerId: editing ? provider.id : undefined,
      });
      if (fetched.length === 0) {
        setModelsError(t('providers.form.loadModelsEmpty'));
        return;
      }
      setModels((current) => mergeRows(current, fetched));
    } catch (err) {
      setModelsError(providerErrorMessage(t, err));
    } finally {
      setLoadingModels(false);
    }
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const parsedModels = rowsToModels(models);
    try {
      if (editing) {
        await updateProvider({
          id: provider.id,
          name,
          apiFormat,
          baseUrl,
          models: parsedModels,
          notes,
          // Blank field on edit = leave the stored key untouched.
          apiKey: apiKey === '' ? undefined : apiKey,
          // Always sent: it is a checkbox group, so an empty array must clear the set
          // rather than read as "unchanged".
          dropRequestFields: dropFields,
        });
      } else {
        await addProvider({
          name,
          apiFormat,
          baseUrl,
          models: parsedModels,
          notes: notes === '' ? undefined : notes,
          apiKey: apiKey === '' ? undefined : apiKey,
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

  const canSubmit =
    name.trim() !== '' && baseUrl.trim() !== '' && rowsToModels(models).length > 0 && !busy;

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
          {!editing && (
            <label style={fieldStyle}>
              {t('providers.form.preset')}
              <select
                defaultValue=""
                onChange={(e) => applyPreset(e.target.value)}
                style={inputStyle}
              >
                <option value="">{t('providers.form.presetNone')}</option>
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label style={fieldStyle}>
            {t('providers.fields.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            {t('providers.fields.apiFormat')}
            <select
              value={apiFormat}
              onChange={(e) => setApiFormat(e.target.value as ApiFormat)}
              style={inputStyle}
            >
              {API_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`providers.formats.${f}`)}
                </option>
              ))}
            </select>
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
          <div style={fieldStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
              <span>{t('providers.fields.models')}</span>
              <button
                type="button"
                onClick={onLoadModels}
                disabled={baseUrl.trim() === '' || loadingModels}
                {...hoverBackground('transparent', token('surfaceHover'))}
                style={buttonStyle('ghost')}
              >
                {loadingModels ? t('providers.form.loadingModels') : t('providers.form.loadModels')}
              </button>
            </div>

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
                          <input
                            type="checkbox"
                            checked={dropFields.includes(field)}
                            onChange={() => toggleDropField(field)}
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

const legendStyle = {
  padding: `0 ${space.xs}px`,
  color: token('text'),
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
