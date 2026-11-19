# Architecture and failure model

```text
React execution inspector
    | HTTP / server-sent events
    v
FastAPI control plane ---> one worker process per run
                              |
                              v
                    SDK bridge / workflow steps
                              |
                       @tool decorators
                              |
                              v
                    BraceRuntime.execute()
                      |      |       |
                   budget  policy   reconcile()
                              |
                  durable SDK SQLite event log
                              |
                         UI projection
                              |
                  dashboard SQLite run/event views

Independent mock order database (separate SQLite file)
    ^
    | place_order() commits before a lost response is raised
    | verify() searches by persisted idempotency key
    +---- Mock order tool, called only through SDK for BRACE mode

Plain / naive / checkpoint baselines:
    separate explicit baseline scenario engine (not the BRACE SDK)
```

## Exactly what is unified

**Every protected dashboard tool call runs through `BraceRuntime.execute()`.**
`brace.api.engine.advance_one()` routes BRACE-mode runs to
`brace.api.sdk_bridge.protected_step()`. The bridge invokes SDK-decorated
functions, so SDK budget reservation, bounded retries, outcome reconciliation,
loop detection, and receipt decisions execute rather than being emitted from
hardcoded branches. The bridge stores SDK events in its durable append-only
SQLite ledger and mirrors them into the existing dashboard schema with
`origin="BraceRuntime.execute"` and `sdk_seq` for an auditable correspondence.

The **baseline** comparison modes remain explicitly scripted. The workflow
itself is a deliberately deterministic five-step mock shopping agent, not a
model deciding which tool to call. This is appropriate for fault-injection
repeatability, but it is not a production agent integration.

## Timeout reconciliation

The injected timeout may happen before or after a committed order in a distinct
SQLite database. The decorated dangerous order tool raises `ToolTimeout`,
which is handled by SDK `execute()`. The reconciler checks the external-effect
surrogate using the same idempotency key. A verified success is not retried;
a verified missing order may be retried by the SDK policy if budget permits;
undeterminable effects pause. This is a *mock external service*, not an
independent network deployment.

## Crash recovery

The worker really exits with code 31 after writing step 3's checkpoint.
A fresh worker resumes at step 4. SDK events survive the restart in a durable
SQLite file. The benchmark's crash scenario instead simulates interruption;
the actual process-exit path is separately tested.

## Cost and safety limits

All costs are local deterministic mock amounts. There is no real model billing,
provider retry ownership, multi-tenant authentication, or exactly-once guarantee
against arbitrary remote services. The separate UI projection is a *derived*
view; the SDK ledger owns protected action/budget events. The outer workflow
checkpoint remains controlled by the demo worker rather than the SDK itself.
