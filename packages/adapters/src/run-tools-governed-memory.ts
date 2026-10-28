import { createHash } from "node:crypto";
import type { GovernedMemoryContext } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  GOVERNED_MEMORY_TOOL_NAMES,
  GOVERNED_MEMORY_WRITE_TOOL_NAMES,
  nativeMemoryApproval,
} from "./governed-memory-tools.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandler, ToolHandlers } from "./run-tool-gate.js";

export async function callDecisionMemory(ctx: RunContext, call: ToolCall) {
  const { deps, run, bot, runId, thread, context } = ctx;
  const { name, args, applied } = call;
  const sourceMessage = ctx.source.sourceMessage;
  if (!deps.governedMemory) throw new Error("Decision memory is not configured.");
  const owner = await deps.prisma.user.findUnique({
    where: { id: run.userId },
    select: { name: true },
  });
  if (!owner) throw new Error("Decision memory owner is no longer available.");
  const memoryContext: GovernedMemoryContext = {
    userLabel: owner?.name ?? undefined,
    spaceId: run.spaceId,
    userId: run.userId,
    agentId: bot.id,
    agentLabel: bot.name,
    runId,
    threadId: thread.id,
    sourceMessageId: run.sourceMessageId ?? undefined,
    signal: context.signal,
  };
  if (GOVERNED_MEMORY_WRITE_TOOL_NAMES.has(name)) {
    if (
      !applied ||
      !sourceMessage ||
      sourceMessage.role !== "user" ||
      sourceMessage.threadId !== thread.id ||
      !sourceMessage.createdAt ||
      !run.sourceMessageId
    )
      throw new Error("Authenticated decision source is unavailable.");
    memoryContext.approval = nativeMemoryApproval(applied.effect.result, {
      effectId: applied.effect.id,
      runId,
      userId: run.userId,
    });
    const sourceText = (sourceMessage.blocks as MessageBlock[])
      .filter((b): b is Extract<MessageBlock, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("\n");
    memoryContext.sourceTextHash = createHash("sha256").update(sourceText).digest("hex");
    memoryContext.sourceRecordedAt = sourceMessage.createdAt.toISOString();
    return deps.governedMemory.execute(
      "publish",
      { ...args, expectedRevision: name === "save_decision" ? 0 : args.expectedRevision },
      memoryContext,
    );
  }
  const operation =
    name === "recall_decisions" ? "search" : name === "decision_history" ? "history" : "status";
  return deps.governedMemory.execute(operation, args, memoryContext);
}
const handler: ToolHandler = async (ctx, call) => call.finish(await callDecisionMemory(ctx, call));
export const governedMemoryTools: ToolHandlers = Object.fromEntries(
  [...GOVERNED_MEMORY_TOOL_NAMES].map((name) => [name, handler]),
);
