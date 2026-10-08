/**
 * One gate for authored edits in both editors: a new command may not change or
 * remove a locked object. Each command declares what it changes with
 * `lockTargets()`, returning `{kind, object}` entries (children of compound and
 * batch commands are collected too). An editor's CommandHistory runs the guard
 * before executing, so a refused command changes nothing; editor checks stay in
 * place for feedback, and this catches any entry point they miss.
 *
 * Deliberately outside the gate:
 * - lock changes themselves, and undo/redo (history must stay consistent);
 * - net-only changes: nets follow connectivity, so routing to locked copper works;
 * - copper and wires that follow a moved part's pads or pins.
 */

export class LockedEditError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'LockedEditError';
    }
}

/** @typedef {{kind?: string, object: object|null|undefined}} LockTarget */
/** @typedef {{lockTargets?: () => LockTarget[], commands?: Command[]}} Command */

/**
 * Every target a command declares, including those of its child commands.
 * @param {Command|null|undefined} command
 * @param {LockTarget[]} [out]
 * @returns {LockTarget[]}
 */
export function commandLockTargets(command, out = []) {
    if (!command) return out;
    if (typeof command.lockTargets === 'function') out.push(...command.lockTargets());
    for (const child of Array.isArray(command.commands) ? command.commands : []) commandLockTargets(child, out);
    return out;
}

/** @param {unknown} a @param {unknown} b */
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether a before/after edit changes nothing but the net (or the lock itself).
 * @param {Record<string, unknown>} [before]
 * @param {Record<string, unknown>} [after]
 */
export function netOnlyChange(before = {}, after = {}) {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
        if (key !== 'net' && key !== 'locked' && !same(before?.[key], after?.[key])) return false;
    }
    return true;
}

/** Targets for a single changed object, or none when the edit only touches its net.
 * @param {string|undefined} kind
 * @param {object|null|undefined} object
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @returns {LockTarget[]}
 */
export function editTargets(kind, object, before, after) {
    return object == null || netOnlyChange(before, after) ? [] : [{ kind, object }];
}

/**
 * Build a CommandHistory guard.
 * @param {(target: LockTarget) => boolean} isLocked
 * @param {(target: LockTarget) => string} describe message for a refused edit
 * @returns {(command: Command) => void}
 */
export function createLockGuard(isLocked, describe) {
    return command => {
        for (const target of commandLockTargets(command)) {
            if (target?.object != null && isLocked(target)) throw new LockedEditError(describe(target));
        }
    };
}

/** Keep an expected refusal out of the console when it reaches an event handler unhandled. */
export function installLockedEditErrorFilter(target = globalThis) {
    target.addEventListener?.('error', event => {
        if (event.error?.name === 'LockedEditError') event.preventDefault();
    });
    target.addEventListener?.('unhandledrejection', event => {
        if (event.reason?.name === 'LockedEditError') event.preventDefault();
    });
}
