import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GovernedMemoryProvider } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { MemoryMonitorState, MemoryMonitorTarget } from "./memory-connection-monitor.js";
import {
  createDiskMemoryMonitorState,
  createMemoryConnectionMonitor,
  memoryConnectionStatus,
} from "./memory-connection-monitor.js";

const first = {
  userId: "owner",
  spaceId: "workspace",
  agentId: "agent-1",
  agentLabel: "Assistant",
  threadId: "thread-1",
};
const next = { ...first, agentId: "agent-2", threadId: "thread-2" };
const ready = { status: "ok", enrolled: false, publicationQueue: { pending: 0, stalled: 0 } };
function setup() {
  let time = 0;
  let saved: MemoryMonitorState = { version: 1, observations: {} };
  const execute = vi.fn<GovernedMemoryProvider["execute"]>(async () => ready as unknown);
  const notify = vi.fn<
    (target: MemoryMonitorTarget, text: string, idempotencyKey: string) => Promise<void>
  >(async () => undefined);
  const listTargets = vi.fn(async () => [first]);
  const deps = {
    provider: { execute },
    notify,
    listTargets,
    now: () => time,
    state: {
      load: async () => structuredClone(saved),
      save: async (value: MemoryMonitorState) => {
        saved = structuredClone(value);
      },
    },
  };
  return {
    deps,
    execute,
    notify,
    listTargets,
    advance: () => {
      time += 60_000;
    },
  };
}

describe("memory connection monitoring", () => {
  it("keeps initial and unchanged healthy observations quiet, including un-enrolled agents", async () => {
    const s = setup(),
      monitor = createMemoryConnectionMonitor(s.deps);
    await monitor.tick();
    await monitor.tick();
    expect(s.execute).toHaveBeenCalledTimes(1);
    s.advance();
    await monitor.tick();
    expect(s.execute).toHaveBeenCalledTimes(2);
    expect(s.notify).not.toHaveBeenCalled();
  });
  it("alerts once per failure and recovery, persisting state across restarts", async () => {
    const s = setup();
    let monitor = createMemoryConnectionMonitor(s.deps);
    await monitor.tick();
    s.advance();
    s.execute.mockRejectedValue(new Error("private endpoint credential"));
    await monitor.tick();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]?.[1]).not.toContain("credential");
    await monitor.stop();
    s.advance();
    monitor = createMemoryConnectionMonitor(s.deps);
    await monitor.tick();
    expect(s.notify).toHaveBeenCalledTimes(1);
    s.advance();
    s.execute.mockResolvedValue(ready);
    await monitor.tick();
    expect(s.notify).toHaveBeenCalledTimes(2);
    expect(s.notify.mock.calls[1]?.[1]).toBe("Memory connection restored.");
  });
  it("retries failed delivery with the identical idempotency key", async () => {
    const s = setup();
    s.execute.mockRejectedValue(new Error("offline"));
    s.notify.mockRejectedValueOnce(new Error("delivery offline"));
    const monitor = createMemoryConnectionMonitor(s.deps);
    await expect(monitor.tick()).rejects.toThrow(/retry/);
    s.advance();
    await monitor.tick();
    expect(s.notify.mock.calls[0]?.[2]).toBe(s.notify.mock.calls[1]?.[2]);
  });
  it("marks stalled publication degraded and never treats malformed status as empty memory", async () => {
    const s = setup();
    s.execute.mockResolvedValue({
      status: "ok",
      enrolled: true,
      publicationQueue: { pending: 2, stalled: 1 },
    });
    const monitor = createMemoryConnectionMonitor(s.deps);
    await monitor.tick();
    expect(s.notify.mock.calls[0]?.[1]).toContain("publication");
    expect(memoryConnectionStatus({ results: [] })).toBe("unavailable");
    expect(memoryConnectionStatus({ status: "ok" })).toBe("unavailable");
    expect(
      memoryConnectionStatus({ status: "ok", publicationQueue: { pending: -1, stalled: 0 } }),
    ).toBe("unavailable");
  });
  it("discovers newly added agents and does not overlap ticks or continue after stop", async () => {
    const s = setup(),
      monitor = createMemoryConnectionMonitor(s.deps);
    await monitor.tick();
    s.advance();
    s.listTargets.mockResolvedValue([first, next]);
    await monitor.tick();
    expect(s.execute).toHaveBeenCalledTimes(3);
    const contexts = s.execute.mock.calls as unknown as Array<
      [string, object, { agentId: string; userId: string }]
    >;
    expect(contexts.at(-1)?.[2]).toMatchObject({ agentId: next.agentId, userId: next.userId });
    await monitor.stop();
    s.advance();
    await monitor.tick();
    expect(s.execute).toHaveBeenCalledTimes(3);
  });
  it("atomically persists metadata with private file permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "memory-monitor-"));
    try {
      const file = path.join(dir, "state.json"),
        state = createDiskMemoryMonitorState(file);
      expect(await state.load()).toEqual({ version: 1, observations: {} });
      const value: MemoryMonitorState = {
        version: 1,
        observations: { fixture: { status: "unavailable", transition: 1, pending: true } },
      };
      await state.save(value);
      expect(await state.load()).toEqual(value);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(file, "utf8")).not.toContain("credential");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("does not overlap probes and aborts shutdown without posting a false failure", async () => {
    const s = setup();
    s.execute.mockImplementation(
      (_operation, _request, context) =>
        new Promise((_resolve, reject) => {
          context.signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const monitor = createMemoryConnectionMonitor(s.deps);
    const first = monitor.tick();
    await vi.waitFor(() => expect(s.execute).toHaveBeenCalledOnce());
    expect(monitor.tick()).toBe(first);
    await monitor.stop();
    await first;
    expect(s.notify).not.toHaveBeenCalled();
  });
  it("reloads transitions after another worker held leadership", async () => {
    const s = setup();
    s.execute.mockRejectedValue(new Error("offline"));
    const firstLeader = createMemoryConnectionMonitor(s.deps);
    await firstLeader.tick();
    s.advance();
    s.execute.mockResolvedValue(ready);
    const secondLeader = createMemoryConnectionMonitor(s.deps);
    await secondLeader.tick();
    s.advance();
    s.execute.mockRejectedValue(new Error("offline again"));
    await firstLeader.tick();
    expect(s.notify).toHaveBeenCalledTimes(3);
    expect(s.notify.mock.calls[0]?.[2]).not.toBe(s.notify.mock.calls[2]?.[2]);
  });
});
