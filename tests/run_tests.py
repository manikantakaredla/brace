"""Tiny runner so tests work without pytest:  python -m brace.tests.run_tests
(With pytest installed:  python -m pytest brace/tests -v)"""
import importlib
import pkgutil
import sys
import traceback

import brace.tests as pkg


def main():
    passed = failed = 0
    for m in sorted(pkgutil.iter_modules(pkg.__path__), key=lambda m: m.name):
        if not m.name.startswith("test_"):
            continue
        mod = importlib.import_module(f"brace.tests.{m.name}")
        if getattr(mod, "PYTEST_ONLY", False):
            print(f"SKIP  {m.name} (requires pytest fixtures)")
            continue
        for name in sorted(dir(mod)):
            if name.startswith("test_"):
                try:
                    getattr(mod, name)()
                    passed += 1
                    print(f"PASS  {m.name}::{name}")
                except Exception:
                    failed += 1
                    print(f"FAIL  {m.name}::{name}")
                    traceback.print_exc()
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
