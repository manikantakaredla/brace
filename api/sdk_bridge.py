"""One authoritative protected path: dashboard actions execute through BraceRuntime.

The React UI reads a projection of SDK events from the legacy demo tables. The SDK
SQLite event ledger is durable across worker restarts and is the source of truth.
Mock order side effects are committed independently in the order database.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from brace.sdk import decorators
from brace.sdk.decorators import tool
from brace.sdk.errors import BraceStop, ToolHTTPError, ToolTimeout
from brace.sdk.events import EventLog
from brace.sdk.policy import backoff_seconds
from brace.sdk.runtime import BraceRuntime
from brace.mocks.catalog import Catalog
from . import engine


def sdk_path() -> Path:
    return engine.DB.with_name(engine.DB.stem + '_sdk.sqlite3')


def runtime_for(run):
    runtime = BraceRuntime(
        task_id=run['id'], budget_usd=run['limit_cents'] / 100,
        log=EventLog(str(sdk_path())), max_retries=3,
        backoff=lambda attempt: backoff_seconds(attempt, base=.04, cap=.12),
    )

    def measured_wait(seconds):
        start = time.monotonic()
        time.sleep(seconds)
        runtime.log.append(run['id'], 'retry_wait_elapsed', {
            'planned_ms': round(seconds * 1000),
            'actual_ms': round((time.monotonic() - start) * 1000),
        })

    runtime.sleep = measured_wait
    return runtime


def projection(rid: str, runtime: BraceRuntime, step: int, scenario: str) -> None:
    """Append only new SDK events to the UI feed, with their origin sequence."""
    events = runtime.events()
    with engine.connect() as db:
        existing = {
            json.loads(row['payload'])['sdk_seq']
            for row in db.execute('SELECT payload FROM events WHERE run_id=?', (rid,))
            if '"sdk_seq"' in row['payload']
        }
        for entry in events:
            if entry['seq'] in existing:
                continue
            payload = dict(entry['payload'], sdk_seq=entry['seq'], origin='BraceRuntime.execute')
            if entry['type'] == 'verify_result':
                payload['outcome'] = payload['verdict']
            if entry['type'] == 'call_dispatched' and step == 1 and \
                    scenario == 'loop':
                payload['loop_probe'] = True
            engine.emit(db, rid, entry['type'], step, **{'sdk_payload': payload, 'sdk_seq': entry['seq'], 'origin': 'BraceRuntime.execute', **{k: v for k, v in payload.items() if k not in ('kind', 'step')}})
            if entry['type'] == 'receipt':
                db.execute(
                    'INSERT INTO receipts(run_id,ts,decision,reason,step) VALUES(?,?,?,?,?)',
                    (rid, entry['created_at'], payload['decision'], payload['reason'], step),
                )
        budget = runtime.budget_state()
        db.execute(
            'UPDATE runs SET spent_cents=?,reserved_cents=?,updated_at=? WHERE id=?',
            (round(budget['spent'] * 100), round(budget['reserved'] * 100), time.time(), rid),
        )


def protected_step(rid: str) -> bool:
    """Perform precisely one workflow step through the public @tool SDK mechanism."""
    state = engine.snapshot(rid)
    if state['status'] != 'running' or state['step'] >= len(engine.STEPS):
        return False
    step = state['step']
    scenario = state['scenario']
    rt = runtime_for(state)
    catalog = Catalog()
    calls = 0

    @tool(side_effect='read-only', cost_usd=.04)
    def search_catalog(query):
        nonlocal calls
        calls += 1
        if scenario == 'server' and calls <= 1 + ((state['seed'] + 1) % 2):
            raise ToolHTTPError(500)
        if scenario == 'rate' and calls == 1:
            raise ToolHTTPError(429, retry_after=.03)
        return catalog.search(query)

    @tool(side_effect='read-only', cost_usd=.03)
    def check_stock(item_id):
        return catalog.stock(item_id)

    def verify(args):
        return engine.verify_mock_order(rid, args['idem_key'])

    @tool(side_effect='dangerous', verify=verify, cost_usd=.16)
    def place_order(item, idem_key):
        nonlocal calls
        calls += 1
        # Seeded pre-commit loss allows the reconciler to return 'failed'.
        if scenario == 'timeout' and calls == 1:
            if state['seed'] % 5 != 0:
                engine.place_mock_order(rid, idem_key, item)
            raise ToolTimeout('Order response lost')
        return engine.place_mock_order(rid, idem_key, item)

    @tool(side_effect='idempotent', cost_usd=.05)
    def send_confirmation(order_id):
        return {'sent': True, 'order_id': order_id}

    @tool(side_effect='none', cost_usd=.01)
    def finish(summary):
        return {'finished': True, 'summary': summary}

    token = decorators._current.set(rt)
    try:
        if scenario == 'loop' and step == 1:
            # Repeated real SDK tool invocations rather than injected log entries.
            for _ in range(3):
                search_catalog('blue notebook')
        elif step == 0:
            search_catalog('blue notebook')
        elif step == 1:
            check_stock('nb-blue-01')
        elif step == 2:
            place_order('blue-notebook', None)
        elif step == 3:
            order = engine.list_mock_orders(rid)
            send_confirmation(order[0]['id'] if order else None)
        elif step == 4:
            finish('blue notebook purchase')
    except BraceStop as failure:
        projection(rid, rt, step, scenario)
        with engine.connect() as db:
            status = 'paused' if failure.status in ('stopped', 'paused') else 'failed'
            db.execute('UPDATE runs SET status=?,updated_at=? WHERE id=?', (status, time.time(), rid))
            engine.emit(db, rid, 'task_' + status, step, reason=failure.reason)
        return False
    finally:
        decorators._current.reset(token)

    projection(rid, rt, step, scenario)
    with engine.connect() as db:
        db.execute('UPDATE runs SET step=step+1, updated_at=? WHERE id=?', (time.time(), rid))
        db.execute(
            'INSERT INTO checkpoints(run_id,next_step,saved_at) VALUES(?,?,?) '
            'ON CONFLICT(run_id) DO UPDATE SET next_step=excluded.next_step,saved_at=excluded.saved_at',
            (rid, step + 1, time.time()),
        )
        engine.emit(db, rid, 'checkpoint_saved', step, next_step=step + 1, origin='sdk_bridge')
        if step == 4:
            db.execute('UPDATE runs SET status=? WHERE id=?', ('completed', rid))
            engine.emit(db, rid, 'task_completed', step)
    return True
