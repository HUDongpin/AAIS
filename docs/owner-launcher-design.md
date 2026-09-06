# AAIS Owner 启动器方案与非敏感测试

状态：**设计候选 / 离线模型，不是已审计或可执行的凭据启动器。**
本轮不连接 ECS/GHCR，不运行 SSH/Docker，不调用 Keychain，不读取任何真实凭据，
不打开或控制 Terminal.app，不改动现有封堵门。

## 1. 目标与不可跨越的边界

仅设计 `AAIS` 的一次私有 GHCR **精确 digest 预加载**。不包含启动应用、迁移数据库、
更改 API Key、Vercel、DNS、账户成员、其他项目或任意远程命令。
现有目标记录为香港实例 `i-j6ceyx0s8nb3p6np317g`、`47.83.162.150`；
这是历史目标线索，正式注册前必须重新验证，不作为本轮已检查的服务器身份。

Owner 必须亲自在独立的系统 Terminal.app 中启动未来的本地程序，并亲自输入隐藏凭据。
Codex/ChatGPT/IDE/Electron/Node/npm/npx/tsx/Deno/Bun 等进程及后代不得启动凭据流程。
测试中的 Node 仅运行离线数据模型，绝不启动、包装或模拟一次真实凭据运行。
本方案不复用 Sufeiya 或 HELP Math 启动器，不接受环境变量 allow flag 或 unsigned receipt。

## 2. 架构选择：原生 Mac 控制器 + 受限 ECS 接收端

```text
Owner 独立 Terminal
  → 原生 Mac 控制器：来源/TTY/代码身份/本次用户在场检查
  → 固定 SSH 主机身份与受限操作通道
  → ECS 一次性挑战（目标、镜像、会话、nonce、有效期）
  → Mac 本地复核并签名 → ECS 验证及原子占用 nonce
  → Owner 在 Mac 本地隐藏提示输入短期 read:packages 凭据
  → 同一已验证通道、一次提交 → ECS 拉取精确 digest
  → digest / OCI revision 检查 → 凭据清理 → 脱敏结果
```

### Mac 端

- 候选实现选用原生 Swift/C 可执行文件；不能用 Node/npm 等作为凭据入口或父进程。
  本轮不编译或创建此可执行文件。
- 从操作系统获取 PID、PPID、UID、进程启动时间、真实代码身份及控制终端信息。
  不信任环境变量、窗口标题、进程显示名或用户提交的 JSON。
- 核验完整父链和两次一致快照：本地非 root Owner → 允许的原生 shell/可选 login
  → 同 UID 的系统 Terminal.app → 正确的系统祖先进程。未知中间层、无法读取、
  PID 复用、UID 变化、后台/异终端或禁止来源均拒绝。真实 macOS 版本的合法链形态
  仍需 Owner 执行非敏感采集后确认，不能把测试中的形态当作系统事实。
- 对 launcher、原生采集器、允许的 shell、Terminal 进行真实代码身份与完整性验证；
  文件名匹配不够。安装目录应不可被普通流程替换，核验时需防符号链接与竞态。
- 本次明确用户在场与签名能力的访问控制需要单独原型验证：不能把 `userPresence=true`
  当作输入。具体 macOS Keychain/Security API、签名要求和私钥不可导出的实现尚未批准。
- 非敏感目标检查完成后才显示隐藏提示；不从 DOCX、剪贴板、参数、环境变量或 stdin
  自动取凭据。这里只接受本流程的短期 GHCR 读取凭据，不接受 ALI QWEN Key、数据库
  密码或阿里云 AccessKey。Owner 取消即结束，无自动重试。

### ECS 端

- 拟使用单独受限的 SSH 身份与固定操作入口，不授予普通远程 shell、任意 sudo、
  Docker 组成员、端口转发、agent forwarding、X11、任意路径上传或 PTY。
  需要权限的底层 helper 只接受协议中的固定预加载操作，不能拼接 shell 命令。
- 不再把远端 TTY 当成本机 Terminal 的证明。远端仅在 Owner 注册的信任根下接受
  目标绑定签名；注册本身需要审核、明确授权和独立身份校验，本轮不执行注册。
- 客户端固定主机公钥指纹并严格校验，主机密钥变化直接拒绝；不采用首次自动接受、
  `StrictHostKeyChecking=no`、可变 ProxyCommand、复用未知连接或用户 SSH config
  中的任意钩子。如何隔离系统/用户配置也必须在原型中验证。
- 每个连接生成随机会话绑定与随机 nonce。这里的会话绑定是服务端状态绑定的随机值，
  **不是已经实现的 SSH session-key exporter**；接收端必须将挑战及后续提交固定到同一连接。
- 注册的签名公钥只允许 AAIS preload 操作，不能作为通用 Owner 权限；使用 P-256/SHA-256
  是当前模型选择，不代表已完成 macOS 硬件密钥或访问控制的实现。
- 对 nonce 进行持久、原子、一次性占用；检查有效期、同连接及目标后才接收凭据帧。
  服务重启、重复提交、并发进程不能恢复一次已消费授权。内存 Set 不足以实现这个要求。
- 凭据只经已固定身份的加密通道作为受限帧传递，不在命令行、环境变量、收据或普通日志。
  接收端凭据文件只允许每次运行独有的 root-only tmpfs 目录；保留现有精确 digest、
  OCI revision、私有包与可信来源检查，不更换镜像来源或绕过发布收据。

## 3. 明确的信任限制：不声称无法证明的事情

父进程快照无法完整重建已结束的祖先进程，也无法证明人类意图。macOS 的启动服务、
重定父进程或已有 Terminal 复用都可能让仅基于名称/父链的结论失真。
远端验签只证明某签名能力参与了请求，**并不独立证明按下启动按钮的人是谁或来源一定是 Terminal**。

因此正式设计必须把可信的原生采集、应用代码身份、本次用户在场、受控签名能力与
审核过的注册流程结合，并明确依赖本机 OS 和 Owner 账户未被攻破。如果无法证明
所要求的边界，保持拒绝，不把本方案降级为“有 TTY + 有签名 = 已通过”。
同 UID 恶意进程、调试/注入、可修改签名 key 的 ACL、已解锁签名代理和 root/OS 被攻破
是必须审查的威胁；本轮模型不声称已抵御这些攻击。

## 4. 请求格式与失败处理

请求必须固定项目、操作、实例、主机指纹、两端 helper 摘要、镜像仓库、完整发布 SHA、
镜像 digest、会话绑定、随机 nonce、签发与到期时间。最多 4096 字节；仅允许固定字段，
严格 canonical JSON；拒绝重复键、额外字段、非规范编码、latest/tag、跨项目与未知版本。
模型有效期为 60 秒；真实提示等待/同连接授权过期的上限需一并实现，过期后取消，
不能凭已显示的输入提示继续提交，也不能静默重新取挑战并重试。

禁止在摘要、错误、日志中输出凭据或其可逆编码。取消、超时、断线、拉取失败都进入清理；
只有检查精确镜像通过且凭据清理被确认后才能写成功收据。清理失败必须单独报告并
保持未完成，不得写成功或自动复用前一次凭据。SIGKILL/崩溃需要接收端恢复扫描、
未完成状态以及安全清理机制；shell 的 EXIT trap 单独不够。此恢复机制尚未实现。

## 5. 本轮实际交付与测试证据的含义

| 文件 | 实际能力 | 明确没有的能力 |
| --- | --- | --- |
| `deploy/aliyun/owner-launcher-plan.json` | 禁用状态的目标与待绑定字段草案 | 无有效签名根、主机指纹或可执行授权 |
| `tests/helpers/aais-owner-launcher-model.mjs` | 纯数据来源规则、签名请求验证、生命周期模型 | 不读取 OS 进程/TTY/凭据，不连接网络 |
| `tests/aais-owner-launcher-model.test.mjs` | 合成来源、临时测试密钥的真实签名/验签及拒绝测试 | 不证明真实 Terminal、真实用户在场或真实服务器状态 |

测试矩阵包括：允许的合成链；12 类禁止来源；缺失/伪造 TTY 和用户在场；UID/父链/
PID/快照变化；正确测试签名、错误实例/指纹/镜像/helper/会话；过期和未来时间；
重放、错误 nonce、错误 key/缺少注册、签名篡改；重复键/超长/未知字段；
取消、超时、断线、失败、清理失败与成功收据的顺序。测试私钥只存在进程内存，
不导出、不打印、不存盘、不注册，不用于任何真实资源。

所有接受结果均带 `authorizesLiveExecution=false`。模型位于 tests 目录，现有
Docker 上下文排除 tests；生产入口不导入它、不消费其结果，仍保留无条件拒绝门。
测试中的 `fresh-verified-by-native-collector` 和 identity 标签仅表示待实现采集器
的假设，不能被实际程序当作用户可填写的证据。

本轮允许自动运行的命令只有非敏感测试，例如：

```text
./node_modules/.bin/vitest run tests/aais-owner-launcher-model.test.mjs
```

这不是 Owner 启动命令。现在无需在 Terminal 输入任何东西。

## 6. 后续审查门（不能由模型通过自动关闭）

1. 审查本方案的信任模型，特别是本机可信采集、签名能力保护与跨 SSH 限制。
2. 实现分离的无凭据原生采集器与非敏感 launch-check，由 Owner 独立启动；
   Codex 只读取脱敏结果，不控制 Terminal，不运行未来凭据 launcher。
3. 验证原生代码身份、密钥访问控制和新鲜用户在场能力；结果不足则停止。
4. 独立审查 ECS 接收端最小权限、固定目标、持久重放防护、SIGKILL/恢复清理；
   用隔离测试机/容器验证，不操作共享生产实例来替代测试。
5. 重新验证 AAIS 云端身份，单独批准安装/注册公钥和目标绑定；本轮所有 null 字段
   必须有真实证据，而不是生成占位值。
6. 独立安全审查通过后才决定是否替换现有拒绝门；凭据运行仍须 Owner 亲自启动。

## 7. 本轮本地验证（2026-09-06）

- 新模型 49 项测试，加上现有 preload/release-split/deployment-assets 回归，共 **76/76 通过**。
- `npm run lint`、`npm run type-check`、`git diff --check` 通过。
- 现有预加载拒绝门与 GHCR 工作流未修改；生产目录没有引用测试模型。
- 未运行原生来源采集、Terminal UI、真实 launch-check、SSH、Docker、Keychain、
  真实签名注册、真实凭据输入或任何云端写入；未重新运行完整应用 CI/构建。
- 以上仅是设计逻辑和边界回归证据，不是生产安全审计、Owner 验收或可发布证明。

参考：[OpenSSH 客户端配置与严格主机校验](https://man.openbsd.org/ssh_config)、
[OpenSSH authorized_keys 限制选项](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT)。
这些选项提供通道与权限约束，不是人类启动来源证明；必须验证目标 macOS/ECS 的实际版本支持。
