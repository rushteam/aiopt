import { describe, expect, it } from 'vitest';
import {
  isTrustedAppRendererEventForLocation,
  isTrustedAppRendererUrl,
  type TrustedRendererLocation,
  type TrustedSenderEventLike,
  type TrustedSenderFrameLike,
} from '../trustedSender';

const DEV: TrustedRendererLocation = {
  devServerUrl: 'http://localhost:5173',
  packagedAppUrl: 'hearth://main/index.html',
};
const PACKAGED: TrustedRendererLocation = {
  devServerUrl: null,
  packagedAppUrl: 'hearth://main/index.html',
};

function frame(url: string, parent: TrustedSenderFrameLike | null = null): TrustedSenderFrameLike {
  return { url, parent };
}
// A top-level frame is its own senderMainFrame.
function topLevelEvent(url: string): TrustedSenderEventLike {
  const f = frame(url);
  return { senderFrame: f, senderMainFrame: f };
}

describe('isTrustedAppRendererUrl', () => {
  it('dev: accepts same-origin, rejects other origins', () => {
    expect(isTrustedAppRendererUrl('http://localhost:5173/x', DEV)).toBe(true);
    expect(isTrustedAppRendererUrl('http://localhost:9999/x', DEV)).toBe(false);
    expect(isTrustedAppRendererUrl('https://evil.example/', DEV)).toBe(false);
  });

  it('packaged: accepts the exact app URL only', () => {
    expect(isTrustedAppRendererUrl('hearth://main/index.html', PACKAGED)).toBe(true);
    expect(isTrustedAppRendererUrl('hearth://main/other.html', PACKAGED)).toBe(false);
    expect(isTrustedAppRendererUrl('file:///etc/passwd', PACKAGED)).toBe(false);
  });

  it('fails closed on an unparseable URL', () => {
    expect(isTrustedAppRendererUrl('not a url', DEV)).toBe(false);
  });
});

describe('isTrustedAppRendererEventForLocation', () => {
  it('accepts the top-level app frame', () => {
    expect(isTrustedAppRendererEventForLocation(topLevelEvent('http://localhost:5173/'), DEV)).toBe(
      true,
    );
  });

  it('rejects a sub-frame even at the app origin', () => {
    const main = frame('http://localhost:5173/');
    const child = frame('http://localhost:5173/iframe', main);
    expect(
      isTrustedAppRendererEventForLocation({ senderFrame: child, senderMainFrame: main }, DEV),
    ).toBe(false);
  });

  it('rejects when the frame is not the main frame', () => {
    const main = frame('http://localhost:5173/');
    const other = frame('http://localhost:5173/');
    expect(
      isTrustedAppRendererEventForLocation({ senderFrame: other, senderMainFrame: main }, DEV),
    ).toBe(false);
  });

  it('rejects a missing frame', () => {
    expect(
      isTrustedAppRendererEventForLocation({ senderFrame: null, senderMainFrame: null }, DEV),
    ).toBe(false);
  });

  it('rejects the top-level frame navigated off-origin', () => {
    expect(isTrustedAppRendererEventForLocation(topLevelEvent('https://evil.example/'), DEV)).toBe(
      false,
    );
  });
});
