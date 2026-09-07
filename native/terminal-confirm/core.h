#ifndef AAIS_TERMINAL_CONFIRM_H
#define AAIS_TERMINAL_CONFIRM_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    char project[16], operation[64], target[64], region[32], host_identity[96];
    char repository[64], release[41], digest[72];
} ConfirmOperation;
typedef enum { CONFIRM_WAITING, CONFIRM_ACCEPTED, CONFIRM_REJECTED } ConfirmState;
typedef struct {
    ConfirmOperation operation;
    char phrase[48];
    uint64_t started_ms, last_ms;
    ConfirmState state;
} ConfirmSession;
ConfirmOperation confirm_fixture(void);
bool confirm_valid_operation(const ConfirmOperation *operation);
bool confirm_begin(ConfirmSession *session, const ConfirmOperation *operation, const char *nonce, uint64_t now);
const char *confirm_finish(ConfirmSession *session, const ConfirmOperation *operation,
    const char *line, size_t length, uint64_t now, bool origin_ok);
const char *confirm_abort(ConfirmSession *session, const char *reason);
#endif
