#!/usr/bin/env node
// Verification 1 (plain equivalence): the refactored annotator with the
// `plain` renderer must build exactly the DOM of the pre-refactor annotator
// for every stored output, in both granularities, with and without the stored
// campaign annotations applied.
//
// Usage: node tests/js/verify_plain_equivalence.js <factgenie-dir> [base-ref] [--jobs N] [--no-cache]
//   <factgenie-dir>  directory with data/outputs and campaigns
//                    (e.g. ../factgenie-personal-fork/factgenie)
//   [base-ref]       git ref of the pre-refactor span-annotator.js (default personal/main)
//   --jobs N         worker threads (default: CPU count - 1)
//   --no-cache       recompute the base-ref results instead of reading the cache
//
// The base-ref results (hashes of DOM and atom triples) are cached in
// tests/js/.cache/, keyed by the git blob of the base-ref span-annotator.js,
// so later runs only render the new code. The work is split over worker
// threads; the long chars-mode documents dominate the run time.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const env = require('./lib/env');

const sha = text => crypto.createHash('sha256').update(text).digest('hex');

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

// One job renders one document with the new code (and the old code unless
// its hashes are cached) and compares the results.
function runWorker() {
    const { jobs, baseRef, cached } = workerData;
    let oldWindow = null;
    const oldWindowLazy = () => {
        oldWindow = oldWindow || env.createWindow([env.readStaticAtRef(baseRef, 'span-annotator.js')]);
        return oldWindow;
    };
    const newWindow = env.createWindow([env.readStatic('span-renderers.js'), env.readStatic('span-annotator.js')]);

    for (const job of jobs) {
        const args = [job.text, job.granularity, job.annotations, job.categories];
        const after = render(newWindow, ...args);
        const afterHash = { dom: sha(after.dom), triples: sha(after.triples) };
        let beforeHash = cached[job.key];
        let before = null;
        if (!beforeHash) {
            before = render(oldWindowLazy(), ...args);
            beforeHash = { dom: sha(before.dom), triples: sha(before.triples) };
        }
        const failures = [];
        for (const part of job.parts) {
            if (beforeHash[part] !== afterHash[part]) {
                // re-render the old side for a readable diff
                before = before || render(oldWindowLazy(), ...args);
                failures.push({ label: `${job.label} ${part}`, ...firstDifference(before[part], after[part]) });
            }
        }
        parentPort.postMessage({ key: job.key, beforeHash, checked: job.parts.length, failures });
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const option = name => {
        const index = argv.indexOf(name);
        return index >= 0 ? argv[index + 1] : null;
    };
    const positional = argv.filter((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--jobs');
    const factgenieDir = path.resolve(positional[0] || path.join(env.REPO_ROOT, 'factgenie'));
    const baseRef = positional[1] || 'personal/main';
    const jobCount = Math.max(1, Number(option('--jobs')) || os.cpus().length - 1);
    const useCache = !argv.includes('--no-cache');

    const baseBlob = execFileSync('git', ['-C', env.REPO_ROOT, 'rev-parse', `${baseRef}:factgenie/static/js/span-annotator.js`], { encoding: 'utf8' }).trim();
    const cacheFile = path.join(__dirname, '.cache', `plain-baseline-${baseBlob}.json`);
    const cache = useCache && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};

    const normalizeNewlines = env.loadNormalizeNewlines();
    const outputs = env.loadOutputs(factgenieDir, normalizeNewlines);
    const records = env.loadCampaignRecords(factgenieDir, normalizeNewlines);
    // Edge cases not necessarily present in the data.
    const synthetic = ['', ' ', '\n', ' a', 'a ', '  a  b  ', 'a\n\nb', '\tx\r', '😀 a👍🏽b', 'é x'];

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

    const jobs = [];
    for (const [text, source] of texts) {
        for (const granularity of ['words', 'chars']) {
            jobs.push({
                key: sha(JSON.stringify([text, granularity])),
                label: `${source} [${granularity}]`,
                text, granularity, annotations: null, categories: [],
                parts: ['triples', 'dom'],
            });
        }
    }
    let annotationCount = 0;
    for (const record of records) {
        annotationCount += record.annotations.length;
        jobs.push({
            key: sha(JSON.stringify([record.text, record.granularity, record.annotations, record.categories])),
            label: `${record.source} [${record.granularity}] with ${record.annotations.length} annotations`,
            text: record.text,
            granularity: record.granularity,
            annotations: record.annotations,
            categories: record.categories,
            parts: ['dom'],
        });
    }

    // Longest documents first, dealt round-robin, so the workers finish together.
    const cost = job => job.text.length * (job.granularity === 'chars' ? 8 : 1) * (cache[job.key] ? 1 : 2);
    const sorted = [...jobs].sort((a, b) => cost(b) - cost(a));
    const chunks = Array.from({ length: jobCount }, () => []);
    sorted.forEach((job, i) => chunks[i % jobCount].push(job));

    let checked = 0;
    const failures = [];
    const newCache = {};
    await Promise.all(chunks.filter(chunk => chunk.length > 0).map(chunk => new Promise((resolve, reject) => {
        const cached = {};
        chunk.forEach(job => {
            if (cache[job.key]) cached[job.key] = cache[job.key];
        });
        const worker = new Worker(__filename, { workerData: { jobs: chunk, baseRef, cached } });
        worker.on('message', message => {
            checked += message.checked;
            failures.push(...message.failures);
            newCache[message.key] = message.beforeHash;
        });
        worker.on('error', reject);
        worker.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
    })));

    if (useCache) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, ...newCache }));
    }

    console.log(`base ref:            ${baseRef} (span-annotator.js ${baseBlob.slice(0, 10)})`);
    console.log(`data:                ${factgenieDir}`);
    console.log(`stored outputs:      ${outputs.length}`);
    console.log(`campaign records:    ${records.length} (${annotationCount} annotations)`);
    console.log(`synthetic texts:     ${synthetic.length}`);
    console.log(`distinct texts:      ${texts.size} (x2 granularities)`);
    console.log(`workers:             ${jobCount}; base results from cache: ${jobs.filter(job => cache[job.key]).length} of ${jobs.length}`);
    console.log(`comparisons:         ${checked}`);
    console.log(`differences:         ${failures.length}`);
    failures.slice(0, 20).forEach(f => console.log(JSON.stringify(f)));
    process.exit(failures.length === 0 ? 0 : 1);
}

if (isMainThread) {
    main().catch(err => {
        console.error(err);
        process.exit(2);
    });
} else {
    runWorker();
}
