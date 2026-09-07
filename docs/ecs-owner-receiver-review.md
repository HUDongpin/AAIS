# ECS Owner 接收端只读审查

范围：当前本地候选中的 `deploy/aliyun/aais-preload-ghcr-image.sh`、`aais-json-v1.py`
及 Owner 设计。没有登录 ECS、查看当前云端身份、运行 helper、配置 SSH 或安装密钥。

**结论：保持封堵，不能接通原生确认演示，也不能把现有脚本当作已完成的签名接收端。**

## 现有代码实际提供的保护

- 预加载主入口先无条件拒绝缺失的 audited Owner launcher binding，先于读配置和凭据。
- 仅允许固定 GHCR repository/full SHA/digest；检查 candidate/preloaded 收据的 schema、
  root-owned 路径、权限、run/attempt、digest、OCI revision。
- 隐藏 TTY 输入、独立受限 Docker credential 目录、EXIT/INT/TERM/HUP 清理、
  清理后才写成功 preload 收据。
- JSON helper 固定路径/摘要，严格字段/类型/大小、重复键拒绝等保护。

以上应保留，但不足以实现本次确认协议。

## 必须关闭的接收端缺口

| 缺口 | 代码现状与后果 | 接通前需要的测试 |
| --- | --- | --- |
| 信任根和验签 | 接收端未注册 Owner 签名 key，未验证签名挑战；本地通过 JSON 不可用作凭证 | 未注册/已吊销/错误 key、错误算法、签名篡改必须拒绝 |
| 精确权限与固定入口 | root shell 脚本不是受限 SSH 协议接收器，现无经审查的 forced-command 身份 | 拒绝 shell/任意命令、转发、PTY、文件路径注入、其他实例/项目 |
| 会话和时效绑定 | 无服务端随机挑战、连接绑定或有效期管理 | 跨连接/实例转用、旧挑战、未来时间、断线后重交均拒绝 |
| 持久原子重放防护 | 当前收据只约束 digest 与 workflow run，不消费一次性 Owner 授权 | 两进程并发同 nonce 仅一次可用；重启后不可复用；验证失败不可错误消费其他 nonce |
| 凭据传输 | 仍是 root helper 的 `/dev/tty` 提示，无经审查的有界消息帧接收器 | 只有授权后同连接可收一帧；大小限制、超时、无回显/日志、无自动重试 |
| 来源真实性 | attestation ID/schema/布尔值只证明格式，代码没有密码学验证 provenance | 独立验证 GitHub identity/source/digest/attestation，不能仅相信 receipt 声明 |
| 崩溃恢复 | shell traps 不能在 SIGKILL 或崩溃中执行，/run 中目录可能留至重启 | 中途终止恢复扫描、残留凭据清理、无成功收据；清理失败保留未完成状态 |

## 最小下一阶段接口建议（设计，未实施）

服务端发出同连接 challenge → Mac 返回生产协议域下的目标绑定签名 → 服务端校验、
原子占用 nonce → 同连接限长 credential 帧 → 精确镜像预加载 → digest 验证 → 清理 → 脱敏收据。
接收端不接受环境 allow flag、任意脚本、客户端声称的 root 状态或离线演示协议。

首个接收端实现应只做**无凭据协议验证器**，使用临时公钥和隔离的 replay 数据目录验证
并发/重启语义；不执行 Docker、SSH 或云端注册。之后再独立审查受限服务身份和恢复清理。
生产密钥需要 OS/硬件访问控制实测及人工注册，原型的内存软件 key 不得直接升级成信任根。

目前 `owner-launcher-plan.json` 的 requiredBindings 仍全为 null，executionEnabled=false。
本轮原生演示固定域 `AAIS-OFFLINE-CONFIRMATION-TEST-v1`，没有 key/signature 输出，不能用于服务器授权。
