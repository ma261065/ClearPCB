import { ModalManager } from '../core/ModalManager.js';

function statusText(state) {
    if (!state.enabled) return 'MCP Session Disabled';
    if (state.connectionError) return `MCP Session Enabled - ${state.connectionError}`;
    return state.connected
        ? 'MCP Session Enabled - Connected to MCP relay'
        : 'MCP Session Enabled - Waiting for MCP relay';
}

export function createMcpSessionUi(bridge) {
    const buttons = [...document.querySelectorAll('[data-mcp-session]')];
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
                    <span><strong>Session URL grants edit access</strong>Only share it with a client you trust.</span>
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
            <footer>
                <button type="button" data-mcp-revert>Revert last MCP change</button>
                <button type="button" data-mcp-toggle></button>
                <button type="button" data-mcp-close>Close</button>
            </footer>
        </section>`;
    document.body.appendChild(overlay);

    const status = /** @type {HTMLElement} */ (overlay.querySelector('[data-mcp-status]'));
    const statusLabel = overlay.querySelector('[data-mcp-status-text]');
    const urlRow = overlay.querySelector('[data-mcp-url-row]');
    const urlInput = /** @type {HTMLInputElement} */ (overlay.querySelector('[data-mcp-url]'));
    const toggle = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-mcp-toggle]'));
    const revert = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-mcp-revert]'));
    const copyButton = /** @type {HTMLButtonElement} */ (overlay.querySelector('[data-mcp-copy]'));
    let copyFeedbackTimer = 0;
    const resetCopyFeedback = () => {
        window.clearTimeout(copyFeedbackTimer);
        copyFeedbackTimer = 0;
        copyButton.textContent = 'Copy URL';
        delete copyButton.dataset.copyState;
    };
    const showCopyFeedback = (text, state) => {
        resetCopyFeedback();
        copyButton.textContent = text;
        copyButton.dataset.copyState = state;
        copyFeedbackTimer = window.setTimeout(resetCopyFeedback, 1800);
    };
    const render = state => {
        statusLabel.textContent = statusText(state);
        status.dataset.enabled = String(state.enabled);
        status.dataset.connected = String(state.connected);
        status.dataset.error = String(!!state.connectionError);
        urlRow.classList.toggle('hide', !state.enabled);
        urlInput.value = state.mcpUrl;
        if (!state.enabled) resetCopyFeedback();
        toggle.textContent = state.enabled ? 'Disable MCP' : 'Enable MCP';
        toggle.classList.toggle('primary', !state.enabled);
        revert.disabled = !state.canRevert;
        buttons.forEach(button => button.classList.toggle('active', state.enabled));
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
    buttons.forEach(button => button.addEventListener('click', open));
    overlay.querySelectorAll('[data-mcp-close]').forEach(button => button.addEventListener('click', close));
    overlay.addEventListener('click', event => {
        if (event.target === overlay) close();
    });
    toggle.addEventListener('click', () => bridge.enabled ? bridge.disable() : bridge.enable());
    revert.addEventListener('click', () => void bridge.revertLastChange());
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
