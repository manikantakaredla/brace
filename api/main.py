"""Control plane, process supervisor and event streaming for the demo."""
import asyncio, json, os, subprocess, sys, threading
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from . import engine as e
e.init()
app = FastAPI(title='BRACE — Engineering Evaluation API', version='2.1.0')

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r'https?://.*',
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
    expose_headers=['*'],
)

@app.get('/')
def root():
    return {
        'service': 'BRACE — Engineering Evaluation API',
        'status': 'healthy',
        'version': '2.1.0',
        'health': '/api/health',
        'docs': '/docs',
        'frontend': 'https://brace-kappa.vercel.app/'
    }
processes = {}
gate = threading.RLock()

class CreateRequest(BaseModel):
    mode: str = 'brace'
    scenario: str = 'timeout'
    seed: int = 42
    limit: float = Field(default=0.5, ge=0.01, le=100)

def refresh(rid):
    with gate:
        p = processes.get(rid)
        if p and p.poll() is not None:
            d = e.snapshot(rid)
            if d['status'] == 'running':
                e.mark_status(rid, 'interrupted')
            processes.pop(rid, None)

def state(rid):
    try:
        refresh(rid)
        return e.snapshot(rid)
    except KeyError:
        raise HTTPException(404, 'Run not found')

@app.get('/api/health')
def health():
    return {'ok': True, 'version': '2.1.0', 'scenarios': e.SCENARIOS}

@app.get('/api/runs')
def list_runs():
    with e.connect() as c:
        ids = [x['id'] for x in c.execute('SELECT id FROM runs ORDER BY created_at DESC LIMIT 40')]
    return [state(x) for x in ids]

@app.post('/api/runs')
def create(req: CreateRequest):
    try:
        return {'id': e.create(**req.model_dump())}
    except ValueError as ex:
        raise HTTPException(400, str(ex))

@app.get('/api/runs/{rid}')
def read(rid: str):
    return state(rid)

def launch(rid, allowed):
    with gate:
        d = state(rid)
        if d['status'] not in allowed:
            raise HTTPException(409, f"Cannot launch run with status {d['status']}")
        p = subprocess.Popen([sys.executable, '-m', 'brace.api.worker', rid], cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__))), env=os.environ.copy())
        processes[rid] = p
        return {'started': True, 'pid': p.pid, 'id': rid}

@app.post('/api/runs/{rid}/start')
def start(rid: str):
    return launch(rid, ('idle',))

@app.post('/api/runs/{rid}/resume')
def resume(rid: str):
    return launch(rid, ('interrupted',))

@app.post('/api/runs/{rid}/kill')
def kill(rid: str):
    with gate:
        p = processes.get(rid)
        if not p or p.poll() is not None:
            raise HTTPException(409, 'No active worker to terminate')
        p.kill()
        p.wait(timeout=5)
        e.mark_status(rid, 'interrupted')
        processes.pop(rid, None)
        return {'killed': True, 'run_id': rid, 'checkpoint': state(rid)['checkpoint']}

@app.get('/api/runs/{rid}/events')
async def events(rid: str):
    state(rid)

    async def generate():
        last = None
        while True:
            d = state(rid)
            marker = (d['status'], len(d['events']))
            if marker != last:
                last = marker
                yield ('data: ' + json.dumps(d, separators=(',', ':')) + '\n\n')
            else:
                yield ': keepalive\n\n'
            await asyncio.sleep(0.3)
    return StreamingResponse(
        generate(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        }
    )

@app.post('/api/reset')
def reset():
    with gate:
        for p in processes.values():
            if p.poll() is None:
                p.kill()
                p.wait(timeout=5)
        processes.clear()
        e.reset()
    return {'reset': True}

@app.get('/api/runs/{rid}/evidence')
def evidence(rid: str):
    d = state(rid)
    return Response(json.dumps(d, indent=2), media_type='application/json', headers={'Content-Disposition': f'attachment; filename="brace-{rid}-evidence.json"'})

@app.get('/api/benchmarks')
def benchmarks():
    from pathlib import Path
    fp = Path(__file__).resolve().parents[1] / 'data' / 'benchmarks.json'
    if fp.is_file():
        return json.loads(fp.read_text(encoding='utf-8'))
    return {'trials': 0, 'generated_at': None, 'results': [], 'notes': 'Run python -m brace.bench.run_bench --trials 30 to generate measured data.'}
