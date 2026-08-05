# Event-driven brain — design direction

Status: decided direction, not yet implemented. Tracked as follow-up work after the
npm-install PR lands.

## Goal

Silky use of the brain in **mindmux or any LLM TUI**: sessions read the brain
automatically, and the brain updates automatically as features are built or ideas
surface — without the user remembering, and without relying on model discipline.

## Core decision

**brain.md never embeds an LLM provider configuration. It stays zero-dependency.**
Wherever model judgement is needed (generate, judge, synthesize), the model is
supplied by the environment:

- inside a TUI session → the TUI's own model
- inside mindmux → mindmux's model (it is a first-class runtime and already
  understands `brainRoot`)
- in CI / unattended → the ambient agent CLI (`kimi -p …`, `claude -p …`, …)

The environment supplies the model and the trigger; brain.md supplies the contract,
the data format, and the CLI.

## What we borrow from OpenWiki (and what we don't)

LangChain's OpenWiki (2026-07) proved the "docs that stay in sync with code" loop:
a **watermark** (the commit of the last sync) + **git diff** + a **scheduled CI
reconciliation** that updates affected docs. It pays for standalone operation by
embedding a provider config and a DeepAgents dependency.

brain.md borrows the mechanism, not the dependency: same watermark + diff + schedule,
but the reconciliation is executed by whatever agent the environment provides.

## Trigger model

**Read paths**

- TUI: a SessionStart hook injects a compact `brain list-pages` index into context.
- mindmux: injects natively at session bootstrap (brainRoot-aware).
- Everywhere else: the wired `AGENTS.md` / `CLAUDE.md` block remains the
  zero-integration fallback (L0) — any agent that reads its config file and can run
  shell commands can use the brain.

**Write triggers** (capture is event-driven, not discipline-driven)

1. **In-session, immediate** — the wire-block contract already requires capturing a
   decision the moment it settles; the in-session model judges what is durable.
2. **Session end** — a Stop/SessionEnd hook runs a synthesis pass: anything durable
   that slipped through gets captured before the session closes.
3. **post-commit hook** — a commit means a feature actually landed; the ambient
   agent takes the diff and updates affected pages (new `decision` page, refresh
   `architecture` / `flow` / `mindmap` roots).
4. **Scheduled `brain sync`** — watermark + git diff since last sync, run by an
   agent CLI in CI (OpenWiki-style loop, environment-supplied model).

## Scope guard

The brain stores **durable decisions** — the *why* that can't be reconstructed from
code. It does not try to be a full descriptive wiki of *what is where* (that is
OpenWiki / DeepWiki territory). Few, dense pages keep sync diffs small and cheap —
an advantage, not a limitation.
