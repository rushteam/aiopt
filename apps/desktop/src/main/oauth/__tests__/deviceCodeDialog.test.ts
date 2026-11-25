import { describe, expect, it } from 'vitest';
import { buildDeviceCodeDialog, DEVICE_CODE_LABELS } from '../deviceCodeDialog';

describe('device-code dialog', () => {
  it('shows the code and the verification host', () => {
    const d = buildDeviceCodeDialog('en', { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    expect(d.message).toContain('ABCD-1234');
    expect(d.detail).toContain('github.com');
    expect(d.detail).not.toContain('{host}');
  });

  it('localizes and falls back to English', () => {
    const p = { userCode: 'X', verificationUri: 'https://github.com/login/device' };
    expect(buildDeviceCodeDialog('zh-CN', p).cancel).toBe('取消');
    expect(buildDeviceCodeDialog('xx', p).cancel).toBe('Cancel');
    for (const l of Object.values(DEVICE_CODE_LABELS)) {
      expect(l.message).toContain('{code}');
      expect(l.detail).toContain('{host}');
    }
  });
});
