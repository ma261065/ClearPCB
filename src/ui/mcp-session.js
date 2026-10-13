import { ModalManager } from '../core/ModalManager.js';

/** @typedef {{id: string, name: string, version?: string}} PairingClient */
/** @typedef {{enabled: boolean, connected: boolean, mcpUrl: string, pairingCode?: string, pairingExpiresAt?: number, pendingClient?: PairingClient, pairedClient?: PairingClient, connectionError?: string, canRevert?: boolean}} McpSessionState */
/** @typedef {{enabled: boolean, onStateChanged: (state: McpSessionState) => void, enable: () => void, disable: () => void, approvePairing: () => boolean, denyPairing: () => boolean, disconnectClient: () => boolean, revertLastChange: () => unknown}} McpBridgeLike */
/** @typedef {{close: () => void, render: (state: McpSessionState) => void}} McpSessionUi */

/** @param {McpSessionState} state */
function statusText(state) {
    if (!state.enabled) return 'MCP Session Disabled';
    if (state.connectionError) return `MCP Session Enabled - ${state.connectionError}`;
    if (state.pairedClient) return `Connected to ${state.pairedClient.name}`;
    if (state.pendingClient) return `${state.pendingClient.name} is requesting access`;
    return state.connected
        ? 'MCP Session Enabled - Ready to pair'
        : 'MCP Session Enabled - Waiting for MCP relay';
}

/**
 * @param {McpBridgeLike} bridge
 * @returns {McpSessionUi}
 */
export function createMcpSessionUi(bridge) {
    const overlay = document.createElement('div');
    overlay.className = 'mcp-session-overlay hide';
    overlay.innerHTML = `
        <section class="mcp-session-dialog" role="dialog" aria-modal="true" aria-labelledby="mcpSessionTitle">
            <header>
                <div>
                    <h2 id="mcpSessionTitle">AI Mode</h2>
                    <div class="mcp-session-status" data-mcp-status>
                        <span class="mcp-session-status-icon" aria-hidden="true"></span>
                        <span data-mcp-status-text></span>
                    </div>
                </div>
                <button type="button" data-mcp-close aria-label="Close">×</button>
            </header>
            <p class="mcp-session-intro">Connect an MCP client (e.g. an AI like Gemini, ChatGPT or Claude) to the open project.</p>
            <div class="mcp-session-notices">
                <div class="mcp-session-notice">
                    <span class="mcp-session-notice-icon" aria-hidden="true">!</span>
                    <span><strong>Approve only clients you trust</strong>A paired client can read and edit this project.</span>
                </div>
                <div class="mcp-session-notice">
                    <span class="mcp-session-notice-icon" aria-hidden="true">↶</span>
                    <span><strong>MCP edits clear normal undo history</strong>You can revert the latest MCP change here.</span>
                </div>
            </div>
            <div class="mcp-session-url hide" data-mcp-url-row>
                <input data-mcp-url readonly aria-label="MCP server URL">
                <button type="button" data-mcp-copy aria-live="polite">Copy URL</button>
            </div>
            <div class="mcp-pairing-code hide" data-mcp-code-row>
                <span>Pairing code</span>
                <strong data-mcp-code></strong>
                <span data-mcp-code-expiry></span>
            </div>
            <div class="mcp-pairing-request hide" data-mcp-request>
                <p><strong data-mcp-client-name></strong> wants access to this project.</p>
                <div>
                    <button type="button" data-mcp-deny>Deny</button>
                    <button type="button" class="primary" data-mcp-allow>Allow</button>
                </div>
            </div>
            <div class="mcp-paired-client hide" data-mcp-paired>
                <span>Connected client: <strong data-mcp-paired-name></strong></span>
                <button type="button" data-mcp-disconnect>Disconnect</button>
            </div>
            <footer>
                <button type="button" data-mcp-revert>Revert last MCP change</button>
                <button type="button" data-mcp-toggle></button>
                <button type="button" data-mcp-close>Close</button>
            </footer>
        </section>`;
    document.body.appendChild(overlay);

    const dialog = /** @type {HTMLElement} */ (overlay.querySelector('.mcp-session-dialog'));
    const dragHandle = /** @type {HTMLElement} */ (dialog.querySelector('header'));
    const status = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-status]'));
    const statusLabel = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-status-text]'));
    const urlRow = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-url-row]'));
    const urlInput = /** @type {HTMLInputElement} */ (overlay.querySelector('[data-mcp-url]'));
    const codeRow = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-code-row]'));
    const codeValue = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-code]'));
    const codeExpiry = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-code-expiry]'));
    const requestRow = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-request]'));
    const clientName = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-client-name]'));
    const pairedRow = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-paired]'));
    const pairedName = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-paired-name]'));
    const toggle = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-mcp-toggle]'));
    const revert = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-mcp-revert]'));
    const copyButton = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-mcp-copy]'));
    let copyFeedbackTimer = 0;
    let expiryTimer = 0;
    let currentState = /** @type {McpSessionState} */ ({ enabled: false, connected: false, mcpUrl: '' });
    const updateExpiry = () => {
        const seconds = Math.max(0, Math.ceil(((currentState.pairingExpiresAt || 0) - Date.now()) / 1000));
        codeExpiry.textContent = seconds ? `Expires in ${Math.ceil(seconds / 60)} min` : 'Expired';
    };
    const resetCopyFeedback = () => {
        window.clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = 0;
        copyButton.textContent = 'Copy URL';
        delete copyButton.dataset.copyState;
    };
    /**
     * @param {string} text
     * @param {string} state
     */
    const showCopyFeedback = (text, state) => {
        resetCopyFeedback();
        copyButton.textContent = text;
        copyButton.dataset.copyState = state;
        copyFeedbackTimer = window.setTimeout(resetCopyFeedback, 1800);
    };
    /** @param {McpSessionState} state */
    const render = state => {
        currentState = state;
        statusLabel.textContent = statusText(state);
        status.dataset.enabled = String(state.enabled);
        status.dataset.connected = String(state.connected);
        status.dataset.error = String(!!state.connectionError);
        urlRow.classList.toggle('hide', !state.enabled);
        urlInput.value = state.mcpUrl;
        codeRow.classList.toggle('hide', !state.pairingCode);
        codeValue.textContent = state.pairingCode || '';
        requestRow.classList.toggle('hide', !state.pendingClient);
        clientName.textContent = state.pendingClient?.name || '';
        pairedRow.classList.toggle('hide', !state.pairedClient);
        pairedName.textContent = state.pairedClient?.name || '';
        window.clearInterval(expiryTimer);
        expiryTimer = 0;
        if (state.pairingCode) {
            updateExpiry();
            expiryTimer = window.setInterval(updateExpiry, 1000);
        }
        if (!state.enabled) resetCopyFeedback();
        toggle.textContent = state.enabled ? 'Disable MCP' : 'Enable MCP';
        toggle.classList.toggle('primary', !state.enabled);
        revert.disabled = !state.canRevert;
        document.querySelectorAll('[data-mcp-session]')
            .forEach(button => button.classList.toggle('active', state.enabled));
    };
    bridge.onStateChanged = render;
    render({ enabled: false, connected: false, mcpUrl: '' });

    const close = () => {
        overlay.classList.add('hide');
        ModalManager.pop('mcp-session');
    };
    const open = () => {
        overlay.classList.remove('hide');
        ModalManager.push('mcp-session', close);
        toggle.focus();
    };
    document.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('[data-mcp-session]')) open();
    });
    overlay.querySelectorAll('[data-mcp-close]').forEach(button => button.addEventListener('click', close));
    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });
    toggle.addEventListener('click', () => bridge.enabled ? bridge.disable() : bridge.enable());
    revert.addEventListener('click', () => void bridge.revertLastChange());
    overlay.querySelector('[data-mcp-allow]')?.addEventListener('click', () => bridge.approvePairing());
    overlay.querySelector('[data-mcp-deny]')?.addEventListener('click', () => bridge.denyPairing());
    overlay.querySelector('[data-mcp-disconnect]')?.addEventListener('click', () => bridge.disconnectClient());
    let dialogX = 0;
    let dialogY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let startDialogX = 0;
    let startDialogY = 0;
    dragHandle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.target instanceof Element && event.target.closest('button')) return;
        const rect = dialog.getBoundingClientRect();
        dragStartX = event.clientX;
        dragStartY = event.clientY;
        startDialogX = dialogX;
        startDialogY = dialogY;
        dragHandle.dataset.dragging = 'true';
        dragHandle.setPointerCapture(event.pointerId);
        /** @param {PointerEvent} moveEvent */
        const move = moveEvent => {
            const requestedX = startDialogX + moveEvent.clientX - dragStartX;
            const requestedY = startDialogY + moveEvent.clientY - dragStartY;
            dialogX = Math.min(requestedX, startDialogX + window.innerWidth - rect.right);
            dialogX = Math.max(dialogX, startDialogX - rect.left);
            dialogY = Math.min(requestedY, startDialogY + window.innerHeight - rect.bottom);
            dialogY = Math.max(dialogY, startDialogY - rect.top);
            dialog.style.transform = `translate(${dialogX}px, ${dialogY}px)`;
        };
        /** @param {PointerEvent} finishEvent */
        const finish = finishEvent => {
            dragHandle.releasePointerCapture(finishEvent.pointerId);
            delete dragHandle.dataset.dragging;
            dragHandle.removeEventListener('pointermove', move);
            dragHandle.removeEventListener('pointerup', finish);
            dragHandle.removeEventListener('pointercancel', finish);
        };
        dragHandle.addEventListener('pointermove', move);
        dragHandle.addEventListener('pointerup', finish);
        dragHandle.addEventListener('pointercancel', finish);
    });
    copyButton.addEventListener('click', async () => {
        let clipboardError = null;
        try {
            await navigator.clipboard.writeText(urlInput.value);
            showCopyFeedback('Copied!', 'success');
            return;
        } catch (error) {
            clipboardError = error;
        }

        try {
            urlInput.select();
            if (document.execCommand('copy')) {
                showCopyFeedback('Copied!', 'success');
                return;
            }
        } catch (fallbackError) {
            console.error('Unable to copy the MCP session URL.', clipboardError, fallbackError);
            showCopyFeedback('Copy failed', 'error');
            return;
        }

        console.error('Unable to copy the MCP session URL.', clipboardError);
        showCopyFeedback('Copy failed', 'error');
    });
    return { close, render };
}
