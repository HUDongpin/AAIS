import { describe, expect, it, vi } from "vitest";
import { inventoryAaisLegacyStatements } from "../scripts/archive-aais-legacy-lrs.mjs";

const config = {
  endpoint: "https://legacy-lrs.example.test/xapi",
  username: "read-only-user",
  password: "legacy-secret",
};

describe("AAIS legacy LRS archive inventory", () => {
  it("inventories only AAIS statements across pages without retaining raw content", async () => {
    const fetchMock = vi.fn(async (request) => {
      const url = new URL(request);
      if (url.pathname === "/xapi/more/2") {
        return Response.json({
          statements: [
            createStatement("00000000-0000-4000-8000-000000000828", "https://www.aais.site/xapi/activities/task-828", "second private prompt"),
          ],
          more: "",
        });
      }
      return Response.json({
        statements: [
          ...Array.from({ length: 827 }, (_, index) => {
            const number = String(index + 1).padStart(12, "0");
            return createStatement(
              `00000000-0000-4000-8000-${number}`,
              `https://www.aais.site/xapi/activities/task-${index + 1}`,
              "first private prompt",
            );
          }),
          createStatement("10000000-0000-4000-8000-000000000001", "https://www.mais.ac/xapi/activities/task-1", "mais private prompt"),
        ],
        more: "/xapi/more/2",
      });
    });

    const manifest = await inventoryAaisLegacyStatements({
      config,
      fetchImpl: fetchMock,
      expectedStatementCount: 828,
    });

    expect(manifest).toMatchObject({
      status: "pass",
      classification: "legacy-mixed-aais-mais-pool",
      projectId: "aais",
      namespacePrefix: "https://www.aais.site/xapi/",
      expectedStatementCount: 828,
      statementCount: 828,
      poolAaisStatementCount: 828,
      postCutoffStatementCount: 0,
      storedThrough: null,
      totalStatementsScanned: 829,
      rawStatementContent: "omitted",
      credentials: "omitted",
      secrets: "redacted",
    });
    expect(manifest.statementIds).toHaveLength(828);
    expect(manifest.statementIds[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(manifest.statementIds.at(-1)).toBe("00000000-0000-4000-8000-000000000828");
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("legacy-secret");
  });

  it("fails closed when an AAIS statement also contains a MAIS namespace", async () => {
    const statement = createStatement(
      "00000000-0000-4000-8000-000000000003",
      "https://www.aais.site/xapi/activities/task-3",
      "private prompt",
    );
    statement.context = {
      contextActivities: {
        grouping: [{ id: "https://www.mais.ac/xapi/courses/mixed" }],
      },
    };
    const fetchMock = vi.fn(async () => Response.json({ statements: [statement], more: "" }));

    await expect(inventoryAaisLegacyStatements({
      config,
      fetchImpl: fetchMock,
      expectedStatementCount: 828,
    })).rejects.toThrow("both AAIS and MAIS namespace");
  });

  it("rejects attempts to change the locked 828-statement archive count", async () => {
    await expect(inventoryAaisLegacyStatements({
      config,
      fetchImpl: vi.fn(),
      expectedStatementCount: 827,
    })).rejects.toThrow("locked to 828");
  });

  it("reports an exact-count mismatch instead of treating it as an archive receipt", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      statements: [
        createStatement("00000000-0000-4000-8000-000000000004", "https://www.aais.site/xapi/activities/task-4", "private prompt"),
      ],
      more: "",
    }));

    const manifest = await inventoryAaisLegacyStatements({
      config,
      fetchImpl: fetchMock,
      expectedStatementCount: 828,
    });

    expect(manifest).toMatchObject({
      status: "count_mismatch",
      statementCount: 1,
      expectedStatementCount: 828,
    });
  });

  it("freezes the owner-authorized 828 rows by inclusive provider stored time", async () => {
    const cutoff = "2026-07-30T08:46:08.407Z";
    const historical = Array.from({ length: 828 }, (_, index) => {
      const number = String(index + 1).padStart(12, "0");
      return createStatement(
        `00000000-0000-4000-8000-${number}`,
        `https://www.aais.site/xapi/activities/task-${index + 1}`,
        "historical private prompt",
        index === 827 ? cutoff : "2026-07-30T08:00:00.000Z",
      );
    });
    const later = Array.from({ length: 61 }, (_, index) => {
      const number = String(index + 829).padStart(12, "0");
      return createStatement(
        `00000000-0000-4000-8000-${number}`,
        `https://www.aais.site/xapi/activities/task-${index + 829}`,
        "later private prompt",
        "2026-07-30T09:48:47.068Z",
      );
    });
    const fetchMock = vi.fn(async () => Response.json({
      statements: [...historical, ...later],
      more: "",
    }));

    const manifest = await inventoryAaisLegacyStatements({
      config,
      fetchImpl: fetchMock,
      expectedStatementCount: 828,
      storedThrough: cutoff,
    });

    expect(manifest).toMatchObject({
      status: "pass",
      statementCount: 828,
      poolAaisStatementCount: 889,
      postCutoffStatementCount: 61,
      storedThrough: cutoff,
      providerStoredRange: {
        last: cutoff,
      },
    });
    expect(manifest.postCutoffSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("private prompt");
  });

  it("fails closed when a frozen provider-stored cutoff sees a row without stored", async () => {
    const statement = createStatement(
      "00000000-0000-4000-8000-000000000001",
      "https://www.aais.site/xapi/activities/task-1",
      "private prompt",
    );
    delete statement.stored;

    await expect(inventoryAaisLegacyStatements({
      config,
      fetchImpl: vi.fn(async () => Response.json({ statements: [statement], more: "" })),
      expectedStatementCount: 828,
      storedThrough: "2026-07-30T08:46:08.407Z",
    })).rejects.toThrow("missing provider stored time");
  });
});

function createStatement(
  id,
  objectId,
  prompt,
  stored = "2026-07-30T00:00:00.000Z",
) {
  return {
    id,
    actor: {
      objectType: "Agent",
      account: {
        homePage: "https://identity.example.test",
        name: "pseudonym",
      },
    },
    verb: {
      id: "http://adlnet.gov/expapi/verbs/experienced",
    },
    object: {
      id: objectId,
      objectType: "Activity",
    },
    context: {
      extensions: {
        "https://example.test/private-prompt": prompt,
      },
    },
    timestamp: "2026-07-30T00:00:00.000Z",
    stored,
  };
}
