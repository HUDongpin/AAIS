// Standalone non-secret prototype. No signing, LAContext, credentials or network.
#include "core.h"
#include "../launch-check/check.h"
static const char *terminal_requirement(AaisRole role, const char *path) {
    return role == AAIS_COLLECTOR ? "identifier \"org.aais.terminal-confirm\"" : aais_requirement(role,path);
}
#define aais_requirement terminal_requirement
#define main unused_launch_check_main
#include "../launch-check/main.c"
#undef main
#undef aais_requirement
#include <poll.h>
#include <termios.h>
#include <time.h>
#include <sys/syslimits.h>

static volatile sig_atomic_t interrupted = 0;
static void stop(int signal_number) { interrupted = signal_number; }
static uint64_t monotonic_ms(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC,&time)) return UINT64_MAX;
    return (uint64_t)time.tv_sec*1000+(uint64_t)time.tv_nsec/1000000;
}
static bool tty_current(dev_t device) {
    struct stat input, output;
    struct termios mode;
    return isatty(0) && isatty(1) && fstat(0,&input)==0 && fstat(1,&output)==0
        && input.st_rdev==device && output.st_rdev==device && tcgetpgrp(0)==getpgrp() && tcgetpgrp(1)==getpgrp()
        && tcgetattr(0,&mode)==0 && (mode.c_lflag & (ICANON|ISIG|ECHO))==(ICANON|ISIG|ECHO);
}
static void result(const char *status, bool confirmed) {
    printf("\n{\"schemaVersion\":1,\"mode\":\"offline-terminal-confirmation\",\"status\":\"%s\","
        "\"operationConfirmed\":%s,\"authorizesLiveExecution\":false,\"hardwareIdentityVerified\":false,"
        "\"signingKeyProtectionVerified\":false,\"credentialsRead\":false,\"networkOperationPerformed\":false}\n",
        status, confirmed ? "true" : "false");
}
int main(int argc, char **argv) {
    (void)argv;
    if (argc!=1) { result("arguments-not-allowed",false); return 64; }
    struct rlimit zero={0,0};
    if (setrlimit(RLIMIT_CORE,&zero)) { result("core-limit-unavailable",false); return 3; }
    struct sigaction action={0}; action.sa_handler=stop; sigemptyset(&action.sa_mask);
    const int signals[]={SIGINT,SIGTERM,SIGHUP,SIGTSTP,SIGTTIN,SIGTTOU,SIGALRM};
    for (size_t i=0;i<sizeof(signals)/sizeof(signals[0]);i++) if (sigaction(signals[i],&action,NULL)) return 3;
    alarm(75);
    char *error=NULL;
    if (sandbox_init(kSBXProfileNoNetwork,SANDBOX_NAMED,&error)) {
        sandbox_free_error(error); result("network-sandbox-unavailable",false); return 3;
    }
    sandbox_free_error(error);
    AaisSnapshot first, initial;
    collect(&first); collect(&initial);
    if (interrupted || aais_evaluate(&first,&initial)) { result("origin-rejected",false); return 2; }
    struct stat tty;
    if (fstat(0,&tty) || !tty_current(tty.st_rdev)) { result("tty-mode-rejected",false); return 2; }
    struct pollfd descriptor={.fd=0,.events=POLLIN};
    if (poll(&descriptor,1,0)!=0) { result("pending-input-rejected",false); return 2; }
    unsigned char random[8]; arc4random_buf(random,sizeof(random));
    char nonce[17];
    for (size_t i=0;i<8;i++) snprintf(nonce+2*i,3,"%02x",random[i]);
    const ConfirmOperation operation=confirm_fixture();
    ConfirmSession session;
    uint64_t now=monotonic_ms();
    if (now==UINT64_MAX || !confirm_begin(&session,&operation,nonce,now)) { result("invalid-operation",false); return 3; }
    printf("AAIS 离线操作确认原型（不是密码提示）\n不连接服务器、不签名、不部署、不改数据库/Vercel/DNS。\n"
        "以下均为明确标记的测试值，不是真实部署授权：\n"
        "项目: %s\n操作: %s\n目标: %s\n地域: %s\n主机身份: %s\n仓库: %s\n完整测试 SHA: %s\n完整测试 digest: %s\n",
        operation.project,operation.operation,operation.target,operation.region,operation.host_identity,
        operation.repository,operation.release,operation.digest);
    printf("请勿输入密码或 Key，也不要粘贴多行文本。\n请在 60 秒内逐字输入下面这一行并回车；取消请输入 CANCEL 或按 Ctrl-C。\n%s\n> ",session.phrase);
    if (fflush(stdout)) { result("output-failed",false); return 3; }
    const char *outcome="interrupted";
    while (!interrupted) {
        now=monotonic_ms();
        if (now==UINT64_MAX || now<session.started_ms || now-session.started_ms>=60000) { outcome="expired"; break; }
        if (!tty_current(tty.st_rdev)) { outcome="tty-changed"; break; }
        descriptor.revents=0;
        int ready=poll(&descriptor,1,100);
        if (ready<0) { if (errno==EINTR) continue; outcome="input-unavailable"; break; }
        if (!ready) continue;
        if (descriptor.revents & (POLLHUP|POLLERR|POLLNVAL)) { outcome="input-disconnected"; break; }
        if (!(descriptor.revents & POLLIN)) { outcome="input-unavailable"; break; }
        // Canonical tty yields a whole line; read capacity exceeds its kernel
        // line bound so a rejected overlong line is not split back into shell input.
        _Static_assert(MAX_CANON < 4096, "Review canonical line bound on this SDK");
        char line[4096];
        ssize_t count=read(0,line,sizeof(line));
        if (interrupted) break;
        if (count<0) { outcome="input-unavailable"; break; }
        AaisSnapshot after; collect(&after);
        bool origin_ok=!interrupted && tty_current(tty.st_rdev) && aais_evaluate(&initial,&after)==0;
        outcome=confirm_finish(&session,&operation,line,(size_t)count,monotonic_ms(),origin_ok);
        memset(line,0,sizeof(line));
        break;
    }
    if (interrupted) outcome="interrupted";
    bool confirmed=!interrupted && session.state==CONFIRM_ACCEPTED;
    if (!confirmed) confirm_abort(&session,outcome);
    alarm(0);
    result(outcome,confirmed);
    return confirmed?0:2;
}
