"""Act 1 vs Act 2:  python -m brace.demo"""
from brace.agent.shopping_agent import run_with_brace, run_without_brace
from brace.agent.tools import World
from brace.mocks.chaos import Chaos

S1 = {"place_order": ["timeout_after_success"]}
RED, GREEN, AMBER, RESET = "\033[91m", "\033[92m", "\033[93m", "\033[0m"


def main():
    print("=== ACT 1: WITHOUT BRACE (S1: timeout after the order is created) ===")
    w = World(Chaos(plan=S1))
    run_without_brace(w)
    print(f"{RED}Orders placed: {len(w.orders.orders)} (expected 1) | duplicates: {w.duplicates()} | "
          f"spent ${w.meter:.2f} of $0.50 budget{RESET}\n")

    print("=== ACT 2: WITH BRACE (same scenario, same seed) ===")
    w = World(Chaos(plan=S1))
    brace, res = run_with_brace(w)
    for e in brace.events():
        p = e["payload"]
        if e["type"] in ("call_dispatched", "call_timeout", "action_unknown", "verify_started",
                         "verify_result", "call_succeeded", "budget_denied", "task_completed"):
            tag = AMBER if e["type"] in ("action_unknown", "call_timeout") else GREEN if \
                e["type"] in ("call_succeeded", "task_completed") else ""
            print(f"{tag}{e['seq']:>3}  {e['type']:<16} {p.get('action_id', '')} "
                  f"{p.get('verdict', '')}{RESET}")
    print("\nReceipts:")
    for r in brace.receipts():
        print(f"  [{r['decision']}] {r['reason']}  (remaining ${r['budget_remaining_usd']:.2f})")
    st = brace.budget_state()
    print(f"{GREEN}\nOrders placed: {len(w.orders.orders)} | duplicates: {w.duplicates()} | "
          f"spent ${st['spent']:.2f} of ${st['limit']:.2f} | status: {res['status']}{RESET}")


if __name__ == "__main__":
    main()
