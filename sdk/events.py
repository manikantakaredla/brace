"""Append-only event log (source of truth). Budget, action states and receipts are derived from it."""
import json
import sqlite3
import threading
import time


class EventLog:
    def __init__(self, path=":memory:"):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.RLock()
        with self.lock:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS events(
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(task_id, seq)
                );
                CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
                BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
                CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
                BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
                """
            )
            self.conn.commit()

    def append(self, task_id, type_, payload=None):
        with self.lock:
            seq = self.conn.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE task_id=?", (task_id,)
            ).fetchone()[0]
            self.conn.execute(
                "INSERT INTO events(task_id,seq,type,payload_json,created_at) VALUES(?,?,?,?,?)",
                (task_id, seq, type_, json.dumps(payload or {}), time.time()),
            )
            self.conn.commit()
            return seq

    def events(self, task_id, types=None):
        with self.lock:
            rows = self.conn.execute(
                "SELECT event_id,task_id,seq,type,payload_json,created_at FROM events "
                "WHERE task_id=? ORDER BY seq",
                (task_id,),
            ).fetchall()
        out = [
            {"event_id": r[0], "task_id": r[1], "seq": r[2], "type": r[3],
             "payload": json.loads(r[4]), "created_at": r[5]}
            for r in rows
        ]
        if types:
            out = [e for e in out if e["type"] in types]
        return out


def derive_actions(events):
    """Fold events into action states: pending, dispatched, unknown, succeeded, failed."""
    actions = {}
    for e in events:
        p, t = e["payload"], e["type"]
        aid = p.get("action_id")
        if t == "action_pending":
            actions[aid] = {"action_id": aid, "tool": p["tool"], "side_effect": p["side_effect"],
                            "idem_key": p["idem_key"], "state": "pending", "attempts": 0}
        elif t == "call_dispatched":
            actions[aid]["state"] = "dispatched"
            actions[aid]["attempts"] = p["attempt"]
        elif t == "call_succeeded":
            actions[aid]["state"] = "succeeded"
        elif t == "call_failed":
            actions[aid]["state"] = "failed"
        elif t == "action_unknown":
            actions[aid]["state"] = "unknown"
        elif t == "verify_result":
            if p["verdict"] == "succeeded":
                actions[aid]["state"] = "succeeded"
            elif p["verdict"] == "failed":
                actions[aid]["state"] = "failed"
    return actions


def derive_receipts(events):
    return [dict(e["payload"], seq=e["seq"]) for e in events if e["type"] == "receipt"]
