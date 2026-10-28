import { createHash } from "node:crypto";
import { type JobPublisher, runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { hasValidBearerToken } from "@rakazo/core";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

const AGENT_GATEWAY_MAX_BODY_BYTES = 16 * 1024;
const AGENT_GATEWAY_MAX_TASK_CHARS = 8_000;
const AGENT_GATEWAY_MAX_MESSAGE_ID_CHARS = 256;

export interface AgentGatewayDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  token: string;
  allowedSpaceIds: string[];
}

type TaskRequest = { agentId: string; task: string; messageId?: string };

function externalTaskPrompt(task: string): string {
  return [
    "External owner request received through the agent gateway.",
    "Treat it like a direct user request. Return a concise written result suitable for a voice assistant.",
    "",
    task,
  ].join("\n");
}

function taskClientNonce(messageId: string): string {
  return `agent-gateway:${createHash("sha256").update(messageId).digest("hex")}`;
}

function textFromBlocks(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return (value as MessageBlock[])
    .filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function parseTaskRequest(raw: string): TaskRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const messageId = typeof input.messageId === "string" ? input.messageId.trim() : undefined;
  if (!agentId || !task || task.length > AGENT_GATEWAY_MAX_TASK_CHARS) return null;
  if (
    messageId !== undefined &&
    (!messageId || messageId.length > AGENT_GATEWAY_MAX_MESSAGE_ID_CHARS)
  ) {
    return null;
  }
  return { agentId, task, ...(messageId ? { messageId } : {}) };
}

export function mountAgentGatewayRoutes(app: Hono, deps: AgentGatewayDeps): void {
  const allowedSpaceIds = [...new Set(deps.allowedSpaceIds.map((id) => id.trim()).filter(Boolean))];
  if (!deps.token || allowedSpaceIds.length === 0) return;

  app.use("/api/v1/agent-gateway/*", async (c, next) => {
    if (!hasValidBearerToken(c.req.header("authorization"), deps.token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/v1/agent-gateway/agents", async (c) => {
    const bots = await deps.prisma.bot.findMany({
      where: { spaceId: { in: allowedSpaceIds }, archivedAt: null, thread: { isNot: null } },
      select: {
        id: true,
        name: true,
        title: true,
        description: true,
        space: { select: { id: true, name: true } },
      },
      orderBy: [{ space: { name: "asc" } }, { position: "asc" }, { name: "asc" }],
    });
    return c.json({ agents: bots });
  });

  app.post("/api/v1/agent-gateway/tasks", async (c) => {
    const raw = await readBoundedBody(c.req.raw, AGENT_GATEWAY_MAX_BODY_BYTES);
    if (raw === null) return c.json({ error: "Payload too large" }, 413);
    const input = parseTaskRequest(raw);
    if (!input) return c.json({ error: "Invalid request" }, 400);

    const bot = await deps.prisma.bot.findFirst({
      where: { id: input.agentId, spaceId: { in: allowedSpaceIds }, archivedAt: null },
      select: {
        id: true,
        name: true,
        spaceId: true,
        userId: true,
        thread: { select: { id: true } },
      },
    });
    if (!bot?.thread) return c.json({ error: "Agent not found" }, 404);

    const sent = await deps.events.sendUserMessage({
      spaceId: bot.spaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      userId: bot.userId,
      blocks: [{ kind: "text", text: input.task }],
      prompt: externalTaskPrompt(input.task),
      trigger: "webhook",
      allowParallelRun: true,
      ...(input.messageId ? { clientNonce: taskClientNonce(input.messageId) } : {}),
    });
    if (!sent.runId) return c.json({ error: "Agent did not accept the task" }, 409);
    await deps.jobs.enqueue(runContinueJob(sent.runId));
    return c.json({ status: "queued", runId: sent.runId, messageId: sent.messageId }, 202);
  });

  app.get("/api/v1/agent-gateway/tasks/:runId", async (c) => {
    const run = await deps.prisma.run.findFirst({
      where: { id: c.req.param("runId"), spaceId: { in: allowedSpaceIds } },
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        bot: { select: { id: true, name: true } },
      },
    });
    if (!run) return c.json({ error: "Task not found" }, 404);

    const response =
      run.status === "completed"
        ? await deps.prisma.message.findFirst({
            where: { runId: run.id, role: "bot" },
            orderBy: { seq: "desc" },
            select: { blocks: true },
          })
        : null;
    const result = textFromBlocks(response?.blocks);
    return c.json({
      runId: run.id,
      status: run.status,
      agent: run.bot,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      ...(run.status === "completed" ? { result } : {}),
    });
  });
}
