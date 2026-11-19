# Scope and verified limitations

| Capability | What is actually implemented | What is not claimed |
| --- | --- | --- |
| Unknown outcome | Seeded timeout before or after mock order commit, with independent mock ledger lookup | Arbitrary remote API verification or exactly-once semantics |
| SDK | `BraceRuntime` and its policy helpers separately tested | Protected dashboard tool actions execute through `BraceRuntime.execute()`; the outer worker/checkpoint orchestration remains separate |
| Budget | Per-run mock cents, reservation/settlement events and dispatch denial | Provider billing integration or cross-process atomic cost settlement |
| Retry | Finite 429/500 sequences, policy check, short actual wait recorded | Real HTTP transport, robust jitter under high load, or gateway retry suppression |
| Loop guard | Three identical actual SDK tool invocations detected and paused | A generic model-state or semantic-progress classifier |
| Crash | OS process exit 31 and separate worker resume for S5 | Supervisor restart recovery across arbitrary split-brain failures |
| Event history | SDK event table has database triggers forbidding update/delete; dashboard events are a derived read projection | End-to-end tamper-resistant audit log, external attestation, or immutable dashboard projection tables |
| Side-effect ledger | Separate SQLite database, queryable by idempotency key | Independent network microservice or payment processor |
| Evaluation | 840 recorded local mock trials at 30 seeds per scenario/setup | Measured production reliability or statistical generalization |
| Presentation | Source for React application and local build instructions | A recorded demo video or verified Docker deployment |

## Interpreting safe stops

Budget exhaustion and loop detection deliberately pause BRACE. A pause is **not** a completed task, and should not be described as one. The benchmark reports `safe_stops` separately so a reviewer can assess prevented unsafe action independently of completion.

## How to reproduce results

1. `python -m pytest brace/tests -q` from the parent directory.
2. `python -m brace.tests.run_tests` for legacy no-pytest tests.
3. `python -m brace.bench.run_bench --trials 30` for per-seed CSV data.
4. Inspect the exported run JSON and the `mock_orders.sqlite3` database.
5. Build the frontend with `npm install` then `npm run build` inside `brace/dashboard`.

Do not use the generated concept art from earlier conversations as proof of a running UI. Capture screenshots directly from the browser after starting the application.
