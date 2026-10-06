#!/usr/bin/env node
// Browser tests: run the real app in headless Chromium against a local static server.
//
// Covers what the Node regression tests cannot: real pointer input, the WebGL 3D
// viewer, the rendered Properties panel, and save/reopen through autosave recovery.
// Scenarios live in browser-tests/*.mjs and export `scenarios: Array<{name, run}>`.
//
// Playwright is not vendored. Install the pinned version into the repo's git-ignored
// node_modules, as CI does (see .github/workflows/regression.yml):
//   npm install --no-save --no-package-lock --ignore-scripts playwright@1.55.0
//   npx playwright install chromium
// or point PLAYWRIGHT at a Playwright package installed elsewhere.
//
// Usage: node tools/browser-test.mjs [scenario-name-filter]   (HEADED=1 shows the browser;
// CPU_THROTTLE=4 slows the page down like a CI runner)

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './serve.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function loadPlaywright() {
    try {
        const resolved = process.env.PLAYWRIGHT
            ? createRequire(join(process.env.PLAYWRIGHT, 'package.json')).resolve(process.env.PLAYWRIGHT)
            : createRequire(join(root, 'package.json')).resolve('playwright');
        return await import(pathToFileURL(resolved).href);
    } catch {
        console.error('Playwright not found. Install it (npm install --no-save playwright) or set PLAYWRIGHT=/path/to/playwright.');
        process.exit(2);
    }
}

const playwright = await loadPlaywright();
const chromium = playwright.chromium ?? playwright.default?.chromium;
const filter = process.argv[2] || '';
const scenarioDir = new URL('../browser-tests/', import.meta.url);
const scenarios = [];
for (const file of readdirSync(scenarioDir).filter(name => name.endsWith('.mjs')).sort()) {
    const module = await import(new URL(file, scenarioDir).href);
    for (const scenario of module.scenarios || []) {
        if (!filter || scenario.name.includes(filter)) scenarios.push({ ...scenario, file });
    }
}
if (!scenarios.length) throw new Error('No matching browser scenarios.');

const { server, url } = await startServer(0);
// Software WebGL so the 3D viewer renders on GPU-less CI runners.
const browser = await chromium.launch({ headless: !process.env.HEADED, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const failed = [];
try {
    for (const scenario of scenarios) {
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await context.newPage();
        // CPU_THROTTLE=4 slows the page like a shared CI runner, to reproduce timing failures locally.
        if (process.env.CPU_THROTTLE) {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
        }
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(String(error?.stack || error)));
        // beforeunload ("unsaved changes") and app-level confirm() dialogs.
        page.on('dialog', dialog => dialog.accept());
        const started = Date.now();
        try {
            await scenario.run(page, url);
            if (pageErrors.length) throw new Error(`Uncaught page errors:\n${pageErrors.join('\n')}`);
            console.log(`PASS ${scenario.name} (${Date.now() - started} ms)`);
        } catch (error) {
            failed.push(scenario.name);
            console.error(`FAIL ${scenario.name}\n${error?.stack || error}`);
            await page.screenshot({ path: join(root, `browser-test-failure-${scenario.name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
        } finally {
            await context.close();
        }
    }
} finally {
    await browser.close();
    server.close();
}
console.log(`\n${scenarios.length - failed.length}/${scenarios.length} browser scenarios passed.`);
process.exitCode = failed.length ? 1 : 0;
