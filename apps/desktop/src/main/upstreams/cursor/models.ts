// Cursor's model list and how a chat's model is asked of Cursor.
//
// Cursor's picker (`aiserver.v1.AiService/AvailableModels`) lists models with their
// parameter definitions (effort, thinking, fast, context) and their concrete variants;
// `agent.v1.AgentService/GetUsableModels` (what `cursor-agent models` prints) names the
// variants the account is actually served. The agent API takes a VARIANT's own id (its
// legacySlug, e.g. `claude-opus-4-5-high`) plus its parameters, in Max Mode when the variant
// needs it. Ported from @magpie-community/opencode-cursor-auth (index.mjs `modelsOf` /
// `request` / `pick` / `named` / `branch` / `fitEffort` / `splitID`).
//
// Pure: unit-tested in upstreams/__tests__/cursorModels.test.ts.

export const LEVEL_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const EFFORT_PARAMS = ['effort', 'reasoning_effort', 'reasoning'];
const ID_EFFORTS: Array<[string, string]> = [
  ['extra-high', 'xhigh'],
  ['xhigh', 'xhigh'],
  ['minimal', 'minimal'],
  ['none', 'none'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['max', 'max'],
];
/** Left out of the CLI's picker, as cursor-agent leaves them out. */
const PICKER_SKIP = new Set([
  'claude-4.5-haiku',
  'claude-4.5-haiku-thinking',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'claude-haiku-4-5',
]);
export const DEFAULT_CONTEXT = 200_000;

/** The parts of a picker model we read (loose: the API is Cursor's, unversioned). */
export interface PickerVariant {
  legacySlug?: string;
  isDefaultNonMaxConfig?: boolean;
  isDefaultMaxConfig?: boolean;
  isMaxMode?: boolean;
  parameterValues?: Array<{ id?: unknown; value?: unknown }>;
}
export interface PickerModel {
  name?: string;
  clientDisplayName?: string;
  legacySlugs?: string[];
  idAliases?: string[];
  isHidden?: boolean;
  isChatOnly?: boolean;
  onlySupportsCmdK?: boolean;
  supportsAgent?: boolean;
  supportsNonMaxMode?: boolean;
  contextTokenLimit?: number;
  contextTokenLimitForMaxMode?: number;
  parameterDefinitions?: Array<{
    id?: string;
    parameterType?: {
      enumParameter?: { values?: Array<{ value?: unknown }> };
      booleanParameter?: { values?: Array<{ value?: unknown }> };
    };
  }>;
  variants?: PickerVariant[];
}

/** One model as offered (an entry per context size a model has). */
export interface OfferedModel {
  id: string;
  name: string;
  run: string;
  pid: string;
  levels: Record<string, string>;
  fast: boolean;
  variants: PickerVariant[];
  def: PickerVariant | undefined;
  partial: boolean;
  model: PickerModel;
  context: number;
  size: string;
}

const cut = (s: string, suffix: string): string | null =>
  s.endsWith(suffix) && s.length > suffix.length ? s.slice(0, -suffix.length) : null;

/** One of Cursor's own ids taken apart: its family, and the effort it is at ("" for none). */
export function splitID(id: string): [string, string] {
  let s = id;
  let fast = false;
  let thinking = false;
  let effort = '';
  let b: string | null;
  if ((b = cut(s, '-fast')) !== null) [s, fast] = [b, true];
  if ((b = cut(s, '-thinking')) !== null) [s, thinking] = [b, true];
  for (const [word, level] of ID_EFFORTS) {
    if ((b = cut(s, '-' + word)) !== null) {
      [s, effort] = [b, level];
      break;
    }
  }
  if (!thinking && (b = cut(s, '-thinking')) !== null) [s, thinking] = [b, true];
  if (thinking) s += '-thinking';
  if (fast) s += '-fast';
  return [s, effort];
}

const clean = (s: unknown): string =>
  String(s ?? '')
    .replaceAll('\u200b', '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

/** A context value as tokens: "300k" → 300000, "1m" → 1000000. */
export function tokensOf(value: unknown): number {
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(String(value ?? '').trim());
  return m ? Math.round(Number(m[1]) * (m[2]!.toLowerCase() === 'm' ? 1_000_000 : 1_000)) : 0;
}

function paramDefs(m: PickerModel): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of m.parameterDefinitions ?? []) {
    const t = d?.parameterType ?? {};
    const vs = (t.enumParameter ?? t.booleanParameter)?.values ?? [];
    if (d?.id) out[d.id] = vs.map((v) => String(v.value));
  }
  return out;
}

const valuesOf = (v: PickerVariant | undefined): Record<string, string> =>
  Object.fromEntries((v?.parameterValues ?? []).map((p) => [String(p.id), String(p.value)]));

const defaultVariant = (vs: PickerVariant[]): PickerVariant | undefined =>
  vs.find((v) => v.isDefaultNonMaxConfig) ?? vs.find((v) => v.isDefaultMaxConfig) ?? vs[0];

const needsMax = (m: PickerModel | undefined, v: PickerVariant | undefined): boolean =>
  m?.supportsNonMaxMode === false || v?.isMaxMode === true;

function effortsOf(defs: Record<string, string[]>): { pid: string; levels: Record<string, string> } {
  const pid = EFFORT_PARAMS.find((p) => defs[p]?.length);
  if (!pid && defs.thinking?.includes('true') && defs.thinking.includes('false')) {
    return { pid: 'thinking', levels: { none: 'false', high: 'true' } };
  }
  if (!pid) return { pid: '', levels: {} };
  const levels: Record<string, string> = {};
  for (const v of defs[pid]!) {
    const l = v === 'extra-high' ? 'xhigh' : v;
    if ((LEVEL_RANK as readonly string[]).includes(l)) levels[l] = v;
  }
  return { pid, levels };
}

function served(m: PickerModel, ids: Set<string> | null): PickerVariant[] {
  const vs = m.variants ?? [];
  if (!ids) return vs;
  const got = vs.filter((v) => !v.legacySlug || ids.has(v.legacySlug));
  return got.some((v) => v.legacySlug) ? got : vs;
}

/**
 * The picker's models as offered: one entry per context size a model has, or one with
 * Cursor's limit when it has none. A model served in part is offered at the sizes and
 * efforts it is served at. `ids` is GetUsableModels' set (null when it could not be had).
 */
export function modelsOf(picker: PickerModel[], ids: Set<string> | null): OfferedModel[] {
  const out: OfferedModel[] = [];
  const used = new Set<string>();
  for (const m of picker) {
    if (
      !m?.name ||
      m.isHidden ||
      m.isChatOnly ||
      m.onlySupportsCmdK ||
      m.supportsAgent === false ||
      PICKER_SKIP.has(m.name)
    ) {
      continue;
    }
    const defs = paramDefs(m);
    const variants = served(m, ids);
    const partial = variants.length < (m.variants ?? []).length;
    const has = (pid: string, value: string): boolean =>
      !partial || !variants.some((v) => pid in valuesOf(v)) || variants.some((v) => valuesOf(v)[pid] === value);
    const def = defaultVariant(variants);
    const { pid, levels: all } = effortsOf(defs);
    const levels = Object.fromEntries(Object.entries(all).filter(([, value]) => has(pid, value)));
    const base = {
      run: m.name,
      pid,
      levels,
      fast: !!defs.fast?.length,
      variants,
      def,
      partial,
      model: m,
    };
    const title = clean(m.clientDisplayName || m.name);
    const contexts = (defs.context ?? []).filter((c) => has('context', c));
    if (contexts.length) {
      for (const c of contexts) {
        const id = m.name + '@' + c;
        if (used.has(id)) continue;
        used.add(id);
        out.push({ ...base, id, name: `${title} @ ${c}`, context: tokensOf(c) || DEFAULT_CONTEXT, size: c });
      }
    } else if (!used.has(m.name)) {
      used.add(m.name);
      const limit = needsMax(m, def)
        ? m.contextTokenLimitForMaxMode || m.contextTokenLimit || 0
        : m.contextTokenLimit || 0;
      out.push({
        ...base,
        id: m.name === 'default' ? 'auto' : m.name,
        name: title,
        context: limit > 0 ? limit : DEFAULT_CONTEXT,
        size: '',
      });
    }
  }
  return out;
}

function nearest(vs: PickerVariant[], want: Record<string, string>): PickerVariant | undefined {
  let best: PickerVariant | undefined;
  let most = -1;
  for (const v of vs) {
    const have = valuesOf(v);
    const n =
      Object.keys(want).filter((k) => have[k] === want[k]).length + (have.context === want.context ? 100 : 0);
    if (n > most) [best, most] = [v, n];
  }
  return best;
}

/** The nearest effort a model has to the one asked for; max for ultra, none only when asked. */
export function fitEffort(wantIn: string, levels: string[]): string {
  const want = wantIn === 'ultra' ? 'max' : wantIn;
  if (!levels.length || levels.includes(want)) return want;
  const rank = LEVEL_RANK as readonly string[];
  const at = rank.indexOf(want);
  if (at < 0) return '';
  let best = '';
  let dist = rank.length;
  for (const l of levels) {
    const i = rank.indexOf(l);
    if (i < 0 || l === 'none') continue;
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) [best, dist] = [l, d];
  }
  return best;
}

function branch(entry: OfferedModel, want: Record<string, string>): PickerVariant | undefined {
  if (!entry.pid || entry.pid === 'thinking') return undefined;
  const level = (x: string | undefined): string => (x === 'extra-high' ? 'xhigh' : (x ?? ''));
  const def = valuesOf(entry.def);
  const isNamed = entry.variants.some((v) => level(valuesOf(v)[entry.pid]) === level(want[entry.pid]));
  if (
    !isNamed &&
    Object.keys(want).every((k) => k === entry.pid || k === 'context' || def[k] === undefined || def[k] === want[k])
  ) {
    return undefined;
  }
  const vs = entry.variants.filter((v) => {
    const have = valuesOf(v);
    return (
      entry.pid in have &&
      Object.keys(want).every((k) => k === entry.pid || have[k] === undefined || have[k] === want[k])
    );
  });
  const at = fitEffort(
    level(want[entry.pid]),
    vs.map((v) => level(valuesOf(v)[entry.pid])),
  );
  return at ? vs.find((v) => level(valuesOf(v)[entry.pid]) === at) : undefined;
}

export interface CursorRequestModel {
  /** The id the agent API is asked for (a variant's legacySlug, or the model as named). */
  id: string;
  params: Array<{ id: string; value: string }>;
  maxMode: boolean;
}

function pick(entry: OfferedModel, effortIn: string, fast: boolean | undefined, seed?: PickerVariant): CursorRequestModel {
  const def = entry.def;
  const want: Record<string, string> = { ...valuesOf(seed ?? def) };
  if (entry.size) want.context = entry.size;
  const effort = effortIn === 'off' ? 'none' : effortIn;
  if (entry.pid && entry.pid !== 'thinking' && effort === 'none' && !('none' in entry.levels) && 'thinking' in want) {
    want.thinking = 'false';
  } else if (entry.pid) {
    const at = effort ? fitEffort(effort, Object.keys(entry.levels)) : '';
    if (at && entry.levels[at]) want[entry.pid] = entry.levels[at]!;
    if (!seed && entry.pid !== 'thinking' && 'thinking' in want && at) want.thinking = 'true';
  }
  if (entry.fast) want.fast = fast ? 'true' : 'false';
  const same = (v: PickerVariant): boolean => {
    const have = valuesOf(v);
    return Object.keys({ ...have, ...want }).every(
      (k) => have[k] === undefined || want[k] === undefined || have[k] === want[k],
    );
  };
  const v =
    entry.variants.find(same) ??
    (seed ? branch(entry, want) : undefined) ??
    (entry.partial ? nearest(entry.variants, want) : undefined);
  const params = Object.entries(v ? { ...want, ...valuesOf(v) } : want).map(([id, value]) => ({ id, value }));
  const maxMode = v
    ? needsMax(entry.model, v)
    : needsMax(entry.model, def) || tokensOf(entry.size) > (entry.model.contextTokenLimit || Infinity);
  const id = v?.legacySlug || def?.legacySlug || entry.run;
  return { id, params, maxMode };
}

function named(
  raw: OfferedModel[],
  id: string,
): { entry: OfferedModel; seed: PickerVariant | undefined; effort: string; fast: boolean } | null {
  const models = raw.filter((e, i) => raw.findIndex((x) => x.model === e.model) === i);
  const at = (e: OfferedModel, v: PickerVariant | undefined): OfferedModel =>
    raw.find((x) => x.model === e.model && x.size === (valuesOf(v).context ?? '')) ?? e;
  const as = (e: OfferedModel, vs: PickerVariant[], effort: string) => {
    const seed = nearest(vs, valuesOf(e.def));
    return { entry: at(e, seed), seed, effort, fast: valuesOf(seed).fast === 'true' };
  };
  for (const e of models) {
    const vs = e.variants.filter((v) => v.legacySlug === id);
    if (vs.length) return as(e, vs, '');
  }
  const [family, effort] = splitID(id);
  for (const e of models) {
    const vs = e.variants.filter((v) => v.legacySlug && splitID(v.legacySlug)[0] === family);
    if (vs.length) return as(e, vs, effort);
  }
  for (const e of models) {
    const m = e.model;
    if ([m.name, ...(m.legacySlugs ?? []), ...(m.idAliases ?? [])].includes(id)) {
      return { entry: at(e, e.def), seed: undefined, effort: '', fast: false };
    }
  }
  return null;
}

/**
 * How a chat's model is asked of Cursor: the variant's own id, its parameters and its mode.
 * An id the list doesn't have that is one of Cursor's own goes as the variant it names;
 * anything else goes as it is named (`auto` → Cursor's `default`).
 */
export function requestModel(
  raw: OfferedModel[],
  model: string,
  effort: string,
  fast: boolean | undefined,
): CursorRequestModel {
  const entry = raw.find((m) => m.id === model);
  if (entry) return pick(entry, effort, fast);
  const old = named(raw, model);
  if (old) return pick(old.entry, effort || old.effort, fast || old.fast, old.seed);
  return { id: model === 'auto' ? 'default' : model, params: [], maxMode: false };
}

/** Whether an offered model takes a reasoning effort (a UI hint). */
export const offersReasoning = (m: OfferedModel): boolean => Object.keys(m.levels).length > 0;
