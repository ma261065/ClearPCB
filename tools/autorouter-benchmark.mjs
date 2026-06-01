#!/usr/bin/env node
/**
 * Headless autorouter benchmark runner for DSN inputs.
 *
 * Usage (Windows PowerShell):
 *   node --experimental-default-type=module tools/autorouter-benchmark.mjs --dsn .\path\board.dsn
 *
 * Optional:
 *   --mode overnight
 *   --max-passes 5
 *   --grid-step 0.4
 *   --top 10
 *   --out .\benchmark-results.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { importDSN } from '../src/pcb/modules/dsn.js';
import { routeAll } from '../src/pcb/modules/autorouter-maze.js';
import { routeWithPathfinderRouter } from '../src/pcb/modules/autorouter-pathfinder.js';

function parseArgs(argv) {
    const args = {
        dsn: null,
        mode: 'recommended',
        router: 'maze',
        maxPasses: null,
        gridStep: null,
        maxCaseMinutes: null,
        top: 10,
        out: null,
        logIntervalSec: 15,
        bestIntervalMin: 10,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dsn') args.dsn = argv[++i];
        else if (a === '--mode') args.mode = String(argv[++i] || 'recommended').toLowerCase();
        else if (a === '--router') args.router = String(argv[++i] || 'maze').toLowerCase();
        else if (a === '--max-passes') args.maxPasses = Math.max(1, parseInt(argv[++i] || '4', 10) || 4);
        else if (a === '--grid-step') args.gridStep = parseFloat(argv[++i] || '0.5') || 0.5;
        else if (a === '--max-case-minutes') args.maxCaseMinutes = Math.max(1, parseFloat(argv[++i] || '1') || 1);
        else if (a === '--top') args.top = Math.max(1, parseInt(argv[++i] || '10', 10) || 10);
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--log-interval-sec') args.logIntervalSec = Math.max(1, parseInt(argv[++i] || '15', 10) || 15);
        else if (a === '--best-interval-min') args.bestIntervalMin = Math.max(1, parseInt(argv[++i] || '10', 10) || 10);
        else if (a === '--help' || a === '-h') {
            printHelp();
            process.exit(0);
        }
    }
    if (!['quick', 'recommended', 'balanced', 'overnight', 'exhaustive'].includes(args.mode)) {
        throw new Error('Invalid --mode. Use quick, recommended, balanced, overnight, or exhaustive');
    }
    if (!['maze', 'pathfinder', 'both'].includes(args.router)) {
        throw new Error('Invalid --router. Use maze, pathfinder, or both');
    }
    if (!args.dsn) {
        printHelp();
        throw new Error('Missing required --dsn argument');
    }
    return args;
}

function printHelp() {
    console.log([
        'Headless DSN autorouter benchmark',
        '',
        'Usage:',
        '  node --experimental-default-type=module tools/autorouter-benchmark.mjs --dsn .\\board.dsn',
        '',
        'Options:',
        '  --dsn <path>          DSN file to test',
        '  --mode <name>         quick | recommended | balanced | overnight | exhaustive (default recommended)',
        '  --router <name>       maze | pathfinder | both (default maze)',
        '  --max-passes <n>      Optional fixed rip-up passes (pins sweep to this value)',
        '  --grid-step <mm>      Optional fixed grid step in mm (pins sweep to this value)',
        '  --max-case-minutes <n> Optional timeout per case (cancel + keep best-so-far)',
        '  --top <n>             Number of top results to print (default 10)',
        '  --log-interval-sec <n> Progress print interval per case (default 15)',
        '  --best-interval-min <n> Print best-so-far heartbeat interval (default 10)',
        '  --out <path>          JSON report path (default auto timestamp file)',
    ].join('\n'));
}

function rankResults(results) {
    return results.slice().sort((a, b) => {
        if (a.failed !== b.failed) return a.failed - b.failed;
        if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
        return b.routedNets - a.routedNets;
    });
}

function printBestHeartbeat(results, sweep, startedAtIso) {
    const elapsedSec = (Date.now() - Date.parse(startedAtIso)) / 1000;
    if (!results.length) {
        console.log(`[heartbeat] elapsed=${fmtSec(elapsedSec)} completed=0/${sweep.length} best=none-yet`);
        return;
    }
    const best = rankResults(results)[0];
    console.log(
        `[heartbeat] elapsed=${fmtSec(elapsedSec)} completed=${results.length}/${sweep.length} ` +
        `best={failed=${best.failed}, routed=${best.routedNets}/${best.totalNets}, time=${fmtSec(best.elapsedMs / 1000)}} ` +
        `${best.label}`
    );
}

function fmtSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '--:--';
    const s = Math.round(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
}

function timestampName() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function buildScaledOverrides(scale) {
    const c = {
        viaCostScale: scale.viaCostScale ?? 1.0,
        bendCostScale: scale.bendCostScale ?? 1.0,
        padDiagCostScale: scale.padDiagCostScale ?? 1.0,
        dirPenaltyScale: scale.dirPenaltyScale ?? 1.0,
        congestionPenaltyScale: scale.congestionPenaltyScale ?? 1.0,
        viaCongestionScale: scale.viaCongestionScale ?? 1.0,
    };

    const mkAttempt = (tag, base) => ({
        effortTag: `${tag}-w${scale.weightScale.toFixed(2)}-d${scale.detourScale.toFixed(2)}-i${scale.iterScale.toFixed(2)}-vc${c.viaCostScale.toFixed(2)}-bc${c.bendCostScale.toFixed(2)}-pc${c.padDiagCostScale.toFixed(2)}-dc${c.dirPenaltyScale.toFixed(2)}-cc${c.congestionPenaltyScale.toFixed(2)}-vcc${c.viaCongestionScale.toFixed(2)}`,
        weight: +(base.weight * scale.weightScale).toFixed(4),
        maxDetourFactor: +(base.maxDetourFactor * scale.detourScale).toFixed(4),
        maxIter: Math.max(1000, Math.round(base.maxIter * scale.iterScale)),
        stagnationIters: Math.max(500, Math.round(base.stagnationIters * scale.iterScale)),
        viaCostScale: c.viaCostScale,
        bendCostScale: c.bendCostScale,
        padDiagCostScale: c.padDiagCostScale,
        dirPenaltyScale: c.dirPenaltyScale,
        congestionPenaltyScale: c.congestionPenaltyScale,
        viaCongestionScale: c.viaCongestionScale,
    });

    return {
        initial: {
            attempt1: mkAttempt('i1', { weight: 1.4, maxDetourFactor: 2.0, maxIter: 100000, stagnationIters: 25000 }),
            attempt2: mkAttempt('i2', { weight: 1.2, maxDetourFactor: 3.0, maxIter: 300000, stagnationIters: 60000 }),
            attempt3: mkAttempt('i3', { weight: 1.0, maxDetourFactor: 5.0, maxIter: 600000, stagnationIters: 120000 }),
        },
        ripup: {
            1: {
                attempt1: mkAttempt('r1a1', { weight: 1.5, maxDetourFactor: 1.8, maxIter: 80000, stagnationIters: 18000 }),
                attempt2: mkAttempt('r1a2', { weight: 1.3, maxDetourFactor: 2.3, maxIter: 180000, stagnationIters: 35000 }),
            },
            2: {
                attempt1: mkAttempt('r2a1', { weight: 1.4, maxDetourFactor: 2.1, maxIter: 110000, stagnationIters: 25000 }),
                attempt2: mkAttempt('r2a2', { weight: 1.2, maxDetourFactor: 3.2, maxIter: 320000, stagnationIters: 65000 }),
                attempt3: mkAttempt('r2a3', { weight: 1.0, maxDetourFactor: 5.2, maxIter: 620000, stagnationIters: 125000 }),
            },
            3: {
                attempt1: mkAttempt('r3a1', { weight: 1.35, maxDetourFactor: 2.5, maxIter: 140000, stagnationIters: 32000 }),
                attempt2: mkAttempt('r3a2', { weight: 1.15, maxDetourFactor: 3.8, maxIter: 420000, stagnationIters: 85000 }),
                attempt3: mkAttempt('r3a3', { weight: 1.0, maxDetourFactor: 6.5, maxIter: 850000, stagnationIters: 170000 }),
            },
            4: {
                attempt1: mkAttempt('r4a1', { weight: 1.3, maxDetourFactor: 3.0, maxIter: 180000, stagnationIters: 45000 }),
                attempt2: mkAttempt('r4a2', { weight: 1.1, maxDetourFactor: 4.8, maxIter: 560000, stagnationIters: 120000 }),
                attempt3: mkAttempt('r4a3', { weight: 1.0, maxDetourFactor: 8.0, maxIter: 1100000, stagnationIters: 240000 }),
            },
        },
    };
}

const SWEEP_PRESETS = {
    quick: {
        maxPasses: [4],
        gridSteps: [0.5],
        weightScales: [0.95, 1.0, 1.05],
        detourScales: [0.95, 1.05],
        iterScales: [0.9, 1.1],
        costProfiles: [
            { name: 'neutral', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'low-via', viaCostScale: 0.8, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.9 },
            { name: 'low-angle', viaCostScale: 1.0, bendCostScale: 0.8, padDiagCostScale: 0.85, dirPenaltyScale: 0.85, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
        ],
    },
    recommended: {
        maxPasses: [4, 5],
        gridSteps: [0.45, 0.5],
        weightScales: [0.95, 1.0, 1.08],
        detourScales: [0.95, 1.05, 1.2],
        iterScales: [0.9, 1.1],
        costProfiles: [
            { name: 'neutral', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'low-via', viaCostScale: 0.8, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.9 },
            { name: 'high-via', viaCostScale: 1.2, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.1 },
            { name: 'low-angle', viaCostScale: 1.0, bendCostScale: 0.85, padDiagCostScale: 0.9, dirPenaltyScale: 0.9, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'high-angle', viaCostScale: 1.0, bendCostScale: 1.2, padDiagCostScale: 1.2, dirPenaltyScale: 1.2, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
        ],
    },
    balanced: {
        maxPasses: [4, 5],
        gridSteps: [0.45, 0.5, 0.55],
        weightScales: [0.9, 1.0, 1.1],
        detourScales: [0.9, 1.0, 1.15],
        iterScales: [0.85, 1.0, 1.2],
        costProfiles: [
            { name: 'neutral', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'low-via', viaCostScale: 0.8, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.9 },
            { name: 'high-via', viaCostScale: 1.2, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.1 },
            { name: 'low-angle', viaCostScale: 1.0, bendCostScale: 0.8, padDiagCostScale: 0.85, dirPenaltyScale: 0.85, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'high-angle', viaCostScale: 1.0, bendCostScale: 1.2, padDiagCostScale: 1.2, dirPenaltyScale: 1.2, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'high-congestion', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.25, viaCongestionScale: 1.25 },
        ],
    },
    overnight: {
        maxPasses: [4, 5, 6],
        gridSteps: [0.4, 0.45, 0.5, 0.55, 0.6],
        weightScales: [0.85, 0.95, 1.0, 1.1, 1.2],
        detourScales: [0.85, 0.95, 1.05, 1.2, 1.35],
        iterScales: [0.75, 0.9, 1.0, 1.2, 1.4],
        costProfiles: [
            { name: 'neutral', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'low-via', viaCostScale: 0.75, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.85 },
            { name: 'high-via', viaCostScale: 1.3, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.2 },
            { name: 'low-angle', viaCostScale: 1.0, bendCostScale: 0.75, padDiagCostScale: 0.8, dirPenaltyScale: 0.8, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'high-angle', viaCostScale: 1.0, bendCostScale: 1.3, padDiagCostScale: 1.25, dirPenaltyScale: 1.25, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            { name: 'high-congestion', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.35, viaCongestionScale: 1.35 },
            { name: 'low-congestion', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 0.8, viaCongestionScale: 0.8 },
            { name: 'tight-angle-high-via', viaCostScale: 1.25, bendCostScale: 1.2, padDiagCostScale: 1.2, dirPenaltyScale: 1.2, congestionPenaltyScale: 1.1, viaCongestionScale: 1.15 },
        ],
    },
    exhaustive: {
        // Full-factorial over a bounded but meaningful range.
        // This is intentionally large and may run for many hours.
        exhaustiveIndependent: true,
        maxPasses: [4, 5],
        gridSteps: [0.45, 0.5],
        weightScales: [0.95, 1.05],
        detourScales: [0.95, 1.15],
        iterScales: [0.9, 1.1],
        viaCostScales: [0.85, 1.15],
        bendCostScales: [0.85, 1.15],
        padDiagCostScales: [0.85, 1.15],
        dirPenaltyScales: [0.85, 1.15],
        congestionPenaltyScales: [0.85, 1.15],
        viaCongestionScales: [0.85, 1.15],
    },
};

function buildSweep(args) {
    const preset = SWEEP_PRESETS[args.mode];
    const maxPassesValues = args.maxPasses != null ? [args.maxPasses] : preset.maxPasses;
    const gridSteps = args.gridStep != null ? [args.gridStep] : preset.gridSteps;

    const cases = [];

    if (preset.exhaustiveIndependent) {
        for (const mp of maxPassesValues) {
            for (const gs of gridSteps) {
                for (const w of preset.weightScales) {
                    for (const d of preset.detourScales) {
                        for (const i of preset.iterScales) {
                            for (const vc of preset.viaCostScales) {
                                for (const bc of preset.bendCostScales) {
                                    for (const pc of preset.padDiagCostScales) {
                                        for (const dc of preset.dirPenaltyScales) {
                                            for (const cc of preset.congestionPenaltyScales) {
                                                for (const vcc of preset.viaCongestionScales) {
                                                    cases.push({
                                                        maxPasses: mp,
                                                        gridStep: gs,
                                                        weightScale: w,
                                                        detourScale: d,
                                                        iterScale: i,
                                                        costProfile: 'independent',
                                                        viaCostScale: vc,
                                                        bendCostScale: bc,
                                                        padDiagCostScale: pc,
                                                        dirPenaltyScale: dc,
                                                        congestionPenaltyScale: cc,
                                                        viaCongestionScale: vcc,
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return cases;
    }

    for (const mp of maxPassesValues) {
        for (const gs of gridSteps) {
            for (const w of preset.weightScales) {
                for (const d of preset.detourScales) {
                    for (const i of preset.iterScales) {
                        for (const cp of preset.costProfiles) {
                            cases.push({
                                maxPasses: mp,
                                gridStep: gs,
                                weightScale: w,
                                detourScale: d,
                                iterScale: i,
                                costProfile: cp.name,
                                viaCostScale: cp.viaCostScale,
                                bendCostScale: cp.bendCostScale,
                                padDiagCostScale: cp.padDiagCostScale,
                                dirPenaltyScale: cp.dirPenaltyScale,
                                congestionPenaltyScale: cp.congestionPenaltyScale,
                                viaCongestionScale: cp.viaCongestionScale,
                            });
                        }
                    }
                }
            }
        }
    }
    return cases;
}

async function runOne(routeInput, sweepCase, opts, index, total) {
    routeInput.gridStep = sweepCase.gridStep;
    const tuning = buildScaledOverrides(sweepCase);

    let lastProgressLog = 0;
    let latestProgress = { completed: 0, total: routeInput.connections.length, phase: 'initial' };
    let timedOut = false;
    const caseCancelToken = { cancelled: false };
    const start = performance.now();

    let timeoutHandle = null;
    if (Number.isFinite(opts.maxCaseMinutes) && opts.maxCaseMinutes > 0) {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            caseCancelToken.cancelled = true;
        }, opts.maxCaseMinutes * 60 * 1000);
    }

    let result;
    try {
        result = await routeAll(routeInput, {
            maxPasses: sweepCase.maxPasses,
            profileOverrides: tuning,
            cancelToken: caseCancelToken,
            onProgress(completed, totalNets, netName, meta) {
                latestProgress = {
                    completed,
                    total: totalNets,
                    netName,
                    phase: meta?.phase || 'routing',
                    ripupPass: meta?.ripupPass || 0,
                    ripupPassTotal: meta?.ripupPassTotal || 0,
                };

                const now = Date.now();
                if (now - lastProgressLog < opts.logIntervalSec * 1000) return;
                lastProgressLog = now;

                const runElapsedSec = (performance.now() - start) / 1000;
                const done = latestProgress.completed;
                const t = Math.max(1, latestProgress.total || 1);
                const pct = Math.max(0, Math.min(100, (done / t) * 100));
                const phaseSuffix = latestProgress.phase === 'ripup' && latestProgress.ripupPassTotal
                    ? ` ripup ${latestProgress.ripupPass}/${latestProgress.ripupPassTotal}`
                    : '';
                const netSuffix = latestProgress.netName ? ` net=${latestProgress.netName}` : '';

                console.log(
                    `[${String(index).padStart(3, '0')}/${total}] progress ${pct.toFixed(1)}% ` +
                    `(${done}/${t}) phase=${latestProgress.phase}${phaseSuffix}${netSuffix} ` +
                    `elapsed=${fmtSec(runElapsedSec)}`
                );
            },
        });
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const elapsedMs = performance.now() - start;

    const totalNets = routeInput.connections.length;
    const routedNets = new Set(result.traces.map(t => t.net)).size;
    const failedNets = Array.isArray(result.failed) ? result.failed.slice() : [];
    const failed = failedNets.length;

    return {
        label: labelScale(sweepCase),
        sweepCase,
        tuning,
        totalNets,
        routedNets,
        failed,
        failedNets,
        timedOut,
        segments: result.traces.length,
        vias: result.vias?.length || 0,
        elapsedMs: Math.round(elapsedMs),
        lastProgress: latestProgress,
    };
}

function labelScale(s) {
    if (s.router === 'pathfinder') {
        return `[pathfinder] g=${s.gridStep.toFixed(2)} gw=${s.greedyWeight.toFixed(2)} it=${s.maxIterations}`;
    }
    return `p=${s.maxPasses} g=${s.gridStep.toFixed(2)} w=${s.weightScale.toFixed(2)} d=${s.detourScale.toFixed(2)} i=${s.iterScale.toFixed(2)} cp=${s.costProfile} vc=${s.viaCostScale.toFixed(2)} bc=${s.bendCostScale.toFixed(2)} pc=${s.padDiagCostScale.toFixed(2)} dc=${s.dirPenaltyScale.toFixed(2)} cc=${s.congestionPenaltyScale.toFixed(2)} vcc=${s.viaCongestionScale.toFixed(2)}`;
}

/**
 * Build pathfinder benchmark cases. The negotiated-congestion router has no
 * maze-style parameter sweep (it self-iterates), so we only vary the grid
 * step — the single dimension shared with the maze sweep — and otherwise use
 * the router's tuned defaults. One case per distinct grid step.
 */
function buildPathfinderCases(args) {
    const preset = SWEEP_PRESETS[args.mode];
    const gridSteps = args.gridStep != null ? [args.gridStep] : preset.gridSteps;
    return gridSteps.map(gs => ({
        router: 'pathfinder',
        gridStep: gs,
        greedyWeight: 1.5,
        maxIterations: 25,
    }));
}

/**
 * Build the full case list based on the requested router(s). Maze cases are
 * tagged router:'maze' so the dispatch loop can route each case to the right
 * runner.
 */
function buildCases(args) {
    const cases = [];
    if (args.router === 'maze' || args.router === 'both') {
        for (const c of buildSweep(args)) {
            cases.push({ ...c, router: 'maze' });
        }
    }
    if (args.router === 'pathfinder' || args.router === 'both') {
        cases.push(...buildPathfinderCases(args));
    }
    return cases;
}

/**
 * Run a single pathfinder case. Mirrors runOne's result-row shape so
 * pathfinder and maze results rank together.
 */
async function runPathfinderOne(routeInput, pfCase, opts, index, total) {
    routeInput.gridStep = pfCase.gridStep;

    let lastProgressLog = 0;
    let latestProgress = { completed: 0, total: routeInput.connections.length, phase: 'pathfinder' };
    let timedOut = false;
    const caseCancelToken = { cancelled: false };
    const start = performance.now();

    let timeoutHandle = null;
    if (Number.isFinite(opts.maxCaseMinutes) && opts.maxCaseMinutes > 0) {
        timeoutHandle = setTimeout(() => {
            timedOut = true;
            caseCancelToken.cancelled = true;
        }, opts.maxCaseMinutes * 60 * 1000);
    }

    let result;
    try {
        result = await routeWithPathfinderRouter(routeInput, {
            greedyWeight: pfCase.greedyWeight,
            maxIterations: pfCase.maxIterations,
            cancelToken: caseCancelToken,
            onProgress(completed, totalUnits, label, meta) {
                latestProgress = {
                    completed,
                    total: totalUnits,
                    netName: label,
                    phase: meta?.phase || 'pathfinder',
                };
                const now = Date.now();
                if (now - lastProgressLog < opts.logIntervalSec * 1000) return;
                lastProgressLog = now;
                const runElapsedSec = (performance.now() - start) / 1000;
                const done = latestProgress.completed;
                const t = Math.max(1, latestProgress.total || 1);
                const pct = Math.max(0, Math.min(100, (done / t) * 100));
                console.log(
                    `[${String(index).padStart(3, '0')}/${total}] pathfinder ${pct.toFixed(1)}% ` +
                    `phase=${latestProgress.phase} ${latestProgress.netName || ''} ` +
                    `elapsed=${fmtSec(runElapsedSec)}`
                );
            },
        });
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const elapsedMs = performance.now() - start;
    const totalNets = routeInput.connections.length;
    const routedNets = new Set(result.traces.map(t => t.net)).size;
    const failedNets = Array.isArray(result.failed) ? result.failed.slice() : [];
    const failed = failedNets.length;

    return {
        router: 'pathfinder',
        label: labelScale(pfCase),
        sweepCase: pfCase,
        tuning: null,
        totalNets,
        routedNets,
        failed,
        failedNets,
        timedOut,
        segments: result.traces.length,
        vias: result.vias?.length || 0,
        elapsedMs: Math.round(elapsedMs),
        lastProgress: latestProgress,
        pathfinder: {
            converged: result.pathfinderConverged,
            iterations: result.pathfinderIterations,
            emittedIter: result.pathfinderEmittedIter,
            trialCandidates: result.pathfinderTrialCandidates,
            trialDropped: result.pathfinderTrialDropped,
            trialRecovered: result.pathfinderTrialRecovered,
        },
    };
}

async function writeReport(filePath, payload) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

async function main() {
    const args = parseArgs(process.argv);
    const dsnPath = path.resolve(args.dsn);
    const outPath = path.resolve(args.out || `./benchmark-results-${timestampName()}.json`);

    const dsnText = await fs.readFile(dsnPath, 'utf8');
    const { routeInput, meta } = importDSN(dsnText);

    console.log(`Loaded DSN: ${dsnPath}`);
    console.log(`Nets=${meta.nets} Pads=${meta.pads} Resolution=${meta.unit} ${meta.resolution}`);
    console.log(`Sweep mode: ${args.mode}`);
    console.log(`Report file: ${outPath}`);
    console.log(`Best heartbeat: every ${args.bestIntervalMin} min`);
    if (args.maxCaseMinutes != null) {
        console.log(`Per-case timeout: ${args.maxCaseMinutes} min`);
    }

    const sweep = buildCases(args);
    const results = [];
    const startedAt = new Date().toISOString();
    let interrupted = false;
    const bestTimer = setInterval(() => {
        printBestHeartbeat(results, sweep, startedAt);
    }, args.bestIntervalMin * 60 * 1000);

    process.on('SIGINT', () => {
        interrupted = true;
        console.log('\nSIGINT received: finishing current case, then stopping.');
    });

    await writeReport(outPath, {
        status: 'running',
        startedAt,
        updatedAt: new Date().toISOString(),
        input: { dsnPath },
        sweep: {
            mode: args.mode,
            totalCases: sweep.length,
            logIntervalSec: args.logIntervalSec,
            maxCaseMinutes: args.maxCaseMinutes,
        },
        meta,
        progress: { completedCases: 0, totalCases: sweep.length },
        results: [],
        top: [],
    });

    console.log(`Total cases: ${sweep.length}`);

    for (let i = 0; i < sweep.length; i++) {
        if (interrupted) break;

        const caseIndex = i + 1;
        const s = sweep[i];
        const runInput = deepClone(routeInput);
        const label = labelScale(s);

        console.log(`\n[${String(caseIndex).padStart(3, '0')}/${sweep.length}] START ${label}`);
        const r = s.router === 'pathfinder'
            ? await runPathfinderOne(runInput, s, args, caseIndex, sweep.length)
            : await runOne(runInput, s, args, caseIndex, sweep.length);

        const row = {
            ...r,
        };
        results.push(row);

        const elapsedOverallSec = (results.reduce((sum, x) => sum + x.elapsedMs, 0)) / 1000;
        const avgSec = elapsedOverallSec / results.length;
        const remain = sweep.length - results.length;
        const etaSec = avgSec * remain;

        console.log(
            `[${String(caseIndex).padStart(3, '0')}/${sweep.length}] DONE ${row.label} -> ` +
            `failed=${row.failed}, routed=${row.routedNets}/${row.totalNets}, ` +
            `time=${fmtSec(row.elapsedMs / 1000)}${row.timedOut ? ' (timeout)' : ''}, ` +
            `overall=${fmtSec(elapsedOverallSec)}, eta=${fmtSec(etaSec)}`
        );

        if (row.failedNets.length) {
            console.log(`  failed nets: ${row.failedNets.join(', ')}`);
        }

        const interimSorted = rankResults(results);
        const interimTop = interimSorted.slice(0, args.top);

        await writeReport(outPath, {
            status: interrupted ? 'interrupted' : 'running',
            startedAt,
            updatedAt: new Date().toISOString(),
            input: { dsnPath },
            sweep: {
                mode: args.mode,
                totalCases: sweep.length,
                logIntervalSec: args.logIntervalSec,
                maxCaseMinutes: args.maxCaseMinutes,
            },
            meta,
            progress: {
                completedCases: results.length,
                totalCases: sweep.length,
                elapsedSec: Math.round(elapsedOverallSec),
                etaSec: Math.round(etaSec),
            },
            results,
            top: interimTop,
        });
    }

    clearInterval(bestTimer);

    results.sort((a, b) => {
        if (a.failed !== b.failed) return a.failed - b.failed;
        if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
        return b.routedNets - a.routedNets;
    });

    const top = results.slice(0, args.top);
    console.log('\nTop results:');
    for (let i = 0; i < top.length; i++) {
        const r = top[i];
        console.log(
            `${i + 1}. ${r.label} | failed=${r.failed} | routed=${r.routedNets}/${r.totalNets} | ` +
            `seg=${r.segments} via=${r.vias} | ${fmtSec(r.elapsedMs / 1000)}${r.timedOut ? ' timeout' : ''}`
        );
    }

    const elapsedOverallSec = (results.reduce((sum, x) => sum + x.elapsedMs, 0)) / 1000;
    await writeReport(outPath, {
        status: interrupted ? 'interrupted' : 'completed',
        startedAt,
        updatedAt: new Date().toISOString(),
        input: { dsnPath },
        sweep: {
            mode: args.mode,
            totalCases: sweep.length,
            logIntervalSec: args.logIntervalSec,
            maxCaseMinutes: args.maxCaseMinutes,
        },
        meta,
        progress: {
            completedCases: results.length,
            totalCases: sweep.length,
            elapsedSec: Math.round(elapsedOverallSec),
            etaSec: 0,
        },
        results,
        top,
    });
    console.log(`\nWrote JSON report: ${outPath}`);
}

main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
});
