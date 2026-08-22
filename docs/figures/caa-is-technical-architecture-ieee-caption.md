# CAAIS technical architecture figure

**Suggested IEEE caption.** Technical architecture of CAAIS. Solid arrows denote
implemented runtime control and data flows; dashed arrows denote pedagogical
handoff semantics recorded in orchestration trace metadata rather than executable
LangGraph dependencies. A1 and A2 are learner-facing agents served through the
governed model-provider boundary, whereas A3 and A4 currently execute as
deterministic background agents. Learning exchanges and agent-attributed evidence
are persisted through the CAAIS learning store and asynchronously mirrored to an
optional external LRS.

**Abbreviations.** CA: Cognitive Apprenticeship; CAAIS: Cognitive Apprenticeship
AI System; CSRF: Cross-Site Request Forgery; LRS: Learning Record Store; SSE:
Server-Sent Events; xAPI: Experience API.

**Publication master.** The SVG is sized for the IEEE two-column width
(7.16 in × 5 in). Use the PDF for paper submission and the 600 dpi PNG for
review systems that require a raster preview.
