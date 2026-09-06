# AAIS 原生、无凭据 launch-check

这是已实现的 **本机只读来源诊断工具**，不是 Owner 凭据启动器。它没有密钥输入、
Keychain、SSH、Docker、签名注册、API 调用或部署功能。现有预加载拒绝门保持不变，
不读取或消费本工具的 JSON。实际独立 Terminal 验收必须由 Owner 亲自执行。

## 实现与边界

- 原生 C 可执行文件，不依赖 Node/npm、脚本解释器或子进程执行采集逻辑。
- `libproc` 采集自身及祖先的 PID/PPID、实际/有效 UID、启动时间、进程组和控制终端。
  最多 32 层；不扫描其他进程，不读取进程参数、环境变量、命令历史、用户文件或终端输入。
- 本机 macOS 26.5.2 对 PID 1 和提权系统 login 的扩展 libproc 查询可能返回 EPERM。
  程序仅对 PID 1 或处于已验证 Owner shell 父节点位置、精确路径为 `/usr/bin/login` 的
  候选读取 `sysctl(KERN_PROC_PID)` 的只读摘要。login 摘要还必须是有效 UID 0、实际 UID
  为本次 Owner；其他节点没有此读取路径。摘要是待验证证据，不是接受结论。
  可执行路径必要时由 Security 返回实际运行代码路径，不猜测、不填充假节点、不请求 sudo。
  必须继续通过动态签名、UID 规则、父子关系和双快照检查；任一失败仍拒绝。
- 用运行中 PID 对应的 `SecCode` 验证代码身份。系统 shell/login/Terminal/launchd 必须同时
  匹配精确系统路径、代码标识及 `anchor apple`，不接受仅改名的假 Terminal。
- 同 UID 的系统 zsh/bash → 可选系统 login → 同 UID 系统 Terminal → PID 1 才属于允许形态。
  login 可为同 UID，或仅在完整五节点链中为“实际 UID=Owner、有效 UID=0”的系统转换节点；
  后者要求 login、其直接子 shell、其直接父 Terminal 均通过精确路径/Apple 代码身份验证，
  shell/Terminal 的实际及有效 UID 均为 Owner，邻接 PID 必须相符。不允许其他 root 祖先。
  Codex/ChatGPT/Electron/IDE/Node/npm/npx/tsx/Deno/Bun/sshd/tmux/screen 及未知祖先均拒绝。
  其他合法 macOS 形态不自动放行；应根据 Owner 的脱敏实测另行审查。
- 每个 PID 在代码查询前后核对身份，整条链再采集第二次；时间/PID/PPID/UID/路径摘要/
  cdhash/TTY 状态变化均不接受。不能恢复已结束的祖先或证明历史启动过程。
- stdin/stdout 都必须是同一个前台控制终端。程序不读取输入、不改变终端回显模式。
  不支持管道、重定向、后台执行、任意参数、fixture 文件或放行开关。

## 无网络与脱敏

1. 采集前必须成功进入 macOS `kSBXProfileNoNetwork`；失败时退出码 3，不降级运行。
2. Security 校验显式使用 `kSecCSNoNetworkAccess`，不请求在线撤销检查。
3. 生产二进制没有直接的 socket/connect/send/recv、子进程执行、stdin 读取、getenv 或
   Keychain 凭据查询函数。没有用户指定网络目标、文件路径或输出路径的参数。
4. 独立测试程序查询内核的 `network-outbound`/`network-inbound` 判定，两者必须拒绝；
   此测试不创建 socket、不连接任何服务。原先“socket 创建一定失败”的测试假设不成立，
   已改成策略查询，不能把创建空 socket 与建立通信混为一谈。
5. `sandbox_init` 是当前 macOS SDK 中已弃用的接口；内核策略查询 `sandbox_check` 是
   仅供测试的私有 ABI，使用 weak link，缺失或返回异常即测试失败。程序未链接该私有查询。
   本次 macOS 26.5.2 实测不能保证未来版本兼容；不是 App Store 沙箱认证或完整能力审计。
6. JSON 只输出固定类别、PID/UID、启动时间、路径 SHA-256 和 code cdhash 等诊断字段。
   不输出真实路径、进程名称/参数、环境、用户名、设备主机名、命令历史或任何输入内容。
   路径摘要不是匿名化保证；它避免直接暴露路径，但已知路径可能被猜测匹配。
7. 仅写 stdout；报告文件如需保存，由 Owner 在 Terminal 中复制内容，不使用输出重定向。
   程序禁用 core dump 并有 15 秒硬超时；截断或缺失的 JSON 不能作为通过证据。

## 构建与测试（不涉及凭据）

```text
bash scripts/build-aais-launch-check.sh
./node_modules/.bin/vitest run tests/aais-native-launch-check.test.mjs
```

构建脚本只编译该诊断工具，不是 Owner launcher，可以用于自动化构建。每次在
`output/native-launch-check/build.*` 新建目录，不覆盖已有二进制。打印 BINARY 路径、
来源摘要和二进制 SHA-256；二进制为当前机器原生架构、0500 权限、ad-hoc 签名并启用
hardened runtime。ad-hoc 签名不等于已注册或受信任的 Owner 签名。

来源摘要覆盖三个 C 源/头文件和构建脚本。二进制 hash 还需与本次交付值人工核对；
源文件注释中的摘要、进程显示名或 JSON 自述都不能替代文件完整性与独立审查。
此目录被 Git 和 Docker 构建上下文忽略，不提交二进制或测试报告。

测试分为：可在非 macOS 编译的同一 C 策略核 fixture 测试；macOS 原生构建/实际负向运行；
参数拒绝；导入符号检查；不发起通信的内核网络策略检查。测试模型与测试编译入口不链接到
交付二进制，没有可以向交付程序注入伪造进程证据的接口。macOS 专项在其他系统明确跳过。

## Owner 操作

1. 确认你从 Finder/Spotlight 亲自打开独立 Terminal.app，且没有需要先保留的运行任务。
2. 使用交付的二进制绝对路径，先通过 `/usr/bin/shasum -a 256` 核对本次提供的 hash。
3. 直接运行该二进制，不加 `sudo`，不加 `bash`/`npm`，不加参数，不用管道或重定向。
4. 程序不会询问密码或密钥。将它输出的一整段 JSON 复制给当前任务检查即可。
   如果出现凭据提示或需要降低系统保护，停止操作，不按提示输入。

退出码及结果：

| 退出码 | 结果 | 含义 |
| --- | --- | --- |
| 0 | `compatible-observation-only` | 此次原生来源和终端观察符合当前严格规则，非授权 |
| 2 | `denied` | 来源/终端/身份/完整性不满足规则，查看固定 issues |
| 3 | `unavailable` | 必要沙箱或系统条件不可用，不能继续 |
| 64 | `ARGUMENTS_NOT_ALLOWED` | 不接受输入参数或策略覆盖 |
| 其他/没有完整 JSON | 无有效结果 | 包括超时、取消、程序终止，不能视为通过 |

`collectionFailure` 的 stage：0 无采集错误；1 进程元数据读取失败；2 路径读取失败；
3 单个节点前后查询不一致/失败；4 环或断裂；5 超过上限。只包含 PID 和数值错误码，
不含错误路径或原始系统错误消息。签名不匹配单独体现在 `codeValid` 和 issues。

**所有结果都保持** `authorizesLiveExecution=false`、`humanIntentVerified=false`、
`keyAccessVerified=false`、`credentialsRead=false`。即使退出 0，也不证明人类意图、
新鲜用户在场、签名能力访问控制、跨 SSH 绑定或生产部署资格。既有 launcher-plan 的
待注册字段仍为空，实际凭据入口仍被封堵。

## 本轮证据与参考

本机 macOS 26.5.2：原生编译和 ad-hoc 签名校验成功；真实自动化父链运行返回 denied，
完整链采集成功且 PID 1 代码验证通过；C fixture 75 项断言通过；网络两方向策略均拒绝。
四个相关测试文件共 69/69 通过；lint、类型检查、Clang 静态分析及差异格式检查通过。
本轮未重新执行完整应用 CI/生产构建，也未修改凭据入口、GHCR 工作流或 launcher 注册字段。
旧版本的 Owner 手动结果确认所有 TTY 条件通过，但在 root-effective 系统 login 处被拒绝。
新增回归先复现旧版本失败，再验证受限修复；另用测试专用只读适配器检查了 Owner 提供的
现存 shell 及其 login/Terminal 父节点：扩展查询不可用、摘要读取成功、实际 UID 匹配、
有效 UID 为 root、Apple 签名和 Terminal 父关系均已验证。该适配器不控制 Terminal，
不执行采集器主入口，不链接到交付二进制，其结果不授权任何执行。
**新版本仍等待 Owner 再次亲自在独立 Terminal 运行**，不能把只读适配器或 fixture 结果
当作这次完整的正向验收，也不能绕过其余启动器安全门。

依据：本机 SDK 的 `libproc.h`/`sys/proc_info.h`/`sys/sysctl.h`/`sandbox.h`/Security 头文件；
[Apple 代码签名要求](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)、
[Apple SecCode 动态验证接口](https://raw.githubusercontent.com/apple-oss-distributions/Security/main/OSX/libsecurity_codesigning/lib/SecCode.h)、
[WebKit Sandbox SPI 声明](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/wtf/spi/darwin/SandboxSPI.h)。
