import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAaisXapiStatement,
  getLrsConfigurationStatus,
  isAaisLrsEndpointAllowed,
  probeAaisLrsConnection,
  sendAaisEventsToLrs,
} from "@/lib/server/aais-lrs-client";
import * as lrsClient from "@/lib/server/aais-lrs-client";
import { aaisEventDefinitions, type AaisEvent } from "@/data/aais";

const testConfig = {
  endpoint: "https://lrs.example.test/xapi",
  username: "test-user",
  password: "test-password",
};
const productPseudonymSecret = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index + 65),
).toString("base64url");

const scaffoldEvent: AaisEvent = {
  student_id: "Phoebe",
  session_id: "session-phoebe-2026",
  phase: "practice",
  task: "practice_task_1",
  agent: "A1",
  event: "scaffold_request",
  time: "2026-06-29T17:00:00.000Z",
  detail: {
    request_count: 1,
    tool_id: "stage-checklist",
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AAIS LRS xAPI client", () => {
  it("has an xAPI verb mapping for every defined AAIS event", () => {
    // Any event that reaches the LRS outbox must build a statement without
    // throwing; a missing verb mapping would permanently stall the persistent
    // outbox flush. Guard the whole class, not just one event.
    for (const [eventName, definition] of Object.entries(aaisEventDefinitions)) {
      const event: AaisEvent = {
        student_id: "S001",
        session_id: "session-coverage",
        phase: "practice",
        task: "practice_task_1",
        agent: definition.agent,
        event: eventName as AaisEvent["event"],
        time: "2026-07-10T00:00:00.000Z",
        detail: {},
      };
      expect(() => buildAaisXapiStatement(event), `event ${eventName} must map to an xAPI verb`).not.toThrow();
    }
  });

  it("builds analysis-ready xAPI statements from AAIS events", () => {
    const statement = buildAaisXapiStatement(scaffoldEvent);

    expect(statement.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statement.actor).toMatchObject({
      objectType: "Agent",
      name: expect.stringMatching(/^aais-learner-v2-[0-9a-f]{32}$/),
      account: {
        homePage: "https://www.aais.site",
        name: expect.stringMatching(/^aais-learner-v2-[0-9a-f]{32}$/),
      },
    });
    expect(JSON.stringify(statement.actor)).not.toContain("Phoebe");
    expect(statement.verb).toEqual({
      id: "https://www.aais.site/xapi/verbs/requested",
      display: {
        "en-US": "requested",
      },
    });
    expect(statement.object.id).toContain("/practice/practice_task_1/scaffold_request");
    expect(statement.context.extensions["https://www.aais.site/xapi/extensions/aais-detail"]).toEqual({
      request_count: 1,
      tool_id: "stage-checklist",
    });
    expect(statement.context.extensions).toMatchObject({
      "https://www.aais.site/xapi/extensions/aais-session-id": expect.stringMatching(/^session-v2-[a-f0-9]{32}$/),
      "https://www.aais.site/xapi/extensions/aais-event-family": "A1_GUIDE",
      "https://www.aais.site/xapi/extensions/aais-evidence-kind": "scaffold",
      "https://www.aais.site/xapi/extensions/aais-agent-role": "Front end, direct student dialogue",
      "https://www.aais.site/xapi/extensions/aais-agent-ca-modules": ["Scaffolding", "Fading"],
      "https://www.aais.site/xapi/extensions/aais-agent-phase-scope": "both",
      "https://www.aais.site/xapi/extensions/aais-role": "learner",
      "https://www.aais.site/xapi/extensions/aais-course-id": "cognitive-apprenticeship",
    });
    expect(JSON.stringify(statement.context.extensions)).not.toContain("session-phoebe-2026");
  });

  it("uses session-aware deterministic ids so LRS retries stay idempotent per session", () => {
    const first = buildAaisXapiStatement(scaffoldEvent);
    const retry = buildAaisXapiStatement({ ...scaffoldEvent });
    const nextSession = buildAaisXapiStatement({
      ...scaffoldEvent,
      session_id: "session-phoebe-2027",
    });

    expect(retry.id).toBe(first.id);
    expect(nextSession.id).not.toBe(first.id);
  });

  it("keeps product actor and session pseudonyms stable across session-secret rotation", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AAIS_PRODUCT_PSEUDONYM_SECRET", productPseudonymSecret);
    vi.stubEnv("AAIS_SESSION_SECRET", "first-session-secret-with-at-least-32-characters");
    const beforeRotation = buildAaisXapiStatement(scaffoldEvent);

    vi.stubEnv("AAIS_SESSION_SECRET", "second-session-secret-with-at-least-32-characters");
    const afterRotation = buildAaisXapiStatement(scaffoldEvent);

    expect(afterRotation.actor).toEqual(beforeRotation.actor);
    expect(afterRotation.context.extensions[
      "https://www.aais.site/xapi/extensions/aais-session-id"
    ]).toBe(beforeRotation.context.extensions[
      "https://www.aais.site/xapi/extensions/aais-session-id"
    ]);
    expect(JSON.stringify(afterRotation)).not.toContain(scaffoldEvent.student_id);
    expect(JSON.stringify(afterRotation)).not.toContain(scaffoldEvent.session_id);
  });

  it("does not reuse a statement id for distinct same-millisecond event details", () => {
    const first = buildAaisXapiStatement(scaffoldEvent);
    const distinctFact = buildAaisXapiStatement({
      ...scaffoldEvent,
      detail: {
        ...scaffoldEvent.detail,
        request_count: 2,
      },
    });

    expect(distinctFact.id).not.toBe(first.id);
    expect(buildAaisXapiStatement({ ...scaffoldEvent }).id).toBe(first.id);
  });

  it("redacts raw learner text from xAPI detail extensions", () => {
    const statement = buildAaisXapiStatement({
      ...scaffoldEvent,
      event: "ai_prompt_submitted",
      agent: "A2",
      detail: {
        prompt: "请直接给我完整答案",
        prompt_length: 10,
        accepted_ai_suggestion: true,
      },
    });

    expect(statement.context.extensions["https://www.aais.site/xapi/extensions/aais-detail"]).toEqual({
      prompt: "[redacted]",
      prompt_length: 10,
      accepted_ai_suggestion: true,
    });
    expect(statement.context.extensions).toMatchObject({
      "https://www.aais.site/xapi/extensions/aais-agent-family": "A2_EXPERT",
      "https://www.aais.site/xapi/extensions/aais-agent-ca-modules": ["Modelling", "Coaching"],
    });
    expect(JSON.stringify(statement)).not.toContain("请直接给我完整答案");
  });

  it("rejects events without a declared verb mapping", () => {
    expect(() =>
      buildAaisXapiStatement({
        ...scaffoldEvent,
        event: "unmapped_event",
      } as unknown as AaisEvent),
    ).toThrow("has no xAPI verb mapping");
  });

  it("posts statements to the configured LRS statements endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    const result = await sendAaisEventsToLrs([scaffoldEvent], {
      config: testConfig,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "sent",
      sent: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://lrs.example.test/xapi/statements",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-experience-api-version": "1.0.3",
        }),
      }),
    );
  });

  it("cancels unused provider response bodies after reading delivery status", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 200 });
    const fetchMock = vi.fn<typeof fetch>(async () => response);

    await expect(sendAaisEventsToLrs([scaffoldEvent], {
      config: testConfig,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "sent", sent: 1 });

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(true);
  });

  it("rejects unsafe product LRS endpoints before credentials or learner data leave the process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LRS_ENDPOINT", "http://lrs.example.test/xapi?tenant=secret");
    vi.stubEnv("LRS_USERNAME", "lrs-user");
    vi.stubEnv("LRS_PASSWORD", "lrs-password");
    const fetchMock = vi.fn<typeof fetch>();

    expect(getLrsConfigurationStatus()).toMatchObject({
      configured: false,
      configurationStatus: "invalid",
    });
    await expect(sendAaisEventsToLrs([scaffoldEvent], {
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toEqual({ status: "not_configured", sent: 0 });
    await expect(sendAaisEventsToLrs([scaffoldEvent], {
      config: {
        endpoint: "https://user:secret@attacker.example.test/xapi",
        username: "lrs-user",
        password: "lrs-password",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toEqual({ status: "not_configured", sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("permits HTTP only for loopback development endpoints", () => {
    expect(isAaisLrsEndpointAllowed("http://127.0.0.1:8080/xapi", {
      NODE_ENV: "development",
    })).toBe(true);
    expect(isAaisLrsEndpointAllowed("http://lrs.example.test/xapi", {
      NODE_ENV: "development",
    })).toBe(false);
    expect(isAaisLrsEndpointAllowed("http://127.0.0.1:8080/xapi", {
      NODE_ENV: "production",
    })).toBe(false);
    expect(isAaisLrsEndpointAllowed("https://lrs.example.test/xapi#secret")).toBe(false);
  });

  it("refuses the generic product LRS pipeline on a research deployment even with explicit credentials", async () => {
    vi.stubEnv("AAIS_RESEARCH_MODE", "true");
    vi.stubEnv("LRS_ENDPOINT", "https://legacy-mixed.example/xapi");
    vi.stubEnv("LRS_USERNAME", "legacy-user");
    vi.stubEnv("LRS_PASSWORD", "legacy-password");
    const fetchMock = vi.fn<typeof fetch>();

    await expect(sendAaisEventsToLrs([scaffoldEvent], {
      config: testConfig,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toEqual({
      status: "not_configured",
      sent: 0,
    });
    await expect(probeAaisLrsConnection({
      config: testConfig,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })).resolves.toEqual({
      status: "not_configured",
      configured: false,
    });
    expect(getLrsConfigurationStatus()).toMatchObject({
      configured: false,
      disabledByResearchIsolation: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a targeted statements query for health checks", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ statements: [] }));

    const result = await probeAaisLrsConnection({
      config: testConfig,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "connected",
      configured: true,
    });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(calledUrl.searchParams.get("activity")).toBe(
      "https://www.aais.site/xapi/courses/cognitive-apprenticeship",
    );
    expect(calledUrl.searchParams.get("related_activities")).toBe("true");
    expect(calledUrl.searchParams.get("limit")).toBe("1");
  });

  it("queues failed LRS batches for retry with redacted observable status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 204 });
    });
    const queue = lrsClient.createAaisLrsDeliveryQueue({
      config: testConfig,
      fetchImpl: fetchMock as unknown as typeof fetch,
      maxAttempts: 3,
      autoStart: false,
    });

    queue.enqueue([scaffoldEvent]);
    await queue.flush();
    expect(queue.getStatus()).toMatchObject({
      pendingBatches: 0,
      retryBatches: 1,
      deadLetterBatches: 0,
      secrets: "redacted",
    });

    await queue.flush();
    expect(queue.getStatus()).toMatchObject({
      pendingBatches: 0,
      retryBatches: 0,
      deadLetterBatches: 0,
      lastResult: {
        status: "sent",
        sent: 1,
        httpStatus: 204,
      },
      secrets: "redacted",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(queue.getStatus())).not.toContain("test-password");
  });
});
