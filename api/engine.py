"""BRACE demo runtime: SQLite-backed event log, persistent mock orders, safe recovery.
This is a single-host demonstrator, not a claim of exactly-once execution for external APIs.
"""
import json, os, sqlite3, time, uuid
from brace.sdk.policy import backoff_seconds, retry_value_test
from brace.mocks.catalog import Catalog
from pathlib import Path
DB = Path(os.getenv('BRACE_DB', str(Path(__file__).resolve().parents[1] / 'data' / 'brace.sqlite3')))
STEPS = ('search_catalog', 'check_stock', 'place_order', 'send_confirmation', 'finish')
COST_CENTS = (4, 3, 16, 5, 1)
SCENARIOS = {'timeout': 'Response lost after order commit', 'server': 'Two HTTP 500 errors on catalog search', 'rate': 'HTTP 429 with retry-after', 'budget': 'Insufficient budget at order dispatch', 'crash': 'Worker exits immediately after the order checkpoint', 'loop': 'Repeated catalog calls without progress', 'normal': 'Clean execution'}

def order_db():
    """Independent durable mock tool storage, not in the runtime's SQLite transaction."""
    return Path(os.getenv('BRACE_ORDER_DB', str(DB.with_name('mock_orders.sqlite3'))))

def order_connect():
    path = order_db()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(path), timeout=20)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA busy_timeout=20000')
    return connection

def place_mock_order(rid, key, item='blue-notebook'):
    """Commit the mock side effect before the runtime acknowledges its outcome."""
    with order_connect() as external:
        external.execute('INSERT OR IGNORE INTO orders(run_id,idem_key,item,created_at) VALUES(?,?,?,?)', (rid, key, item, time.time()))
        return dict(external.execute('SELECT * FROM orders WHERE run_id=? AND idem_key=?', (rid, key)).fetchone())

def verify_mock_order(rid, key):
    with order_connect() as external:
        match = external.execute('SELECT * FROM orders WHERE run_id=? AND idem_key=?', (rid, key)).fetchone()
        return dict(match) if match else None

def list_mock_orders(rid):
    with order_connect() as external:
        return [dict(row) for row in external.execute('SELECT id, idem_key, item, created_at FROM orders WHERE run_id=? ORDER BY id', (rid,))]

def connect():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(DB), timeout=20)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA busy_timeout=20000')
    return c

def init():
    with order_connect() as external:
        external.execute('CREATE TABLE IF NOT EXISTS orders (\n   id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,\n   idem_key TEXT NOT NULL, item TEXT NOT NULL, created_at REAL NOT NULL,\n   UNIQUE(run_id, idem_key))')
    with connect() as c:
        c.execute('PRAGMA journal_mode=WAL')
        c.executescript("\n  CREATE TABLE IF NOT EXISTS runs (\n   id TEXT PRIMARY KEY, mode TEXT NOT NULL, scenario TEXT NOT NULL,\n   seed INTEGER NOT NULL, limit_cents INTEGER NOT NULL,\n   spent_cents INTEGER NOT NULL DEFAULT 0,\n   reserved_cents INTEGER NOT NULL DEFAULT 0,\n   step INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'idle',\n   created_at REAL NOT NULL, updated_at REAL NOT NULL\n  );\n  CREATE TABLE IF NOT EXISTS events (\n   id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,\n   ts REAL NOT NULL, type TEXT NOT NULL, step INTEGER NOT NULL,\n   payload TEXT NOT NULL\n  );\n  CREATE TABLE IF NOT EXISTS receipts (\n   id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,\n   ts REAL NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,\n   step INTEGER NOT NULL\n  );\n  CREATE TABLE IF NOT EXISTS checkpoints (\n   run_id TEXT PRIMARY KEY, next_step INTEGER NOT NULL,\n   saved_at REAL NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1\n  );\n  ")
        c.execute('CREATE INDEX IF NOT EXISTS ix_events_run ON events(run_id, id)')
        c.execute('CREATE INDEX IF NOT EXISTS ix_receipts_run ON receipts(run_id, id)')

def emit(c, rid, kind, step=-1, **payload):
    c.execute('INSERT INTO events(run_id,ts,type,step,payload) VALUES(?,?,?,?,?)', (rid, time.time(), kind, step, json.dumps(payload, sort_keys=True)))

def receipt(c, rid, decision, reason, step):
    c.execute('INSERT INTO receipts(run_id,ts,decision,reason,step) VALUES(?,?,?,?,?)', (rid, time.time(), decision, reason, step))
    emit(c, rid, 'decision_receipt', step, decision=decision, reason=reason)

def create(mode='brace', scenario='timeout', seed=42, limit=0.5):
    init()
    if mode not in ('brace', 'naive', 'plain', 'checkpoint'):
        raise ValueError('Invalid mode')
    if scenario not in SCENARIOS:
        raise ValueError('Invalid scenario')
    cents = round(float(limit) * 100)
    if cents < 1 or cents > 10000:
        raise ValueError('Budget must be $0.01–$100')
    rid = uuid.uuid4().hex[:14]
    now = time.time()
    with connect() as c:
        c.execute('INSERT INTO runs(id,mode,scenario,seed,limit_cents,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', (rid, mode, scenario, int(seed), cents, now, now))
        emit(c, rid, 'task_created', budget_cents=cents, mode=mode, scenario=scenario, seed=seed)
    return rid

def snapshot(rid):
    with connect() as c:
        r = c.execute('SELECT * FROM runs WHERE id=?', (rid,)).fetchone()
        if not r:
            raise KeyError(rid)
        d = dict(r)
        d['events'] = [{**dict(x), 'payload': json.loads(x['payload'])} for x in c.execute('SELECT * FROM events WHERE run_id=? ORDER BY id DESC', (rid,))]
        d['receipts'] = [dict(x) for x in c.execute('SELECT * FROM receipts WHERE run_id=? ORDER BY id DESC', (rid,))]
        d['order_records'] = list_mock_orders(rid)
        d['orders'] = len(d['order_records'])
        d['duplicates'] = max(0, d['orders'] - 1)
        d['lim'] = d['limit_cents'] / 100
        d['spent'] = d['spent_cents'] / 100
        d['reserved'] = d['reserved_cents'] / 100
        d['remaining'] = (d['limit_cents'] - d['spent_cents'] - d['reserved_cents']) / 100
        d['retries'] = len([x for x in d['events'] if x['type'] == 'retry_decided'])
        d['verification_count'] = len([x for x in d['events'] if x['type'] == 'verify_result'])
        d['checkpoint'] = next((dict(x) for x in c.execute('SELECT * FROM checkpoints WHERE run_id=?', (rid,))), None)
        return d

def mark_status(rid, status):
    with connect() as c:
        r = c.execute('SELECT status,step FROM runs WHERE id=?', (rid,)).fetchone()
        if not r:
            raise KeyError(rid)
        c.execute('UPDATE runs SET status=?,updated_at=? WHERE id=?', (status, time.time(), rid))
        emit(c, rid, 'task_' + status, r['step'])

def advance_one(rid):
    # BRACE mode has one authoritative execution path through BraceRuntime.execute.
    # Other modes remain explicit baseline simulations for the controlled comparison.
    state = snapshot(rid)
    if state['mode'] == 'brace':
        from .sdk_bridge import protected_step
        return protected_step(rid)
    """One runtime transaction per tool step; mock orders commit to a SEPARATE
 SQLite store, as an external side effect would. This is NOT a network service
 and does not establish exactly-once execution guarantees.
 """
    with connect() as c:
        c.execute('BEGIN IMMEDIATE')
        r = c.execute('SELECT * FROM runs WHERE id=?', (rid,)).fetchone()
        if not r or r['status'] != 'running':
            return False
        s = r['step']
        if s >= 5:
            return False
        mode = r['mode']
        protected = mode == 'brace'
        scenario = r['scenario']
        cost = COST_CENTS[s]
        finish_reserve = 2 if s < 4 else 0
        if protected and r['spent_cents'] + cost + finish_reserve > r['limit_cents']:
            emit(c, rid, 'budget_denied', s, estimate_cents=cost, finish_reserve_cents=finish_reserve)
            receipt(c, rid, 'deny_call', 'Call blocked before dispatch: estimated cost and finishing reserve exceed remaining budget.', s)
            c.execute("UPDATE runs SET status='paused',updated_at=? WHERE id=?", (time.time(), rid))
            emit(c, rid, 'task_paused', s, reason='budget')
            return False
        if scenario == 'loop' and s == 1 and protected:
            signature = 'search_catalog:blue-notebook'
            for observation in range(3):
                seen = c.execute("SELECT COUNT(*) FROM events WHERE run_id=? AND type='loop_observation' AND json_extract(payload,'$.signature')=?", (rid, signature)).fetchone()[0]
                if seen >= 3:
                    break
                loop_cost = 2
                if r['spent_cents'] + observation * loop_cost + loop_cost + 2 > r['limit_cents']:
                    emit(c, rid, 'budget_denied', s, estimate_cents=loop_cost)
                    receipt(c, rid, 'deny_call', 'Loop call denied by remaining budget.', s)
                    c.execute("UPDATE runs SET status='paused',updated_at=? WHERE id=?", (time.time(), rid))
                    return False
                emit(c, rid, 'call_dispatched', s, tool='search_catalog', attempt=observation + 1, loop_probe=True)
                catalog_result = Catalog().search('blue notebook')
                emit(c, rid, 'call_succeeded', s, tool='search_catalog', loop_probe=True, result_count=len(catalog_result))
                emit(c, rid, 'loop_observation', s, signature=signature, progress_hash='unchanged', repeat=seen + 1)
            repeats = c.execute("SELECT COUNT(*) FROM events WHERE run_id=? AND type='loop_observation' AND json_extract(payload,'$.signature')=?", (rid, signature)).fetchone()[0]
            if repeats >= 3:
                c.execute('UPDATE runs SET spent_cents=spent_cents+?,updated_at=? WHERE id=?', (repeats * 2, time.time(), rid))
                emit(c, rid, 'loop_detected', s, threshold=3, observed_calls=repeats)
                receipt(c, rid, 'pause_loop', 'Three actual identical catalog reads with no progress. Further calls blocked.', s)
                c.execute("UPDATE runs SET status='paused',updated_at=? WHERE id=?", (time.time(), rid))
                emit(c, rid, 'task_paused', s, reason='loop_guard')
                return False
        side_effect = 'dangerous' if s == 2 else 'read-only' if s < 2 else 'idempotent'
        emit(c, rid, 'action_pending', s, tool=STEPS[s], side_effect=side_effect)
        if protected:
            c.execute('UPDATE runs SET reserved_cents=? WHERE id=?', (cost, rid))
            emit(c, rid, 'budget_reserved', s, amount_cents=cost)
        emit(c, rid, 'call_dispatched', s, tool=STEPS[s], attempt=1)
        if scenario in ('server', 'rate') and s == 0:
            code = 500 if scenario == 'server' else 429
            attempts = 1 + (r['seed'] + 1) % 2 if code == 500 else 1
            for a in range(attempts):
                emit(c, rid, 'call_failed', s, status_code=code, attempt=a + 1)
                if mode != 'plain':
                    remaining = (r['limit_cents'] - r['spent_cents']) / 100
                    allowed, why = retry_value_test(kind='server_error' if code == 500 else 'rate_limit', state_safe=True, retries_used=a, max_retries=3, remaining=remaining, estimate=cost / 100, min_reserve=0.02)
                    if protected and (not allowed):
                        emit(c, rid, 'retry_decided', s, decision='stop', reason=why)
                        receipt(c, rid, 'pause_retry', why, s)
                        c.execute("UPDATE runs SET status='paused',reserved_cents=0 WHERE id=?", (rid,))
                        return False
                    delay = round(min(0.12, backoff_seconds(a + 1, base=0.04, cap=0.12)), 3)
                    emit(c, rid, 'retry_decided', s, reason=why if protected else 'naive retry', attempt=a + 2, backoff_ms=int(delay * 1000))
                    if protected:
                        receipt(c, rid, 'bounded_retry', f'Read-only catalog call returned {code}; retry authorized by budget and retry policy.', s)
                    started = time.monotonic()
                    time.sleep(delay)
                    emit(c, rid, 'retry_wait_elapsed', s, actual_ms=int((time.monotonic() - started) * 1000))
                    emit(c, rid, 'call_dispatched', s, tool=STEPS[s], attempt=a + 2)
                else:
                    emit(c, rid, 'call_failed_final', s, status_code=code)
                    c.execute("UPDATE runs SET status='failed',reserved_cents=0 WHERE id=?", (rid,))
                    return False
        if scenario == 'timeout' and s == 2:
            key = f'{rid}:place_order' if protected else f'{rid}:attempt-1'
            committed_before_timeout = r['seed'] % 5 != 0
            if committed_before_timeout:
                place_mock_order(rid, key)
            emit(c, rid, 'call_timeout', s, after_effect=committed_before_timeout)
            emit(c, rid, 'action_unknown', s, reason='Response lost; external outcome requires reconciliation')
            if protected:
                emit(c, rid, 'verify_started', s, idem_key=key)
                found = verify_mock_order(rid, key)
                if found:
                    emit(c, rid, 'verify_result', s, outcome='succeeded', order_id=found['id'], idem_key=key)
                    receipt(c, rid, 'skip_retry', f"Independent mock store contains order #{found['id']} for {key}; not retried.", s)
                else:
                    emit(c, rid, 'verify_result', s, outcome='failed', idem_key=key)
                    remaining = (r['limit_cents'] - r['spent_cents']) / 100
                    allowed, reason = retry_value_test(kind='timeout', state_safe=True, retries_used=0, max_retries=3, remaining=remaining, estimate=cost / 100, min_reserve=0.02)
                    if not allowed:
                        receipt(c, rid, 'pause_retry', reason, s)
                        c.execute("UPDATE runs SET status='paused',reserved_cents=0 WHERE id=?", (rid,))
                        return False
                    emit(c, rid, 'retry_decided', s, reason=reason, attempt=2)
                    emit(c, rid, 'call_dispatched', s, tool='place_order', attempt=2)
                    place_mock_order(rid, key)
                    receipt(c, rid, 'verified_retry', 'Independent mock store confirmed no order; retry used same idempotency key.', s)
            else:
                emit(c, rid, 'retry_decided', s, reason='unverified timeout; blind retry')
                emit(c, rid, 'call_dispatched', s, tool='place_order', attempt=2)
                place_mock_order(rid, f'{rid}:attempt-2')
                receipt(c, rid, 'unsafe_retry', 'Blind retry attempted without verifying external state.', s)
        elif s == 2:
            place_mock_order(rid, f'{rid}:order')
        emit(c, rid, 'call_succeeded', s, tool=STEPS[s], reconciled=scenario == 'timeout' and s == 2 and protected)
        if protected:
            emit(c, rid, 'budget_settled', s, amount_cents=cost)
        c.execute('UPDATE runs SET step=step+1,spent_cents=spent_cents+?,reserved_cents=0,updated_at=? WHERE id=?', (cost, time.time(), rid))
        c.execute('INSERT INTO checkpoints(run_id,next_step,saved_at) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET next_step=excluded.next_step,saved_at=excluded.saved_at', (rid, s + 1, time.time()))
        emit(c, rid, 'checkpoint_saved', s, next_step=s + 1)
        if s == 4:
            c.execute("UPDATE runs SET status='completed' WHERE id=?", (rid,))
            emit(c, rid, 'task_completed', s, spent_cents=r['spent_cents'] + cost)
        return True

def worker(rid, delay=0.5):
    """Run in a separate OS process: S5 uses os._exit to prove restart works."""
    state = snapshot(rid)
    if state['status'] not in ('idle', 'interrupted'):
        raise ValueError('Worker already active or not resumable')
    if state['status'] == 'interrupted':
        with connect() as c:
            emit(c, rid, 'task_resumed', state['step'], checkpoint_step=state['checkpoint']['next_step'] if state['checkpoint'] else 0)
    mark_status(rid, 'running')
    while True:
        d = snapshot(rid)
        if d['status'] != 'running' or d['step'] >= 5:
            break
        time.sleep(delay)
        progressed = advance_one(rid)
        if not progressed:
            break
        d = snapshot(rid)
        if d['scenario'] == 'crash' and d['step'] == 3 and (not any((x['type'] in ('worker_os_exit', 'bench_crash_injected') for x in d['events']))):
            with connect() as c:
                emit(c, rid, 'worker_os_exit', 2, checkpoint_step=3, exit_code=31)
            os._exit(31)

def reset():
    init()
    with connect() as c:
        c.executescript('DELETE FROM checkpoints;DELETE FROM receipts;DELETE FROM events;DELETE FROM runs;')
    with order_connect() as external:
        external.execute('DELETE FROM orders')
    sdk_db = DB.with_name(DB.stem + '_sdk.sqlite3')
    if sdk_db.exists():
        sdk_db.unlink()
