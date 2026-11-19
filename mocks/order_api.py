"""Mock order API. dedupe=False models a server with no idempotency support (verify() is needed)."""


class OrderAPI:
    def __init__(self, dedupe=False, first_id=4821):
        self.dedupe = dedupe
        self._next = first_id
        self.orders = []
        self.confirmations = []

    def create_order(self, item_id, idem_key=None):
        if self.dedupe and idem_key:
            hit = self.order_exists(idem_key)
            if hit:
                return hit
        order = {"order_id": self._next, "item_id": item_id, "idem_key": idem_key}
        self._next += 1
        self.orders.append(order)
        return order

    def order_exists(self, idem_key):
        if not idem_key:
            return None
        return next((o for o in self.orders if o["idem_key"] == idem_key), None)

    def send_confirmation(self, order_id, idem_key=None):
        if idem_key and any(c["idem_key"] == idem_key for c in self.confirmations):
            return {"sent": True, "duplicate_ignored": True}
        self.confirmations.append({"order_id": order_id, "idem_key": idem_key})
        return {"sent": True}
