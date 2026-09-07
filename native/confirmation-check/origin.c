// Reuse the reviewed collector unchanged, in-process, without invoking a child.
#include "../launch-check/check.h"
#include "origin.h"
static const char *demo_requirement(AaisRole role, const char *path) {
    return role == AAIS_COLLECTOR ? "identifier \"org.aais.confirmation-check\""
        : aais_requirement(role, path);
}
#define aais_requirement demo_requirement
#define main unused_launch_check_main
#include "../launch-check/main.c"
#undef main
#undef aais_requirement

static AaisSnapshot initial;
static bool started = false;

bool aais_confirmation_origin_begin(void) {
    struct rlimit zero = {0, 0};
    if (started || setrlimit(RLIMIT_CORE, &zero) != 0) return false;
    alarm(90);
    char *error = NULL;
    if (sandbox_init(kSBXProfileNoNetwork, SANDBOX_NAMED, &error) != 0) {
        sandbox_free_error(error); return false;
    }
    sandbox_free_error(error);
    AaisSnapshot before;
    collect(&before); collect(&initial);
    if (aais_evaluate(&before, &initial)) return false;
    started = true;
    return true;
}

bool aais_confirmation_origin_unchanged(void) {
    if (!started) return false;
    AaisSnapshot current;
    collect(&current);
    return aais_evaluate(&initial, &current) == 0;
}
