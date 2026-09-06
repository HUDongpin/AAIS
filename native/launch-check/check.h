#ifndef AAIS_LAUNCH_CHECK_H
#define AAIS_LAUNCH_CHECK_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AAIS_MAX_CHAIN 32
typedef enum { AAIS_COLLECTOR, AAIS_SHELL, AAIS_LOGIN, AAIS_TERMINAL,
    AAIS_LAUNCHD, AAIS_FORBIDDEN, AAIS_UNKNOWN } AaisRole;
typedef struct {
    uint32_t pid, ppid, uid, ruid, pgid, tty_device, tty_pgid;
    uint64_t started_sec, started_usec;
    AaisRole role;
    bool signature_valid;
    char path_digest[65], cdhash[65];
} AaisProcess;
typedef struct {
    uint32_t uid, euid, pid, pgid;
    bool stdin_tty, stdout_tty, same_tty, foreground, controlling_tty;
    bool complete;
    unsigned failure_stage, failure_errno;
    uint32_t failure_pid;
    size_t count;
    AaisProcess processes[AAIS_MAX_CHAIN];
} AaisSnapshot;
enum {
    AAIS_ROOT = 1u << 0, AAIS_TTY = 1u << 1, AAIS_INCOMPLETE = 1u << 2,
    AAIS_CHANGED = 1u << 3, AAIS_CHAIN = 1u << 4, AAIS_UID = 1u << 5,
    AAIS_CODE = 1u << 6, AAIS_FORBIDDEN_ORIGIN = 1u << 7
};
AaisRole aais_classify(const char *path, bool self);
const char *aais_role_name(AaisRole role);
const char *aais_requirement(AaisRole role, const char *path);
unsigned aais_evaluate(const AaisSnapshot *first, const AaisSnapshot *second);
#endif
