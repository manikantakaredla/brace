"""@tool(side_effect=..., verify=..., cost_usd=...). Outside a BraceRuntime the tool runs unchanged."""
import contextvars
import functools
from dataclasses import dataclass
from typing import Callable, Optional

SIDE_EFFECTS = ("read-only", "idempotent", "dangerous", "none")
_current = contextvars.ContextVar("brace_runtime", default=None)


@dataclass
class ToolSpec:
    name: str
    side_effect: str
    verify: Optional[Callable]
    cost_usd: float


def tool(side_effect="read-only", verify=None, cost_usd=0.01):
    if side_effect not in SIDE_EFFECTS:
        raise ValueError(f"side_effect must be one of {SIDE_EFFECTS}")

    def deco(fn):
        spec = ToolSpec(fn.__name__, side_effect, verify, cost_usd)

        @functools.wraps(fn)
        def wrapper(*a, **kw):
            rt = _current.get()
            if rt is None:
                return fn(*a, **kw)
            return rt.execute(spec, fn, a, kw)

        wrapper._brace = spec
        return wrapper

    return deco
