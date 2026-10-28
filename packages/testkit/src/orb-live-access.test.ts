import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { OrbLiveAccess } from "../../../apps/shared-workspace-pilot/orb-live-access.js";

const binding = { executionUserId: "team", botId: "bot", orbAgentId: "agent" };
function setup(
  rows: unknown = [
    {
      id: "member",
      user_id: "canonical",
      is_active: true,
      employment_status: "active",
      ended_at: null,
      updated_at: "2026-01-01",
      agent_access: [
        {
          id: "grant",
          agent_id: "agent",
          agent_type: "rakazo-staging",
          has_access: true,
          created_at: "2026-01-01",
        },
      ],
    },
  ],
) {
  const query = vi.fn().mockResolvedValue({ rows: [{ canonical_id: "canonical" }] });
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
  const access = new OrbLiveAccess({ query } as unknown as Pool, {
    url: "https://orb.example.test/",
    key: "synthetic-server-key",
    fetch: fetcher,
  });
  access.bindings.set("space", binding);
  return { access, query, fetcher };
}
describe("read-only live ORB policy", () => {
  it("uses the server alias binding and explicit resource grant", async () => {
    const { access, fetcher } = setup();
    expect(await access.resolve("alias-login", "space")).toMatchObject({
      executionUserId: "team",
      botIds: ["bot"],
      canSend: true,
    });
    const [url, options] = fetcher.mock.calls[0];
    expect(url.searchParams.get("user_id")).toBe("eq.canonical");
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each(
    [
      [],
      [
        {
          user_id: "canonical",
          is_active: true,
          employment_status: "active",
          ended_at: null,
          agent_access: [],
        },
      ],
      [
        {
          user_id: "canonical",
          is_active: false,
          employment_status: "active",
          ended_at: null,
          agent_access: [],
        },
      ],
      [
        {
          user_id: "wrong",
          is_active: true,
          employment_status: "active",
          ended_at: null,
          agent_access: [],
        },
      ],
    ].map((rows) => ({ rows })),
  )("denies absent, inactive or mismatched authority %j", async ({ rows }) => {
    expect(await setup(rows).access.resolve("user", "space")).toBeNull();
  });
  it("never falls back to a previously allowed result on source failure", async () => {
    const { access, fetcher } = setup();
    expect(await access.resolve("user", "space")).not.toBeNull();
    fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(access.resolve("user", "space")).rejects.toThrow("503");
  });
  it("checks each call and observes revoked live grants", async () => {
    const { access, fetcher } = setup();
    expect(await access.resolve("user", "space")).not.toBeNull();
    fetcher.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            user_id: "canonical",
            is_active: true,
            employment_status: "active",
            ended_at: null,
            agent_access: [],
          },
        ]),
      ),
    );
    expect(await access.resolve("user", "space")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("denies unbound subjects without contacting ORB", async () => {
    const { access, query, fetcher } = setup();
    query.mockResolvedValue({ rows: [] });
    expect(await access.resolve("unknown", "space")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
