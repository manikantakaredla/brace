from brace.agent.shopping_agent import run_without_brace, shopping_agent
from brace.agent.tools import World, make_tools
from brace.mocks.chaos import Chaos


def test_agent_runs_end_to_end_without_brace():
    w = World()
    res = shopping_agent(make_tools(w))
    assert res["order_id"] == 4821
    assert len(w.orders.orders) == 1 and w.duplicates() == 0
    assert w.meter == 0.34
    assert len(w.orders.confirmations) == 1


def test_chaos_is_seeded_and_repeatable():
    def faults(seed):
        c = Chaos(rates={"place_order": {"timeout_after_success": 0.5}}, seed=seed)
        return [c.next_fault("place_order") for _ in range(20)]
    assert faults(7) == faults(7)
    assert faults(7) != faults(8)


def test_plan_is_consumed_in_order():
    c = Chaos(plan={"search_catalog": ["5xx", "429"]})
    assert [c.next_fault("search_catalog") for _ in range(3)] == ["5xx", "429", None]


def test_act1_without_brace_creates_duplicate_order():
    w = World(Chaos(plan={"place_order": ["timeout_after_success"]}))
    res = run_without_brace(w)
    assert res["status"] == "completed"
    assert len(w.orders.orders) == 2 and w.duplicates() == 1
    assert w.meter > 0.50  # over the $0.50 budget
