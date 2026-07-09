# AAIS Client Async-Action Audit

Status date: 2026-07-09 HKT

Scope: user-visible client async paths under `src/components/pages`. Inventory source:
`rg -n "async |await |fetch\\(|FileReader|createObjectURL|navigator\\.|window\\.localStorage|setTimeout|ReadableStream" src/components/pages --glob '*.tsx' --glob '*.ts'`

## Result

Every inventoried user-facing async action now has one of:

- visible busy or progress text via `role="status"` and/or button text
- error feedback via `role="alert"` or a route-specific fallback message
- duplicate/overlap prevention through disabled controls, state guards, or ref guards where same-tick duplicate submission was possible
- focused source tests and/or Playwright coverage

Manual screen-reader spot checking remains separate and is not closed by this audit.

## Inventory

| Surface | Async path | User-visible state | Evidence |
| --- | --- | --- | --- |
| Login | Account authentication | `登录中...`, form `aria-busy`, validation/server alerts, ref duplicate guard | `src/components/pages/login-page.tsx`; `tests/login-page.test.tsx`; `tests/e2e/login-learning.spec.ts`; `tests/e2e/login-failure.spec.ts` |
| Login | Invite/reset-token password save | `保存中...`, form `aria-busy`, success status, error alert, ref duplicate guard | `src/components/pages/login-page.tsx`; `tests/login-page.test.tsx` |
| Login | Password reset request | `发送中...`, form `aria-busy`, non-enumerating success status, error alert, ref duplicate guard | `src/components/pages/login-page.tsx`; `tests/login-page.test.tsx` |
| Learning | Initial session load | Backend-unavailable alert while preserving local input | `src/components/pages/learning-page.tsx`; `tests/learning-page.test.tsx` |
| Learning | AI guide request | Pending assistant message, `智能导学处理中...`, panel `aria-busy`, alerts, disabled composer controls | `src/components/pages/learning/use-learning-guide.ts`; `src/components/pages/learning/guide-panel.tsx`; `tests/learning-page.test.tsx`; `tests/learning-components.test.tsx`; `tests/e2e/ai-guide.spec.ts` |
| Learning | Guide file attachment read | `文件正在读取...`, panel `aria-busy`, disabled upload/send/remove/quick-start controls, read errors | `src/components/pages/learning/use-learning-guide.ts`; `src/components/pages/learning/guide-panel.tsx`; `tests/learning-page.test.tsx`; `tests/learning-components.test.tsx` |
| Learning | Artifact autosave | Pending/saving/saved status, document panel `aria-busy`, backend error alert | `src/components/pages/learning-page.tsx`; `src/components/pages/learning/content-side-panel.tsx`; `tests/learning-page.test.tsx` |
| Learning | Local Markdown download | `正在准备下载...`, `下载中...`, document panel `aria-busy`, download error alert, duplicate download prevention | `src/components/pages/learning-page.tsx`; `src/components/pages/learning/content-side-panel.tsx`; `tests/learning-page.test.tsx` |
| Learning | Learner data export | `正在导出学习数据...`, account menu `aria-busy`, disabled overlapping account actions, error alert | `src/components/pages/learning-page.tsx`; `src/components/pages/learning/learning-top-bar.tsx`; `tests/learning-page.test.tsx`; `tests/learning-components.test.tsx` |
| Learning | Learner data deletion | Confirm gate, `正在删除学习数据...`, account menu `aria-busy`, disabled overlapping account actions, error alert | `src/components/pages/learning-page.tsx`; `src/components/pages/learning/learning-top-bar.tsx`; `tests/learning-page.test.tsx`; `tests/learning-components.test.tsx` |
| Learning | Logout/session revoke | `正在退出...`, account menu `aria-busy`, disabled overlapping account actions, redirect fallback if revoke fails | `src/components/pages/learning-page.tsx`; `src/components/pages/learning/learning-top-bar.tsx`; `tests/learning-page.test.tsx`; `tests/learning-components.test.tsx` |
| Teacher dashboard | Cohort load, filter, refresh, pagination | Loading status, main `aria-busy`, disabled refresh/export/pagination while loading, authorization alert | `src/components/pages/teacher-dashboard-page.tsx`; `tests/teacher-dashboard-page.test.tsx`; `tests/e2e/dashboard-access.spec.ts` |
| Teacher dashboard | Cohort CSV/JSON export | Format-specific progress/status, main `aria-busy`, disabled duplicate export buttons, failure status | `src/components/pages/teacher-dashboard-page.tsx`; `tests/teacher-dashboard-page.test.tsx`; `tests/e2e/core-accessibility.spec.ts` |
| Teacher dashboard | Recommendation override | `正在记录推荐处理...`, card/main `aria-busy`, disabled duplicate override, success/failure status | `src/components/pages/teacher-dashboard-page.tsx`; `tests/teacher-dashboard-page.test.tsx` |
| Admin users | User list load | `Loading accounts`, main/table `aria-busy`, alert on load error | `src/components/pages/admin-users-page.tsx`; `tests/admin-users-page.test.tsx` |
| Admin users | Invite user | `Creating invite...`, `Inviting`, form/main `aria-busy`, validation/error alert, ref duplicate guard | `src/components/pages/admin-users-page.tsx`; `tests/admin-users-page.test.tsx` |
| Admin users | Access update | `Saving access...`, row buttons/selects disabled, main/table `aria-busy`, error alert | `src/components/pages/admin-users-page.tsx`; `tests/admin-users-page.test.tsx` |
| Admin users | Password reset | `Password reset request in progress.`, row buttons/selects disabled, main/table `aria-busy`, error alert | `src/components/pages/admin-users-page.tsx`; `tests/admin-users-page.test.tsx` |
