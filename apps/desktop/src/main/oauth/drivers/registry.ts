import { throwIpcError } from '../../ipc/validate';
import {
  isOAuthStubKind,
  type OAuthSubscriptionKind,
} from '../../../shared/oauthProviders';
import { genericPkceDriver } from './genericPkce';
import type { OAuthDriver } from './types';

function stubDriver(kind: OAuthSubscriptionKind): OAuthDriver {
  return {
    kind,
    buildAuthorizeUrl() {
      throwIpcError(
        'UNSUPPORTED_CAPABILITY',
        'this subscription OAuth driver is not enabled in this build yet',
      );
    },
    async exchangeCode() {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'this subscription OAuth driver is not enabled in this build yet');
    },
  };
}

const DRIVERS: Record<OAuthSubscriptionKind, OAuthDriver> = {
  generic_pkce: genericPkceDriver,
  openai_codex: stubDriver('openai_codex'),
  anthropic_claude: stubDriver('anthropic_claude'),
  github_copilot: stubDriver('github_copilot'),
};

export function getOAuthDriver(kind: OAuthSubscriptionKind): OAuthDriver {
  return DRIVERS[kind];
}

export function isStubOAuthKind(kind: OAuthSubscriptionKind): boolean {
  return isOAuthStubKind(kind);
}
