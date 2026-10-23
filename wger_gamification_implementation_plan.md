# Claude Code brief: wger integration for my gamification app

> **Status note (added during pre-production review):** what actually got
> built (`server/wger.ts`, see CLAUDE.md's "wger integration" section) is a
> much smaller slice of this brief than the full plan below describes —
> read-only, direct-to-wger-API reads on every request (no local mirror
> table, no polling/reconciliation job, no sync-run bookkeeping — Phases
> 1-2 below were never built that way), and no XP/quests/achievements/
> reward system at all (Phase 4+ below). It's "pride glance" display data
> only: today's logged sets, wger's own computed lifetime stats, wger's
> own auto-detected personal records, and a recent-sessions log — all
> fetched live per-request with simple in-memory caching for static
> metadata (exercise names, weight units), not ingested/normalized into
> this app's own database. Left this file as-is below (historical
> record of the original ambition) rather than editing it to match what
> shipped — if a bigger integration along these lines is ever actually
> pursued, this is still the right starting brief for phases beyond what
> exists today.

## Product goal

I use the official wger app to plan and log workouts against my own self-hosted wger server. My personal productivity/gamification app must consume those records, award progress, and show workout summaries and trends. Keep the official mobile app unchanged. Build an integration, not another workout logger.

Example: I complete three deadlift sets in wger. Once those records reach my wger server, my game should see three completed sets, their weights/reps, and award the configured progress exactly once. If I correct or delete a set, the game must reconcile the result. From my game I can request today's activity or a historical trend on demand.

“Three times” means three performed sets in this example, not three reps or three workout sessions. Keep these metrics distinct.

## How to execute this brief

1. Inspect the existing repository, AGENTS.md, architecture, authentication, database, jobs, tests, and deployment conventions. Reuse the project's stack. Do not choose a new stack or rewrite unrelated features.
2. Work one phase at a time. For each phase: state scope, implement, run meaningful checks, update a durable implementation checklist, and report acceptance results and remaining limitations. Stop after the requested phase; do not implement later phases speculatively.
3. Start with Phase 0 only unless explicitly told otherwise. Ask for genuinely missing inputs; infer routine implementation choices from the repository.
4. Keep application features independent from wger deployment changes. No phone-app fork. Any wger extension must be a small, separately maintained server extension with a documented upgrade path.
5. All endpoints under `/integrations/wger` and `/fitness` below are proposed endpoints in MY app. Confirm actual wger endpoints and schemas from the deployed version. Do not assume the examples are exact contracts.
6. Do not enable XP mutations until the reward phase. Initial imports are historical data, not automatic new achievements.

## Architecture and boundaries

- Official wger app writes/syncs to self-hosted wger.
- My backend reads wger with server-held credentials and maintains a normalized activity mirror.
- My frontend calls MY backend, never wger with a privileged token.
- Phase 2 uses polling; Phase 5 adds durable push events from wger. Both feed the SAME ingestion/reconciliation service.
- wger owns workout truth. My app owns XP, quests, achievements, and game state.
- No writes back to wger in initial scope. Requesting summaries is a read, not bidirectional record synchronization.
- Eventual consistency: server visibility follows mobile synchronization, not the instant of an offline phone tap.
- Network access must work from the gym to the wger server, for example over an existing VPN or HTTPS setup. A server reachable only on home Wi-Fi cannot provide live gym updates.

## Phase 0 — Discovery and verified contract

### Tasks

- Inventory the game repository and propose the smallest integration boundary.
- Identify the deployed wger version, matching source/tag, deployment method, database, official mobile version, and account to integrate. Pin versions rather than relying on `latest`.
- Inspect the instance's OpenAPI schema and real authenticated responses. Candidate routes to verify: `/api/v2/workoutlog/`, `/api/v2/workoutsession/`, `/api/v2/routine/{id}/logs/`, `/api/v2/routine/{id}/stats/`.
- Verify auth options, pagination, ownership filtering, supported date/exercise filters, stable record identifiers, timestamps, units, exercise identifiers, routine links, and whether incomplete/planned records can appear.
- Determine whether the app saves individual sets to the server immediately, batches them, or sends them when a workout finishes. Test online logging and offline recovery on the actual installed versions. If a live device is unavailable, mark this unverified rather than inventing latency guarantees.
- Verify how routine stats are invalidated after log changes, whether unlinked logs are omitted, and which requested metrics are available server-side.
- Check for built-in webhooks/change feeds in this version before proposing an extension. Source inspected during planning used Django signals for WorkoutLog and WorkoutSession changes; that is a candidate extension point, not a guarantee for every version or bulk-write path.
- Produce a short contract document, sanitized response fixtures, phase checklist, and unresolved decisions. Never include credentials or real private workout history in committed fixtures.

### Acceptance

- Record fields and supported queries are grounded in the target version.
- A documented data path explains exactly when logged sets become server-queryable.
- Stack, auth, deployment, timezone, and initial import/reward boundary are recorded.
- If no wger instance exists, supply a pinned local development setup using upstream instructions, then perform contract checks there. Keep phone sync timing explicitly unverified until tested.

## Phase 1 — Connection and read-only API client

### Tasks

- Add a backend-only wger client with configured base URL and secret, timeouts, pagination, bounded retries for safe reads, and useful sanitized errors.
- Use the auth mechanism actually supported by the installed release. Do not assume read-only token scopes exist; enforce read-only behavior in this adapter.
- Add connection status and manual “test connection” behavior using the app's existing settings patterns.
- Suggested app endpoint: `GET /integrations/wger/status`. Return connected state, last successful contact, and a safe error message, never tokens.
- Fetch sessions and performed sets; preserve source IDs, source units, exercise IDs, source dates/times, and routine linkage.

### Acceptance

- Authorized backend requests read only the intended account's data.
- Multiple API pages are handled; expired/invalid auth, unreachable server, timeout, and malformed responses produce actionable errors.
- No token reaches the browser, application logs, or version control.

## Phase 2 — Local activity mirror and polling MVP

### Tasks

- Add migrations for connection identity, mirrored sessions/sets, sync runs/status, and a stable source-to-local mapping. Scope identifiers by connection/account as well as source record ID; support the deployed identifier type without assuming integer IDs.
- Store original values and units plus normalized values where appropriate. Preserve source exercise identity; do not identify exercises only by display names. Allow explicit mappings for variants instead of silently merging sumo and conventional deadlifts.
- Ingest only actual performed activity as reward-eligible. Verify wger's representation; do not infer completion merely from a record's presence unless the contract supports it.
- Use content fingerprints or verified source revisions to make repeated imports idempotent.
- Add an initial paginated backfill with an explicit historical cutoff. Default: historical imports are visible in stats but earn no retroactive XP.
- Poll at a configurable interval; suggested starting point is 30 seconds while fitness UI is active, with a slower background schedule. Reuse existing job infrastructure and prevent overlapping runs for a connection.
- If supported modification cursors do not exist, rescan a recent window and schedule a complete paginated reconciliation for older edits/deletions. Document the eventual-consistency delay.
- Never mark records deleted from an incomplete scan, an error, a pagination limit, or a filtered response. A successful authoritative scan can tombstone missing records only within that scan's proven coverage.
- Expose a manual sync action, last successful sync time, and stale-data state. Do not show a failed sync as an empty workout day.

### Acceptance

- Logging three completed sets, then syncing, produces exactly three mirrored sets.
- Repeating the same sync creates no duplicates.
- Weight/reps edits, exercise renames, deletions, multiple pages, and older corrections reconcile correctly under the documented policy.
- Network failures preserve previous data and do not create false deletions.

## Phase 3 — On-demand summaries and trends

### Tasks

- Suggested app endpoints: `GET /fitness/summary?date=YYYY-MM-DD`, `GET /fitness/trends?start=...&end=...&exerciseId=...`, and a paginated activity endpoint.
- Return workouts, completed sets, completed reps, and lifting volume separately. For the deadlift example: three sets of five at 100 kg means 3 sets, 15 reps, and 1,500 kg-reps of load volume.
- Define supported metric semantics explicitly: warm-up inclusion, bodyweight/assisted exercises, mixed units, zero-rep records, missing loads, timed exercises, and estimated 1RM. Do not apply ordinary weight-times-reps formulas to every exercise type.
- Use wger routine stats where verified and suitable; use mirrored records for account-wide/date-range summaries or metrics unavailable upstream. Label metric provenance/formula so charts do not silently mix incompatible calculations.
- Group activity using the user's configured timezone (default America/New_York); preserve date-only source semantics rather than fabricating UTC midnight. Handle date boundaries and DST.
- Return freshness metadata. Offer refresh-on-demand with bounded latency and last-known data if wger is unavailable. Avoid calling wger once per individual chart point.
- Build a compact fitness screen using existing UI/chart conventions: today's totals, recent activity, and selected-exercise trends. Provide empty, loading, stale, and error states.

### Acceptance

- Today's deadlift sets match the source records.
- Known fixtures verify unit conversion, date grouping, gaps with no activity, and volume arithmetic.
- Unlinked logs remain visible in local summaries even when upstream routine stats omit them.
- Every chart states units and date range; errors do not masquerade as zero activity.

## Phase 4 — Gamification and corrections

### Tasks

- Integrate the existing game reward system. If no rule exists, make a configurable initial rule, such as XP per completed non-warm-up set; do not invent permanent economy values.
- Track reward eligibility using a documented initial-import boundary plus first observation/source metadata. Old backfilled workouts must not become new rewards merely because they arrive today.
- Use an idempotent reward ledger keyed by source activity and rule version. Derive the desired reward from current eligible activity and apply only the difference transactionally.
- Handle edits/deletions with compensating ledger entries; define effects on levels, achievements, and already-spent currency using the game's established policy. Resolve this policy before enabling irreversible game effects.
- Publish existing app events/WebSocket notifications only after mirror and reward transactions commit.

### Acceptance

- A new eligible set awards progress once, despite retries, duplicate ingestion, or concurrent jobs.
- Undoing/deleting that set reconciles rewards according to policy.
- Polling and future webhook ingestion produce identical results.
- Restarting workers does not duplicate rewards; historical import grants none by default.

## Phase 5 — Durable push from the wger server

### Tasks

- If the installed wger version has a suitable built-in event mechanism, use it. Otherwise implement a small server extension, leaving the official mobile app unchanged.
- Verify actual create/update/delete write paths, including sync/bulk operations; Django model signals can be bypassed by bulk operations. Cover the real paths instead of assuming signals catch everything.
- Store an outbox event in the SAME database transaction as the workout mutation. A background worker delivers it after commit. An `on_commit` callback alone is not a durable outbox and can lose events if the process crashes.
- Version the event envelope. Include event ID, connection/account identity, entity type, entity ID, operation, event time, and a reliable per-entity revision/order mechanism. Include enough identity in deletion tombstones to reconcile without refetching a nonexistent object.
- Suggested receiving endpoint: `POST /integrations/wger/events`. Authenticate deliveries using HMAC over raw bytes with timestamp/replay checks or an existing equivalent mechanism. Restrict credentials to this integration.
- Persist received events before acknowledging; deduplicate event IDs. Retry sender failures with exponential backoff, durable attempt state, and manual replay/dead-letter visibility.
- Handle out-of-order updates: refetch authoritative current state for create/update, or apply verified monotonic revisions. Prevent an older update from resurrecting a newer deletion. Handle not-found races deliberately.
- Route all changes through the Phase 2 reconciliation service and Phase 4 reward ledger.
- Keep periodic polling/reconciliation as repair for missed events, unsupported write paths, and historical edits.
- Expose delivery lag, last successful delivery, retry counts, and unhealthy backlog without storing sensitive payloads in general logs.

### Acceptance

- After the phone syncs a set to wger, the game reflects it without waiting for its polling interval. Suggested development target: within five seconds of committed server save under healthy conditions, measured rather than promised.
- Receiver downtime, sender restart, duplicate deliveries, out-of-order edits, and deletion races cause neither lost committed events nor duplicate XP.
- A crash between source mutation and commit rolls back both mutation and event; a crash after commit leaves a deliverable outbox event.
- Invalid signatures/replays are rejected; acknowledged events survive receiver restart.
- Disabling the integration does not prevent normal wger logging.

## Phase 6 — Operational hardening and handoff

- Provide configuration examples without secrets, migration/rollback instructions, backup guidance for source/mirror/ledger/outbox, and upgrade compatibility notes for the pinned wger release.
- Add a feature flag for push ingestion and independent reward enablement. Preserve polling fallback.
- Run an end-to-end smoke test: log in the official app, query from the game, edit/delete the record, request a month trend, interrupt connectivity, and recover.
- Test timezone boundaries and the initial-history cutoff. Use a dedicated test account or clearly identified disposable records.
- Document observed mobile sync behavior, polling latency, webhook latency, and any unsupported metrics.
- Do not silently deploy to production or modify unrelated infrastructure. Prepare changes and use the user's existing deployment workflow.

## Definition of done

I can keep using the official wger app. My game reads today's completed sets and historical trends from my backend. New server-visible activity updates game progress promptly; offline activity catches up after sync. Edits/deletions reconcile, retries do not duplicate XP, and missed events can be repaired. Credentials remain server-side. Rebuilding my workout mirror never requires recreating or double-awarding my game history.

## References to verify against the installed release

- wger API/auth: https://wger.readthedocs.io/en/stable/api/api.html
- Routine/log/stats API: https://wger.readthedocs.io/en/stable/api/routines.html
- Server repository: https://github.com/wger-project/wger
- Candidate server extension points: https://github.com/wger-project/wger/blob/master/wger/manager/signals.py
- Official app: https://github.com/wger-project/flutter

Planning basis: documentation/source inspected on 2026-10-21. This document is an implementation specification, not proof that a particular deployed release has been tested.

## First prompt to run

Read this implementation brief and the repository's instructions. Execute Phase 0 only. Produce the verified integration contract, recommended file/module changes, a phase checklist, and any blockers. Do not implement XP, push delivery, or a new workout UI yet.
