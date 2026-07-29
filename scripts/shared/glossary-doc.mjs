// Single source of truth for rendering i18n/GLOSSARY.md from i18n/glossary.json.
//
// Both the generator (generate-glossary-doc.mjs) and the gate (check-i18n-glossary.mjs)
// import this, so "generate" and "is it in sync" can never drift apart: the gate compares
// the committed doc against exactly what the generator would write.

/** Normalize line endings before comparison, so CRLF vs LF never trips the sync check. */
export function normalizeDocEol(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

/**
 * Render the human-readable glossary doc. Deterministic: same glossary in, same bytes out.
 * Terms are grouped by status (decided first) and sorted by id so the diff is stable.
 */
export function renderGlossaryDoc(glossary) {
  const lines = [];
  lines.push('# Glossary');
  lines.push('');
  lines.push('> Generated from `i18n/glossary.json` by `pnpm glossary:generate`. Do not edit by hand —');
  lines.push('> the gate `pnpm check:i18n-glossary` fails if this file is out of sync with the JSON.');
  lines.push('');
  lines.push(
    'Product terms with an adjudicated translation. `decided` terms are enforced (a forbidden ' +
      'rendering fails CI); `proposed` terms are under discussion and only warn.',
  );
  lines.push('');
  lines.push(`Source locale: \`${glossary.sourceLocale}\`. Locales: ${glossary.locales.map((l) => `\`${l}\``).join(', ')}.`);
  lines.push('');

  const byStatus = (status) =>
    glossary.terms
      .filter((t) => t.status === status)
      .slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  for (const [status, heading] of [
    ['decided', 'Decided'],
    ['proposed', 'Proposed (under discussion)'],
  ]) {
    const terms = byStatus(status);
    if (terms.length === 0) continue;
    lines.push(`## ${heading}`);
    lines.push('');
    for (const term of terms) {
      lines.push(`### ${term.en} (\`${term.id}\`)`);
      lines.push('');
      if (term.note) {
        lines.push(term.note);
        lines.push('');
      }
      const translations = term.translations ?? {};
      for (const locale of glossary.locales) {
        if (locale === glossary.sourceLocale) continue;
        const preferred = translations[locale];
        if (preferred) lines.push(`- **${locale}**: ${preferred}`);
        const forbidden = term.forbidden?.[locale] ?? [];
        if (forbidden.length > 0) {
          lines.push(`  - forbidden: ${forbidden.map((f) => `\`${f}\``).join(', ')}`);
        }
      }
      lines.push('');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
