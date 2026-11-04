import { describe, expect, it } from 'vitest';
import { requireChatImages } from '../chatImages';
import { WORKBENCH_LIMITS } from '../../../shared/workbench';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000', 'latin1').toString('base64');
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP', 'latin1').toString('base64');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('chat image validation', () => {
  it('accepts the four vendor-safe types whose bytes match their signature', () => {
    expect(requireChatImages(undefined)).toEqual([]);
    const images = [
      { mimeType: 'image/png', data: PNG },
      { mimeType: 'image/jpeg', data: JPEG },
      { mimeType: 'image/gif', data: GIF },
      { mimeType: 'image/webp', data: WEBP },
    ];
    expect(requireChatImages(images)).toEqual(images);
    // Extra fields from the renderer are not passed on.
    expect(requireChatImages([{ mimeType: 'image/png', data: PNG, path: '/etc/passwd' }])).toEqual([
      { mimeType: 'image/png', data: PNG },
    ]);
  });

  it('refuses anything off instead of dropping it', () => {
    const bad: unknown[] = [
      'x',
      [null],
      [{ mimeType: 'image/svg+xml', data: PNG }],
      [{ mimeType: 'image/png', data: '' }],
      [{ mimeType: 'image/png', data: `data:image/png;base64,${PNG}` }],
      [{ mimeType: 'image/png', data: `${PNG}\n` }],
      [{ mimeType: 'image/png', data: JPEG }],
      [{ mimeType: 'image/jpeg', data: 7 }],
      [{ mimeType: 'image/png', data: 'A'.repeat(WORKBENCH_LIMITS.chatImageBase64 + 4) }],
      Array.from({ length: WORKBENCH_LIMITS.chatImages + 1 }, () => ({ mimeType: 'image/png', data: PNG })),
    ];
    for (const raw of bad) expect(codeOf(() => requireChatImages(raw))).toBe('INVALID_PARAMS');
  });
});
