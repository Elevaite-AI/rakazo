import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GovernedMemoryContext, GovernedMemoryProvider } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { GOVERNED_MEMORY_TOOL_NAMES } from "./governed-memory-tools.js";

export type MemoryConnectionStatus = "ok" | "degraded" | "unavailable";
export type MemoryMonitorTarget = Pick<
  GovernedMemoryContext,
  "spaceId" | "userId" | "agentId" | "agentLabel"
> & { threadId: string };

type Observation = { status: MemoryConnectionStatus; transition: number; pending: boolean };
export type MemoryMonitorState = { version: 1; observations: Record<string, Observation> };
export interface MemoryMonitorStateStore {
  load(): Promise<MemoryMonitorState>;
  save(state: MemoryMonitorState): Promise<void>;
}

export function createDiskMemoryMonitorState(file: string): MemoryMonitorStateStore {
  return {
    async load() {
      let value: unknown;
      try {
        value = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { version: 1, observations: {} };
        throw new Error("Memory connection monitor state is unavailable");
      }
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid memory connection monitor state");
      const state = value as MemoryMonitorState;
      if (
        state.version !== 1 ||
        !state.observations ||
        typeof state.observations !== "object" ||
        Array.isArray(state.observations)
      )
        throw new Error("Invalid memory connection monitor state");
      for (const observation of Object.values(state.observations)) {
        if (
          !observation ||
          !["ok", "degraded", "unavailable"].includes(observation.status) ||
          !Number.isSafeInteger(observation.transition) ||
          observation.transition < 0 ||
          typeof observation.pending !== "boolean"
        )
          throw new Error("Invalid memory connection monitor state");
      }
      return state;
    },
    async save(state) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.next`;
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}

/** Unknown or malformed status never means empty memory or a successful connection. */
export function memoryConnectionStatus(value: unknown): MemoryConnectionStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unavailable";
  const result = value as { status?: unknown; publicationQueue?: unknown; enrolled?: unknown };
  if (typeof result.enrolled !== "boolean" || result.publicationQueue === undefined)
    return "unavailable";
  if (!["ok", "degraded", "unavailable"].includes(String(result.status))) return "unavailable";
  if (result.publicationQueue !== undefined) {
    if (
      !result.publicationQueue ||
      typeof result.publicationQueue !== "object" ||
      Array.isArray(result.publicationQueue)
    )
      return "unavailable";
    const queue = result.publicationQueue as { pending?: unknown; stalled?: unknown };
    if (
      !Number.isSafeInteger(queue.pending) ||
      !Number.isSafeInteger(queue.stalled) ||
      Number(queue.pending) < 0 ||
      Number(queue.stalled) < 0
    )
      return "unavailable";
    if (Number(queue.stalled) > 0 && result.status === "ok") return "degraded";
  }
  return result.status as MemoryConnectionStatus;
}

export function memoryConnectionNotice(status: MemoryConnectionStatus): string {
  if (status === "ok") return "Memory connection restored.";
  if (status === "degraded")
    return "Memory publication needs attention. New decisions may not be available yet.";
  return "Memory connection needs attention. Saved decisions cannot be verified until it is restored.";
}

/** Invoked by the elected reconciler; bounded probes never overlap or call a model. */
export function createMemoryConnectionMonitor(deps: {
  provider: GovernedMemoryProvider;
  state: MemoryMonitorStateStore;
  listTargets: (afterId: string | undefined, limit: number) => Promise<MemoryMonitorTarget[]>;
  notify: (target: MemoryMonitorTarget, text: string, idempotencyKey: string) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
}) {
  let state: MemoryMonitorState | undefined;
  let persistence = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let cursor: string | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const controller = new AbortController();
  const persist = () => {
    const snapshot = structuredClone(state!);
    persistence = persistence.catch(() => undefined).then(() => deps.state.save(snapshot));
    return persistence;
  };
  const observe = async (target: MemoryMonitorTarget) => {
    if (controller.signal.aborted) return;
    let status: MemoryConnectionStatus;
    try {
      status = memoryConnectionStatus(
        await deps.provider.execute(
          "status",
          {},
          {
            ...target,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
          },
        ),
      );
    } catch {
      if (controller.signal.aborted) return;
      status = "unavailable";
    }
    if (controller.signal.aborted) return;
    const key = createHash("sha256")
      .update(JSON.stringify([target.spaceId, target.userId, target.agentId]))
      .digest("hex");
    const previous = state!.observations[key];
    if (!previous || previous.status !== status) {
      state!.observations[key] = {
        status,
        transition: (previous?.transition ?? 0) + 1,
        pending: previous ? previous.status !== "ok" || status !== "ok" : status !== "ok",
      };
      await persist();
    }
    const current = state!.observations[key]!;
    if (!current.pending) return;
    // Persist the transition before delivery; a retry uses exactly the same message nonce.
    await persist();
    await deps.notify(
      target,
      memoryConnectionNotice(current.status),
      `memory-monitor:${key}:${current.transition}:${current.status}`,
    );
    current.pending = false;
    await persist();
  };
  const run = async () => {
    // Another worker may have held reconciliation leadership since our last tick.
    await persistence.catch(() => undefined);
    state = await deps.state.load();
    let targets = await deps.listTargets(cursor, 20);
    if (targets.length === 0 && cursor) {
      cursor = undefined;
      targets = await deps.listTargets(undefined, 20);
    }
    cursor = targets.length === 20 ? targets.at(-1)?.agentId : undefined;
    let failed = false;
    for (let offset = 0; offset < targets.length && !controller.signal.aborted; offset += 4) {
      const outcomes = await Promise.allSettled(targets.slice(offset, offset + 4).map(observe));
      if (outcomes.some((outcome) => outcome.status === "rejected")) failed = true;
    }
    if (failed) throw new Error("Memory connection monitoring could not finish; it will retry");
  };
  return {
    tick(): Promise<void> {
      const now = (deps.now ?? Date.now)();
      if (stopped || inFlight || now - lastStartedAt < (deps.intervalMs ?? 60_000))
        return inFlight ?? Promise.resolve();
      lastStartedAt = now;
      inFlight = run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    async stop() {
      stopped = true;
      controller.abort();
      await inFlight?.catch(() => undefined);
      await persistence.catch(() => undefined);
    },
  };
}

/** Native unread chat notices, not model turns or semantic-memory ingestion. */
export function createDatabaseMemoryConnectionMonitor(deps: {
  prisma: PrismaClient;
  events: ThreadEvents;
  provider: GovernedMemoryProvider;
  dataDir: string;
}) {
  return createMemoryConnectionMonitor({
    provider: deps.provider,
    state: createDiskMemoryMonitorState(path.join(deps.dataDir, "memory-connection-monitor.json")),
    listTargets: (afterId, limit) =>
      runAsSystem("Check current agents' configured memory connection", async () => {
        const bots = await deps.prisma.bot.findMany({
          where: {
            archivedAt: null,
            NOT: { disabledBuiltinTools: { hasEvery: [...GOVERNED_MEMORY_TOOL_NAMES] } },
            space: { deletingAt: null },
            thread: { isNot: null },
            ...(afterId ? { id: { gt: afterId } } : {}),
          },
          orderBy: { id: "asc" },
          take: limit,
          select: {
            id: true,
            userId: true,
            spaceId: true,
            name: true,
            thread: { select: { id: true } },
          },
        });
        return bots.map((bot) => ({
          spaceId: bot.spaceId,
          userId: bot.userId,
          agentId: bot.id,
          agentLabel: bot.name,
          threadId: bot.thread!.id,
        }));
      }),
    notify: (target, text, clientNonce) =>
      runAsTenant(target, async () => {
        const bot = await deps.prisma.bot.findFirst({
          where: {
            id: target.agentId,
            userId: target.userId,
            spaceId: target.spaceId,
            archivedAt: null,
          },
          select: { thread: { select: { id: true } } },
        });
        if (bot?.thread?.id !== target.threadId) return;
        const event = await deps.prisma.$transaction(async (tx) => {
          // Same thread-first lock order as ordinary message/event appends.
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
          const duplicate = await tx.message.findUnique({
            where: { threadId_clientNonce: { threadId: target.threadId, clientNonce } },
            select: { id: true },
          });
          if (duplicate) return null;
          const blocks: MessageBlock[] = [{ kind: "text", text }];
          const message = await createThreadMessageInTransaction(tx, {
            threadId: target.threadId,
            botId: target.agentId,
            role: "bot",
            blocks,
            clientNonce,
            markUnread: true,
          });
          return appendEventInTransaction(tx, {
            spaceId: target.spaceId,
            threadId: target.threadId,
            botId: target.agentId,
            type: "thread.message.created",
            payload: { messageId: message.id, role: "bot", blocks },
          });
        });
        if (event) await deps.events.notify(target.threadId, event.seq).catch(() => undefined);
      }),
  });
}
