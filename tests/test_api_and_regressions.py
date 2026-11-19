"""Critical integration checks for the evidence and policy adapter."""
import pytest

PYTEST_ONLY = True
from fastapi.testclient import TestClient
from brace.api import engine
from brace.api.main import app, processes


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, 'DB', tmp_path / 'runtime.sqlite3')
    processes.clear()
    engine.init()


def test_api_input_validation_and_404():
    with TestClient(app) as client:
        assert client.get('/api/health').status_code == 200
        assert client.post('/api/runs', json={'mode':'invalid'}).status_code == 400
        assert client.post('/api/runs', json={'limit':0}).status_code == 422
        assert client.get('/api/runs/missing').status_code == 404


def test_api_create_read_and_evidence():
    with TestClient(app) as client:
        result=client.post('/api/runs',json={'scenario':'timeout','seed':42}).json()
        rid=result['id']
        engine.worker(rid,0)
        snapshot=client.get(f'/api/runs/{rid}')
        assert snapshot.status_code==200
        assert snapshot.json()['orders']==1
        evidence=client.get(f'/api/runs/{rid}/evidence')
        assert evidence.status_code==200
        assert evidence.json()['status']=='completed'


def test_timeout_can_be_verified_not_committed():
    rid=engine.create(scenario='timeout',seed=40)
    engine.worker(rid,0)
    state=engine.snapshot(rid)
    assert state['orders']==1 and state['duplicates']==0
    events=state['events']
    assert any(x['type']=='verify_result' and x['payload']['outcome']=='failed' for x in events)
    assert any(x['type']=='retry_decided' and x['step']==2 for x in events)


def test_order_side_effect_has_independent_database(tmp_path):
    rid=engine.create(scenario='timeout',seed=42)
    engine.worker(rid,0)
    assert engine.DB != engine.order_db()
    assert engine.order_db().exists()
    with engine.connect() as runtime:
        assert not runtime.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'").fetchone()
    with engine.order_connect() as external:
        assert external.execute('SELECT COUNT(*) FROM orders WHERE run_id=?',(rid,)).fetchone()[0]==1


def test_retry_wait_is_real_and_loop_calls_are_dispatched():
    r=engine.create(scenario='server',seed=42)
    engine.worker(r,0)
    events=engine.snapshot(r)['events']
    assert len([e for e in events if e['type']=='retry_wait_elapsed'])==2
    assert all(e['payload']['actual_ms'] >= 30 for e in events if e['type']=='retry_wait_elapsed')
    r=engine.create(scenario='loop',seed=42)
    engine.worker(r,0)
    state=engine.snapshot(r)
    assert state['status']=='paused'
    assert len([e for e in state['events'] if e['type']=='call_dispatched' and e['payload'].get('loop_probe')])==3


def test_dashboard_protected_run_invokes_sdk_execute(monkeypatch):
    """Regression: the API's engine must never bypass BraceRuntime.execute in BRACE mode."""
    from brace.sdk.runtime import BraceRuntime
    calls = []
    original = BraceRuntime.execute

    def traced_execute(self, spec, fn, args, kwargs):
        calls.append(spec.name)
        return original(self, spec, fn, args, kwargs)

    monkeypatch.setattr(BraceRuntime, 'execute', traced_execute)
    rid = engine.create(mode='brace', scenario='timeout', seed=42)
    engine.worker(rid, 0)
    snap = engine.snapshot(rid)
    assert snap['status'] == 'completed'
    assert calls == ['search_catalog', 'check_stock', 'place_order',
                     'send_confirmation', 'finish']
    assert all(any(event['payload'].get('origin') == 'BraceRuntime.execute'
                       for event in snap['events'] if event['type'] == name)
               for name in ('action_pending', 'budget_reserved', 'verify_result'))


def test_sdk_durable_log_persists_across_worker_steps():
    """The protected event ledger is persistent and budget is not reset per step."""
    from brace.api.sdk_bridge import runtime_for, sdk_path
    rid = engine.create(mode='brace', scenario='normal', seed=42)
    engine.worker(rid, 0)
    final = engine.snapshot(rid)
    assert final['status'] == 'completed'
    rt = runtime_for(final)
    assert sdk_path().exists()
    assert len([event for event in rt.events()
                if event['type'] == 'task_created']) == 1
    assert len([event for event in rt.events()
                if event['type'] == 'call_dispatched']) == 5
    assert round(rt.budget_state()['spent'], 2) == .29
    assert len([event for event in final['events']
                if event['payload'].get('origin') == 'BraceRuntime.execute']) > 15
