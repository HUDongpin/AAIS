import { describe, expect, it } from "vitest";
import {
  getPersistedAttachmentGuideMessages,
  readSafePersistedGuideDelivery,
} from "@/components/pages/learning/guide-message-persistence";
import type { AaisClientSession } from "@/components/pages/learning/learning-page-types";

describe("persisted guide delivery hydration", () => {
  it("restores only safe live-delivery fields for attachment history", () => {
    const messages = [{
      id: "persisted-user",
      kind: "user",
      text: "请概括附件",
      attachments: [{
        name: "notes.txt",
        mediaType: "text/plain",
        sizeBytes: 12,
        status: "read",
      }],
    }, {
      id: "persisted-assistant",
      kind: "assistant",
      text: "已概括。",
      orchestration: {
        graphId: "learning-ai-guide",
        topologicalOrder: ["A1"],
        delivery: {
          schemaVersion: 1,
          responseMode: "live",
          channel: "secondary",
          degraded: true,
          diagnosticId: "MUST-NOT-HYDRATE",
          budgetDisposition: "charged-once",
        },
      },
    }] as unknown as AaisClientSession["guideMessages"];

    const restored = getPersistedAttachmentGuideMessages(messages);

    expect(restored[1]?.runtime).toEqual({
      fallback: false,
      delivery: {
        schemaVersion: 1,
        responseMode: "live",
        channel: "secondary",
        degraded: true,
      },
    });
    expect(JSON.stringify(restored)).not.toContain("MUST-NOT-HYDRATE");
    expect(JSON.stringify(restored)).not.toContain("diagnosticId");
    expect(JSON.stringify(restored)).not.toContain("budgetDisposition");
  });

  it("rejects an inconsistent persisted delivery instead of trusting it", () => {
    expect(readSafePersistedGuideDelivery({
      schemaVersion: 1,
      responseMode: "live",
      channel: "primary",
      degraded: true,
    })).toBeUndefined();
  });
});
