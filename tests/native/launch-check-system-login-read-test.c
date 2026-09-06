// Read-only test adapter; never included in the shipped binary. It inspects
// only a supplied Owner shell and its two parents, never controls Terminal.
#define AAIS_SOURCE_DIGEST "test-adapter-not-a-shipped-collector"
#define main aais_collector_main_not_invoked
#include "../../native/launch-check/main.c"
#undef main
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc != 2 || getuid() == 0 || geteuid() != getuid()) return 64;
    char *end = NULL;
    long value = strtol(argv[1], &end, 10);
    if (!end || *end || value <= 1 || value > INT32_MAX) return 64;
    alarm(15);
    char *error = NULL;
    if (sandbox_init(kSBXProfileNoNetwork, SANDBOX_NAMED, &error) != 0) {
        sandbox_free_error(error); return 3;
    }
    sandbox_free_error(error);
    pid_t shell_pid = (pid_t)value;
    struct proc_bsdinfo shell = {0}, login = {0}, terminal = {0}, again = {0};
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0}, code[65] = {0};
    if (!process_info(shell_pid, &shell, false) || shell.pbi_uid != getuid() || shell.pbi_ruid != getuid()
        || !process_path(shell_pid, path, false) || aais_classify(path, false) != AAIS_SHELL
        || !signature(shell_pid, aais_requirement(AAIS_SHELL, path), code)) return 2;
    pid_t login_pid = (pid_t)shell.pbi_ppid;
    if (!process_path(login_pid, path, true) || aais_classify(path, false) != AAIS_LOGIN
        || !signature(login_pid, aais_requirement(AAIS_LOGIN, path), code)) return 2;
    bool direct = process_info(login_pid, &login, false);
    if (!process_info(login_pid, &login, true) || login.pbi_uid != 0 || login.pbi_ruid != getuid()) return 2;
    pid_t terminal_pid = (pid_t)login.pbi_ppid;
    if (!process_info(terminal_pid, &terminal, false) || terminal.pbi_uid != getuid() || terminal.pbi_ruid != getuid()
        || !process_path(terminal_pid, path, false) || aais_classify(path, false) != AAIS_TERMINAL
        || !signature(terminal_pid, aais_requirement(AAIS_TERMINAL, path), code)) return 2;
    if (!process_info(shell_pid, &again, false) || again.pbi_ppid != shell.pbi_ppid
        || again.pbi_start_tvsec != shell.pbi_start_tvsec || again.pbi_start_tvusec != shell.pbi_start_tvusec) return 2;
    if (!process_info(login_pid, &again, true) || again.pbi_ppid != login.pbi_ppid || again.pbi_uid != login.pbi_uid
        || again.pbi_ruid != login.pbi_ruid || again.pbi_start_tvsec != login.pbi_start_tvsec
        || again.pbi_start_tvusec != login.pbi_start_tvusec) return 2;
    printf("{\"status\":\"read-only-system-login-validated\",\"directMetadataAvailable\":%s,"
        "\"realUidMatchesOwner\":true,\"effectiveUidIsRoot\":true,\"appleSignaturesValid\":true,"
        "\"terminalParentValid\":true,\"authorizesLiveExecution\":false}\n", direct ? "true" : "false");
    return 0;
}
