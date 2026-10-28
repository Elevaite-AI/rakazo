import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrbVersionedAccess } from "../../../apps/shared-workspace-pilot/orb-versioned-access.js";

const enabled = process.env.VERIFY_AUTHORITY === "1";
describe.runIf(enabled)("scoped versioned permission authority", () => {
  const canonical = randomUUID(),
    alias = randomUUID(),
    member = randomUUID(),
    agent = randomUUID(),
    space = randomUUID(),
    subject = randomUUID(),
    otherSpace = randomUUID();
  let owner: pg.Pool, reader: pg.Pool, access: OrbVersionedAccess;
  const resolve = () => access.resolve(subject, space);
  beforeAll(async () => {
    for (const raw of [process.env.AUTHORITY_OWNER_URL, process.env.AUTHORITY_READER_URL]) {
      const url = new URL(raw!);
      if (
        url.hostname !== "127.0.0.1" ||
        url.port !== "15443" ||
        url.pathname !== "/orb_permission_stage"
      )
        throw new Error("Isolated authority required");
    }
    owner = new pg.Pool({ connectionString: process.env.AUTHORITY_OWNER_URL });
    reader = new pg.Pool({ connectionString: process.env.AUTHORITY_READER_URL });
    access = new OrbVersionedAccess(reader, new Set([space, otherSpace]));
    await owner.query("INSERT INTO public.team_member VALUES($1,$2,true,'active',NULL)", [
      member,
      canonical,
    ]);
    await owner.query(
      "INSERT INTO permission_authority.aliases(profile_id,canonical_id) VALUES($1,$2)",
      [alias, canonical],
    );
    await owner.query(
      "INSERT INTO permission_authority.principals(subject_id,profile_id) VALUES($1,$2)",
      [subject, alias],
    );
    for (const id of [space, otherSpace])
      await owner.query(
        "INSERT INTO permission_authority.resources(space_id,execution_user_id,bot_id) VALUES($1,$2,$3)",
        [id, "team-executor", "shared-agent"],
      );
    await owner.query("INSERT INTO permission_authority.resource_bindings VALUES($1,$2)", [
      agent,
      space,
    ]);
    await owner.query(
      "INSERT INTO public.agent_access(team_member_id,agent_type,agent_id,has_access) VALUES($1,'rakazo-staging',$2,true)",
      [member, agent],
    );
    await owner.query(
      "INSERT INTO permission_authority.reader_scopes(login_name,space_id) VALUES('rakazo_permission_reader',$1)",
      [space],
    );
    await owner.query(
      "INSERT INTO permission_authority.grants(canonical_id,space_id,allowed) VALUES($1,$2,true)",
      [canonical, otherSpace],
    );
  });
  afterAll(async () => {
    await owner?.query(
      "DELETE FROM permission_authority.reader_scopes WHERE login_name='rakazo_permission_reader' AND space_id=$1",
      [space],
    );
    await reader?.end();
    await owner?.end();
  });
  it("returns a decision only for the explicit identity and scoped workspace", async () => {
    expect(await resolve()).toMatchObject({ canSend: true, executionUserId: "team-executor" });
    expect(await access.resolve(subject, otherSpace)).toBeNull();
    expect(await access.resolve("unknown", space)).toBeNull();
  });
  it("cannot read source or authority tables, write grants, create objects, or assume owner", async () => {
    for (const sql of [
      "SELECT * FROM public.team_member",
      "SELECT * FROM public.agent_access",
      "SELECT * FROM permission_authority.grants",
      "UPDATE permission_authority.grants SET allowed=true",
      "CREATE TABLE public.forbidden(id int)",
      "SET ROLE postgres",
    ])
      await expect(reader.query(sql)).rejects.toThrow();
    await reader.query("SET default_transaction_read_only=off");
    await expect(reader.query("UPDATE public.agent_access SET has_access=true")).rejects.toThrow();
    await reader.query("SET default_transaction_read_only=on");
  });
  it("detects revoke/regrant within one transaction even with the same source row ID", async () => {
    const before = (await resolve())!;
    const connection = await owner.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "UPDATE public.agent_access SET has_access=false WHERE team_member_id=$1",
        [member],
      );
      await connection.query(
        "UPDATE public.agent_access SET has_access=true WHERE team_member_id=$1",
        [member],
      );
      await connection.query("COMMIT");
    } finally {
      connection.release();
    }
    expect((await resolve())!.revision).not.toBe(before.revision);
  });
  it("denies revocation immediately and changes revision on regrant", async () => {
    const before = (await resolve())!.revision;
    await owner.query("UPDATE public.agent_access SET has_access=false WHERE team_member_id=$1", [
      member,
    ]);
    expect(await resolve()).toBeNull();
    await owner.query("UPDATE public.agent_access SET has_access=true WHERE team_member_id=$1", [
      member,
    ]);
    expect((await resolve())!.revision).not.toBe(before);
  });
  it("versions member offboarding and reactivation", async () => {
    const before = (await resolve())!.revision;
    await owner.query(
      "UPDATE public.team_member SET employment_status='ended',ended_at=now() WHERE id=$1",
      [member],
    );
    expect(await resolve()).toBeNull();
    await owner.query(
      "UPDATE public.team_member SET employment_status='active',ended_at=NULL WHERE id=$1",
      [member],
    );
    expect((await resolve())!.revision).not.toBe(before);
  });
  it("versions identity bindings and reader-scope removal/recreation", async () => {
    const before = (await resolve())!.revision;
    await owner.query(
      "UPDATE permission_authority.aliases SET canonical_id=canonical_id WHERE profile_id=$1",
      [alias],
    );
    expect((await resolve())!.revision).not.toBe(before);
    const current = (await resolve())!.revision;
    await owner.query(
      "DELETE FROM permission_authority.reader_scopes WHERE login_name='rakazo_permission_reader' AND space_id=$1",
      [space],
    );
    expect(await resolve()).toBeNull();
    await owner.query(
      "INSERT INTO permission_authority.reader_scopes(login_name,space_id) VALUES('rakazo_permission_reader',$1)",
      [space],
    );
    expect((await resolve())!.revision).not.toBe(current);
  });
  it("preserves unrelated grant revisions and rejects resource rebinding", async () => {
    const before = (await resolve())!.revision;
    await owner.query("UPDATE permission_authority.grants SET allowed=false WHERE space_id=$1", [
      otherSpace,
    ]);
    expect((await resolve())!.revision).toBe(before);
    await expect(
      owner.query(
        "UPDATE permission_authority.resource_bindings SET space_id=$1 WHERE orb_agent_id=$2",
        [otherSpace, agent],
      ),
    ).rejects.toThrow("immutable");
  });
  it("does not revive cascaded grants when a deleted member is recreated", async () => {
    const before = (await resolve())!.revision;
    const source = (
      await owner.query("SELECT id FROM public.agent_access WHERE team_member_id=$1", [member])
    ).rows[0];
    await owner.query("DELETE FROM public.team_member WHERE id=$1", [member]);
    expect(await resolve()).toBeNull();
    await owner.query("INSERT INTO public.team_member VALUES($1,$2,true,'active',NULL)", [
      member,
      canonical,
    ]);
    expect(await resolve()).toBeNull();
    await owner.query(
      "INSERT INTO public.agent_access(id,team_member_id,agent_type,agent_id,has_access) VALUES($1,$2,'rakazo-staging',$3,true)",
      [source.id, member, agent],
    );
    expect((await resolve())!.revision).not.toBe(before);
  });
  it("fails closed without cached decisions when the connection fails", async () => {
    expect(await resolve()).not.toBeNull();
    const closed = new pg.Pool({ connectionString: process.env.AUTHORITY_READER_URL });
    const p = new OrbVersionedAccess(closed, new Set([space]));
    await closed.end();
    await expect(p.resolve(subject, space)).rejects.toThrow();
  });
});
