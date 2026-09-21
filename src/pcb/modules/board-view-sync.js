export function createBoardViewSync({ refresh3D, refresh2D, on3DSettled = () => {} }) {
    let sourceRevision = 0;
    let applied3DRevision = 0;
    const inFlight = new Set();

    const settle = (revision, applied) => {
        inFlight.delete(revision);
        if (applied) applied3DRevision = Math.max(applied3DRevision, revision);
        on3DSettled({ revision, applied, dirty: applied3DRevision < sourceRevision });
    };

    return {
        invalidate() { return ++sourceRevision; },
        flush(view) {
            if (view === 'top' || view === 'bottom') {
                return refresh2D();
            }
            const revision = sourceRevision;
            if (revision <= applied3DRevision || inFlight.has(revision)) return;
            inFlight.add(revision);
            let result;
            try {
                result = refresh3D(revision);
            } catch (error) {
                settle(revision, false);
                throw error;
            }
            if (result && typeof result.then === 'function') {
                return Promise.resolve(result).then(
                    (applied) => { settle(revision, applied !== false); return applied; },
                    (error) => { settle(revision, false); throw error; },
                );
            }
            settle(revision, result !== false);
            return result;
        },
        is3DDirty() { return applied3DRevision < sourceRevision; },
    };
}