# AAIS 独立候选发布与待批准的 Vercel 变更

状态：本地准备，不代表 GitHub/GHCR/ECS/Vercel 发布或 Owner 验收。

## A. GHCR 注册包（仅默认分支工作流注册）

`deploy/aliyun/ghcr-registration.patch` 基于
`main@caac8f3fd8fc90749eb08cf0ddb517a5d19b1eda`，仅包含：

- `.github/workflows/ghcr-container.yml`；
- `scripts/verify-aais-ghcr-source.mjs`；
- `vercel.json` 中关闭精确候选分支自动部署的一项配置。

不得将整个应用候选合并到 main 来注册工作流。注册包不改变原有 Vercel
build command、区域、cron、运行环境或应用源码。GitHub 要求
workflow_dispatch 工作流存在于默认分支，之后才能从指定分支手动运行。
将注册包合入 main 本身仍可能触发 Vercel 对原应用的重新部署；实际提交前需
单独核对 provider 的忽略构建策略并获得发布授权。本轮不合并、不推送。

## B. 独立 Aliyun 应用候选（不得合入 main）

- 唯一分支：`codex/aais-aliyun-postgres-empty`。
- 唯一仓库：`HUDongpin/AAIS`。
- 仅 `workflow_dispatch`，无 push 发布触发；`expected_sha` 必须为完整 40 位 SHA，
  与事件 SHA 和实际 checkout HEAD 三者相同，main、其他分支、tag、PR 均拒绝。
  还要求 GitHub 的 `GITHUB_REF_PROTECTED=true`；未保护分支直接拒绝。
- 两个 job 都验证来源；测试 job 无包或云写权限。发布 job 保留
  `aliyun-production` 环境，以及最小 packages/attestations/OIDC 权限。
- Provider 侧还必须配置该精确分支的保护、必需审核人与禁止自批、环境 deployment
  branch allowlist，并验证不可绕过。YAML 中的 environment 名称不证明这些保护存在。
- `vercel.json` 禁止该分支自动部署，且候选专用 build guard 拒绝全部 Vercel 构建，
  包括 CLI 或意外合入 main。不要为构建镜像而降低 Vercel 保护。
- SHA/digest、私有包、SBOM、provenance、凭据清理与 ECS 收据验证保持独立。

## C. Vercel 热备变更（只保留，不激活）

原候选的 Vercel 区域、两分钟 cron、生产数据库/worker 门禁及其测试保存在
`deploy/vercel/warm-backup-deferred.patch`。它针对上述 main 基线，需在独立分支
另行审查。当前候选不使用其中的区域/cron/生产 guard。共享应用模块仍包含
此前的双平台支持，因此整个 Aliyun 候选仍不可视为 Vercel 可发布代码。

自托管空 PostgreSQL 不向旧 Neon 同步数据，不能把这份旧热备方案直接用作
新数据库的故障切换。Vercel 后续上线还需要单独决定数据库及数据一致性方案。

## D. Owner 启动器：安全封堵已加入，功能接通仍阻塞

现有 ECS 脚本只检查 TTY，无法从 SSH 服务端证明本地 macOS Terminal.app
的完整启动来源。AAIS 专用受审计 Owner 启动器及其验证契约尚未提供。
在此之前 `aais-preload-ghcr-image.sh` 的主入口无条件返回
`BLOCKED_AAIS_AUDITED_OWNER_LAUNCHER_BINDING_MISSING`，发生在读取配置、
进入凭据提示、创建 credential 目录、登录或拉取镜像之前。

这不是已经实现的 ancestry 验证，不是可部署的凭据流程。不得添加 unsigned
receipt、环境变量 allow flag、TTY 伪装或跨项目启动器替代。只有取得精确
AAIS 启动器并完成审查、绑定和非敏感拒绝测试后，才能另行替换此拒绝门。
Codex 不启动该凭据流程、不读取或输入凭据。

## E. 验证边界

- `tests/run-aliyun-postgres-migration-integration.mjs` 只接受 `/tmp/aais-pg-review-*`
  下新建的 Unix-socket-only 临时 cluster；检查 server data_directory 后才创建测试库。
  覆盖缺失 CREATE 的反例、29 个真实迁移、29 个重跑校验、关窗权限撤销和应用无 DDL。
- 本机现有 PostgreSQL 为 16.15，该实测不是 PostgreSQL 17 的同版本证明。
- `tests/aliyun-postgres-cold-start.sh` 在 Linux 临时目录中执行两次新建 tmpfiles，
  检查遍历 ACL、bootstrap 后保留 ACL，以及数据库身份无法读取 secret generation。
  此测试已接入无发布权限的 product-gates，未用重启生产 ECS 代替测试。
- 原 awk 修复和 parser 回归测试必须随本批纳入，不能仅引用原始候选 SHA。

2026-09-06 本地复核：lint、TypeScript、生产构建通过；完整测试运行
1687 通过、9 跳过，之后新增的注册包一致性测试所在两文件 14/14 通过。
测试数量减少主要因为 Vercel 热备 guard 及其测试已移入待批准补丁，当前
保留原 main 的 guard 测试；不是删掉失败断言来降低同一发布路径的要求。
`fast-uri` 从 3.1.5 更新为 3.1.7，npm audit 为零漏洞，依赖清单验证通过。
两份补丁均在干净 main 基线上通过 `git apply --check`，未实际应用到 main。
本机 Docker 查询超时，Linux cold-start 与 PostgreSQL 17 同版本验证未完成。

官方依据：
[GitHub 手动工作流与默认分支要求](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、
[Vercel 精确分支部署开关](https://vercel.com/docs/project-configuration/git-configuration)。
