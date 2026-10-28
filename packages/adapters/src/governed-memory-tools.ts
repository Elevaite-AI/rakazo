import type { GovernedMemoryContext } from "@rakazo/adapter-kit";
import { z } from "zod";

export const GOVERNED_MEMORY_TOOL_NAMES = new Set([
  "save_decision",
  "correct_decision",
  "recall_decisions",
  "decision_history",
  "memory_status",
]);
export const GOVERNED_MEMORY_WRITE_TOOL_NAMES = new Set(["save_decision", "correct_decision"]);
const content = z.string().trim().min(1).max(4_000);
const factId = z.string().trim().min(1).max(200);
const visibility = z.enum(["private", "shared"]);
const schemas = {
  save_decision: z
    .object({ content, visibility, title: z.string().trim().min(1).max(200).optional() })
    .strict(),
  correct_decision: z
    .object({
      factId,
      content,
      expectedRevision: z.number().int().min(1),
      reason: z.string().trim().min(1).max(500),
    })
    .strict(),
  recall_decisions: z
    .object({ query: z.string().trim().min(1).max(5_000), visibility: visibility.optional() })
    .strict(),
  decision_history: z.object({ factId }).strict(),
  memory_status: z.object({}).strict(),
};

const audienceFields = z.object({
  audienceKey: z.string().min(1).max(300),
  audienceLabel: z.string().min(1).max(300),
});

export function decisionAudience(status: unknown, chosenVisibility: unknown) {
  const selected = visibility.parse(chosenVisibility);
  const parsed = z
    .object({
      audiences: z.object({
        private: z.object({ key: z.string(), label: z.string() }),
        shared: z.object({ key: z.string(), label: z.string() }),
      }),
    })
    .passthrough()
    .parse(status);
  return audienceFields.parse({
    audienceKey: parsed.audiences[selected].key,
    audienceLabel: parsed.audiences[selected].label,
  });
}

/** Validate before creating an effect; derived correction visibility is backend-only. */
export function parseGovernedMemoryArgs(
  name: string,
  args: Record<string, unknown>,
  replay = false,
): Record<string, unknown> {
  if (!(name in schemas)) throw new Error("Unknown decision-memory tool.");
  const schema = schemas[name as keyof typeof schemas];
  if (GOVERNED_MEMORY_WRITE_TOOL_NAMES.has(name) && replay) {
    const { audienceKey, audienceLabel, ...inner } = args;
    const audience = audienceFields.parse({ audienceKey, audienceLabel });
    if (name === "correct_decision") {
      const { visibility: savedVisibility, ...rest } = inner;
      return { ...schema.parse(rest), visibility: visibility.parse(savedVisibility), ...audience };
    }
    return { ...schema.parse(inner), ...audience };
  }
  return schema.parse(args);
}

/** Proof is written by answerRunInput, never accepted from model-controlled arguments. */
export function nativeMemoryApproval(
  result: unknown,
  expected: { effectId: string; runId: string; userId: string },
): NonNullable<GovernedMemoryContext["approval"]> {
  const parsed = z
    .object({
      approval: z
        .object({
          effectId: z.string(),
          runId: z.string(),
          approverUserId: z.string(),
          approvedAt: z.iso.datetime(),
          kind: z.literal("native-owner-approval"),
        })
        .strict(),
    })
    .strict()
    .parse(result);
  if (
    parsed.approval.effectId !== expected.effectId ||
    parsed.approval.runId !== expected.runId ||
    parsed.approval.approverUserId !== expected.userId
  ) {
    throw new Error("Decision approval does not match this owner and run.");
  }
  const { runId: _runId, ...approval } = parsed.approval;
  return approval;
}

export function currentDecisionSnapshot(
  history: unknown,
  expectedRevision: number,
): { visibility: "private" | "shared"; audienceKey: string; audienceLabel: string } {
  const parsed = z
    .object({
      revisions: z.array(
        z.object({
          revision: z.number().int(),
          state: z.string(),
          visibility,
          editable: z.boolean(),
          audienceKey: z.string().optional(),
          audienceLabel: z.string().optional(),
        }),
      ),
    })
    .passthrough()
    .parse(history);
  if (parsed.revisions.some((r) => r.state === "pending"))
    throw new Error("A correction is still publishing; wait before correcting again.");
  const current = parsed.revisions.find((r) => r.state === "current");
  if (!current?.editable || current.revision !== expectedRevision)
    throw new Error("Decision revision changed or is unavailable; read its history again.");
  return {
    visibility: current.visibility,
    ...audienceFields.parse({
      audienceKey: current.audienceKey,
      audienceLabel: current.audienceLabel,
    }),
  };
}

export function currentDecisionVisibility(
  history: unknown,
  expectedRevision: number,
): "private" | "shared" {
  return currentDecisionSnapshot(history, expectedRevision).visibility;
}
