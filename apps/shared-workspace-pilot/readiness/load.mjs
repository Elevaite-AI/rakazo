import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { request } from "../node_modules/playwright/index.mjs";

const state = JSON.parse(
  await readFile(new URL("../.local/native-state.json", import.meta.url), "utf8"),
);
const origin = "http://127.0.0.1:15442",
  clients = [],
  results = [];
try {
  for (const who of ["member", "owner", "ownerAlias"]) {
    const ctx = await request.newContext({ baseURL: origin });
    const p = state.people[who];
    assert.equal(
      (
        await ctx.post("/api/auth/sign-in/email", {
          headers: { origin },
          data: { email: p.email, password: p.password },
        })
      ).status(),
      200,
    );
    clients.push({ who, ctx });
  }
  for (const concurrency of [1, 4, 8]) {
    const samples = [];
    let next = 0;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < 24) {
          const n = next++,
            { who, ctx } = clients[n % clients.length],
            t = performance.now();
          const r = await ctx.post("/rpc/bootstrap", {
            headers: { origin, "x-rakazo-space-id": state.spaceId },
            data: { json: {} },
            timeout: 15000,
          });
          samples.push({ who, status: r.status(), ms: Math.round(performance.now() - t) });
        }
      }),
    );
    const elapsedMs = Math.round(performance.now() - start),
      times = samples.map((s) => s.ms).sort((a, b) => a - b);
    results.push({
      concurrency,
      requests: samples.length,
      elapsedMs,
      p50ms: times[11],
      p95ms: times[22],
      maxMs: times[23],
      non200: samples.filter((s) => s.status !== 200),
      requestsPerSecond: +(24000 / elapsedMs).toFixed(2),
    });
    console.log(JSON.stringify(results.at(-1)));
    await new Promise((r) => setTimeout(r, 2000));
  }
  await writeFile(
    new URL("../.local/readiness-load-results.json", import.meta.url),
    JSON.stringify(
      {
        target: "native staging using scoped live ORB",
        budget: "72 reads, maximum 8 concurrent clients",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const { ctx } of clients) await ctx.dispose();
}
