"""Budget service: reserve -> settle / release, derived from the event log. Atomic via the log lock."""


class BudgetService:
    def __init__(self, log, task_id):
        self.log = log
        self.task_id = task_id

    def state(self):
        limit, spent, reserved = 0.0, 0.0, {}
        for e in self.log.events(self.task_id):
            t, p = e["type"], e["payload"]
            if t == "task_created":
                limit = p["budget_usd"]
            elif t == "budget_reserved":
                reserved[p["call_id"]] = p["amount"]
            elif t == "budget_settled":
                reserved.pop(p["call_id"], None)
                spent += p["actual"]
            elif t == "budget_released":
                reserved.pop(p["call_id"], None)
        held = sum(reserved.values())
        return {
            "limit": round(limit, 6),
            "spent": round(spent, 6),
            "reserved": round(held, 6),
            "remaining": round(limit - spent - held, 6),
            "used_pct": round((spent + held) / limit * 100, 1) if limit else 0.0,
            "warn": limit > 0 and (spent + held) / limit >= 0.8,
            "reserved_by_call": reserved,
        }

    def reserve(self, call_id, estimate, tool):
        with self.log.lock:
            st = self.state()
            if estimate > st["remaining"] + 1e-9:
                self.log.append(self.task_id, "budget_denied",
                                {"call_id": call_id, "tool": tool, "estimate": estimate,
                                 "remaining": st["remaining"]})
                return False
            self.log.append(self.task_id, "budget_reserved",
                            {"call_id": call_id, "tool": tool, "amount": estimate})
            return True

    def settle(self, call_id, actual):
        with self.log.lock:
            held = self.state()["reserved_by_call"].get(call_id, 0.0)
            self.log.append(self.task_id, "budget_settled", {"call_id": call_id, "actual": actual})
            if held > actual:
                self.log.append(self.task_id, "budget_released",
                                {"call_id": call_id, "released": round(held - actual, 6),
                                 "reason": "unused reservation"})

    def release(self, call_id, reason=""):
        with self.log.lock:
            held = self.state()["reserved_by_call"].get(call_id, 0.0)
            self.log.append(self.task_id, "budget_released",
                            {"call_id": call_id, "released": held, "reason": reason})
