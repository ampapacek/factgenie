#!/usr/bin/env node
// Verification 1 (plain equivalence): the refactored annotator with the
// `plain` renderer must build exactly the DOM of the pre-refactor annotator
// for every stored output, in both granularities, with and without the stored
// campaign annotations applied.
//
// Usage: node tests/js/verify_plain_equivalence.js <factgenie-dir> [base-ref]
//   <factgenie-dir>  directory with data/outputs and campaigns
//                    (e.g. ../factgenie-personal-fork/factgenie)
//   [base-ref]       git ref of the pre-refactor span-annotator.js (default personal/main)
const path = require('path');
const env = require('./lib/env');

const factgenieDir = path.resolve(process.argv[2] || path.join(env.REPO_ROOT, 'factgenie'));
const baseRef = process.argv[3] || 'personal/main';

const oldWindow = env.createWindow([env.readStaticAtRef(baseRef, 'span-annotator.js')]);
const newWindow = env.createWindow([env.readStatic('span-renderers.js'), env.readStatic('span-annotator.js')]);
const normalizeNewlines = env.loadNormalizeNewlines();

// Returns the serialized DOM and the (data-index, data-content, data-whitespace) sequence.
function render(window, text, granularity, annotations = null, categories = []) {
    const annotator = new window.SpanAnnotator();
    annotator.init(granularity, true, categories, false);
    const par = window.document.createElement('p');
    annotator.addDocument('doc', par, false, text);
    if (annotations) {
        annotator.addAnnotations('doc', annotations);
    }
    const triples = Array.from(par.querySelectorAll('.annotatable'))
        .map(span => [span.dataset.index, span.dataset.content, span.dataset.whitespace ?? null]);
    return { dom: env.serializeNode(par), triples: JSON.stringify(triples) };
}

function firstDifference(a, b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return { at: i, old: a.slice(Math.max(0, i - 80), i + 80), new: b.slice(Math.max(0, i - 80), i + 80) };
}

const outputs = env.loadOutputs(factgenieDir, normalizeNewlines);
const records = env.loadCampaignRecords(factgenieDir, normalizeNewlines);
// Edge cases not necessarily present in the data.
const synthetic = ['', ' ', '\n', ' a', 'a ', '  a  b  ', 'a\n\nb', '\tx\r', '😀 a👍🏽b', 'é x'];

let checked = 0;
const failures = [];

function compare(label, oldHtml, newHtml) {
    checked++;
    if (oldHtml !== newHtml) {
        failures.push({ label, ...firstDifference(oldHtml, newHtml) });
    }
}

// Identical texts (campaign records repeat stored outputs) are checked once.
const texts = new Map();
[
    ...outputs.map(o => ({ source: o.source, text: o.text })),
    ...records.map(r => ({ source: r.source, text: r.text })),
    ...synthetic.map((text, i) => ({ source: `synthetic#${i}`, text })),
].forEach(({ source, text }) => {
    if (!texts.has(text)) {
        texts.set(text, source);
    }
});

for (const [text, source] of texts) {
    for (const granularity of ['words', 'chars']) {
        const before = render(oldWindow, text, granularity);
        const after = render(newWindow, text, granularity);
        compare(`${source} [${granularity}] triples`, before.triples, after.triples);
        compare(`${source} [${granularity}] dom`, before.dom, after.dom);
    }
}

let annotationCount = 0;
for (const record of records) {
    annotationCount += record.annotations.length;
    compare(
        `${record.source} [${record.granularity}] with ${record.annotations.length} annotations`,
        render(oldWindow, record.text, record.granularity, record.annotations, record.categories).dom,
        render(newWindow, record.text, record.granularity, record.annotations, record.categories).dom
    );
}

console.log(`base ref:            ${baseRef}`);
console.log(`data:                ${factgenieDir}`);
console.log(`stored outputs:      ${outputs.length}`);
console.log(`campaign records:    ${records.length} (${annotationCount} annotations)`);
console.log(`synthetic texts:     ${synthetic.length}`);
console.log(`distinct texts:      ${texts.size} (x2 granularities)`);
console.log(`comparisons:         ${checked}`);
console.log(`differences:         ${failures.length}`);
failures.slice(0, 20).forEach(f => console.log(JSON.stringify(f)));
process.exit(failures.length === 0 ? 0 : 1);
