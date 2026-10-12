// Helpers for the markdown verifications: a window with the bundle, renderers
// and annotator, and a renderer that returns atoms, units and check results.
const env = require('./env');

function createMarkdownWindow() {
    const window = env.createWindow(
        ['lib/mdast-gfm.bundle.js', 'span-renderers.js', 'span-annotator.js'].map(env.readStatic),
        { expose: ['SpanAnnotator', 'SpanRenderers'] }
    );
    // collect renderer warnings (e.g. text nodes that could not be aligned)
    window.__warnings = [];
    window.console.warn = (...args) => window.__warnings.push(args);
    return window;
}

// Renders `text` with `format` and returns the atoms (fragments merged),
// visible units and the runtime check result.
function renderDocument(window, text, granularity, format = 'markdown', annotations = null, categories = []) {
    window.__warnings.length = 0;
    const annotator = new window.SpanAnnotator();
    annotator.init(granularity, true, categories, false);
    const element = window.document.createElement('div');
    annotator.addDocument('doc', element, false, text, { format });
    if (annotations) {
        annotator.addAnnotations('doc', annotations);
    }
    const warnings = window.__warnings.map(args => args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
    const atoms = [];
    element.querySelectorAll('.annotatable').forEach(span => {
        const start = Number(span.dataset.index);
        const length = Array.from(span.dataset.content ?? '').length;
        const last = atoms[atoms.length - 1];
        if (last && last.start === start) {
            return;
        }
        atoms.push({ start, end: start + length });
    });
    // units are rebuilt from a second render (the annotator does not keep them)
    const units = window.SpanRenderers.get(format).render(text).units
        .map(unit => ({ start: unit.start, end: unit.end, display: unit.display }));
    return {
        atoms,
        units,
        check: annotator.getDocumentCheck('doc'),
        warnings,
        element,
    };
}

function distinctTexts(outputs, records) {
    const texts = new Map();
    [...outputs, ...records].forEach(({ source, text }) => {
        if (!texts.has(text)) {
            texts.set(text, source);
        }
    });
    return texts;
}

module.exports = { createMarkdownWindow, renderDocument, distinctTexts };
