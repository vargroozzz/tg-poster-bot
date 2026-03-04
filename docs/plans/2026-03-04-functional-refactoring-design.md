# Functional Refactoring Design

**Date:** 2026-03-04
**Scope:** Module-boundaries — stateless OOP classes flattened to functions, Effect for async IO chains

## Problem

Several modules are OOP in form but functional in nature: no instance state, no lifecycle, no meaningful reason to be classes. Additionally, two modules have painful imperative patterns that Effect cleans up well:
- `AttributionService`: deep null-chain branching across multiple async DB lookups
- `RetryService`: mutable while-loop with manual sleep and DB updates on each attempt

## Approach

### Part 1 — Stateless classes → module functions

Five modules are pure functions disguised as classes. Remove the class shell; export functions directly.

| File | Change |
|---|---|
| `src/core/transformation/text-transformer.service.ts` | Class removed; `applyTextHandling`, `prependCustomText`, `transformText` exported as functions. File renamed to `text-transformer.ts`. |
| `src/core/session/session-state-machine.ts` | `SessionStateMachine` class removed; `getNextState`, `isValidTransition`, `getPossibleNextStates` exported as functions. |
| `src/shared/helpers/validation.helper.ts` | `ValidationHelper` class removed; all static methods exported as functions. File renamed to `validation.ts`. |
| `src/shared/helpers/nickname.helper.ts` | `NicknameHelper` class removed; all static methods exported as functions. File renamed to `nickname.ts`. |
| `src/core/attribution/nickname-resolver.service.ts` | Deleted. Single `getUserAttribution(userId)` function inlined into `attribution.ts`. |

Call sites updated from `Class.method()` / `new Class().method()` to direct function imports.

### Part 2 — `AttributionService` with Effect

**File:** `src/core/attribution/attribution.service.ts` → `src/core/attribution/attribution.ts`

The class is deleted. `buildAttribution` and helpers become module-level functions.

Internally:
- `Effect.gen` replaces `async/await` for readability
- `Option.fromNullable` replaces multi-exit null checks
- `isGreenListed` and `isRedListed` run concurrently via `Effect.all`
- `NicknameResolverService` is inlined (it was a one-liner)

External signature stays `Promise<string | null>` — `Effect.runPromise` bridges at the function boundary. No callers change.

### Part 3 — `RetryService` with Effect

**File:** `src/utils/retry/retry.service.ts` → `src/utils/retry/retry.ts`

The class is deleted. Exported function:

```typescript
export function withRetry<T>(
  operation: () => Promise<T>,
  post: IScheduledPost,
  config?: Partial<RetryConfig>
): Promise<T>
```

Internally:
- `Effect.retry` with `Schedule.exponential` + `Schedule.upTo` + `Schedule.recurs`
- `Effect.tapError` handles the DB metadata update on each failed attempt before retry
- `Effect.runPromise` at the boundary — callers see no change
- `PostWorkerService` imports `withRetry` directly; `RetryService` class instantiation removed

## Effect boundary rule

Effect values stay inside these modules. All public APIs remain `Promise`-based. `Effect.runPromise` is called at the module boundary, not by callers.

## Files not changed

- `parseForwardInfo` — already a pure function
- `entitiesToHtml` — already pure functions
- `time-slots.ts` — already module functions
- `PreviewGeneratorService` — straightforward async chain, no null complexity worth Effect overhead
- All handlers, repositories, models, bot setup

## Dependencies

Add `effect` package if not already installed: `npm install effect`
