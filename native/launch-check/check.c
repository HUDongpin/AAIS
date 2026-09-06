#include "check.h"
#include <ctype.h>
#include <string.h>

AaisRole aais_classify(const char *path, bool self) {
    if (self) return AAIS_COLLECTOR;
    if (!strcmp(path, "/bin/zsh") || !strcmp(path, "/bin/bash")) return AAIS_SHELL;
    if (!strcmp(path, "/usr/bin/login")) return AAIS_LOGIN;
    if (!strcmp(path, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")) return AAIS_TERMINAL;
    if (!strcmp(path, "/sbin/launchd")) return AAIS_LAUNCHD;
    char lower[4096];
    size_t length = strlen(path);
    if (length >= sizeof(lower)) return AAIS_UNKNOWN;
    for (size_t i = 0; i <= length; i++) lower[i] = (char)tolower((unsigned char)path[i]);
    const char *denied[] = { "codex", "chatgpt", "electron", "visual studio code", "vscode",
        "cursor", "node", "npm", "npx", "tsx", "deno", "bun", "sshd", "tmux", "screen" };
    for (size_t i = 0; i < sizeof(denied)/sizeof(denied[0]); i++)
        if (strstr(lower, denied[i])) return AAIS_FORBIDDEN;
    return AAIS_UNKNOWN;
}

const char *aais_role_name(AaisRole role) {
    switch (role) {
        case AAIS_COLLECTOR: return "collector";
        case AAIS_SHELL: return "system-shell";
        case AAIS_LOGIN: return "system-login";
        case AAIS_TERMINAL: return "system-terminal";
        case AAIS_LAUNCHD: return "system-launchd";
        case AAIS_FORBIDDEN: return "forbidden";
        default: return "unknown";
    }
}

const char *aais_requirement(AaisRole role, const char *path) {
    switch (role) {
        // An ad-hoc identity is diagnostic only, not a trusted Owner signature.
        case AAIS_COLLECTOR: return "identifier \"org.aais.launch-check\"";
        case AAIS_SHELL: return !strcmp(path, "/bin/zsh")
            ? "identifier \"com.apple.zsh\" and anchor apple"
            : "identifier \"com.apple.bash\" and anchor apple";
        case AAIS_LOGIN: return "identifier \"com.apple.login\" and anchor apple";
        case AAIS_TERMINAL: return "identifier \"com.apple.Terminal\" and anchor apple";
        case AAIS_LAUNCHD: return "identifier \"com.apple.xpc.launchd\" and anchor apple";
        default: return NULL;
    }
}

static bool same_process(const AaisProcess *a, const AaisProcess *b) {
    return a->pid == b->pid && a->ppid == b->ppid && a->uid == b->uid && a->ruid == b->ruid
        && a->pgid == b->pgid && a->tty_device == b->tty_device && a->tty_pgid == b->tty_pgid
        && a->started_sec == b->started_sec && a->started_usec == b->started_usec
        && a->role == b->role && a->signature_valid == b->signature_valid
        && !strcmp(a->path_digest, b->path_digest) && !strcmp(a->cdhash, b->cdhash);
}

static bool verified_login_transition(const AaisSnapshot *snapshot, size_t index) {
    if (snapshot->count != 5 || index != 2) return false;
    const AaisProcess *login = &snapshot->processes[2];
    const AaisProcess *shell = &snapshot->processes[1];
    const AaisProcess *terminal = &snapshot->processes[3];
    return login->role == AAIS_LOGIN && login->signature_valid && login->uid == 0
        && login->ruid == snapshot->uid
        && shell->role == AAIS_SHELL && shell->signature_valid
        && shell->uid == snapshot->uid && shell->ruid == snapshot->uid
        && terminal->role == AAIS_TERMINAL && terminal->signature_valid
        && terminal->uid == snapshot->uid && terminal->ruid == snapshot->uid
        && shell->ppid == login->pid && login->ppid == terminal->pid;
}

unsigned aais_evaluate(const AaisSnapshot *a, const AaisSnapshot *b) {
    unsigned issues = 0;
    if (!a->uid || a->uid != a->euid) issues |= AAIS_ROOT;
    if (!a->stdin_tty || !a->stdout_tty || !a->same_tty || !a->foreground || !a->controlling_tty) issues |= AAIS_TTY;
    if (!a->complete || !b->complete || a->count < 4 || a->count > AAIS_MAX_CHAIN) issues |= AAIS_INCOMPLETE;
    if (a->count != b->count || a->uid != b->uid || a->euid != b->euid || a->pid != b->pid || a->pgid != b->pgid
        || a->stdin_tty != b->stdin_tty || a->stdout_tty != b->stdout_tty || a->same_tty != b->same_tty
        || a->foreground != b->foreground || a->controlling_tty != b->controlling_tty) issues |= AAIS_CHANGED;
    if (a->count > AAIS_MAX_CHAIN || b->count > AAIS_MAX_CHAIN) return issues | AAIS_CHAIN;
    for (size_t i = 0; i < a->count; i++) {
        const AaisProcess *p = &a->processes[i];
        if (i >= b->count || !same_process(p, &b->processes[i])) issues |= AAIS_CHANGED;
        if (!p->pid || !p->started_sec || p->started_usec >= 1000000) issues |= AAIS_CHAIN;
        for (size_t j = 0; j < i; j++) if (a->processes[j].pid == p->pid) issues |= AAIS_CHAIN;
        if (p->role == AAIS_FORBIDDEN) issues |= AAIS_FORBIDDEN_ORIGIN;
        uint32_t expected_uid = p->role == AAIS_LAUNCHD ? 0 : a->uid;
        if ((p->uid != expected_uid || p->ruid != expected_uid)
            && !verified_login_transition(a, i)) issues |= AAIS_UID;
        if (!p->signature_valid || !p->cdhash[0] || !p->path_digest[0]) issues |= AAIS_CODE;
        if (i + 1 < a->count) {
            const AaisProcess *parent = &a->processes[i+1];
            if (p->ppid != parent->pid || p->started_sec < parent->started_sec
                || (p->started_sec == parent->started_sec && p->started_usec < parent->started_usec)) issues |= AAIS_CHAIN;
        } else if (p->role != AAIS_LAUNCHD || p->pid != 1 || p->ppid != 0) issues |= AAIS_CHAIN;
    }
    bool shape = (a->count == 4 || a->count == 5) && a->processes[0].role == AAIS_COLLECTOR
        && a->processes[0].pid == a->pid && a->processes[1].role == AAIS_SHELL
        && a->processes[a->count-2].role == AAIS_TERMINAL
        && a->processes[a->count-1].role == AAIS_LAUNCHD;
    if (a->count == 5 && a->processes[2].role != AAIS_LOGIN) shape = false;
    if (!shape) issues |= AAIS_CHAIN;
    return issues;
}
