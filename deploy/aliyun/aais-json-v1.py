"""Strict, dependency-free JSON validation for the AAIS ECS wrappers."""

from __future__ import print_function

import datetime
import json
import os
import re
import stat
import sys


MAX_JSON_BYTES = 64 * 1024
ALLOWED_FILE_MODES = frozenset((0o600, 0o644))
IMAGE_REPOSITORY = "ghcr.io/hudongpin/aais"
SHA_RE = re.compile(r"^[a-f0-9]{40}$", re.ASCII)
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$", re.ASCII)
RUN_ID_RE = re.compile(r"^[0-9]{1,32}$", re.ASCII)
ATTESTATION_RE = re.compile(r"^[A-Za-z0-9._:-]{1,255}$", re.ASCII)
BUNDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$", re.ASCII)
LOWER_HEX_12_RE = re.compile(r"^[a-f0-9]{12}$", re.ASCII)
LOWER_HEX_64_RE = re.compile(r"^[a-f0-9]{64}$", re.ASCII)
TIMESTAMP_RE = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$",
    re.ASCII,
)

CANDIDATE_KEYS = frozenset((
    "schemaVersion",
    "provider",
    "stage",
    "gitSha",
    "imageRepository",
    "imageTag",
    "imageDigest",
    "githubRunId",
    "githubRunAttempt",
    "packageVisibility",
    "sbomGenerated",
    "provenanceGenerated",
    "provenanceAttestationId",
    "secrets",
))
PRELOADED_KEYS = frozenset((
    "schemaVersion",
    "provider",
    "stage",
    "gitSha",
    "imageRepository",
    "imageDigest",
    "localRepoDigest",
    "imageRevision",
    "candidateRunId",
    "candidateRunAttempt",
    "pulledAt",
    "credentialsCleaned",
    "secrets",
))
LIVE_KEYS = frozenset(("status", "releaseId", "provider"))
TRAFFIC_KEYS = frozenset((
    "status",
    "releaseId",
    "provider",
    "deployment",
    "database",
    "schema",
))
PUBLIC_READY_KEYS = frozenset(("status",))
DEPLOYMENT_KEYS = frozenset((
    "schemaVersion",
    "provider",
    "imageSource",
    "gitSha",
    "imageDigest",
    "secretBundleVersion",
    "container",
    "containerId",
    "color",
    "port",
    "nginxUpstreamSha256",
    "nginxVhostSha256",
    "deployedAt",
    "secrets",
))


class ValidationError(Exception):
    pass


def fail():
    raise ValidationError()


def exact_string(value):
    if type(value) is not str:
        fail()
    return value


def matches(pattern, value):
    return pattern.fullmatch(exact_string(value)) is not None


def valid_sha(value):
    return matches(SHA_RE, value)


def valid_digest(value):
    return matches(DIGEST_RE, value)


def valid_run_id(value):
    return matches(RUN_ID_RE, value)


def valid_timestamp(value):
    timestamp = exact_string(value)
    if TIMESTAMP_RE.fullmatch(timestamp) is None:
        return False
    try:
        parsed = datetime.datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ") == timestamp


def reject_constant(_value):
    fail()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if type(key) is not str or key in result:
            fail()
        result[key] = value
    return result


def parse_json_bytes(payload):
    if not payload or len(payload) > MAX_JSON_BYTES:
        fail()
    try:
        text = payload.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail()
    if text.startswith("\ufeff"):
        fail()
    try:
        value = json.loads(
            text,
            object_pairs_hook=unique_object,
            parse_constant=reject_constant,
        )
    except (TypeError, ValueError, json.JSONDecodeError):
        fail()
    if type(value) is not dict:
        fail()
    return value


def read_stdin_json():
    payload = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
    return parse_json_bytes(payload)


def read_file_json(path):
    if not hasattr(os, "O_NOFOLLOW"):
        fail()
    try:
        before = os.lstat(path)
    except OSError:
        fail()
    expected_uid = os.geteuid()
    if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
            or before.st_uid != expected_uid
            or stat.S_IMODE(before.st_mode) not in ALLOWED_FILE_MODES
            or before.st_size < 1 or before.st_size > MAX_JSON_BYTES):
        fail()
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    descriptor = None
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or opened.st_uid != expected_uid
                or stat.S_IMODE(opened.st_mode) not in ALLOWED_FILE_MODES
                or opened.st_dev != before.st_dev or opened.st_ino != before.st_ino
                or opened.st_size != before.st_size
                or opened.st_size < 1 or opened.st_size > MAX_JSON_BYTES):
            fail()
        chunks = []
        remaining = MAX_JSON_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 8192))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        after = os.fstat(descriptor)
        if (not stat.S_ISREG(after.st_mode) or after.st_nlink != 1
                or after.st_uid != expected_uid
                or stat.S_IMODE(after.st_mode) not in ALLOWED_FILE_MODES
                or after.st_dev != opened.st_dev or after.st_ino != opened.st_ino
                or after.st_size != opened.st_size
                or len(payload) != opened.st_size):
            fail()
    except OSError:
        fail()
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    return parse_json_bytes(payload)


def require_keys(value, expected):
    if frozenset(value.keys()) != expected:
        fail()


def require_int_one(value):
    if type(value) is not int or value != 1:
        fail()


def require_bool(value, expected):
    if type(value) is not bool or value is not expected:
        fail()


def validate_sha_argument(value):
    if not valid_sha(value):
        fail()


def validate_digest_argument(value):
    if not valid_digest(value):
        fail()


def validate_run_argument(value):
    if not valid_run_id(value):
        fail()


def validate_candidate(value, release_sha, expected_digest):
    require_keys(value, CANDIDATE_KEYS)
    require_int_one(value["schemaVersion"])
    require_bool(value["sbomGenerated"], True)
    require_bool(value["provenanceGenerated"], True)
    digest = exact_string(value["imageDigest"])
    run_id = exact_string(value["githubRunId"])
    run_attempt = exact_string(value["githubRunAttempt"])
    if not (
        value["provider"] == "github"
        and value["stage"] == "ghcr_candidate"
        and value["gitSha"] == release_sha
        and value["imageRepository"] == IMAGE_REPOSITORY
        and value["imageTag"] == IMAGE_REPOSITORY + ":" + release_sha
        and valid_digest(digest)
        and (expected_digest == "-" or digest == expected_digest)
        and valid_run_id(run_id)
        and valid_run_id(run_attempt)
        and value["packageVisibility"] == "private"
        and matches(ATTESTATION_RE, value["provenanceAttestationId"])
        and value["secrets"] == "redacted"
    ):
        fail()
    return digest, run_id, run_attempt


def validate_preloaded(value, release_sha, digest, run_id, run_attempt):
    require_keys(value, PRELOADED_KEYS)
    require_int_one(value["schemaVersion"])
    require_bool(value["credentialsCleaned"], True)
    if not (
        value["provider"] == "github"
        and value["stage"] == "ghcr_preloaded"
        and value["gitSha"] == release_sha
        and value["imageRepository"] == IMAGE_REPOSITORY
        and value["imageDigest"] == digest
        and value["localRepoDigest"] == IMAGE_REPOSITORY + "@" + digest
        and value["imageRevision"] == release_sha
        and value["candidateRunId"] == run_id
        and value["candidateRunAttempt"] == run_attempt
        and valid_timestamp(value["pulledAt"])
        and value["secrets"] == "redacted"
    ):
        fail()


def validate_live(value, release_sha):
    require_keys(value, LIVE_KEYS)
    if not (
        value["status"] == "live"
        and value["releaseId"] == release_sha
        and value["provider"] == "aliyun"
    ):
        fail()


def validate_traffic_ready(value, release_sha):
    require_keys(value, TRAFFIC_KEYS)
    if not (
        value["status"] == "ready"
        and value["releaseId"] == release_sha
        and value["provider"] == "aliyun"
        and value["deployment"] == "valid"
        and value["database"] == "ok"
        and value["schema"] == "current"
    ):
        fail()


def validate_public_ready(value):
    require_keys(value, PUBLIC_READY_KEYS)
    if value["status"] != "ready":
        fail()


def deployment_identity(color, port_text):
    if color == "blue" and port_text == "3101":
        return "aais-blue", 3101
    if color == "green" and port_text == "3102":
        return "aais-green", 3102
    fail()


def validate_deployment_arguments(
        release_sha, digest, bundle, color, port_text, container_id,
        upstream_sha, vhost_sha, deployed_at):
    validate_sha_argument(release_sha)
    validate_digest_argument(digest)
    if not matches(BUNDLE_RE, bundle):
        fail()
    container, port = deployment_identity(exact_string(color), exact_string(port_text))
    if (not matches(LOWER_HEX_12_RE, container_id)
            or not matches(LOWER_HEX_64_RE, upstream_sha)
            or not matches(LOWER_HEX_64_RE, vhost_sha)
            or not valid_timestamp(deployed_at)):
        fail()
    return container, port


def validate_deployment(
        value, release_sha, digest, bundle, color, port_text, container_id,
        upstream_sha, vhost_sha, deployed_at):
    container, port = validate_deployment_arguments(
        release_sha, digest, bundle, color, port_text, container_id,
        upstream_sha, vhost_sha, deployed_at,
    )
    require_keys(value, DEPLOYMENT_KEYS)
    require_int_one(value["schemaVersion"])
    if type(value["port"]) is not int:
        fail()
    if not (
        value["provider"] == "aliyun"
        and value["imageSource"] == "ghcr-preloaded"
        and value["gitSha"] == release_sha
        and value["imageDigest"] == digest
        and value["secretBundleVersion"] == bundle
        and value["container"] == container
        and value["containerId"] == container_id
        and value["color"] == color
        and value["port"] == port
        and value["nginxUpstreamSha256"] == upstream_sha
        and value["nginxVhostSha256"] == vhost_sha
        and value["deployedAt"] == deployed_at
        and value["secrets"] == "redacted"
    ):
        fail()


def canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def self_test():
    if (sys.implementation.name != "cpython" or sys.version_info < (3, 6)
            or not sys.flags.isolated or not sys.flags.no_site
            or not sys.flags.ignore_environment
            or not sys.flags.dont_write_bytecode or not hasattr(os, "O_NOFOLLOW")
            or not hasattr(os, "geteuid")):
        fail()


def run(argv):
    if len(argv) == 2 and argv[1] == "self-test":
        self_test()
        return
    if len(argv) == 5 and argv[1] == "candidate-metadata":
        path, release_sha, expected_digest = argv[2:]
        validate_sha_argument(release_sha)
        if expected_digest != "-":
            validate_digest_argument(expected_digest)
        digest, run_id, run_attempt = validate_candidate(
            read_file_json(path), release_sha, expected_digest,
        )
        sys.stdout.write(digest + "\t" + run_id + "\t" + run_attempt + "\n")
        return
    if len(argv) == 7 and argv[1] == "validate-preloaded":
        path, release_sha, digest, run_id, run_attempt = argv[2:]
        validate_sha_argument(release_sha)
        validate_digest_argument(digest)
        validate_run_argument(run_id)
        validate_run_argument(run_attempt)
        validate_preloaded(
            read_file_json(path), release_sha, digest, run_id, run_attempt,
        )
        return
    if len(argv) == 7 and argv[1] == "write-preloaded":
        release_sha, digest, run_id, run_attempt, pulled_at = argv[2:]
        validate_sha_argument(release_sha)
        validate_digest_argument(digest)
        validate_run_argument(run_id)
        validate_run_argument(run_attempt)
        if not valid_timestamp(pulled_at):
            fail()
        value = {
            "schemaVersion": 1,
            "provider": "github",
            "stage": "ghcr_preloaded",
            "gitSha": release_sha,
            "imageRepository": IMAGE_REPOSITORY,
            "imageDigest": digest,
            "localRepoDigest": IMAGE_REPOSITORY + "@" + digest,
            "imageRevision": release_sha,
            "candidateRunId": run_id,
            "candidateRunAttempt": run_attempt,
            "pulledAt": pulled_at,
            "credentialsCleaned": True,
            "secrets": "redacted",
        }
        validate_preloaded(value, release_sha, digest, run_id, run_attempt)
        sys.stdout.write(canonical_json(value) + "\n")
        return
    if len(argv) == 3 and argv[1] == "validate-live":
        validate_sha_argument(argv[2])
        validate_live(read_stdin_json(), argv[2])
        return
    if len(argv) == 3 and argv[1] == "validate-traffic-ready":
        validate_sha_argument(argv[2])
        validate_traffic_ready(read_stdin_json(), argv[2])
        return
    if len(argv) == 2 and argv[1] == "validate-public-ready":
        validate_public_ready(read_stdin_json())
        return
    if len(argv) == 12 and argv[1] == "validate-deployment":
        (path, release_sha, digest, bundle, color, port_text, container_id,
         upstream_sha, vhost_sha, deployed_at) = argv[2:]
        validate_deployment(
            read_file_json(path), release_sha, digest, bundle, color, port_text,
            container_id, upstream_sha, vhost_sha, deployed_at,
        )
        return
    if len(argv) == 11 and argv[1] == "write-deployment":
        (release_sha, digest, bundle, color, port_text, container_id,
         upstream_sha, vhost_sha, deployed_at) = argv[2:]
        container, port = validate_deployment_arguments(
            release_sha, digest, bundle, color, port_text, container_id,
            upstream_sha, vhost_sha, deployed_at,
        )
        value = {
            "schemaVersion": 1,
            "provider": "aliyun",
            "imageSource": "ghcr-preloaded",
            "gitSha": release_sha,
            "imageDigest": digest,
            "secretBundleVersion": bundle,
            "container": container,
            "containerId": container_id,
            "color": color,
            "port": port,
            "nginxUpstreamSha256": upstream_sha,
            "nginxVhostSha256": vhost_sha,
            "deployedAt": deployed_at,
            "secrets": "redacted",
        }
        validate_deployment(
            value, release_sha, digest, bundle, color, port_text, container_id,
            upstream_sha, vhost_sha, deployed_at,
        )
        sys.stdout.write(canonical_json(value) + "\n")
        return
    fail()


def main():
    try:
        run(sys.argv)
    except BaseException:
        sys.stderr.write("AAIS JSON validation failed.\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
