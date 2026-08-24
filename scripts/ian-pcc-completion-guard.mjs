#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || "").trim().replace(/^['"]|['"]$/g, ""));
}

export function resolveCanonicalPccRepo(configSource) {
  const source = String(configSource || "");
  const match = source.match(/^\s*-\s*(.+?[\\/]hermes-mcp[\\/]server\.mjs)\s*$/mi);
  if (!match) throw new Error("Ian MCP config does not declare a portfolio-command-center server path");
  const serverPath = normalizeWindowsPath(match[1]);
  if (!/portfolio-command-center(?:-[^\\/]+)?[\\/]hermes-mcp[\\/]server\.mjs$/i.test(serverPath)) {
    throw new Error("Ian MCP server path is not a Portfolio Command Center runtime path");
  }
  return path.win32.dirname(path.win32.dirname(serverPath));
}

export function assertCompletionEvidence(evidence, canonicalRepo) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("completion evidence must be a JSON object");
  }
  if (evidence.status !== "VERIFIED") {
    throw new Error("completion evidence status must be VERIFIED");
  }
  const expectedRepo = normalizeWindowsPath(canonicalRepo);
  if (normalizeWindowsPath(evidence.repo) !== expectedRepo) {
    throw new Error("completion evidence repo does not match the canonical repo");
  }
  for (const key of ["test", "deploy", "readback"]) {
    if (typeof evidence[key] !== "string" || !evidence[key].trim()) {
      throw new Error(`completion evidence requires ${key === "readback" ? "read-back" : key} proof`);
    }
  }
  return { status: "VERIFIED", repo: expectedRepo };
}

async function main() {
  const [, , command, ...args] = process.argv;
  const configFlag = args.indexOf("--config");
  const evidenceFlag = args.indexOf("--evidence");
  if (!["preflight", "verify"].includes(command) || configFlag < 0) {
    throw new Error("Usage: node scripts/ian-pcc-completion-guard.mjs <preflight|verify> --config <ian-config.yaml> [--evidence <completion.json>]");
  }
  const canonicalRepo = resolveCanonicalPccRepo(await readFile(args[configFlag + 1], "utf8"));
  if (command === "preflight") {
    process.stdout.write(`${JSON.stringify({ status: "IMPLEMENTING", canonical_repo: canonicalRepo })}\n`);
    return;
  }
  if (evidenceFlag < 0) throw new Error("verify requires --evidence <completion.json>");
  const evidence = JSON.parse(await readFile(args[evidenceFlag + 1], "utf8"));
  process.stdout.write(`${JSON.stringify(assertCompletionEvidence(evidence, canonicalRepo))}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
