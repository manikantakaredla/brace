"""Errors that tools raise (or adapters translate into) and errors BRACE raises to stop a task."""


class ToolTimeout(Exception):
    """The call timed out. The outcome is UNKNOWN (the action may have happened)."""


class ToolHTTPError(Exception):
    def __init__(self, status, retry_after=None, message=""):
        super().__init__(f"HTTP {status} {message}".strip())
        self.status = status
        self.retry_after = retry_after


class BraceStop(Exception):
    status = "stopped"

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class BudgetDenied(BraceStop):
    status = "stopped"


class NeedsHuman(BraceStop):
    status = "paused"


class ActionFailed(BraceStop):
    status = "failed"
