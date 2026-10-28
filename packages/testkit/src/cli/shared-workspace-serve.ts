import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createApp } from "@rakazo/api/app";
import { OrbDecisionAccess } from "../../../../apps/shared-workspace-pilot/orb-decision-access.js";

const url = new URL(process.env.DATABASE_URL!);
if (
  url.hostname !== "127.0.0.1" ||
  url.port !== "15439" ||
  url.pathname !== "/rakazo_native_stage" ||
  process.env.AGENT_RUNTIME !== "scripted" ||
  process.env.SANDBOX_PROVIDER !== "fake"
)
  throw Error("Isolated native staging required");
if (process.env.NATIVE_STAGE_AUTHORITY_CONFIG || process.env.DATABASE_MIGRATION_URL)
  throw Error("Runtime must not receive administrative or ORB SQL configuration");
const config = JSON.parse(await readFile(process.env.NATIVE_STAGE_DECISION_CONFIG!, "utf8"));
const handles = await createApp({
  sharedWorkspaceAccess: new OrbDecisionAccess(config.url, config.token, new Set(config.spaces)),
});
const server = serve({ fetch: handles.app.fetch, hostname: "127.0.0.1", port: 15441 });
console.log("Restricted native staging API ready");
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    server.close();
    await handles.stop();
    process.exit(0);
  });
