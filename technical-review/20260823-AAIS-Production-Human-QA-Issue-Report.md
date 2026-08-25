# AAIS 上线后真人式生产走查问题报告

## 1. 测试摘要

| 项目 | 结果 |
| --- | --- |
| 执行窗口 | 2026-08-23 13:13:28–13:26:34 CST（Asia/Shanghai） |
| 生产域名 | `https://aais.site`、`https://www.aais.site` |
| 浏览器 | 用户 Chrome，通过真实页面点击、输入、键盘、导航与响应式视口完成；未注入 Session、未模拟接口 |
| 视口 | 桌面 `1440×900`；手机 `390×844`；英文窄屏 `375×812` |
| 测试账号 | 专用学生与教师环境变量均未配置；发现 www 域名已有一个学生会话，仅做最小只读验证，未输出身份、未写入数据、未退出 |
| 业务数据变更 | 未执行 AI 消息、文档、任务、附件、导出、删除或账号变更；普通页面访问可能产生站点标准遥测，本次未把遥测写入数量作为可验证事实 |
| 总体结论 | `NO_GO`：生产 readiness 门失败；另有双域名登录状态分裂。完整学生写入与教师流程因缺少专用凭据未获验证 |

本报告只记录生产黑盒测试结果。未修改产品代码、公共 API、数据库、Vercel 配置或生产部署，也未提交 Git。

## 2. 门禁矩阵

| 门禁面 | 状态 | 证据范围 |
| --- | --- | --- |
| 公开页面可达性 | `PASS` | apex/www 登录页 HTTP 200；条款与隐私页可打开；受保护路由按会话状态跳转 |
| 生产 readiness | `FAIL` | apex/www 在测试开始与结束均返回 HTTP 503、`{"status":"not_ready"}` |
| 登录页交互 | `FAIL_WITH_PARTIAL_PASS` | 双语、密码显隐、错误提示、忘记密码本地校验、键盘路径通过；未勾选协议时登录按钮仍可用 |
| 学生登录 | `BLOCKED_CREDENTIALS` | 未配置专用学生账号；未使用演示凭据或现有会话冒充本次登录 |
| 学生只读权限 | `PASS_LIMITED` | www 现有学生会话可打开学习工作台；访问 `/dashboard` 被送回 `/learning` |
| 学习任务、AI、附件、文档、持久化 | `BLOCKED_CREDENTIALS` | 为避免污染未知现有账号，没有执行任何写入流程 |
| AI 在线/离线状态 | `NOT_VERIFIED` | 本次没有发送真实 AI 请求；不得从历史消息或 readiness 推断当前可见回复状态 |
| 教师看板与导出 | `BLOCKED_CREDENTIALS` | 未配置专用教师账号 |
| 手机登录布局 | `PASS` | 中文 `390×844`、英文 `375×812` 的核心控件均可见，截图未见横向截断 |
| 学生手机布局 | `PASS_LIMITED` | 在现有学生会话中只读确认工作台、输入区、内容展示、文档编辑和账户菜单入口可见；未进入写入面 |
| 键盘与可访问性 | `PASS_LIMITED` | 登录页账号→密码→显示密码→协议的 Tab 顺序、协议 Space 操作、账户菜单 Escape/ArrowDown 通过；登录主区域文字对比度失败数为 0 |
| 控制台、资源与安全头 | `PASS` | 公开测试页面无 console warning/error；登录页一次重载捕获 23 个网络响应，0 个加载失败或 HTTP ≥400；CSP、HSTS、DENY、nosniff 等头存在 |

## 3. 问题清单

### PROD-HQA-001 — 生产 readiness 门返回 `not_ready`

- 严重度：`S1 High`
- 状态：`OPEN`
- 影响角色：所有角色；发布与运维门禁
- 页面/接口：`https://aais.site/api/system/readiness`、`https://www.aais.site/api/system/readiness`
- 前置条件：匿名请求，无凭据
- 复现频率：`4/4`（两个域名 × 测试开始/结束各一次）

复现步骤：

1. 对 apex readiness 地址执行 GET。
2. 对 www readiness 地址执行 GET。
3. 在测试结束时重复两次请求。

预期结果：HTTP 200，公开状态为 `{"status":"ready"}`。

实际结果：四次请求均返回 HTTP 503，响应为 `{"status":"not_ready"}`。

用户与发布影响：登录页和部分学习界面可访问不能替代生产健康门。当前状态不得表述为全面上线通过，也不能据此声称 live AI 可用。

绕行方式：无 readiness 层面的绕行方式。确定性本地支架可能维持部分学习体验，但本次因缺少专用账号未重新验证，不能用作该门禁的通过证据。

证据：[PROD-HQA-001-readiness-http.txt](./evidence/20260823-aais-site-human-qa/PROD-HQA-001-readiness-http.txt)

工程责任域：S22 生产发布；根据非公开 readiness 明细再路由至 S07 AI 或 S12 API/平台。

已确认事实：公开 readiness 当前为 HTTP 503 / `not_ready`；公开登录页仍为 HTTP 200。

根因假设：本次黑盒走查未读取管理员 readiness 明细，也未检查或修改 Vercel/Provider 配置，因此不下根因结论。

### PROD-HQA-002 — apex 与 www 未归一，登录状态按主机分裂

- 严重度：`S2 Medium`
- 状态：`OPEN`
- 影响角色：已登录学习者；域名、认证与导航
- 页面：`https://aais.site/learning`、`https://www.aais.site/learning`
- 前置条件：同一个 Chrome 会话中，www 已存在有效学生会话；未读取 Cookie，未输出身份
- 复现频率：`2/2`

复现步骤：

1. 在同一浏览器访问 `https://aais.site/learning`。
2. 观察最终地址为 `https://aais.site/login?from=%2Flearning`，学习工作台不存在。
3. 随后访问 `https://www.aais.site/learning`。
4. 观察最终地址仍为 `https://www.aais.site/learning`，学习工作台可见。
5. 重复上述顺序一次。

预期结果：面向用户公开的两个域名应归一到一个 canonical host，或至少保持一致的认证后导航体验。

实际结果：两个主机独立提供页面；www 的有效会话不适用于 apex。用户从书签、文档或链接切换主机时会被要求重新登录。

用户影响：产生“刚刚登录却又回到登录页”的体验，并可能形成两套并存的主机会话。未观察到越权或跨用户数据泄露。

绕行方式：在修复前始终使用 `https://www.aais.site`，不要混用 apex 链接。

证据：[PROD-HQA-002-host-session-split.txt](./evidence/20260823-aais-site-human-qa/PROD-HQA-002-host-session-split.txt)

工程责任域：S22 生产发布；S12 认证/API 平台。

已确认事实：相同 Chrome 会话、相同时间窗、相同 `/learning` 路径在两个主机得到不同认证结果，连续两轮一致。

根因假设：可能是未设置 apex→www canonical redirect，同时 Session Cookie 为 host-only；需通过实际 DNS/Vercel 重定向和 Cookie 配置另行诊断。

### PROD-HQA-003 — 未勾选协议时登录按钮仍处于可用状态

- 严重度：`S3 Low`
- 状态：`OPEN`
- 影响角色：未登录用户；登录与同意流程
- 页面：apex/www `/login`
- 前置条件：页面 `data-client-ready=true`；账号密码登录模式；协议复选框未勾选
- 复现频率：`4/4`（apex 三次独立页面加载，www 一次）

复现步骤：

1. 打开登录页，不勾选用户协议和隐私政策。
2. 观察“立即登录”按钮状态。
3. 使用合成测试账号文本和非敏感占位密码点击按钮。

预期结果：未确认协议时，“立即登录”按钮不可用。

实际结果：按钮没有 `disabled` 属性且可点击。点击后页面仍停留在 `/login` 并显示“请先确认用户协议、隐私政策和必要的监护人同意。”，说明可见校验文案存在，但禁用态验收不通过。

用户影响：界面会给出可以提交的视觉和交互暗示，用户只能在点击后才知道同意是必需条件；未观察到由此获得认证会话。

绕行方式：用户先勾选协议复选框再点击登录。

证据：[PROD-HQA-003-consent-button-enabled.png](./evidence/20260823-aais-site-human-qa/PROD-HQA-003-consent-button-enabled.png)

工程责任域：S03 学习/登录界面；S09 文案与可访问性。

已确认事实：复选框未勾选时按钮可用；点击后出现明确的同意校验错误。

根因假设：部署页面的按钮禁用条件可能只绑定客户端 hydration/提交中状态，未绑定 consent state；这需要对部署代码另行确认。

## 4. 已通过的公开与只读检查

- apex/www `/login` 均为 HTTP 200，页面标题为 CAAIS，未出现证书、安全拦截或 Next.js 错误覆盖层。
- 未登录访问 apex `/learning`、`/dashboard` 会正确返回带 `from` 参数的登录页。
- 中文和英文切换会更新页面文案、`lang` 与法律链接语言参数。
- 密码显示/隐藏会在 `password` 与 `text` 类型之间正确切换。
- 空登录表单、未确认协议、空重置邮箱和无效邮箱均显示安全、明确的本地错误文案；未发送重置邮件。
- 英文条款与隐私页能通过登录页链接打开，并可返回登录页；标题与 H1/H2 结构存在。
- 登录键盘路径和协议复选框 Space 操作通过；登录页主区域自动文字对比度检查为 0 个失败。
- 公开登录页 CSP 禁止对象、框架祖先和内联样式属性；HSTS、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、权限策略存在。
- 中文手机与英文窄屏登录页核心控件可见，未在截图中观察到横向截断。
- 现有 www 学生会话中，学习工作台加载完成；学生访问教师看板被送回学习页；账户菜单可由鼠标和 ArrowDown 打开，可由 Escape 关闭。未点击导出、删除或退出。

截图证据：

- [public-login-zh-390x844.png](./evidence/20260823-aais-site-human-qa/public-login-zh-390x844.png)
- [public-login-en-375x812.png](./evidence/20260823-aais-site-human-qa/public-login-en-375x812.png)
- [public-login-desktop-1440x900.png](./evidence/20260823-aais-site-human-qa/public-login-desktop-1440x900.png)
- [public-network-console-summary.txt](./evidence/20260823-aais-site-human-qa/public-network-console-summary.txt)
- [SHA256SUMS.txt](./evidence/20260823-aais-site-human-qa/SHA256SUMS.txt)

## 5. 未测试或受阻项

以下项目均为 `BLOCKED_CREDENTIALS`，不是已确认产品缺陷：

- 专用学生账号的错误密码与正确登录。
- 学习任务进入、完成与下一任务解锁。
- 普通消息只显示小张、非显式 Professor 保持小张、显式 `@教授`/`@Professor` 等待气泡与单一可见响应者。
- 当前 live AI、离线支架、额度提示和响应耗时。
- 对话刷新持久化与隐藏 A3/A4 回合不外露。
- 合成附件读取、文档 H1/H2/H3、保存、历史恢复、下载和个人数据导出。
- 教师登录、看板筛选、CSV/JSON 导出。
- 完整学生/教师键盘路径和认证后对比度。

以下项目为 `NOT_RUN_SAFETY`：

- 删除学习数据。
- 发送真实密码重置邮件。
- 修改用户、角色、教师建议或真实 cohort 数据。
- 在未知的现有学生会话中写入、导出或退出。

## 6. 发布建议

结论：`NO_GO`

理由：

1. `PROD-HQA-001` 是明确的 S1 生产 readiness 门失败。
2. `PROD-HQA-002` 使 apex 与 www 的登录后体验不一致，用户可因主机切换意外回到登录页。
3. 关键学生写入、live AI、持久化和教师流程因缺少专用账号尚未获得生产验收，不能把部分公开页面通过扩大为整站通过。

最小复测条件：

- readiness 恢复为 HTTP 200 / `ready`，或存在 Owner 明确记录并批准的同范围发布豁免。
- 确定 canonical host 并验证 apex/www 登录后导航一致。
- 配置专用学生与教师生产测试账号，通过本报告第 5 节所有认证后用例。
- 修复或由 Owner 明确接受登录协议按钮禁用态偏差。
