// Separate test executable. Never linked into the collector. No sockets or I/O.
#include <sandbox.h>
#include <stdio.h>
#include <unistd.h>

// macOS private diagnostic ABI, weak-linked and confined to this test. The SDK
// exports the symbol but not its header. Missing/unknown behavior is a failure.
extern int sandbox_check(pid_t, const char *, int, ...) __attribute__((weak_import));

int main(void) {
    char *error = NULL;
    if (sandbox_init(kSBXProfileNoNetwork, SANDBOX_NAMED, &error) != 0) {
        sandbox_free_error(error); puts("NETWORK_POLICY_TEST_UNAVAILABLE"); return 3;
    }
    sandbox_free_error(error);
    if (!sandbox_check) { puts("NETWORK_POLICY_QUERY_UNAVAILABLE"); return 3; }
    const char *operations[] = { "network-outbound", "network-inbound" };
    for (unsigned i=0; i<sizeof(operations)/sizeof(operations[0]); i++) {
        if (sandbox_check(getpid(), operations[i], 0) != 1) {
            puts("NETWORK_POLICY_NOT_DENIED_OR_UNKNOWN"); return 1;
        }
    }
    puts("AAIS_NETWORK_POLICY_DENIALS=2 (no sockets or connections attempted)");
    return 0;
}
