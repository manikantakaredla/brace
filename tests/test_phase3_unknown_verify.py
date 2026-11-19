from brace.agent.shopping_agent import run_with_brace
from brace.agent.tools import World
from brace.mocks.chaos import Chaos


def types(brace):
    return [e["type"] for e in brace.events()]


def test_S1_timeout_after_success_zero_duplicates():
    w = World(Chaos(plan={"place_order": ["timeout_after_success"]}))
    brace, res = run_with_brace(w)
    assert res["status"] == "completed" and res["result"]["order_id"] == 4821
    assert len(w.orders.orders) == 1 and w.duplicates() == 0
    t = types(brace)
    assert "action_unknown" in t and "verify_started" in t and "retry_decided" not in t
    assert brace.actions()["place_order#1"]["state"] == "succeeded"
    rc = [r for r in brace.receipts() if r["decision"] == "skip_retry"]
    assert len(rc) == 1 and "4821" in rc[0]["reason"]
    assert brace.budget_state()["spent"] == 0.34
    assert w.orders.orders[0]["idem_key"] == "order-123:place_order#1"


def test_unknown_then_verified_not_executed_retries_once():
    w = World(Chaos(plan={"place_order": ["timeout_before"]}))
    brace, res = run_with_brace(w)
    assert res["status"] == "completed" and len(w.orders.orders) == 1
    decisions = [e["payload"]["decision"] for e in brace.events() if e["type"] == "retry_decided"]
    assert decisions == ["retry"]
    assert brace.budget_state()["spent"] == 0.34 and brace.budget_state()["reserved"] == 0


def test_S2_repeated_5xx_backoff_then_success():
    waits = []
    w = World(Chaos(plan={"search_catalog": ["5xx", "5xx"]}))
    brace, res = run_with_brace(w, sleep=waits.append)
    assert res["status"] == "completed"
    assert waits == [0.5, 1.0]                       # exponential backoff
    assert brace.budget_state()["spent"] == w.meter == 0.34


def test_S3_rate_limit_waits_retry_after_then_retries_once():
    waits = []
    w = World(Chaos(plan={"check_stock": ["429"]}))
    brace, res = run_with_brace(w, sleep=waits.append)
    assert res["status"] == "completed" and waits == [2]


def test_retries_are_bounded():
    w = World(Chaos(plan={"search_catalog": ["5xx"] * 10}))
    brace, res = run_with_brace(w, max_retries=3)
    assert res["status"] == "failed"
    assert "retry bound reached (3/3)" in res["reason"]
    assert len(w.chaos.history) == 4                 # 1 try + 3 retries


def test_client_error_is_not_retried():
    w = World(Chaos(plan={"search_catalog": ["400"]}))
    brace, res = run_with_brace(w)
    assert res["status"] == "failed" and len(w.chaos.history) == 1


def test_dangerous_tool_without_verify_pauses_and_never_retries():
    from brace.sdk import BraceRuntime, tool
    from brace.sdk.errors import ToolTimeout
    calls = []

    @tool(side_effect="dangerous", cost_usd=0.10)
    def charge_card(amount):
        calls.append(amount)
        raise ToolTimeout("lost")

    brace = BraceRuntime("pay-1", 0.50)
    res = brace.run(lambda: charge_card(5))
    assert res["status"] == "paused" and len(calls) == 1
    assert brace.receipts()[-1]["decision"] == "pause_escalate"
    assert brace.actions()["charge_card#1"]["state"] == "unknown"


def test_retry_denied_when_budget_cannot_cover_retry_plus_reserve():
    w = World(Chaos(plan={"place_order": ["timeout_before"]}))
    brace, res = run_with_brace(w, budget_usd=0.33)  # 0.31 left after search/stock: enough for the order, not for a retry + 0.02 reserve
    assert res["status"] == "failed" and len(w.orders.orders) == 0
    assert brace.receipts()[-1]["decision"] == "stop"
