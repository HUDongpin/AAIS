# AAIS Teacher Recommendation Rules

AAIS recommendations are deterministic, rule-based follow-ups generated from pseudonymous cohort analytics. They are not model-generated diagnoses and do not include raw learner artifacts, guide messages, or self-report text.

The current policy version is `aais-rule-recommendations-v1`. Teacher and admin users may record an override decision for any recommendation; overrides are stored as redacted `recommendation_override_recorded` events.

The queue is enabled by default. Set `AAIS_RECOMMENDATIONS_ENABLED=false` in an environment to pause the recommendation queue while leaving cohort analytics and exports available.

## Rules

| Rule id | Trigger | Teacher action | Priority |
| --- | --- | --- | --- |
| `complete_training` | The learner has not completed the training task. | Arrange training-task completion before continuing practice. | High |
| `complete_reflection` | Reflection evidence is missing because self-report or expert-trace comparison evidence is absent. | Ask the learner to add an explanation of their process and compare it with the expert trace. | Medium to high |
| `respond_to_coaching` | A2/A3 coaching signals exist, but no later AI interaction or acceptance decision is present. | Follow up on the coaching cue and ask for the learner's next step. | Medium to high |
| `fade_scaffold` | Scaffold requests reach the high-dependency threshold. | Shift from direct help to self-check prompts and ask for the learner's reasoning. | High |
| `advance_practice` | Training is complete, risk is low, and reflection evidence is present. | Keep the learner moving to the next practice task with light monitoring. | Low |

## Interpretation Guardrails

- Use the recommendation as an action queue, not as a final judgment about the learner.
- Check the learner's actual work before high-impact intervention.
- Prefer `deferred` when the teacher needs more evidence before acting.
- Do not copy recommendation payloads into external systems with raw student identifiers; AAIS exposes `learner-*` and `session-*` pseudonymous keys for cohort workflows.
