# Octopus Prime — A Theory

> Status: theory / design sketch. No code here is binding; this document exists
> to argue for a shape, not to specify an implementation.

## 1. The premise

Caretta today is a single self-steering autopilot. On every invocation it reads
the repository's pulse, picks one route (`work` or `factory`), and runs it
inline. The whole organism is one arm: it observes, decides, and acts in a
single straight-line pass through `runAutopilot`
(`src/application/run-autopilot.ts`).

**Octopus Prime** asks a different question: what if the *deciding* and the
*acting* were pulled apart into two different kinds of thing?

- **Eight tentacles** — narrow, reflexive effectors. Each one does exactly one
  bounded job against the repository and nothing else.
- **One nervous system** — an intelligent scheduler that holds the world-model,
  decides which tentacle to fire and when, and sequences their work.

The design constraint the name encodes: **each tentacle is impotent.** A
tentacle cannot decide to act on its own, cannot schedule itself, cannot summon
another tentacle, and keeps no memory between actuations. All intelligence —
all *potency* — lives in the nervous system. This deliberately inverts real
octopus biology (where most neurons live in the arms); Octopus Prime
centralizes cognition and leaves the limbs as reflex arcs.

Why bother? Three payoffs:

1. **Testability.** An impotent tentacle is a pure-ish function: signal in,
   observation out. No hidden scheduling, no cross-talk.
2. **Composability.** Eight small effectors recombine into behaviors the
   monolithic pass can't express (e.g. "review three PRs, then hold").
3. **Backpressure as a first-class concept.** The CI-hold logic that's
   currently tangled into the linear pass becomes the scheduler's whole job.

## 2. Mapping the metaphor onto what already exists

The good news: Caretta is *already* decomposed into the right organs. The eight
tentacles are not new capabilities — they are the concerns that
`runAutopilot` currently calls in sequence, promoted to first-class,
independently-actuated effectors. The current code does each of these as a
hardcoded step:

| Existing concern (file)                              | Becomes tentacle |
| ---------------------------------------------------- | ---------------- |
| `gh.listOpenIssues` / `listOpenPullRequests`         | T1 · **Sense**   |
| `closeIssuesForMergedPrs` (`close-on-merge.ts`)      | T2 · **Reap**    |
| `resolveDirtyAgentPRs` (`conflict-resolver.ts`)      | T3 · **Mend**    |
| `reviewAndFixAgentPRs` (`execute-autopilot.ts`)      | T4 · **Critique**|
| `domain.evaluate` / `findActiveSprint` (`evaluate.ts`)| T5 · **Appraise**|
| `processAgentPRs` (`pr-ci.ts`, `ci-dispatcher.ts`)   | T6 · **Gate**    |
| `executeAutopilot` (`work`/`factory` child actions)  | T7 · **Work**    |
| `domain.decideTrigger` (`trigger.ts`)                | T8 · **Reflex**  |

The nervous system is the elevated descendant of `AutopilotUseCase` and
`AutopilotDomainLogic` (`src/domain/autopilot-domain.ts`): the policy objects
(`TriggerPolicy`, `EvaluationPolicy`, `ExecutionDecisionPolicy`,
`SummaryPolicy`) are exactly the kind of pure decision logic that belongs in a
brain, not a limb. Octopus Prime's thesis is that those policies should *drive*
the tentacles rather than be buried in a fixed call order.

## 3. The eight tentacles

Each tentacle is defined by a job, an actuation signal, and a returned
observation. None of them decides whether it *should* run — that is always the
nervous system's call.

1. **T1 · Sense** — fetch open issues and PRs; return the raw repo state. The
   only tentacle the scheduler fires unconditionally at the start of a pass.
2. **T2 · Reap** — close issues whose PRs merged. Idempotent: closing an
   already-closed issue is a no-op observation.
3. **T3 · Mend** — resolve `DIRTY` agent PRs (merge-conflict remediation).
   Non-disruptive: never dispatches new work or others' CI.
4. **T4 · Critique** — code-review and fix agent PRs whose CI has settled.
5. **T5 · Appraise** — evaluate sprint state, pick a route, name a tracker.
   Pure computation; touches no external state.
6. **T6 · Gate** — scan agent PRs for a head-SHA `Test` check and dispatch
   `ci.yml` where missing. Produces the backpressure signal (`hold_target`).
7. **T7 · Work** — install and run caretta itself via the `work-dispatch` or
   `factory-cycle` child action. The only tentacle that creates commits.
8. **T8 · Reflex** — the self-gate. Given the triggering event, decide whether
   this whole organism should wake at all (the cheap "exit cleanly" path).

T5, T6 and T8 are *afferent* (they sense and report); T2, T3, T4, T7 are
*efferent* (they change the world); T1 is the proprioceptor. The scheduler only
fires efferent tentacles once the afferent ones have built a coherent picture.

### The impotence contract

For a tentacle to be legitimately "impotent" it must satisfy:

- **Stateless** — no memory across actuations; all input arrives in the signal.
- **Single-shot & bounded** — one job, terminates, no internal loops over the
  repo's lifecycle.
- **Idempotent where it writes** — firing twice with the same signal must be
  safe (the current `Reap`/`Gate` steps already aim for this).
- **No self-scheduling** — cannot enqueue itself or any sibling.
- **Structured observation out** — returns data the scheduler can reason over,
  never a fire-and-forget side effect with no report.

This is essentially the `EvaluationResult` / `PrCiResult` / `AutopilotDecision`
discipline already present in `@caretta/action-common/types`, generalized so
*every* tentacle speaks it.

## 4. Centralized vs. decentralized — and the recommendation

The user posed the open question: is the nervous system centralized or
decentralized? The honest answer is that "tentacle" and "nervous system" are
two different axes, and the right design splits them:

- **Cognition: centralized.** One scheduler owns the world-model and all
  decisions. This is what makes tentacles safely impotent and keeps the system
  reasoning-about-able. A decentralized brain (tentacles negotiating
  peer-to-peer) reintroduces exactly the hidden cross-talk we're trying to
  delete, and on GitHub's eventually-consistent API it invites races (two arms
  dispatching CI for the same SHA).
- **Execution: decentralized.** The tentacles are physically distributed and
  ephemeral — each is a separate GitHub Action run / workflow dispatch,
  spun up on demand, with no shared process. They already work this way:
  `work-dispatch-action` and `factory-cycle-action` are independent packages
  with their own `dist/index.js`.

So: **a centralized brain commanding decentralized reflexes** — which, fittingly,
is roughly how a real octopus splits a central brain from arm-local ganglia,
just with the autonomy dial turned down to zero on the arms.

```
                    ┌─────────────────────────────┐
                    │     NERVOUS SYSTEM           │
                    │  (intelligent scheduler)     │
                    │  • world-model of the repo   │
                    │  • policy: when/which/order  │
                    │  • backpressure & holds      │
                    └───────────────┬─────────────┘
        actuation signals           │            structured observations
        ┌──────────┬──────────┬─────┼─────┬──────────┬──────────┐
        ▼          ▼          ▼     ▼     ▼          ▼          ▼
      ┌────┐    ┌────┐    ┌────┐ ┌────┐ ┌────┐    ┌────┐    ┌────┐  ...×8
      │ T1 │    │ T2 │    │ T3 │ │ T4 │ │ T5 │    │ T6 │    │ T7 │
      └────┘    └────┘    └────┘ └────┘ └────┘    └────┘    └────┘
       each: impotent · stateless · idempotent · single-shot
```

## 5. The nervous system as an intelligent scheduler

The scheduler is the only potent component, and "intelligent" means it does
more than fixed sequencing. Its responsibilities:

1. **Build the world-model.** Fire T1 (Sense); fold the result into a snapshot:
   open issues, agent PRs, sprint/tracker, CI state per head SHA.
2. **Plan an actuation order.** Today the order is hardcoded in
   `runAutopilot` (sense → reap → mend → critique → appraise → gate → work).
   The scheduler makes this a *derived* plan from the snapshot + policies, so it
   can skip dead steps and reorder safe ones.
3. **Apply backpressure.** The `computeHoldTarget` / `decideExecution` logic in
   `decide.ts` is the heart of the brain: if T6 (Gate) reports in-flight CI,
   the scheduler withholds T7 (Work) this pass and reports a hold instead of
   blocking. This is already the system's smartest behavior — Octopus Prime
   makes it the scheduler's defining job rather than an `if` in a linear pass.
4. **Resolve contention.** Because cognition is centralized, only the scheduler
   can dispatch CI or run work, so two tentacles can never race on the same SHA.
5. **Be idempotent across passes.** Each invocation is a fresh tick: re-sense,
   re-plan, re-decide. Holding rather than blocking (the current model) means a
   pass always terminates, and the *next* trigger picks up where this left off.

A natural extension the decomposition unlocks: the scheduler can run a partial
plan (e.g. Mend + Critique only, deferring Work) without the all-or-nothing
shape of today's pass — useful when an event is "interesting but not yet
actionable."

## 6. Where Caretta fits

Caretta is **not** one of the eight tentacles, and it is not the nervous system.
Caretta is the *muscle* that **T7 · Work** contracts — the installed agent
(`caretta-install.ts`) the Work tentacle runs to actually author commits. The
relationship is:

- **Octopus Prime (scheduler)** decides *whether and when* to act.
- **T7 (tentacle)** is the impotent effector that *invokes* the agent.
- **Caretta (agent)** is the intelligence-on-loan that does the open-ended
  authoring work once told to.

This keeps the impotence contract intact: T7 itself holds no judgment; it just
runs caretta with the context the scheduler handed it. Caretta's own
intelligence is downstream of, and gated by, the scheduler — it never decides
to wake itself.

This repository — `caretta-autopilot-action` — is therefore the seed of the
nervous system plus its eight tentacles. The migration is mostly *re-drawing
boundaries* around code that already exists, not writing new behavior.

## 7. A plausible path (not a commitment)

1. Formalize the **tentacle interface** (`signal → observation`) in
   `action-common`, generalizing the existing result types.
2. Wrap each of the eight existing concerns to satisfy the impotence contract
   (stateless, idempotent, no self-scheduling). Most already nearly do.
3. Lift the fixed call order out of `runAutopilot` into a **scheduler** that
   derives the plan from the snapshot + the existing policy objects.
4. Keep tentacles deployable as independent action runs (decentralized
   execution), with the scheduler as the one entry point that fans out.
5. Leave Caretta exactly where it is — the muscle behind T7.

## 8. Open questions

- **Tick source.** Does the scheduler run per-event (current model) or hold a
  longer-lived loop? Per-event preserves the "hold, don't block" property.
- **Observation transport.** In-process return values, action outputs, or a
  persisted snapshot (issue comment / artifact) when tentacles are separate runs?
- **Is eight load-bearing?** The eight here are *derived* from current
  concerns. If a ninth concern appears (e.g. release-cutting), does it become a
  tentacle, or fold into an existing one? The metaphor shouldn't constrain the
  architecture.
- **Failure semantics.** When an efferent tentacle fails mid-plan, does the
  scheduler abort the tick or continue with the remaining safe tentacles?
