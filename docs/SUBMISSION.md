# BRACE — Budgeted Recovery Runtime

**Category:** AI infrastructure / agent reliability  
**Stage:** Single-host, controlled-fault research prototype  
**Target users:** Developers building tool-using AI agents for orders, bookings, payment authorization, and operations workflows.

## Abstract

Agents frequently call external systems whose effects may outlive the network connection. A timeout is therefore an ambiguous result: the request might have failed before it reached the service, or the service might have committed the action and lost the acknowledgement. A blind retry can duplicate an order. BRACE introduces a budget-aware recovery policy that records uncertain outcomes, checks for a previously committed side effect, and only then decides whether to retry. It also records decision receipts, enforces per-task spending limits, detects repeated calls without progress, and resumes a supported workflow from durable checkpoints. The prototype provides an SDK, FastAPI observability API, SQLite-backed mock tool ledger, React control center, controlled fault scenarios, and raw evaluation data.

## Problem statement

How can tool-using AI workflows recover from ambiguous failures without repeating risky side effects or exceeding a fixed operating budget?

## Why it matters in India

Digital commerce, travel bookings, and payment services often interact with multiple external APIs and asynchronous processors. A realistic future adapter could demonstrate a **simulated UPI merchant payment** whose authorization commits but whose response is lost. **This repository does not process UPI payments or integrate with NPCI.** The current observable effect is a mock notebook order. The India-specific application is a proposed use case, not an implemented integration.

## Demonstrated technical contribution

* An explicit `unknown` state and a reconciliation decision before replay of a dangerous action.
* Budget authorization before dispatch and a conservative finishing reserve.
* A separate durable order ledger from the runtime event store, with seed-controlled pre-commit and post-commit timeouts.
* Real subprocess exit and checkpoint resume, tested automatically.
* Bounded retries with actual short waits for controlled HTTP 429/5xx simulation.
* Loop detection from recorded repeated mock catalog calls.
* Inspectable event history, decision receipts, evidence export, and reproducible benchmark data.

**Important boundary:** Protected dashboard tool calls now invoke `BraceRuntime.execute()` via the SDK bridge, verified with a direct SDK entrypoint regression test. The **outer checkpoint/worker orchestrator remains demo-specific**, and the plain/naive/checkpoint comparison modes remain explicit baselines. This is a five-step mock workflow, not a production agent framework integration.

## Measured evidence

Run `python -m brace.bench.run_bench --trials 30` from the parent of the `brace` folder. The committed CSV files correspond to a 30-seed, seven-scenario, four-configuration local mock evaluation. The seed selects whether order effects commit before a timeout and whether transient server errors repeat once or twice. The crash benchmark *simulates* interruption for throughput; a separate test uses a genuine `os._exit(31)` worker and restart. No statistical claims about real production networks are made.

## Deployment needs

Python 3.11+, Node.js 20.19+ (Node 22 recommended) and npm, or Docker Desktop. Local data only. No LLM API key, real order backend, or payment credential required.

## 48-hour development scope

Next add a separate HTTP mock tool process, crash-point coverage before/after external commits, and policy invariants under concurrency. Keep distributed execution, real payments, and multi-agent coordination out of scope.

## Ownership and disclosure

The team must accurately document its actual contributions, testing, and any AI assistance permitted by the event rules. Do not manufacture commit dates, team roles, external adoption, production results, screenshots, or demo video evidence. Reviewers should be able to reproduce the implementation locally.

## Files for review

`README.md` — installation and runbook  
`docs/ARCHITECTURE.md` — execution and data flow  
`docs/LIMITATIONS.md` — exact capability boundaries  
`docs/DEMO_SCRIPT.md` — practical recorded demonstration plan  
`bench/run_bench.py` and `data/benchmark-trials.csv` — raw evaluation  
`tests/` — SDK, runtime, API, and worker recovery checks
