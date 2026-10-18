import { describe, expect, it } from 'vitest';
import { buildCanonicalRequest, hmacSha256Hex, sha256Hex, signRequestHuawei } from '../sign';

describe('codearts sign',
  () => {
    it('builds the Huawei canonical request',
      () => {
        const headers = new Map([
          ['content-type', 'application/json'],
          ['host', 'example.com'],
          ['x-sdk-date', '20260101T000000Z'],
        ]);
        const canonical = buildCanonicalRequest(
          'POST',
          '/api/v2/',
          '',
          headers,
          'abc',
        );
        expect(canonical).toBe(
          [
            'POST',
            '/api/v2/',
            '',
            'content-type:application/json',
            'host:example.com',
            'x-sdk-date:20260101T000000Z',
            '',
            'content-type;host;x-sdk-date',
            'abc',
          ].join('\n'),
        );
      });

    it('signs a POST and includes maas_type in SignedHeaders',
      () => {
        const headers = signRequestHuawei({
          accessKeyId: 'AK',
          secretAccessKey: 'SK',
          securityToken: 'ST',
          method: 'POST',
          url: 'https://example.com/api/v2/chat/completions',
          body: '{"model":"glm-5.3-flash"}',
          extraHeaders: { maas_type: 'benefit' },
          dateStamp: '20260101T000000Z',
        });
        expect(headers['x-security-token']).toBe('ST');
        expect(headers.maas_type).toBe('benefit');
        expect(headers['content-type']).toBe('application/json');
        expect(headers.Authorization).toMatch(/^SDK-HMAC-SHA256 Access=AK,/);
        expect(headers.Authorization).toContain('maas_type');
        expect(headers.Authorization).toContain(
          `Signature=${hmacSha256Hex(
            'SK',
            `SDK-HMAC-SHA256\n20260101T000000Z\n${sha256Hex(
              buildCanonicalRequest(
                'POST',
                '/api/v2/chat/completions/',
                '',
                new Map([
                  ['content-type', 'application/json'],
                  ['host', 'example.com'],
                  ['maas_type', 'benefit'],
                  ['x-sdk-content-sha256', sha256Hex('{"model":"glm-5.3-flash"}')],
                  ['x-sdk-date', '20260101T000000Z'],
                  ['x-security-token', 'ST'],
                ]),
                sha256Hex('{"model":"glm-5.3-flash"}'),
              ),
            )}`,
          )}`,
        );
      });
  });
