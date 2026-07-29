#!/usr/bin/env node
// Regenerate i18n/GLOSSARY.md from i18n/glossary.json (the single source of truth).
//
//   pnpm glossary:generate
//
// The gate pnpm check:i18n-glossary compares the committed GLOSSARY.md against exactly what
// this script would produce, using the shared renderer — so a stale doc fails CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderGlossaryDoc } from './shared/glossary-doc.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLOSSARY_PATH = path.join(repoRoot, 'i18n', 'glossary.json');
const DOC_PATH = path.join(repoRoot, 'i18n', 'GLOSSARY.md');

const glossary = JSON.parse(fs.readFileSync(GLOSSARY_PATH, 'utf8'));
fs.writeFileSync(DOC_PATH, renderGlossaryDoc(glossary), 'utf8');
console.log(`[glossary:generate] wrote ${path.relative(repoRoot, DOC_PATH)}`);
