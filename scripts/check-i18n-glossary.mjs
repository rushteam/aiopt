#!/usr/bin/env node
/**
 * i18n glossary consistency gate.
 *
 * The primitive: the glossary (i18n/glossary.json) is the single source of truth for how a
 * product term is rendered in each locale. This gate ensures the same concept is translated
 * consistently everywhere, and that the human-readable GLOSSARY.md never drifts from the JSON.
 *
 * What it checks, against every desktop renderer locale JSON (apps/desktop/src/renderer/
 * i18n/locales/<locale>/common.json):
 *  1. forbidden — a term's banned rendering in a given locale (e.g. an off-brand translation).
 *  2. doc sync — i18n/GLOSSARY.md must equal what the generator would produce.
 *
 * Severity:
 *  - status=decided term with a forbidden hit → blocks (exit 1).
 *  - status=proposed term with a forbidden hit → warns only. `proposed` carries "known but
 *    not yet adjudicated" terms so the list is visible and discussable, rather than letting
 *    the script unilaterally decide product wording.
 *
 * This is a deliberately small, self-contained version of the primitive: enough to enforce
 * "terms are adjudicated in one place, and the gate holds the line" without the baseline /
 * punctuation / multi-app machinery a mature product accretes. Extend it as the app grows.
 *
 * Usage:
 *   node scripts/check-i18n-glossary.mjs            # check (root: pnpm check:i18n-glossary)
 *   node scripts/check-i18n-glossary.mjs --report   # print full detail, do not block
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDocEol, renderGlossaryDoc } from './shared/glossary-doc.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOSSARY_PATH = path.join(repoRoot, 'i18n', 'glossary.json');
const DOC_PATH = path.join(repoRoot, 'i18n', 'GLOSSARY.md');
const DESKTOP_LOCALES = path.join(repoRoot, 'apps', 'desktop', 'src', 'renderer', 'i18n', 'locales');

const SUPPORTED_SCHEMA_VERSION = 1;
const REPORT_ONLY = process.argv.includes('--report');

function fail(message) {
  console.error(`[check-i18n-glossary] ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`failed to read / parse: ${path.relative(repoRoot, file)}\n  ${err.message}`);
  }
}

const glossary = readJson(GLOSSARY_PATH);
if (glossary.version !== SUPPORTED_SCHEMA_VERSION) {
  fail(
    `glossary.json version=${glossary.version}; this script supports only ${SUPPORTED_SCHEMA_VERSION}. ` +
      `Update the script in lockstep when bumping the schema — do not let the version drift silently.`,
  );
}
if (!Array.isArray(glossary.locales) || glossary.locales.length === 0) {
  fail('glossary.json: "locales" must be a non-empty array.');
}
if (!glossary.locales.includes(glossary.sourceLocale)) {
  fail(`glossary.json: sourceLocale "${glossary.sourceLocale}" is not listed in locales.`);
}

// Locale-keyed fields whose keys must fall inside glossary.locales. A misspelled locale key
// (e.g. zh_CN instead of zh-CN) would make the whole rule silently vanish — a rule that is
// written, appears to be checked, but never fires.
const declaredLocales = new Set(glossary.locales);
const localeKeyErrors = [];
for (const term of glossary.terms) {
  if (term.status !== 'decided' && term.status !== 'proposed') {
    fail(`term ${term.id}: status "${term.status}" is invalid; must be "decided" or "proposed".`);
  }
  for (const field of ['translations', 'forbidden']) {
    for (const locale of Object.keys(term[field] ?? {})) {
      if (!declaredLocales.has(locale)) {
        localeKeyErrors.push(
          `term ${term.id} ${field}.${locale}: "${locale}" is not in locales [${glossary.locales.join(', ')}]`,
        );
      }
    }
  }
}
if (localeKeyErrors.length > 0) {
  fail(`unreachable locale keys (a misspelled key silently disables the whole rule):\n${localeKeyErrors.map((e) => `  - ${e}`).join('\n')}`);
}

/** Recursively flatten nested JSON into Map<'a.b.c', string>. */
function flatten(obj, prefix, out) {
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, keyPath, out);
    } else if (typeof value === 'string') {
      out.set(keyPath, value);
    }
  }
  return out;
}

function loadLocale(locale) {
  const out = new Map();
  const file = path.join(DESKTOP_LOCALES, locale, 'common.json');
  if (fs.existsSync(file)) {
    for (const [k, v] of flatten(readJson(file), '', new Map())) out.set(k, v);
  }
  return out;
}

const corpus = new Map(glossary.locales.map((l) => [l, loadLocale(l)]));

const violations = [];
for (const term of glossary.terms) {
  const severity = term.status === 'decided' ? 'error' : 'warn';
  for (const locale of glossary.locales) {
    const entries = corpus.get(locale);
    for (const bad of term.forbidden?.[locale] ?? []) {
      for (const [key, value] of entries) {
        if (!value.includes(bad)) continue;
        violations.push({
          locale,
          key,
          severity,
          termId: term.id,
          // Deliberately no replacement target: the glossary is a reference, not a
          // find-and-replace table. The preferred rendering is in GLOSSARY.md, but which
          // rendering fits this specific string depends on its context. The gate reports the
          // problem; a human (or an agent reading the context) decides the wording.
          hint: `"${bad}" is a forbidden rendering of ${term.en}; see i18n/GLOSSARY.md for the ${term.en} entry`,
        });
      }
    }
  }
}

violations.sort((a, b) => `${a.locale}\t${a.key}\t${a.termId}`.localeCompare(`${b.locale}\t${b.key}\t${b.termId}`));

const blocking = violations.filter((v) => v.severity === 'error');
const warnings = violations.filter((v) => v.severity === 'warn');

function print(list, label, log) {
  if (list.length === 0) return;
  log(`\n[check-i18n-glossary] ${label} ${list.length}:`);
  for (const v of list.slice(0, REPORT_ONLY ? Infinity : 40)) {
    log(`  ${v.locale}  ${v.key}`);
    log(`      ${v.hint}`);
  }
}

print(blocking, '❌ forbidden-term violations', console.error);
if (warnings.length > 0) {
  console.warn(`\n[check-i18n-glossary] ⚠️ proposed-term hits ${warnings.length} (status=proposed, non-blocking):`);
  for (const v of warnings.slice(0, REPORT_ONLY ? Infinity : 40)) {
    console.warn(`  ${v.locale}  ${v.key}  (${v.termId})`);
  }
}

// GLOSSARY.md is the entry point humans and agents read; stale is worse than missing, because
// people follow the stale table. Compared with the exact renderer, not a fuzzy match.
const docStale = fs.existsSync(DOC_PATH)
  ? normalizeDocEol(fs.readFileSync(DOC_PATH, 'utf8')) !== normalizeDocEol(renderGlossaryDoc(glossary))
  : true;
if (docStale) {
  console.error(
    '\n[check-i18n-glossary] ❌ i18n/GLOSSARY.md is out of sync with i18n/glossary.json (or missing).\n' +
      '  Run `pnpm glossary:generate` to regenerate.',
  );
}

if (REPORT_ONLY) {
  console.log(
    `\n[check-i18n-glossary] report: blocking ${blocking.length} / proposed ${warnings.length} / ` +
      `doc ${docStale ? 'stale' : 'in sync'}`,
  );
  process.exit(0);
}

if (blocking.length > 0 || docStale) {
  console.error(
    `\n[check-i18n-glossary] failed: ${blocking.length} forbidden-term violation(s)` +
      `${docStale ? ' / doc out of sync' : ''}. Adjudications live in i18n/glossary.json; the readable view is i18n/GLOSSARY.md.`,
  );
  process.exit(1);
}

const decided = glossary.terms.filter((t) => t.status === 'decided').length;
const proposed = glossary.terms.length - decided;
console.log(
  `[check-i18n-glossary] ✅ ${decided} decided / ${proposed} proposed term(s), ` +
    `${glossary.locales.join(' / ')} — no violations` +
    (warnings.length > 0 ? ` (${warnings.length} proposed-term warning(s))` : ''),
);
