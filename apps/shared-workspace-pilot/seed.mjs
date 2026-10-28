import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { databaseUrl } from "./config.mjs";

export async function seed() {
  const c = new pg.Client({ connectionString: databaseUrl(true) });
  await c.connect();
  try {
    await c.query(await readFile(new URL("pilot.sql", import.meta.url), "utf8"));
    await c.query("BEGIN");
    // Only synthetic fixture identifiers in the dedicated pilot database.
    await c.query("DELETE FROM shared_pilot.jobs");
    await c.query("DELETE FROM shared_pilot.audit");
    await c.query("DELETE FROM shared_pilot.resources");
    for (const id of ["pilot-owner", "pilot-member", "pilot-outsider", "pilot-team"])
      await c.query("DELETE FROM organization WHERE id=$1", [id]);
    for (const id of ["pilot-owner", "pilot-member", "pilot-outsider"]) {
      await c.query(
        'INSERT INTO "user"(id,name,email,"updatedAt") VALUES($1,$2,$3,now()) ON CONFLICT(id) DO NOTHING',
        [id, id.replace("pilot-", ""), `${id}@example.test`],
      );
    }
    for (const [space, user, shared] of [
      ["pilot-owner", "pilot-owner", false],
      ["pilot-member", "pilot-member", false],
      ["pilot-outsider", "pilot-outsider", false],
      ["pilot-team", "pilot-owner", true],
    ]) {
      await c.query('INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,$1,$1,now())', [
        space,
      ]);
      await c.query(
        'INSERT INTO spaces(id,"organizationId",name,"isDefault","createdByUserId") VALUES($1,$1,$2,true,$3)',
        [space, shared ? "Team workspace" : `${user.replace("pilot-", "")} — Private`, user],
      );
      await c.query(
        'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,\'owner\',now())',
        [`${space}-owner`, space, user],
      );
      if (shared)
        await c.query(
          'INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES($1,$2,$3,\'member\',now())',
          ["pilot-team-member", space, "pilot-member"],
        );
      await c.query(
        'INSERT INTO bots(id,"spaceId","userId",name,color,"updatedAt") VALUES($1,$2,$3,$4,\'ink\',now())',
        [`${space}-bot`, space, user, shared ? "Team assistant" : "Private assistant"],
      );
      await c.query('INSERT INTO threads(id,"spaceId","userId","botId") VALUES($1,$2,$3,$4)', [
        `${space}-thread`,
        space,
        user,
        `${space}-bot`,
      ]);
      await c.query(
        'INSERT INTO memory_documents(id,"spaceId","userId","botId",scope,path,content,"updatedAt") VALUES($1,$2,$3,$4,\'bot\',\'MEMORY.md\',$5,now())',
        [
          `${space}-memory`,
          space,
          user,
          `${space}-bot`,
          shared ? "Team test fact: reporting day is Thursday." : `PRIVATE_CANARY_${space}`,
        ],
      );
      await c.query(
        'INSERT INTO secrets(id,"spaceId","userId",kind,ciphertext) VALUES($1,$2,$3,\'pilot-canary\',$4)',
        [`${space}-secret`, space, user, `NOT_A_REAL_SECRET_${space}`],
      );
      await c.query(
        "INSERT INTO shared_pilot.resources(space_id,bot_id,shared,executor_id,credential_binding) VALUES($1,$2,$3,$4,'offline-test-agent')",
        [space, `${space}-bot`, shared, shared ? "pilot-team-executor" : `${user}-executor`],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seed();
  const folder = new URL(".local/", import.meta.url);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const sessions = Object.fromEntries(
    ["pilot-owner", "pilot-member", "pilot-outsider"].map((id) => [
      randomBytes(32).toString("hex"),
      { id, expiresAt: Date.now() + 86400000 },
    ]),
  );
  await writeFile(new URL("sessions.json", folder), JSON.stringify(sessions, null, 2), {
    mode: 0o600,
  });
  console.log("Synthetic fixtures ready. Local session file created; no production accounts used.");
}
