import assert from 'node:assert/strict';
import { openSchematic, viewCentre } from './helpers/editor-helpers.mjs';

export const scenarios = [{
    name: 'schematic-print-pdf-clone-preserves-symbol-visibility',
    async run(page, url) {
        await openSchematic(page, url);
        const result = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Component } = await import('/src/components/Component.js');
            const { BuiltInComponents } = await import('/src/components/BuiltInComponents.js');
            const { Text } = await import('/src/shapes/text.js');
            const { componentViewOf } = await import('/src/schematic/render/shape-view-state.js');
            const { mountComponent } = await import('/src/schematic/modules/schematic-view.js');
            const { cloneViewportSvgForExport } = await import('/src/shared/ui/export.js');
            const definition = BuiltInComponents.find(item => item.symbol?.graphics?.length);
            const component = new Component(definition, { x: centre.x, y: centre.y });
            app.components.push(component);
            mountComponent(app, component);
            app.updateSelectableItems();
            app.addShape(new Text({ x: centre.x + 20, y: centre.y, text: 'Unbordered text' }));
            app.renderShapes(true);
            const live = componentViewOf(component).element;
            const hiddenPin = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            hiddenPin.setAttribute('class', 'export-hidden-probe');
            hiddenPin.setAttribute('r', '1');
            hiddenPin.style.display = 'none';
            live.appendChild(hiddenPin);
            live.classList.add('lod-far', 'culled');
            const { svgNode } = cloneViewportSvgForExport(app);
            const exported = svgNode.querySelector(`[data-id="${component.id}"]`);
            const hidden = exported.querySelector('.export-hidden-probe');
            const textGroup = [...svgNode.querySelectorAll('g')].find(group =>
                [...group.children].some(child => child.tagName.toLowerCase() === 'text'
                    && child.textContent === 'Unbordered text'));
            const repaint = textGroup.querySelector('rect');
            return {
                placeholderCount: svgNode.querySelectorAll('.cpcb-lod-rect').length,
                hiddenDisplay: hidden.getAttribute('display'),
                exportedCulled: exported.classList.contains('culled'),
                exportedLod: exported.classList.contains('lod-far'),
                liveCulled: live.classList.contains('culled'),
                liveLod: live.classList.contains('lod-far'),
                repaintFill: repaint.getAttribute('fill'),
                outlineVisible: [...exported.querySelectorAll('path, rect, polyline, circle')]
                    .some(element => element !== hidden && element.getAttribute('display') !== 'none'
                        && element.getAttribute('stroke') === '#000000'),
            };
        }, await viewCentre(page));
        assert.equal(result.placeholderCount, 0, 'print/PDF never includes viewport LOD blocks');
        assert.equal(result.hiddenDisplay, 'none', 'hidden markers remain hidden after serialization');
        assert.equal(result.exportedCulled, false);
        assert.equal(result.exportedLod, false);
        assert.equal(result.liveCulled, true, 'export restores live viewport classes');
        assert.equal(result.liveLod, true);
        assert.ok(['transparent', 'rgba(0, 0, 0, 0)'].includes(result.repaintFill),
            'invisible text repaint bounds must not become black rectangles');
        assert.equal(result.outlineVisible, true, 'actual component outlines remain available at full detail');
    },
}, {
    name: 'schematic-print-pdf-keeps-crossing-gaps-and-ohm',
    async run(page, url) {
        await openSchematic(page, url);
        const result = await page.evaluate(async centre => {
            const app = window.bootstrap.schematicApp;
            const { Wire } = await import('/src/shapes/wire.js');
            const { Text } = await import('/src/shapes/text.js');
            const { cloneViewportSvgForExport, loadVectorPdfLibs, useSymbolFontForGreek } =
                await import('/src/shared/ui/export.js');
            const { EXPORT_CROSSING_GAP } = await import('/src/schematic/modules/wire-crossings.js');
            app.shapes.push(
                new Wire({ id: 'export-under', points: [{ x: centre.x, y: centre.y - 10 }, { x: centre.x, y: centre.y + 10 }] }),
                new Wire({ id: 'export-over', points: [{ x: centre.x - 10, y: centre.y }, { x: centre.x + 10, y: centre.y }] }));
            app.addShape(new Text({ x: centre.x + 20, y: centre.y, text: 'R1 10k\u03A9 \u00B5F' }));
            app.updateSelectableItems();
            app.renderShapes(true);
            const { svgNode } = cloneViewportSvgForExport(app);
            const borders = [...svgNode.querySelectorAll('.wire-crossing-cues > .wire-crossing-border')];
            useSymbolFontForGreek(svgNode);
            const text = [...svgNode.querySelectorAll('text')].find(node => node.textContent.startsWith('R1 10k'));
            const symbol = text.querySelector('tspan[font-family="symbol"]');
            const jsPDF = await loadVectorPdfLibs(app);
            const pdf = new jsPDF({ unit: 'mm', format: [297, 210], compress: false });
            const svg2pdf = window.svg2pdf.svg2pdf || window.svg2pdf.default || window.svg2pdf;
            await svg2pdf(svgNode, pdf, { x: 0, y: 0, width: 297, height: 210 });
            const output = pdf.output();
            return {
                gap: EXPORT_CROSSING_GAP,
                borders: borders.map(line => ({ stroke: line.getAttribute('stroke'), width: Number(line.getAttribute('stroke-width')) })),
                liveStroke: document.querySelector('.wire-crossing-cues > .wire-crossing-border').getAttribute('stroke'),
                text: text.textContent,
                symbol: symbol && { text: symbol.textContent, weight: symbol.getAttribute('font-weight') },
                pdfHasCopyright: output.includes('\\251') || output.includes('\u00A9'),
            };
        }, await viewCentre(page));
        assert.equal(result.borders.length, 2, 'the crossing keeps both side gaps in the export');
        assert.ok(result.borders.every(border => border.stroke === '#ffffff' && border.width === result.gap),
            `print/PDF gaps are paper white and ${result.gap} mm wide, not monochrome black hairlines`);
        assert.equal(result.liveStroke, 'var(--sch-background, #1e1e1e)', 'the live canvas cue is unchanged');
        assert.equal(result.text, 'R1 10kW \u00B5F', 'only the Omega is re-encoded; WinAnsi \u00B5 stays in Helvetica');
        assert.deepEqual(result.symbol, { text: 'W', weight: 'normal' });
        assert.equal(result.pdfHasCopyright, false, 'Omega no longer collapses to the WinAnsi copyright byte');
    },
}];
