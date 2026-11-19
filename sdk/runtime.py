"""BraceRuntime: every tool call goes through execute(). One policy, one retry owner."""
import inspect

from brace.sdk import decorators
from brace.sdk.budget import BudgetService
from brace.sdk.errors import (ActionFailed, BraceStop, BudgetDenied, NeedsHuman,
                              ToolHTTPError, ToolTimeout)
from brace.sdk.events import EventLog, derive_actions, derive_receipts
from brace.sdk.policy import backoff_seconds, classify, retry_value_test
from brace.sdk.reconciler import reconcile


class BraceRuntime:
    def __init__(self, task_id, budget_usd, log=None, max_retries=3, min_reserve_usd=0.02, sleep=None, backoff=None):
        self.task_id = task_id
        self.log = log or EventLog()
        self.budget = BudgetService(self.log, task_id)
        self.max_retries = max_retries
        self.min_reserve = min_reserve_usd
        self.sleep = sleep or (lambda s: None)  # inject a scheduler or real sleep
        self.backoff = backoff or backoff_seconds
        previous = self.log.events(task_id)
        created = [event for event in previous if event["type"] == "task_created"]
        if created:
            original_limit = created[0]["payload"]["budget_usd"]
            if abs(original_limit - budget_usd) > 1e-8:
                raise ValueError("Cannot change the budget of an existing task")
        else:
            self.log.append(task_id, "task_created", {"budget_usd": budget_usd})
        self._counts = {}
        for event in previous:
            if event["type"] == "action_pending":
                name = event["payload"]["tool"]
                self._counts[name] = self._counts.get(name, 0) + 1

    # ---- views derived from the event log
    def events(self):
        return self.log.events(self.task_id)

    def actions(self):
        return derive_actions(self.events())

    def receipts(self):
        return derive_receipts(self.events())

    def budget_state(self):
        return self.budget.state()

    # ---- run an agent
    def run(self, agent, *args, **kwargs):
        token = decorators._current.set(self)
        try:
            result = agent(*args, **kwargs)
            self.log.append(self.task_id, "task_completed", {})
            return {"status": "completed", "result": result, "reason": ""}
        except BraceStop as stop:
            self.log.append(self.task_id, "task_paused", {"status": stop.status, "reason": stop.reason})
            return {"status": stop.status, "result": None, "reason": stop.reason}
        finally:
            decorators._current.reset(token)

    # ---- helpers
    def _receipt(self, decision, action_id, reason, attempt):
        self.log.append(self.task_id, "receipt", {
            "decision": decision, "action": action_id, "reason": reason,
            "budget_remaining_usd": self.budget.state()["remaining"], "attempt": attempt})

    def _ev(self, type_, **payload):
        self.log.append(self.task_id, type_, payload)

    @staticmethod
    def _bind(fn, a, kw, key):
        sig = inspect.signature(fn)
        bound = sig.bind(*a, **kw)
        bound.apply_defaults()
        args = dict(bound.arguments)
        if "idem_key" in sig.parameters and not args.get("idem_key"):
            args["idem_key"] = key
        return args

    # ---- the per-call flow
    def execute(self, spec, fn, a, kw):
        n = self._counts[spec.name] = self._counts.get(spec.name, 0) + 1
        action_id = f"{spec.name}#{n}"
        key = f"{self.task_id}:{action_id}"
        args = self._bind(fn, a, kw, key)
        # Observe actual repeated calls across the execution, not fabricated events.
        # A repeat count is reset whenever a different tool/arguments are invoked.
        signature = (spec.name, repr(sorted(args.items())))
        history = getattr(self, "_loop_history", [])
        history = (history + [signature])[-6:]
        self._loop_history = history
        est = spec.cost_usd
        dangerous = spec.side_effect == "dangerous"
        attempt, retries = 0, 0

        while True:
            attempt += 1
            call_id = f"{action_id}/try{attempt}"

            if not self.budget.reserve(call_id, est, spec.name):  # 1. budget check
                rem = self.budget.state()["remaining"]
                reason = (f"Budget check denied {spec.name}: needs ${est:.2f}, only ${rem:.2f} "
                          f"available. Call not dispatched; safe stop.")
                self._receipt("deny_call", action_id, reason, attempt)
                raise BudgetDenied(reason)

            if attempt == 1:
                self._ev("action_pending", action_id=action_id, tool=spec.name,
                         side_effect=spec.side_effect, idem_key=key)
            self._ev("call_dispatched", action_id=action_id, attempt=attempt, call_id=call_id)

            try:
                result = fn(**args)
            except (ToolTimeout, ToolHTTPError) as exc:
                kind = classify(exc)
                verified_failed = False
                if kind == "timeout":
                    self._ev("call_timeout", action_id=action_id, attempt=attempt)

                if dangerous and kind in ("timeout", "server_error"):
                    # Outcome UNKNOWN: do not retry yet. Verify first.
                    self._ev("action_unknown", action_id=action_id, attempt=attempt, kind=kind)
                    self._ev("verify_started", action_id=action_id)
                    verdict, found, why = reconcile(spec.verify, args)
                    self._ev("verify_result", action_id=action_id, verdict=verdict)
                    if verdict == "succeeded":
                        self.budget.settle(call_id, est)
                        self._ev("call_succeeded", action_id=action_id, attempt=attempt, reconciled=True)
                        oid = found.get("order_id") if isinstance(found, dict) else None
                        extra = f" order #{oid}" if oid else " the effect"
                        self._receipt("skip_retry", action_id,
                                      f"Outcome unknown after {kind}; verify() found{extra} "
                                      f"(idem_key {key}). Marked succeeded; not retried.", attempt)
                        return found
                    if verdict == "undetermined":
                        reason = (f"Outcome of {spec.name} unknown after {kind} and cannot be verified "
                                  f"({why}). Paused for a human; not retried.")
                        self._receipt("pause_escalate", action_id, reason, attempt)
                        raise NeedsHuman(reason)
                    self.budget.release(call_id, "verified not executed")
                    verified_failed = True
                else:
                    self.budget.release(call_id, kind)
                    self._ev("call_failed", action_id=action_id, attempt=attempt, kind=kind,
                             status=getattr(exc, "status", None))

                # retry value test
                ok, why = retry_value_test(
                    kind=kind, state_safe=(not dangerous) or verified_failed,
                    retries_used=retries, max_retries=self.max_retries,
                    remaining=self.budget.state()["remaining"], estimate=est,
                    min_reserve=self.min_reserve)
                if not ok:
                    reason = f"Stopped {spec.name}: {why}."
                    self._ev("retry_decided", action_id=action_id, decision="stop", reason=why)
                    self._receipt("stop", action_id, reason, attempt)
                    raise ActionFailed(reason)
                ra = getattr(exc, "retry_after", None)
                wait = ra if (kind == "rate_limit" and ra) else self.backoff(retries + 1)
                retries += 1
                prefix = "verify() found no order; " if verified_failed else ""
                self._ev("retry_decided", action_id=action_id, decision="retry", wait=wait, reason=why)
                self._receipt("retry", action_id, f"{prefix}{why}. Waiting {wait}s.", attempt)
                self.sleep(wait)
                continue

            self.budget.settle(call_id, est)
            self._ev("call_succeeded", action_id=action_id, attempt=attempt)
            if len(history) >= 3 and history[-3:] == [signature] * 3:
                self._ev("loop_detected", action_id=action_id, tool=spec.name,
                         signature=str(signature), repeats=3)
                reason = "Three identical successful calls without progress; paused before another dispatch."
                self._receipt("pause_loop", action_id, reason, attempt)
                raise NeedsHuman(reason)
            return result
