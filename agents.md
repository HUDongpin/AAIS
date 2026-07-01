# AAIS Agents

AAIS is a focused Cognitive Apprenticeship learning system. This project keeps the useful UAIS coordination pattern, but removes UAIS-only teaching workspace, course plaza, chatroom mock-agent, and course-management roles.

## Product Agents

| Agent | Name | Scope | Notes |
| --- | --- | --- | --- |
| `A1` | 导学智能体 | Expert demonstration, checks for understanding, task release | Used in training and practice. |
| `A2` | 监督智能体 | Behavior monitoring, low-interruption coaching, data packaging for A3 | Used throughout the task process. |
| `A3` | 反思智能体 | Articulation prompts, student trace, expert trace comparison, self-report | Used after and during key task moments. |
| `A4` | 支架智能体 | Metacognitive toolkit with per-task request limits | Practice stage only. Helps thinking, not answers. |

## Engineering Roles Kept From UAIS

| Session | Owner/role | AAIS scope | Allowed files/modules | Forbidden files/modules |
| --- | --- | --- | --- | --- |
| `S01` | App shell lead | Root layout, redirect, header, app shell | `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/layout/`, shell CSS | Page-specific workflows, product data contracts |
| `S03` | Learner workspace lead | `/learning`, Cognitive Apprenticeship learning cockpit | `src/app/learning/`, `src/components/pages/learning-page.tsx`, learning sections in `src/data/aais.ts` | Login/auth internals, provider behavior without S07 |
| `S06` | Design system and CSS lead | Global CSS variables, Tailwind usage, responsive polish | `src/app/globals.css`, design-only edits in shared components | Product data semantics, provider logic |
| `S07` | AI agent model lead | A1-A4 definitions, LangGraph orchestration, provider boundary | `src/data/aais.ts`, `src/lib/ai/`, `src/app/api/learning/ai-guide/` | Real secret files, UI rewrites without S03/S06 |
| `S08` | Data contract lead | Event schema, training/practice task data, export invariants | `src/data/aais.ts`, data-contract tests | Page rewrites outside direct integration needs |
| `S09` | Copy, i18n, accessibility lead | Chinese/English terminology, labels, aria text | Copy-only edits in `src/components/` and future i18n files | Business logic and provider behavior |
| `S10` | Tooling, docs, report lead | Project docs and config | `README.md`, `agents.md`, package/config files | Feature implementation unless assigned |
| `S11` | QA and release quality lead | Vitest, browser smoke, release evidence | `tests/`, QA reports if added | Feature implementation unless assigned |
| `S12` | Backend/API platform lead | Auth route, export route, future storage adapters | `src/app/api/`, `src/lib/server/` if added | UI feature work without owning-session coordination |
| `S16` | Research and pedagogy lead | Cognitive Apprenticeship rationale and evaluation notes | Future `docs/` or research notes | Unverified latest-research claims without dated sources |
| `S22` | Production reliability and release engineering lead | Local build/dev server, parity checks, release blockers | Build/deploy config and release reports | Feature bug fixes unless assigned |

## Secret Handling

- `All API Keys.docx` may exist locally in this AAIS folder for owner-approved provider work.
- Never print, summarize, commit, stage, screenshot, or log real credentials.
- Prefer environment variables for runtime provider access.
- If a live provider is unavailable, keep deterministic local LangGraph behavior so AAIS remains runnable.
