type AaisAuditEvent = {
  event: string;
  actorId?: string;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
};

const sensitiveKeyPattern = /(password|secret|token|credential|authorization)/i;

export function recordAaisAuditEvent(event: AaisAuditEvent) {
  console.info(JSON.stringify({
    type: "aais.audit",
    time: new Date().toISOString(),
    event: event.event,
    actorId: event.actorId,
    outcome: event.outcome,
    metadata: redactMetadata(event.metadata ?? {}),
  }));
}

function redactMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key) ? "redacted" : value,
    ]),
  );
}
