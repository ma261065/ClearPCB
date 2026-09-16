import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';

const project = () => ({ type: 'clearpcb-project', version: '2.0', schematic: { shapes: [], components: [] } });
const owner = new ProjectDocument();
let current = project();
const view = {
    serializeSection: () => structuredClone(current),
    prepareSection: () => ({}),
    loadSection(data) { current = structuredClone(data); },
};
owner.registerView('schematic', view);
await owner.load(project());
assert.equal(owner.fileManager.loading, false);
assert.equal(owner.fileManager.isDirty, false);
owner.fileManager.setDirty(true);
assert.equal(owner.fileManager.isDirty, true);
const loadedRevision = owner.fileManager.revision;
view.onDocumentChanged();
view.onDocumentChanged();
assert.equal(owner.fileManager.revision, loadedRevision + 2);
owner.fileManager.setDirty(false);
assert.equal(owner.fileManager.revision, loadedRevision + 2);
assert.equal(owner.isDirty, false);
view.prepareSection = () => { throw new Error('Invalid recovered project'); };
await assert.rejects(owner.load(project()), /Invalid recovered project/);
assert.equal(owner.fileManager.loading, false);
assert.equal(owner.isDirty, false);
assert.deepEqual(current, project());
console.log('PASS document recovery, change notifications, revisions and failed-load cleanup');