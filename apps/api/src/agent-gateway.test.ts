import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { type AgentGatewayDeps, mountAgentGatewayRoutes } from "./agent-gateway.js";

const TOKEN = "agent-gateway-test-token-value";

function createHarness() {
  const findBots = vi.fn(async () => [
    {
      id: "bot-1",
      name: "Operator",
      title: "Operations agent",
      description: "Gets work done",
      space: { id: "space-1", name: "Team" },
    },
  ]);
  const findBot = vi.fn(async () => ({
    id: "bot-1",
    name: "Operator",
    spaceId: "space-1",
    userId: "owner-1",
    thread: { id: "thread-1" },
  }));
  const findRun = vi.fn(async () => ({
    id: "run-1",
    status: "completed",
    createdAt: new Date("2026-10-27T01:00:00.000Z"),
    startedAt: new Date("2026-10-27T01:00:01.000Z"),
    completedAt: new Date("2026-10-27T01:00:02.000Z"),
    bot: { id: "bot-1", name: "Operator" },
  }));
  const findMessage = vi.fn(async () => ({
    blocks: [
      { kind: "text", text: "Finished the task." },
      { kind: "computer", command: "private detail" },
    ],
  }));
  const sendUserMessage = vi.fn(async () => ({ messageId: "message-1", runId: "run-1", seq: 2 }));
  const enqueue = vi.fn(async () => undefined);
  const deps = {
    prisma: {
      bot: { findMany: findBots, findFirst: findBot },
      run: { findFirst: findRun },
      message: { findFirst: findMessage },
    },
    events: { sendUserMessage },
    jobs: { enqueue },
    token: TOKEN,
    allowedSpaceIds: ["space-1"],
  } as unknown as AgentGatewayDeps;
  const app = new Hono();
  mountAgentGatewayRoutes(app, deps);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
    });
  return { app, request, findBots, findBot, findRun, findMessage, sendUserMessage, enqueue };
}

describe("agent gateway", () => {
  it("requires its bearer token", async () => {
    const { app } = createHarness();
    const response = await app.request("/api/v1/agent-gateway/agents");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("lists only the public fields of agents in allowed spaces", async () => {
    const { request, findBots } = createHarness();
    const response = await request("/api/v1/agent-gateway/agents");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        {
          id: "bot-1",
          name: "Operator",
          title: "Operations agent",
          description: "Gets work done",
          space: { id: "space-1", name: "Team" },
        },
      ],
    });
    expect(findBots).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: { in: ["space-1"] }, archivedAt: null, thread: { isNot: null } },
      }),
    );
  });

  it("queues a task for an allowed agent without putting the external id in the database", async () => {
    const { request, sendUserMessage, enqueue } = createHarness();
    const response = await request("/api/v1/agent-gateway/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot-1", task: "Prepare the report", messageId: "voice-42" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "queued",
      runId: "run-1",
      messageId: "message-1",
    });
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "space-1",
        botId: "bot-1",
        trigger: "webhook",
        allowParallelRun: true,
        blocks: [{ kind: "text", text: "Prepare the report" }],
        clientNonce: expect.stringMatching(/^agent-gateway:[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(sendUserMessage.mock.calls[0])).not.toContain("voice-42");
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ payload: { runId: "run-1" } }));
  });

  it("does not reveal an agent outside the allowlist", async () => {
    const { request, findBot, sendUserMessage } = createHarness();
    findBot.mockResolvedValueOnce(null as never);
    const response = await request("/api/v1/agent-gateway/tasks", {
      method: "POST",
      body: JSON.stringify({ agentId: "bot-other", task: "Do something" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Agent not found" });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns only written reply text for a completed task", async () => {
    const { request } = createHarness();
    const response = await request("/api/v1/agent-gateway/tasks/run-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "run-1",
      status: "completed",
      agent: { id: "bot-1", name: "Operator" },
      result: "Finished the task.",
    });
  });
});
