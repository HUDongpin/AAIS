# 原生本次确认与一次性签名能力原型

本阶段交付 **可编译的原生离线演示 + 非敏感自动化测试**。不是已保护的生产签名器，
不是 Owner 凭据启动器，不接收真实发布目标，不连接 ECS/GHCR，不持久保存或注册密钥。
不解除 `BLOCKED_AAIS_AUDITED_OWNER_LAUNCHER_BINDING_MISSING`。

## 1. 演示程序实际做什么

`aais-confirmation-check` 由原生 Swift 和 C 组成。无脚本解释器、Node/npm 子进程。
入口无参数、无 test/approve/force 开关，流程如下：

1. 在本进程复用已审核的原生来源采集与判断核，包括 system login 身份转换规则。
   独立 Terminal、同 UID、前台 TTY、完整双快照和动态 Apple 代码身份均须通过。
   C 桥接使用本演示的独立代码标识 `org.aais.confirmation-check`；旧 launch-check 不变。
2. 建立 no-network sandbox，禁用 core dump，设置 90 秒硬超时。
   来源或沙箱不满足时，在创建 LAContext 前返回，不触发生物识别提示。
3. 新建一个 `LAContext`，只使用 `deviceOwnerAuthenticationWithBiometrics`，
   reuse duration 明确为 0，隐藏密码 fallback 按钮，不使用密码认证策略。
   没有可用或已注册的生物识别设备时返回 `biometrics-unavailable`，不要求 Owner 改系统安全设置。
4. 固定显示“AAIS 离线签名自检、offline-fixture-only、不访问服务器、不使用真实 Key”。
   测试 SHA/digest 由程序固定，nonce 由系统随机源生成，不能从命令行/环境文件替换目标。
5. 仅调用一次原生认证。60 秒超时则 invalidate；取消、失败、超时均进入终止态，
   不重新提示。锁阻止迟到回调覆盖已结束的决策；测试不触发真实认证。
6. 认证成功后，先重新检查来源与不可变请求、单调时钟有效期；签名前再检查一次。
   任何变化均拒绝。仅此时生成一次性 P-256 内存密钥（`kSecAttrIsPermanent=false`）。
7. 在进入密码学操作前消费本次签名机会，签名/验签并验证篡改消息不会通过。
   私钥没有 getter/export 接口，签名不输出；函数结束释放引用。失败也不允许重试。
8. 输出脱敏结果，不输出 nonce、signature、key、认证系统错误细节或本机进程信息。

本轮使用本机 SDK 的 LocalAuthentication/Security API 编译。测试 key 是程序即时生成的
非持久内存对象，不是 Owner 的真实 key；没有 SecItemAdd/CopyMatching 或云端 key enrollment。
协议域为 `AAIS-OFFLINE-CONFIRMATION-TEST-v1`，固定操作 `offline-signature-self-check`。
未来 ECS 接收器必须拒绝这个演示协议，不能把演示结果当作授权票据。

## 2. “签名能力保护”的确切范围

已经实现的是 **应用内的软件流程限制**：请求绑定、确认顺序、过期、来源复核、一次调用、
错误/取消后失效、无持久化、无导出接口。不是硬件或 OS 强制的 key 访问边界。

尚未实现/验证：

- Secure Enclave 内部密钥及每次使用的硬件用户在场约束；
- Keychain key ACL 与签名应用的 designated requirement 绑定；
- 对同 UID 注入/调试、替换应用、已攻破系统的防御；
- 安全清除系统/运行时的所有内存副本（本原型只能释放引用，不能宣称已证明 zeroization）；
- 生产密钥的注册、轮换、吊销、有效权限或服务器信任根。

LAContext 生物识别成功证明系统在本次策略下接受了生物识别认证，不是不可否认的人类意图
证明，也不是对提交内容的硬件交易签名。原型通过软件将“一个固定离线操作”与该结果绑定，
生产前仍需独立审查。不能把 native test 中的 `.approved` fixture 当作真实认证。

所有演示结果保持 `authorizesLiveExecution=false`、`productionKeyAccessVerified=false`、
`secureEnclaveVerified=false`、`credentialsRead=false`、`keyPersisted=false`。

## 3. 自动化测试与真实运行的区别

`tests/native/confirmation-check/main.swift` 是分离编译的测试可执行文件，只链接同一原生
状态核和 Security 软件密钥 API，不链接 LocalAuthentication UI 或来源桥接。
它注入的是合成测试决策；不能在交付演示中选择这个测试入口。

覆盖：未确认不得创建 key；正确确认后真实签名/验签；篡改消息拒绝；取消/不可用/超时/
认证失败；nonce/SHA/digest 被替换；过期/非数值/倒退时钟；来源变化；重复确认与重复签名；
错误后不能恢复。原生测试共 61 项断言。失败前均检查 key 尚未创建。

Vitest 包装还检查：主程序只有一次原生认证调用；无 password fallback；来源先于 LAContext；
签名前两次来源核验；无持久 key/导出/网络/API；参数拒绝；真实自动化来源必须在提示前拒绝；
ECS 旧拒绝门和所有注册字段仍保持不变。

可运行的非敏感构建/测试：

```text
bash scripts/build-aais-confirmation-check.sh
./node_modules/.bin/vitest run tests/aais-native-confirmation-check.test.mjs
```

Codex 只运行分离测试及演示入口的实际拒绝路径，不控制 Terminal、输入凭据、代做生物识别，
也不制造 TTY 来伪装通过来源条件。

## 4. Owner 演示（由 Owner 自己决定运行）

构建生成新的 `output/native-confirmation-check/build.*` 路径、SHA-256 和来源摘要。
Owner 核对本次交付 hash 后，在独立 Terminal 直接运行二进制，无参数、sudo、管道或重定向。
确认提示只描述离线测试。取消是正常结果，无需密码/API Key/GitHub Token；出现非预期
密钥或密码提示就停止，不要输入。生物识别不可用时停止，不改用输入密码的策略。

结果：

- `offline-confirmation-self-check-passed`：真实本次生物识别与临时签名自检完成；不允许生产执行。
- `biometrics-unavailable`：未满足当前设备的生物识别条件，没有签名。
- `cancelled` / `timedOut` / `authenticationFailed`：未完成，不重试或消费真实凭据。
- `origin-or-sandbox-rejected`：来源或沙箱不满足，在认证提示之前停止。
- `originRejected` / `changedRequest` / `expired`：确认与签名之间条件变化，拒绝签名。

本轮没有执行 Owner 正向/取消的原生系统提示验收。需要 Owner 返回演示 JSON 后才能
记录相应设备上的实测结果。即使成功，ECS 接收端和生产密钥保护门仍独立。

## 5. 2026-09-07 本地验证

- 新原生演示编译与 ad-hoc 签名完整性验证通过；此签名不是 Owner 注册或硬件身份。
- 五个相关测试文件 **74/74 通过**；原生一次性签名核心 **61 项断言通过**。
- 自动化来源的真实演示运行返回 `origin-or-sandbox-rejected`，未进入认证提示。
- lint、类型检查及差异格式检查通过；本轮未重跑完整应用 CI/生产构建。
- 旧 launch-check 源码及交付二进制不变，既有凭据封堵、GHCR 和注册字段不变。
- Owner 正向/取消系统认证、Secure Enclave/Keychain 隔离、ECS 实际接收均未验证。

参考：[Apple LAContext](https://developer.apple.com/documentation/localauthentication/lacontext)、
[生物识别复用时间](https://developer.apple.com/documentation/localauthentication/lacontext/touchidauthenticationallowablereuseduration)、
[SecKeyCreateRandomKey](https://developer.apple.com/documentation/security/seckeycreaterandomkey(_:_:))。
具体属性语义核对了本机 SDK 头文件；在线文档正文需要 JavaScript，不能用链接代替实际验证。
