#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const aaisNamespacePrefix = "https://www.aais.site/xapi/";
const maisNamespacePrefixes = [
  "https://www.mais.ac/xapi/",
  "https://mais-mvp.local/",
  "https://www.mais.hk/",
];
const defaultExpectedStatementCount = 828;
const xapiVersion = "1.0.3";

export async function inventoryAaisLegacyStatements(input) {
  const expectedStatementCount = normalizeExpectedCount(input.expectedStatementCount);
  const pageLimit = normalizePageLimit(input.pageLimit);
  const storedThrough = normalizeOptionalStoredThrough(input.storedThrough);
  const statementsUrl = getStatementsUrl(input.config.endpoint);
  const headers = createLrsHeaders(input.config);
  const fetchImpl = input.fetchImpl ?? fetch;
  const aaisStatements = [];
  let totalStatementsScanned = 0;
  let nextUrl = new URL(statementsUrl);
  nextUrl.searchParams.set("limit", String(pageLimit));
  const visitedPages = new Set();

  while (nextUrl) {
    const pageKey = nextUrl.toString();
    if (visitedPages.has(pageKey)) {
      throw new Error("AAIS legacy LRS pagination loop detected.");
    }
    visitedPages.add(pageKey);
    if (visitedPages.size > 10_000) {
      throw new Error("AAIS legacy LRS pagination exceeded the safety limit.");
    }

    const response = await fetchImpl(nextUrl, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      throw new Error(`AAIS legacy LRS inventory failed with HTTP ${response.status}.`);
    }
    const body = await response.json();
    const pageStatements = Array.isArray(body?.statements) ? body.statements : [];
    totalStatementsScanned += pageStatements.length;
    for (const statement of pageStatements) {
      const namespace = classifyStatementNamespace(statement);
      if (!namespace.aais) {
        continue;
      }
      if (namespace.mais) {
        throw new Error("AAIS legacy statement contains both AAIS and MAIS namespace references.");
      }
      aaisStatements.push(createArchiveEntry(statement));
    }
    nextUrl = resolveMoreUrl(body?.more, nextUrl, statementsUrl);
  }

  const duplicateIds = findDuplicateIds(aaisStatements.map((entry) => entry.statementId));
  if (duplicateIds.length) {
    throw new Error("AAIS legacy LRS inventory contains duplicate statement ids.");
  }
  const selectedEntries = storedThrough
    ? aaisStatements.filter((entry) => {
        if (!entry.stored) {
          throw new Error(
            "AAIS legacy statement is missing provider stored time required by the frozen cutoff.",
          );
        }
        return entry.stored <= storedThrough;
      })
    : aaisStatements;
  const postCutoffEntries = storedThrough
    ? aaisStatements.filter((entry) => entry.stored > storedThrough)
    : [];
  const sortedEntries = [...selectedEntries].sort((left, right) =>
    left.statementId.localeCompare(right.statementId));
  const statementCount = sortedEntries.length;
  const status = statementCount === expectedStatementCount ? "pass" : "count_mismatch";
  const manifestSha256 = createHash("sha256")
    .update(JSON.stringify(sortedEntries))
    .digest("hex");

  return {
    schemaVersion: 1,
    status,
    classification: "legacy-mixed-aais-mais-pool",
    projectId: "aais",
    namespacePrefix: aaisNamespacePrefix,
    expectedStatementCount,
    statementCount,
    poolAaisStatementCount: aaisStatements.length,
    postCutoffStatementCount: postCutoffEntries.length,
    storedThrough,
    totalStatementsScanned,
    statementIds: sortedEntries.map((entry) => entry.statementId),
    contentDigests: sortedEntries.map((entry) => ({
      statementId: entry.statementId,
      sha256: entry.sha256,
    })),
    timeRange: getTimeRange(sortedEntries),
    providerStoredRange: getStoredRange(sortedEntries),
    postCutoffSetSha256: storedThrough
      ? hashArchiveEntries(postCutoffEntries)
      : null,
    namespaceIntegrity: "no-cross-project-reference-detected",
    manifestSha256,
    rawStatementContent: "omitted",
    credentials: "omitted",
    secrets: "redacted",
  };
}

function classifyStatementNamespace(statement) {
  const iris = collectStatementIris(statement);
  return {
    aais: iris.some((iri) => iri.startsWith(aaisNamespacePrefix)),
    mais: iris.some((iri) => maisNamespacePrefixes.some((prefix) => iri.startsWith(prefix))),
  };
}

function collectStatementIris(statement) {
  if (!statement || typeof statement !== "object") {
    return [];
  }
  const contextActivities = statement.context?.contextActivities ?? {};
  const activityGroups = Object.values(contextActivities).flatMap((value) =>
    Array.isArray(value) ? value : []);
  return [
    statement.verb?.id,
    statement.object?.id,
    statement.object?.definition?.type,
    ...activityGroups.map((activity) => activity?.id),
    ...Object.keys(statement.context?.extensions ?? {}),
  ].filter((value) => typeof value === "string");
}

function createArchiveEntry(statement) {
  const statementId = typeof statement?.id === "string" ? statement.id.trim() : "";
  if (!statementId) {
    throw new Error("AAIS legacy statement is missing its statement id.");
  }
  const timestamp = normalizeTimestamp(statement.timestamp);
  const stored = normalizeTimestamp(statement.stored);
  return {
    statementId,
    timestamp,
    stored,
    sha256: createHash("sha256")
      .update(stableJson(statement))
      .digest("hex"),
  };
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function getTimeRange(entries) {
  const timestamps = entries
    .map((entry) => entry.timestamp)
    .filter(Boolean)
    .sort();
  return {
    first: timestamps[0] ?? null,
    last: timestamps.at(-1) ?? null,
  };
}

function getStoredRange(entries) {
  const timestamps = entries
    .map((entry) => entry.stored)
    .filter(Boolean)
    .sort();
  return {
    first: timestamps[0] ?? null,
    last: timestamps.at(-1) ?? null,
  };
}

function hashArchiveEntries(entries) {
  const normalized = [...entries]
    .sort((left, right) => left.statementId.localeCompare(right.statementId))
    .map((entry) => ({ statementId: entry.statementId, sha256: entry.sha256 }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function findDuplicateIds(ids) {
  const seen = new Set();
  const duplicates = new Set();
  ids.forEach((id) => {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  });
  return [...duplicates];
}

function resolveMoreUrl(more, currentUrl, statementsUrl) {
  if (typeof more !== "string" || !more.trim()) {
    return null;
  }
  const resolved = new URL(more, currentUrl);
  const allowedOrigin = new URL(statementsUrl).origin;
  if (resolved.origin !== allowedOrigin) {
    throw new Error("AAIS legacy LRS pagination attempted to leave the configured origin.");
  }
  return resolved;
}

function getStatementsUrl(endpoint) {
  const normalized = requireText(endpoint, "AAIS legacy LRS endpoint").replace(/\/+$/, "");
  const url = normalized.endsWith("/statements")
    ? new URL(normalized)
    : new URL(`${normalized}/statements`);
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error("AAIS legacy LRS endpoint must use HTTPS outside loopback testing.");
  }
  return url.toString();
}

function createLrsHeaders(config) {
  const username = requireText(config.username, "AAIS legacy LRS username");
  const password = requireText(config.password, "AAIS legacy LRS password");
  return {
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    accept: "application/json",
    "x-experience-api-version": xapiVersion,
  };
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function requireText(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeExpectedCount(value) {
  const parsed = Number(value ?? defaultExpectedStatementCount);
  if (parsed !== defaultExpectedStatementCount) {
    throw new Error("AAIS legacy expected statement count is locked to 828.");
  }
  return parsed;
}

function normalizePageLimit(value) {
  const parsed = Number(value ?? 100);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error("AAIS legacy LRS page limit must be between 1 and 1000.");
  }
  return parsed;
}

function normalizeOptionalStoredThrough(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const normalized = normalizeTimestamp(value);
  if (!normalized || normalized !== value) {
    throw new Error("AAIS legacy stored-through cutoff must be an exact ISO timestamp.");
  }
  return normalized;
}

function parseArgs(argv) {
  const options = {
    expectedStatementCount: defaultExpectedStatementCount,
    storedThrough: null,
    output: path.resolve("aais-legacy-lrs-archive-manifest.json"),
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--expected-count") {
      options.expectedStatementCount = normalizeExpectedCount(argv[++index]);
    } else if (arg === "--output") {
      options.output = path.resolve(requireText(argv[++index], "AAIS legacy archive output path"));
    } else if (arg === "--stored-through") {
      options.storedThrough = normalizeOptionalStoredThrough(argv[++index]);
    } else {
      throw new Error(`Unknown AAIS legacy archive argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write([
    "Usage: node scripts/archive-aais-legacy-lrs.mjs [--expected-count 828] [--stored-through <inclusive-provider-stored-ISO>] [--output manifest.json]",
    "",
    "Required environment (legacy mixed pool, read-only credentials):",
    "  AAIS_LEGACY_LRS_ENDPOINT",
    "  AAIS_LEGACY_LRS_USERNAME",
    "  AAIS_LEGACY_LRS_PASSWORD",
    "",
    "When the shared pool has later AAIS rows, --stored-through freezes the owner-authorized historical set by the provider stored time (inclusive).",
    "The receipt contains statement ids and SHA-256 digests only. Raw statement content and credentials are omitted.",
    "",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const manifest = await inventoryAaisLegacyStatements({
    config: {
      endpoint: process.env.AAIS_LEGACY_LRS_ENDPOINT,
      username: process.env.AAIS_LEGACY_LRS_USERNAME,
      password: process.env.AAIS_LEGACY_LRS_PASSWORD,
    },
    expectedStatementCount: options.expectedStatementCount,
    storedThrough: options.storedThrough,
  });
  await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    status: manifest.status,
    statementCount: manifest.statementCount,
    expectedStatementCount: manifest.expectedStatementCount,
    poolAaisStatementCount: manifest.poolAaisStatementCount,
    postCutoffStatementCount: manifest.postCutoffStatementCount,
    storedThrough: manifest.storedThrough,
    manifestSha256: manifest.manifestSha256,
    output: options.output,
    rawStatementContent: "omitted",
    secrets: "redacted",
  })}\n`);
  if (manifest.status !== "pass") {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "AAIS legacy LRS archive failed."}\n`);
    process.exitCode = 1;
  });
}
