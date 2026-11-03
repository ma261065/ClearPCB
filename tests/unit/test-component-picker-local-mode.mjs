import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { ComponentLibrary } = await import('../../src/components/ComponentLibrary.js');
const { populateComponents } = await import('../../src/components/picker/results-list.js');

const library = new ComponentLibrary();
library.addDefinition({
    name: 'Online EasyEDA Only',
    category: 'Online EasyEDA Category',
    description: 'Fetched online',
    symbol: { pins: [], graphics: [] },
}, 'LCSC');
library.addDefinition({
    name: 'Online KiCad Only',
    category: 'Online KiCad Category',
    description: 'Fetched online',
    symbol: { pins: [], graphics: [] },
}, 'KiCad');

assert.ok(!library.getLocalDefinitions().some(definition => definition.name === 'Online EasyEDA Only'),
    'cached EasyEDA definitions are excluded from Local browsing');
assert.ok(!library.getLocalDefinitions().some(definition => definition.name === 'Online KiCad Only'),
    'cached KiCad definitions are excluded from Local browsing');
assert.ok(!library.searchLocal('Online').length, 'Local search excludes cached online definitions');
assert.ok(!library.getLocalCategoryNames().includes('Online EasyEDA Category')
    && !library.getLocalCategoryNames().includes('Online KiCad Category'),
'Local categories exclude online-only headings');

const body = document.createElement('div');
const header = document.createElement('div');
header.className = 'cp-results-header-row';
const listEl = document.createElement('div');
body.append(header, listEl);
const picker = {
    body,
    listEl,
    library,
    searchQuery: '',
    selectedCategory: 'All',
    componentItems: new Map(),
    lazyLoader: null,
    _scrollHandler: null,
};
populateComponents(picker);
assert.equal(body.querySelector('.cp-results-header-row'), null,
    'switching to Local removes the EasyEDA and KiCad header row');
assert.ok([...picker.componentItems.values()].every(definition =>
    definition._source !== 'LCSC' && definition._source !== 'KiCad' && definition._source !== 'EasyEDA'),
'Local result rows contain no cached online definitions');
picker.lazyLoader?.destroy();

console.log('PASS component picker Local mode: online headers, categories and cached results are excluded');
