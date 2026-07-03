import { createHash } from "node:crypto";

type AaisAuditEvent = {
  event: string;
  actorId?: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
};

const sensitiveKeyPattern = /(password|secret|token|credential|authorization)/i;
const actorIdRedaction = "sha256-16";

export function recordAaisAuditEvent(event: AaisAuditEvent) {
  const actorKey = pseudonymizeAuditActorId(event.actorId);
  console.info(JSON.stringify({
    type: "aais.audit",
    time: new Date().toISOString(),
    event: event.event,
    ...(actorKey
      ? {
          actorId: actorKey,
          actorIdRedaction,
        }
      : {}),
    outcome: event.outcome,
    metadata: redactMetadata(event.metadata ?? {}),
  }));
}

function pseudonymizeAuditActorId(actorId: string | undefined) {
  const normalized = actorId?.trim();
  if (!normalized) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(`aais.audit.actor:v1:${normalized}`)
    .digest("hex")
    .slice(0, 16);
  return `actor:${digest}`;
}

function redactMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key) ? "redacted" : value,
    ]),
  );
}
