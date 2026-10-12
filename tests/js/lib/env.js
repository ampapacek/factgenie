// Shared helpers for the Node checks: a jsdom window with jQuery and the
// FactGenie span scripts, plus loaders for stored outputs and campaigns.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const STATIC_JS = path.join(REPO_ROOT, 'factgenie', 'static', 'js');

function readStatic(relPath) {
    return fs.readFileSync(path.join(STATIC_JS, relPath), 'utf8');
}

// Source of a static file at a git ref (e.g. the pre-refactor annotator).
function readStaticAtRef(ref, relPath) {
    return execFileSync('git', ['-C', REPO_ROOT, 'show', `${ref}:factgenie/static/js/${relPath}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
}

// A window with jQuery and the given script sources evaluated as one script,
// like consecutive <script> tags sharing top-level declarations. The listed
// globals are exposed as window properties.
function createWindow(sources, { quiet = true, expose = ['SpanAnnotator'] } = {}) {
    const virtualConsole = new VirtualConsole();
    if (!quiet) {
        virtualConsole.sendTo(console);
    }
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        runScripts: 'outside-only',
        virtualConsole,
    });
    const { window } = dom;
    window.eval(readStatic('lib/jquery.min.js'));
    const exposeCode = expose.map(name => `window.${name} = ${name};`).join('\n');
    window.eval(`${sources.join('\n;\n')}\n;${exposeCode}`);
    return window;
}

// normalizeNewlines() exactly as browse.js defines it.
function loadNormalizeNewlines() {
    const source = readStatic('browse.js');
    const match = source.match(/function normalizeNewlines\(text\) \{[\s\S]*?\n\}/);
    if (!match) {
        throw new Error('normalizeNewlines() not found in browse.js');
    }
    return new Function(`${match[0]}; return normalizeNewlines;`)();
}

function readJsonl(filePath) {
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(line => line.trim())
        .map((line, lineIdx) => {
            try {
                return JSON.parse(line);
            } catch (err) {
                return { __parseError: `${filePath}:${lineIdx + 1}: ${err.message}` };
            }
        });
}

function listFiles(dir, suffix) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...listFiles(full, suffix));
        } else if (entry.name.endsWith(suffix)) {
            result.push(full);
        }
    }
    return result.sort();
}

// Stored outputs: { source, text } for every record in data/outputs/**/*.jsonl.
function loadOutputs(factgenieDir, normalizeNewlines) {
    const outputs = [];
    for (const file of listFiles(path.join(factgenieDir, 'data', 'outputs'), '.jsonl')) {
        readJsonl(file).forEach((record, lineIdx) => {
            if (record.__parseError || record.output === undefined) {
                return;
            }
            outputs.push({
                source: `${path.relative(factgenieDir, file)}:${lineIdx + 1}`,
                text: normalizeNewlines(record.output),
            });
        });
    }
    return outputs;
}

// Campaign annotation records from campaigns/*/files/*.jsonl.
function loadCampaignRecords(factgenieDir, normalizeNewlines) {
    const records = [];
    for (const file of listFiles(path.join(factgenieDir, 'campaigns'), '.jsonl')) {
        if (!file.includes(`${path.sep}files${path.sep}`)) {
            continue;
        }
        const campaignId = path.relative(path.join(factgenieDir, 'campaigns'), file).split(path.sep)[0];
        readJsonl(file).forEach((record, lineIdx) => {
            if (record.__parseError || record.output === undefined || !Array.isArray(record.annotations)) {
                return;
            }
            const metadata = record.metadata || {};
            records.push({
                source: `${path.relative(factgenieDir, file)}:${lineIdx + 1}`,
                campaignId,
                text: normalizeNewlines(record.output),
                annotations: record.annotations,
                granularity: metadata.annotation_granularity || 'words',
                categories: metadata.annotation_span_categories || [],
            });
        });
    }
    return records;
}

// Serializes a node tree keeping text node boundaries and attribute order.
function serializeNode(node) {
    if (node.nodeType === 3) {
        return JSON.stringify(node.data);
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) {
        return `#${node.nodeType}`;
    }
    const children = Array.from(node.childNodes).map(serializeNode).join('');
    if (node.nodeType === 11) {
        return children;
    }
    const attrs = Array.from(node.attributes).map(attr => ` ${attr.name}=${JSON.stringify(attr.value)}`).join('');
    return `<${node.localName}${attrs}>${children}</${node.localName}>`;
}

module.exports = {
    REPO_ROOT,
    readStatic,
    readStaticAtRef,
    createWindow,
    loadNormalizeNewlines,
    loadOutputs,
    loadCampaignRecords,
    serializeNode,
};
