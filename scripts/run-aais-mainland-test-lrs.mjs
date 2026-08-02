#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AAIS_MAINLAND_TEST_LRS_ABSENCE_SCHEMA =
  "https://www.aais.site/xapi/receipts/absence/v1";

const LOOPBACK_HOST = "127.0.0.1";
const XAPI_VERSION = "1.0.3";
const MAX_STATEMENT_BYTES = 1024 * 1024;
const modulePath = fileURLToPath(import.meta.url);

const storeDefinitions = Object.freeze([
  {
    envPrefix: "AAIS_PRODUCTION_LRS",
    routeId: "aais-production",
    projectId: "aais",
    environment: "production",
    expectedRetentionDays: 7,
    namespacePrefix: "https://www.aais.site/xapi/",
  },
  {
    envPrefix: "AAIS_STAGING_LRS",
    routeId: "aais-staging",
    projectId: "aais",
    environment: "staging",
    expectedRetentionDays: 7,
    namespacePrefix: "https://www.aais.site/xapi/",
  },
  {
    envPrefix: "AAIS_RESEARCH_LRS",
    routeId: "aais-research",
    projectId: "aais",
    environment: "research",
    expectedRetentionDays: 30,
    namespacePrefix: "https://www.aais.site/xapi/",
  },
  {
    envPrefix: "MAIS_LRS",
    routeId: "mais",
    projectId: "mais",
    environment: "test",
    expectedRetentionDays: 1,
    namespacePrefix: "https://www.mais.ac/xapi/",
  },
]);

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await runAaisMainlandTestLrs(options);
    process.stdout.write(`${JSON.stringify({
      status: result.report.status,
      scope: result.report.scope,
      store_count: result.report.store_count,
      output_sha256: result.outputSha256,
      output: options.output,
      provider_attested: false,
      external_provider_contacted: false,
      secrets: "not-retained",
    })}\n`);
  } catch (error) {
    const safeCodes = new Set([
      "EEXIST",
      "invalid_arguments",
      "missing_env_file",
      "missing_output",
      "output_directory_unsafe",
      "restricted_env_file_invalid",
      "restricted_env_file_unsafe",
      "rehearsal_failed",
    ]);
    const candidate = error?.code ?? error?.message;
    process.stderr.write(`${JSON.stringify({
      status: "blocked",
      code: safeCodes.has(candidate) ? candidate : "rehearsal_failed",
      secrets: "not-retained",
    })}\n`);
    process.exitCode = 1;
  }
}

/**
 * Runs a real loopback HTTP round trip against four isolated in-memory stores.
 * It is deliberately not provider evidence and never accepts a remote endpoint.
 */
export async function runAaisMainlandTestLrs(input) {
  const outputPath = path.resolve(requireText(input?.output, "missing_output"));
  const env = input?.env ?? await readRestrictedEnvFile(input?.envFile);
  const configuration = readTestConfiguration(env);
  const now = input.now ?? (() => new Date());
  const generatedAt = exactIso(now());
  const keyPair = configuration.keyPair;
  const publicSpki = Buffer.from(
    keyPair.publicKey.export({ format: "der", type: "spki" }),
  );
  const stores = configuration.stores;
  const server = createLoopbackServer({
    stores,
    keyPair,
    keyId: configuration.keyId,
    now,
  });
  let address;

  try {
    address = await listenOnLoopback(server, configuration.port);
    const baseUrl = `http://${LOOPBACK_HOST}:${address.port}`;
    const credentials = stores.map((store) => store.credentials);

    const credentialMatrix = await checkCredentialMatrix({
      baseUrl,
      stores,
      credentials,
    });
    assert(
      credentialMatrix.authorized === stores.length
        && credentialMatrix.rejected === stores.length * (stores.length - 1),
      "credential_matrix_failed",
    );

    const baselineBefore = await readAllCounts({ baseUrl, stores });
    assert(baselineBefore.every((entry) => entry.count === 0), "baseline_not_zero");

    const storeRoundTrips = [];
    for (const store of stores) {
      storeRoundTrips.push(await exerciseStore({
        baseUrl,
        generatedAt,
        keyId: configuration.keyId,
        publicKey: keyPair.publicKey,
        store,
        stores,
      }));
    }
    const crossStoreStatuses = storeRoundTrips.flatMap(
      (entry) => entry.cross_store_absence_http_statuses,
    );
    assert(
      crossStoreStatuses.length === stores.length * (stores.length - 1)
        && crossStoreStatuses.every((status) => status === 404),
      "cross_store_statement_visible",
    );

    const baselineAfter = await readAllCounts({ baseUrl, stores });
    assert(baselineAfter.every((entry) => entry.count === 0), "final_baseline_not_zero");
    for (const store of stores) {
      store.statements.clear();
    }
    const inMemoryMapsCleared = stores.every((store) => store.statements.size === 0);
    assert(inMemoryMapsCleared, "in_memory_teardown_failed");
    await closeServer(server);
    const serverClosedBeforeEvidence = !server.listening;
    assert(serverClosedBeforeEvidence, "server_teardown_failed");

    const report = {
      evidence_schema_version: 1,
      artifact_type: "aais-mainland-local-test-lrs-rehearsal",
      status: "pass",
      generated_at: generatedAt,
      scope: "local-loopback-in-memory",
      study_id: configuration.studyId,
      configured_research_namespace_used: true,
      evidence_origin: "operator-run-internal-test",
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
        in_memory_maps_cleared_before_evidence: inMemoryMapsCleared,
        server_closed_before_evidence: serverClosedBeforeEvidence,
      },
      binding: {
        host: LOOPBACK_HOST,
        address_family: "IPv4",
        configured_loopback_port_used: true,
        port_value_retained: false,
        loopback_only_verified: address.address === LOOPBACK_HOST,
      },
      store_count: stores.length,
      stores: stores.map(({ definition, retentionDays }) => ({
        store_id: definition.storeId,
        project_id: definition.projectId,
        environment: definition.environment,
        retention_days: retentionDays,
        canonical_namespace_prefix: definition.namespacePrefix,
        statement_namespace: definition.statementNamespace,
        independent_route: true,
        independent_in_memory_statement_map: true,
        basic_auth_required: true,
      })),
      isolation: {
        independent_store_routes: true,
        independent_basic_credentials: true,
        credential_matrix_check_count: credentialMatrix.checked,
        authorized_credential_check_count: credentialMatrix.authorized,
        rejected_cross_credential_check_count: credentialMatrix.rejected,
        rejected_cross_credential_http_status: 401,
        cross_store_statement_absence_check_count: crossStoreStatuses.length,
        cross_store_statement_absence_http_statuses: crossStoreStatuses,
      },
      reconciliation: {
        baseline_before: {
          all_zero: true,
          stores: baselineBefore,
        },
        store_round_trips: storeRoundTrips,
        signer: {
          signer_classification: "internal-test-local-key",
          signature_algorithm: "Ed25519",
          signing_key_id: configuration.keyId,
          public_key_spki_sha256: sha256(publicSpki),
          private_key_source: "configured-restricted-env",
          provider_attested: false,
        },
        baseline_after: {
          all_zero: true,
          stores: baselineAfter,
        },
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
    };

    const serialized = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeRestrictedEvidence(outputPath, serialized);
    return {
      report,
      outputPath,
      outputSha256: sha256(serialized),
    };
  } finally {
    await closeServer(server);
    for (const store of stores) {
      store.statements.clear();
    }
  }
}

export function createCanonicalAbsenceEnvelope(input) {
  return Buffer.from(JSON.stringify({
    schema: AAIS_MAINLAND_TEST_LRS_ABSENCE_SCHEMA,
    store_id: input.storeId,
    statement_id: input.statementId,
    confirmed_at: input.confirmedAt,
    receipt_sha256: input.receiptSha256,
    key_id: input.keyId,
  }), "utf8");
}

async function readRestrictedEnvFile(candidatePath) {
  const envPath = path.resolve(requireText(candidatePath, "missing_env_file"));
  const directoryMetadata = await lstat(path.dirname(envPath));
  const metadata = await lstat(envPath);
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || (directoryMetadata.mode & 0o077) !== 0
    || !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || metadata.size < 1
    || metadata.size > 1024 * 1024
  ) {
    const error = new Error("restricted_env_file_unsafe");
    error.code = "restricted_env_file_unsafe";
    throw error;
  }
  return parseRestrictedEnv(await readFile(envPath, "utf8"));
}

function parseRestrictedEnv(source) {
  const env = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(env, match[1]) || /[\0\r\n]/.test(match[2])) {
      const error = new Error("restricted_env_file_invalid");
      error.code = "restricted_env_file_invalid";
      throw error;
    }
    env[match[1]] = match[2];
  }
  return env;
}

function readTestConfiguration(env) {
  assert(
    env?.AAIS_MAINLAND_TEST_PROFILE === "mainland-caa-is-test",
    "test_profile_invalid",
  );
  const studyId = requireConfiguredValue(env, "AAIS_RESEARCH_STUDY_ID");
  assert(
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(studyId),
    "study_id_invalid",
  );
  const configuredResearchNamespace = requireConfiguredValue(
    env,
    "AAIS_RESEARCH_LRS_NAMESPACE",
  );
  const expectedResearchNamespace =
    `https://www.aais.site/xapi/studies/${encodeURIComponent(studyId)}/research/v1`;
  assert(
    configuredResearchNamespace === expectedResearchNamespace,
    "research_namespace_invalid",
  );
  const stores = storeDefinitions.map((baseDefinition) => {
    const prefix = baseDefinition.envPrefix;
    const endpoint = requireConfiguredValue(env, `${prefix}_ENDPOINT`);
    const username = requireConfiguredValue(env, `${prefix}_USERNAME`);
    const password = requireConfiguredValue(env, `${prefix}_PASSWORD`);
    const storeId = requireConfiguredValue(env, `${prefix}_STORE_ID`);
    const retentionDays = Number(requireConfiguredValue(
      env,
      `${prefix}_RETENTION_DAYS`,
    ));
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      assert(false, "store_endpoint_invalid");
    }
    assert(
      parsed.protocol === "http:"
        && parsed.hostname === "localhost"
        && parsed.port !== ""
        && parsed.pathname === `/stores/${baseDefinition.routeId}/xapi`
        && parsed.username === ""
        && parsed.password === ""
        && parsed.search === ""
        && parsed.hash === "",
      "store_endpoint_invalid",
    );
    const port = Number(parsed.port);
    assert(
      Number.isSafeInteger(port) && port >= 1024 && port <= 65535,
      "store_port_invalid",
    );
    assert(
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(storeId),
      "store_id_invalid",
    );
    assert(
      /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(username)
        && password.length >= 32
        && password.length <= 512
        && !/[\s:]/.test(username)
        && !/\s/.test(password),
      "store_credentials_invalid",
    );
    assert(
      retentionDays === baseDefinition.expectedRetentionDays,
      "store_retention_invalid",
    );
    const statementNamespace = baseDefinition.projectId === "mais"
      ? `https://www.mais.ac/xapi/studies/${encodeURIComponent(studyId)}/test/v1`
      : `https://www.aais.site/xapi/studies/${encodeURIComponent(studyId)}/${baseDefinition.environment}/v1`;
    if (baseDefinition.environment === "research") {
      assert(
        statementNamespace === configuredResearchNamespace,
        "research_namespace_invalid",
      );
    }
    return {
      definition: {
        ...baseDefinition,
        statementNamespace,
        storeId,
      },
      credentials: { username, password },
      endpoint,
      port,
      retentionDays,
      statements: new Map(),
    };
  });

  assert(new Set(stores.map((store) => store.endpoint)).size === stores.length,
    "store_endpoints_not_distinct");
  assert(new Set(stores.map((store) => store.port)).size === 1,
    "store_ports_not_shared");
  assert(new Set(stores.map((store) => store.definition.storeId)).size === stores.length,
    "store_ids_not_distinct");
  assert(new Set(stores.flatMap((store) => [
    store.credentials.username,
    store.credentials.password,
  ])).size === stores.length * 2, "store_credentials_not_distinct");

  const keyId = requireConfiguredValue(
    env,
    "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_ID",
  );
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId), "key_id_invalid");
  const privateKeyBytes = decodeCanonicalBase64(requireConfiguredValue(
    env,
    "AAIS_MAINLAND_TEST_LRS_RECEIPT_SIGNING_KEY_PKCS8",
  ));
  const publicKeyBytes = decodeCanonicalBase64(requireConfiguredValue(
    env,
    "AAIS_RESEARCH_LRS_RECEIPT_VERIFYING_KEY_SPKI",
  ));
  let privateKey;
  let publicKey;
  try {
    privateKey = createPrivateKey({ key: privateKeyBytes, format: "der", type: "pkcs8" });
    publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    assert(false, "signing_key_invalid");
  }
  const canonicalPrivate = Buffer.from(
    privateKey.export({ format: "der", type: "pkcs8" }),
  );
  const canonicalPublic = Buffer.from(
    publicKey.export({ format: "der", type: "spki" }),
  );
  const derivedPublic = Buffer.from(
    createPublicKey(privateKey).export({ format: "der", type: "spki" }),
  );
  assert(
    privateKey.asymmetricKeyType === "ed25519"
      && publicKey.asymmetricKeyType === "ed25519"
      && canonicalPrivate.equals(privateKeyBytes)
      && canonicalPublic.equals(publicKeyBytes)
      && derivedPublic.equals(publicKeyBytes),
    "signing_key_pair_mismatch",
  );
  return {
    keyId,
    keyPair: { privateKey, publicKey },
    port: stores[0].port,
    studyId,
    stores,
  };
}

function requireConfiguredValue(env, name) {
  const value = env?.[name];
  assert(
    typeof value === "string"
      && value.length > 0
      && value.trim() === value,
    "required_test_configuration_missing",
  );
  return value;
}

function decodeCanonicalBase64(value) {
  assert(
    value.length <= 4096
      && value.length % 4 === 0
      && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    "signing_key_invalid",
  );
  const bytes = Buffer.from(value, "base64");
  assert(
    bytes.length > 0 && bytes.toString("base64") === value,
    "signing_key_invalid",
  );
  return bytes;
}

async function exerciseStore({
  baseUrl,
  generatedAt,
  keyId,
  publicKey,
  store,
  stores,
}) {
  const initialCount = await readStoreCount({ baseUrl, store });
  assert(initialCount === 0, "store_initial_baseline_not_zero");
  const statementId = randomUUID();
  const statementBody = createSyntheticStatementBody(
    statementId,
    generatedAt,
    store,
  );
  const statementObjectId = JSON.parse(statementBody.toString("utf8")).object?.id;
  assert(
    typeof statementObjectId === "string"
      && statementObjectId.startsWith(`${store.definition.statementNamespace}/`),
    "statement_namespace_invalid",
  );
  const statementBodySha256 = sha256(statementBody);
  const statementUrl = getStatementUrl(baseUrl, store, statementId);

  const putResponse = await loopbackFetch(statementUrl, store.credentials, {
    method: "PUT",
    body: statementBody,
  });
  await discardResponse(putResponse);
  assert(putResponse.status === 204, "put_failed");

  const getResponse = await loopbackFetch(statementUrl, store.credentials);
  const getBody = Buffer.from(await getResponse.arrayBuffer());
  const getBodySha256 = sha256(getBody);
  assert(
    getResponse.status === 200
      && getBody.equals(statementBody)
      && getBodySha256 === statementBodySha256,
    "get_hash_mismatch",
  );

  const crossStoreStatuses = [];
  for (const otherStore of stores.filter((candidate) => candidate !== store)) {
    const response = await loopbackFetch(
      getStatementUrl(baseUrl, otherStore, statementId),
      otherStore.credentials,
    );
    crossStoreStatuses.push(response.status);
    await discardResponse(response);
  }
  assert(
    crossStoreStatuses.length === stores.length - 1
      && crossStoreStatuses.every((status) => status === 404),
    "cross_store_statement_visible",
  );

  const deleteResponse = await loopbackFetch(
    statementUrl,
    store.credentials,
    { method: "DELETE" },
  );
  const deletionReceiptBody = Buffer.from(await deleteResponse.arrayBuffer());
  const deletionReceiptSha256 = sha256(deletionReceiptBody);
  const absenceVerification = verifyAbsenceHeaders({
    response: deleteResponse,
    receiptSha256: deletionReceiptSha256,
    statementId,
    storeId: store.definition.storeId,
    publicKey,
    expectedKeyId: keyId,
  });
  assert(
    deleteResponse.status === 200 && absenceVerification.verified,
    "signed_delete_receipt_invalid",
  );

  const afterDeleteResponse = await loopbackFetch(statementUrl, store.credentials);
  const afterDeleteStatus = afterDeleteResponse.status;
  await discardResponse(afterDeleteResponse);
  assert(afterDeleteStatus === 404, "deleted_statement_still_present");
  const finalCount = await readStoreCount({ baseUrl, store });
  assert(finalCount === 0, "store_final_baseline_not_zero");

  return {
    store_id: store.definition.storeId,
    retention_days: store.retentionDays,
    canonical_namespace_prefix: store.definition.namespacePrefix,
    statement_namespace: store.definition.statementNamespace,
    statement_namespace_prefix_verified: true,
    baseline_before_count: initialCount,
    put_http_status: putResponse.status,
    put_statement_body_sha256: statementBodySha256,
    get_http_status: getResponse.status,
    get_statement_body_sha256: getBodySha256,
    get_byte_exact_sha256_match: getBodySha256 === statementBodySha256,
    cross_store_absence_check_count: crossStoreStatuses.length,
    cross_store_absence_http_statuses: crossStoreStatuses,
    delete_http_status: deleteResponse.status,
    delete_receipt_body_sha256: deletionReceiptSha256,
    delete_absence_confirmation_verified: absenceVerification.verified,
    delete_canonical_envelope_schema: AAIS_MAINLAND_TEST_LRS_ABSENCE_SCHEMA,
    delete_response_header_names: [
      "x-aais-lrs-absence-confirmed-at",
      "x-aais-lrs-absence-receipt-sha256",
      "x-aais-lrs-absence-receipt-key-id",
      "x-aais-lrs-absence-receipt-signature",
    ],
    get_after_delete_http_status: afterDeleteStatus,
    final_count: finalCount,
    provider_attested: false,
  };
}

function createLoopbackServer({ stores, keyPair, keyId, now }) {
  const storesByRoute = new Map(
    stores.map((store) => [store.definition.routeId, store]),
  );
  return http.createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "close");
    handleRequest({
      request,
      response,
      storesByRoute,
      keyPair,
      keyId,
      now,
    }).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, { error: "internal_test_lrs_error" });
    });
  });
}

async function handleRequest({
  request,
  response,
  storesByRoute,
  keyPair,
  keyId,
  now,
}) {
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  const match = /^\/stores\/([a-z-]+)\/xapi\/(about|statements)$/.exec(url.pathname);
  const store = match ? storesByRoute.get(match[1]) : null;
  if (!store) {
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  if (!hasValidBasicCredentials(request, store.credentials)) {
    response.setHeader("www-authenticate", "Basic realm=\"aais-mainland-test-lrs\"");
    sendJson(response, 401, { error: "unauthorized" });
    return;
  }

  if (match[2] === "about") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    sendJson(response, 200, { version: [XAPI_VERSION] });
    return;
  }

  const statementId = url.searchParams.get("statementId");
  if (request.method === "PUT") {
    if (!statementId || !isUuid(statementId)) {
      sendJson(response, 400, { error: "statement_id_required" });
      return;
    }
    const body = await readBoundedBody(request);
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    if (
      !parsed
      || Array.isArray(parsed)
      || parsed.id !== statementId
      || typeof parsed.object?.id !== "string"
      || !parsed.object.id.startsWith(`${store.definition.statementNamespace}/`)
    ) {
      sendJson(response, 400, { error: "statement_id_mismatch" });
      return;
    }
    store.statements.set(statementId, body);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && statementId) {
    const body = store.statements.get(statementId);
    if (!body) {
      sendJson(response, 404, { error: "statement_not_found" });
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }

  if (request.method === "GET") {
    const statements = [...store.statements.values()].map((body) =>
      JSON.parse(body.toString("utf8")));
    sendJson(response, 200, { statements, more: "" });
    return;
  }

  if (request.method === "DELETE") {
    if (!statementId || !isUuid(statementId)) {
      sendJson(response, 400, { error: "statement_id_required" });
      return;
    }
    store.statements.delete(statementId);
    const confirmedAt = exactIso(now());
    const receiptBody = Buffer.from(`${JSON.stringify({
      schema: "aais-mainland-local-test-lrs-delete/v1",
      store_id: store.definition.storeId,
      absent: true,
      confirmed_at: confirmedAt,
      evidence_origin: "internal-test-lrs",
      provider_attested: false,
    })}\n`, "utf8");
    const receiptSha256 = sha256(receiptBody);
    const envelope = createCanonicalAbsenceEnvelope({
      storeId: store.definition.storeId,
      statementId,
      confirmedAt,
      receiptSha256,
      keyId,
    });
    const signature = sign(null, envelope, keyPair.privateKey).toString("base64url");
    response.writeHead(200, {
      "content-type": "application/json",
      "x-aais-lrs-absence-confirmed-at": confirmedAt,
      "x-aais-lrs-absence-receipt-sha256": receiptSha256,
      "x-aais-lrs-absence-receipt-key-id": keyId,
      "x-aais-lrs-absence-receipt-signature": signature,
    });
    response.end(receiptBody);
    return;
  }

  sendJson(response, 405, { error: "method_not_allowed" });
}

async function checkCredentialMatrix({ baseUrl, stores, credentials }) {
  let checked = 0;
  let authorized = 0;
  let rejected = 0;
  for (const target of stores) {
    for (const candidate of credentials) {
      const response = await loopbackFetch(
        `${getStoreBaseUrl(baseUrl, target)}/about`,
        candidate,
      );
      checked += 1;
      if (candidate === target.credentials && response.status === 200) {
        authorized += 1;
      } else if (candidate !== target.credentials && response.status === 401) {
        rejected += 1;
      }
      await discardResponse(response);
    }
  }
  return { checked, authorized, rejected };
}

async function readAllCounts({ baseUrl, stores }) {
  const counts = [];
  for (const store of stores) {
    counts.push({
      store_id: store.definition.storeId,
      count: await readStoreCount({ baseUrl, store }),
    });
  }
  return counts;
}

async function readStoreCount({ baseUrl, store }) {
  const response = await loopbackFetch(
    `${getStoreBaseUrl(baseUrl, store)}/statements`,
    store.credentials,
  );
  const payload = await response.json();
  assert(response.status === 200 && Array.isArray(payload.statements), "count_failed");
  return payload.statements.length;
}

function verifyAbsenceHeaders({
  response,
  receiptSha256,
  statementId,
  storeId,
  publicKey,
  expectedKeyId,
}) {
  const confirmedAt = response.headers.get("x-aais-lrs-absence-confirmed-at") ?? "";
  const claimedSha256 =
    response.headers.get("x-aais-lrs-absence-receipt-sha256") ?? "";
  const keyId = response.headers.get("x-aais-lrs-absence-receipt-key-id") ?? "";
  const encodedSignature =
    response.headers.get("x-aais-lrs-absence-receipt-signature") ?? "";
  if (
    !isExactIso(confirmedAt)
    || claimedSha256 !== receiptSha256
    || keyId !== expectedKeyId
    || !/^[A-Za-z0-9_-]{86}$/.test(encodedSignature)
  ) {
    return { verified: false };
  }
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== encodedSignature) {
    return { verified: false };
  }
  const envelope = createCanonicalAbsenceEnvelope({
    storeId,
    statementId,
    confirmedAt,
    receiptSha256,
    keyId,
  });
  return { verified: verify(null, envelope, publicKey, signature) };
}

async function listenOnLoopback(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(
    address
      && typeof address === "object"
      && address.address === LOOPBACK_HOST
      && address.family === "IPv4",
    "loopback_binding_failed",
  );
  return address;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function loopbackFetch(url, credentials, init = {}) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === "http:"
      && parsed.hostname === LOOPBACK_HOST
      && parsed.username === ""
      && parsed.password === "",
    "non_loopback_request_rejected",
  );
  return fetch(parsed, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: createBasicAuthorization(credentials),
      "content-type": "application/json",
      "x-experience-api-version": XAPI_VERSION,
      ...(init.headers ?? {}),
    },
  });
}

function hasValidBasicCredentials(request, credentials) {
  const actual = Buffer.from(request.headers.authorization ?? "", "utf8");
  const expected = Buffer.from(createBasicAuthorization(credentials), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createBasicAuthorization(credentials) {
  return `Basic ${Buffer.from(
    `${credentials.username}:${credentials.password}`,
    "utf8",
  ).toString("base64")}`;
}

function getStoreBaseUrl(baseUrl, store) {
  return `${baseUrl}/stores/${store.definition.routeId}/xapi`;
}

function getStatementUrl(baseUrl, store, statementId) {
  const url = new URL(`${getStoreBaseUrl(baseUrl, store)}/statements`);
  url.searchParams.set("statementId", statementId);
  return url.toString();
}

function createSyntheticStatementBody(statementId, timestamp, store) {
  const statementNamespace = store.definition.statementNamespace;
  const homePage = store.definition.projectId === "mais"
    ? "https://www.mais.ac"
    : "https://www.aais.site";
  return Buffer.from(`${JSON.stringify({
    id: statementId,
    actor: {
      objectType: "Agent",
      account: {
        homePage,
        name: "SYNTHETIC_ACTOR_NOT_RETAINED",
      },
    },
    verb: {
      id: "http://adlnet.gov/expapi/verbs/experienced",
      display: { "en-US": "experienced" },
    },
    object: {
      objectType: "Activity",
      id: `${statementNamespace}/activities/mainland-local-test/${store.definition.storeId}`,
    },
    context: {
      extensions: {
        [`${statementNamespace}/extensions/synthetic-raw-text`]:
          "SYNTHETIC_RAW_TEXT_NOT_RETAINED",
      },
    },
    timestamp,
  })}\n`, "utf8");
}

async function readBoundedBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_STATEMENT_BYTES) {
      const error = new Error("statement_too_large");
      error.code = "statement_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function writeRestrictedEvidence(outputPath, bytes) {
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    const error = new Error("output_directory_unsafe");
    error.code = "output_directory_unsafe";
    throw error;
  }
  await chmod(directory, 0o700);
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
}

async function discardResponse(response) {
  await response.arrayBuffer();
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error("invalid_arguments");
    }
    values.set(name, value);
  }
  if (values.size !== 2 || !values.has("--env-file") || !values.has("--output")) {
    throw new Error(argv.length === 0 ? "missing_output" : "invalid_arguments");
  }
  return {
    envFile: requireText(values.get("--env-file"), "invalid_arguments"),
    output: requireText(values.get("--output"), "missing_output"),
  };
}

function requireText(value, code) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(code);
  }
  return value;
}

function exactIso(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid_clock");
  }
  return value.toISOString();
}

function isExactIso(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition, code) {
  if (!condition) {
    const error = new Error("rehearsal_failed");
    error.code = code;
    throw error;
  }
}
