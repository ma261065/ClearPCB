export function showSaveToast(app, text = 'Saved') {
    const anchor = app.status.docTitle || document.getElementById('pcbDocTitle');
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const existing = document.getElementById('ribbon-save-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'ribbon-save-toast';
    toast.className = 'ribbon-save-toast';
    toast.textContent = text;
    toast.style.left = `${rect.left + rect.width / 2}px`;
    toast.style.top = `${rect.top - 28}px`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    window.setTimeout(() => {
        toast.classList.remove('show');
        window.setTimeout(() => toast.remove(), 200);
    }, 900);
}
