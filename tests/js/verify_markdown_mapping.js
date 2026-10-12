#!/usr/bin/env node
// Verification 2 (mapping checks): render every stored output with the
// `markdown` renderer in both granularities and run the runtime checks 1-3.
// Also reports text nodes the renderer could not align character by character.
// With --citations, the citation pass runs on top (superscript | hidden | raw).
//
// Usage: node tests/js/verify_markdown_mapping.js <factgenie-dir> [--words-only] [--citations DISPLAY]
const path = require('path');
const env = require('./lib/env');
const { createMarkdownWindow, renderDocument, distinctTexts } = require('./lib/markdown');

const factgenieDir = path.resolve(process.argv[2] || path.join(env.REPO_ROOT, 'factgenie'));
const granularities = process.argv.includes('--words-only') ? ['words'] : ['words', 'chars'];
const citationsIndex = process.argv.indexOf('--citations');
const citations = citationsIndex > 0 ? process.argv[citationsIndex + 1] : null;

const window = createMarkdownWindow();
const normalizeNewlines = env.loadNormalizeNewlines();
const outputs = env.loadOutputs(factgenieDir, normalizeNewlines);
const records = env.loadCampaignRecords(factgenieDir, normalizeNewlines);
const texts = distinctTexts(outputs, records);

const failures = [];
const alignWarnings = [];
let documents = 0;
let hiddenChars = 0;
let totalChars = 0;
let citationUnits = 0;

for (const [text, source] of texts) {
    for (const granularity of granularities) {
        documents++;
        let result;
        try {
            result = renderDocument(window, text, granularity, 'markdown', null, [], citations);
        } catch (err) {
            failures.push({ source, granularity, problems: [{ message: `exception: ${err.message}` }] });
            continue;
        }
        if (!result.check.ok) {
            failures.push({ source, granularity, problems: result.check.problems.slice(0, 5), problemCount: result.check.problems.length });
        }
        if (granularity === 'words') {
            const chars = Array.from(text).length;
            const visible = result.units.reduce((sum, unit) => sum + unit.end - unit.start, 0);
            totalChars += chars;
            hiddenChars += chars - visible;
            citationUnits += result.units.filter(unit => unit.kind === 'citation').length;
            result.warnings.forEach(warning => alignWarnings.push({ source, warning: warning.slice(0, 300) }));
        }
    }
}

console.log(`data:                ${factgenieDir}`);
console.log(`stored outputs:      ${outputs.length}`);
console.log(`campaign records:    ${records.length}`);
console.log(`distinct texts:      ${texts.size} (x${granularities.length} granularities)`);
console.log(`citation display:    ${citations || 'off'} (${citationUnits} superscripts)`);
console.log(`documents checked:   ${documents}`);
console.log(`hidden characters:   ${hiddenChars} of ${totalChars} (${(100 * hiddenChars / Math.max(totalChars, 1)).toFixed(1)}%)`);
console.log(`alignment fallbacks: ${alignWarnings.length}`);
alignWarnings.slice(0, 20).forEach(w => console.log(`  ${w.source}: ${w.warning}`));
console.log(`check failures:      ${failures.length}`);
failures.slice(0, 20).forEach(f => console.log(`  ${JSON.stringify(f)}`));
process.exit(failures.length === 0 ? 0 : 1);
