import { afterEach, expect, it, vi } from "vitest";
import { OrbDecisionAccess } from "../../../apps/shared-workspace-pilot/orb-decision-access.js";

afterEach(() => vi.unstubAllGlobals());
it("does not contact the service for an unrelated workspace", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const a = new OrbDecisionAccess(
    "http://127.0.0.1:15446/v1/resolve",
    "a".repeat(64),
    new Set(["shared"]),
  );
  expect(await a.resolve("subject", "private")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects insecure remote endpoints and credentials embedded in URLs", () => {
  for (const url of [
    "http://example.test/v1/resolve",
    "https://user:password@example.test/v1/resolve",
    "https://example.test/sql",
  ]) {
    expect(() => new OrbDecisionAccess(url, "a".repeat(64), new Set(["shared"]))).toThrow();
  }
});
it("fails closed on unavailable or malformed decisions", async () => {
  const a = new OrbDecisionAccess(
    "http://127.0.0.1:15446/v1/resolve",
    "a".repeat(64),
    new Set(["shared"]),
  );
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ grant: { canSend: true } })),
  );
  await expect(a.resolve("subject", "shared")).rejects.toThrow();
  await expect(a.resolve("subject", "shared")).rejects.toThrow();
});
it("sends only a scoped decision request and strips unexpected response fields", async () => {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      grant: {
        executionUserId: "service",
        botIds: ["bot"],
        revision: "v1",
        canSend: true,
        approvalRevision: "a1",
        secret: "omit",
      },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const a = new OrbDecisionAccess(
    "http://127.0.0.1:15446/v1/resolve",
    "a".repeat(64),
    new Set(["shared"]),
  );
  expect(await a.resolve("subject", "shared")).toEqual({
    executionUserId: "service",
    botIds: ["bot"],
    revision: "v1",
    canSend: true,
    approvalRevision: "a1",
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    subject: "subject",
    spaceId: "shared",
  });
  expect(fetch.mock.calls[0][1].redirect).toBe("error");
});
