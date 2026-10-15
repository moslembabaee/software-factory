import { z } from "zod";

export const IntakeSchema = z.strictObject({
  description: z.string().min(1).max(10_000).regex(/\S/),
});

export const TaskProposalSchema = z.strictObject({
  phase: z.string().min(1),
  title: z.string().min(1).max(160),
  description: z.string().min(1),
  assigned_agent: z.enum(["claude", "codex", "antigravity"]),
  verification_cmd: z.literal("npm run typecheck && npm test"),
  verification_gates: z.array(z.string().min(1)).min(1),
});
export type TaskProposal = z.infer<typeof TaskProposalSchema>;

export const AskPlanSchema = z.strictObject({
  description: z.string(),
  tasks: z.array(TaskProposalSchema).min(1).max(36),
  assumptions: z.array(z.string()),
});
export type AskPlan = z.infer<typeof AskPlanSchema>;

export const PendingTaskSchema = TaskProposalSchema.extend({
  id: z.string().min(1),
  status: z.literal("pending"),
  retry_count: z.literal(0),
  tenant_id: z.uuid(),
  project_id: z.uuid(),
  created_by: z.uuid(),
  created_at: z.iso.datetime(),
  intake_id: z.string().min(1),
});
export type PendingTask = z.infer<typeof PendingTaskSchema>;

export const AskAcceptanceSchema = z.strictObject({
  tasks: z.array(PendingTaskSchema).min(1),
  request_id: z.uuid(),
});
export type AskAcceptance = z.infer<typeof AskAcceptanceSchema>;

/** Bounded local planning: prompt text is data, never agent or shell configuration. */
export function proposeTasks(input: unknown): AskPlan {
  const description = IntakeSchema.parse(input).description.trim();
  const requirements = description
    .split(/\n+|;\s*|(?<=[.!?])\s+(?=[A-Z])/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim())
    .filter(Boolean);
  if (requirements.length > 12) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["description"],
        message: "Describe at most 12 requirements per plan",
      },
    ]);
  }
  const tasks = requirements.flatMap((requirement): TaskProposal[] => {
    const subject =
      requirement.length > 110 ? `${requirement.slice(0, 107)}…` : requirement;
    const common = {
      verification_cmd: "npm run typecheck && npm test" as const,
    };
    return [
      {
        ...common,
        phase: "Discovery & design",
        title: `Design: ${subject}`,
        assigned_agent: "claude",
        description: `Clarify acceptance criteria and design the change for: ${requirement}`,
        verification_gates: [
          "Acceptance criteria and affected interfaces are documented",
          "Tenant boundaries and dependencies are identified",
        ],
      },
      {
        ...common,
        phase: "Implementation",
        title: `Build: ${subject}`,
        assigned_agent: "codex",
        description: `Implement the agreed design for: ${requirement}`,
        verification_gates: [
          "Implementation meets the acceptance criteria",
          "Type checking and automated tests pass",
        ],
      },
      {
        ...common,
        phase: "Verification",
        title: `Verify: ${subject}`,
        assigned_agent: "antigravity",
        description: `Review behavior, regression coverage and tenant isolation for: ${requirement}`,
        verification_gates: [
          "Independent review covers the requested behavior",
          "npm run typecheck && npm test passes",
        ],
      },
    ];
  });
  return AskPlanSchema.parse({
    description,
    tasks,
    assumptions: [
      "This local draft uses one design, implementation and verification task per requirement; review the scope before accepting.",
      "Tasks remain pending until separately approved. Acceptance does not start a build.",
      "The repository's trusted verification command is used for every task.",
    ],
  });
}
