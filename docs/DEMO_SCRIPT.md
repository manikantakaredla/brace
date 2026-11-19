# Four-minute demonstrator script

The goal is to show real, inspectable execution traces, not to read a marketing pitch. Rehearse and record the actual running browser and terminal; no prerecorded fake telemetry.

**0:00–0:35 | Context.** Explain a timeout can mean "committed but acknowledgement lost." Show the notebook-order workflow and its $0.50 mock budget.

**0:35–1:25 | Blind retry vs reconciliation.** Run S1 with seed 42. Compare the two ledgers. In the baseline, show two persisted orders; with BRACE show one persisted order. Open the event history and point out `action_unknown`, `verify_started`, `verify_result`, and the receipt explaining why the retry was skipped.

**1:25–1:50 | Verification can fail.** Run S1 again with seed 40. The first request times out **before** committing. Show `verify_result: failed`, an authorized retry, and exactly one final order. This proves the verifier does not simply return success every time.

**1:50–2:25 | Budget gate and loop guard.** Show S4 paused before dangerous dispatch, then S6 and the recorded actual repeated mock catalog calls. Describe a safe stop separately from completed work.

**2:25–3:05 | Worker crash.** Run S5; show the OS worker exit event and persisted third checkpoint. Resume and show no new `place_order` dispatch.

**3:05–3:35 | Evaluation.** Open the 30-seed benchmark and raw `benchmark-trials.csv`. Explain that these are controlled mock trials; the crash benchmark is simulated and the real process exit is independently tested.

**3:35–4:00 | Boundaries and roadmap.** Disclose that the demo engine is not yet unified with the SDK and does not guarantee exactly-once execution for real external APIs. Say that the next milestone is an HTTP mock order service and a single SDK-driven execution path.

**Recording checklist:** Capture the screen at actual 1080p or higher, keep text readable, mute notifications, inspect all endpoints before recording, avoid invented benchmarks, and leave the GitHub URL/QR until you have actually published the repository.
