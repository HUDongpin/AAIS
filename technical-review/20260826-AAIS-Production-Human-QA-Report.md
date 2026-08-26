# AAIS 上线后真人式生产验收与问题报告

## 1. 测试摘要

| 项目 | 结果 |
| --- | --- |
| 执行窗口 | 2026-08-26 01:55:48–03:23:48 CST（Asia/Shanghai） |
| Run ID | `PROD-HQA-20260826-015548` |
| 生产域名 | `https://aais.site`、`https://www.aais.site` |
| 部署身份 | `origin/main` 与 GitHub Production deployment 6085217834 均为 `ed00b8de29e1a7d3b26b0bd3e8604d91af0fb46e`；测试中途未变化 |
| 不可变部署 URL | `https://aais-ia5je38zf-peter-dongpin-hu-s-projects.vercel.app` |
| 浏览器 | Google Chrome 151.0.7922.174，headed、无扩展、仓库外隔离 persistent profile；Playwright 1.62.1 驱动真实页面点击、逐字输入、键盘与导航 |
| 学生账号 | 经用户明确授权，从旧 Codex 运行记录在进程内恢复历史 Production learner 凭据并通过可见表单登录；值未显示、记录或保留。任务卡起点干净，但全局导学已有 21 条历史消息，因此只用增量断言，不把账号表述为全局全新 |
| 教师账号 | `BLOCKED_CREDENTIALS`：发现的另一份历史教师文件不属于获批的旧 Codex 运行记录来源，未读取、未输入 |
| 允许副作用 | 完成平台介绍、专家示范、Task 1、Task 2；新增 7 个合成 AI turn（A1 5、A2 2）、2 次显式支架请求、1 个合成 TXT 附件、Run-ID 文档与归档尝试 |
| 禁止副作用 | 未删除学习数据，未提交有效邮箱重置，未改账号/角色/教师建议/生产配置，未操作数据库、LRS、Git、Vercel 或部署 |
| 下载与临时资料 | Markdown 下载只出现一次未确认失败观察；未生成个人导出。约 19 MB 隔离 profile、附件、下载和 raw 目录已永久删除 |
| 总体结论 | `NO_GO`：确认 2 个 S1 核心持久化/任务推进缺陷与 1 个 S2 支架状态同步缺陷；教师链、Task 4、个人导出和真实 200% 缩放仍受阻 |

本报告只记录当前 Production 黑盒事实。未修改产品代码、公共 API、数据库、环境变量、Vercel 配置或生产部署，也未提交、推送或开 PR。

## 2. 门禁矩阵

| 门禁面 | 状态 | 证据范围 |
| --- | --- | --- |
| 部署身份与中途稳定性 | `PASS` | 开始/结束 `origin/main` 和 GitHub Production deployment 均锁定同一 SHA；无新 Production deployment |
| 公开页面与 canonical host | `PASS` | 登录/条款/隐私与匿名受保护路由通过；apex path/query 以 308 归一到 www；登录后 apex `/learning` 保持授权会话 |
| 生产 readiness | `PASS` | 开始和结束的 www `/api/system/readiness` 均为 200 / `{"status":"ready"}`；apex 对等路径 308 保持 query |
| 登录页双语、协议与本地校验 | `PASS` | 中英文、`html.lang`、法律链接、密码显隐、协议真实 disabled/enabled、忘记密码空值/无效格式通过；未发送邮件 |
| 学生认证与角色隔离 | `PASS_LIMITED` | 历史 Production learner 可见登录成功；学生访问 `/dashboard`、`/admin/users` 返回 `/learning`；全局导学历史非空 |
| Task 1 与 Task 2 即时推进 | `PASS_LIMITED` | orientation、expert model、training 与 Task 2 证据/完成即时成功；Task 3 保持 pilot-closed；完成当下 Task 4 active |
| Task 2→Task 4 刷新持久化 | `FAIL` | `PROD-HQA-20260826-001`：完成当下正确，首次 reload 后 Task 1/2/4 与 35 条历史回到新会话式初始状态 |
| A1/A2 路由与 SSE | `PASS_LIMITED` | 新增 5 个 A1 + 2 个 A2；均 200 SSE；路由标签、A2 等待态、提交禁用、无重复/永久 busy 通过；2/7 显示 fallback，不能外推 Provider 合同通过 |
| A1 支架计数与 fading | `FAIL` | `PROD-HQA-20260826-003`：服务器计数推进，但当前页直到下一 mutation/reload 才显示最新剩余次数 |
| 合成附件 | `PASS` | 不支持扩展名安全拒绝；TXT 选择、移除、重选、发送与“已读取”回执通过 |
| 编辑器格式与归档 | `PASS_LIMITED` | H1/H2/H3、列表、居中、Run-ID 归档、重开和再次归档通过；粗体/斜体未获得独立持久化断言 |
| 编辑器自动保存/刷新恢复 | `FAIL` | `PROD-HQA-20260826-002`：两次均显示已保存且 PATCH 200，但 refresh 后标题/正文为空 |
| Task 4 800 字、A4 报告、总结 | `NOT_VERIFIED` | Task 2 完成状态被 S1 重置，停止继续写 Task 4 |
| Markdown 下载 | `NOT_VERIFIED` | `OBS-001 / NEEDS_REPRO`：一次显示下载失败；未能安全完成原生保存器第二次确认，不编号 |
| 个人学习数据导出 | `NOT_VERIFIED` | 核心状态重置后停止；未生成或读取 raw JSON |
| 学生退出与撤权 | `PASS_LIMITED` | 1 次 DELETE 200，refresh/直达均回登录；本轮未保留响应体 revoke/absent 布尔值 |
| 教师登录、看板与导出 | `BLOCKED_CREDENTIALS` | 未扩大授权读取独立历史教师文件 |
| 响应式学习布局 | `PASS_LIMITED` | 5 个请求视口均无页面级横向溢出；账户、上传、发送达到 44px；教师宽表未测 |
| 键盘、reduced motion、VoiceOver、200% | `PASS_LIMITED` | 登录键盘/协议与公开 skip link 通过；reduced-motion 可模拟且未见阻断；VoiceOver 与真实 200% Page Zoom 为 `BLOCKED_ENVIRONMENT` |
| 控制台、资源与安全头 | `PASS_LIMITED` | 公开页 console warning/error 为 0；CSP/HSTS/DENY/nosniff/Permissions/Referrer/COOP 存在；未对完整认证写入链保留 raw console/network |

## 3. 问题清单

### PROD-HQA-20260826-001 — Task 2 完成后刷新把任务与导学状态重置为初始会话

- 严重度：`S1 High`
- 状态：`OPEN`
- 影响角色：学生；核心学习进度、历史与 Task 2→Task 4 推进
- 页面/API：`/learning`、`PATCH /api/learning/session`
- 部署 SHA：`ed00b8de29e1a7d3b26b0bd3e8604d91af0fb46e`
- 前置条件：历史 Production learner 可见登录；Task 1 完成；Task 2 服务端门槛确认齐全；Task 3 pilot-closed
- 复现频率：`1 次完整端到端转移 + 2 次独立 reload/导航持久化信号`；按本轮规则达到“端到端复现 + 刷新后的独立持久化信号”正式编号阈值

复现步骤：

1. 经可见表单登录学生账号并完成 orientation、专家示范与 Task 1。
2. 在 Task 2 完成四项合成证据、AI 使用判断与服务端证据保存。
3. 点击一次“完成任务”，观察 Production mutation 返回 200。
4. 立即观察 Task 2 为 `completed/evidence_complete`、Task 3 为 `locked/pilot-closed`、Task 4 为 `active`。
5. 刷新 `/learning`，再次打开任务卡。
6. 使用 Privacy→Back→Forward→Back，再做第二次独立 reload，只读检查同一状态。

预期结果：Task 2 持续为 completed；Task 3 持续 pilot-closed；Task 4 持续 active；刷新与历史导航保留 35 条无重复导学消息和服务器学习状态。

实际结果：首次刷新后 Task 1 变回 active，Task 2 和 Task 4 变回 locked，完成 outcome 消失，导学消息从 35 条变为 1 条。Back/Forward 与第二次 reload 均保持该重置状态。

用户影响：学习者完成核心任务后只要刷新或重新进入，就会看到进度和导学历史回到起点，无法可靠进入 Task 4；这是本轮 `NO_GO` 核心门。

绕行方式：未找到可靠绕行。不要要求学习者避免刷新来掩盖服务器持久化问题。

最小复测条件：用全新专用 learner 完成 Task 1→Task 2→Task 4，分别在完成当下、reload、Back/Forward、重新登录后核对同一服务器任务 outcome、activeTaskId、guide message IDs 与 Run ID；至少独立 `2/2`。

证据：[PROD-HQA-20260826-001-task-progression-reset.txt](./evidence/20260826-aais-site-human-qa/PROD-HQA-20260826-001-task-progression-reset.txt)

工程责任域：S12 后端/API 平台；S03 学习工作台；S22 生产发布阻塞协调。

已确认事实：单次完成 mutation 返回 200 且即时 UI 正确；同一部署第一次 reload 后任务和消息状态重置；后续导航与第二次 reload 继续显示重置；部署 SHA/readiness 未变化。

根因假设：可能是完成 Task 2 后的 learner session/data generation/actor 映射未被后续读取命中，加载路径回退到新会话。黑盒证据不能区分数据库未提交、读取键漂移或客户端身份代际变化，需工程侧另行诊断。

### PROD-HQA-20260826-002 — 编辑器显示已保存且返回 200，但刷新后标题和正文为空

- 严重度：`S1 High`
- 状态：`OPEN`
- 影响角色：学生；文档编辑、核心产物持久化、Task 4 800 字门槛
- 页面/API：`/learning` 文档编辑器、`PATCH /api/learning/session`
- 部署 SHA：`ed00b8de29e1a7d3b26b0bd3e8604d91af0fb46e`
- 前置条件：学生登录，Task 2 active，编辑器可见；只输入 Run-ID 合成内容
- 复现频率：`2/2`（格式化文档与独立加载后的最小纯文本文档）

复现步骤：

1. 打开 Task 2 编辑器，逐字输入 Run-ID 标题与合成正文。
2. 等待 `PATCH /api/learning/session → 200` 和可见状态“文档已保存。”。
3. Repro A 依次验证 H1/H2/H3、列表和居中；记录长度与摘要哈希。
4. 刷新并重开“文档编辑”，检查标题、正文和 Run ID。
5. 在独立页面加载中只输入最小纯文本，重复保存，额外等待 2 秒后刷新。

预期结果：刷新后标题、正文、格式、长度和 Run ID 均从服务器恢复。

实际结果：两次刷新后标题长度、正文长度和 HTML 长度均为 0，Run ID 消失；此前均有 200 保存响应与明确“已保存”状态。

用户影响：界面给出成功确认但作品实际不可恢复；Task 4 依赖至少 800 个可见字符，因而核心学习完成门不可被信任。

绕行方式：在 Task 2 中，“保存并关闭”可把 Run-ID 文档归档、重开并再次归档；但该动作会清空 active working artifact，不能作为 Task 4 完成门的可靠绕行。

最小复测条件：普通文本与富文本各独立 `2/2`，验证 PATCH 200、刷新、重新登录、历史重开后的标题/HTML/可见字符数/摘要哈希一致；另验证 Task 4 的 800 字 active artifact 在不归档时持久。

证据：[PROD-HQA-20260826-002-editor-autosave-persistence.txt](./evidence/20260826-aais-site-human-qa/PROD-HQA-20260826-002-editor-autosave-persistence.txt)

工程责任域：S03 学习工作台；S12 会话持久化/API；S22 生产发布阻塞协调。

已确认事实：两次可见保存状态与 HTTP 200 都存在；保存前长度非零；刷新后标题/正文为空；归档路径能保存同一类 Run-ID 合成文档。

根因假设：自动保存 mutation 可能提交了过期的 title/artifact snapshot，或服务器返回成功但未把 working artifact 写入后续读取使用的记录；归档路径成功表明不能简单归因于所有文档存储不可用。

### PROD-HQA-20260826-003 — A1 回复完成后当前页的直接支架剩余次数不更新

- 严重度：`S2 Medium`
- 状态：`OPEN`
- 影响角色：学生；A1 分级支架与 fading 状态
- 页面/API：`/learning` Task 2、`POST /api/learning/ai-guide`、`POST /api/learning/scaffold`
- 部署 SHA：`ed00b8de29e1a7d3b26b0bd3e8604d91af0fb46e`
- 前置条件：Task 2 active；AI-supported；存在剩余直接支架
- 复现频率：`2/2 状态同步信号`，其中第二次为“单个 A1 端到端 + reload 独立持久化信号”

复现步骤：

1. 在 Task 2 观察剩余次数和当前/下一支架等级。
2. 发送一个 A1-targeted 合成消息并等待 200 SSE、响应者小张和 busy 结束。
3. 不刷新，重新读取支架状态。
4. 刷新并再次读取。
5. 另一次在页面显示 4 次时完成 A1 与显式 A2，再点击一次支架按钮并核对请求数和跳变。

预期结果：每个实际消耗 A1 直接支架的完成事件都立即把当前页按 `4 → 3 → 2 → 1 → self-check/fading` 单调更新；A2 不消耗 A1 机会。

实际结果：页面在 A1 完成后仍显示旧次数。明确案例为 1/L3 保持不变，刷新后才变为 exhausted/L4/self-check；另一信号中页面从 4 经单个 scaffold POST 直接显示 2，网络仅有一次 scaffold 请求。

用户影响：学习者看到的剩余帮助机会与服务器状态不一致，可能误以为仍可获得直接支架；后续 mutation 或刷新才突然跳级。

绕行方式：每次 A1 完成后刷新页面可看到服务器确认状态，但会打断学习过程；且在 `PROD-HQA-20260826-001` 未修复前刷新本身不可接受。

最小复测条件：全新 Task 2 state，严格只发送 5 个 A1 与 2 个穿插 A2，不点击额外支架工具；每次 SSE done 后即时与 reload 后分别核对 server-confirmed count、可见 level 和 fading，独立 `2/2`。

证据：[PROD-HQA-20260826-003-scaffold-counter-stale.txt](./evidence/20260826-aais-site-human-qa/PROD-HQA-20260826-003-scaffold-counter-stale.txt)

工程责任域：S03 学习工作台状态同步；S12/S07 导学与支架确认边界。

已确认事实：A1 请求成功且回复可见；当前页次数未立即变化；reload 后显示已推进的服务器状态；对应 scaffold 跳变只有一次网络 POST。

根因假设：导学 SSE 返回的 `helpRequestsUsed` 可能只更新 `scaffoldRequests`，而 UI 优先读取未同步的 `scaffoldState.remainingDirectAssists`，直到完整 session 或 scaffold response 覆盖该对象。该假设来自当前源码阅读，尚未在 Production 服务端诊断验证。

## 4. 已通过的检查

- 开始和结束的实际 readiness 端点均为 HTTP 200 / `ready`；测试中没有部署 SHA 或 alias 漂移。
- apex 对 login、learning、readiness 的 path/query 308 归一到 www；学生登录后从 apex `/learning` 进入同一 www 授权工作台。
- `/login`、`/terms`、`/privacy` 的中英文文案、`html.lang`、法律链接和返回路径通过。
- 匿名 `/learning`、`/dashboard`、`/admin/users` 均带安全编码 `from` 回登录且未泄露保护内容。
- 未勾选协议时登录按钮真实 disabled；勾选后 enabled。密码显隐、空/无效重置邮箱本地校验通过；未发送邮件。
- 学生角色不能进入教师或管理员面；真实账户菜单退出只发出一次 DELETE 200，刷新和直达学习页都回登录。
- Orientation、专家示范、Task 1、Task 2 三个练习入口、Task 3 `pilot-closed` 与 Task 2 完成当下自动进入稳定 ID `practice_task_3` 均得到即时 UI 证据。
- 7 个新 AI turn 均为 200 SSE；路由、A2 等待态、提交禁用、原位唯一回复、附件回执、无重复 ID 和无永久 busy 通过。详见 [student-ai-attachment-summary.txt](./evidence/20260826-aais-site-human-qa/student-ai-attachment-summary.txt)。
- 合成 TXT 的选择、移除、重选和发送通过；不支持扩展名被安全拒绝。
- H1/H2/H3、列表、居中与 Run-ID 历史归档/重开/再次归档得到结构化通过证据。
- 五个响应式请求视口均无页面级横向溢出；账户菜单、上传、发送控件达到 44 CSS px。
- 公开安全头包含 CSP、HSTS、DENY、nosniff、Permissions Policy、Referrer Policy 与 COOP。详见 [public-responsive-security-summary.txt](./evidence/20260826-aais-site-human-qa/public-responsive-security-summary.txt)。

## 5. 观察项、阻塞与未运行项

### OBS-001 / NEEDS_REPRO — Markdown 下载一次显示失败

- 一次可见点击发生在合成文档 `PATCH 200` 与“已保存”之后。
- 页面显示“文档下载未能完成，请稍后重试。”，未产生可核对的下载事件或文件。
- 自动化页级点击无法打开可验证的系统保存器；macOS UI 控制无法证明焦点锁定在隔离 Chrome，因此没有进行第二次安全确认。
- 不达到正式缺陷 `2/2` 阈值，不分配 `PROD-HQA` 编号。

以下为 `BLOCKED_CREDENTIALS`：

- 教师可见登录、role=teacher 证明、只授权合成 cohort、看板筛选/分页/风险队列、CSV/JSON 下载、英文看板与退出。
- 受保护历史教师文件不属于本轮明确授权来源；未读取、未复制、未输入。

以下为 `NOT_VERIFIED` / `BLOCKED_ENVIRONMENT`：

- Task 4 800 字 active artifact、规划/监控/评价/表达/反思、5 步专家比较报告、总结确认与刷新持久化：被 S1 任务状态重置阻断。
- 个人学习数据 JSON：核心状态重置后停止，未生成 raw 导出。
- Markdown 下载第二次真实系统保存器验证：环境焦点无法安全锁定。
- Chrome 真实 Page Zoom 200%：页面级快捷键没有改变 DPR；OS 快捷键无法证明作用于隔离窗口，因此不冒充 PASS。
- VoiceOver：无法安全把 OS 焦点锁定到隔离测试窗口。
- 完整认证后 console/network、Provider 合同、LRS 精确投递、研究 readiness、真实 cohort 与 Owner acceptance。

以下为 `NOT_RUN_SAFETY`：

- 删除学习数据。
- 提交格式有效的密码重置邮箱。
- 修改管理员账号、角色、邀请或教师建议状态。
- 浏览或导出真实 cohort。
- 手工 LRS flush/retry/reconcile/archive。
- 修复、提交、推送、PR、部署、数据库或生产配置操作。

AI 请求实际次数：`7` 个用户主动 turn（A1 `5`、A2 `2`），未超过绝对上限 `10`。其中 `2/7` 显示 fallback 标识；这不能表述为外部 Provider 合同通过或失败。

临时资料处置：隔离 Chrome profile、缓存、raw 快照/脚本、合成附件和 downloads 目录约 19 MB 已从精确临时路径永久删除。仓库只保留本报告和脱敏 TXT；没有截图、HAR、trace、原始 AI 文本、完整导出或 xAPI body。详见 [blocked-observations-and-cleanup.txt](./evidence/20260826-aais-site-human-qa/blocked-observations-and-cleanup.txt)。

## 6. 总体判定与最小复测条件

结论：`NO_GO`

理由：

1. `PROD-HQA-20260826-001` 是 Task 2→Task 4 与导学历史的 S1 持久化失败，直接违反核心学习链刷新/重进门。
2. `PROD-HQA-20260826-002` 是“保存成功”与实际可恢复文档不一致的 S1，且 Task 4 完成依赖 active artifact。
3. `PROD-HQA-20260826-003` 使 A1 直接支架/fading 可见状态与服务器状态不同步。
4. 教师主链、Task 4、个人导出、200% real zoom 仍未得到本轮 Production 证明。

最小复测条件：

- 在不改变 Production deployment 的前提下，用全新、可重置的专用 learner 独立 `2/2` 完成 Task 1→Task 2→Task 4；在 reload、Back/Forward、退出重登后核对 task outcome、active task、guide IDs 和 Run ID。
- 对普通文本和富文本自动保存各独立 `2/2`，验证可见保存状态、HTTP 200、服务器恢复内容摘要和 Task 4 800 字门。
- 严格只用 5 个 A1 与 2 个穿插 A2 重测 `4 → 3 → 2 → 1 → self-check/fading`，每个 SSE done 后不刷新即校验，再用 reload 校验。
- 由 Owner 以获批秘密渠道提供当前专用 teacher 凭据；完成只读合成 cohort、双语筛选、CSV/JSON、响应式宽表与一次性退出撤权。
- 在能可靠锁定隔离 Chrome/VoiceOver 焦点的环境补跑真实 200% Page Zoom 与读屏；在真实系统保存器中对 Markdown 下载独立 `2/2`。
- 复测期间重新锁定 Production SHA、immutable URL、aliases 与 readiness；任何部署变化均换新 profile、新 Run ID 重启，不混合结果。

证据索引：

- [run-boundary-and-deployment.txt](./evidence/20260826-aais-site-human-qa/run-boundary-and-deployment.txt)
- [PROD-HQA-20260826-001-task-progression-reset.txt](./evidence/20260826-aais-site-human-qa/PROD-HQA-20260826-001-task-progression-reset.txt)
- [PROD-HQA-20260826-002-editor-autosave-persistence.txt](./evidence/20260826-aais-site-human-qa/PROD-HQA-20260826-002-editor-autosave-persistence.txt)
- [PROD-HQA-20260826-003-scaffold-counter-stale.txt](./evidence/20260826-aais-site-human-qa/PROD-HQA-20260826-003-scaffold-counter-stale.txt)
- [student-ai-attachment-summary.txt](./evidence/20260826-aais-site-human-qa/student-ai-attachment-summary.txt)
- [public-responsive-security-summary.txt](./evidence/20260826-aais-site-human-qa/public-responsive-security-summary.txt)
- [blocked-observations-and-cleanup.txt](./evidence/20260826-aais-site-human-qa/blocked-observations-and-cleanup.txt)
- [sensitive-scan.txt](./evidence/20260826-aais-site-human-qa/sensitive-scan.txt)
- [SHA256SUMS.txt](./evidence/20260826-aais-site-human-qa/SHA256SUMS.txt)
