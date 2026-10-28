import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

const root = new URL("./.local/", import.meta.url),
  owner = randomBytes(24).toString("hex"),
  reader = randomBytes(24).toString("hex");
let exists = false;
try {
  execFileSync("docker", ["inspect", "rakazo-permission-authority-stage"], { stdio: "pipe" });
  exists = true;
} catch {}
if (exists) throw new Error("Authority container already exists; refusing to overwrite its state");
const envFile = new URL("authority-docker.env", root);
await writeFile(envFile, `POSTGRES_PASSWORD=${owner}\nPOSTGRES_DB=orb_permission_stage\n`, {
  mode: 0o600,
});
execFileSync(
  "docker",
  [
    "run",
    "-d",
    "--name",
    "rakazo-permission-authority-stage",
    "--label",
    "purpose=isolated-permission-authority",
    "-p",
    "127.0.0.1:15443:5432",
    "--env-file",
    envFile.pathname,
    "postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
  ],
  { stdio: "pipe" },
);
const url = `postgresql://postgres:${owner}@127.0.0.1:15443/orb_permission_stage`;
const pool = new pg.Pool({ connectionString: url });
for (let i = 0; i < 40; i++) {
  try {
    await pool.query("SELECT 1");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}
await pool.query(await readFile(new URL("../authority-stage.sql", root), "utf8"));
const fixture = JSON.parse(await readFile(new URL("orb-identities.json", root), "utf8")),
  state = JSON.parse(await readFile(new URL("native-state.json", root), "utf8"));
await pool.query(
  "INSERT INTO permission_authority.resources(space_id,execution_user_id,bot_id) VALUES($1,$2,$3)",
  [state.spaceId, state.people.service.actor.userId, state.botId],
);
for (const p of fixture.people) {
  await pool.query(
    "INSERT INTO permission_authority.members(profile_id,active) VALUES($1,true) ON CONFLICT DO NOTHING",
    [p.canonicalProfileId],
  );
  await pool.query(
    "INSERT INTO permission_authority.aliases(profile_id,canonical_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [p.profileId, p.canonicalProfileId],
  );
  await pool.query(
    "INSERT INTO permission_authority.principals(subject_id,profile_id) VALUES($1,$2)",
    [state.people[p.key].actor.userId, p.profileId],
  );
  await pool.query(
    "INSERT INTO permission_authority.grants(canonical_id,space_id,allowed) VALUES($1,$2,true) ON CONFLICT DO NOTHING",
    [p.canonicalProfileId, state.spaceId],
  );
}
await pool.query(
  `CREATE ROLE rakazo_permission_reader LOGIN PASSWORD '${reader}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8`,
);
await pool.query("REVOKE ALL ON DATABASE orb_permission_stage FROM PUBLIC");
await pool.query("GRANT CONNECT ON DATABASE orb_permission_stage TO rakazo_permission_reader");
await pool.query("GRANT USAGE ON SCHEMA permission_authority TO rakazo_permission_reader");
await pool.query(
  "GRANT EXECUTE ON FUNCTION permission_authority.resolve(text,text) TO rakazo_permission_reader",
);
await pool.query(
  "ALTER ROLE rakazo_permission_reader SET default_transaction_read_only=on; ALTER ROLE rakazo_permission_reader SET statement_timeout='500ms'; ALTER ROLE rakazo_permission_reader SET lock_timeout='250ms'",
);
await pool.query(
  "INSERT INTO permission_authority.reader_scopes(login_name,space_id) VALUES($1,$2)",
  ["rakazo_permission_reader", state.spaceId],
);
await writeFile(new URL("authority-owner.json", root), JSON.stringify({ url }), { mode: 0o600 });
await writeFile(
  new URL("authority-reader.json", root),
  JSON.stringify({
    url: `postgresql://rakazo_permission_reader:${reader}@127.0.0.1:15443/orb_permission_stage`,
    spaces: [state.spaceId],
  }),
  { mode: 0o600 },
);
await pool.query(await readFile(new URL("../authority-orb-source-stage.sql", root), "utf8"));
await pool.query("INSERT INTO permission_authority.resource_bindings VALUES($1,$2)", [
  state.orbAgentId,
  state.spaceId,
]);
for (const p of fixture.people) {
  await pool.query(
    "INSERT INTO public.team_member VALUES($1,$2,true,'active',NULL) ON CONFLICT DO NOTHING",
    [p.teamMemberId, p.canonicalProfileId],
  );
  await pool.query(
    "INSERT INTO public.agent_access(team_member_id,agent_type,agent_id,has_access) VALUES($1,'rakazo-staging',$2,true) ON CONFLICT DO NOTHING",
    [p.teamMemberId, state.orbAgentId],
  );
}
await pool.query(await readFile(new URL("../authority-stage-hardening.sql", root), "utf8"));
await pool.query(await readFile(new URL("../authority-source-delete-hardening.sql", root), "utf8"));
await pool.end();
console.log(
  "Isolated authority initialized. Reader has only scoped decision-function access; credentials are private.",
);
