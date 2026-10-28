import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "./config.mjs";

export class Denied extends Error {
  constructor() {
    super("Not found or access removed");
    this.status = 404;
  }
}
export class Invalid extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// The caller comes from the authenticated transport, never from request JSON.
// This is the enforcement seam an ORB grant adapter must feed; no ORB network
// calls, user impersonation, or personal credential fallback are permitted here.
export function createAccess() {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 6 });
  async function scoped(userId, spaceId, fn) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('app.space_id',$1,true),set_config('app.user_id',$2,true),set_config('app.rls_version','2',true),set_config('app.rls_bypass','off',true)",
        [spaceId, userId],
      );
      // Serialize reads/writes against revocation. Once DELETE commits, no new
      // operation can borrow an old membership or reuse a queued entitlement.
      const member = (
        await c.query(
          'SELECT id,role,"organizationId" FROM space_members WHERE "spaceId"=$1 AND "userId"=$2 FOR SHARE',
          [spaceId, userId],
        )
      ).rows[0];
      if (!member) throw new Denied();
      const result = await fn(c, member);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function resource(c, userId, spaceId, botId) {
    const r = (
      await c.query(
        `SELECT r.*,b.name,b."userId",t.id thread_id FROM shared_pilot.resources r JOIN bots b ON b.id=r.bot_id JOIN threads t ON t."botId"=b.id WHERE r.space_id=$1 AND r.bot_id=$2 AND b."spaceId"=$1 AND (r.shared OR b."userId"=$3)`,
        [spaceId, botId, userId],
      )
    ).rows[0];
    if (!r) throw new Denied();
    return r;
  }
  const audit = (c, space, user, action, subject) =>
    c.query(
      "INSERT INTO shared_pilot.audit(space_id,actor_id,action,subject_id) VALUES($1,$2,$3,$4)",
      [space, user, action, subject],
    );
  return {
    pool,
    scoped,
    async spaces(userId) {
      return (
        await pool.query(
          'SELECT s.id,s.name,m.role FROM space_members m JOIN spaces s ON s.id=m."spaceId" WHERE m."userId"=$1 ORDER BY s.name',
          [userId],
        )
      ).rows;
    },
    async snapshot(userId, spaceId) {
      return scoped(userId, spaceId, async (c, m) => {
        const resources = (
          await c.query(
            'SELECT r.bot_id,r.shared,b.name FROM shared_pilot.resources r JOIN bots b ON b.id=r.bot_id WHERE r.space_id=$1 AND (r.shared OR b."userId"=$2)',
            [spaceId, userId],
          )
        ).rows;
        return { role: m.role, agents: resources };
      });
    },
    async thread(userId, spaceId, botId) {
      return scoped(userId, spaceId, async (c) => {
        const r = await resource(c, userId, spaceId, botId);
        return (
          await c.query(
            'SELECT id,seq,role,blocks FROM messages WHERE "threadId"=$1 ORDER BY seq',
            [r.thread_id],
          )
        ).rows;
      });
    },
    async memory(userId, spaceId, botId) {
      return scoped(userId, spaceId, async (c) => {
        await resource(c, userId, spaceId, botId);
        return (
          await c.query(
            'SELECT path,content FROM memory_documents WHERE "spaceId"=$1 AND "botId"=$2',
            [spaceId, botId],
          )
        ).rows;
      });
    },
    async enqueue(userId, spaceId, botId, body) {
      if (
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 4000 ||
        typeof body.nonce !== "string" ||
        !body.nonce ||
        body.nonce.length > 100
      )
        throw new Invalid("Text and request identifier required");
      // Explicit allowlist: a body cannot select an actor or credential principal.
      if (Object.keys(body).some((k) => !["text", "nonce"].includes(k)))
        throw new Invalid("Unexpected field");
      return scoped(userId, spaceId, async (c, m) => {
        const r = await resource(c, userId, spaceId, botId);
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          JSON.stringify([spaceId, userId, body.nonce]),
        ]);
        const existing = (
          await c.query(
            "SELECT * FROM shared_pilot.jobs WHERE space_id=$1 AND requester_id=$2 AND nonce=$3",
            [spaceId, userId, body.nonce],
          )
        ).rows[0];
        if (existing) {
          if (existing.text !== body.text || existing.bot_id !== botId)
            throw new Invalid("Request identifier conflict");
          return existing;
        }
        const job = (
          await c.query(
            `INSERT INTO shared_pilot.jobs(id,space_id,bot_id,requester_id,membership_id,executor_id,text,nonce,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued') RETURNING *`,
            [randomUUID(), spaceId, botId, userId, m.id, r.executor_id, body.text, body.nonce],
          )
        ).rows[0];
        await audit(c, spaceId, userId, "queued", job.id);
        return job;
      });
    },
    async run(userId, spaceId, jobId) {
      return scoped(userId, spaceId, async (c, actor) => {
        const job = (
          await c.query("SELECT * FROM shared_pilot.jobs WHERE id=$1 AND space_id=$2", [
            jobId,
            spaceId,
          ])
        ).rows[0];
        if (!job || (job.requester_id !== userId && actor.role !== "owner")) throw new Denied();
        if (job.status !== "queued") return { status: job.status };
        const requester = (
          await c.query(
            'SELECT id FROM space_members WHERE id=$1 AND "spaceId"=$2 AND "userId"=$3 FOR SHARE',
            [job.membership_id, spaceId, job.requester_id],
          )
        ).rows[0];
        const locked = (
          await c.query("SELECT status FROM shared_pilot.jobs WHERE id=$1 FOR UPDATE", [jobId])
        ).rows[0];
        if (locked.status !== "queued") return { status: locked.status };
        if (!requester) {
          await c.query("UPDATE shared_pilot.jobs SET status='cancelled' WHERE id=$1", [job.id]);
          return { status: "cancelled" };
        }
        const r = await resource(c, job.requester_id, spaceId, job.bot_id);
        if (r.executor_id !== job.executor_id || r.credential_binding !== "offline-test-agent")
          throw new Denied();
        const seq = (
          await c.query(
            'UPDATE threads SET "nextMessageSeq"="nextMessageSeq"+2 WHERE id=$1 RETURNING "nextMessageSeq"',
            [r.thread_id],
          )
        ).rows[0].nextMessageSeq;
        for (const [offset, role, blocks] of [
          [-1, "user", [{ type: "text", text: job.text, authorId: job.requester_id }]],
          [
            0,
            "assistant",
            [
              {
                type: "text",
                text: `Pilot acknowledgement: ${job.text}`,
                executorId: r.executor_id,
                credentialBinding: r.credential_binding,
              },
            ],
          ],
        ]) {
          await c.query(
            'INSERT INTO messages(id,"threadId",seq,role,blocks,"searchTokens") VALUES($1,$2,$3,$4,$5,ARRAY[]::integer[])',
            [randomUUID(), r.thread_id, seq + offset, role, JSON.stringify(blocks)],
          );
        }
        await c.query("UPDATE shared_pilot.jobs SET status='completed' WHERE id=$1", [job.id]);
        await audit(c, spaceId, job.requester_id, "completed", job.id);
        return { status: "completed" };
      });
    },
    async members(userId, spaceId) {
      return scoped(userId, spaceId, async (c, m) => {
        if (m.role !== "owner") throw new Denied();
        return (
          await c.query('SELECT "userId",role FROM space_members WHERE "spaceId"=$1', [spaceId])
        ).rows;
      });
    },
    async revoke(userId, spaceId, targetId) {
      if (userId === targetId) throw new Invalid("Self-removal is disabled in this pilot");
      return scoped(userId, spaceId, async (c, m) => {
        if (m.role !== "owner") throw new Denied();
        const target = (
          await c.query(
            'SELECT role FROM space_members WHERE "spaceId"=$1 AND "userId"=$2 FOR UPDATE',
            [spaceId, targetId],
          )
        ).rows[0];
        if (!target || target.role === "owner") throw new Denied();
        await c.query('DELETE FROM space_members WHERE "spaceId"=$1 AND "userId"=$2', [
          spaceId,
          targetId,
        ]);
        await c.query(
          "UPDATE shared_pilot.jobs SET status='cancelled' WHERE space_id=$1 AND requester_id=$2 AND status='queued'",
          [spaceId, targetId],
        );
        await audit(c, spaceId, userId, "revoked", targetId);
        return { revoked: true };
      });
    },
    close: () => pool.end(),
  };
}
