export interface TriggerDecision {
  readonly run: boolean;
  readonly reason: string;
}

export interface TriggerInputs {
  readonly eventName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly agentBranchPrefix?: string;
}

const DEFAULT_AGENT_BRANCH_PREFIX = "agent/issue-";

export function decideTrigger(inputs: TriggerInputs): TriggerDecision {
  const { eventName, payload } = inputs;
  const agentPrefix = inputs.agentBranchPrefix ?? DEFAULT_AGENT_BRANCH_PREFIX;

  switch (eventName) {
    case "schedule":
      return { run: true, reason: "scheduled heartbeat" };

    case "workflow_dispatch":
      return { run: true, reason: "manual dispatch" };

    case "issues": {
      const action = stringField(payload, "action");
      if (action === "closed") {
        return { run: true, reason: "issue closed" };
      }
      const labels = issueLabels(payload);
      if (labels.includes("sprint")) {
        return { run: true, reason: `sprint issue ${action ?? "event"}` };
      }
      return {
        run: false,
        reason: `issue ${action ?? "event"} without sprint label`,
      };
    }

    case "pull_request": {
      const headRef = prHeadRef(payload);
      if (headRef?.startsWith(agentPrefix)) {
        const action = stringField(payload, "action");
        if (action === "closed" && prMerged(payload) === false) {
          return { run: false, reason: "agent PR closed without merge" };
        }
        return { run: true, reason: `agent PR ${action ?? "event"}` };
      }
      return { run: false, reason: "non-agent pull request" };
    }

    case "workflow_run": {
      const run = recordField(payload, "workflow_run");
      const headBranch = run ? stringField(run, "head_branch") : undefined;
      if (headBranch?.startsWith(agentPrefix)) {
        const conclusion = run ? stringField(run, "conclusion") : undefined;
        return {
          run: true,
          reason: `agent CI ${conclusion ?? "completed"}`,
        };
      }
      return { run: false, reason: "non-agent workflow_run" };
    }

    default:
      return { run: false, reason: `unhandled event: ${eventName}` };
  }
}

function stringField(
  source: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = source[key];
  return typeof v === "string" ? v : undefined;
}

function recordField(
  source: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  const v = source[key];
  return v && typeof v === "object"
    ? (v as Record<string, unknown>)
    : undefined;
}

function issueLabels(payload: Readonly<Record<string, unknown>>): string[] {
  const issue = recordField(payload, "issue");
  if (!issue) return [];
  const labels = issue.labels;
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === "string") {
      out.push(l);
    } else if (l && typeof l === "object") {
      const name = (l as Record<string, unknown>).name;
      if (typeof name === "string") out.push(name);
    }
  }
  return out;
}

function prHeadRef(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  const pr = recordField(payload, "pull_request");
  if (!pr) return undefined;
  const head = recordField(pr, "head");
  if (!head) return undefined;
  return stringField(head, "ref");
}

function prMerged(
  payload: Readonly<Record<string, unknown>>,
): boolean | undefined {
  const pr = recordField(payload, "pull_request");
  if (!pr) return undefined;
  const v = pr.merged;
  return typeof v === "boolean" ? v : undefined;
}
