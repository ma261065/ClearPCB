/**
 * Page-wide generators for prefixed IDs such as `via_12`.
 *
 * Each entity kind owns one allocator. New IDs are one above the highest number
 * observed, so loading or constructing an entity with an explicit ID (`observe`)
 * guarantees later generated IDs cannot collide with it. Starting a new document
 * may `reset` an allocator before observing the loaded entities again.
 */
export class IdAllocator {
    /** @param {string} prefix ID prefix without the trailing underscore, e.g. `'via'`. */
    constructor(prefix) {
        this.prefix = prefix;
        this.head = `${prefix}_`;
        this.highest = 0;
    }

    /** @returns {string} The next unused generated ID. */
    next() {
        return `${this.head}${++this.highest}`;
    }

    /**
     * Record an existing ID so generated IDs skip past it; other formats are ignored.
     * @param {unknown} id
     */
    observe(id) {
        // Entities are constructed in bulk on load, so this parses without a regex or substring.
        if (typeof id !== 'string') return;
        const start = this.head.length;
        if (id.length <= start || id.length - start > 15 || !id.startsWith(this.head)) return;
        let number = 0;
        for (let index = start; index < id.length; index++) {
            const digit = id.charCodeAt(index) - 48;
            if (digit < 0 || digit > 9) return;
            number = number * 10 + digit;
        }
        if (number > this.highest) this.highest = number;
    }

    /**
     * Assign `id` when given (observing it), otherwise a newly generated ID.
     * @param {string|null|undefined} [id]
     * @returns {string}
     */
    claim(id) {
        if (id) {
            this.observe(id);
            return id;
        }
        return this.next();
    }

    reset() {
        this.highest = 0;
    }
}
