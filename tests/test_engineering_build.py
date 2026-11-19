"""Acceptance tests for the engineering evaluation edition."""
import os, subprocess, sys
from pathlib import Path
import pytest
from brace.api import engine as e

@pytest.fixture(autouse=True)
def isolated_db(tmp_path,monkeypatch):
 monkeypatch.setattr(e,'DB',tmp_path/'verify.sqlite3');e.init()

def test_timeout_verified_and_no_duplicate():
 rid=e.create(mode='brace',scenario='timeout');e.worker(rid,0)
 d=e.snapshot(rid)
 assert d['status']=='completed' and d['orders']==1 and d['duplicates']==0
 assert any(x['type']=='verify_result' for x in d['events'])
 assert not any(x['type']=='retry_decided' and x['step']==2 for x in d['events'])

def test_unprotected_retries_and_duplicates():
 rid=e.create(mode='naive',scenario='timeout');e.worker(rid,0)
 d=e.snapshot(rid)
 assert d['orders']==2 and d['duplicates']==1

def test_budget_denies_prior_to_dispatch():
 rid=e.create(mode='brace',scenario='budget',limit=.12);e.worker(rid,0)
 d=e.snapshot(rid)
 assert d['status']=='paused'
 assert any(x['type']=='budget_denied' and x['step']==2 for x in d['events'])
 assert not any(x['type']=='call_dispatched' and x['step']==2 for x in d['events'])
 assert d['spent_cents']<=d['limit_cents']

def test_loop_stops_execution():
 rid=e.create(mode='brace',scenario='loop');e.worker(rid,0)
 d=e.snapshot(rid)
 assert d['status']=='paused' and d['step']==1
 assert any(x['type']=='loop_detected' for x in d['events'])

def test_real_os_process_exit_and_resume():
 rid=e.create(mode='brace',scenario='crash');env=dict(os.environ,BRACE_DB=str(e.DB))
 p=subprocess.run([sys.executable,'-m','brace.api.worker',rid,'--delay','0'],env=env,capture_output=True)
 assert p.returncode==31,p.stderr.decode()
 d=e.snapshot(rid)
 assert d['step']==3 and d['orders']==1 and d['checkpoint']['next_step']==3
 e.mark_status(rid,'interrupted')
 p2=subprocess.run([sys.executable,'-m','brace.api.worker',rid,'--delay','0'],env=env,capture_output=True)
 assert p2.returncode==0,p2.stderr.decode()
 d=e.snapshot(rid)
 assert d['step']==5 and d['orders']==1 and d['status']=='completed'
 assert len([x for x in d['events'] if x['type']=='call_dispatched' and x['step']==2])==1

def test_retries_bounded():
 for scenario,count in [('server',2),('rate',1)]:
  rid=e.create(mode='brace',scenario=scenario);e.worker(rid,0)
  d=e.snapshot(rid)
  assert d['status']=='completed' and d['retries']==count

def test_data_persists_across_connections():
 rid=e.create(mode='brace',scenario='normal');e.worker(rid,0)
 assert e.snapshot(rid)['checkpoint']['next_step']==5
 with e.connect() as c:
  assert c.execute('SELECT COUNT(*) FROM events WHERE run_id=?',(rid,)).fetchone()[0]>10
