"""Scripted 5-step shopping agent + the two ways to run it (Without BRACE / With BRACE)."""
from types import SimpleNamespace

from brace.agent.tools import World, make_tools
from brace.sdk import BraceRuntime
from brace.sdk.errors import ToolHTTPError, ToolTimeout


def shopping_agent(tools, query="blue notebook"):
    hits = tools.search_catalog(query)                       # 1 read-only
    item = hits[0]
    if tools.check_stock(item["id"]) <= 0:                   # 2 read-only
        return tools.finish({"order_id": None, "note": "out of stock"})
    order = tools.place_order(item["id"])                    # 3 dangerous
    tools.send_confirmation(order["order_id"])               # 4 idempotent
    return tools.finish({"order_id": order["order_id"]})     # 5


def _retrying(fn, tries):
    def wrapper(*a, **kw):
        last = None
        for _ in range(tries):
            try:
                return fn(*a, **kw)
            except (ToolTimeout, ToolHTTPError) as exc:  # blind retry: timeout treated as failure
                last = exc
        raise last
    return wrapper


def run_without_brace(world, tries=3):
    """Naive agent: every failure, including a timeout, is retried blindly."""
    tools = make_tools(world)
    naive = SimpleNamespace(**{k: _retrying(v, tries) for k, v in vars(tools).items()})
    try:
        return {"status": "completed", "result": shopping_agent(naive)}
    except (ToolTimeout, ToolHTTPError) as exc:
        return {"status": "failed", "result": None, "reason": str(exc)}


def run_with_brace(world, budget_usd=0.50, task_id="order-123", **runtime_kw):
    tools = make_tools(world)
    brace = BraceRuntime(task_id=task_id, budget_usd=budget_usd, **runtime_kw)
    result = brace.run(shopping_agent, tools)
    return brace, result
