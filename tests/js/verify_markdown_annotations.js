#!/usr/bin/env node
// Verification 3 (stored annotations): for every annotation in every campaign,
// report whether it has a visible part under the `markdown` renderer, and list
// annotations whose highlighted text differs from the stored text by more than
// hidden syntax. Differences that the plain view already has (annotations not
// aligned to atoms) are counted separately.
//
// With --citations, the citation pass runs on top (superscript | hidden | raw).
//
// Usage: node tests/js/verify_markdown_annotations.js <factgenie-dir> [--list N] [--citations DISPLAY]
const path = require('path');
const env = require('./lib/env');
const { createMarkdownWindow, renderDocument } = require('./lib/markdown');

const factgenieDir = path.resolve(process.argv[2] || path.join(env.REPO_ROOT, 'factgenie'));
const listIndex = process.argv.indexOf('--list');
const listLimit = listIndex > 0 ? Number(process.argv[listIndex + 1]) : 30;
const citationsIndex = process.argv.indexOf('--citations');
const citations = citationsIndex > 0 ? process.argv[citationsIndex + 1] : null;

const window = createMarkdownWindow();
const normalizeNewlines = env.loadNormalizeNewlines();
const records = env.loadCampaignRecords(factgenieDir, normalizeNewlines);

// Raw atoms of the plain view (start-in-range highlighting rule).
function plainAtoms(text, granularity) {
    const chars = Array.from(text);
    if (granularity !== 'words') {
        return chars.map((_, i) => ({ start: i, end: i + 1 }));
    }
    const atoms = [];
    let index = 0;
    text.split(/(\s+)/).forEach((part, i) => {
        const length = Array.from(part).length;
        if (i % 2 === 0) {
            atoms.push({ start: index, end: index + length });
        }
        index += length;
    });
    return atoms;
}

// Visible non-whitespace raw positions that are highlighted but outside the
// annotation, or inside the annotation but not highlighted.
function difference(highlightedAtoms, visibleUnits, start, end) {
    const highlighted = new Set();
    highlightedAtoms.forEach(atom => {
        for (let i = atom.start; i < atom.end; i++) highlighted.add(i);
    });
    const extra = [];
    const missing = [];
    visibleUnits.forEach(unit => {
        if (/^\s+$/.test(unit.display)) {
            return;
        }
        const inAnnotation = unit.start < end && unit.end > start;
        const isHighlighted = highlighted.has(unit.start);
        if (isHighlighted && !inAnnotation) extra.push(unit.display);
        if (!isHighlighted && inAnnotation) missing.push(unit.display);
    });
    return { extra: extra.join(''), missing: missing.join('') };
}

const cache = new Map();
const stats = { annotations: 0, textMismatch: 0, noVisiblePart: 0, plainDiff: 0, markdownOnlyDiff: 0, bothDiff: 0 };
const noVisible = [];
const textMismatches = new Map();
const markdownOnly = [];

for (const record of records) {
    const key = `${record.granularity}\u0000${record.text}`;
    if (!cache.has(key)) {
        const rendered = renderDocument(window, record.text, record.granularity, 'markdown', null, [], citations);
        cache.set(key, {
            chars: Array.from(record.text),
            mdAtoms: rendered.atoms,
            mdUnits: rendered.units,
            plainAtoms: plainAtoms(record.text, record.granularity),
        });
    }
    const doc = cache.get(key);
    const plainUnits = doc.chars.map((char, i) => ({ start: i, end: i + 1, display: char }));

    record.annotations.forEach((ann, annIndex) => {
        stats.annotations++;
        const start = Number(ann.start);
        const annText = String(ann.text ?? '');
        const end = start + Array.from(annText).length;
        if (doc.chars.slice(start, end).join('') !== annText) {
            stats.textMismatch++;
            textMismatches.set(record.campaignId, (textMismatches.get(record.campaignId) || 0) + 1);
        }
        const label = `${record.source} #${annIndex} start=${start} ${JSON.stringify(annText.slice(0, 80))}`;

        const visible = doc.mdUnits.filter(unit => unit.start < end && unit.end > start);
        if (visible.length === 0) {
            stats.noVisiblePart++;
            noVisible.push(label);
        }

        const mdHighlighted = doc.mdAtoms.filter(atom => atom.start < end && atom.end > start);
        const plainHighlighted = doc.plainAtoms.filter(atom => atom.start >= start && atom.start < end);
        const md = difference(mdHighlighted, doc.mdUnits, start, end);
        const plain = difference(plainHighlighted, plainUnits, start, end);
        const mdDiff = md.extra || md.missing;
        const plainDiff = plain.extra || plain.missing;
        if (plainDiff) stats.plainDiff++;
        if (mdDiff && plainDiff) stats.bothDiff++;
        if (mdDiff && !plainDiff) {
            stats.markdownOnlyDiff++;
            markdownOnly.push(`${label} extra=${JSON.stringify(md.extra.slice(0, 60))} missing=${JSON.stringify(md.missing.slice(0, 60))}`);
        }
    });
}

console.log(`data:                          ${factgenieDir}`);
console.log(`citation display:              ${citations || 'off'}`);
console.log(`campaign records:              ${records.length}`);
console.log(`annotations:                   ${stats.annotations}`);
console.log(`stored text != raw slice:      ${stats.textMismatch} (pre-existing data issue, not caused by rendering)`);
textMismatches.forEach((count, campaignId) => console.log(`  ${campaignId}: ${count}`));
console.log(`no visible part (marker):      ${stats.noVisiblePart}`);
noVisible.slice(0, listLimit).forEach(line => console.log(`  ${line}`));
console.log(`plain view differs already:    ${stats.plainDiff} (of which markdown also differs: ${stats.bothDiff})`);
console.log(`differs only under markdown:   ${stats.markdownOnlyDiff}`);
markdownOnly.slice(0, listLimit).forEach(line => console.log(`  ${line}`));
