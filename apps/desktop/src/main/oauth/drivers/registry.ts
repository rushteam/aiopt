import type { OAuthSubscriptionKind } from '../../../shared/oauthProviders';
import { anthropicClaudeDriver } from './anthropicClaude';
import { genericPkceDriver } from './genericPkce';
import { githubCopilotDriver } from './githubCopilot';
import { huaweiCodeartsDriver } from './huaweiCodearts';
import { openaiCodexDriver } from './openaiCodex';
import type { OAuthDriver } from './types';

const DRIVERS: Record<OAuthSubscriptionKind, OAuthDriver> = {
  generic_pkce: genericPkceDriver,
  openai_codex: openaiCodexDriver,
  anthropic_claude: anthropicClaudeDriver,
  github_copilot: githubCopilotDriver,
  huawei_codearts: huaweiCodeartsDriver,
};

export function getOAuthDriver(kind: OAuthSubscriptionKind): OAuthDriver {
  return DRIVERS[kind];
}
