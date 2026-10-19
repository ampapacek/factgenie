const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
class Node {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.textContent = text; this.events = {}; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    replaceChildren() { this.children = []; }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    setAttribute() {}
    addEventListener(type, handler) { this.events[type] = handler; }
    scrollIntoView() {}
    querySelectorAll(selector) {
        const all = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
        return all.filter(child => child.tag === 'input' && (selector !== 'input:checked' || child.checked));
    }
    get style() { return this._style ||= {}; }
}
const definitions = [{label: 'List', placeholder: '', max_items: 2, empty_confirmation: true,
    empty_label: 'Nothing', required: true, choice_groups: [
        {label: 'Single', multiple: false, required: false, default_values: ['Unknown'], options: [{label: 'Yes'}, {label: 'Unknown'}]},
        {label: 'Multi', multiple: true, required: true, default_values: ['A', 'B'], options: [{label: 'A'}, {label: 'B'}]}]}];
const root = new Node('div'); root.dataset = {config: JSON.stringify(definitions)};
const doc = {getElementById: () => root, createElement: tag => new Node(tag), createTextNode: text => new Node('text', text), activeElement: null};
const context = {document: doc, crypto: {randomUUID}, structuredClone, setTimeout: callback => callback(), window: {}};
vm.createContext(context);
vm.runInContext(fs.readFileSync('factgenie/static/js/text-lists.js', 'utf8') + '\nglobalThis.ui = textListsUI;', context);
const ui = context.ui;
const descendants = (node, tag) => node.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...descendants(child, tag)]);
const rows = () => descendants(root, 'textarea');
const type = (node, value) => { doc.activeElement = node; node.value = value; node.events.input(); };
ui.load([]);
assert.equal(rows().length, 1);
assert.equal(ui.validate(), false);
const first = rows()[0]; type(first, ' item ');
const firstId = ui.collect()[0].items[0].id;
assert.equal(rows().length, 2);
assert.equal(ui.collect()[0].items[0].text, 'item');
assert.deepEqual(Array.from(ui.collect()[0].items[0].choices[1].values), ['A', 'B']);
assert.equal(ui.validate(), true);
const second = rows()[1]; type(second, 'second');
assert.equal(rows().length, 2); // finite maximum removes placeholder row
assert.equal(ui.collect()[0].items[0].id, firstId);
type(first, '  ');
assert.equal(ui.collect()[0].items.length, 1);
assert.ok(rows().includes(first)); // focused blank is retained
assert.equal(descendants(first.parent, 'fieldset').length, 0);
type(first, 'again');
assert.notEqual(ui.collect()[0].items[0].id, firstId);
assert.deepEqual(Array.from(ui.collect()[0].items[0].choices[0].values), ['Unknown']);
const checkpoint = ui.collect(); ui.load(checkpoint);
assert.equal(ui.collect()[0].items[0].id, checkpoint[0].items[0].id);
let blank = rows()[0]; type(blank, ''); doc.activeElement = rows()[1]; blank.events.blur();
assert.equal(rows().length, 2); // one filled row + exactly one trailing blank
assert.equal(rows()[1].value, '');
const deletion = descendants(rows()[0].parent, 'button').find(node => node.textContent === 'Delete');
deletion.events.click();
assert.equal(ui.collect()[0].items.length, 0);
const confirmation = descendants(root, 'input')[0];
assert.equal(confirmation.disabled, false);
confirmation.checked = true; confirmation.events.change();
assert.equal(ui.validate(), true);
assert.equal(rows().length, 1);
type(rows()[0], 'new item');
assert.equal(confirmation.checked, false);
assert.equal(confirmation.disabled, true);
console.log('Text-list DOM behavior checks passed: rows, defaults, IDs, clearing, blur, limits, delete and empty confirmation.');
// Exercise annotation-content detection and browser recovery using the production functions.
const annotate = fs.readFileSync('factgenie/static/js/annotate.js', 'utf8');
vm.runInContext(annotate.slice(annotate.indexOf('function hasStoredAnnotationContent('),
    annotate.indexOf('function preparePerExampleFinishSubmission(')), context);
assert.equal(context.hasStoredAnnotationContent(null), false);
assert.equal(context.hasStoredAnnotationContent({text_lists: [{items: [{text: 'text'}]}]}), true);
assert.equal(context.hasStoredAnnotationContent({text_lists: [{items: [], empty_confirmed: true}]}), true);
assert.equal(context.hasStoredAnnotationContent({text_lists: [{items: [{text: ' '}]}]}), false);
const key = {dataset: 'demo', split: 'test', setup_id: 'model', example_idx: 0, batch_idx: 0, annotator_group: 0};
const savedLists = [{label: 'List', items: [{id: 'recover', text: 'backup', choices: []}]}];
context.metadata = {id: 'campaign'}; context.annotator_id = 'human';
context.annotation_set = [{...key}, {...key, example_idx: 1, per_example_saved: true}];
let backup = {campaign_id: 'campaign', annotator_id: 'human', annotation_set: [
    {...key, text_lists: savedLists}, {...key, example_idx: 1, text_lists: savedLists}]};
context.localStorage = {getItem: () => JSON.stringify(backup)};
vm.runInContext(annotate.slice(annotate.indexOf('function restoreTextListsFromLocalStorage('),
    annotate.indexOf('function loadAnnotations(')), context);
context.restoreTextListsFromLocalStorage();
assert.equal(context.annotation_set[0].text_lists[0].items[0].id, 'recover');
assert.equal(context.annotation_set[1].text_lists, undefined);
context.annotation_set = [{...key}]; backup.annotator_id = 'someone else';
context.restoreTextListsFromLocalStorage(); assert.equal(context.annotation_set[0].text_lists, undefined);
backup.annotator_id = 'human'; backup.campaign_id = 'other campaign';
context.restoreTextListsFromLocalStorage(); assert.equal(context.annotation_set[0].text_lists, undefined);
// Hidden YAML fields must survive form reconstruction and clear on configuration switches.
const campaigns = fs.readFileSync('factgenie/static/js/campaigns.js', 'utf8');
const values = {'#crowdsourcingConfig': 'with-lists'};
context.$ = selector => ({val: (...args) => args.length ? (values[selector] = args[0]) : values[selector],
    prop: () => {}, is: () => false, empty: () => {}});
context.window = {mode: 'crowdsourcing', configs: {
    'with-lists': {annotation_span_categories: [], text_lists: definitions},
    'without-lists': {annotation_span_categories: []}}};
context.annotatorInstructionsMDE = context.finalMessageMDE = {value: () => ''};
context.getAnnotationSpanCategories = context.getKeys = context.getOptions = context.getSliders = () => [];
vm.runInContext('let configuredTextLists = [];\n' + campaigns.slice(campaigns.indexOf('function gatherConfig('),
    campaigns.indexOf('function buildExtraFieldsPromptTemplate(')) +
    campaigns.slice(campaigns.indexOf('function updateCrowdsourcingConfig('),
    campaigns.indexOf('function importCrowdsourcingConfigToLLM(')), context);
context.updateCrowdsourcingConfig();
assert.equal(context.gatherConfig().text_lists[0].label, 'List');
values['#crowdsourcingConfig'] = 'without-lists'; context.updateCrowdsourcingConfig();
assert.equal(context.gatherConfig().text_lists.length, 0);
values['#crowdsourcingConfig'] = 'with-lists'; context.updateCrowdsourcingConfig();
values['#crowdsourcingConfig'] = '[None]'; context.updateCrowdsourcingConfig();
assert.equal(context.gatherConfig().text_lists.length, 0);
console.log('Annotation recovery, list-only content and campaign-form preservation checks passed.');
