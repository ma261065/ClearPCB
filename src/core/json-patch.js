const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** @param {string} path */
function decodePointer(path) {
    if (path === '') return [];
    if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer: ${String(path)}`);
    }
    return path.slice(1).split('/').map((segment) => {
        const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
        if (FORBIDDEN_SEGMENTS.has(decoded)) throw new Error(`Unsafe JSON Pointer segment: ${decoded}`);
        return decoded;
    });
}

/**
 * @param {string} segment
 * @param {number} length
 * @param {{allowEnd?: boolean}} [options]
 */
function arrayIndex(segment, length, { allowEnd = false } = {}) {
    if (allowEnd && segment === '-') return length;
    if (!/^(0|[1-9]\d*)$/.test(segment)) throw new Error(`Invalid array index: ${segment}`);
    const index = Number(segment);
    const maximum = allowEnd ? length : length - 1;
    if (index > maximum) throw new Error(`Array index out of bounds: ${segment}`);
    return index;
}

/**
 * JSON patch values are untrusted document fragments, so pointer traversal
 * stays typed as `any` at this boundary.
 * @param {any} document
 * @param {string} path
 * @param {{allowAppend?: boolean}} [options]
 * @returns {{root: true, parent: null, key: null}|{root: false, parent: any, key: string|number}}
 */
function location(document, path, { allowAppend = false } = {}) {
    const segments = decodePointer(path);
    if (!segments.length) return { root: true, parent: null, key: null };
    let parent = document;
    for (const segment of segments.slice(0, -1)) {
        if (Array.isArray(parent)) parent = parent[arrayIndex(segment, parent.length)];
        else if (parent && typeof parent === 'object'
            && Object.prototype.hasOwnProperty.call(parent, segment)) parent = parent[segment];
        else throw new Error(`JSON Pointer does not exist: ${path}`);
    }
    if (!parent || typeof parent !== 'object') throw new Error(`JSON Pointer parent is not a container: ${path}`);
    const final = /** @type {string} */ (segments.at(-1));
    const key = Array.isArray(parent) ? arrayIndex(final, parent.length, { allowEnd: allowAppend }) : final;
    return { root: false, parent, key };
}

/**
 * @param {any} document
 * @param {string} path
 * @returns {any}
 */
function getValue(document, path) {
    const target = location(document, path);
    if (target.root) return document;
    if (!Object.prototype.hasOwnProperty.call(target.parent, target.key)) {
        throw new Error(`JSON Pointer does not exist: ${path}`);
    }
    return target.parent[target.key];
}

/**
 * @param {any} document
 * @param {string} path
 * @param {any} value
 * @returns {any}
 */
function addValue(document, path, value) {
    const target = location(document, path, { allowAppend: true });
    const copy = structuredClone(value);
    if (target.root) return copy;
    if (Array.isArray(target.parent)) target.parent.splice(/** @type {number} */ (target.key), 0, copy);
    else target.parent[/** @type {string} */ (target.key)] = copy;
    return document;
}

/**
 * @param {any} document
 * @param {string} path
 * @returns {{document: any, removed: any}}
 */
function removeValue(document, path) {
    const target = location(document, path);
    if (target.root) return { document: undefined, removed: document };
    if (!Object.prototype.hasOwnProperty.call(target.parent, target.key)) {
        throw new Error(`JSON Pointer does not exist: ${path}`);
    }
    const removed = target.parent[target.key];
    if (Array.isArray(target.parent)) target.parent.splice(/** @type {number} */ (target.key), 1);
    else delete target.parent[/** @type {string} */ (target.key)];
    return { document, removed };
}

/**
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
function equalJson(left, right) {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => equalJson(value, right[index]));
    }
    if (left && right && typeof left === 'object' && typeof right === 'object'
        && !Array.isArray(left) && !Array.isArray(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return leftKeys.length === rightKeys.length
            && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
                && equalJson(left[key], right[key]));
    }
    return false;
}

/**
 * Apply an RFC 6902 JSON Patch atomically to a clone of the supplied value.
 * @param {any} value
 * @param {Array<{op:string,path:string,from?:string,value?:any}>} patch
 * @returns {any}
 */
export function applyJsonPatch(value, patch) {
    if (!Array.isArray(patch)) throw new Error('JSON Patch must be an array.');
    let document = structuredClone(value);
    patch.forEach((operation, index) => {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
            throw new Error(`Invalid JSON Patch operation at index ${index}.`);
        }
        const { op, path } = operation;
        try {
            if (op === 'add') {
                if (!Object.prototype.hasOwnProperty.call(operation, 'value')) throw new Error('add requires value.');
                document = addValue(document, path, operation.value);
            } else if (op === 'remove') {
                document = removeValue(document, path).document;
            } else if (op === 'replace') {
                if (!Object.prototype.hasOwnProperty.call(operation, 'value')) throw new Error('replace requires value.');
                getValue(document, path);
                document = removeValue(document, path).document;
                document = addValue(document, path, operation.value);
            } else if (op === 'move') {
                if (typeof operation.from !== 'string') throw new Error('move requires from.');
                if (path.startsWith(`${operation.from}/`)) throw new Error('Cannot move a value into its descendant.');
                const result = removeValue(document, operation.from);
                document = addValue(result.document, path, result.removed);
            } else if (op === 'copy') {
                if (typeof operation.from !== 'string') throw new Error('copy requires from.');
                document = addValue(document, path, getValue(document, operation.from));
            } else if (op === 'test') {
                if (!Object.prototype.hasOwnProperty.call(operation, 'value')) throw new Error('test requires value.');
                if (!equalJson(getValue(document, path), operation.value)) throw new Error('test failed.');
            } else {
                throw new Error(`Unsupported operation: ${String(op)}`);
            }
        } catch (error) {
            throw new Error(`JSON Patch operation ${index} failed: ${error.message}`);
        }
    });
    return document;
}
