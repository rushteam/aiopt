import { describe, expect, it } from 'vitest';
import { fitEffort, modelsOf, requestModel, splitID, tokensOf, type PickerModel } from '../cursor/models';

const opus: PickerModel = {
  name: 'claude-opus',
  clientDisplayName: 'Claude Opus',
  supportsAgent: true,
  contextTokenLimit: 200_000,
  parameterDefinitions: [
    { id: 'effort', parameterType: { enumParameter: { values: [{ value: 'low' }, { value: 'high' }] } } },
  ],
  variants: [
    { legacySlug: 'claude-opus-low', isDefaultNonMaxConfig: true, parameterValues: [{ id: 'effort', value: 'low' }] },
    { legacySlug: 'claude-opus-high', parameterValues: [{ id: 'effort', value: 'high' }] },
  ],
};
const gpt: PickerModel = {
  name: 'gpt-5',
  supportsAgent: true,
  parameterDefinitions: [
    { id: 'context', parameterType: { enumParameter: { values: [{ value: '272k' }, { value: '1m' }] } } },
  ],
  variants: [
    { legacySlug: 'gpt-5', parameterValues: [{ id: 'context', value: '272k' }], isDefaultNonMaxConfig: true },
    { legacySlug: 'gpt-5-1m', isMaxMode: true, parameterValues: [{ id: 'context', value: '1m' }] },
  ],
};
const picker: PickerModel[] = [
  { name: 'default', clientDisplayName: 'Auto', supportsAgent: true },
  opus,
  gpt,
  { name: 'hidden', isHidden: true },
  { name: 'gemini-2.5-flash', supportsAgent: true },
];

describe('cursor model ids', () => {
  it('splits a family and its effort', () => {
    expect(splitID('claude-opus-high')).toEqual(['claude-opus', 'high']);
    expect(splitID('gpt-5-extra-high-fast')).toEqual(['gpt-5-fast', 'xhigh']);
    expect(splitID('claude-thinking-high')).toEqual(['claude-thinking', 'high']);
  });

  it('reads context sizes and fits efforts', () => {
    expect(tokensOf('272k')).toBe(272_000);
    expect(tokensOf('1m')).toBe(1_000_000);
    expect(fitEffort('medium', ['low', 'high'])).toBe('high');
    expect(fitEffort('ultra', ['max', 'high'])).toBe('max');
  });
});

describe('modelsOf', () => {
  it('offers agent models, one per context size, skipping hidden and skipped ones', () => {
    const raw = modelsOf(picker, null);
    expect(raw.map((m) => m.id)).toEqual(['auto', 'claude-opus', 'gpt-5@272k', 'gpt-5@1m']);
    expect(raw.find((m) => m.id === 'gpt-5@1m')!.context).toBe(1_000_000);
  });

  it('keeps only variants the account is served', () => {
    const raw = modelsOf(picker, new Set(['gpt-5']));
    expect(raw.map((m) => m.id)).toContain('gpt-5@272k');
    expect(raw.map((m) => m.id)).not.toContain('gpt-5@1m');
  });
});

describe('requestModel', () => {
  const raw = modelsOf(picker, null);

  it('picks the variant for a requested effort', () => {
    expect(requestModel(raw, 'claude-opus', 'high', undefined)).toMatchObject({ id: 'claude-opus-high', maxMode: false });
    expect(requestModel(raw, 'claude-opus', '', undefined).id).toBe('claude-opus-low');
  });

  it('turns on Max Mode for a max-only variant', () => {
    expect(requestModel(raw, 'gpt-5@1m', '', undefined)).toMatchObject({ id: 'gpt-5-1m', maxMode: true });
  });

  it("reads one of Cursor's own ids, and passes unknown ones through", () => {
    expect(requestModel(raw, 'claude-opus-high', '', undefined).id).toBe('claude-opus-high');
    expect(requestModel(raw, 'auto', '', undefined).id).toBe('default');
    expect(requestModel([], 'auto', '', undefined)).toEqual({ id: 'default', params: [], maxMode: false });
    expect(requestModel([], 'mystery', '', undefined).id).toBe('mystery');
  });
});
