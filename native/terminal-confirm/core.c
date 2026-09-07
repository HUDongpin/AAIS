#include "core.h"
#include <stdio.h>
#include <string.h>

ConfirmOperation confirm_fixture(void) {
    return (ConfirmOperation){ .project="AAIS", .operation="offline-operation-confirmation-only",
        .target="offline-fixture-only", .region="offline-no-region", .host_identity="offline-no-server-identity",
        .repository="ghcr.io/hudongpin/aais", .release="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .digest="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
}
static bool safe(const char *value, size_t capacity) {
    const char *end = memchr(value, 0, capacity);
    if (!end || end == value) return false;
    for (const char *p=value; p<end; p++) if (*p < 33 || *p > 126) return false;
    return true;
}
static bool same(const ConfirmOperation *a, const ConfirmOperation *b) {
    return !strcmp(a->project,b->project) && !strcmp(a->operation,b->operation)
        && !strcmp(a->target,b->target) && !strcmp(a->region,b->region)
        && !strcmp(a->host_identity,b->host_identity) && !strcmp(a->repository,b->repository)
        && !strcmp(a->release,b->release) && !strcmp(a->digest,b->digest);
}
bool confirm_valid_operation(const ConfirmOperation *op) {
    if (!op) return false;
    if (!safe(op->project,sizeof(op->project)) || !safe(op->operation,sizeof(op->operation))
        || !safe(op->target,sizeof(op->target)) || !safe(op->region,sizeof(op->region))
        || !safe(op->host_identity,sizeof(op->host_identity)) || !safe(op->repository,sizeof(op->repository))
        || !safe(op->release,sizeof(op->release)) || !safe(op->digest,sizeof(op->digest))) return false;
    // Only the offline fixture is permitted, not a configurable production plan.
    ConfirmOperation expected = confirm_fixture();
    return same(op, &expected);
}
bool confirm_begin(ConfirmSession *s, const ConfirmOperation *op, const char *nonce, uint64_t now) {
    memset(s, 0, sizeof(*s)); s->state = CONFIRM_REJECTED;
    if (!confirm_valid_operation(op) || !nonce || strlen(nonce)!=16) return false;
    for (size_t i=0;i<16;i++) if (!((nonce[i]>='0' && nonce[i]<='9') || (nonce[i]>='a' && nonce[i]<='f'))) return false;
    s->operation=*op; s->started_ms=now; s->last_ms=now;
    snprintf(s->phrase,sizeof(s->phrase),"CONFIRM AAIS %s",nonce);
    s->state=CONFIRM_WAITING;
    return true;
}
const char *confirm_abort(ConfirmSession *s, const char *reason) {
    s->state=CONFIRM_REJECTED;
    return reason;
}
const char *confirm_finish(ConfirmSession *s, const ConfirmOperation *op,
    const char *line, size_t length, uint64_t now, bool origin_ok) {
    if (s->state != CONFIRM_WAITING) return confirm_abort(s,"already-finished");
    if (!origin_ok) return confirm_abort(s,"origin-changed");
    if (!confirm_valid_operation(op) || !same(op,&s->operation)) return confirm_abort(s,"operation-changed");
    if (now < s->last_ms || now < s->started_ms || now-s->started_ms >= 60000) return confirm_abort(s,"expired");
    s->last_ms=now;
    if (!line || !length) return confirm_abort(s,"end-of-input");
    if (length>128) return confirm_abort(s,"input-too-long");
    if (length==7 && !memcmp(line,"CANCEL\n",7)) return confirm_abort(s,"cancelled");
    size_t expected=strlen(s->phrase);
    if (length != expected+1 || line[length-1]!='\n' || memcmp(line,s->phrase,expected))
        return confirm_abort(s,"confirmation-mismatch");
    s->state=CONFIRM_ACCEPTED;
    return "offline-operation-confirmed";
}
