import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Activity, AlertTriangle, ArrowDownToLine, ArrowRight, Check, ChevronRight,
    CircleAlert, CircleDot, ClipboardList, Database, DollarSign, FileJson,
    Gauge, GitBranch, HardDrive, Layers, Play, RotateCcw, Shield, ShieldAlert,
    ShieldCheck, Sparkles, Square, Terminal, Workflow, X, Zap
} from 'lucide-react';
import './style.css';

const RAW_BACKEND = (import.meta.env.VITE_API_URL || 'https://brace-api-y8ha.onrender.com').trim().replace(/\/+$/, '');
const API = RAW_BACKEND.endsWith('/api') ? RAW_BACKEND : `${RAW_BACKEND}/api`;

const SCENARIOS = {
    timeout: {
        id: 'timeout',
        name: 'S1 · Lost response (Timeout)',
        tag: 'DANGEROUS RETRY',
        summary: 'Order API times out right after committing the order in the database.',
        defaultBudget: 0.45,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.45)', val: 0.45 }, { label: 'Tight ($0.20)', val: 0.20 }, { label: 'Generous ($0.90)', val: 0.90 }],
        risk: 'Unprotected agent assumes failure, generates a NEW idempotency key, and dispatches a second order → DOUBLE CHARGE / DUPLICATE EFFECT!',
        guard: 'BRACE records an "unknown" outcome state, verifies the mock ledger using the existing idempotency key, reconciles the commit, and safely skips re-dispatch.',
        toolCostEstimate: 0.29,
    },
    server: {
        id: 'server',
        name: 'S2 · HTTP 500 (Server Error)',
        tag: 'TRANSIENT FAILURE',
        summary: 'Catalog search fails twice with HTTP 500 internal server errors before succeeding.',
        defaultBudget: 0.60,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.60)', val: 0.60 }, { label: 'Tight ($0.20)', val: 0.20 }, { label: 'Generous ($1.00)', val: 1.00 }],
        risk: 'Unprotected agent retries blindly without exponential backoff or budget tracking, risking server stampede.',
        guard: 'BRACE calculates retry value against remaining budget, performs bounded exponential backoff, and tracks attempts.',
        toolCostEstimate: 0.29,
    },
    rate: {
        id: 'rate',
        name: 'S3 · HTTP 429 (Rate Limit)',
        tag: 'RATE THROTTLING',
        summary: 'Catalog API returns HTTP 429 Too Many Requests with a retry-after penalty.',
        defaultBudget: 0.50,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.50)', val: 0.50 }, { label: 'Tight ($0.25)', val: 0.25 }, { label: 'Generous ($1.00)', val: 1.00 }],
        risk: 'Unprotected agent retries immediately or crashes on 429, exhausting token quotas.',
        guard: 'BRACE honors rate-limit backoff, checks budget reserve, and executes a controlled retry wait.',
        toolCostEstimate: 0.29,
    },
    budget: {
        id: 'budget',
        name: 'S4 · Insufficient Budget Limit',
        tag: 'FINANCIAL DEFENSE',
        summary: 'Strict budget cap ($0.12) is insufficient for the dangerous $0.16 order placement.',
        defaultBudget: 0.12,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.12)', val: 0.12 }, { label: 'Borderline ($0.25)', val: 0.25 }, { label: 'Generous ($0.50)', val: 0.50 }],
        risk: 'Unprotected agent proceeds to dispatch unaffordable operations, causing financial overdraft or runaway costs.',
        guard: 'BRACE budget gate pre-authorizes tool cost + finishing reserve ($0.02), blocks dispatch before execution, and triggers safe pause.',
        toolCostEstimate: 0.29,
    },
    crash: {
        id: 'crash',
        name: 'S5 · Worker Crash (Exit 31)',
        tag: 'STATE PERSISTENCE',
        summary: 'Worker process crashes immediately after checkpoint 3 (order placement).',
        defaultBudget: 0.38,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.38)', val: 0.38 }, { label: 'Tight ($0.20)', val: 0.20 }, { label: 'Generous ($0.75)', val: 0.75 }],
        risk: 'Without checkpoints, agent state is lost on process exit. Restarting restarts from scratch, re-ordering the item!',
        guard: 'BRACE persists checkpoints in SQLite WAL. Upon worker restart, it resumes exactly from step 4 without re-dispatching order.',
        toolCostEstimate: 0.29,
    },
    loop: {
        id: 'loop',
        name: 'S6 · No Progress (Runaway Loop)',
        tag: 'CIRCUIT BREAKER',
        summary: 'Agent repeatedly issues catalog queries returning unchanged results with no task progress.',
        defaultBudget: 0.75,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.75)', val: 0.75 }, { label: 'Low ($0.30)', val: 0.30 }, { label: 'Max ($1.50)', val: 1.50 }],
        risk: 'Unprotected agent burns the entire budget repeating unproductive queries indefinitely.',
        guard: 'BRACE loop detector computes state progress hashes, detects 3 identical queries without state delta, and trips the circuit breaker.',
        toolCostEstimate: 0.29,
    },
    normal: {
        id: 'normal',
        name: 'S7 · Control Run (Nominal Flow)',
        tag: 'CONTROL BASELINE',
        summary: 'Ideal nominal execution with zero injected faults to measure baseline cost and timing.',
        defaultBudget: 0.32,
        defaultSeed: 42,
        presets: [{ label: 'Recommended ($0.32)', val: 0.32 }, { label: 'Nominal ($0.29)', val: 0.29 }, { label: 'Generous ($0.50)', val: 0.50 }],
        risk: 'Standard execution succeeds, but lacks resilience and recovery telemetry if unexpected edge cases occur.',
        guard: 'Nominal workflow completes with exact budget accounting ($0.29 total) and verified step checkpoints.',
        toolCostEstimate: 0.29,
    },
};

const STEPS = [
    { name: 'search_catalog', cost: '$0.04', desc: 'Read product catalog' },
    { name: 'check_stock', cost: '$0.03', desc: 'Verify inventory availability' },
    { name: 'place_order', cost: '$0.16', desc: 'Durable side-effect order commit' },
    { name: 'send_confirmation', cost: '$0.05', desc: 'Idempotent email confirmation' },
    { name: 'finish', cost: '$0.01', desc: 'Mark workflow complete' }
];

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
    const [page, setPage] = useState('executions');
    const [execMode, setExecMode] = useState('paired'); // 'paired', 'naive' (without brace), 'brace' (with brace), 'plain'
    const [scenario, setScenario] = useState('timeout');
    const [seed, setSeed] = useState(42);
    const [limit, setLimit] = useState(SCENARIOS.timeout.defaultBudget);
    const [ids, setIds] = useState({});
    const [runs, setRuns] = useState({});
    const [selectedRun, setSelectedRun] = useState('brace');
    const [selectedEvent, setSelectedEvent] = useState(null);
    const [filter, setFilter] = useState('all');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('Ready. Select an execution mode and scenario to begin.');
    const [health, setHealth] = useState(false);
    const [benchmark, setBenchmark] = useState(null);

    // Sync budget when scenario changes
    const onSelectScenario = scKey => {
        setScenario(scKey);
        const sc = SCENARIOS[scKey];
        if (sc) {
            setLimit(sc.defaultBudget);
            setSeed(sc.defaultSeed);
        }
    };

    useEffect(() => {
        const checkHealth = () => api('/health').then(() => setHealth(true)).catch(() => setHealth(false));
        checkHealth();
        api('/benchmarks').then(setBenchmark).catch(() => { });
        const interval = setInterval(checkHealth, 15000);
        return () => clearInterval(interval);
    }, []);

    // Listen to live events for all active runs
    useEffect(() => {
        let connections = Object.entries(ids).map(([mode, id]) => {
            if (!id) return null;
            let es = new EventSource(`${API}/runs/${id}/events`);
            es.onmessage = e => {
                try {
                    const data = JSON.parse(e.data);
                    setRuns(prev => ({ ...prev, [mode]: data }));
                    if (['completed', 'failed', 'safe_stop', 'budget_exhausted', 'paused'].includes(data.status)) {
                        // Still allow keepalive until user triggers actions
                    }
                } catch { }
            };
            es.onerror = () => {
                api(`/runs/${id}`).then(finalData => {
                    setRuns(prev => ({ ...prev, [mode]: finalData }));
                }).catch(() => { });
            };
            return es;
        }).filter(Boolean);
        return () => connections.forEach(e => e.close());
    }, [JSON.stringify(ids)]);

    const safe = runs.brace;
    const unsafe = runs.naive || runs.plain;
    const currentScenario = SCENARIOS[scenario] || SCENARIOS.timeout;
    const active = runs[selectedRun] || runs[execMode] || safe || unsafe;

    async function run() {
        setBusy(true);
        setRuns({});
        setIds({});
        setSelectedEvent(null);

        try {
            if (execMode === 'paired') {
                let a = await api('/runs', { mode: 'naive', scenario, seed: Number(seed), limit: Number(limit) });
                let b = await api('/runs', { mode: 'brace', scenario, seed: Number(seed), limit: Number(limit) });
                setIds({ naive: a.id, brace: b.id });
                await Promise.all([api(`/runs/${a.id}/start`, {}), api(`/runs/${b.id}/start`, {})]);
                setSelectedRun('brace');
                setMessage(`Started paired runs • Scenario: ${currentScenario.name} • Seed ${seed}`);
            } else {
                let r = await api('/runs', { mode: execMode, scenario, seed: Number(seed), limit: Number(limit) });
                setIds({ [execMode]: r.id });
                await api(`/runs/${r.id}/start`, {});
                setSelectedRun(execMode);
                const modeLabel = execMode === 'naive' ? 'Without BRACE (Unprotected)' : execMode === 'brace' ? 'With BRACE (Protected)' : 'Plain Agent';
                setMessage(`Started ${modeLabel} run • Scenario: ${currentScenario.name} • Seed ${seed}`);
            }
            setPage('executions');
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
            setRuns({});
            setIds({});
            setMessage('Database & ledger cleared; ready for a new experiment.');
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

    // Dynamic stats depending on execution mode
    const primaryRun = execMode === 'naive' ? unsafe : safe || unsafe;
    const isWithoutBraceMode = execMode === 'naive';

    return <div className="shell">
        <aside className="sidebar">
            <div className="brand">
                <div className="brand-symbol"><GitBranch size={20} /></div>
                <div>
                    <strong>BRACE</strong>
                    <small>RECOVERY RUNTIME</small>
                </div>
                <span className="brand-version">v2.1</span>
            </div>
            <div className="nav-section">WORKSPACE</div>
            {[
                ['executions', Activity, 'Executions'],
                ['inspect', GitBranch, 'Execution inspector'],
                ['orders', Database, 'Mock order ledger'],
                ['benchmarks', Gauge, 'Evaluation & Trials'],
                ['about', ClipboardList, 'Architecture & Limits']
            ].map(([id, Icon, label]) => (
                <button
                    key={id}
                    className={'nav ' + (page === id ? 'current' : '')}
                    onClick={() => setPage(id)}
                >
                    <Icon size={16} />{label}
                    {page === id && <ChevronRight size={14} className="nav-chevron" />}
                </button>
            ))}

            <div className="sidebar-bottom">
                <div className="side-meta">
                    <span className={`dot ${health ? 'good-dot' : 'bad-dot'}`} />
                    <span className={health ? 'health-good' : 'health-bad'}>
                        {health ? 'Render API Online' : 'Connecting to API...'}
                    </span>
                </div>
                <p style={{ margin: '8px 0 0', fontSize: '10px', color: '#728192' }}>
                    Backend Host:<br />
                    <code style={{ fontSize: '10px', color: '#9bb8d7', wordBreak: 'break-all' }}>
                        {API.replace('/api', '')}
                    </code>
                </p>
            </div>
        </aside>

        <div className="body">
            <main className="main">
                <div className="page-heading">
                    <div>
                        <div className="page-eyebrow">
                            RELIABILITY ENGINEERING LAB <span>/</span> {execMode === 'naive' ? 'WITHOUT BRACE (BASELINE)' : execMode === 'brace' ? 'WITH BRACE (PROTECTED)' : 'HEAD-TO-HEAD COMPARISON'}
                        </div>
                        <h1>
                            {({
                                executions: 'Reliability Control Center',
                                inspect: 'Execution Event Inspector',
                                orders: 'Durable Mock Order Ledger',
                                benchmarks: 'Controlled Evaluation & Benchmarks',
                                about: 'System Architecture & Guarantees'
                            })[page]}
                        </h1>
                        <p>
                            {({
                                executions: 'Execute workflows with or without BRACE under controlled network timeouts, server failures, rate limits, and worker crashes.',
                                inspect: 'Inspect raw state transitions, tool dispatches, decision receipts, and persisted checkpoints.',
                                orders: 'Inspect side effects committed directly to the durable mock SQLite ledger vs claimed agent responses.',
                                benchmarks: 'Outcome measurements across 30 reproducible controlled trials per scenario.',
                                about: 'Evaluation boundaries, finite state machine specifications, and idempotency mechanics.'
                            })[page]}
                        </p>
                    </div>
                    <div className="heading-meta">
                        RENDER BACKEND <span>/</span> VERCEL FRONTEND
                    </div>
                </div>

                {(page === 'executions' || page === 'inspect') && <>
                    {/* Execution Mode Selector */}
                    <div className="mode-selector-wrap">
                        <div className="mode-label-group">
                            <Layers size={14} />
                            <span>EXECUTION MODE:</span>
                        </div>
                        <div className="mode-tabs">
                            <button
                                className={`mode-tab ${execMode === 'paired' ? 'active-paired' : ''}`}
                                onClick={() => setExecMode('paired')}
                            >
                                <Zap size={13} />
                                <span>Paired Comparison</span>
                            </button>
                            <button
                                className={`mode-tab ${execMode === 'naive' ? 'active-naive' : ''}`}
                                onClick={() => { setExecMode('naive'); setSelectedRun('naive'); }}
                            >
                                <ShieldAlert size={13} />
                                <span>Without BRACE (Baseline)</span>
                            </button>
                            <button
                                className={`mode-tab ${execMode === 'brace' ? 'active-brace' : ''}`}
                                onClick={() => { setExecMode('brace'); setSelectedRun('brace'); }}
                            >
                                <ShieldCheck size={13} />
                                <span>With BRACE (Protected)</span>
                            </button>
                            <button
                                className={`mode-tab ${execMode === 'plain' ? 'active-plain' : ''}`}
                                onClick={() => { setExecMode('plain'); setSelectedRun('plain'); }}
                            >
                                <Terminal size={13} />
                                <span>Plain Agent</span>
                            </button>
                        </div>
                    </div>

                    {/* Scenario Deep Insight & Mechanics Banner */}
                    <div className="scenario-banner">
                        <div className="scenario-banner-header">
                            <div>
                                <strong style={{ fontSize: '13px', color: '#e5eaf0' }}>{currentScenario.name}</strong>
                                <span style={{ marginLeft: '10px', fontSize: '11px', color: '#8797a7' }}>{currentScenario.summary}</span>
                            </div>
                            <span className={`scenario-tag ${scenario}`}>{currentScenario.tag}</span>
                        </div>
                        <div className="scenario-cols">
                            <div className="scenario-box risk">
                                <div className="scenario-box-title">
                                    <AlertTriangle size={13} />
                                    <span>FAILURE MODE WITHOUT BRACE</span>
                                </div>
                                <p>{currentScenario.risk}</p>
                            </div>
                            <div className="scenario-box guard">
                                <div className="scenario-box-title">
                                    <ShieldCheck size={13} />
                                    <span>PROTECTION WITH BRACE</span>
                                </div>
                                <p>{currentScenario.guard}</p>
                            </div>
                        </div>
                    </div>

                    {/* Controls Panel */}
                    <section className="panel controls">
                        <div className="control-item scenario-control">
                            <label>FAULT SCENARIO</label>
                            <select
                                value={scenario}
                                onChange={e => onSelectScenario(e.target.value)}
                            >
                                {Object.values(SCENARIOS).map(x => (
                                    <option value={x.id} key={x.id}>{x.name}</option>
                                ))}
                            </select>
                        </div>

                        <div className="control-item small-control">
                            <label>SEED</label>
                            <input
                                type="number"
                                value={seed}
                                onChange={e => setSeed(e.target.value)}
                            />
                        </div>

                        <div className="control-item" style={{ minWidth: '180px' }}>
                            <label>BUDGET (USD)</label>
                            <input
                                type="number"
                                min="0.01"
                                max="100"
                                step="0.01"
                                value={limit}
                                onChange={e => setLimit(e.target.value)}
                            />
                            <div className="preset-row">
                                <span className="preset-label">Presets:</span>
                                {currentScenario.presets.map((p, idx) => (
                                    <button
                                        key={idx}
                                        type="button"
                                        className={`preset-btn ${Number(limit) === p.val ? 'active' : ''}`}
                                        onClick={() => setLimit(p.val)}
                                    >
                                        ${p.val.toFixed(2)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <button
                            className={`primary-btn ${execMode === 'naive' ? 'naive-btn' : execMode === 'brace' ? 'brace-btn' : ''}`}
                            onClick={run}
                            disabled={busy}
                        >
                            <Play size={15} />
                            {execMode === 'paired' && 'Run Paired Comparison'}
                            {execMode === 'naive' && 'Run Without BRACE'}
                            {execMode === 'brace' && 'Run With BRACE'}
                            {execMode === 'plain' && 'Run Plain Agent'}
                        </button>

                        <button
                            className="icon-btn"
                            onClick={reset}
                            disabled={busy}
                            title="Reset all SQLite database state and mock ledger"
                        >
                            <RotateCcw size={17} />
                        </button>
                    </section>

                    {/* Tool Step Nominal Pricing Breakdown */}
                    <div className="tool-cost-bar">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <DollarSign size={13} style={{ color: '#88a4be' }} />
                            <span>Tool Cost Schedule:</span>
                        </div>
                        <div className="tool-step-pills">
                            {STEPS.map((s, idx) => (
                                <span className="tool-step-pill" key={s.name}>
                                    {idx + 1}. {s.name}: <b>{s.cost}</b>
                                </span>
                            ))}
                            <span className="tool-step-pill" style={{ borderColor: '#48627d', background: '#1c2838' }}>
                                Nominal Total: <b>$0.29</b>
                            </span>
                        </div>
                    </div>

                    {/* Real-time Outcome Impact Alert */}
                    {unsafe?.duplicates > 0 && (
                        <div className="outcome-alert danger">
                            <AlertTriangle size={18} />
                            <div>
                                <b>CRITICAL DEFECT DETECTED (WITHOUT BRACE):</b> Unprotected agent generated multiple idempotency keys and placed{' '}
                                <strong style={{ color: '#fff' }}>{unsafe.duplicates} duplicate order(s)</strong> in the persistent mock ledger! Total mock orders charged: {unsafe.orders}.
                            </div>
                        </div>
                    )}

                    {safe?.duplicates === 0 && safe?.orders === 1 && scenario === 'timeout' && (
                        <div className="outcome-alert success">
                            <ShieldCheck size={18} />
                            <div>
                                <b>RECONCILIATION SUCCESS (WITH BRACE):</b> Order timeout safely reconciled! Verified existing order #{safe.order_records?.[0]?.id || 1} via idempotency key; skipped redundant re-dispatch. Duplicate orders: 0.
                            </div>
                        </div>
                    )}

                    {safe?.status === 'paused' && safe?.events?.some(e => e.type === 'budget_denied') && (
                        <div className="outcome-alert warn">
                            <ShieldAlert size={18} />
                            <div>
                                <b>FINANCIAL GATE TRIGGERED (WITH BRACE):</b> Pre-dispatch budget gate blocked dangerous operation. Prevented account overdraft before network transmission.
                            </div>
                        </div>
                    )}

                    {safe?.status === 'paused' && safe?.events?.some(e => e.type === 'loop_detected') && (
                        <div className="outcome-alert warn">
                            <RotateCcw size={18} />
                            <div>
                                <b>CIRCUIT BREAKER TRIGGERED (WITH BRACE):</b> Loop guard detected 3 identical search operations with no state progress. Halted execution safely.
                            </div>
                        </div>
                    )}

                    <div className="hint-line">
                        <CircleAlert size={15} />
                        <span>{currentScenario.summary}</span>
                        <span className="hint-msg">{message}</span>
                    </div>

                    {page === 'executions' && <>
                        {/* Summary Metrics Row */}
                        <div className="summary-row">
                            <Stat
                                label={isWithoutBraceMode ? "Baseline Status" : "Protected Status"}
                                value={primaryRun?.status || 'Not started'}
                                detail={isWithoutBraceMode ? "Unprotected execution" : "Controlled BRACE runtime"}
                                status={cls(primaryRun?.status)}
                            />
                            <Stat
                                label="Committed Orders"
                                value={execMode === 'paired' ? `Baseline: ${unsafe?.orders ?? '—'} | BRACE: ${safe?.orders ?? '—'}` : (primaryRun?.orders ?? '—')}
                                detail="Durable SQLite mock store"
                            />
                            <Stat
                                label="Duplicate Side Effects"
                                value={execMode === 'paired' ? `Baseline: ${unsafe?.duplicates ?? '—'} | BRACE: ${safe?.duplicates ?? '0'}` : (primaryRun?.duplicates ?? '—')}
                                detail={isWithoutBraceMode ? "Unprotected duplicate risk" : "Protected guarantee"}
                                status={(primaryRun?.duplicates || 0) > 0 ? 'bad' : 'good'}
                            />
                            <Stat
                                label="Budget Consumed"
                                value={primaryRun ? money(primaryRun.spent) : '—'}
                                detail={primaryRun ? `${money(primaryRun.remaining)} remaining / ${money(primaryRun.lim)} limit` : 'Not started'}
                            />
                        </div>

                        {/* Main Execution View */}
                        {execMode === 'paired' ? (
                            <>
                                <div className="section-heading">
                                    <h2>Paired Comparative Execution</h2>
                                    <span>Identical Scenario · Identical Seed · Different Recovery Policies</span>
                                </div>
                                <div className="comparison">
                                    <RunPanel
                                        run={unsafe}
                                        label="BASELINE"
                                        headline="Without BRACE (Unprotected)"
                                        mode="naive"
                                        onSelect={() => { setSelectedRun('naive'); setPage('inspect'); }}
                                        onKill={() => action('naive', 'kill')}
                                        onResume={() => action('naive', 'resume')}
                                    />
                                    <RunPanel
                                        run={safe}
                                        label="CONTROLLED"
                                        headline="With BRACE (Protected Runtime)"
                                        mode="brace"
                                        onSelect={() => { setSelectedRun('brace'); setPage('inspect'); }}
                                        onKill={() => action('brace', 'kill')}
                                        onResume={() => action('brace', 'resume')}
                                    />
                                </div>
                            </>
                        ) : (
                            <div className="single-run-container">
                                <div className="section-heading">
                                    <h2>
                                        {execMode === 'naive' && 'Without BRACE (Unprotected Baseline Agent)'}
                                        {execMode === 'brace' && 'With BRACE (Protected Execution Runtime)'}
                                        {execMode === 'plain' && 'Plain Uncheckpointed Agent'}
                                    </h2>
                                    <span>Focused Single-Run Execution Telemetry</span>
                                </div>
                                <RunPanel
                                    run={primaryRun}
                                    label={execMode === 'naive' ? 'UNPROTECTED BASELINE' : execMode === 'brace' ? 'BRACE PROTECTED' : 'PLAIN AGENT'}
                                    headline={execMode === 'naive' ? 'Without BRACE Runtime' : execMode === 'brace' ? 'BRACE Reliability Guard Active' : 'Plain Agent Execution'}
                                    mode={execMode}
                                    onSelect={() => { setSelectedRun(execMode); setPage('inspect'); }}
                                    onKill={() => action(execMode, 'kill')}
                                    onResume={() => action(execMode, 'resume')}
                                />
                            </div>
                        )}

                        {/* Bottom Decision Receipts and Budget Breakdown */}
                        <div className="bottom-grid">
                            <div className="panel">
                                <div className="panel-header">
                                    <div>
                                        <h2>Latest Decision Receipts</h2>
                                        <p>Human-readable recovery policy & verification decisions</p>
                                    </div>
                                    <span className="minor-count">{safe?.receipts?.length || unsafe?.receipts?.length || 0} records</span>
                                </div>
                                <div className="receipt-list">
                                    {(active?.receipts?.length) ? active.receipts.slice(0, 5).map(r => (
                                        <div className="receipt" key={r.id}>
                                            <div className="receipt-dot" />
                                            <div>
                                                <b>{r.decision.replaceAll('_', ' ')}</b>
                                                <p>{r.reason}</p>
                                                <small>{fmtTime(r.ts)} · step {r.step + 1}</small>
                                            </div>
                                        </div>
                                    )) : (
                                        <div className="subtle-empty">
                                            {execMode === 'naive' ? 'Baseline runs emit unverified naive retry receipts on fault.' : 'Policy receipts will appear after a protected run.'}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="panel">
                                <div className="panel-header">
                                    <div>
                                        <h2>Execution Budget Ledger</h2>
                                        <p>Real durable SQLite ledger totals</p>
                                    </div>
                                    <span className="budget-tag">USD</span>
                                </div>
                                <div className="budget-card">
                                    <div className="budget-main">
                                        <strong>{active ? money(active.spent) : '$0.00'}</strong>
                                        <span>spent / {money(active?.lim ?? limit)} limit</span>
                                    </div>
                                    <div className="budget-track">
                                        <span style={{ width: `${active ? Math.min(100, (active.spent / active.lim) * 100) : 0}%` }} />
                                    </div>
                                    <div className="budget-splits">
                                        <span>Reserved <b>{money(active?.reserved)}</b></span>
                                        <span>Available <b>{money(active?.remaining ?? limit)}</b></span>
                                    </div>
                                </div>
                                <div className="panel-footer">
                                    <button className="text-btn" onClick={() => { setSelectedRun(execMode === 'paired' ? 'brace' : execMode); setPage('inspect'); }}>
                                        Inspect budget events <ArrowRight size={14} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </>}

                    {page === 'inspect' && (
                        <div className="inspector-layout">
                            <div className="panel inspector-main">
                                <div className="panel-header">
                                    <div>
                                        <h2>Event History & Audit Log</h2>
                                        <p>Append-only SQLite event log • Newest first</p>
                                    </div>
                                    <div className="right-actions">
                                        <select value={selectedRun} onChange={e => { setSelectedRun(e.target.value); setSelectedEvent(null); }}>
                                            {ids.brace && <option value="brace">With BRACE (Protected)</option>}
                                            {ids.naive && <option value="naive">Without BRACE (Baseline)</option>}
                                            {ids.plain && <option value="plain">Plain Agent</option>}
                                        </select>
                                        <select value={filter} onChange={e => setFilter(e.target.value)}>
                                            <option value="all">All events</option>
                                            <option value="call">Dispatches & Calls</option>
                                            <option value="budget">Budget events</option>
                                            <option value="verify">Verification</option>
                                            <option value="checkpoint">Checkpoints</option>
                                            <option value="decision">Decisions & Receipts</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>TIME</th>
                                                <th>EVENT TYPE</th>
                                                <th>STEP</th>
                                                <th>PAYLOAD PREVIEW</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {eventList.length ? eventList.map(e => (
                                                <tr
                                                    key={e.id}
                                                    className={selectedEvent?.id === e.id ? 'row-selected' : ''}
                                                    onClick={() => setSelectedEvent(e)}
                                                >
                                                    <td className="mono muted">{fmtTime(e.ts)}</td>
                                                    <td><EventPill type={e.type} /></td>
                                                    <td className="mono">{e.step >= 0 && STEPS[e.step] ? STEPS[e.step].name : '—'}</td>
                                                    <td className="ellipsed">
                                                        {Object.entries(e.payload || {}).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(' • ') || '—'}
                                                    </td>
                                                </tr>
                                            )) : (
                                                <tr>
                                                    <td colSpan="4" className="empty-cell">No events. Start an experiment run to inspect.</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="panel inspection-side">
                                <div className="panel-header">
                                    <div>
                                        <h2>Event Details</h2>
                                        <p>Raw persisted evidence</p>
                                    </div>
                                </div>
                                <div className="detail-pane">
                                    {selectedEvent ? (
                                        <>
                                            <div className="detail-title">{selectedEvent.type}</div>
                                            <div className="detail-sub">Event ID #{selectedEvent.id} · {fmtTime(selectedEvent.ts)}</div>
                                            <pre>{JSON.stringify(selectedEvent, null, 2)}</pre>
                                        </>
                                    ) : (
                                        <div className="subtle-empty">Select any event row on the left to inspect its complete JSON payload.</div>
                                    )}
                                </div>
                                <div className="detail-footer">
                                    <button className="secondary-btn" onClick={download} disabled={!active}>
                                        <ArrowDownToLine size={15} /> Export complete evidence
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
                                <h2>Persistent Mock Order Records in SQLite</h2>
                                <p>Order effects commit to a separate durable SQLite database, not inferred from agent answers.</p>
                            </div>
                        </div>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                    <tr>
                                        <th>EXECUTION MODE</th>
                                        <th>ORDER ID</th>
                                        <th>IDEMPOTENCY KEY</th>
                                        <th>ITEM</th>
                                        <th>TIMESTAMP</th>
                                        <th>OUTCOME STATUS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[runs.naive, runs.plain, runs.brace].filter(Boolean).flatMap(r =>
                                        r.order_records.map((o, idx) => {
                                            const isDuplicate = r.mode !== 'brace' && idx > 0;
                                            return (
                                                <tr key={r.id + o.id}>
                                                    <td>
                                                        <strong style={{ color: r.mode === 'brace' ? '#86efac' : '#fca5a5' }}>
                                                            {r.mode === 'brace' ? 'WITH BRACE' : 'WITHOUT BRACE'}
                                                        </strong>
                                                        <span className="muted mono" style={{ marginLeft: '6px' }}>{r.id.slice(0, 7)}</span>
                                                    </td>
                                                    <td className="mono">#{o.id}</td>
                                                    <td className="mono">{o.idem_key}</td>
                                                    <td>{o.item}</td>
                                                    <td className="mono">{fmtTime(o.created_at)}</td>
                                                    <td>
                                                        {isDuplicate ? (
                                                            <span className="badge-dup">
                                                                <AlertTriangle size={11} /> DUPLICATE ORDER
                                                            </span>
                                                        ) : (
                                                            <span className="badge-clean">
                                                                <Check size={11} /> UNIQUE EFFECT
                                                            </span>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    ).length ? (
                                        [runs.naive, runs.plain, runs.brace].filter(Boolean).flatMap(r =>
                                            r.order_records.map((o, idx) => {
                                                const isDuplicate = r.mode !== 'brace' && idx > 0;
                                                return (
                                                    <tr key={r.id + o.id}>
                                                        <td>
                                                            <strong style={{ color: r.mode === 'brace' ? '#86efac' : '#fca5a5' }}>
                                                                {r.mode === 'brace' ? 'WITH BRACE' : 'WITHOUT BRACE'}
                                                            </strong>
                                                            <span className="muted mono" style={{ marginLeft: '6px' }}>{r.id.slice(0, 7)}</span>
                                                        </td>
                                                        <td className="mono">#{o.id}</td>
                                                        <td className="mono">{o.idem_key}</td>
                                                        <td>{o.item}</td>
                                                        <td className="mono">{fmtTime(o.created_at)}</td>
                                                        <td>
                                                            {isDuplicate ? (
                                                                <span className="badge-dup">
                                                                    <AlertTriangle size={11} /> DUPLICATE ORDER
                                                                </span>
                                                            ) : (
                                                                <span className="badge-clean">
                                                                    <Check size={11} /> UNIQUE EFFECT
                                                                </span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                );
                                            })
                                        )
                                    ) : (
                                        <tr>
                                            <td className="empty-cell" colSpan="6">No mock orders committed yet. Run an experiment to populate.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div className="info-box">
                            <strong>Why does Without BRACE create duplicates?</strong> In the lost-response timeout scenario, the unprotected baseline treats the network drop as a tool failure and generates a new idempotency key (<code>{ids.naive || 'run'}:attempt-2</code>). The external database commits both, producing double-orders. BRACE uses a persistent task-scoped idempotency key (<code>{ids.brace || 'run'}:place_order</code>), checks the external ledger, finds the committed record, and reconciles without duplicate dispatch!
                        </div>
                    </div>
                )}

                {page === 'benchmarks' && (
                    <div className="panel">
                        <div className="panel-header">
                            <div>
                                <h2>Controlled Benchmark Outcomes (With vs Without BRACE)</h2>
                                <p>Results from local reproducible trials across all 7 scenarios; no synthetic claims.</p>
                            </div>
                            <button className="secondary-btn" onClick={() => api('/benchmarks').then(setBenchmark).catch(e => setMessage(e.message))}>
                                <RotateCcw size={14} /> Reload results
                            </button>
                        </div>
                        {benchmark?.results?.length ? (
                            <>
                                <div className="bench-meta">
                                    {benchmark.trials} trials per setup/scenario · Generated: {benchmark.generated_at} · Deterministic Mock Store
                                </div>
                                <div className="table-wrap">
                                    <table>
                                        <thead>
                                            <tr>
                                                <th>SETUP / MODE</th>
                                                <th>SCENARIO</th>
                                                <th>TRIALS</th>
                                                <th>COMPLETED</th>
                                                <th>SAFE STOPS</th>
                                                <th>DUPLICATE ORDERS</th>
                                                <th>BUDGET OVERRUNS</th>
                                                <th>RESUME SUCCESS</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {benchmark.results.map((r, i) => (
                                                <tr key={i}>
                                                    <td>
                                                        <strong style={{ color: r.mode === 'brace' ? '#86efac' : '#fca5a5' }}>
                                                            {r.mode === 'brace' ? 'BRACE (PROTECTED)' : 'WITHOUT BRACE (' + r.mode.toUpperCase() + ')'}
                                                        </strong>
                                                    </td>
                                                    <td>{r.scenario}</td>
                                                    <td>{r.trials}</td>
                                                    <td>{r.completed}</td>
                                                    <td>{r.safe_stops ?? 0}</td>
                                                    <td style={{ color: r.duplicates > 0 ? '#f87171' : '#a7b7c5', fontWeight: r.duplicates > 0 ? 700 : 400 }}>
                                                        {r.duplicates}
                                                    </td>
                                                    <td>{r.overruns}</td>
                                                    <td>{r.resumed}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </>
                        ) : (
                            <div className="empty-benchmark">
                                <Terminal size={24} />
                                <h3>No benchmark results loaded</h3>
                                <p>Run the benchmark command below on your machine, then reload this page.</p>
                                <code>python -m brace.bench.run_bench --trials 30</code>
                            </div>
                        )}
                    </div>
                )}

                {page === 'about' && (
                    <div className="about-grid">
                        <div className="panel about-card">
                            <h2>Runtime Data Flow & Protection Pipeline</h2>
                            <div className="flow-list">
                                {[
                                    ['01', 'Agent Tool Request', 'The caller requests an operation with an idempotency key.'],
                                    ['02', 'Policy & Budget Gate', 'Deny unaffordable dispatches and detect loop repetition before invocation.'],
                                    ['03', 'Dispatch & Event Log', 'Record action states in append-only SQLite transactions.'],
                                    ['04', 'Reconcile Unknown Outcomes', 'On timeout, verify external durable ledger before retrying dangerous side effects.'],
                                    ['05', 'Checkpoint & Resume', 'Persist step checkpoints in SQLite WAL and resume safely after process exits.']
                                ].map(([n, a, b]) => (
                                    <div className="flow-step" key={n}>
                                        <span>{n}</span>
                                        <div>
                                            <b>{a}</b>
                                            <p>{b}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="panel about-card">
                            <h2>Evaluation Boundaries & Guarantees</h2>
                            <p>
                                <strong>Controlled Demonstrator:</strong> BRACE here evaluates AI tool execution under deterministic mock tools, persistent SQLite ledgers, and real OS subprocess terminations.
                            </p>
                            <p>
                                <strong>Without BRACE vs With BRACE:</strong> The baseline agent mimics typical standard agent patterns: blind retries, lack of idempotency keys across timeouts, and uncheckpointed memory.
                            </p>
                            <p>
                                <strong>Real-World Requirements:</strong> In production networks, real tools require upstream idempotency keys or ledger verification APIs. BRACE provides the recovery orchestration layer to manage these boundaries reliably.
                            </p>
                        </div>
                    </div>
                )}

                <footer>
                    BRACE · RELIABILITY & RECOVERY RUNTIME <span>Deterministic Faults. Inspectable Audit Logs. Reproducible Behavior.</span>
                </footer>
            </main>
        </div>
    </div>;
}

function Stat({ label, value, detail, status }) {
    return <div className="stat panel">
        <span>{label}</span>
        <strong className={status || ''}>{value}</strong>
        <small>{detail}</small>
    </div>;
}

function EventPill({ type }) {
    let kind = type.includes('failed') || type.includes('denied') || type.includes('exit') ? 'error'
        : type.includes('succeeded') || type.includes('completed') || type === 'verify_result' ? 'success'
        : type.includes('unknown') || type.includes('paused') || type.includes('timeout') ? 'warning'
        : 'ordinary';
    return <span className={'event-pill ' + kind}>{type}</span>;
}

function RunPanel({ run, label, headline, mode, onSelect, onKill, onResume }) {
    const isNaive = mode === 'naive';
    return <section className="panel run-panel">
        <div className="run-header">
            <div>
                <span className="run-label" style={{ color: isNaive ? '#f87171' : '#38bdf8' }}>{label}</span>
                <h3>{headline}</h3>
            </div>
            <span className={'status-pill ' + cls(run?.status)}>{run?.status || 'idle'}</span>
        </div>
        <div className="run-id">RUN ID <span className="mono">{run?.id || 'not started'}</span></div>
        <div className="step-list">
            {STEPS.map((stepObj, i) => {
                const done = run && i < run.step;
                const active = run && i === run.step && run.status === 'running';
                return <div className={'step-line ' + (done ? 'done' : active ? 'active' : '')} key={stepObj.name}>
                    <span className="step-indicator">
                        {done ? <Check size={13} /> : String(i + 1).padStart(2, '0')}
                    </span>
                    <span>{stepObj.name}</span>
                    <span style={{ fontSize: '10px', color: '#667788', marginLeft: '6px' }}>({stepObj.cost})</span>
                    <span className="step-state">{done ? 'completed' : active ? 'running' : 'pending'}</span>
                </div>;
            })}
        </div>
        <div className="run-kpis">
            <div>
                <span>Committed Orders</span>
                <b>{run?.orders ?? '—'}</b>
            </div>
            <div>
                <span>Duplicates</span>
                <b className={(run?.duplicates || 0) > 0 ? 'bad' : 'good'}>{run?.duplicates ?? '—'}</b>
            </div>
            <div>
                <span>Budget Spent</span>
                <b>{run ? money(run.spent) : '—'}</b>
            </div>
        </div>
        <div className="run-actions">
            <button className="text-btn" onClick={onSelect}>
                Inspect audit log <ArrowRight size={14} />
            </button>
            {run?.status === 'running' && (
                <button className="secondary-btn compact" onClick={onKill}>
                    <Square size={13} /> Kill worker process
                </button>
            )}
            {run?.status === 'interrupted' && (
                <button className="secondary-btn compact" onClick={onResume}>
                    <RotateCcw size={13} /> Resume from checkpoint
                </button>
            )}
        </div>
    </section>;
}

createRoot(document.getElementById('root')).render(<App />);
