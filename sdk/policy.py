"""Policy: failure classification, backoff and the retry value test."""
from brace.sdk.errors import ToolTimeout

RETRYABLE = {"timeout", "rate_limit", "server_error"}


def classify(exc):
    if isinstance(exc, ToolTimeout):
        return "timeout"
    s = exc.status
    if s == 429:
        return "rate_limit"
    if 500 <= s < 600:
        return "server_error"
    return "client_error"


def backoff_seconds(retry_no, base=0.5, cap=8.0):
    return min(cap, base * 2 ** (retry_no - 1))


def retry_value_test(*, kind, state_safe, retries_used, max_retries, remaining, estimate, min_reserve):
    """Return (allowed, reason). All conditions must hold."""
    if kind not in RETRYABLE:
        return False, f"failure type '{kind}' is not retryable"
    if not state_safe:
        return False, "action state is not safe to retry"
    if retries_used >= max_retries:
        return False, f"retry bound reached ({retries_used}/{max_retries})"
    need = estimate + min_reserve
    if remaining + 1e-9 < need:
        return False, (f"remaining budget ${remaining:.2f} is below retry estimate "
                       f"${estimate:.2f} plus minimum reserve ${min_reserve:.2f}")
    return True, (f"retry {retries_used + 1}/{max_retries} allowed: {kind}, state safe, "
                  f"${remaining:.2f} remaining covers ${need:.2f}")
