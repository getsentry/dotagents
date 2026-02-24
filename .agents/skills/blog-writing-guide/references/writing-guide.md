---
title: Sentry Blog Writing Guide — Full Reference
description: Detailed examples, post templates, and complete writer/editor checklists referenced by the Sentry Blog Writing Skill.
---

# Sentry Blog Writing Guide (Full)

This document contains the detailed examples, full post templates, and the complete writer/editor checklists referenced by `../SKILL.md`. Use this as the working reference while drafting or reviewing.

## Detailed Examples

### Openings (Good vs. Bad)

Good (problem-first):
- "Two weeks before launch, we killed our entire metrics product. Pre-aggregating time-series metrics hid the debugging context we needed. Here’s what broke and how we rebuilt it."

Good (conclusion-first):
- "Sampling error events increased p99 ingestion latency by 7.5×. We fixed it by moving the HOT partition to a separate tier and rewriting our batcher."

Bad (corporate/hype):
- "We're thrilled to announce exciting updates to our platform that will empower developers to build best-in-class experiences."

Why good works:
- It states something specific, the reader immediately knows why to care, and it promises concrete detail.

### Headings (Informative vs. Vague)

Vague:
- "Background"
- "Architecture"
- "Results"

Informative:
- "Why pre-aggregating time‑series destroys debugging context"
- "Scatter‑gather for distributed GROUP BY without blowing the heap"
- "Where this fails: the cardinality wall at 10M series"

### Closings (Useful vs. Empty)

Useful:
- "Try it: enable Metrics 2.0 in Settings → Projects → Metrics. Docs: [link]. We want feedback on high‑cardinality edge cases — open a GitHub issue or ping us on Discord."

Empty:
- "We can't wait to see what you build!"

## Post Templates

Use these as scaffolds. Replace bracketed prompts with specifics. Keep paragraphs short and dense; prefer subheadings and lists to long prose.

### 1) Engineering Deep Dive

- Title: [Specific claim or question your post answers]
- Opening (2–3 sentences):
  - [State the problem or the conclusion up front. Include one concrete number or constraint.]
- Why the obvious approach failed
  - [Show what you tried and why it didn’t work. Include data, logs, or resource limits.]
- The approach that worked
  - [Explain the core idea. Include diagrams if >2 components interact.]
  - [Key trade‑offs and why you accepted them.]
- Implementation details
  - [Algorithms, data structures, failure modes, backpressure, retries, consistency model.]
  - [Code snippets that run — include imports and configuration.]
- Results
  - [Numbers with baselines: p50/p95/p99, CPU/heap/IO; before vs. after.]
- Limitations and follow‑ups
  - [Where it breaks, what you left out, what’s next.]
- How to use/try it
  - [Links to docs, flags, minimal example. CTA for feedback.]

### 2) Product Launch

- Title: [What shipped] that [solves X] for [who]
- Opening (2–3 sentences):
  - [What shipped, why it matters, one crisp payoff or number.]
- What problem this solves
  - [Pain the reader has. Avoid marketing adjectives; use concrete scenarios.]
- How it works (at a technical level)
  - [System overview; include one diagram or sequence if helpful.]
- How to try it today
  - [Steps, prerequisites, feature flags, pricing/limits if relevant.]
- Tips and gotchas
  - [Known limitations, performance notes, migration caveats.]
- CTA
  - [Docs link, quickstart repo, feedback channel.]

### 3) Postmortem

- Title: [Incident] — what failed, why, and what we changed
- Summary (5 bullets max):
  - Impact, duration, user scope, core root cause, key fix.
- Timeline
  - [Timestamps and facts. Keep blame‑free and specific.]
- Technical root cause
  - [Mechanism, not labels. What failed in the system and how.]
- What went well / what didn’t
  - [Detection, escalation, mitigations.]
- Fixes and prevention
  - [Immediate remediation and durable changes; owners and timelines.]
- Appendix
  - [Diagrams, logs, graphs.]

### 4) Tutorial / Guide

- Title: How to [achieve X] with [tool/feature]
- Who this is for
  - [Target reader; prerequisites.]
- The shortest path to success
  - [Numbered steps; copy‑paste‑able commands; screenshots/diagrams where helpful.]
- Why this works
  - [Brief explanation to build intuition; link to deeper docs.]
- Common pitfalls
  - [3–5 gotchas with fixes.]
- Next steps
  - [Extend, optimize, deploy; links.]

## Complete Checklists

Use these in order when drafting and reviewing.

### Writer Checklist (before sending for review)

- Opening states problem or conclusion within 2–3 sentences
- Headings convey information (no "Background/Conclusion" headings)
- All technical claims have numbers or evidence
- Code samples compile/run as written (imports, config, versions included)
- If >2 components interact, include a diagram with real service names
- Honest about limitations and trade‑offs; no hype language
- Clear "who this is for" and how they benefit
- Title is specific and compelling
- Links to docs/getting‑started are included

### Technical Review Checklist

- Technical claims are accurate and bounded (units, baselines, p50/p95/p99)
- Code samples are correct, minimal, and match current APIs
- Architecture descriptions match reality (names, data flow, failure modes)
- Benchmarks and graphs are reproducible or linked to sources
- Known limitations and failure cases are stated plainly
- Security/privacy implications considered where relevant

### Editorial Review Checklist

- Opening hooks the reader and sets stakes quickly
- Headings tell a story; paragraphs are short; lists used where helpful
- Banned language removed (excited/thrilled, best‑in‑class, seamless, leverage, empower, robust, etc.)
- "Would I share this?" test passes
- Tone matches Sentry voice: opinionated, specific, a little irreverent
- Title communicates a concrete payoff or claim

### Final Publishing Checklist

- Real author byline (no "The Sentry Team")
- All links work; images have alt text; diagrams render at blog width
- Docs/quickstart links present; repo examples build
- Post doesn’t duplicate the changelog; changelog‑worthy items moved there
- Date, tags, and metadata set correctly

---

When in doubt, go deeper and show your work. The fastest way to improve a draft is to replace generalities with specifics: logs, graphs, numbers, real service names, and code that runs.

