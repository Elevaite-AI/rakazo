import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

import { runAsSystem, runAsTenant } from "../../../packages/db/src/index.js";
import { MarkdownMemoryStore } from "../../../packages/memory/src/index.js";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator.js";
import { createApp } from "../../api/src/app.js";
import { OrbDecisionAccess } from "../orb-decision-access.js";
import { OrbVersionedAccess } from "../orb-versioned-access.js";

for (const value of [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL]) {
  const u = new URL(value!);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "15439");
  assert.equal(u.pathname, "/rakazo_native_stage");
}
assert.equal(process.env.SANDBOX_PROVIDER, "fake");
process.env.MCP_ALLOW_PRIVATE_ENDPOINT = "true";
const base = new URL("../.local/", import.meta.url),
  state = JSON.parse(await readFile(new URL("native-state.json", base), "utf8")),
  config = JSON.parse(await readFile(new URL("approval-reader.json", base), "utf8")),
  stamp = randomUUID().replaceAll("-", ""),
  workspace = `rakazo_readiness_${stamp}`,
  origin = "http://127.0.0.1:15442";
const key = execFileSync(
  "docker",
  [
    "exec",
    "rakazo-rehearsal-honcho-api-1",
    "/app/.venv/bin/python",
    "-c",
    `from src.security import JWTParams,create_jwt\nimport datetime\nprint(create_jwt(JWTParams(w='${workspace}', exp=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=1))))`,
  ],
  { encoding: "utf8" },
).trim();
const creds = {
  baseUrl: "http://127.0.0.1:18000",
  apiKey: key,
  reasoningLevel: "minimal" as const,
};
const pool = new pg.Pool({
    connectionString: config.url,
    ssl: config.ssl,
    max: 2,
    connectionTimeoutMillis: 5000,
  }),
  brokerConfig = process.env.NATIVE_STAGE_DECISION_CONFIG
    ? JSON.parse(await readFile(process.env.NATIVE_STAGE_DECISION_CONFIG, "utf8"))
    : null,
  policy = brokerConfig
    ? new OrbDecisionAccess(brokerConfig.url, brokerConfig.token, new Set(brokerConfig.spaces))
    : new OrbVersionedAccess(pool, new Set(config.spaces), true);
const ownerConfig = JSON.parse(await readFile(new URL("release-proof/owner.json", base), "utf8"));
for (const c of [config, ownerConfig]) {
  const u = new URL(c.url);
  assert.equal(u.hostname, "127.0.0.1");
  assert.equal(u.port, "15444");
}
const owner = new pg.Pool({ connectionString: ownerConfig.url });
async function approver(who: string, allowed: boolean) {
  if (process.env.APPROVAL_AUTHORITY_MODE === "live") {
    assert.equal(new URL(brokerConfig?.url).port, "15449");
    const requestId = randomUUID();
    await writeFile(
      new URL("live-approval-phase.json", base),
      JSON.stringify({ requestId, who, allowed }),
    );
    console.log("WAIT protected staging approval toggle", requestId, who, allowed);
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const ack = JSON.parse(await readFile(new URL("live-approval-ack.json", base), "utf8"));
        if (ack.requestId === requestId) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Staging-only approval toggle was not acknowledged");
  }
  await owner.query(
    `UPDATE permission_authority.approvers SET allowed=$1 WHERE space_id=$2 AND canonical_id=(SELECT a.canonical_id FROM permission_authority.principals p JOIN permission_authority.aliases a ON a.profile_id=p.profile_id WHERE p.subject_id=$3)`,
    [allowed, state.spaceId, state.people[who].actor.userId],
  );
}
let revokeBeforeTool = false;
const model = await startModelEmulator({ apiKey: "readiness-synthetic-key", steps: [] });
let handles: any;
const cookies: Record<string, string> = {},
  outcomes: any[] = [];
let plan: any[] = [];
let proofModelCredentialId: string | undefined;
let memoryInstalled = false;
let originalBotModel: { modelProvider: string | null; modelId: string | null } | undefined;
async function login(who: string) {
  const p = state.people[who];
  const r = await handles.app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email: p.email, password: p.password }),
  });
  assert.equal(r.status, 200);
  cookies[who] = sessionCookieHeader(r);
}
async function rpc(who: string, path: string, input: any = {}, space = state.spaceId) {
  const r = await handles.app.request(`/rpc/${path}`, {
    method: "POST",
    headers: {
      origin,
      cookie: cookies[who],
      "content-type": "application/json",
      "x-rakazo-space-id": space,
    },
    body: JSON.stringify({ json: input }),
  });
  const b = await r.json();
  return { status: r.status, body: b.json ?? b };
}
const runtime: any = {
  describe: () => ({
    id: "deterministic-real-tool-proof",
    contractVersion: "1",
    adapterVersion: "1",
    capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
  }),
  abort: async () => {},
  async *run(request: any) {
    assert.ok(request.executeTool);
    assert.ok(!request.instructions.includes(`PRIVATE_CANARY_${stamp}`));
    for (const step of plan) {
      if (revokeBeforeTool) {
        await approver("member", false);
        revokeBeforeTool = false;
      }
      const result = await request.executeTool(step.name, step.args, randomUUID());
      outcomes.push({ name: step.name, result });
    }
    yield { type: "done", text: "Readiness tool proof completed" };
  },
};
try {
  handles = await createApp({ mcpAllowPrivateEndpoint: true });
  await runAsSystem("clean paused synthetic proof runs", () =>
    handles.prisma.run.updateMany({
      where: {
        botId: state.botId,
        status: { in: ["waiting_input", "queued"] },
        task: { prompt: { startsWith: "Readiness proof " } },
      },
      data: { status: "cancelled", completedAt: new Date(), error: "Readiness fixture cleanup" },
    }),
  );
  await login("service");
  assert.equal(
    await runAsSystem("memory fixture preflight", () =>
      handles.prisma.spaceMemoryConfig.findUnique({ where: { spaceId: state.spaceId } }),
    ),
    null,
    "Existing memory configuration must not be replaced",
  );
  originalBotModel = await runAsSystem("capture original staging model", () =>
    handles.prisma.bot.findUniqueOrThrow({
      where: { id: state.botId },
      select: { modelProvider: true, modelId: true },
    }),
  );
  const modelConnect = await rpc("service", "models/connect", {
    credentialId: null,
    label: "Readiness disposable model",
    provider: model.model.provider,
    modelId: model.model.id,
    baseUrl: model.baseUrl,
    apiKey: "readiness-synthetic-key",
    contextWindow: 32768,
    maxTokens: 1024,
  });
  assert.equal(modelConnect.status, 200, JSON.stringify(modelConnect.body));
  proofModelCredentialId = modelConnect.body.id;
  await runAsSystem("staging model fixture", () =>
    handles.prisma.bot.update({
      where: { id: state.botId },
      data: { modelProvider: model.model.provider, modelId: model.model.id },
    }),
  );
  const connected = await rpc("service", "memory/connectProvider", {
    provider: "honcho",
    settings: {
      mode: "local",
      baseUrl: creds.baseUrl,
      workspaceId: workspace,
      reasoningLevel: "minimal",
    },
    credentials: { apiKey: key },
    defaultMemoryScope: "shared",
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  memoryInstalled = true;
  await handles.stop();
  handles = await createApp({
    mcpAllowPrivateEndpoint: true,
    runtime,
    sharedWorkspaceAccess: policy,
  });
  for (const who of ["member", "owner", "ownerAlias", "outsider"]) await login(who);
  const memory = new MarkdownMemoryStore(handles.prisma);
  const privateActor = state.people.owner.actor;
  await runAsTenant(privateActor, () =>
    memory.commit(
      {
        scope: "user",
        path: `readiness-private-${stamp}.md`,
        content: `PRIVATE_CANARY_${stamp}`,
      },
      { ...privateActor, operationId: stamp, traceId: stamp, signal: new AbortController().signal },
    ),
  );
  async function send(who: string, steps: any[], expected = "completed") {
    plan = steps;
    const start = outcomes.length;
    const r = await rpc(who, "threads/send", {
      botId: state.botId,
      text:
        "Readiness proof " +
        stamp +
        " " +
        who +
        (steps.some((s: any) => s.name === "web_fetch")
          ? " Read only https://example.com to verify the real web tool."
          : ""),
      clientNonce: randomUUID(),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.runId ?? r.body.runIds?.[0];
    await handles.awaitIdle();
    const run = await runAsSystem("proof read", () =>
      handles.prisma.run.findUnique({ where: { id } }),
    );
    assert.equal(run.status, expected, JSON.stringify({ status: run.status, error: run.error }));
    return { id, tools: outcomes.slice(start) };
  }
  const fact = `Readiness project ${stamp} uses the BLUE approval code.`;
  const saved = await send("member", [
    { name: "save_shared_memory", args: { path: `readiness-${stamp}.md`, content: fact } },
    { name: "save_memory", args: { content: fact } },
  ]);
  assert.ok(
    saved.tools.every((t: any) => t.result?.ok === true),
    JSON.stringify(saved),
  );
  const recalled = await send("owner", [
    {
      name: "recall_memory",
      args: { query: `What approval code is used by readiness project ${stamp}?` },
    },
  ]);
  assert.equal(recalled.tools[0].result.ok, true);
  assert.ok(JSON.stringify(recalled.tools[0].result.value).includes("BLUE"));
  const cited = recalled.tools[0].result.value.find((v: any) => v.id);
  assert.ok(cited);
  const approvalChecks = [];
  let approvalPaused: any;
  for (const [index, who] of ["owner", "ownerAlias", "member"].entries()) {
    approvalPaused = await send(
      "ownerAlias",
      [
        {
          name: "forget_memory",
          args: { id: cited.id, entity: cited.entity, reason: "Readiness correction" },
        },
      ],
      "waiting_input",
    );
    const messages = await runAsSystem("approval fixture", () =>
      handles.prisma.message.findMany({ where: { runId: approvalPaused.id, role: "bot" } }),
    );
    const message = messages.find((m: any) =>
      m.blocks.some((b: any) => b.kind === "ask" && b.approvalEffectId && b.status !== "answered"),
    );
    assert.ok(message);
    const input = {
      botId: state.botId,
      runId: approvalPaused.id,
      messageId: message.id,
      answer: index === 2 ? "allow" : "deny",
    };
    assert.equal((await rpc("outsider", "threads/answer", input)).status, 401);
    await approver(who, false);
    assert.equal((await rpc(who, "threads/answer", input)).status, 403);
    assert.ok(await policy.resolve(state.people[who].actor.userId, state.spaceId));
    await approver(who, true);
    assert.equal((await rpc(who, "threads/answer", { ...input, answer: "always" })).status, 403);
    const before = outcomes.length;
    const answer = await rpc(who, "threads/answer", input);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    await handles.awaitIdle();
    const stored = await runAsSystem("approval receipt", () =>
      handles.prisma.message.findUnique({ where: { id: message.id } }),
    );
    assert.ok(
      stored.blocks.some((b: any) => b.sharedApproval?.userId === state.people[who].actor.userId),
    );
    if (index === 2)
      assert.ok(
        outcomes.slice(before).some((t: any) => t.name === "forget_memory" && t.result.ok),
        JSON.stringify(outcomes.slice(before)),
      );
    approvalChecks.push({
      who,
      deniedWithoutApproverGrant: true,
      alwaysDenied: true,
      receiptAttributed: true,
      decision: input.answer,
    });
  }
  const correction = { ok: true, throughNativeApproval: true };
  const corrected = await send("ownerAlias", [
    {
      name: "save_shared_memory",
      args: { path: `readiness-${stamp}.md`, content: fact.replace("BLUE", "GREEN") },
    },
    { name: "save_memory", args: { content: fact.replace("BLUE", "GREEN") } },
  ]);
  assert.ok(
    corrected.tools.every((t: any) => t.result?.ok === true),
    JSON.stringify(corrected),
  );
  const correctedRecall = await send("member", [
    {
      name: "recall_memory",
      args: { query: `What approval code is used by readiness project ${stamp}?` },
    },
    { name: "web_fetch", args: { url: "https://example.com" } },
  ]);
  const correctedText = JSON.stringify(correctedRecall.tools[0].result);
  assert.ok(correctedText.includes("GREEN"));
  assert.ok(!correctedText.includes("BLUE"));
  assert.ok(JSON.stringify(correctedRecall.tools[1].result).includes("Example Domain"));
  const denied = await rpc("outsider", "threads/send", {
    botId: state.botId,
    text: "forbidden memory request",
  });
  assert.equal(denied.status, 401);

  for (const [who, run] of [
    ["member", saved],
    ["owner", recalled],
    ["ownerAlias", corrected],
  ] as const) {
    const row = await runAsSystem("source attribution proof", () =>
      handles.prisma.run.findUnique({ where: { id: run.id }, include: { sourceMessage: true } }),
    );
    assert.ok(JSON.stringify(row.sourceMessage.blocks).includes(state.people[who].actor.userId));
  }
  const secondRecall = await send("member", [
    {
      name: "recall_memory",
      args: { query: `What approval code is used by readiness project ${stamp}?` },
    },
  ]);
  const secondFact = secondRecall.tools[0].result.value.find((v: any) => v.id);
  assert.ok(secondFact);
  const pending = await send(
    "owner",
    [
      {
        name: "forget_memory",
        args: { id: secondFact.id, entity: secondFact.entity, reason: "Revocation proof" },
      },
    ],
    "waiting_input",
  );
  const messages = await runAsSystem("revoked approval fixture", () =>
    handles.prisma.message.findMany({ where: { runId: pending.id, role: "bot" } }),
  );
  const message = messages.find((m: any) =>
    m.blocks.some((b: any) => b.kind === "ask" && b.approvalEffectId && b.status !== "answered"),
  );
  assert.ok(message);
  revokeBeforeTool = true;
  const beforeBlocked = outcomes.length;
  assert.equal(
    (
      await rpc("member", "threads/answer", {
        botId: state.botId,
        runId: pending.id,
        messageId: message.id,
        answer: "allow",
      })
    ).status,
    200,
  );
  await handles.awaitIdle();
  const blockedRun = await runAsSystem("revoked approval result", () =>
    handles.prisma.run.findUnique({ where: { id: pending.id } }),
  );
  assert.equal(blockedRun.status, "cancelled");
  assert.equal(outcomes.length, beforeBlocked);
  await approver("member", true);
  await runAsSystem("regrant must not revive approved work", () =>
    handles.prisma.run.update({
      where: { id: pending.id },
      data: { status: "queued", completedAt: null },
    }),
  );
  await runAsTenant({ spaceId: state.spaceId, userId: state.people.service.actor.userId }, () =>
    handles.executor.continueRun(pending.id, "approval-regrant-proof"),
  );
  assert.equal(
    (
      await runAsSystem("regrant cancellation", () =>
        handles.prisma.run.findUnique({ where: { id: pending.id } }),
      )
    ).status,
    "cancelled",
  );
  assert.equal(outcomes.length, beforeBlocked);
  console.log(
    "PASS designated approval, denial, native Honcho deletion, attribution, correction, recall and approver revocation",
  );
  await writeFile(
    new URL("readiness-approvals-results.json", base),
    JSON.stringify(
      {
        workspace,
        model:
          "deterministic tool requests; real native executor/tool implementations and real Honcho HTTP",
        saved,
        recalled,
        approvalPaused,
        correction,
        corrected,
        correctedRecall,
        privateCanaryAbsent: true,
        outsiderDenied: true,
        sourceRunAttribution: true,
        revokedApprovedDeletionCancelled: true,
        regrantDoesNotReviveOldApproval: true,
        approvalChecks,
      },
      null,
      2,
    ),
  );
} finally {
  if (handles) {
    await runAsSystem("restore staging bot configuration", async () => {
      await handles.prisma.bot.update({
        where: { id: state.botId },
        data: originalBotModel ?? { modelProvider: null, modelId: null },
      });
      if (proofModelCredentialId)
        await handles.prisma.userModelCredential.deleteMany({
          where: { id: proofModelCredentialId, userId: state.people.service.actor.userId },
        });
      await handles.prisma.memoryDocument.deleteMany({
        where: {
          userId: { in: [state.people.service.actor.userId, state.people.owner.actor.userId] },
          path: { in: [`readiness-${stamp}.md`, `readiness-private-${stamp}.md`] },
        },
      });
      const c = await handles.prisma.spaceMemoryConfig.findUnique({
        where: { spaceId: state.spaceId },
      });
      if (c && memoryInstalled) {
        await handles.prisma.spaceMemoryConfig.delete({ where: { spaceId: state.spaceId } });
        await handles.prisma.secret.deleteMany({ where: { id: c.secretId } });
      }
    });
    await handles.stop();
  }
  await approver("member", true);
  await approver("owner", true);
  await owner.end();
  await pool.end();
  await model.close();
}
