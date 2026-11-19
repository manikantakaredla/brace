import sqlite3

from brace.agent.shopping_agent import run_with_brace
from brace.agent.tools import World
from brace.sdk.budget import BudgetService
from brace.sdk.events import EventLog
from brace.tests.helpers import raises


def test_event_log_is_append_only():
    log = EventLog()
    log.append("t", "task_created", {"budget_usd": 1})
    assert raises(sqlite3.DatabaseError, lambda: log.conn.execute("UPDATE events SET type='x'"))
    assert raises(sqlite3.DatabaseError, lambda: log.conn.execute("DELETE FROM events"))
    assert [e["seq"] for e in log.events("t")] == [1]


def test_reserve_settle_release_deny():
    log = EventLog()
    log.append("t", "task_created", {"budget_usd": 0.50})
    b = BudgetService(log, "t")
    assert b.reserve("c1", 0.30, "x")
    assert b.state()["reserved"] == 0.30 and b.state()["remaining"] == 0.20
    b.settle("c1", 0.25)
    st = b.state()
    assert st["spent"] == 0.25 and st["reserved"] == 0 and st["remaining"] == 0.25
    assert not b.reserve("c2", 0.30, "x")          # denied
    assert any(e["type"] == "budget_denied" for e in log.events("t"))
    assert b.reserve("c3", 0.10, "x")
    b.release("c3", "failed call")
    assert b.state()["remaining"] == 0.25


def test_S4_budget_denial_blocks_the_call():
    w = World()
    brace, res = run_with_brace(w, budget_usd=0.05)
    assert res["status"] == "stopped"
    assert len(w.orders.orders) == 0                # order never placed
    dispatched = [e for e in brace.events() if e["type"] == "call_dispatched"
                  and e["payload"]["action_id"].startswith("place_order")]
    assert dispatched == []                         # no call dispatched after a deny
    assert brace.receipts()[-1]["decision"] == "deny_call"
    assert w.meter == 0.02


def test_happy_path_ledger_matches_real_spend():
    w = World()
    brace, res = run_with_brace(w)
    assert res["status"] == "completed"
    st = brace.budget_state()
    assert st["spent"] == w.meter == 0.34 and st["reserved"] == 0 and st["remaining"] == 0.16
    assert {a["state"] for a in brace.actions().values()} == {"succeeded"}
