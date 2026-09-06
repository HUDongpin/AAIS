#include "check.h"
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <libproc.h>
#include <sandbox.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <signal.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifndef AAIS_SOURCE_DIGEST
#error Build through scripts/build-aais-launch-check.sh
#endif

static void hex_bytes(const unsigned char *bytes, size_t count, char out[65]) {
    static const char digits[] = "0123456789abcdef";
    if (count > 32) { out[0] = 0; return; }
    for (size_t i = 0; i < count; i++) { out[2*i] = digits[bytes[i] >> 4]; out[2*i+1] = digits[bytes[i] & 15]; }
    out[2*count] = 0;
}

static bool signature(pid_t pid, const char *requirement_text, char cdhash[65]) {
    if (!requirement_text) return false;
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    if (!number) return false;
    const void *keys[] = { kSecGuestAttributePid }, *values[] = { number };
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFStringRef text = CFStringCreateWithCString(NULL, requirement_text, kCFStringEncodingUTF8);
    SecCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    CFDictionaryRef info = NULL;
    bool valid = attributes && text
        && SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) == errSecSuccess
        && SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) == errSecSuccess
        && SecCodeCheckValidity(code, kSecCSNoNetworkAccess, requirement) == errSecSuccess
        && SecCodeCopySigningInformation(code, kSecCSDefaultFlags, &info) == errSecSuccess;
    if (valid) {
        CFDataRef data = CFDictionaryGetValue(info, kSecCodeInfoUnique);
        valid = data && CFGetTypeID(data) == CFDataGetTypeID() && CFDataGetLength(data) > 0 && CFDataGetLength(data) <= 32;
        if (valid) hex_bytes(CFDataGetBytePtr(data), (size_t)CFDataGetLength(data), cdhash);
    }
    if (info) CFRelease(info);
    if (code) CFRelease(code);
    if (requirement) CFRelease(requirement);
    if (attributes) CFRelease(attributes);
    if (text) CFRelease(text);
    CFRelease(number);
    return valid;
}

static bool process_info(pid_t pid, struct proc_bsdinfo *info) {
    if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info)) return true;
    // macOS can restrict libproc's extended PID 1 record to root. Query only
    // its public kernel summary, never args/environment or a guessed root node.
    if (pid != 1) return false;
    int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, 1 };
    struct kinfo_proc record = {0};
    size_t length = sizeof(record);
    if (sysctl(mib, 4, &record, &length, NULL, 0) != 0 || length != sizeof(record)
        || record.kp_proc.p_pid != 1) return false;
    memset(info, 0, sizeof(*info));
    info->pbi_pid = (uint32_t)record.kp_proc.p_pid;
    info->pbi_ppid = (uint32_t)record.kp_eproc.e_ppid;
    info->pbi_uid = record.kp_eproc.e_ucred.cr_uid;
    info->pbi_ruid = record.kp_eproc.e_pcred.p_ruid;
    info->pbi_pgid = (uint32_t)record.kp_eproc.e_pgid;
    info->e_tdev = (uint32_t)record.kp_eproc.e_tdev;
    info->e_tpgid = (uint32_t)record.kp_eproc.e_tpgid;
    info->pbi_start_tvsec = (uint64_t)record.kp_proc.p_starttime.tv_sec;
    info->pbi_start_tvusec = (uint64_t)record.kp_proc.p_starttime.tv_usec;
    return true;
}

static bool process_path(pid_t pid, char path[PROC_PIDPATHINFO_MAXSIZE]) {
    if (proc_pidpath(pid, path, PROC_PIDPATHINFO_MAXSIZE) > 0) return true;
    if (pid != 1) return false;
    // Security resolves the actual running code; do not substitute /sbin/launchd.
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    if (!number) return false;
    const void *keys[] = { kSecGuestAttributePid }, *values[] = { number };
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    SecStaticCodeRef static_code = NULL;
    CFURLRef url = NULL;
    bool valid = attributes
        && SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) == errSecSuccess
        && SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code) == errSecSuccess
        && SecCodeCopyPath(static_code, kSecCSDefaultFlags, &url) == errSecSuccess
        && CFURLGetFileSystemRepresentation(url, true, (UInt8 *)path, PROC_PIDPATHINFO_MAXSIZE);
    if (url) CFRelease(url);
    if (static_code) CFRelease(static_code);
    if (code) CFRelease(code);
    if (attributes) CFRelease(attributes);
    CFRelease(number);
    return valid;
}

static void collect(AaisSnapshot *snapshot) {
    memset(snapshot, 0, sizeof(*snapshot));
    snapshot->uid = getuid(); snapshot->euid = geteuid(); snapshot->pid = (uint32_t)getpid(); snapshot->pgid = (uint32_t)getpgrp();
    snapshot->stdin_tty = isatty(STDIN_FILENO) == 1;
    snapshot->stdout_tty = isatty(STDOUT_FILENO) == 1;
    struct stat input = {0}, output = {0};
    bool descriptors = fstat(STDIN_FILENO, &input) == 0 && fstat(STDOUT_FILENO, &output) == 0;
    snapshot->same_tty = descriptors && snapshot->stdin_tty && snapshot->stdout_tty
        && S_ISCHR(input.st_mode) && S_ISCHR(output.st_mode) && input.st_rdev == output.st_rdev;
    snapshot->foreground = snapshot->same_tty && tcgetpgrp(STDIN_FILENO) == getpgrp()
        && tcgetpgrp(STDOUT_FILENO) == getpgrp();
    pid_t pid = getpid();
    for (size_t index = 0; index < AAIS_MAX_CHAIN; index++) {
        struct proc_bsdinfo before = {0}, after = {0};
        char path[PROC_PIDPATHINFO_MAXSIZE] = {0}, path_after[PROC_PIDPATHINFO_MAXSIZE] = {0};
        snapshot->failure_pid = (uint32_t)pid;
        errno = 0;
        if (!process_info(pid, &before)) {
            snapshot->failure_stage = 1; snapshot->failure_errno = (unsigned)errno; return;
        }
        if (!process_path(pid, path)) {
            snapshot->failure_stage = 2; snapshot->failure_errno = (unsigned)errno; return;
        }
        AaisProcess p = { .pid = before.pbi_pid, .ppid = before.pbi_ppid,
            .uid = before.pbi_uid, .ruid = before.pbi_ruid, .pgid = before.pbi_pgid,
            .tty_device = before.e_tdev, .tty_pgid = before.e_tpgid,
            .started_sec = before.pbi_start_tvsec, .started_usec = before.pbi_start_tvusec };
        p.role = aais_classify(path, index == 0);
        unsigned char digest[CC_SHA256_DIGEST_LENGTH];
        CC_SHA256(path, (CC_LONG)strlen(path), digest);
        hex_bytes(digest, sizeof(digest), p.path_digest);
        p.signature_valid = signature(pid, aais_requirement(p.role, path), p.cdhash);
        // Fence PID reuse, reparenting and exec changes around signature lookup.
        if (!process_info(pid, &after) || !process_path(pid, path_after)
            || strcmp(path, path_after) || before.pbi_pid != after.pbi_pid
            || before.pbi_ppid != after.pbi_ppid || before.pbi_uid != after.pbi_uid
            || before.pbi_ruid != after.pbi_ruid || before.pbi_start_tvsec != after.pbi_start_tvsec
            || before.pbi_start_tvusec != after.pbi_start_tvusec) {
            snapshot->failure_stage = 3; snapshot->failure_errno = (unsigned)errno; return;
        }
        for (size_t j = 0; j < index; j++) if (snapshot->processes[j].pid == p.pid) {
            snapshot->failure_stage = 4; return;
        }
        snapshot->processes[snapshot->count++] = p;
        if (index == 0) snapshot->controlling_tty = snapshot->same_tty
            && p.tty_device == (uint32_t)input.st_rdev && p.tty_pgid == snapshot->pgid;
        if (pid == 1) { snapshot->complete = p.ppid == 0; snapshot->failure_pid = 0; return; }
        if (!p.ppid || p.ppid == (uint32_t)pid) { snapshot->failure_stage = 4; return; }
        pid = (pid_t)p.ppid;
    }
    snapshot->failure_stage = 5;
}

static const char *boolean(bool value) { return value ? "true" : "false"; }

static void failure(const char *fixed_code) {
    printf("{\"schemaVersion\":1,\"mode\":\"non-sensitive-launch-check\",\"status\":\"unavailable\","
        "\"reason\":\"%s\",\"authorizesLiveExecution\":false,\"credentialsRead\":false}\n", fixed_code);
}

int main(int argc, char **argv) {
    // No values, paths, fixture files, network targets or policy overrides accepted.
    if (argc == 2 && !strcmp(argv[1], "--help")) {
        puts("AAIS non-sensitive launch-check: run without arguments. Reads no input; prints diagnostic JSON only. Never authorizes credentials or deployment.");
        return 0;
    }
    if (argc != 1) { failure("ARGUMENTS_NOT_ALLOWED"); return 64; }
    struct rlimit zero = {0, 0};
    if (setrlimit(RLIMIT_CORE, &zero) != 0) { failure("CORE_LIMIT_UNAVAILABLE"); return 3; }
    // Hard timeout, no retry. An interrupted/truncated report is not evidence.
    alarm(15);
    char *sandbox_error = NULL;
    if (sandbox_init(kSBXProfileNoNetwork, SANDBOX_NAMED, &sandbox_error) != 0) {
        sandbox_free_error(sandbox_error); failure("NETWORK_SANDBOX_UNAVAILABLE"); return 3;
    }
    sandbox_free_error(sandbox_error);
    AaisSnapshot first, second;
    collect(&first); collect(&second);
    unsigned issues = aais_evaluate(&first, &second);
    printf("{\"schemaVersion\":1,\"mode\":\"non-sensitive-launch-check\",\"status\":\"%s\","
        "\"sourceDigest\":\"%s\",\"authorizesLiveExecution\":false,\"humanIntentVerified\":false,"
        "\"keyAccessVerified\":false,\"credentialsRead\":false,\"networkSandbox\":\"no-network\","
        "\"uid\":%u,\"complete\":%s,\"stdinTty\":%s,\"stdoutTty\":%s,\"sameTty\":%s,"
        "\"foreground\":%s,\"controllingTty\":%s,\"snapshotsMatch\":%s,\"issues\":[",
        issues ? "denied" : "compatible-observation-only", AAIS_SOURCE_DIGEST, first.uid,
        boolean(first.complete && second.complete), boolean(first.stdin_tty), boolean(first.stdout_tty),
        boolean(first.same_tty), boolean(first.foreground), boolean(first.controlling_tty), boolean(!(issues & AAIS_CHANGED)));
    const char *codes[] = { "ROOT_OR_EFFECTIVE_UID", "TTY_NOT_LOCAL_FOREGROUND", "INCOMPLETE_CHAIN", "SNAPSHOT_CHANGED",
        "CHAIN_NOT_ALLOWLISTED", "UID_MISMATCH", "CODE_IDENTITY_UNVERIFIED", "FORBIDDEN_ANCESTOR" };
    bool comma = false;
    for (unsigned i = 0; i < sizeof(codes)/sizeof(codes[0]); i++) if (issues & (1u << i)) {
        printf("%s\"%s\"", comma ? "," : "", codes[i]); comma = true;
    }
    printf("],\"collectionFailure\":{\"firstStage\":%u,\"firstPid\":%u,\"firstErrno\":%u,"
        "\"secondStage\":%u,\"secondPid\":%u,\"secondErrno\":%u},\"chain\":[",
        first.failure_stage, first.failure_pid, first.failure_errno, second.failure_stage, second.failure_pid, second.failure_errno);
    for (size_t i = 0; i < first.count; i++) {
        const AaisProcess *p = &first.processes[i];
        printf("%s{\"pid\":%u,\"ppid\":%u,\"uid\":%u,\"realUid\":%u,\"startedSeconds\":%llu,"
            "\"startedMicroseconds\":%llu,\"role\":\"%s\",\"codeValid\":%s,\"pathDigest\":\"%s\",\"cdhash\":\"%s\"}",
            i ? "," : "", p->pid, p->ppid, p->uid, p->ruid, (unsigned long long)p->started_sec,
            (unsigned long long)p->started_usec, aais_role_name(p->role), boolean(p->signature_valid), p->path_digest, p->cdhash);
    }
    puts("]}");
    return issues ? 2 : 0;
}
