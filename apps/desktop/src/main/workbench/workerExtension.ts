// The workers' pi extension: the write gate's worker half (writeGate.ts has main's half).
//
// Loaded into every local worker with `--extension <file>`, next to herdr's pi integration.
// A `tool_call` guard lets `write` and `edit` through when the target — resolved the way pi
// resolves it (`@` prefix, `~`, `file://`, Unicode spaces), then through symlinks — is inside
// the worker's working dir (the task's folder or worktree) or a folder the user granted in the
// explorer. Anything else is held until the user answers a confirmation card in AiOpt; no
// answer within WRITE_GATE_TIMEOUT_MS, or no AiOpt to ask, blocks the call.
//
// Only these two tools are gated. `bash` can still write anywhere the user can, so this guards
// against a model's mistakes, not against a hostile one (see writeGate.ts).
//
// The source is a constant so the file on disk is always exactly what this build ships; main
// rewrites it on every start. It must stay free of imports outside node built-ins.

import { FOLDERS_FILE_ENV } from './orchestratorExtension';
import { WRITE_GATE_DIR_ENV, WRITE_GATE_TIMEOUT_MS, WRITE_GATE_TOOLS } from './writeGate';

export const WORKER_EXTENSION_SOURCE = `// Written by AiOpt. Rewritten on every start; edits are lost.
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATED = ${JSON.stringify(WRITE_GATE_TOOLS)};
const TIMEOUT_MS = ${WRITE_GATE_TIMEOUT_MS};
const POLL_MS = 400;
const UNICODE_SPACES = /[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g;

function grantedFolders() {
  try {
    const doc = JSON.parse(readFileSync(process.env.${FOLDERS_FILE_ENV} || "", "utf8"));
    return Array.isArray(doc.folders) ? doc.folders.filter((f) => f && typeof f.path === "string") : [];
  } catch {
    return [];
  }
}

// The nearest existing ancestor, resolved through symlinks.
function realish(p) {
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), path.relative(cur, p));
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      cur = up;
    }
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

// The absolute target pi's write/edit tools would use for this argument.
function targetOf(raw, cwd) {
  let p = raw.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2));
  else if (/^file:\\/\\//.test(p)) p = fileURLToPath(p);
  return realish(path.resolve(cwd, p));
}

function allowed(target, cwd) {
  const roots = [cwd, ...grantedFolders().map((f) => f.path)].map((r) => realish(path.resolve(r)));
  return roots.some((root) => inside(target, root));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask AiOpt through the gate directory. Anything short of an explicit yes is a no.
async function askUser(tool, target, cwd, signal) {
  const dir = process.env.${WRITE_GATE_DIR_ENV};
  if (!dir) return false;
  const id = randomUUID();
  const req = path.join(dir, id + ".req.json");
  const res = path.join(dir, id + ".res.json");
  const tmp = path.join(dir, id + ".tmp");
  try {
    try {
      // herdr names the pane, so AiOpt can tell apart tasks working in the same folder.
      const pane = /^w[0-9A-Za-z]{1,8}:p[0-9A-Za-z]{1,8}$/.test(process.env.HERDR_PANE_ID || "")
        ? process.env.HERDR_PANE_ID
        : undefined;
      writeFileSync(tmp, JSON.stringify({ v: 1, tool, path: target, cwd, pane }), { mode: 0o600 });
      renameSync(tmp, req);
    } catch {
      return false;
    }
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) return false;
      await sleep(POLL_MS);
      let text = null;
      try {
        text = readFileSync(res, "utf8");
      } catch {
        continue;
      }
      try {
        return JSON.parse(text).allow === true;
      } catch {
        return false;
      }
    }
    return false;
  } finally {
    for (const f of [tmp, req, res]) {
      try {
        rmSync(f, { force: true });
      } catch {}
    }
  }
}

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (!GATED.includes(event.toolName)) return;
    const raw = event.input && event.input.path;
    // A missing or malformed path fails in the tool itself; nothing is written.
    if (typeof raw !== "string" || raw === "") return;
    const cwd = path.resolve((ctx && ctx.cwd) || process.cwd());
    const target = targetOf(raw, cwd);
    if (allowed(target, cwd)) return;
    if (await askUser(event.toolName, target, cwd, ctx && ctx.signal)) return;
    return {
      block: true,
      reason:
        "Not allowed: " + target + " is outside the task's folder and the folders granted to the workbench, " +
        "and the user did not approve this write. Work inside the task's folder, or ask the user.",
    };
  });
}
`;
