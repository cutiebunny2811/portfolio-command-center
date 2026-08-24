import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCompletionEvidence,
  resolveCanonicalPccRepo,
} from "../scripts/ian-pcc-completion-guard.mjs";

const config = `
mcp_servers:
  portfolio-command-center:
    command: node
    args:
      - C:\\Work\\portfolio-command-center\\hermes-mcp\\server.mjs
    env:
      PCC_AGENT_TOKEN: pcc_secret
`;

test("canonical PCC repo is derived from Ian MCP server path rather than the caller cwd", () => {
  assert.equal(
    resolveCanonicalPccRepo(config),
    "C:\\Work\\portfolio-command-center",
  );
  assert.equal(
    resolveCanonicalPccRepo(`
mcp_servers:
  portfolio-command-center:
    args:
      - C:\\Work\\portfolio-command-center-release\\hermes-mcp\\server.mjs
`),
    "C:\\Work\\portfolio-command-center-release",
  );
});

test("completion evidence rejects an implementation claim without canonical repo, test, deploy and read-back proof", () => {
  assert.throws(
    () => assertCompletionEvidence({
      status: "VERIFIED",
      repo: "C:\\Wrong\\clone",
      test: "pass",
      deploy: "pass",
      readback: "pass",
    }, "C:\\Work\\portfolio-command-center"),
    /canonical repo/i,
  );
  assert.throws(
    () => assertCompletionEvidence({
      status: "VERIFIED",
      canonical_repo: "C:\\Work\\portfolio-command-center",
      test: "pass",
      deploy: "pass",
    }, "C:\\Work\\portfolio-command-center"),
    /read-back/i,
  );
});

test("completion evidence accepts only a fully verified canonical deployment", () => {
  assert.deepEqual(
    assertCompletionEvidence({
      status: "VERIFIED",
      canonical_repo: "C:\\Work\\portfolio-command-center",
      test: "node --test tests/valuation-framework.test.mjs: pass",
      deploy: "supabase functions deploy portfolio-agent-api: success",
      readback: "production API/UI read-back: pass",
    }, "C:\\Work\\portfolio-command-center"),
    { status: "VERIFIED", canonical_repo: "C:\\Work\\portfolio-command-center" },
  );
});

test("completion evidence accepts the durable work-item evidence arrays", () => {
  assert.deepEqual(
    assertCompletionEvidence({
      status: "VERIFIED",
      canonical_repo: "C:\\Work\\portfolio-command-center",
      test_evidence: ["targeted tests: pass"],
      deploy_evidence: ["edge function: deployed"],
      readback_evidence: ["production read-back: pass"],
    }, "C:\\Work\\portfolio-command-center"),
    { status: "VERIFIED", canonical_repo: "C:\\Work\\portfolio-command-center" },
  );
});
