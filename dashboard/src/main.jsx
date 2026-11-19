import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowRight, Check, ChevronRight, CircleAlert, CircleDot, ClipboardList, Database, FileJson, Gauge, GitBranch, HardDrive, Play, RotateCcw, Shield, Square, Terminal, Workflow, X } from 'lucide-react';
import './style.css';

const RAW_BACKEND = (import.meta.env.VITE_API_URL || 'https://brace-api-y8ha.onrender.com').trim().replace(/\/+$/, '');
const API = RAW_BACKEND.endsWith('/api') ? RAW_BACKEND : `${RAW_BACKEND}/api`;

const scenarios = [
    ['timeout', 'S1 · Lost response', 'Create order, then drop the acknowledgement.'],
    ['server', 'S2 · HTTP 500', 'Two transient failures during catalog lookup.'],
    ['rate', 'S3 · Rate limit', 'HTTP 429 with a bounded retry.'],
    ['budget', 'S4 · Budget limit', 'Deny an unaffordable order operation.'],
    ['crash', 'S5 · Worker crash', 'Worker exits at checkpoint three.'],
    ['loop', 'S6 · No progress', 'Repeated calls trigger a loop guard.'],
    ['normal', 'S7 · Control run', 'Baseline with no injected faults.'],
];
const steps = ['search_catalog', 'check_stock', 'place_order', 'send_confirmation', 'finish'];
async function api(url, body) {
    let r = await fetch(API + url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!r.ok) {
        let s = await r.text();
        throw Error(s.slice(0, 220));
    }
    return r.json();
}
const money = n => '$' + Number(n || 0).toFixed(2);
const fmtTime = x => new Date(x * 1000).toLocaleTimeString(undefined, { hour12: false });
const cls = (s = '') => ['completed', 'succeeded'].includes(s) ? 'good' : ['failed', 'interrupted'].includes(s) ? 'bad' : ['paused', 'running'].includes(s) ? 'warn' : 'neutral';

function App() {
    const [page, setPage] = useState('executions'), [scenario, setScenario] = useState('timeout'), [seed, setSeed] = useState(42), [limit, setLimit] = useState(.5), [ids, setIds] = useState({}), [runs, setRuns] = useState({}), [selectedRun, setSelectedRun] = useState('brace'), [selectedEvent, setSelectedEvent] = useState(null), [filter, setFilter] = useState('all'), [busy, setBusy] = useState(false), [message, setMessage] = useState('Ready. Connected to BRACE runtime API.'), [health, setHealth] = useState(false), [benchmark, setBenchmark] = useState(null);

    useEffect(() => {
        const checkHealth = () => api('/health').then(() => setHealth(true)).catch(() => setHealth(false));
        checkHealth();
        api('/benchmarks').then(setBenchmark).catch(() => { });
        const interval = setInterval(checkHealth, 15000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        let connections = Object.entries(ids).map(([mode, id]) => {
            let es = new EventSource(`${API}/runs/${id}/events`);
            es.onmessage = e => {
                try {
                    const data = JSON.parse(e.data);
                    setRuns(prev => ({ ...prev, [mode]: data }));
                    if (['completed', 'failed', 'safe_stop', 'budget_exhausted'].includes(data.status)) {
                        es.close();
                    }
                } catch { }
            };
            es.onerror = () => {
                api(`/runs/${id}`).then(finalData => {
                    setRuns(prev => ({ ...prev, [mode]: finalData }));
                }).catch(() => { });
            };
            return es;
        });
        return () => connections.forEach(e => e.close());
    }, [ids.naive, ids.brace]);

    const safe = runs.brace, unsafe = runs.naive, active = runs[selectedRun];

    async function run() {
        setBusy(true); setRuns({}); setIds({}); setSelectedEvent(null);
        try {
            let a = await api('/runs', { mode: 'naive', scenario, seed: Number(seed), limit: Number(limit) });
            let b = await api('/runs', { mode: 'brace', scenario, seed: Number(seed), limit: Number(limit) });
            setIds({ naive: a.id, brace: b.id });
            await Promise.all([api(`/runs/${a.id}/start`, {}), api(`/runs/${b.id}/start`, {})]);
            setPage('executions');
            setMessage(`Started paired runs • seed ${seed}`);
        } catch (e) {
            setMessage(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function reset() {
        setBusy(true);
        try {
            await api('/reset', {});
            setRuns({}); setIds({});
            setMessage('Database cleared; ready for a new experiment.');
        } catch (e) {
            setMessage(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function action(mode, which) {
        try {
            let o = await api(`/runs/${ids[mode]}/${which}`, {});
            setMessage(which === 'kill' ? `Worker ${mode} terminated. Checkpoint persisted.` : `Restarted ${mode} worker from last committed step. PID ${o.pid}`);
        } catch (e) {
            setMessage(e.message);
        }
    }

    function download() {
        if (!active) return;
        let blob = new Blob([JSON.stringify(active, null, 2)], { type: 'application/json' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        a.href = url;
        a.download = `brace-evidence-${active.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    const eventList = (active?.events || []).filter(e => filter === 'all' || e.type.includes(filter));

    return <div className="shell">
        <aside className="sidebar">
            <div className="brand"><div className="brand-symbol"><GitBranch size={20} /></div><div><strong>BRACE</strong><small>EXECUTION RUNTIME</small></div><span className="brand-version">v2</span></div>
            <div className="nav-section">WORKSPACE</div>
            {[['executions', Activity, 'Executions'], ['inspect', GitBranch, 'Execution inspector'], ['orders', Database, 'Mock order ledger'], ['benchmarks', Gauge, 'Evaluation'], ['about', ClipboardList, 'Architecture & limits']].map(([id, Icon, label]) => <button key={id} className={'nav ' + (page === id ? 'current' : '')} onClick={() => setPage(id)}><Icon size={16} />{label}{page === id && <ChevronRight size={14} className="nav-chevron" />}</button>)}
            <div className="sidebar-bottom">
                <div className="side-meta">
                    <span className={`dot ${health ? 'good-dot' : 'bad-dot'}`} />
                    <span className={health ? 'health-good' : 'health-bad'}>
                        {health ? 'API Connected' : 'Connecting to API...'}
                    </span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: '10px', color: '#728192' }}>
                    Endpoint:<br />
                    <code style={{ fontSize: '10px', color: '#9bb8d7', wordBreak: 'break-all' }}>
                        {API.replace('/api', '')}
                    </code>
                </p>
            </div>
        </aside>
        <div className="body">
            <main className="main">
                <div className="page-heading"><div><div className="page-eyebrow">RELIABILITY ENGINEERING / EXPERIMENT 001</div><h1>{({ executions: 'Execution overview', inspect: 'Execution inspector', orders: 'Mock order ledger', benchmarks: 'Evaluation results', about: 'System architecture' })[page]}</h1><p>{({ executions: 'Compare an unprotected workflow with BRACE under identical injected faults.', inspect: 'Inspect raw events, decisions, timing, and persisted checkpoints.', orders: 'Inspect mock effects committed in a separate SQLite ledger.', benchmarks: 'Measured outcomes from reproducible controlled trials—not claimed production benchmarks.', about: 'Transparent architecture, evidence, and known limitations.' })[page]}</p></div><div className="heading-meta">PROJECT BRACE <span>/</span> BUILD 2.1</div></div>
                {(page === 'executions' || page === 'inspect') && <>
                    <section className="panel controls"><div className="control-item scenario-control"><label>FAULT SCENARIO</label><select value={scenario} onChange={e => { setScenario(e.target.value); setLimit(e.target.value === 'budget' ? .12 : .5) }}>{scenarios.map(x => <option value={x[0]} key={x[0]}>{x[1]}</option>)}</select></div><div className="control-item small-control"><label>SEED</label><input type="number" value={seed} onChange={e => setSeed(e.target.value)} /></div><div className="control-item small-control"><label>BUDGET (USD)</label><input type="number" min="0.01" max="100" step="0.01" value={limit} onChange={e => setLimit(e.target.value)} /></div><button className="primary-btn" onClick={run} disabled={busy}><Play size={15} /> Run comparison</button><button className="icon-btn" onClick={reset} disabled={busy} title="Reset all data"><RotateCcw size={17} /></button></section>
                    <div className="hint-line"><CircleAlert size={15} /><span>{scenarios.find(x => x[0] === scenario)?.[2]}</span><span className="hint-msg">{message}</span></div>
                    {page === 'executions' && <><div className="summary-row"><Stat label="Protected status" value={safe?.status || 'Not started'} detail="Current execution" status={cls(safe?.status)} /><Stat label="Committed orders" value={safe?.orders ?? '—'} detail="BRACE ledger count" /><Stat label="Duplicate side effects" value={safe?.duplicates ?? '—'} detail="Protected workflow" status={safe?.duplicates === 0 ? 'good' : 'neutral'} /><Stat label="Budget consumed" value={safe ? money(safe.spent) : '—'} detail={safe ? `${money(safe.remaining)} remaining` : 'Not started'} /></div><div className="section-heading"><h2>Paired execution</h2><span>Same scenario · same seed · different recovery policy</span></div><div className="comparison"><RunPanel run={unsafe} label="BASELINE" headline="Unprotected agent" mode="naive" onSelect={() => { setSelectedRun('naive'); setPage('inspect') }} onKill={() => action('naive', 'kill')} onResume={() => action('naive', 'resume')} /><RunPanel run={safe} label="CONTROLLED" headline="BRACE runtime" mode="brace" onSelect={() => { setSelectedRun('brace'); setPage('inspect') }} onKill={() => action('brace', 'kill')} onResume={() => action('brace', 'resume')} /></div></>}
                    {page === 'inspect' && <div className="inspector-layout"><div className="panel inspector-main"><div className="panel-header"><div><h2>Event history</h2><p>Append-only SQLite log • Newest first</p></div><div className="right-actions"><select value={selectedRun} onChange={e => { setSelectedRun(e.target.value); setSelectedEvent(null) }}><option value="brace">BRACE run</option><option value="naive">Baseline run</option></select><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All events</option><option value="call">Calls</option><option value="budget">Budget</option><option value="verify">Verification</option><option value="checkpoint">Checkpoints</option><option value="decision">Decisions</option></select></div></div><div className="table-wrap"><table><thead><tr><th>TIME</th><th>EVENT</th><th>STEP</th><th>DETAIL</th></tr></thead><tbody>{eventList.length ? eventList.map(e => <tr key={e.id} className={selectedEvent?.id === e.id ? 'row-selected' : ''} onClick={() => setSelectedEvent(e)}><td className="mono muted">{fmtTime(e.ts)}</td><td><EventPill type={e.type} /></td><td className="mono">{e.step >= 0 ? steps[e.step] : '—'}</td><td className="ellipsed">{Object.entries(e.payload || {}).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(' • ') || '—'}</td></tr>) : <tr><td colSpan="4" className="empty-cell">No events. Start an experiment.</td></tr>}</tbody></table></div></div><div className="panel inspection-side"><div className="panel-header"><div><h2>Event details</h2><p>Raw evidence</p></div></div><div className="detail-pane">{selectedEvent ? <><div className="detail-title">{selectedEvent.type}</div><div className="detail-sub">Event ID {selectedEvent.id} · {fmtTime(selectedEvent.ts)}</div><pre>{JSON.stringify(selectedEvent, null, 2)}</pre></> : <div className="subtle-empty">Select an event to inspect its complete persisted payload.</div>}</div><div className="detail-footer"><button className="secondary-btn" onClick={download} disabled={!active}><ArrowDownToLine size={15} /> Export complete evidence</button></div></div></div>}
                    <div className="bottom-grid"><div className="panel"><div className="panel-header"><div><h2>Latest decision receipts</h2><p>Human-readable recovery policy decisions</p></div><span className="minor-count">{safe?.receipts?.length || 0} records</span></div><div className="receipt-list">{safe?.receipts?.length ? safe.receipts.slice(0, 5).map(r => <div className="receipt" key={r.id}><div className="receipt-dot" /><div><b>{r.decision.replaceAll('_', ' ')}</b><p>{r.reason}</p><small>{fmtTime(r.ts)} · step {r.step + 1}</small></div></div>) : <div className="subtle-empty">Policy receipts will appear after a protected run.</div>}</div></div><div className="panel"><div className="panel-header"><div><h2>Execution budget</h2><p>Real ledger totals from SQLite</p></div><span className="budget-tag">USD</span></div><div className="budget-card"><div className="budget-main"><strong>{safe ? money(safe.spent) : '$0.00'}</strong><span>spent / {money(safe?.lim ?? limit)} limit</span></div><div className="budget-track"><span style={{ width: `${safe ? Math.min(100, (safe.spent / safe.lim) * 100) : 0}%` }} /></div><div className="budget-splits"><span>Reserved <b>{money(safe?.reserved)}</b></span><span>Available <b>{money(safe?.remaining ?? limit)}</b></span></div></div><div className="panel-footer"><button className="text-btn" onClick={() => { setSelectedRun('brace'); setPage('inspect') }}>Inspect budget events <ArrowRight size={14} /></button></div></div></div>
                </>}
                {page === 'orders' && <div className="panel"><div className="panel-header"><div><h2>Persistent mock order records</h2><p>Order effects are committed to a separate durable SQLite ledger, not inferred from agent responses.</p></div></div><div className="table-wrap"><table><thead><tr><th>RUN</th><th>ORDER ID</th><th>IDEMPOTENCY KEY</th><th>ITEM</th><th>CREATED</th></tr></thead><tbody>{[unsafe, safe].filter(Boolean).flatMap(r => r.order_records.map(o => <tr key={r.id + o.id}><td>{r.mode.toUpperCase()} <span className="muted mono">{r.id.slice(0, 7)}</span></td><td className="mono">#{o.id}</td><td className="mono">{o.idem_key}</td><td>{o.item}</td><td className="mono">{fmtTime(o.created_at)}</td></tr>)).length ? [unsafe, safe].filter(Boolean).flatMap(r => r.order_records.map(o => <tr key={r.id + o.id}><td>{r.mode.toUpperCase()} <span className="muted mono">{r.id.slice(0, 7)}</span></td><td className="mono">#{o.id}</td><td className="mono">{o.idem_key}</td><td>{o.item}</td><td className="mono">{fmtTime(o.created_at)}</td></tr>)) : <tr><td className="empty-cell" colSpan="5">Start the paired execution to produce order records.</td></tr>}</tbody></table></div><div className="info-box">In the lost-response scenario, the baseline generates two independent idempotency keys. BRACE checks the existing order key and does not dispatch a second order.</div></div>}
                {page === 'benchmarks' && <div className="panel"><div className="panel-header"><div><h2>Controlled benchmark output</h2><p>Results are loaded from local reproducible trials; no pre-filled performance claims.</p></div><button className="secondary-btn" onClick={() => api('/benchmarks').then(setBenchmark).catch(e => setMessage(e.message))}><RotateCcw size={14} /> Reload results</button></div>{benchmark?.results?.length ? <><div className="bench-meta">{benchmark.trials} trials per setup/scenario · {benchmark.generated_at} · deterministic mock</div><div className="table-wrap"><table><thead><tr><th>SETUP</th><th>SCENARIO</th><th>TRIALS</th><th>COMPLETED</th><th>SAFE STOPS</th><th>DUPLICATE ORDERS</th><th>BUDGET OVERRUNS</th><th>RESUME SUCCESS</th></tr></thead><tbody>{benchmark.results.map((r, i) => <tr key={i}><td>{r.mode}</td><td>{r.scenario}</td><td>{r.trials}</td><td>{r.completed}</td><td>{r.safe_stops ?? 0}</td><td>{r.duplicates}</td><td>{r.overruns}</td><td>{r.resumed}</td></tr>)}</tbody></table></div></> : <div className="empty-benchmark"><Terminal size={24} /><h3>No benchmark results loaded</h3><p>Run the benchmark command below, then reload this page. The dashboard does not invent measurements.</p><code>python -m brace.bench.run_bench --trials 30</code></div>}</div>}
                {page === 'about' && <div className="about-grid"><div className="panel about-card"><h2>Runtime data flow</h2><div className="flow-list">{[['01', 'Agent tool request', 'The caller requests a mock operation'], ['02', 'Policy & budget gate', 'Deny unaffordable dispatches and detect loops'], ['03', 'Dispatch & persist', 'Record action states in append-only SQLite events'], ['04', 'Reconcile unknown outcomes', 'Verify a dangerous action before retrying'], ['05', 'Checkpoint & continue', 'Persist completed steps and resume after OS process exit']].map(([n, a, b]) => <div className="flow-step" key={n}><span>{n}</span><div><b>{a}</b><p>{b}</p></div></div>)}</div></div><div className="panel about-card"><h2>Evaluation boundaries</h2><p>BRACE here is a single-host evaluation runtime with deterministic mock tools, no real payments, and no external agent network.</p><p>Mock orders are persisted in a separate SQLite ledger, but the mock is still local and does not model every real network or concurrency failure.</p><p>Real tools require idempotency keys, a reliable verification method, or human escalation. This demo makes no exactly-once guarantee for arbitrary external systems.</p><p>Only data produced by locally executed benchmarks should appear as measured results.</p></div></div>}
                <footer>BRACE · ENGINEERING EVALUATION BUILD <span>Deterministic faults. Inspectable evidence. Reproducible behavior.</span></footer>
            </main></div>
    </div>
}
function Stat({ label, value, detail, status }) { return <div className="stat panel"><span>{label}</span><strong className={status || ''}>{value}</strong><small>{detail}</small></div> }
function EventPill({ type }) { let kind = type.includes('failed') || type.includes('denied') || type.includes('exit') ? 'error' : type.includes('succeeded') || type.includes('completed') || type === 'verify_result' ? 'success' : type.includes('unknown') || type.includes('paused') || type.includes('timeout') ? 'warning' : 'ordinary'; return <span className={'event-pill ' + kind}>{type}</span> }
function RunPanel({ run, label, headline, mode, onSelect, onKill, onResume }) { return <section className="panel run-panel"><div className="run-header"><div><span className="run-label">{label}</span><h3>{headline}</h3></div><span className={'status-pill ' + cls(run?.status)}>{run?.status || 'idle'}</span></div><div className="run-id">RUN ID <span className="mono">{run?.id || 'not started'}</span></div><div className="step-list">{steps.map((step, i) => { const done = run && i < run.step, active = run && i === run.step && run.status === 'running'; return <div className={'step-line ' + (done ? 'done' : active ? 'active' : '')} key={step}><span className="step-indicator">{done ? <Check size={13} /> : String(i + 1).padStart(2, '0')}</span><span>{step}</span><span className="step-state">{done ? 'completed' : active ? 'running' : 'pending'}</span></div> })}</div><div className="run-kpis"><div><span>Orders</span><b>{run?.orders ?? '—'}</b></div><div><span>Duplicates</span><b className={(run?.duplicates || 0) > 0 ? 'bad' : 'good'}>{run?.duplicates ?? '—'}</b></div><div><span>Spent</span><b>{run ? money(run.spent) : '—'}</b></div></div><div className="run-actions"><button className="text-btn" onClick={onSelect}>Inspect history <ArrowRight size={14} /></button>{run?.status === 'running' && <button className="secondary-btn compact" onClick={onKill}><Square size={13} /> Kill worker</button>}{run?.status === 'interrupted' && <button className="secondary-btn compact" onClick={onResume}><RotateCcw size={13} /> Resume</button>}</div></section> }
createRoot(document.getElementById('root')).render(<App />);
