"""Reproducible local benchmark. Every count comes from actual SQLite run records."""
import argparse, csv, json, os, subprocess, sys, tempfile, time
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description='BRACE controlled mock benchmark')
    parser.add_argument('--trials', type=int, default=30)
    parser.add_argument('--output', default=None)
    args = parser.parse_args()
    if args.trials < 1:
        parser.error('--trials must be positive')
    out = Path(args.output) if args.output else Path(__file__).resolve().parents[1] / 'data' / 'benchmarks.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    from brace.api import engine as e
    rows = []
    raw = []
    with tempfile.TemporaryDirectory(prefix='brace-bench-') as td:
        e.DB = Path(td) / 'results.sqlite3'
        e.init()
        for scenario in e.SCENARIOS:
            for mode in ('plain', 'naive', 'checkpoint', 'brace'):
                completed = duplicates = overruns = resumed = retry_count = safe_stops = 0
                for seed in range(args.trials):
                    limit = 0.12 if scenario == 'budget' else 0.5
                    rid = e.create(mode=mode, scenario=scenario, seed=seed, limit=limit)
                    if scenario == 'crash':
                        e.mark_status(rid, 'running')
                        for _ in range(3):
                            e.advance_one(rid)
                        with e.connect() as c:
                            e.emit(c, rid, 'bench_crash_injected', 2, checkpoint_step=3)
                        e.mark_status(rid, 'interrupted')
                        if mode in ('checkpoint', 'brace'):
                            e.worker(rid, delay=0)
                            resumed += int(e.snapshot(rid)['status'] == 'completed')
                    else:
                        e.worker(rid, delay=0)
                    d = e.snapshot(rid)
                    completed += d['status'] == 'completed'
                    duplicates += d['duplicates']
                    safe_stops += int(d['status'] == 'paused' and mode == 'brace' and (scenario in ('budget', 'loop')))
                    overruns += d['spent_cents'] > d['limit_cents']
                    retry_count += d['retries']
                    raw.append({'mode': mode, 'scenario': scenario, 'seed': seed, 'status': d['status'], 'completed': int(d['status'] == 'completed'), 'safe_stop': int(d['status'] == 'paused' and mode == 'brace' and (scenario in ('budget', 'loop'))), 'duplicates': d['duplicates'], 'overrun': int(d['spent_cents'] > d['limit_cents']), 'retries': d['retries'], 'spent_cents': d['spent_cents']})
                rows.append({'mode': mode, 'scenario': scenario, 'trials': args.trials, 'completed': completed, 'safe_stops': safe_stops, 'duplicates': duplicates, 'overruns': overruns, 'resumed': resumed, 'retries': retry_count})
    data = {'trials': args.trials, 'generated_at': time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime()), 'notes': 'Controlled local mock trials with seeded pre/post-commit outcomes and bounded HTTP failures. Crash benchmark simulates an interrupted worker; independent tests verify actual os._exit(31) recovery. Not production measurements.', 'results': rows}
    out.write_text(json.dumps(data, indent=2), encoding='utf-8')
    with out.with_suffix('.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    with out.with_name('benchmark-trials.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=raw[0].keys())
        writer.writeheader()
        writer.writerows(raw)
    print(f'Recorded {len(raw)} controlled mock trials to {out} and accompanying CSV files')
    for r in rows:
        if r['mode'] == 'brace':
            print(f"{r['scenario']:9} completed={r['completed']}/{r['trials']} dup={r['duplicates']} overrun={r['overruns']} resumed={r['resumed']}")
if __name__ == '__main__':
    main()
