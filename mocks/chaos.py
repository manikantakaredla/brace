"""Seeded fault injector. Faults: timeout_after_success, timeout_before, 5xx, 429, 400.
Use a deterministic plan (per-tool queue) or seeded random rates."""
import random

from brace.sdk.errors import ToolHTTPError, ToolTimeout


class Chaos:
    def __init__(self, plan=None, rates=None, seed=0):
        self.plan = {k: list(v) for k, v in (plan or {}).items()}
        self.rates = rates or {}
        self.rng = random.Random(seed)
        self.history = []  # (tool, fault)

    def next_fault(self, tool):
        q = self.plan.get(tool)
        if q:
            return q.pop(0)
        r = self.rates.get(tool)
        if r:
            roll, acc = self.rng.random(), 0.0
            for fault, p in r.items():
                acc += p
                if roll < acc:
                    return fault
        return None

    def call(self, tool, fn, *a, **kw):
        fault = self.next_fault(tool)
        self.history.append((tool, fault))
        if fault in (None, "ok"):
            return fn(*a, **kw)
        if fault == "timeout_after_success":
            fn(*a, **kw)  # the effect happens, the response is lost
            raise ToolTimeout(f"{tool}: response lost")
        if fault == "timeout_before":
            raise ToolTimeout(f"{tool}: timed out before executing")
        if fault == "5xx":
            raise ToolHTTPError(500)
        if fault == "429":
            raise ToolHTTPError(429, retry_after=2)
        if fault == "400":
            raise ToolHTTPError(400, message="validation error")
        raise ValueError(f"unknown fault {fault}")
