# AAIS 本地真人式全链路 QA 问题报告

## 1. 测试摘要

| 项目 | 结果 |
| --- | --- |
| 执行窗口 | 2026-08-25 11:36:42–14:28:51 CST（Asia/Shanghai） |
| Run | `20260825-033642-88580` |
| 本地地址 | `http://localhost:3000`；Next 与浏览器始终使用同一 `localhost` origin，未混用 `127.0.0.1` |
| Checkout | 分支 `codex/aais-guide-history-hydration-20260823`；HEAD `f33652e2d3d9bbed5c2a35dc7fc577fd78fb5799`；origin `https://github.com/HUDongpin/AAIS.git` |
| 浏览器方式 | 全新隔离 profile 的 headed Chrome for Testing `151.0.7922.34`，Playwright `1.62.1`；认证均经可见表单；未注入 Session/Cookie，未 mock、intercept 或伪造 AI/LRS 响应 |
| 隔离数据 | 两套仓库外一次性 PostgreSQL `16.15`：主浏览器矩阵与 LRS 单学生子运行分离；未连接现有 `.aais-data`、产品库、研究库或生产库 |
| 合成身份 | 同一唯一 cohort 下 1 名学生、1 名教师；只保留不可逆身份哈希前缀 `dfadfa027ddca803` 与 `366cdd7b4f3a39ea` |
| 外部配置 | 当前 AI Provider/model 与 LRS endpoint/credential 均配置；research mode 明确关闭；密钥值未读取到报告、截图或证据 |
| 真实 AI 副作用 | 10 次真实 Provider 请求，均 HTTP 200/SSE，无 fallback；原始 prompt 与完整回复未保留 |
| 外部 LRS 副作用 | 只执行 1 次授权 flush。11 个预期 statement ID 均可逐 ID GET，故确认外部 LRS 中存在 11 条本轮伪匿名记录；没有重试、requeue、手工 POST 或管理员对账 |
| 禁止操作 | 未删除学习数据、未发送真实邮件、未修改管理员账号、未写教师推荐状态、未修复代码、未提交/推送 Git、未部署 |
| Git 边界 | 初始状态 0 字节；Next 运行时自动改写的 `next-env.d.ts` 已在停止服务后精确恢复；正式交付仅包含本报告与本轮脱敏证据 |
| 临时数据清理 | 两套数据库、浏览器 profile、下载、trace、snapshot、日志与原始 LRS probe 已移出 workspace 并放入 macOS 废纸篓；在用户清空废纸篓前仍可恢复 |
| 总体结论 | `NO_GO`：确认 2 项 S1 High、3 项 S2 Medium；LRS 本地交付状态仍为 `uncertain`，远端 actor 集合一致性与 version 门禁未闭环 |

本报告只证明当前 commit、当前本机隔离环境与本轮授权外部调用的结果。它不证明 Preview/生产、正式研究 LRS、邮件、OIDC、监控、真实 cohort、PostgreSQL 持久部署或删除合规已经通过。

## 2. 门禁矩阵

| 门禁面 | 状态 | 证据范围 |
| --- | --- | --- |
| 隔离环境与可追溯性 | `PASS` | 一次性 PG、独立 runtime secrets、仓库外 profile/download/temp；初始与运行时清理后的 Git 状态均为 0 字节 |
| 公开路由与安全 `from` | `PASS` | `/` → `/login`；匿名 `/learning`、`/dashboard`、`/admin/users` 均回到带安全编码 `from` 的登录页 |
| 登录校验与双语 | `PASS` | 中英文、HTML `lang`、条款/隐私、密码显隐、空字段、错误密码、未勾协议、忘记密码本地校验、Back/Forward/refresh 均完成；未发邮件 |
| 学生/教师可见表单认证 | `PASS` | 两种角色均通过真实表单登录；无 cookie/session 注入 |
| 角色授权 | `PASS` | 学生不能进入教师/管理员页；教师不能进入管理员页；教师只看到授权 cohort 的 1 名伪匿名学生 |
| 学生任务状态与转移 | `PASS` | 初始任务 1；任务 2 锁定；任务 3 `pilot-closed`；完成任务 1 后任务 2 解锁但不自动进入；完成任务 2 后自动进入任务 4；刷新后保持 |
| 编辑、自动保存与刷新恢复 | `PASS` | 合成文档、快速编辑、H1/H2/H3、粗体、斜体、列表、对齐、保存关闭、历史重开与二次编辑均通过 |
| 学生 Markdown 实体落盘 | `BLOCKED_ENVIRONMENT` | `BLOCKED_ENVIRONMENT_NATIVE_FILE_PICKER`；原生保存对话框不可由当前自动化表面安全选择路径，不能冒充产品下载失败 |
| 附件读取与安全拒绝 | `PASS` | 安全 `.txt` 读取、移除、重选、随消息发送；不支持扩展名与第 4 个文件均被拒绝 |
| 学生个人数据导出实体落盘 | `BLOCKED_ENVIRONMENT` | 同一原生保存对话框限制；取消时未发 privacy GET，未把自动化限制判为产品缺陷 |
| 真实 AI Provider/SSE transport | `PASS` | 10/10 HTTP 200、SSE Content-Type、无 fallback；A3/A4 无可见泄漏；刷新历史无重复、空白或永久 busy |
| A1 四次直接支架与 fading | `FAIL` | `LOCAL-HQA-001`；2/2 独立学生会话，10/10 请求的 `helpRequestsUsed` 均为 0 |
| A2 Professor 路由与等待态 | `PASS` | `@教授`、`@Professor` 先显示 thinking，处理中禁用输入，最终原位替换且只有一个可见响应者 |
| 教师 cohort 看板、筛选与导出 | `PASS` | 合成学生统计、Phase/Agent/Event、刷新、空态、分页禁用态；真实 CSV/JSON 下载、解析、筛选和隐私字段断言通过 |
| 教师可见退出与会话撤销 | `FAIL` | `LOCAL-HQA-002`；2/2 点击退出均无 DELETE/revoke，直达 `/dashboard` 可恢复旧会话 |
| 登录/学习响应式 | `PASS` | 桌面 `1440×900`、中文 `390×844`、英文 `375×812`、横屏 `812×375` 均无 body 横向溢出 |
| 教师 tablet 与 200% reflow | `FAIL` | `LOCAL-HQA-003`；`812×375` body overflow 103px；真实 200% zoom、innerWidth 720 时 overflow 195px |
| 英文教师页语言语义 | `FAIL` | `LOCAL-HQA-004`；`html lang=en-US`，看板主要内容为中文且无局部 `lang=zh-CN` |
| 关键触控目标约 44px | `FAIL` | `LOCAL-HQA-005`；多处高频主控件实测高 36px 或 40px |
| Reduced motion | `PASS` | 媒体查询匹配；可见元素 animation/transition offender 为 0 |
| 键盘与自动 DOM 语义 | `PASS` | skip link、Tab/Shift+Tab、Space、Enter、方向键、Home/End/Escape；具名 main/H1、menu、aria-live、status/alert/busy 均检查 |
| VoiceOver 三页短走查 | `BLOCKED_ENVIRONMENT` | `BLOCKED_VOICEOVER_TARGETING`；2/2 无法把 OS 级焦点安全定向到隔离 Chromium，DOM 检查未冒充读屏 PASS |
| 主浏览器运行 LRS flush | `NOT_RUN_SAFETY` | 学生 59 个物理 outbox 候选之外另有 2 个教师候选；全局 worker 无 actor 过滤，故未写外部 LRS |
| 隔离学生 LRS flush/readback | `BLOCKED_EXTERNAL` | 11 条只执行一次 flush，HTTP 502；逐 ID 11/11 可读，但本地 attempt 为 `uncertain`，actor 集合 60 秒内未收敛，11/11 version 门禁失败 |
| 删除、真实邮件、管理员与推荐写入 | `NOT_RUN_SAFETY` | 按计划明确禁止，不属于产品缺陷 |

## 3. 问题清单

### LOCAL-HQA-001 — A1 帮助计数不推进，四次直接支架与第五次 fading 契约不可运行

- 严重度：`S1 High`
- 状态：`OPEN` / 门禁 `FAIL`
- 影响角色：学生；A1 小张；Scaffolding/fading 教学流程
- 页面/API：`/learning`、`POST /api/learning/ai-guide`
- 运行身份：上述 branch/HEAD/origin；`http://localhost:3000`
- 前置条件：全新合成学生会话；同一任务；真实 Provider；无 Session 注入、API mock/intercept 或伪造回复
- 复现频率：`2/2` 独立学生会话；全轮 `10/10` 真实请求；主会话计划内 A1 五步序列 `5/5`

复现步骤：

1. 通过可见表单登录全新合成学生。
2. 在同一任务依次发送普通帮助、裸“教授/Professor”、`@小张` 与普通追问，完成五次 A1 帮助序列。
3. 只捕获脱敏后的请求 ordinal、target、SSE lifecycle、fallback 标记和 `workspaceState.helpRequestsUsed` 数字。
4. 在第二套隔离 PostgreSQL 与新浏览器会话再次从可见表单登录并发送两次真实请求，确认新会话仍从同一错误状态出发。

预期结果：主 A1 序列应发送 `0,1,2,3,4` 或语义等价的单调推进状态；前四次属于直接支架机会，第五次进入 fading/对话优先行为。

实际结果：主 A1 五步序列为 `0,0,0,0,0`；两套会话共 10 次真实请求全部为 0。第五次无法通过该状态契约到达规定的 fading 分支。

用户与教学影响：产品无法执行声明的渐隐支架策略，学习者可能持续获得同一强度帮助；教师看板中的支架请求统计也保持 0，无法用于判断帮助机会消耗。

绕行方式：无等价产品内绕行。教师人工控制帮助次数不能构成 A1 状态契约通过。

证据：[LOCAL-HQA-001-a1-help-counter.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-001-a1-help-counter.txt)

工程责任域：S07 AI orchestration；S08 state/data contract；必要时协调 S03 learner workspace。

已确认事实：客户端 `src/components/pages/learning/use-learning-guide.ts:202` 每次发送 `helpRequestsUsed: 0`；API 在 `src/app/api/learning/ai-guide/route.ts:178` 把该状态传给 graph；graph 在 `src/lib/ai/orchestration/aais-learning-guide-graph.ts:481,495` 依赖该值计算剩余机会与 fading。真实 Provider transport 本身 10/10 成功，不是本缺陷的失败原因。

根因结论：可见 UI 固定发送 0 是已确认的直接原因。为何未由已持久化任务状态计算并递增，需要另行设计/代码诊断；本轮未修复。

### LOCAL-HQA-002 — 教师“退出账号”只导航登录页，未撤销服务器会话

- 严重度：`S1 High`
- 状态：`OPEN` / 门禁 `FAIL`
- 影响角色：教师；共享设备上的认证与 cohort 数据访问
- 页面/API：`/dashboard` → 可见“退出账号” → `/login`；Session 删除接口未被调用
- 运行身份：上述 branch/HEAD/origin；`http://localhost:3000`
- 前置条件：合成教师通过可见登录表单建立有效会话
- 复现频率：`2/2` 独立 headed 浏览器 profile

复现步骤：

1. 通过可见表单登录教师并进入 `/dashboard`。
2. 点击页面提供的“退出账号”。
3. 记录最终 URL 与同一时间窗内 DELETE/revoke 请求数，不读取 Cookie 内容。
4. 刷新登录页并直接访问 `/dashboard`。
5. 在第二个全新 profile 重复。

预期结果：可见退出应撤销服务器会话；refresh、Back 和直达保护路由均不得恢复教师权限。

实际结果：两轮都只到达 `/login`，DELETE/revoke 请求数均为 0；直接访问 `/dashboard` 会恢复教师看板。

用户影响：共享设备上的教师可能误以为已退出，后续操作者仍可进入 cohort 数据面。当前未观察到跨 cohort 数据泄露，但会话撤销保证失败。

绕行方式：测试环境可关闭隔离 profile 或清除站点数据；这不是产品内安全退出，也不适合作为用户绕行。

证据：[LOCAL-HQA-002-teacher-logout-session.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-002-teacher-logout-session.txt)

工程责任域：S12 auth/API；S01 shared header UI。

已确认事实：教师页使用的共享 Header 在 `src/components/layout/header.tsx:56` 是普通 `/login` Link；没有 logout handler。学生账户作为对照会调用 Session DELETE；服务器删除路由存在。浏览器结果与源码因果链闭合。

根因结论：教师退出控件没有调用 Session 撤销是已确认的直接原因；无需把问题归因于 Back/Forward cache 或 Cookie 格式。

### LOCAL-HQA-003 — 教师看板在横屏与真实 200% zoom 下产生页面级横向溢出

- 严重度：`S2 Medium`
- 状态：`OPEN` / 门禁 `FAIL`
- 影响角色：教师；tablet、低视力/zoom 与键盘用户
- 页面：`/dashboard`
- 运行身份：上述 branch/HEAD/origin；headed Chromium
- 前置条件：教师看板加载完成，main `aria-busy=false`
- 复现频率：`2/2`

复现步骤：

1. 在教师看板设置 `812×375`，等待页面 ready。
2. 读取 document/body scrollWidth 与 innerWidth，并区分表格内部 scroller。
3. 恢复桌面宽度，通过真实浏览器缩放到 200%，确认 outerWidth 基本不变、innerWidth 为 720、DPR 为 2。
4. 重复 document/body overflow 计算，并在独立会话复核。

预期结果：document/body overflow `<=1px`；宽表只在自身 `overflow-x` 容器内横滚，页面主导航与控制保持可达。

实际结果：`812×375` 时 document/body overflow 103px；真实 200% zoom 时 overflow 195px。两者的根页面 scrollWidth 均为 915px，不是正常的表格内部横滚。

用户影响：用户必须横向移动整个页面，控制和焦点可能离开可见区域；正式 tablet/landscape 与 200% reflow 门禁失败。

绕行方式：降低浏览器 zoom 或使用更宽屏幕不是等价的无障碍绕行。

证据：[LOCAL-HQA-003-dashboard-overflow.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-003-dashboard-overflow.txt)

工程责任域：S06 design/CSS；教师页面 owner。

已确认事实：溢出属于 document/body；`src/components/pages/teacher-dashboard-page.tsx:434-435` 的表格内部虽有横滚容器，仍未约束根页面。

根因假设：外层 grid/card 的 min-content 约束可能让 `min-w-[820px]` 表格扩张根布局。该贡献尚未通过 computed-style offender 隔离，不能写成已证实根因。

### LOCAL-HQA-004 — 英文会话把中文教师看板标记为 `lang=en-US`

- 严重度：`S2 Medium`
- 状态：`OPEN` / 门禁 `FAIL`
- 影响角色：英语界面教师；屏幕阅读器用户
- 页面：英文可见登录 → `/dashboard`
- 运行身份：上述 branch/HEAD/origin
- 前置条件：在登录页通过可见语言控件选择 English，再通过可见表单登录教师
- 复现频率：`2/2`（初次进入与独立 reload/会话复核）

复现步骤：

1. 在登录页选择 English，确认 `html lang=en-US`。
2. 经可见表单登录教师并进入 `/dashboard`。
3. 检查最终 document lang、H1/主要文案语言与最近的局部 `lang` ancestor。
4. 在干净页面重复。

预期结果：看板显示英语，或中文区域显式声明 `lang=zh-CN`，使辅助技术使用正确语言规则。

实际结果：`html lang=en-US`；H1 和主要看板内容为中文；中文 subtree 没有局部 `lang=zh-CN`。

用户影响：英语界面在进入教师页后语言突然变化；辅助技术可能使用不匹配的发音规则。本轮 VoiceOver 受环境阻塞，因此没有把实际误读程度写成已证实事实。

绕行方式：登录前切回中文只能避免错误语言标注，不能提供英文教师界面。

证据：[LOCAL-HQA-004-dashboard-language.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-004-dashboard-language.txt)

工程责任域：S09 copy/i18n/accessibility；教师页面 owner。

已确认事实：root locale 会把 `<html lang>` 设为英语；教师 page 未接收 locale，页面与共享 Header 使用中文 copy。运行时观察与源码一致。

根因结论：教师看板缺少本地化或局部语言声明是已确认的直接原因；具体国际化方案留待实现设计。

### LOCAL-HQA-005 — 多个高频主控件低于约 44×44 CSS px 的验收门槛

- 严重度：`S2 Medium`
- 状态：`OPEN` / 门禁 `FAIL`
- 影响角色：触屏、低精细动作和运动障碍用户
- 页面：`/login`、`/learning`、`/dashboard`
- 运行身份：上述 branch/HEAD/origin；正式支持视口
- 前置条件：页面 ready；控件可见、启用；checkbox 采用关联 label 的有效点击区域
- 复现频率：`2/2`

复现步骤：

1. 在对应正式支持视口等待页面 ready。
2. 对可见、启用的 primary controls 读取 effective target bounding rect。
3. 使用 `width>=43.5 && height>=43.5` 的本轮约 44px 门槛判断。
4. 在独立 reload/会话重复；不纳入 inline 法律链接、隐藏 input 或 disabled controls。

预期结果：高频主控件的有效目标约不小于 44×44 CSS px。

实际结果：登录语言控件 99×40、密码显隐 36×36、学习上传 40×40、发送 40×40、教师退出 40×40；两轮一致。

用户影响：提高误触与漏触风险，影响手机与运动障碍用户完成高频操作。

绕行方式：系统缩放或辅助指针不是产品内等价修复；且教师 200% zoom 另有页面溢出问题。

证据：[LOCAL-HQA-005-touch-targets.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-005-touch-targets.txt)

工程责任域：S06 design/CSS；S09 accessibility。

已确认事实：以上均为实际运行 bounding rect；固定 `size-9`/`size-10` 源码与结果一致。

根因边界：本问题只声明未满足本轮计划的约 44px 产品门槛，不泛化为所有小元素不合规，也不在本报告中断言违反某一特定 WCAG 条款。

## 4. 已通过项

- 公开/认证：root redirect、匿名保护路由、双语切换、HTML lang、条款/隐私、密码显隐、空表单、错误密码、未同意协议、忘记密码空/无效邮箱、本地安全错误与键盘提交均通过；未发送邮件。
- 权限：学生访问 `/dashboard` 与 `/admin/users` 被拒；教师访问 `/admin/users` 被拒；退出后的学生 refresh、Back 与直达保护路由不能恢复工作台。
- 任务：全新学生任务状态、任务 1→任务 2 解锁、任务 2 练习 1–3、任务 2 完成后跳过 `pilot-closed` 任务 3 并自动进入任务 4、练习 4 和刷新持久化均通过。
- 文档：合成中文输入、快速连续编辑、H1/H2/H3 的视觉层级、粗体、斜体、列表、对齐、自动保存、刷新恢复、保存关闭、历史重开和二次编辑通过。原生 Markdown 实体落盘另列环境 blocker。
- 附件：安全 `.txt` 的读取、移除、重选和随消息发送通过；不支持扩展名与第 4 个小文件均显示安全拒绝；没有上传真实材料或创建大文件。
- AI 可见行为：普通文本、裸“教授/Professor”、`@小张` 与普通追问只显示小张；`@教授`/`@Professor` 的 waiting、busy、原位替换与单一 Professor 回复通过；A3/A4 不外露；刷新历史不重复。
- 教师看板：只显示唯一授权 cohort 的 1 名伪匿名学生；Phase/Agent/Event、刷新、组合筛选空态与分页禁用态通过；未写推荐状态。
- 教师导出：CSV/JSON 均产生真实 download event、HTTP 200、正确 MIME 且可解析；授权 learner 行数为 1；筛选写入 JSON；未发现邮箱、原始 prompt、文档/附件正文或认证材料。摘要见 [export-summary.txt](./evidence/20260825-aais-local-human-qa/export-summary.txt)。
- 响应式：登录与学习页在 `1440×900`、`390×844`、`375×812`、`812×375` 无 body 横向溢出；登录/学习真实 200% zoom 也通过。Reduced motion 匹配且可见动画 offender 为 0。
- 键盘/DOM：skip link、表单、协议 Space、任务卡、内容/编辑器切换、账户 menu Arrow/Home/End/Escape、教师筛选与下载均可用；一个具名 main/H1、status/alert/live/busy 语义通过自动检查。VoiceOver 未因此被标为 PASS。
- 控制台/网络：未观察 pageerror、unhandled error、业务 requestfailed 或 Next error overlay。401/404 均对应有意的认证/空会话测试；唯一 502 是授权 LRS flush。摘要见 [console-network-summary.txt](./evidence/20260825-aais-local-human-qa/console-network-summary.txt)。

## 5. 阻塞、观察与未运行项

以下均不分配 `LOCAL-HQA` 产品缺陷严重度：

1. `BLOCKED_ENVIRONMENT_NATIVE_FILE_PICKER`：学生 Markdown 与个人数据导出采用原生 OS 保存对话框；当前 Playwright DOM 表面不能安全选择实体路径。两次尝试均没有把自动化限制冒充兼容性缺陷。Markdown 实体文件名/MIME/非零字节/正文归属与个人导出实体 JSON 因此未通过。
2. `BLOCKED_VOICEOVER_TARGETING`：2/2 尝试中，macOS Accessibility 目标仍解析到另一 Chrome surface，而非本轮隔离 headed Chromium。为避免读取用户日常浏览器内容，立即停止；登录、学习与教师三页的实际听读 landmark、heading、live/status/busy 未验证。
3. `BLOCKED_EXTERNAL (BLOCKED_LRS_RECONCILIATION)`：单次 flush 后本地 attempt 为 `uncertain`；虽然 11/11 statement ID 逐个可读，当前计划没有 admin+CSRF reconciliation 权限，因此不能把本地 delivery 标为 acknowledged，也不能再次 dispatch。
4. `NOT_RUN_SAFETY`：主浏览器旅程冻结了 59 条学生 outbox，但全局 worker 同时可取 2 条教师候选。为避免超出“唯一学生 actor”的授权范围，没有 flush 这组数据。
5. `NOT_RUN_SAFETY`：学习数据删除、真实密码邮件、管理员账号变更、教师推荐状态写入均按计划不运行。

`OBS-001`：单次取消原生 Markdown picker 后，同一句通用失败同时出现在文档区与导学区。因为只有 1 次观察，未达到 2/2 门槛，不创建产品缺陷。证据：[OBS-001-native-picker-cancel.txt](./evidence/20260825-aais-local-human-qa/OBS-001-native-picker-cancel.txt)。

完整 blocker 边界与最小复测条件见 [blockers-summary.txt](./evidence/20260825-aais-local-human-qa/blockers-summary.txt)。

## 6. 外部 AI 摘要

| 项目 | 结果 |
| --- | --- |
| Provider/model | `qwen` / `qwen3.8-max` |
| 请求上限 | 实际 10 次，未超过计划上限 |
| Transport | 10/10 HTTP 200；10/10 `text/event-stream`；0 fallback；0 safe error |
| 生命周期 | 2 个完整深度 capture 均为 accepted → agent-start → agent-done → done；10 个 UI 请求均完成 |
| 可见响应者 | 7 次 A1、小张；3 次 A2、Professor；A3/A4 可见泄漏为 0 |
| A2 busy | 3 次均先出现 thinking，composer 禁用，最终原位替换，无永久 busy |
| 历史 | 完整问答各出现一次；无空白、重复或刷新后重复 |
| 代表性等待 | 主运行 A1 约 1.3–1.5 秒；A2 约 6.5–6.7 秒 |
| 教学状态 | `FAIL`：10/10 请求的 `helpRequestsUsed` 为 0，见 `LOCAL-HQA-001` |
| 数据保留 | 未保留完整 prompt、完整模型输出或 Provider credential |

真实 Provider/SSE transport 的 `PASS` 与 A1 pedagogical state 的 `FAIL` 是两个独立结论。回复成功不能清除支架计数失败；本地结果也不能扩大为 Preview 或生产 AI 已通过。脱敏明细见 [ai-lifecycle-summary.txt](./evidence/20260825-aais-local-human-qa/ai-lifecycle-summary.txt)。

## 7. 外部 LRS 精确对账

### 7.1 零基线

浏览器写入前，用独立 pseudonym key 推导唯一 actor 并执行 GET-only 查询：HTTP 200，xAPI response header `1.0.3`，actor statement count 为 0。该零基线使后续逐 ID 记录可归属于本轮伪匿名测试。

### 7.2 主浏览器集合未写入

主浏览器旅程产生 84 个学生语义事件与 59 个学生物理 outbox 行；合并事件的 semantic-weight 差为 0。但 worker candidate 中另有 2 个教师事件。由于现有 flush 是全局 worker、不能按 actor 过滤，本轮对该集合执行 0 次 flush，状态为 `NOT_RUN_SAFETY`。这 59+2 行不与后续 11 行相加，也不声称发生外部写入。

### 7.3 授权单学生集合与唯一一次 flush

为满足用户授权边界，另建 fresh PostgreSQL/Next 与新浏览器会话，只登录同一合成学生，不进入教师 UI。该子运行产生 12 个语义事件和 11 个物理 outbox 行；2 个 `artifact_saved` 在 30 秒窗口合并为 1 个物理行，semantic-weight 差为 0；foreign candidate 为 0。

对这 11 行只调用一次 `flush?limit=12`：worker 返回 HTTP 502，安全投影为 sent 0、failed 11、deferred 0、stopped `drained`、hasMore false。数据库随后有 1 个 `uncertain` attempt、11 个完整 ledger row 和 11 个 `sending`/claimed outbox；ledger ID/SHA/冻结投影内部一致。没有第二次 flush、requeue、手工 POST 或管理员 reconciliation。

### 7.4 GET-only 读回结果

| 对账项 | 结果 |
| --- | --- |
| 预期 statement ID | 11 |
| 逐 ID GET | 11×HTTP 200；404=0；other=0 |
| 已确认永久外部记录 | 11 条本轮伪匿名 statement |
| 本地 attempt | 1×`uncertain`；0×`acknowledged` |
| Immutable projection | 11/11 匹配；mismatch=0 |
| Client timestamp instant | 11/11 匹配；mismatch=0 |
| Actor | 逐 ID actor mismatch=0 |
| `stored` / `authority` | violation=0 |
| HTTP xAPI version header | violation=0 |
| Statement version/managed additions | 11/11 未通过；statement version violation=11，provider addition violation=11 |
| Actor collection query | 60 秒内 consistent observed=0；expected=11；missing=11；extra=0 |
| Consistent full set equality | `BLOCKED` |
| Marker privacy scan | 本地冻结体和 11 个逐 ID响应均 0 hit；actor 全量集合未完成，因此总体 privacy status 仍为 `BLOCKED` |
| 顶层状态 | `BLOCKED_LRS_RECONCILIATION` |

精确边界是：11 个 ID 已被 LRS 接收且逐个内容投影匹配，但 LRS 的 actor 集合索引未在 60 秒窗口收敛，返回 Statement 也没有满足本探针的 xAPI managed-field/version 合同；同时应用数据库没有 acknowledged 状态。由此不能给出端到端 `PASS`，也不能将 HTTP 502 解释为“外部没有写入”。

永久证据只保留计数、集合摘要、状态和隐私布尔断言，不保存 actor、statement/claim ID、完整 body、authority、endpoint 或凭据。详见 [lrs-reconciliation-summary.txt](./evidence/20260825-aais-local-human-qa/lrs-reconciliation-summary.txt)。

## 8. 总体结论、证据索引与最小复测条件

总体结论：`NO_GO`

理由：

1. `LOCAL-HQA-001` 是 S1：核心 Cognitive Apprenticeship 的四次直接支架与第五次 fading 状态不可到达。
2. `LOCAL-HQA-002` 是 S1：教师可见退出没有撤销服务器会话，共享设备访问保证失败。
3. `LOCAL-HQA-003`、`004`、`005` 是三个独立 S2，分别影响 tablet/zoom reflow、语言语义与触控可达性。
4. LRS 已形成 11 条长期外部副作用，却保持本地 `uncertain`；actor 全量一致性与 version 门禁均未闭环。未经新授权不得重发这一 frozen set。

最小复测条件：

- `LOCAL-HQA-001`：在两个全新学生会话各执行 5 次同任务帮助请求，验证状态单调推进、前四次直接支架与第五次 fading。
- `LOCAL-HQA-002`：在两个新教师会话验证可见退出调用撤销；refresh、Back、旧页与直达 `/dashboard` 均不能恢复权限。
- `LOCAL-HQA-003`：`812×375` 与真实 200% zoom 的 document/body overflow 均 `<=1px`，表格横滚只存在内层容器。
- `LOCAL-HQA-004`：英语教师看板完成本地化，或中文 subtree 正确声明 `lang=zh-CN`。
- `LOCAL-HQA-005`：列出的 primary targets 实测达到 `>=43.5×43.5 CSS px`。
- 原生文件：在可控制前台 OS 保存对话框的 headed Chrome 中完成 Markdown 与个人导出实体文件 2/2 校验。
- VoiceOver：先由 VO+F1 确认目标为隔离 Chromium，再走查登录、学习与教师三页；DOM 证据不能替代。
- LRS：不得重发现有 11 条记录。若要对原 frozen set 做无重发 reconciliation，必须在清空废纸篓前另获明确授权并恢复本轮精确隔离数据库；若数据库被永久清空，只能保留本次 blocker，未来新写入不得冒充对本次不确定交付的对账。

证据索引：

- [run-baseline.txt](./evidence/20260825-aais-local-human-qa/run-baseline.txt)
- [LOCAL-HQA-001-a1-help-counter.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-001-a1-help-counter.txt)
- [LOCAL-HQA-002-teacher-logout-session.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-002-teacher-logout-session.txt)
- [LOCAL-HQA-003-dashboard-overflow.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-003-dashboard-overflow.txt)
- [LOCAL-HQA-004-dashboard-language.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-004-dashboard-language.txt)
- [LOCAL-HQA-005-touch-targets.txt](./evidence/20260825-aais-local-human-qa/LOCAL-HQA-005-touch-targets.txt)
- [OBS-001-native-picker-cancel.txt](./evidence/20260825-aais-local-human-qa/OBS-001-native-picker-cancel.txt)
- [ai-lifecycle-summary.txt](./evidence/20260825-aais-local-human-qa/ai-lifecycle-summary.txt)
- [lrs-reconciliation-summary.txt](./evidence/20260825-aais-local-human-qa/lrs-reconciliation-summary.txt)
- [export-summary.txt](./evidence/20260825-aais-local-human-qa/export-summary.txt)
- [console-network-summary.txt](./evidence/20260825-aais-local-human-qa/console-network-summary.txt)
- [blockers-summary.txt](./evidence/20260825-aais-local-human-qa/blockers-summary.txt)
- [SHA256SUMS.txt](./evidence/20260825-aais-local-human-qa/SHA256SUMS.txt)

所有永久证据均为最小脱敏 TXT；原始 trace、snapshot、下载、浏览器 profile、数据库目录、prompt/response 和完整 xAPI body 不纳入交付，已从 workspace 移入可恢复的 macOS 废纸篓。未修改任何产品代码、API、类型、migration、配置或测试文件。
