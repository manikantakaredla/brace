# BRACE v2

**Budgeted Recovery Runtime** — local, inspectable research prototype for budget-aware recovery in tool-using AI workflows.

When an order API times out, the agent cannot assume the order failed. BRACE records that uncertainty, verifies the mock side effect, and then decides whether another attempt is safe. See [the technical design](docs/ARCHITECTURE.md), [exact limitations](docs/LIMITATIONS.md), [project abstract](docs/SUBMISSION.md), and the [four-minute demo script](docs/DEMO_SCRIPT.md).

> This is a single-host evaluation prototype, **not a production payment or order system**. BRACE-mode dashboard tool calls execute through `BraceRuntime.execute()`. The deterministic baseline modes remain separately scripted, and worker checkpoint orchestration remains part of the demo adapter.

## Live Deployments

- **Frontend (Vercel):** [https://brace-kappa.vercel.app/](https://brace-kappa.vercel.app/)
- **Backend API (Render):** [https://brace-api-y8ha.onrender.com](https://brace-api-y8ha.onrender.com)
- **Interactive OpenAPI Documentation:** [https://brace-api-y8ha.onrender.com/docs](https://brace-api-y8ha.onrender.com/docs)
- **API Health Check:** [https://brace-api-y8ha.onrender.com/api/health](https://brace-api-y8ha.onrender.com/api/health)

The frontend is configured to communicate directly with the Render backend API, supporting real-time Server-Sent Events (SSE) streaming, paired fault simulation runs, checkpoint inspection, and mock order tracking.

## Requirements

- Python 3.11+; Node.js 22 and npm for manual setup.
- Or Docker Desktop with Compose.
- No real orders, real payment credentials, external LLM key, or cloud services required.

## Quick start: Docker

Run from this `brace` directory:

```bash
docker compose up --build
```

Dashboard: http://localhost:5173  
OpenAPI documentation: http://localhost:8000/docs

Docker deployment is provided but needs verification on your machine before submission. Use `docker compose down` to stop, or `docker compose down -v` to remove persisted volumes.

## Quick start: Windows PowerShell (no Docker)

Extract the ZIP. Open the terminal in **the folder immediately above `brace`**. Do not run package commands from inside the Python `brace` folder.

**Terminal 1 (API):**

```powershell
py -m pip install -r brace/requirements.txt
py -m uvicorn brace.api.main:app --host 127.0.0.1 --port 8000
```

**Terminal 2 (UI):**

```powershell
cd brace/dashboard
npm install
npm run dev
```

Open http://localhost:5173.

## Quick start: macOS / Linux (no Docker)

From the parent of `brace`:

**Terminal 1:**

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r brace/requirements.txt
python -m uvicorn brace.api.main:app --host 127.0.0.1 --port 8000
```

**Terminal 2:**

```bash
cd brace/dashboard
npm install
npm run dev
```

## Seven controlled fault scenarios

| ID | Scenario | Evidence to inspect |
| --- | --- | --- |
| S1 | Timeout before/after order commit | `verify_result`, distinct order keys, decision receipts |
| S2 | 500 server errors | Actual bounded retry-wait events |
| S3 | 429 rate limit | Recorded short retry wait |
| S4 | Budget nearly exhausted | No dangerous call dispatched after `budget_denied` |
| S5 | Worker exit | Exit 31 and checkpoint resume |
| S6 | No-progress search loop | Repeated mock read calls and a safe stop |
| S7 | Normal operation | Completed workflow and budget ledger |

Use seed **42** for the main S1 demonstration (post-commit timeout, no duplicate with BRACE) and seed **40** to verify the other branch (pre-commit timeout, `verify_result: failed`, authorized retry).

## Tests

From the parent of `brace`:

```bash
python -m pytest brace/tests -q
python -m brace.tests.run_tests
```

The primary pytest suite includes API endpoint tests and a genuine subprocess exit/resume test. The lightweight custom runner executes the original no-pytest tests and skips tests that require pytest fixtures.

## Controlled benchmarks

```bash
python -m brace.bench.run_bench --trials 30
```

This produces `brace/data/benchmarks.json`, `benchmarks.csv` and `benchmark-trials.csv`. The result shipped in this ZIP contains **840 runs** (seven scenarios × four configurations × 30 seeds). Safe stops are distinct from completions. Seeds vary selected HTTP 500 counts and whether the timeout occurs before or after the order side effect. The crash benchmark uses simulated interruption for throughput, while a separate integration test exercises real OS process exit and restart.

## What to inspect in the UI

- **Execution overview:** a plain/naive workflow side by side with BRACE.
- **Execution inspector:** raw event history and policy receipts.
- **Mock order ledger:** effects persisted in a **separate SQLite file** from the runtime state.
- **Evaluation:** data loaded from actual benchmark output, not hand-entered scores.
- **Architecture and limits:** honest engineering boundaries.

The interface deliberately avoids decorative achievement counters. To add screenshots to the repository, capture the application in a real browser after you have built it. A mockup image is not acceptable as execution evidence.

## Deployment and development notes

The React UI uses `EventSource` to read live run states from the FastAPI API. Subprocesses use `python -m brace.api.worker`. Runtime dashboard state is stored in `brace/data/brace.sqlite3`, protected SDK events in `brace/data/brace_sdk.sqlite3`, and mock orders in `brace/data/mock_orders.sqlite3` (or paths configured by `BRACE_DB` and `BRACE_ORDER_DB`). Docker stores the data in a named volume.

CI workflow: `.github/workflows/ci.yml` (available when this project is pushed with `brace` as repository root).

## Authorship and ethics

Use only genuine git commits; do not fabricate development history. Attribute team contributions accurately and disclose AI assistance according to the hackathon's rules. This demo has no user authentication and does not process real personal or financial data. License: MIT; confirm copyright attribution with your team before public release.


## SDK integration verification

The regression test `test_dashboard_protected_run_invokes_sdk_execute` patches the actual SDK entrypoint and asserts it was invoked for all five protected tool steps. Protected events include `origin: BraceRuntime.execute` and `sdk_seq` in the dashboard evidence export. The durable SDK log lives in a separate SQLite file with database-level append-only triggers.
