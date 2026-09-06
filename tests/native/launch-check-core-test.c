#include "check.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned checks;
#define CHECK(expression) do { assert(expression); checks++; } while (0)
static AaisSnapshot fixture(void) {
    AaisSnapshot s = { .uid = 501, .euid = 501, .pid = 44, .pgid = 44, .complete = true,
        .stdin_tty = true, .stdout_tty = true, .same_tty = true, .foreground = true, .controlling_tty = true, .count = 4 };
    const AaisRole roles[] = { AAIS_COLLECTOR, AAIS_SHELL, AAIS_TERMINAL, AAIS_LAUNCHD };
    const uint32_t pids[] = {44, 33, 22, 1}, parents[] = {33, 22, 1, 0};
    for (size_t i = 0; i < 4; i++) {
        s.processes[i] = (AaisProcess){ .pid=pids[i], .ppid=parents[i], .uid=i==3?0:501, .ruid=i==3?0:501,
            .started_sec=100-i, .role=roles[i], .signature_valid=true };
        strcpy(s.processes[i].path_digest, "fixture-path-digest"); strcpy(s.processes[i].cdhash, "fixture-code-hash");
    }
    return s;
}

int main(void) {
    AaisSnapshot a = fixture(), b = a;
    CHECK(aais_evaluate(&a, &b) == 0);
    const char *forbidden[] = { "/Applications/Codex.app/Codex", "/Applications/ChatGPT.app/ChatGPT",
        "/Applications/Electron.app/Electron", "/Applications/Visual Studio Code.app/Code", "/Applications/Cursor.app/Cursor",
        "/opt/bin/node", "/opt/bin/npm", "/opt/bin/npx", "/opt/bin/tsx", "/opt/bin/deno", "/opt/bin/bun", "/usr/sbin/sshd",
        "/opt/bin/tmux", "/usr/bin/screen" };
    for (size_t i=0; i<sizeof(forbidden)/sizeof(forbidden[0]); i++) {
        CHECK(aais_classify(forbidden[i], false) == AAIS_FORBIDDEN);
        a = fixture(); a.processes[1].role = aais_classify(forbidden[i], false); b = a;
        CHECK(aais_evaluate(&a, &b) & AAIS_FORBIDDEN_ORIGIN);
    }
    CHECK(aais_classify("/tmp/Terminal.app/Contents/MacOS/Terminal", false) == AAIS_UNKNOWN);
    CHECK(aais_classify("/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", false) == AAIS_TERMINAL);
    CHECK(aais_classify("/bin/zsh", false) == AAIS_SHELL);
    CHECK(aais_classify("/tmp/zsh", false) == AAIS_UNKNOWN);
    CHECK(strstr(aais_requirement(AAIS_TERMINAL, ""), "anchor apple") != NULL);
    CHECK(aais_requirement(AAIS_UNKNOWN, "") == NULL);
    a = fixture(); a.uid = 0; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_ROOT);
    a = fixture(); a.euid = 502; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_ROOT);
    a = fixture(); a.stdin_tty = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_TTY);
    a = fixture(); a.stdout_tty = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_TTY);
    a = fixture(); a.same_tty = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_TTY);
    a = fixture(); a.foreground = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_TTY);
    a = fixture(); a.controlling_tty = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_TTY);
    a = fixture(); b = a; b.processes[1].started_usec++; CHECK(aais_evaluate(&a,&b) & AAIS_CHANGED);
    a = fixture(); b = a; b.processes[1].ppid++; CHECK(aais_evaluate(&a,&b) & AAIS_CHANGED);
    a = fixture(); b = a; b.foreground = false; CHECK(aais_evaluate(&a,&b) & AAIS_CHANGED);
    a = fixture(); a.complete = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_INCOMPLETE);
    a = fixture(); a.processes[1].uid = 0; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_UID);
    a = fixture(); a.processes[1].ruid = 502; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_UID);
    a = fixture(); a.processes[2].signature_valid = false; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_CODE);
    a = fixture(); a.processes[0].pid = 22; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_CHAIN);
    a = fixture(); a.processes[1].ppid = 1; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_CHAIN);
    a = fixture(); a.processes[1].started_sec = 200; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_CHAIN);
    a = fixture(); a.processes[3].pid = 7; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_CHAIN);
    a = fixture(); a.count = 0; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_INCOMPLETE);
    a = fixture(); a.count = AAIS_MAX_CHAIN + 1; b = a; CHECK(aais_evaluate(&a,&b) & AAIS_CHAIN);
    a = fixture(); a.count = 5; a.processes[4] = a.processes[3]; a.processes[3] = a.processes[2];
    a.processes[2] = a.processes[1]; a.processes[2].pid = 27; a.processes[2].role = AAIS_LOGIN;
    a.processes[1].ppid = 27; b = a; CHECK(aais_evaluate(&a,&b) == 0);
    puts("Native core fixtures only: no real Terminal or authorization.");
    printf("AAIS_NATIVE_CORE_CHECKS=%u\n", checks);
    return 0;
}
