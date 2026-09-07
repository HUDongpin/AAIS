# 无凭据终端确认原型

本程序 `aais-terminal-confirm` 是新的原生 C 离线交互原型，不是 Touch ID 程序的 fallback，
也不是实际凭据启动器。它不请求生物识别、不签名、不创建密钥、不访问服务器、不部署。
既有来源核与生物识别实验源码不变，真实凭据入口和所有生产绑定继续关闭。

## 实际流程

1. 无参数启动，建立 no-network sandbox，禁用 core dump；限制75秒总运行时间。
2. 在同一进程复用 `native/launch-check` 来源采集和校验，单独使用
   `org.aais.terminal-confirm` 代码标识。拒绝禁止来源、错误身份或不完整链；不读取旧 JSON。
3. 检查 stdin/stdout 为相同前台控制终端；要求规范行模式、信号处理及正常回显开启。
   不改 termios、不关闭回显、不打开其他 tty、不请求 sudo。排队的完整输入行导致拒绝，
   不主动清空缓冲区。已有未完成行未必能被 poll 看见，因此新随机短语仍必须精确匹配。
4. 冻结并显示固定离线操作的全部字段：AAIS、offline-operation-confirmation-only、
   offline-fixture-only、offline-no-region、offline-no-server-identity、仓库和完整测试 SHA/digest。
   测试值明确不代表真实实例/主机身份，也不准用于预加载授权。真实目标不能通过参数传入。
5. 随机生成16个十六进制字符，显示 `CONFIRM AAIS <本次随机码>`；要求60秒内输入
   完全相同的一行并回车。短语不是秘密，键盘输入由终端正常回显；不要输入任何密码或Key。
6. 输入后重新采集来源、检查前台控制终端和不可变操作、时间，然后输出诊断 JSON。
   仅本次离线 `operationConfirmed` 可为 true，真实执行/硬件身份/签名保护永远为 false。

## 输入与取消规则

- 空行、yes、缺字符、前后空格、旧随机码、控制字符、缺少换行、嵌入 NUL 均拒绝。
- 单行上限128字节（含换行）；C读取缓冲4096字节大于当前SDK的MAX_CANON=1024，
  以完整读取内核规范行，避免因128字节用户上限把一行剩余文本截留给shell。
- 输入 `CANCEL` 并回车或按 Ctrl-C 取消。EOF、断线、后台切换、Ctrl-Z、SIGTERM、
  超时结束，无自动重试。SIGKILL或其他异常终止导致无完整JSON，不能视为成功。
- 未修改终端模式，因此没有回显模式需要恢复。**超时/退出时不会主动清除尚未提交的输入**；
  若返回shell后还有未完成文本，Owner应先按Ctrl-C取消该行，不要直接按回车。
- 请只输入/粘贴单行确认短语，不粘贴多行命令。规范终端无法阻止额外粘贴行在程序退出后
  留给shell处理，也不能可靠区分手打与粘贴；这是明确限制，不声称随机码证明人类身份。
- 不读取参数、环境批准值、文件或剪贴板API；stdin必须是已验证的控制终端。
  原型只针对非秘密确认文本，无法识别用户误输入的内容是否为密码，因此不得输入真实凭据。
  程序不会在JSON/日志重印原始输入或保存文件。

## 结果

| status | 解释 |
| --- | --- |
| offline-operation-confirmed | 本次离线确认文本匹配且检查通过，退出0 |
| cancelled / interrupted | 取消或信号结束，退出2 |
| expired | 60秒窗口过期或时钟异常，退出2 |
| confirmation-mismatch / input-too-long / end-of-input | 输入无效，没有确认 |
| origin-rejected / origin-changed / tty-mode-rejected / tty-changed | 来源或终端条件不满足 |
| arguments-not-allowed | 不接受参数或批准开关，退出64 |
| network-sandbox-unavailable 等 | 必要系统能力不可用，不降级继续 |

始终：`authorizesLiveExecution=false`、`hardwareIdentityVerified=false`、
`signingKeyProtectionVerified=false`、`credentialsRead=false`、`networkOperationPerformed=false`。
这里的 credentialsRead=false 表示没有凭据功能，不是对用户误输入内容的检测或保证。
普通确认JSON不能作为服务器认证/授权、签名证明或生产放行依据。

## 构建和测试

```text
bash scripts/build-aais-terminal-confirm.sh
./node_modules/.bin/vitest run tests/aais-terminal-confirm.test.mjs tests/owner-confirmation-alternative.test.mjs
```

构建仅生成原型，不执行交互；每次使用新的 output/native-terminal-confirm/build.* 目录。
二进制0500权限，ad-hoc代码签名加hardened runtime，不等于已注册的Owner身份。

C纯逻辑测试覆盖68项断言：精确匹配、错误/旧短语、控制字符/超长输入、单次确认、
取消/超时/EOF/来源变化、全部操作字段的变化、无效字段拒绝。无Terminal模拟、无凭据。
原生macOS测试验证自动化来源在提示前拒绝、参数拒绝及无直接网络/密钥/生物识别导入。
已有来源代码、生物识别代码和ECS拒绝门仍用摘要回归检查保持不变。
纯逻辑的信号/超时状态测试不代表真实Terminal下的所有交互已经验证。

Owner的正向、CANCEL、超时以及终端信号实测仍待完成。自动化不伪造TTY或绕过来源条件
来替代这些实测。本轮不运行真实凭据程序，不推送/部署，不修改ECS、Vercel或DNS。

## Owner操作

使用交付的**新原型路径**，无需再次运行已停用Touch ID实验。文件校验由Codex先完成；
Owner在独立Terminal中直接运行，不加bash/sudo/npm、参数、管道或重定向。
检查屏幕为明确的离线测试内容后，输入本次显示的确认短语；需要取消则输入CANCEL。
只将最后的完整JSON返回当前任务，不需要密码、Key、截图或原始终端内容。

本原型完成不解除 [替代方案](owner-terminal-confirmation-design.md) 中的生产审查门。

## 本轮验证（2026-09-08）

- 五个相关测试文件 66/66 通过；C确认核68项断言通过。
- 同一C确认核在AddressSanitizer/UndefinedBehaviorSanitizer下通过，无报告错误。
- lint、类型检查、Clang静态分析、差异格式检查、二进制签名完整性验证通过。
- 最终交付二进制从自动化来源实际运行返回origin-rejected，未显示输入提示。
- 八个来源/生物识别/凭据保护关键文件的摘要保持不变，原凭据开关未启用。
- 未重新运行完整应用CI/生产构建；未执行Owner正向/取消/超时TTY验收，没有操作Terminal UI。
- 没有读取真实凭据、持久化key、网络调用、推送或云端部署；不能声称已完成生产发布。
