"""Shopping tools on top of mocks. Decorated with @tool: plain functions without BRACE,
fully controlled inside BraceRuntime.run()."""
from types import SimpleNamespace

from brace.mocks.catalog import Catalog
from brace.mocks.chaos import Chaos
from brace.mocks.order_api import OrderAPI
from brace.sdk.decorators import tool

COST = {"search_catalog": 0.01, "check_stock": 0.01, "place_order": 0.30,
        "send_confirmation": 0.02, "finish": 0.0}


class World:
    """All mock state for one run. `meter` = real money spent (every call that reached the server)."""

    def __init__(self, chaos=None):
        self.chaos = chaos or Chaos()
        self.orders = OrderAPI()
        self.catalog = Catalog()
        self.meter = 0.0
        self.finished = None

    def duplicates(self):
        return max(0, len(self.orders.orders) - 1)


def make_tools(world):
    def spend(name):
        world.meter = round(world.meter + COST[name], 6)

    @tool(side_effect="read-only", cost_usd=COST["search_catalog"])
    def search_catalog(query):
        def _do():
            spend("search_catalog")
            return world.catalog.search(query)
        return world.chaos.call("search_catalog", _do)

    @tool(side_effect="read-only", cost_usd=COST["check_stock"])
    def check_stock(item_id):
        def _do():
            spend("check_stock")
            return world.catalog.stock(item_id)
        return world.chaos.call("check_stock", _do)

    @tool(side_effect="dangerous", cost_usd=COST["place_order"],
          verify=lambda args: world.orders.order_exists(args["idem_key"]))
    def place_order(item_id, idem_key=None):
        def _do():
            spend("place_order")
            return world.orders.create_order(item_id, idem_key)
        return world.chaos.call("place_order", _do)

    @tool(side_effect="idempotent", cost_usd=COST["send_confirmation"])
    def send_confirmation(order_id, idem_key=None):
        def _do():
            spend("send_confirmation")
            return world.orders.send_confirmation(order_id, idem_key)
        return world.chaos.call("send_confirmation", _do)

    @tool(side_effect="none", cost_usd=COST["finish"])
    def finish(summary):
        world.finished = summary
        return {"status": "done", **summary}

    return SimpleNamespace(search_catalog=search_catalog, check_stock=check_stock,
                           place_order=place_order, send_confirmation=send_confirmation, finish=finish)
