#!/usr/bin/env node
// DCO (Developer Certificate of Origin) gate: verifies every non-exempt commit in a range
// carries a Signed-off-by trailer whose name and email match the commit's author (or
// committer). The full DCO text is in the DCO file at the repository root; the contributor-
// facing explanation is in CONTRIBUTING.md.
//
// Only the commits a PR introduces are checked (merge-base..head); repository history is not
// re-audited, so commits from before DCO was adopted are unaffected. Reads git metadata
// only — no network, no private config, no credentials.
//
// The authoritative gate on a PR is the DCO GitHub App's check (configured in
// .github/dco.yml); this script is the local pre-commit self-check, deliberately aligned
// with the App or stricter, so that passing locally means passing on the PR.
//
// Local usage:
//   pnpm check:dco                                  check origin/main..HEAD
//   node scripts/check-dco.mjs --base <ref> --head <ref>
// When run on a pull_request event (GITHUB_EVENT_PATH present) the range is taken from the
// payload's base.sha and head.sha automatically.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isSignOffHookInstalled } from './install-dco-hook.mjs';

// Field/record separators for git log: ASCII control chars, so they never collide with
// commit message content.
const FIELD_SEP = '';
const RECORD_SEP = '';
const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%cn', '%ce', '%B'].join(FIELD_SEP) + RECORD_SEP;

// Matcher aligned verbatim with the DCO App (dcoapp/app `lib/dco.js`:
// `/^Signed-off-by: (.*) <(.*)>\s*$/gim`). Matched per line rather than requiring the
// trailer at the very end — other trailers (Co-authored-by, etc.) often follow it.
//
// Three things deliberately not relaxed, because each would produce "green locally, red on
// the PR":
// - no leading whitespace: the App anchors `^Signed-off-by:` at line start, so an indented
//   line is not a sign-off in its eyes.
// - exactly one space after `Signed-off-by:`: with two spaces the App folds the extra space
//   into the name, so the name no longer matches the author.
// - captured values are not trimmed (see validateCommit): the App compares raw captures,
//   so `Alice ` does not equal `Alice`.
const SIGN_OFF_LINE = /^Signed-off-by: (.*) <(.*)>\s*$/i;

// Shape of bot addresses: dependabot etc. use `<name>[bot]@users.noreply.github.com`, and
// the GitHub Web UI uses web-flow's noreply@github.com.
//
// **This is used only to annotate failure output, never to exempt.** The App decides bot
// status from the GitHub account type (`author.type === "Bot"`), which is unavailable and
// unforgeable offline; an author email, by contrast, can be set to anything. Exempting by
// email would leave a forgeable backdoor in the local check, in the worst direction —
// "green locally, red on the PR". So we always check, and only note in the output that a
// real bot would be exempt by the App.
const BOT_EMAILS = new Set(['noreply@github.com']);
const BOT_EMAIL_SUFFIX = '[bot]@users.noreply.github.com';

// Local default bases. upstream/main is first: when working from a fork, origin/main can be
// ahead of upstream, and using it as the base would drop the fork's own unsigned commits
// out of range even though the PR's true base is upstream. This is only a local heuristic —
// the real base is whatever the DCO check on the PR uses — so the base actually used is
// printed on success.
const DEFAULT_BASE_CANDIDATES = ['upstream/main', 'origin/main', 'main'];

const git = (args, options = {}) =>
  execFileSync('git', args, { encoding: 'utf8', ...options }).trim();

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

// Email shape: aligned with validator.isEmail's default rules, which the DCO App uses.
// - local part limited to RFC 5322 atext, dot-separated, no leading/trailing/consecutive
//   dots. atext excludes parentheses, brackets, quotes, so `a(b)@x.com` is rejected — the
//   validator rejects it too.
// - each domain label may not start or end with a hyphen, no underscores, and there must be
//   an alphabetic TLD (so the `user@hostname` git auto-generates when user.email is unset
//   is rejected).
// This cannot mirror the validator line for line, and is deliberately biased strict: better
// a local false positive than passing an address the App would reject, which is the
// "green locally, red on the PR" failure. Bot emails containing brackets (dependabot etc.)
// likewise violate atext, so those commits are reported locally — while the App skips them
// because the account is a Bot. The conclusion differs but the direction is safe (red
// locally, green on the PR), and the failure output explains this.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const EMAIL_LOCAL_PART = new RegExp(`^${ATEXT}+(?:\\.${ATEXT}+)*$`);
const EMAIL_DOMAIN = new RegExp(`^${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*\\.[A-Za-z]{2,}$`);
// validator.isEmail length limits; over these it rejects. The total limit is separate:
// a compliant local part plus a compliant domain can still exceed 254 combined.
const MAX_TOTAL = 254;
const MAX_LOCAL_PART = 64;
const MAX_DOMAIN = 254;
const MAX_DOMAIN_LABEL = 63;

export function looksLikeEmail(email) {
  const value = String(email ?? '').trim();
  if (value.length > MAX_TOTAL) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return false;

  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (localPart.length > MAX_LOCAL_PART || domain.length > MAX_DOMAIN) return false;
  if (domain.split('.').some((label) => label.length > MAX_DOMAIN_LABEL)) return false;

  return EMAIL_LOCAL_PART.test(localPart) && EMAIL_DOMAIN.test(domain);
}

/**
 * Extract every Signed-off-by line from a message. Captures are kept raw, not trimmed — the
 * App does not trim either, and extra whitespace makes it fail to match the author, so
 * failing here in lockstep avoids "green locally, red on the PR".
 */
export function parseSignOffs(message) {
  const signOffs = [];
  for (const line of String(message ?? '').split(/\r?\n/)) {
    const match = SIGN_OFF_LINE.exec(line);
    if (match) signOffs.push({ name: match[1], email: match[2] });
  }
  return signOffs;
}

/** Only judges "the address looks like a bot", for failure output; not an exemption. */
export function looksLikeBotAddress(email) {
  const normalizedEmail = normalizeEmail(email);
  return BOT_EMAILS.has(normalizedEmail) || normalizedEmail.endsWith(BOT_EMAIL_SUFFIX);
}

/**
 * Returns an exemption reason, or null if not exempt.
 *
 * Only merge commits can be judged reliably offline (parent count), so only they are
 * exempted. Bot commits are left to the App to exempt by account type — locally we would
 * rather report one extra than trust a forgeable identity.
 */
export function exemptReason(commit) {
  if (commit.parents.length > 1) return 'merge commit';
  return null;
}

/**
 * Returns a list of errors; an empty list means the commit passes. Aligned with the DCO App
 * (dcoapp/app `lib/dco.js`), stricter in two places — being strict only causes "red locally,
 * green on the PR", while being lax causes "green locally, red on the PR", which is what we
 * avoid:
 *
 * 1. The sign-off must match author or committer as one whole identity. The App splits name
 *    and email into two sets and checks each independently, so with author=Alice<a@x> and
 *    committer=Bob<b@x> a sign-off `Alice <b@x>` passes even though that identity never
 *    existed — here name+email are compared as a pair.
 * 2. Email shape: see looksLikeEmail.
 *
 * This script likewise does not recognize remediation commits (enabled App-side in
 * .github/dco.yml) — same tradeoff. Contributor-facing text is in English.
 */
export function validateCommit(commit) {
  const signOffs = parseSignOffs(commit.message);
  if (signOffs.length === 0) {
    return ['No Signed-off-by trailer.'];
  }

  // Same as the App: use author.email (falling back to committer.email). "Fail only if both
  // are invalid" would be laxer than the App and reintroduce green-locally/red-on-PR.
  const email = commit.authorEmail || commit.committerEmail;
  if (!looksLikeEmail(email)) {
    return [`${email} is not a valid email address.`];
  }

  const identities = [
    { name: normalizeName(commit.authorName), email: normalizeEmail(commit.authorEmail) },
    { name: normalizeName(commit.committerName), email: normalizeEmail(commit.committerEmail) },
  ];
  // The sign-off side is lowercased but not trimmed (as the App does); the commit side is
  // trimmed, which is safe because git idents carry no surrounding whitespace. The two sides
  // are handled differently on purpose, so that "Alice " also fails locally.
  const matches = (signOff) =>
    identities.some(
      (identity) =>
        identity.name === String(signOff.name).toLowerCase() &&
        identity.email === String(signOff.email).toLowerCase()
    );
  if (signOffs.some(matches)) return [];

  const got = signOffs.map((signOff) => `"${signOff.name} <${signOff.email}>"`).join(', ');
  return [
    `Expected a sign-off from "${commit.authorName} <${commit.authorEmail}>" or ` +
      `"${commit.committerName} <${commit.committerEmail}>", got ${got}. ` +
      'The name and the address have to match one of them as a whole.',
  ];
}

export function validateCommits(commits) {
  const failures = [];
  const exempted = [];
  let checked = 0;

  for (const commit of commits) {
    const reason = exemptReason(commit);
    if (reason) {
      exempted.push({ commit, reason });
      continue;
    }
    checked += 1;
    const errors = validateCommit(commit);
    if (errors.length > 0) failures.push({ commit, errors });
  }

  return { failures, exempted, checked };
}

export function parseGitLog(stdout) {
  return String(stdout)
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\r?\n/, ''))
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [sha, parents, authorName, authorEmail, committerName, committerEmail, message] =
        record.split(FIELD_SEP);
      return {
        sha: (sha ?? '').trim(),
        parents: (parents ?? '').trim() ? parents.trim().split(/\s+/) : [],
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        committerName: committerName ?? '',
        committerEmail: committerEmail ?? '',
        message: message ?? '',
      };
    });
}

export function shortSha(sha) {
  return String(sha ?? '').slice(0, 8);
}

export function subjectOf(commit) {
  return String(commit.message ?? '').split(/\r?\n/, 1)[0].trim();
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function revParse(ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Resolve the range to check. The returned start is an exclusive endpoint (start..head). */
function resolveRange() {
  const explicitBase = readArg('--base');
  const explicitHead = readArg('--head');
  const eventPath = process.env.GITHUB_EVENT_PATH;

  let base = explicitBase;
  let head = explicitHead ?? 'HEAD';

  if (!base && eventPath) {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const pr = event.pull_request;
    if (!pr) throw new Error('Event payload has no pull_request; check the workflow trigger.');
    base = pr.base?.sha;
    head = explicitHead ?? pr.head?.sha ?? 'HEAD';
    if (!base) throw new Error('Event payload is missing pull_request.base.sha.');
  }

  if (!base) {
    base = DEFAULT_BASE_CANDIDATES.find((candidate) => revParse(candidate));
    if (!base) {
      throw new Error(
        `No default base ref found (${DEFAULT_BASE_CANDIDATES.join(' / ')}); pass --base <ref>.`
      );
    }
  }

  const baseSha = revParse(base);
  if (!baseSha) throw new Error(`Cannot resolve base ref: ${base} (fetch it first if missing).`);
  const headSha = revParse(head);
  if (!headSha) throw new Error(`Cannot resolve head ref: ${head}.`);

  // Use merge-base rather than the base itself: while a PR is open the base branch moves on,
  // and base.sha..head would fold in other people's commits from the base side (false
  // positives).
  let start = baseSha;
  try {
    start = git(['merge-base', baseSha, headSha]);
  } catch {
    // No common ancestor (e.g. an orphan branch): fall back to the base itself.
  }

  return { start, head: headSha, baseRef: base };
}

function reportFailures({ failures, start }) {
  const plural = failures.length === 1 ? 'commit' : 'commits';
  console.error(`DCO check failed: ${failures.length} ${plural} without a valid Signed-off-by.\n`);
  for (const { commit, errors } of failures) {
    console.error(`- ${shortSha(commit.sha)} ${subjectOf(commit)}`);
    for (const error of errors) console.error(`  ${error}`);
    if (looksLikeBotAddress(commit.authorEmail)) {
      console.error('  This looks like a bot address. Bot commits are exempt on the pull request,');
      console.error('  where the DCO App can check the GitHub account type — this check cannot,');
      console.error('  so it reports them rather than trusting a forgeable address.');
    }
  }
  // Full SHAs: short SHAs can be ambiguous in a large repo and break copy-pasted commands.
  console.error('\nHow to fix, on your pull request branch:');
  console.error('  most recent commit only:  git commit --amend -s --no-edit');
  console.error(`  several commits:          git rebase --signoff ${start}`);
  console.error('  then update the PR:       git push --force-with-lease');
  console.error('\nTo stop forgetting, commit with `git commit -s`, or install the hook shipped');
  console.error('with this repository once: `pnpm dco:install-hook` (.githooks/prepare-commit-msg).');
  console.error('The DCO file at the repository root states what the sign-off certifies;');
  console.error('CONTRIBUTING.md explains the requirement in full.');
}

function main() {
  const { start, head, baseRef } = resolveRange();
  const stdout = execFileSync('git', ['log', `--format=${LOG_FORMAT}`, `${start}..${head}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const commits = parseGitLog(stdout);

  if (commits.length === 0) {
    console.log(`No new commits in ${shortSha(start)}..${shortSha(head)}; nothing to check.`);
    return;
  }

  const { failures, exempted, checked } = validateCommits(commits);
  if (failures.length > 0) {
    reportFailures({ failures, start });
    process.exit(1);
  }

  const exemptNote = exempted.length > 0 ? `, ${exempted.length} exempt (merge commits)` : '';
  console.log(
    `DCO check passed: ${checked} ${checked === 1 ? 'commit' : 'commits'} signed off${exemptNote} ` +
      `— range ${shortSha(start)}..${shortSha(head)} (base ${baseRef}).`
  );

  if (!process.env.GITHUB_EVENT_PATH && !isSignOffHookInstalled()) {
    console.log('Tip: `pnpm dco:install-hook` signs off local commits automatically.');
  }
}

// Run only when invoked as an entry point; when imported, export pure functions for tests.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
