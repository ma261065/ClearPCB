export function createBoardViewSync({ refresh3D, refresh2D }) {
    let dirty3D = false;
    return {
        invalidate() { dirty3D = true; },
        flush(view) {
            if (view === 'top' || view === 'bottom') {
                refresh2D();
            } else if (dirty3D) {
                dirty3D = false;
                try {
                    refresh3D();
                } catch (error) {
                    dirty3D = true;
                    throw error;
                }
            }
        },
    };
}