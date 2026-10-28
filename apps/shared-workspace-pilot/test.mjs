import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { createAccess } from "./access.mjs";
import { databaseUrl } from "./config.mjs";
import { seed } from "./seed.mjs";
import { createPilotServer } from "./server.mjs";

describe("shared workspace pilot: real PostgreSQL and HTTP", () => {
  let access, pilot, base, admin;
  const sessions = Object.fromEntries(
    ["owner", "member", "outsider"].map((u) => [
      `${u}-test-session`,
      { id: `pilot-${u}`, expiresAt: Date.now() + 600000 },
    ]),
  );
  async function request(who, path, method = "GET", body) {
    const r = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${who}-test-session`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  const team = "/api/spaces/pilot-team";
  const enqueue = (who = "member", text = "Shared test message", nonce = randomUUID()) =>
    request(who, `${team}/jobs/pilot-team-bot`, "POST", { text, nonce });
  before(async () => {
    await seed();
    access = createAccess();
    admin = new pg.Client({ connectionString: databaseUrl(true) });
    await admin.connect();
    pilot = createPilotServer({ access, sessions, streamMs: 30 });
    await new Promise((r) => pilot.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${pilot.server.address().port}`;
  });
  beforeEach(seed);
  after(async () => {
    await pilot?.close();
    await access?.close();
    await admin?.end();
  });
  it("lists each private space and the shared space across organisations", async () => {
    for (const u of ["owner", "member"]) {
      const r = await request(u, "/api/spaces");
      assert.deepEqual(r.body.spaces.map((s) => s.id).sort(), [`pilot-${u}`, "pilot-team"].sort());
    }
    assert.deepEqual(
      (await request("outsider", "/api/spaces")).body.spaces.map((s) => s.id),
      ["pilot-outsider"],
    );
  });
  it("rejects unauthenticated and forged identities", async () => {
    assert.equal((await request("unknown", "/api/spaces")).status, 401);
    assert.equal((await request("outsider", `${team}/snapshot`)).status, 404);
    assert.equal(
      (
        await request("member", `${team}/jobs/pilot-team-bot`, "POST", {
          text: "x",
          nonce: "x",
          userId: "pilot-owner",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("member", `${team}/jobs/pilot-team-bot`, "POST", {
          text: "x",
          nonce: "x",
          executor_id: "pilot-owner",
        })
      ).status,
      400,
    );
  });
  it("denies direct private agent, conversation and memory URLs both directions", async () => {
    for (const [actor, target] of [
      ["owner", "member"],
      ["member", "owner"],
      ["outsider", "owner"],
    ]) {
      for (const path of ["snapshot", `thread/pilot-${target}-bot`, `memory/pilot-${target}-bot`])
        assert.equal((await request(actor, `/api/spaces/pilot-${target}/${path}`)).status, 404);
      assert.equal(
        (
          await request(actor, `/api/spaces/pilot-${target}/jobs/pilot-${target}-bot`, "POST", {
            text: "intrusion",
            nonce: "x",
          })
        ).status,
        404,
      );
    }
  });
  it("rejects a private bot ID inside an authorised shared-space URL", async () => {
    assert.equal((await request("member", `${team}/thread/pilot-owner-bot`)).status, 404);
    assert.equal((await request("member", `${team}/memory/pilot-owner-bot`)).status, 404);
  });
  it("both members see the same shared agent, attributed messages and team-only executor", async () => {
    for (const u of ["owner", "member"]) {
      assert.equal((await request(u, `${team}/snapshot`)).body.agents[0].bot_id, "pilot-team-bot");
      const job = await enqueue(u, `From ${u}`);
      assert.equal(job.status, 200);
      assert.equal(job.body.requester_id, `pilot-${u}`);
      assert.equal(job.body.executor_id, "pilot-team-executor");
      assert.equal(
        (await request(u, `${team}/run/${job.body.id}`, "POST")).body.status,
        "completed",
      );
    }
    const a = (await request("owner", `${team}/thread/pilot-team-bot`)).body;
    const b = (await request("member", `${team}/thread/pilot-team-bot`)).body;
    assert.deepEqual(a, b);
    assert.equal(a.length, 4);
    assert.deepEqual(
      a.filter((m) => m.role === "user").map((m) => m.blocks[0].authorId),
      ["pilot-owner", "pilot-member"],
    );
    assert.ok(
      a
        .filter((m) => m.role === "assistant")
        .every((m) => m.blocks[0].credentialBinding === "offline-test-agent"),
    );
  });
  it("memory retrieval contains shared facts and no private canaries", async () => {
    for (const u of ["owner", "member"]) {
      const r = await request(u, `${team}/memory/pilot-team-bot`);
      assert.equal(r.status, 200);
      assert.match(r.body[0].content, /Thursday/);
      assert.doesNotMatch(JSON.stringify(r.body), /PRIVATE_CANARY/);
    }
  });
  it("RLS denies cross-space rows even when a query omits its filter", async () => {
    await access.scoped("pilot-member", "pilot-member", async (c) => {
      for (const table of ["bots", "threads", "memory_documents", "secrets"]) {
        const rows = (await c.query(`SELECT "spaceId" FROM ${table}`)).rows;
        assert.ok(rows.length > 0);
        assert.ok(rows.every((r) => r.spaceId === "pilot-member"));
      }
      const role = (
        await c.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
      ).rows[0];
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
    });
  });
  it("parallel duplicate sends and executions write only one message pair", async () => {
    const jobs = await Promise.all([
      enqueue("member", "same", "same"),
      enqueue("member", "same", "same"),
    ]);
    assert.ok(jobs.every((j) => j.status === 200));
    assert.equal(jobs[0].body.id, jobs[1].body.id);
    const runs = await Promise.all(
      jobs.map((j) => request("member", `${team}/run/${j.body.id}`, "POST")),
    );
    assert.ok(runs.every((r) => r.status === 200));
    assert.equal((await request("owner", `${team}/thread/pilot-team-bot`)).body.length, 2);
    assert.equal((await enqueue("member", "different", "same")).status, 400);
  });
  it("members cannot administer access or remove owners", async () => {
    assert.equal((await request("member", `${team}/members`)).status, 404);
    assert.equal((await request("member", `${team}/members/pilot-owner`, "DELETE")).status, 404);
    assert.equal((await request("owner", `${team}/members/pilot-owner`, "DELETE")).status, 400);
  });
  it("removal denies old-session reads and sends immediately and hides discovery", async () => {
    assert.equal((await request("owner", `${team}/members/pilot-member`, "DELETE")).status, 200);
    for (const path of ["snapshot", "thread/pilot-team-bot", "memory/pilot-team-bot", "members"])
      assert.equal((await request("member", `${team}/${path}`)).status, 404);
    assert.equal((await enqueue()).status, 404);
    assert.deepEqual(
      (await request("member", "/api/spaces")).body.spaces.map((s) => s.id),
      ["pilot-member"],
    );
    assert.equal((await request("owner", `${team}/snapshot`)).status, 200);
  });
  it("removal cancels queued work and retains prior shared history", async () => {
    const completed = await enqueue("member", "Already shared");
    await request("member", `${team}/run/${completed.body.id}`, "POST");
    const pending = await enqueue("member", "Must never execute");
    await request("owner", `${team}/members/pilot-member`, "DELETE");
    assert.equal(
      (await request("owner", `${team}/run/${pending.body.id}`, "POST")).body.status,
      "cancelled",
    );
    const thread = (await request("owner", `${team}/thread/pilot-team-bot`)).body;
    assert.equal(thread.length, 2);
    assert.doesNotMatch(JSON.stringify(thread), /Must never execute/);
  });
  it("regrant cannot resurrect jobs from a previous membership generation", async () => {
    const pending = await enqueue();
    await request("owner", `${team}/members/pilot-member`, "DELETE");
    await admin.query(
      `INSERT INTO space_members(id,"spaceId","organizationId","userId",role,"createdAt") VALUES('new-generation','pilot-team','pilot-team','pilot-member','member',now())`,
    );
    assert.equal((await request("member", `${team}/snapshot`)).status, 200);
    assert.equal(
      (await request("member", `${team}/run/${pending.body.id}`, "POST")).body.status,
      "cancelled",
    );
  });
  it("membership removal closes an already-open authenticated stream", async () => {
    const controller = new AbortController();
    const response = await fetch(`${base + team}/stream`, {
      headers: { Authorization: "Bearer member-test-session" },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    const start = performance.now();
    await request("owner", `${team}/members/pilot-member`, "DELETE");
    const timeout = setTimeout(() => controller.abort(), 2000);
    let text = "";
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        text += new TextDecoder().decode(r.value);
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
    assert.match(text, /event: revoked/);
    assert.ok(performance.now() - start < 1500);
  });
  it("forged browser origin is rejected", async () => {
    const r = await fetch(`${base}/api/spaces`, {
      headers: { Authorization: "Bearer owner-test-session", Origin: "https://unrelated.example" },
    });
    assert.equal(r.status, 404);
  });
  it("revocation leaves both private memberships and canaries unchanged", async () => {
    const before = (
      await admin.query(
        "SELECT id,\"userId\",content FROM memory_documents WHERE \"spaceId\" IN ('pilot-owner','pilot-member') ORDER BY id",
      )
    ).rows;
    await request("owner", `${team}/members/pilot-member`, "DELETE");
    const after = (
      await admin.query(
        "SELECT id,\"userId\",content FROM memory_documents WHERE \"spaceId\" IN ('pilot-owner','pilot-member') ORDER BY id",
      )
    ).rows;
    assert.deepEqual(after, before);
    for (const u of ["owner", "member"])
      assert.equal((await request(u, `/api/spaces/pilot-${u}/snapshot`)).status, 200);
  });
  it("removal is recorded with the actual administrator identity", async () => {
    await request("owner", `${team}/members/pilot-member`, "DELETE");
    const events = (
      await admin.query("SELECT actor_id,subject_id FROM shared_pilot.audit WHERE action='revoked'")
    ).rows;
    assert.deepEqual(events, [{ actor_id: "pilot-owner", subject_id: "pilot-member" }]);
  });
});
