"""Reconciler: resolve an UNKNOWN action by calling the user-supplied verify()."""


def reconcile(verify, args):
    """Return (verdict, value, why). verdict: succeeded | failed | undetermined.
    verify(args) returns a truthy value (the found effect) or a falsy value (not found)."""
    if verify is None:
        return "undetermined", None, "no verify() was supplied for this tool"
    try:
        found = verify(args)
    except Exception as exc:  # cannot tell
        return "undetermined", None, f"verify() raised {type(exc).__name__}"
    if found:
        return "succeeded", found, ""
    return "failed", None, ""
