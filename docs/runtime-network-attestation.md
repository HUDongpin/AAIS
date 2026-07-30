# AAIS Runtime And Network Attestation

These artifacts are provenance gates for the browser reconciliation. They do
not replace provider isolation, delivery, or signed physical-deletion
receipts. Evidence filenames are immutable: every writer uses exclusive
creation, fails if a target exists, sets the evidence directory to mode 0700,
and sets each JSON file to mode 0600.

## Production runtime bundle

Run the attester from a clean repository root. It independently requires the
full expected Git SHA, runs `npm run build`, requires a fresh `.next/BUILD_ID`,
and verifies that Git HEAD and the worktree remain unchanged after the build
and hash.

```bash
node scripts/attest-aais-runtime-build.mjs \
  --output output/<run>/runtime-build-attestation.json \
  --project-id aais \
  --study-id <study-id> \
  --environment research \
  --lrs-namespace https://www.aais.site/xapi/studies/<study-id>/research/v1 \
  --expected-commit <full-git-head>
```

`runtime_bundle_sha256` is deterministic over a canonical manifest containing
the scope, full commit SHA, BUILD_ID, and every regular file or symbolic-link
entry in the production `.next` runtime. `.next/cache`, `.next/dev`,
`.next/diagnostics`, `.next/types`, `trace`, and `trace-build` are excluded
because they are caches, development output, diagnostics, types, or
non-runtime traces. The attestation records the algorithm, scope, and entry
count. It cannot be emitted from a dirty tree, a short/mismatched SHA, a stale
BUILD_ID, or a build that changes tracked source.

## External-LRS network window

Host packet capture is only a capability probe on machines where BPF/pktap
access may be denied:

```bash
node scripts/attest-aais-external-lrs-network.mjs \
  --probe \
  --blocked-output output/<run>/network-capability-blocked.json \
  --project-id aais \
  --study-id <study-id> \
  --environment research \
  --lrs-namespace https://www.aais.site/xapi/studies/<study-id>/research/v1 \
  --target-origin https://www.aais.site
```

An unavailable probe writes only a blocked artifact. It is not accepted by the
browser reconciler as a complete capture.

The preferred complete method runs the production Next app in a dedicated
Docker container/network with its Postgres services and local LRS counter.
Use a capture image already present locally and pinned by a registry digest
(`repository@sha256:<64 hex>`); the tool never pulls a mutable tag. The
sidecar shares only the app container's network namespace, receives
`NET_RAW`/`NET_ADMIN`, and runs:

```text
tcpdump -i any -Q out -n -q -l -s 96 --immediate-mode "tcp or udp"
```

Wrap the complete automated browser driver:

```bash
node scripts/attest-aais-external-lrs-network.mjs \
  --output output/<run>/external-lrs-attestation.json \
  --capture-output output/<run>/external-lrs-sanitized-capture.json \
  --blocked-output output/<run>/external-lrs-capture-blocked.json \
  --app-container <production-app-container> \
  --capture-image <capture-repository>@sha256:<digest> \
  --project-id aais \
  --study-id <study-id> \
  --environment research \
  --lrs-namespace https://www.aais.site/xapi/studies/<study-id>/research/v1 \
  --target-origin https://www.aais.site \
  --target-origin https://www.mais.ac \
  -- <browser-driver> <driver-arguments>
```

The bounded driver starts only after tcpdump reports readiness. Capture stops
only after the driver exits. The sidecar writes no pcap and never prints or
retains HTTP headers, credentials, cookies, request/response bodies, or learner
text. Packet-summary lines exist only in process memory while they are reduced
to counts. The retained sanitized JSON contains timestamps, method/scope,
digest-pinned capture image identity, hashed subject/origin/address sets, and
packet/statistics counts.

This Docker mode captures all outbound TCP and UDP from the app network
namespace, not only pre-resolved LRS addresses. Any public-destination packet,
any declared-target packet, a DNS address-set change, any tcpdump kernel drop,
any unparseable packet summary, missing statistics, or a nonzero browser-driver
exit produces only a blocked artifact. Because encrypted packet metadata
cannot establish an HTTP request count, the tool never converts a positive
packet count into a request count. It records
`observed_external_lrs_requests=0` only when the complete window has zero
public packets and zero declared-target packets.

Finally pass both valid v2 attestations to:

```bash
npm run study:reconcile-browser -- \
  <existing-reconciliation-arguments> \
  --application-mode production-build \
  --runtime-build-attestation output/<run>/runtime-build-attestation.json \
  --external-lrs-attestation output/<run>/external-lrs-attestation.json
```

The reconciler rejects legacy/extra-key attestation shapes, unsafe capture
paths, checksum drift, capture/attestation metadata drift, retained raw
capture, packet loss, parse gaps, positive public/target contact, mismatched
scope/commit, and a capture window that does not enclose the visits and
server-received events.
