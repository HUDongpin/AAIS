// @vitest-environment node

import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAaisResearchLrsAbsenceReceiptEnvelope,
} from "../src/lib/server/aais-research-lrs.ts";
import {
  generateAaisMainlandTestProfile,
} from "../scripts/generate-aais-mainland-test-profile.mjs";
import {
  AAIS_MAINLAND_TEST_LRS_ABSENCE_SCHEMA,
  createCanonicalAbsenceEnvelope,
  runAaisMainlandTestLrs,
} from "../scripts/run-aais-mainland-test-lrs.mjs";

const tempRoots = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("AAIS mainland local four-store LRS rehearsal", () => {
  it("performs an isolated 0-PUT-GET-DELETE-0 round trip and writes redacted evidence", async () => {
    const root = await createTempRoot();
    const profileDirectory = path.join(root, "profile");
    await generateAaisMainlandTestProfile({
      outputDir: profileDirectory,
      participantCount: 3,
      studyId: "mainland-caa-is-test-four-store-integration",
      commitSha: "77ec56051af1eef41d2b64e70462d00c3d38c7c9",
      appVersion: "0.1.0",
      lrsPort: await reserveAvailablePort(),
      now: new Date("2026-08-01T03:59:00.000Z"),
    });
    const envFile = path.join(profileDirectory, "secrets.env");
    const env = parseEnv(await readFile(envFile, "utf8"));
    const output = path.join(profileDirectory, "mainland-test-lrs.json");
    const result = await runAaisMainlandTestLrs({
      envFile,
      output,
      now: () => new Date("2026-08-01T04:00:00.000Z"),
    });

    expect(result.report).toMatchObject({
      status: "pass",
      scope: "local-loopback-in-memory",
      study_id: env.AAIS_RESEARCH_STUDY_ID,
      configured_research_namespace_used: true,
      signer_classification: "internal-test-local-key",
      configured_credentials_used: true,
      provider_attested: false,
      external_provider_contacted: false,
      physical_provider_isolation_verified: false,
      formal_study_launch_evidence: false,
      lifecycle: {
        execution_model: "single-command-in-memory",
        configured_retention_days_are_maximum_ceilings: true,
        actual_data_lifetime_shorter_than_configured_ceilings: true,
        long_running_ttl_daemon_claimed: false,
        in_memory_maps_cleared_before_evidence: true,
        server_closed_before_evidence: true,
      },
      binding: {
        host: "127.0.0.1",
        address_family: "IPv4",
        configured_loopback_port_used: true,
        port_value_retained: false,
        loopback_only_verified: true,
      },
      store_count: 4,
      isolation: {
        independent_store_routes: true,
        independent_basic_credentials: true,
        credential_matrix_check_count: 16,
        authorized_credential_check_count: 4,
        rejected_cross_credential_check_count: 12,
        rejected_cross_credential_http_status: 401,
        cross_store_statement_absence_check_count: 12,
        cross_store_statement_absence_http_statuses: Array(12).fill(404),
      },
      reconciliation: {
        baseline_before: { all_zero: true },
        signer: {
          signer_classification: "internal-test-local-key",
          signature_algorithm: "Ed25519",
          private_key_source: "configured-restricted-env",
          provider_attested: false,
        },
        baseline_after: { all_zero: true },
      },
      redaction: {
        statement_bodies_retained: false,
        statement_ids_retained: false,
        credentials_retained: false,
        credential_values_retained: false,
        credential_derivatives_retained: false,
        actors_retained: false,
        raw_text_retained: false,
        private_signing_key_retained: false,
        public_signing_key_material_retained: false,
        response_header_values_retained: false,
        port_value_retained: false,
      },
    });

    expect(result.report.stores.map((store) => store.store_id)).toEqual([
      env.AAIS_PRODUCTION_LRS_STORE_ID,
      env.AAIS_STAGING_LRS_STORE_ID,
      env.AAIS_RESEARCH_LRS_STORE_ID,
      env.MAIS_LRS_STORE_ID,
    ]);
    expect(result.report.stores.map((store) => store.retention_days)).toEqual([
      7,
      7,
      30,
      1,
    ]);
    expect(result.report.stores.map((store) => store.canonical_namespace_prefix))
      .toEqual([
        "https://www.aais.site/xapi/",
        "https://www.aais.site/xapi/",
        "https://www.aais.site/xapi/",
        "https://www.mais.ac/xapi/",
      ]);
    const encodedStudyId = encodeURIComponent(env.AAIS_RESEARCH_STUDY_ID);
    const expectedStatementNamespaces = [
      `https://www.aais.site/xapi/studies/${encodedStudyId}/production/v1`,
      `https://www.aais.site/xapi/studies/${encodedStudyId}/staging/v1`,
      env.AAIS_RESEARCH_LRS_NAMESPACE,
      `https://www.mais.ac/xapi/studies/${encodedStudyId}/test/v1`,
    ];
    expect(result.report.stores.map((store) => store.statement_namespace))
      .toEqual(expectedStatementNamespaces);
    expect(result.report.stores[2].statement_namespace).toBe(
      env.AAIS_RESEARCH_LRS_NAMESPACE,
    );
    expect(result.report.reconciliation.baseline_before.stores.every(
      (entry) => entry.count === 0,
    )).toBe(true);
    expect(result.report.reconciliation.baseline_after.stores.every(
      (entry) => entry.count === 0,
    )).toBe(true);
    expect(result.report.reconciliation.store_round_trips).toHaveLength(4);
    for (const [index, roundTrip] of
      result.report.reconciliation.store_round_trips.entries()) {
      expect(roundTrip).toMatchObject({
        baseline_before_count: 0,
        canonical_namespace_prefix: index === 3
          ? "https://www.mais.ac/xapi/"
          : "https://www.aais.site/xapi/",
        statement_namespace: expectedStatementNamespaces[index],
        statement_namespace_prefix_verified: true,
        put_http_status: 204,
        get_http_status: 200,
        get_byte_exact_sha256_match: true,
        cross_store_absence_check_count: 3,
        cross_store_absence_http_statuses: [404, 404, 404],
        delete_http_status: 200,
        delete_absence_confirmation_verified: true,
        delete_canonical_envelope_schema: AAIS_MAINLAND_TEST_LRS_ABSENCE_SCHEMA,
        delete_response_header_names: [
          "x-aais-lrs-absence-confirmed-at",
          "x-aais-lrs-absence-receipt-sha256",
          "x-aais-lrs-absence-receipt-key-id",
          "x-aais-lrs-absence-receipt-signature",
        ],
        get_after_delete_http_status: 404,
        final_count: 0,
        provider_attested: false,
      });
      expect(roundTrip.put_statement_body_sha256).toBe(
        roundTrip.get_statement_body_sha256,
      );
    }
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);

    const serialized = await readFile(output, "utf8");
    expect(serialized).not.toContain("SYNTHETIC_ACTOR_NOT_RETAINED");
    expect(serialized).not.toContain("SYNTHETIC_RAW_TEXT_NOT_RETAINED");
    expect(serialized).not.toMatch(/authorization|password|username/i);
    expect(serialized).not.toMatch(/localhost:\d+|127\.0\.0\.1:\d+/);
    for (const name of [
      "AAIS_PRODUCTION_LRS_USERNAME",
      "AAIS_PRODUCTION_LRS_PASSWORD",
      "AAIS_STAGING_LRS_USERNAME",
      "AAIS_STAGING_LRS_PASSWORD",
      "AAIS_RESEARCH_LRS_USERNAME",
      "AAIS_RESEARCH_LRS_PASSWORD",
      "MAIS_LRS_USERNAME",
      "MAIS_LRS_PASSWORD",
      "AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8",
      "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI",
    ]) {
      expect(serialized).not.toContain(env[name]);
    }
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
    );
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(output))).mode & 0o777).toBe(0o700);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing evidence file", async () => {
    const root = await createTempRoot();
    const directory = path.join(root, "restricted");
    const output = path.join(directory, "existing.json");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(output, "retained\n", { mode: 0o600 });

    await expect(runAaisMainlandTestLrs({
      env: createTestEnv(await reserveAvailablePort()),
      output,
    })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(output, "utf8")).toBe("retained\n");
  });

  it("uses the exact canonical absence envelope property order", () => {
    const input = {
      storeId: "aais-research-mainland-test",
      statementId: "00000000-0000-4000-8000-000000000001",
      confirmedAt: "2026-08-01T04:00:00.000Z",
      receiptSha256: "a".repeat(64),
      keyId: "aais-mainland-local-test-ed25519-v1",
    };
    const envelope = createCanonicalAbsenceEnvelope(input);

    expect(envelope.toString("utf8")).toBe(
      `{\"schema\":\"${AAIS_MAINLAND_TEST_LRS_ABSENCE_SCHEMA}\",`
      + `\"store_id\":\"aais-research-mainland-test\",`
      + `\"statement_id\":\"00000000-0000-4000-8000-000000000001\",`
      + `\"confirmed_at\":\"2026-08-01T04:00:00.000Z\",`
      + `\"receipt_sha256\":\"${"a".repeat(64)}\",`
      + `\"key_id\":\"aais-mainland-local-test-ed25519-v1\"}`,
    );
    expect(envelope.equals(
      createAaisResearchLrsAbsenceReceiptEnvelope(input),
    )).toBe(true);
  });
});

async function createTempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aais-mainland-lrs-"));
  tempRoots.push(root);
  await chmod(root, 0o700);
  return root;
}

function createTestEnv(port) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const definitions = [
    ["AAIS_PRODUCTION_LRS", "aais-production", "aais-production-mainland-test", 7],
    ["AAIS_STAGING_LRS", "aais-staging", "aais-staging-mainland-test", 7],
    ["AAIS_RESEARCH_LRS", "aais-research", "aais-research-mainland-test", 30],
    ["MAIS_LRS", "mais", "mais-mainland-test", 1],
  ];
  const studyId = "mainland-caa-is-test-overwrite-fixture";
  const env = {
    AAIS_MAINLAND_TEST_PROFILE: "mainland-caa-is-test",
    AAIS_RESEARCH_STUDY_ID: studyId,
    AAIS_RESEARCH_LRS_NAMESPACE:
      `https://www.aais.site/xapi/studies/${encodeURIComponent(studyId)}/research/v1`,
  };
  for (const [prefix, route, storeId, retentionDays] of definitions) {
    env[`${prefix}_ENDPOINT`] = `http://localhost:${port}/stores/${route}/xapi`;
    env[`${prefix}_STORE_ID`] = storeId;
    env[`${prefix}_USERNAME`] = `test-user-${route}`;
    env[`${prefix}_PASSWORD`] = `test-password-${route}-${"x".repeat(32)}`;
    env[`${prefix}_RETENTION_DAYS`] = String(retentionDays);
  }
  env.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID =
    "aais-mainland-local-test-ed25519-v1";
  env.AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  env.AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8 = privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  return env;
}

function parseEnv(source) {
  return Object.fromEntries(source.split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

async function reserveAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address !== "object" || address.port < 1024) {
    throw new Error("test could not reserve an unprivileged loopback port");
  }
  return address.port;
}
