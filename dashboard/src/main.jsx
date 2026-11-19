import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Activity, ArrowDownToLine, ArrowRight, Check, ChevronRight,
    CircleAlert, Database, Gauge, GitBranch, Play, RotateCcw,
    Square, Terminal, ClipboardList
} from 'lucide-react';
import './style.css';

const RAW_BACKEND = (import.meta.env.VITE_API_URL || 'https://brace-api-y8ha.onrender.com').trim().replace(/\/+$/, '');
const API = RAW_BACKEND.endsWith('/api') ? RAW_BACKEND : `${RAW_BACKEND}/api`;

const SCENARIOS = {
    timeout: { id: 'timeout', label: 'S1 · Timeout after order commit', budget: 0.45, seed: 42, presets: [0.45, 0.20, 0.80], desc: 'Injected: dropped HTTP ack after order commit. Target: orders.sqlite3' },
    server:  { id: 'server',  label: 'S2 · HTTP 500 transient error', budget: 0.60, seed: 42, presets: [0.60, 0.30, 1.00], desc: 'Injected: two transient 500 responses during catalog search.' },
    rate:    { id: 'rate',    label: 'S3 · HTTP 429 rate limit',       budget: 0.50, seed: 42, presets: [0.50, 0.25, 0.80], desc: 'Injected: HTTP 429 response with Retry-After backoff.' },
    budget:  { id: 'budget',  label: 'S4 · Insufficient budget ($0.12)', budget: 0.12, seed: 42, presets: [0.12, 0.25, 0.50], desc: 'Injected: tool dispatch cost ($0.16) exceeds remaining budget.' },
    crash:   { id: 'crash',   label: 'S5 · Worker process crash',     budget: 0.38, seed: 42, presets: [0.38, 0.20, 0.60], desc: 'Injected: SIGKILL (exit 31) after order checkpoint.' },
    loop:    { id: 'loop',    label: 'S6 · Query loop (no progress)', budget: 0.75, seed: 42, presets: [0.75, 0.30, 1.20], desc: 'Injected: repeated identical queries with no state delta.' },
    normal:  { id: 'normal',  label: 'S7 · Nominal baseline',         budget: 0.30, seed: 42, presets: [0.30, 0.50, 1.00], desc: 'Nominal five-step workflow with zero injected faults.' }
};

const STEPS = [
    { name: 'search_catalog', cost: '$0.04' },
    { name: 'check_stock', cost: '$0.03' },
    { name: 'place_order', cost: '$0.16' },
    { name: 'send_confirmation', cost: '$0.05' },
    { name: 'finish', cost: '$0.01' },
];

async function api(url, body) {
    const fullUrl = `${API}${url.startsWith('/') ? url : '/' + url}`;
    const res = await fetch(fullUrl, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!res.ok) {
        let errText = '';
        try {
            const errJson = await res.json();
            errText = errJson.detail || JSON.stringify(errJson);
        } catch {
            errText = await res.text();
        }
        throw new Error(errText ? errText.slice(0, 180) : `HTTP ${res.status}`);
    }
    return res.json();
}

const money = n => {
    const num = Number(n);
    return '$' + (isNaN(num) ? '0.00' : num.toFixed(2));
};

const fmtTime = x => {
    if (x === null || x === undefined || isNaN(Number(x))) return '—';
    try {
        const d = new Date(Number(x) * 1000);
        return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
        return '—';
    }
};

const cls = (s = '') => ['completed', 'succeeded'].includes(s) ? 'good' : ['failed', 'interrupted'].includes(s) ? 'bad' : ['paused', 'running'].includes(s) ? 'warn' : '';

function App() {
    const [page, setPage] = useState('executions');
    const [execMode, setExecMode] = useState('comparative'); // 'comparative' | 'unprotected' | 'brace'
    const [scenario, setScenario] = useState('timeout');
    const [seed, setSeed] = useState(42);
    const [limit, setLimit] = useState(SCENARIOS.timeout.budget);
    const [ids, setIds] = useState({});
    const [runs, setRuns] = useState({});
    const [selectedRun, setSelectedRun] = useState('brace');
    const [selectedEvent, setSelectedEvent] = useState(null);
    const [filter, setFilter] = useState('all');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('Ready.');
    const [health, setHealth] = useState(false);
    const [benchmark, setBenchmark] = useState(null);

    const onSelectScenario = scKey => {
        setScenario(scKey);
        const sc = SCENARIOS[scKey];
        if (sc) {
            setLimit(sc.budget);
            setSeed(sc.seed);
        }
    };

    useEffect(() => {
        const checkHealth = () => api('/health').then(() => setHealth(true)).catch(() => setHealth(false));
        checkHealth();
        api('/benchmarks').then(setBenchmark).catch(() => { });
        const interval = setInterval(checkHealth, 15000);
        return () => clearInterval(interval);
    }, []);

    // Reliable polling — fetch run state every 1s until terminal, then one final fetch
    useEffect(() => {
        const TERMINAL = ['completed', 'succeeded', 'failed', 'interrupted'];
        const settled = {}; // track which modes are done
        let cancelled = false;

        async function fetchRun(mode, id) {
            try {
                const data = await api(`/runs/${id}`);
                if (cancelled) return;
                if (data && data.id) {
                    setRuns(prev => ({ ...prev, [mode]: data }));
                    if (TERMINAL.includes(data.status)) {
                        settled[mode] = true;
                    }
                }
            } catch { }
        }

        // Initial fetch immediately
        Object.entries(ids).forEach(([mode, id]) => {
            if (id) fetchRun(mode, id);
        });

        // Poll every 1s
        const timer = setInterval(() => {
            if (cancelled) return;
            let allDone = true;
            Object.entries(ids).forEach(([mode, id]) => {
                if (!id) return;
                if (settled[mode]) return;
                allDone = false;
                fetchRun(mode, id);
            });
            if (allDone && Object.keys(ids).length > 0) {
                clearInterval(timer);
            }
        }, 1000);

        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [ids.naive, ids.brace]);

    const safe = runs.brace;
    const unsafe = runs.naive;
    const currentScenario = SCENARIOS[scenario] || SCENARIOS.timeout;
    const active = runs[selectedRun] || (execMode === 'unprotected' ? unsafe : safe) || unsafe;

    async function run() {
        setBusy(true);
        setRuns({});
        setIds({});
        setSelectedEvent(null);

        const safeLimit = Math.max(0.01, Math.min(100, Number(limit) || 0.45));
        const safeSeed = Math.max(0, parseInt(seed, 10) || 42);

        try {
            if (execMode === 'comparative') {
                let a = await api('/runs', { mode: 'naive', scenario, seed: safeSeed, limit: safeLimit });
                let b = await api('/runs', { mode: 'brace', scenario, seed: safeSeed, limit: safeLimit });
                setIds({ naive: a.id, brace: b.id });
                await Promise.all([api(`/runs/${a.id}/start`, {}), api(`/runs/${b.id}/start`, {})]);
                setSelectedRun('brace');
                setMessage(`Started comparative runs · seed ${safeSeed}`);
            } else if (execMode === 'unprotected') {
                let r = await api('/runs', { mode: 'naive', scenario, seed: safeSeed, limit: safeLimit });
                setIds({ naive: r.id });
                await api(`/runs/${r.id}/start`, {});
                setSelectedRun('naive');
                setMessage(`Started baseline run · seed ${safeSeed}`);
            } else {
                let r = await api('/runs', { mode: 'brace', scenario, seed: safeSeed, limit: safeLimit });
                setIds({ brace: r.id });
                await api(`/runs/${r.id}/start`, {});
                setSelectedRun('brace');
                setMessage(`Started BRACE run · seed ${safeSeed}`);
            }
            setPage('executions');
        } catch (e) {
            setMessage(e.message || 'Failed to start execution.');
        } finally {
            setBusy(false);
        }
    }

    async function reset() {
        setBusy(true);
        try {
            await api('/reset', {});
            setRuns({});
            setIds({});
            setMessage('Database reset.');
        } catch (e) {
            setMessage(e.message || 'Reset failed.');
        } finally {
            setBusy(false);
        }
    }

    async function action(mode, which) {
        const targetId = ids[mode];
        if (!targetId) return;
        try {
            let o = await api(`/runs/${targetId}/${which}`, {});
            setMessage(which === 'kill' ? `Worker ${mode} terminated.` : `Worker ${mode} resumed (PID ${o.pid || '—'}).`);
        } catch (e) {
            setMessage(e.message || `Action ${which} failed.`);
        }
    }

    function download() {
        if (!active) return;
        let blob = new Blob([JSON.stringify(active, null, 2)], { type: 'application/json' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        a.href = url;
        a.download = `run-${active.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    const rawEvents = Array.isArray(active?.events) ? active.events : [];
    const eventList = rawEvents.filter(e => e && e.type && (filter === 'all' || e.type.includes(filter)));
    const receiptsList = Array.isArray(active?.receipts) ? active.receipts : [];

    const orderRows = [runs.naive, runs.brace].filter(Boolean).flatMap(r => {
        const list = Array.isArray(r.order_records) ? r.order_records : [];
        return list.map((o, idx) => ({
            id: o.id,
            idem_key: o.idem_key || '—',
            item: o.item || '—',
            created_at: o.created_at,
            runMode: r.mode || 'unknown',
            runId: r.id || '',
            isDuplicate: r.mode !== 'brace' && idx > 0
        }));
    });

    const benchResults = Array.isArray(benchmark?.results) ? benchmark.results : [];
    const budgetLimitNum = active && active.lim ? active.lim : Number(limit) || 0.45;
    const spentPct = active && active.spent && budgetLimitNum > 0
        ? Math.max(0, Math.min(100, (active.spent / budgetLimitNum) * 100))
        : 0;

    return <div className="shell">
        <aside className="sidebar">
            <div className="brand">
                <div className="brand-symbol"><GitBranch size={18} /></div>
                <div>
                    <strong>BRACE</strong>
                    <small>RUNTIME CONSOLE</small>
                </div>
                <span className="brand-version">v2.1</span>
            </div>

            <div className="nav-section">NAVIGATE</div>
            {[
                ['executions', Activity, 'Executions'],
                ['inspect', GitBranch, 'Event log'],
                ['orders', Database, 'Mock ledger'],
                ['benchmarks', Gauge, 'Benchmarks'],
                ['about', ClipboardList, 'Design & limits']
            ].map(([id, Icon, label]) => (
                <button
                    key={id}
                    className={'nav ' + (page === id ? 'current' : '')}
                    onClick={() => setPage(id)}
                >
                    <Icon size={15} />{label}
                    {page === id && <ChevronRight size={13} className="nav-chevron" />}
                </button>
            ))}

            <div className="sidebar-bottom">
                <div className="side-meta">
                    <span className={`dot ${health ? 'good-dot' : 'bad-dot'}`} />
                    <span className={health ? 'health-good' : 'health-bad'}>
                        {health ? 'API Connected' : 'Connecting...'}
                    </span>
                </div>
                <div className="sidebar-host">
                    Host: <code>{API.replace('/api', '').replace('https://', '')}</code>
                </div>
            </div>
        </aside>

        <div className="body">
            <main className="main">
                <div className="page-heading">
                    <div>
                        <div className="page-eyebrow">Reliability Runtime</div>
                        <h1>{({
                            executions: 'Executions',
                            inspect: 'Event Inspector',
                            orders: 'Mock Order Ledger',
                            benchmarks: 'Benchmark Trials',
                            about: 'System Specification'
                        })[page]}</h1>
                        <p>{({
                            executions: 'Controlled workflow execution under injected network, server, and process faults.',
                            inspect: 'Raw SQLite audit log of action dispatches, receipts, and persisted checkpoints.',
                            orders: 'Durable side effects written to orders.sqlite3.',
                            benchmarks: 'Outcomes across 30 deterministic trials per configuration.',
                            about: 'State machine semantics, idempotency guarantees, and boundary limits.'
                        })[page]}</p>
                    </div>
                    <div className="heading-meta">
                        RENDER BACKEND <span>/</span> VERCEL FRONTEND
                    </div>
                </div>

                {(page === 'executions' || page === 'inspect') && <>
                    {/* Execution Mode Selector */}
                    <div className="top-bar-row">
                        <div className="segmented-control">
                            <button
                                className={`segment-btn ${execMode === 'comparative' ? 'active' : ''}`}
                                onClick={() => setExecMode('comparative')}
                            >
                                Side-by-side
                            </button>
                            <button
                                className={`segment-btn ${execMode === 'unprotected' ? 'active' : ''}`}
                                onClick={() => { setExecMode('unprotected'); setSelectedRun('naive'); }}
                            >
                                Baseline (Unprotected)
                            </button>
                            <button
                                className={`segment-btn ${execMode === 'brace' ? 'active' : ''}`}
                                onClick={() => { setExecMode('brace'); setSelectedRun('brace'); }}
                            >
                                BRACE Runtime
                            </button>
                        </div>
                    </div>

                    {/* Run Controls */}
                    <div className="panel controls-bar">
                        <div className="control-field scenario-select">
                            <label>SCENARIO</label>
                            <select
                                value={scenario}
                                onChange={e => onSelectScenario(e.target.value)}
                            >
                                {Object.values(SCENARIOS).map(s => (
                                    <option value={s.id} key={s.id}>{s.label}</option>
                                ))}
                            </select>
                        </div>

                        <div className="control-field num-input">
                            <label>SEED</label>
                            <input
                                type="number"
                                value={seed}
                                onChange={e => setSeed(e.target.value)}
                            />
                        </div>

                        <div className="control-field budget-field">
                            <label>BUDGET (USD)</label>
                            <input
                                type="number"
                                min="0.01"
                                max="100"
                                step="0.01"
                                value={limit}
                                onChange={e => setLimit(e.target.value)}
                            />
                            <div className="preset-strip">
                                <span className="preset-tag">Presets:</span>
                                {(currentScenario?.presets || []).map((val, idx) => (
                                    <button
                                        key={idx}
                                        type="button"
                                        className={`preset-chip ${Number(limit) === val ? 'active' : ''}`}
                                        onClick={() => setLimit(val)}
                                    >
                                        ${val.toFixed(2)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <button
                            className="btn-primary"
                            onClick={run}
                            disabled={busy}
                        >
                            <Play size={14} />
                            {execMode === 'comparative' ? 'Run comparison' : execMode === 'unprotected' ? 'Run baseline' : 'Run BRACE'}
                        </button>

                        <button
                            className="btn-icon"
                            onClick={reset}
                            disabled={busy}
                            title="Reset SQLite database"
                        >
                            <RotateCcw size={15} />
                        </button>
                    </div>

                    <div className="scenario-summary-caption">
                        <CircleAlert size={14} />
                        <span>{currentScenario?.desc || ''}</span>
                        <span style={{ marginLeft: 'auto', color: '#7a8898' }}>{message}</span>
                    </div>

                    {page === 'executions' && <>
                        {/* === COMPARATIVE VERDICT BANNER === */}
                        {execMode === 'comparative' && unsafe && safe && (unsafe.status === 'completed' || safe.status === 'completed') && (
                            <div className="verdict-banner">
                                <div className="verdict-title">
                                    <CircleAlert size={16} />
                                    Comparison Result
                                </div>
                                <div className="verdict-grid">
                                    <div className="verdict-col verdict-bad">
                                        <div className="verdict-col-label">BASELINE (Unprotected)</div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num danger-text">{unsafe?.orders ?? '—'}</span>
                                            <span>orders committed</span>
                                        </div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num danger-text">{unsafe?.duplicates ?? '—'}</span>
                                            <span>duplicates</span>
                                        </div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num">{money(unsafe?.spent)}</span>
                                            <span>spent</span>
                                        </div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num">{unsafe?.retries ?? '—'}</span>
                                            <span>blind retries</span>
                                        </div>
                                        {(unsafe?.receipts || []).map(r => (
                                            <div key={r.id} className="verdict-receipt bad">
                                                {String(r.decision || '').replaceAll('_', ' ')}
                                            </div>
                                        ))}
                                    </div>
                                    <div className="verdict-divider">
                                        <span>VS</span>
                                    </div>
                                    <div className="verdict-col verdict-good">
                                        <div className="verdict-col-label">BRACE (Protected)</div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num good-text">{safe?.orders ?? '—'}</span>
                                            <span>orders committed</span>
                                        </div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num good-text">{safe?.duplicates ?? '0'}</span>
                                            <span>duplicates</span>
                                        </div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num">{money(safe?.spent)}</span>
                                            <span>spent</span>
                                        </div>
                                        <div className="verdict-stat">
                                            <span className="verdict-num good-text">{safe?.verification_count ?? '—'}</span>
                                            <span>verifications</span>
                                        </div>
                                        {(safe?.receipts || []).map(r => (
                                            <div key={r.id} className="verdict-receipt good">
                                                {String(r.decision || '').replaceAll('_', ' ')}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                {(unsafe?.duplicates || 0) > (safe?.duplicates || 0) && (
                                    <div className="verdict-summary">
                                        BRACE prevented <strong>{(unsafe?.duplicates || 0) - (safe?.duplicates || 0)}</strong> duplicate side-effect(s)
                                        {(safe?.verification_count || 0) > 0 && <> via <strong>{safe.verification_count}</strong> outcome verification(s)</>}.
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Metrics Grid */}
                        <div className="metrics-grid">
                            {execMode === 'comparative' ? (<>
                                <div className="metric-card panel">
                                    <span className="label">Baseline status</span>
                                    <strong className={cls(unsafe?.status)}>{unsafe?.status || 'idle'}</strong>
                                    <span className="caption">Unprotected agent</span>
                                </div>
                                <div className="metric-card panel">
                                    <span className="label">BRACE status</span>
                                    <strong className={cls(safe?.status)}>{safe?.status || 'idle'}</strong>
                                    <span className="caption">Protected runtime</span>
                                </div>
                                <div className="metric-card panel">
                                    <span className="label">Orders (baseline → BRACE)</span>
                                    <strong>
                                        <span style={{ color: (unsafe?.duplicates || 0) > 0 ? 'var(--danger)' : 'inherit' }}>{unsafe?.orders ?? '—'}</span>
                                        <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>→</span>
                                        <span style={{ color: 'var(--brand)' }}>{safe?.orders ?? '—'}</span>
                                    </strong>
                                    <span className="caption">
                                        {(unsafe?.orders ?? 0) > (safe?.orders ?? 0) ? 'BRACE reduced duplicate orders' : 'orders.sqlite3'}
                                    </span>
                                </div>
                                <div className="metric-card panel">
                                    <span className="label">Duplicates (baseline → BRACE)</span>
                                    <strong>
                                        <span style={{ color: (unsafe?.duplicates || 0) > 0 ? 'var(--danger)' : 'inherit', fontWeight: 700 }}>{unsafe?.duplicates ?? '—'}</span>
                                        <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>→</span>
                                        <span style={{ color: 'var(--brand)', fontWeight: 700 }}>{safe?.duplicates ?? '0'}</span>
                                    </strong>
                                    <span className="caption">
                                        {(unsafe?.duplicates || 0) > 0 ? 'Baseline produced unverified duplicates' : 'No duplicates either way'}
                                    </span>
                                </div>
                            </>) : (<>
                                <div className="metric-card panel">
                                    <span className="label">
                                        {execMode === 'unprotected' ? 'Baseline status' : 'BRACE status'}
                                    </span>
                                    <strong className={cls(active?.status)}>
                                        {active?.status || 'idle'}
                                    </strong>
                                    <span className="caption">
                                        {execMode === 'unprotected' ? 'Unprotected agent' : 'Protected runtime'}
                                    </span>
                                </div>
                                <div className="metric-card panel">
                                    <span className="label">Committed orders</span>
                                    <strong>{active?.orders ?? '—'}</strong>
                                    <span className="caption">Target: orders.sqlite3</span>
                                </div>
                                <div className="metric-card panel">
                                    <span className="label">Duplicate side effects</span>
                                    <strong style={{ color: (active?.duplicates || 0) > 0 ? 'var(--danger)' : 'inherit' }}>
                                        {active?.duplicates ?? '—'}
                                    </strong>
                                    <span className="caption">
                                        {(active?.duplicates || 0) > 0 ? 'Unverified duplicate writes' : 'Zero duplicates'}
                                    </span>
                                </div>
                                <div className="metric-card panel">
                                    <span className="label">Spend / Budget</span>
                                    <strong>{active ? money(active.spent) : '—'}</strong>
                                    <span className="caption">
                                        {active ? `${money(active.remaining)} available of ${money(budgetLimitNum)}` : 'Limit: ' + money(limit)}
                                    </span>
                                </div>
                            </>)}
                        </div>

                        {/* Execution View */}
                        {execMode === 'comparative' ? (
                            <div className="run-grid-comparative">
                                <RunPanel
                                    run={unsafe}
                                    label="BASELINE"
                                    title="Unprotected Agent"
                                    mode="naive"
                                    onSelect={() => { setSelectedRun('naive'); setPage('inspect'); }}
                                    onKill={() => action('naive', 'kill')}
                                    onResume={() => action('naive', 'resume')}
                                />
                                <RunPanel
                                    run={safe}
                                    label="CONTROLLED"
                                    title="BRACE Runtime"
                                    mode="brace"
                                    onSelect={() => { setSelectedRun('brace'); setPage('inspect'); }}
                                    onKill={() => action('brace', 'kill')}
                                    onResume={() => action('brace', 'resume')}
                                />
                            </div>
                        ) : (
                            <div className="run-grid-single">
                                <RunPanel
                                    run={active}
                                    label={execMode === 'unprotected' ? 'BASELINE AGENT' : 'BRACE RUNTIME'}
                                    title={execMode === 'unprotected' ? 'Unprotected Execution' : 'Protected Execution'}
                                    mode={execMode === 'unprotected' ? 'naive' : 'brace'}
                                    onSelect={() => { setSelectedRun(execMode === 'unprotected' ? 'naive' : 'brace'); setPage('inspect'); }}
                                    onKill={() => action(execMode === 'unprotected' ? 'naive' : 'brace', 'kill')}
                                    onResume={() => action(execMode === 'unprotected' ? 'naive' : 'brace', 'resume')}
                                />
                            </div>
                        )}

                        {/* Bottom Split: Receipts comparison in comparative mode */}
                        {execMode === 'comparative' ? (
                            <div className="bottom-split">
                                <div className="panel">
                                    <div className="panel-header">
                                        <div>
                                            <h2>Baseline Receipts</h2>
                                            <p>Unprotected agent decisions</p>
                                        </div>
                                        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                            {(unsafe?.receipts || []).length} records
                                        </span>
                                    </div>
                                    <div className="receipt-table-wrap">
                                        {(unsafe?.receipts || []).length ? (unsafe.receipts).map(r => (
                                            <div className="receipt-row receipt-bad" key={r.id}>
                                                <div className="receipt-marker bad" />
                                                <div className="receipt-body">
                                                    <strong style={{ color: 'var(--danger)' }}>{String(r.decision || 'DECISION').replaceAll('_', ' ')}</strong>
                                                    <p>{r.reason || '—'}</p>
                                                    <small>{fmtTime(r.ts)} · step {(r.step || 0) + 1}</small>
                                                </div>
                                            </div>
                                        )) : (
                                            <div style={{ padding: '36px 18px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                                                No receipts for baseline run.
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="panel">
                                    <div className="panel-header">
                                        <div>
                                            <h2>BRACE Receipts</h2>
                                            <p>Protected runtime decisions</p>
                                        </div>
                                        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                            {(safe?.receipts || []).length} records
                                        </span>
                                    </div>
                                    <div className="receipt-table-wrap">
                                        {(safe?.receipts || []).length ? (safe.receipts).map(r => (
                                            <div className="receipt-row receipt-good" key={r.id}>
                                                <div className="receipt-marker good" />
                                                <div className="receipt-body">
                                                    <strong style={{ color: 'var(--brand)' }}>{String(r.decision || 'DECISION').replaceAll('_', ' ')}</strong>
                                                    <p>{r.reason || '—'}</p>
                                                    <small>{fmtTime(r.ts)} · step {(r.step || 0) + 1}</small>
                                                </div>
                                            </div>
                                        )) : (
                                            <div style={{ padding: '36px 18px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                                                No receipts for BRACE run.
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="bottom-split">
                                <div className="panel">
                                    <div className="panel-header">
                                        <div>
                                            <h2>Recovery Receipts</h2>
                                            <p>Policy evaluation trail from SQLite receipts table</p>
                                        </div>
                                        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                            {receiptsList.length} records
                                        </span>
                                    </div>
                                    <div className="receipt-table-wrap">
                                        {receiptsList.length ? receiptsList.map(r => (
                                            <div className="receipt-row" key={r.id}>
                                                <div className="receipt-marker" />
                                                <div className="receipt-body">
                                                    <strong>{String(r.decision || 'DECISION').replaceAll('_', ' ')}</strong>
                                                    <p>{r.reason || '—'}</p>
                                                    <small>{fmtTime(r.ts)} · step {(r.step || 0) + 1}</small>
                                                </div>
                                            </div>
                                        )) : (
                                            <div style={{ padding: '36px 18px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                                                No policy receipts recorded for this run.
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="panel">
                                    <div className="panel-header">
                                        <div>
                                            <h2>Budget Ledger</h2>
                                            <p>Real-time spend against authorized limit</p>
                                        </div>
                                        <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>USD</span>
                                    </div>
                                    <div className="budget-widget">
                                        <div className="budget-numbers">
                                            <strong>{active ? money(active.spent) : '$0.00'}</strong>
                                            <span>spent / {money(budgetLimitNum)} limit</span>
                                        </div>
                                        <div className="budget-bar">
                                            <div
                                                className="budget-bar-fill"
                                                style={{ width: `${spentPct}%` }}
                                            />
                                        </div>
                                        <div className="budget-breakdown">
                                            <span>Reserved: <b>{money(active?.reserved)}</b></span>
                                            <span>Available: <b>{money(active?.remaining ?? limit)}</b></span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </>}

                    {page === 'inspect' && (
                        <div className="inspector-layout">
                            <div className="panel">
                                <div className="panel-header">
                                    <div>
                                        <h2>Audit Event Stream</h2>
                                        <p>Append-only events table</p>
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <select
                                            style={{ height: '30px', fontSize: '11px', background: '#0f141b', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '4px', padding: '0 8px' }}
                                            value={selectedRun}
                                            onChange={e => { setSelectedRun(e.target.value); setSelectedEvent(null); }}
                                        >
                                            {ids.brace && <option value="brace">BRACE run</option>}
                                            {ids.naive && <option value="naive">Baseline run</option>}
                                        </select>
                                        <select
                                            style={{ height: '30px', fontSize: '11px', background: '#0f141b', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '4px', padding: '0 8px' }}
                                            value={filter}
                                            onChange={e => setFilter(e.target.value)}
                                        >
                                            <option value="all">All events</option>
                                            <option value="call">Dispatches</option>
                                            <option value="budget">Budget</option>
                                            <option value="verify">Verification</option>
                                            <option value="checkpoint">Checkpoints</option>
                                            <option value="receipt">Receipts</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>TIME</th>
                                                <th>EVENT</th>
                                                <th>STEP</th>
                                                <th>PAYLOAD SUMMARY</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {eventList.length ? eventList.map(e => (
                                                <tr
                                                    key={e.id}
                                                    className={selectedEvent?.id === e.id ? 'selected' : ''}
                                                    onClick={() => setSelectedEvent(e)}
                                                >
                                                    <td className="mono" style={{ color: 'var(--text-muted)' }}>{fmtTime(e.ts)}</td>
                                                    <td><span className="mono" style={{ fontSize: '11px' }}>{e.type}</span></td>
                                                    <td className="mono">{e.step >= 0 && STEPS[e.step] ? STEPS[e.step].name : '—'}</td>
                                                    <td style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                        {Object.entries(e.payload || {}).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}
                                                    </td>
                                                </tr>
                                            )) : (
                                                <tr>
                                                    <td colSpan="4" style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                                                        No events recorded. Run an execution first.
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="panel json-view">
                                <div className="panel-header">
                                    <div>
                                        <h2>Event Details</h2>
                                        <p>Persisted JSON payload</p>
                                    </div>
                                </div>
                                <div style={{ padding: '14px' }}>
                                    {selectedEvent ? (
                                        <>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                                <span className="mono" style={{ fontSize: '12px', color: '#fff' }}>{selectedEvent.type}</span>
                                                <span className="mono" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>ID #{selectedEvent.id}</span>
                                            </div>
                                            <pre>{JSON.stringify(selectedEvent, null, 2)}</pre>
                                        </>
                                    ) : (
                                        <div style={{ padding: '40px 10px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                                            Select any event row on the left to inspect raw JSON.
                                        </div>
                                    )}
                                </div>
                                <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
                                    <button className="btn-secondary btn-sm" onClick={download} disabled={!active}>
                                        <ArrowDownToLine size={13} /> Export evidence JSON
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </>}

                {page === 'orders' && (
                    <div className="panel">
                        <div className="panel-header">
                            <div>
                                <h2>Mock Order Ledger (orders.sqlite3)</h2>
                                <p>Committed records directly from external mock tool store.</p>
                            </div>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>RUN MODE</th>
                                        <th>ORDER ID</th>
                                        <th>IDEMPOTENCY KEY</th>
                                        <th>ITEM</th>
                                        <th>TIMESTAMP</th>
                                        <th>STATE</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {orderRows.length ? orderRows.map(o => (
                                        <tr key={o.runId + '-' + o.id}>
                                            <td>
                                                <strong className="mono" style={{ color: o.runMode === 'brace' ? 'var(--brand)' : 'var(--danger)' }}>
                                                    {o.runMode.toUpperCase()}
                                                </strong>
                                                <span className="mono" style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>{o.runId.slice(0, 7)}</span>
                                            </td>
                                            <td className="mono">#{o.id}</td>
                                            <td className="mono">{o.idem_key}</td>
                                            <td>{o.item}</td>
                                            <td className="mono">{fmtTime(o.created_at)}</td>
                                            <td>
                                                {o.isDuplicate ? (
                                                    <span className="tag tag-dup">duplicate</span>
                                                ) : (
                                                    <span className="tag tag-ok">committed</span>
                                                )}
                                            </td>
                                        </tr>
                                    )) : (
                                        <tr>
                                            <td colSpan="6" style={{ textAlign: 'center', padding: '36px', color: 'var(--text-muted)' }}>
                                                No records committed yet. Start an execution to populate the ledger.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {page === 'benchmarks' && (
                    <div className="panel">
                        <div className="panel-header">
                            <div>
                                <h2>Controlled Benchmark Trials</h2>
                                <p>Reproducible local trials across 7 scenarios (30 seeds each).</p>
                            </div>
                            <button className="btn-secondary btn-sm" onClick={() => api('/benchmarks').then(setBenchmark).catch(e => setMessage(e.message))}>
                                <RotateCcw size={12} /> Reload
                            </button>
                        </div>
                        {benchResults.length ? (
                            <>
                                <div style={{ padding: '10px 16px', background: '#10141b', borderBottom: '1px solid var(--border)', fontSize: '11px', color: 'var(--text-muted)' }}>
                                    Trials per scenario: {benchmark?.trials || 30} · Generated: {benchmark?.generated_at || '—'}
                                </div>
                                <div className="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>MODE</th>
                                                <th>SCENARIO</th>
                                                <th>TRIALS</th>
                                                <th>COMPLETED</th>
                                                <th>SAFE STOPS</th>
                                                <th>DUPLICATES</th>
                                                <th>OVERRUNS</th>
                                                <th>RESUMES</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {benchResults.map((r, i) => (
                                                <tr key={i}>
                                                    <td className="mono" style={{ color: r.mode === 'brace' ? 'var(--brand)' : 'var(--text-secondary)' }}>
                                                        {(r.mode || '').toUpperCase()}
                                                    </td>
                                                    <td>{r.scenario}</td>
                                                    <td className="mono">{r.trials}</td>
                                                    <td className="mono">{r.completed}</td>
                                                    <td className="mono">{r.safe_stops ?? 0}</td>
                                                    <td className="mono" style={{ color: r.duplicates > 0 ? 'var(--danger)' : 'inherit', fontWeight: r.duplicates > 0 ? 600 : 400 }}>
                                                        {r.duplicates}
                                                    </td>
                                                    <td className="mono">{r.overruns}</td>
                                                    <td className="mono">{r.resumed}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        ) : (
                            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
                                <Terminal size={24} style={{ marginBottom: '10px', opacity: 0.5 }} />
                                <div style={{ fontSize: '13px', color: '#fff', marginBottom: '6px' }}>No benchmark results loaded</div>
                                <p style={{ fontSize: '11px', marginBottom: '12px' }}>Generate trials locally via CLI:</p>
                                <code style={{ background: '#0f1319', border: '1px solid var(--border)', padding: '6px 12px', borderRadius: '4px' }}>
                                    python -m brace.bench.run_bench --trials 30
                                </code>
                            </div>
                        )}
                    </div>
                )}

                {page === 'about' && (
                    <div className="panel" style={{ padding: '24px' }}>
                        <h2 style={{ fontSize: '16px', marginBottom: '14px', color: '#fff' }}>Runtime Specification & Boundaries</h2>
                        <p style={{ fontSize: '13px', lineHeight: 1.7, color: 'var(--text-secondary)', marginBottom: '16px' }}>
                            BRACE (Budgeted Recovery Runtime) evaluates recovery policies for tool-using AI agents under transient network errors, dropped HTTP acknowledgements, rate limiting, and process crashes.
                        </p>
                        <p style={{ fontSize: '13px', lineHeight: 1.7, color: 'var(--text-secondary)', marginBottom: '16px' }}>
                            <strong>Idempotency Reconciliation:</strong> In the lost-response scenario (S1), an external API times out after committing an effect. While a baseline agent mints a new idempotency key on retry (producing duplicate side effects), BRACE marks the outcome state as <code>unknown</code>, queries the external verification method with the existing idempotency key, and reconciles the state without redundant re-dispatch.
                        </p>
                        <p style={{ fontSize: '13px', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
                            <strong>Boundaries:</strong> All side effects here execute against a durable SQLite mock store (<code>orders.sqlite3</code>). This demonstration evaluates single-host recovery mechanisms and does not assert exactly-once semantics for uncoordinated external network services.
                        </p>
                    </div>
                )}

                <footer>
                    <span>BRACE EVALUATION SUITE</span>
                    <span>DETERMINISTIC FAULTS · VERIFIABLE AUDIT LOG</span>
                </footer>
            </main>
        </div>
    </div>;
}

function RunPanel({ run, label, title, mode, onSelect, onKill, onResume }) {
    const isRunValid = run && typeof run === 'object' && run.id;
    const currentStep = isRunValid && typeof run.step === 'number' ? run.step : -1;
    const currentStatus = isRunValid ? (run.status || 'idle') : 'idle';

    return <section className="run-card">
        <div className="run-card-header">
            <div>
                <span className="type-pill">{label}</span>
                <h3>{title}</h3>
            </div>
            <span className={'status-tag ' + cls(currentStatus)}>{currentStatus}</span>
        </div>

        <div className="run-id-bar">
            RUN ID: <span>{isRunValid ? run.id : 'not started'}</span>
        </div>

        <div className="pipeline-list">
            {STEPS.map((step, i) => {
                const done = isRunValid && i < currentStep;
                const active = isRunValid && i === currentStep && currentStatus === 'running';
                return (
                    <div className={'pipeline-step ' + (done ? 'done' : active ? 'active' : '')} key={step.name}>
                        <span className="step-num">{done ? <Check size={11} /> : String(i + 1).padStart(2, '0')}</span>
                        <span>{step.name}</span>
                        <span className="step-cost">({step.cost})</span>
                        <span className="step-state-tag">{done ? 'completed' : active ? 'running' : 'pending'}</span>
                    </div>
                );
            })}
        </div>

        <div className="run-kpi-strip">
            <div>
                <span>Orders</span>
                <b>{isRunValid ? (run.orders ?? '—') : '—'}</b>
            </div>
            <div>
                <span>Duplicates</span>
                <b style={{ color: (run?.duplicates || 0) > 0 ? 'var(--danger)' : 'inherit' }}>
                    {isRunValid ? (run.duplicates ?? '—') : '—'}
                </b>
            </div>
            <div>
                <span>Spent</span>
                <b>{isRunValid ? money(run.spent) : '—'}</b>
            </div>
        </div>

        <div className="run-card-footer">
            <button className="link-btn" onClick={onSelect}>
                Inspect audit log <ArrowRight size={12} />
            </button>
            {currentStatus === 'running' && (
                <button className="btn-secondary btn-sm" onClick={onKill}>
                    <Square size={12} /> Terminate PID
                </button>
            )}
            {currentStatus === 'interrupted' && (
                <button className="btn-secondary btn-sm" onClick={onResume}>
                    <RotateCcw size={12} /> Resume from checkpoint
                </button>
            )}
        </div>
    </section>;
}

createRoot(document.getElementById('root')).render(<App />);
