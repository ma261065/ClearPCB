import { AutorouterPresentation } from './autorouter-presentation.js';

/**
 * @typedef {object} AutorouterBoardState
 * @property {boolean} active
 * @property {boolean} editing
 * @property {object} model Identity of the authored document (never mutated here).
 * @property {Map} placements
 * @property {Array} netlist
 * @property {Array} undo
 * @property {Array} redo
 * @property {object} rules Canonical routing dimensions.
 *
 * @typedef {object} AutorouterCapabilities
 * @property {() => AutorouterBoardState} readBoard
 * @property {() => object} takeRouteInput Consume a test input or build a fresh board input.
 * @property {() => string} getRouterMode
 * @property {(result: object) => void} adoptResult Publish one undoable route replacement.
 * @property {() => void} reconcileRatsnest Restore the authored board's connectivity.
 * @property {(message: string) => void} setStatus
 * @property {import('./autorouter-presentation.js').AutorouterPresentationCapabilities} presentation
 * @property {(error: Error) => void} [reportError]
 */

/** Owns one latest-only routing session; Stop accepts partial output, cancel never does. */
export class AutorouterSession {
    /**
     * @param {AutorouterCapabilities} capabilities
     * @param {Partial<import('./autorouter-presentation.js').AutorouterPresentationRuntime> & {createWorker?: () => Worker}} [runtime]
     * Explicit worker/clock/scheduler overrides for headless contracts.
     */
    constructor(capabilities, runtime = {}) {
        this.capabilities = capabilities;
        this.runtime = {
            createWorker: () => new Worker(new URL('./autorouter-worker.js', import.meta.url), { type: 'module' }),
            now: () => performance.now(),
            setInterval: (callback, delay) => setInterval(callback, delay),
            clearInterval: id => clearInterval(id),
            ...runtime,
        };
        this.presentation = new AutorouterPresentation(capabilities.presentation, () => this.stop(), runtime);
        this._session = null;
        this._worker = null;
        this._disposed = false;
    }

    get active() { return this._session !== null; }

    _isCurrent(session) {
        if (this._disposed || this._session !== session) return false;
        const board = this.capabilities.readBoard();
        return board.active && !board.editing && board.model === session.model
            && board.placements === session.placements && board.netlist === session.netlist
            && Object.entries(session.rules).every(([key, value]) => board.rules[key] === value)
            && board.undo.length === session.undo.length
            && board.undo.every((command, index) => command === session.undo[index])
            && board.redo.length === session.redo.length
            && board.redo.every((command, index) => command === session.redo[index]);
    }

    async run() {
        if (this._disposed) return;
        const board = this.capabilities.readBoard();
        if (!board.active) return;
        if (board.editing) {
            this.capabilities.setStatus('Finish the current edit before routing.');
            return;
        }
        if (!board.placements.size || !board.netlist.length) {
            this.capabilities.setStatus('Nothing to route');
            return;
        }
        this.cancel();
        const session = {
            model: board.model, placements: board.placements, netlist: board.netlist,
            undo: [...board.undo], redo: [...board.redo], rules: { ...board.rules },
            cancelToken: { cancelled: false },
        };
        this._session = session;
        const current = () => this._isCurrent(session);
        let adopting = false;
        try {
            this.presentation.start();
            const input = this.capabilities.takeRouteInput();
            input.trackWidth = session.rules.trackWidth;
            input.clearance = session.rules.clearance;
            input.viaDiameter = session.rules.viaDiameter;
            this.presentation.beginConnections(input.connections);
            const startTime = this.runtime.now();
            const result = await this._runInWorker(input, session, this.capabilities.getRouterMode());
            if (!result || !current()) {
                if (this._session === session) this.cancel('Routing cancelled because the board changed.');
                return;
            }
            if (!session.cancelToken.cancelled) await this.presentation.finishRipupPhases(current);
            if (!current()) {
                if (this._session === session) this.cancel('Routing cancelled because the board changed.');
                return;
            }

            this.presentation.finish();
            // Release before the command's dirty notification invalidates pending sessions.
            this._session = null;
            adopting = true;
            this.capabilities.adoptResult(result);
            const seconds = Math.max(0, Math.floor((this.runtime.now() - startTime) / 1000));
            const elapsed = `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} sec`;
            const total = result.totalConnectionCount || input.connections.length;
            const failed = result.failedConnectionCount || 0;
            this.capabilities.setStatus(`Routed ${total - failed} of ${total} connections (${failed} unrouted), ${result.tracks.length} segments, ${result.vias?.length || 0} vias in ${elapsed}`);
        } catch (error) {
            if (this._session !== session && !adopting) return;
            this.cancel();
            (this.capabilities.reportError || (error => console.error('Autorouter error:', error)))(error);
            this.capabilities.setStatus(`Route error: ${error.message}`);
        } finally {
            if (this._session === session) this.cancel();
        }
    }

    /** Cooperative Stop leaves the session current so its partial result can be adopted. */
    stop() {
        const session = this._session;
        if (!session) return;
        session.cancelToken.cancelled = true;
        this.presentation.skipRemainingPhases();
        this._worker?.requestStop();
    }

    /** Invalidation discards every pending result and restores authored presentation. */
    cancel(message = null) {
        const session = this._session;
        if (!session) return;
        this._session = null;
        session.cancelToken.cancelled = true;
        session.cancelToken.abort?.();
        this.presentation.reset();
        this.capabilities.reconcileRatsnest();
        if (message) this.capabilities.setStatus(message);
    }

    dispose() {
        this._disposed = true;
        this.cancel();
        this.presentation.dispose();
    }

    _runInWorker(routeInput, session, routerMode) {
        return new Promise((resolve, reject) => {
            const worker = this.runtime.createWorker();
            const token = session.cancelToken;
            let poll = null, settled = false;
            const cleanup = () => {
                if (poll !== null) this.runtime.clearInterval(poll);
                poll = null;
                worker.removeEventListener('message', onMessage);
                worker.removeEventListener('error', onError);
                worker.removeEventListener('messageerror', onMessageError);
                worker.terminate();
                if (this._worker === transport) this._worker = null;
                delete token.abort;
            };
            const settle = (result, error = null) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve(result);
            };
            const current = () => {
                if (settled) return false;
                if (this._isCurrent(session)) return true;
                if (this._session === session) this.cancel('Routing cancelled because the board changed.');
                else settle(null);
                return false;
            };
            const onError = event => {
                if (current()) settle(null, event?.error || new Error(event?.message || 'Autorouter worker failed'));
            };
            const onMessageError = () => onError(new Error('Invalid autorouter worker response'));
            const onMessage = event => {
                try {
                    if (!current()) return;
                    const message = event.data || {};
                    if (message.type === 'done') settle(message.result);
                    else if (message.type === 'error') settle(null, new Error(message.error || 'Autorouter worker error'));
                    else this.presentation.handleMessage(message);
                } catch (error) { onError(error); }
            };
            const transport = {
                requestStop: () => {
                    try {
                        if (current()) worker.postMessage({ type: 'cancel' });
                    } catch (error) { onError(error); }
                },
            };
            this._worker = transport;
            token.abort = () => settle(null);
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.addEventListener('messageerror', onMessageError);
            try {
                worker.postMessage({ type: 'start', routeInput, routerMode });
                if (!settled) poll = this.runtime.setInterval(() => {
                    if (current() && token.cancelled) transport.requestStop();
                }, 50);
            } catch (error) { onError(error); }
        });
    }
}
