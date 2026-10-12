#!/usr/bin/env node
// Unit tests for the span renderers and the Browse search highlights on
// rendered outputs. Usage: node tests/js/test_renderers.js
const env = require('./lib/env');
const { createMarkdownWindow, renderDocument } = require('./lib/markdown');

const window = createMarkdownWindow();
const failures = [];
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (err) {
        failures.push(`${name}: ${err.message}`);
    }
}

function assertEqual(actual, expected, what = 'value') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`${what}: expected ${e}, got ${a}`);
    }
}

// [start, display] of the visible units
const units = (text, format = 'markdown', citations = null) =>
    window.SpanRenderers.render(text, format, { citations }).units.map(unit => [unit.start, unit.display]);

function assertChecksPass(text) {
    for (const granularity of ['words', 'chars']) {
        const result = renderDocument(window, text, granularity);
        assertEqual(result.check.ok, true, `checks (${granularity})`);
        assertEqual(result.warnings, [], `warnings (${granularity})`);
    }
}

// Code blocks: whitespace in the code keeps its own offsets, the removed
// indentation or container prefix stays hidden.

test('indented code keeps inner indentation on its own offsets', () => {
    assertEqual(units('    a\n      b'), [[4, 'a'], [5, '\n'], [10, ' '], [11, ' '], [12, 'b']]);
    assertChecksPass('    a\n      b');
});

test('indented code inside a list item', () => {
    assertEqual(units('- x\n\n      a\n        b'), [[2, 'x'], [11, 'a'], [12, '\n'], [19, ' '], [20, ' '], [21, 'b']]);
});

test('indented code inside a blockquote', () => {
    assertEqual(units('>     a\n>       b'), [[6, 'a'], [7, '\n'], [14, ' '], [15, ' '], [16, 'b']]);
});

test('indented code with tabs', () => {
    assertEqual(units('\t\ta\n\t\t  b'), [[1, '\t'], [2, 'a'], [3, '\n'], [5, '\t'], [6, ' '], [7, ' '], [8, 'b']]);
});

test('inline code strips one padding space on each side', () => {
    assertEqual(units('x ``  a  `` y'), [[0, 'x'], [1, ' '], [5, ' '], [6, 'a'], [7, ' '], [11, ' '], [12, 'y']]);
    assertEqual(units('x `` ` `` y'), [[0, 'x'], [1, ' '], [5, '`'], [9, ' '], [10, 'y']]);
});

test('inline code of only spaces is not stripped', () => {
    assertEqual(units('x `  ` y'), [[0, 'x'], [1, ' '], [3, ' '], [4, ' '], [6, ' '], [7, 'y']]);
});

// Fences: a closing fence uses the opening character and is at least as long.

test('closing fence must match the opening character', () => {
    assertEqual(units('```\na\n~~~'), [[4, 'a'], [5, '\n'], [6, '~'], [7, '~'], [8, '~']]);
    assertChecksPass('```\na\n~~~');
});

test('closing fence must be at least as long as the opening one', () => {
    assertEqual(units('~~~~\na\n~~~\n~~~~'), [[5, 'a'], [6, '\n'], [7, '~'], [8, '~'], [9, '~']]);
    assertChecksPass('~~~~\na\n~~~\n~~~~');
});

test('matching closing fence is hidden', () => {
    assertEqual(units('```\na\n```'), [[4, 'a']]);
    assertEqual(units('```\na\n`````'), [[4, 'a']]);
});

// Browse search: matches are found in the raw output, so they can cross
// formatting and hidden syntax.

function loadBrowseFunction(name) {
    const source = env.readStatic('browse.js');
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!match) {
        throw new Error(`${name}() not found in browse.js`);
    }
    window.eval(`${match[0]}; window.${name} = ${name};`);
}
['rawTextMatches', 'markRenderedOutputText'].forEach(loadBrowseFunction);

// An output box like Browse builds it: annotated (atoms) or static (segments).
function outputBox(text, granularity = null) {
    const $ = window.$;
    const box = $('<div>', { class: 'output-box' });
    const placeholder = $('<div>', { class: 'out-placeholder' }).appendTo(box);
    if (granularity) {
        const annotator = new window.SpanAnnotator();
        annotator.init(granularity, true, [], false);
        const content = $('<div>');
        annotator.addDocument('doc', content, false, text, { format: 'markdown' });
        placeholder.append(content);
    } else {
        const rendered = window.SpanRenderers.renderStatic(text, 'markdown', {});
        placeholder.append(rendered.root);
        placeholder.data('segments', rendered.segments);
    }
    placeholder.data('rawText', text);
    return box;
}

const marked = box => box.find('mark.browse-match-highlight').map((_, el) => el.textContent).get();
const markedAtoms = box => box.find('.browse-match-span').map((_, el) => el.dataset.index).get().map(Number);

test('raw matches are code-point ranges', () => {
    assertEqual(window.rawTextMatches('😀 Ab ab', 'AB'), [{ start: 2, end: 4 }, { start: 5, end: 7 }]);
});

test('search across bold in the original box', () => {
    const box = outputBox('Hello **world** today');
    assertEqual(window.markRenderedOutputText(box, 'Hello **world**'), true);
    assertEqual(marked(box), ['Hello ', 'world']);
});

test('search across list items in the original box', () => {
    const box = outputBox('- alpha\n- beta');
    assertEqual(window.markRenderedOutputText(box, 'alpha\n- beta'), true);
    assertEqual(marked(box), ['alpha', 'beta']);
});

test('search inside one text node of the original box', () => {
    const box = outputBox('one two one');
    assertEqual(window.markRenderedOutputText(box, 'one'), true);
    assertEqual(marked(box), ['one', 'one']);
});

test('search across formatting in annotated boxes', () => {
    const bold = outputBox('Hello **world** today', 'words');
    assertEqual(window.markRenderedOutputText(bold, 'Hello **world**'), true);
    assertEqual([...new Set(markedAtoms(bold))], [0, 6]);
    const words = outputBox('- alpha\n- beta', 'words');
    assertEqual(window.markRenderedOutputText(words, 'alpha\n- beta'), true);
    assertEqual([...new Set(markedAtoms(words))], [2, 10]);
    const chars = outputBox('Hello **world** today', 'chars');
    assertEqual(window.markRenderedOutputText(chars, 'o **w'), true);
    assertEqual([...new Set(markedAtoms(chars))], [4, 5, 8]);
});

test('no match leaves the box unchanged', () => {
    const box = outputBox('Hello **world**');
    assertEqual(window.markRenderedOutputText(box, 'missing'), false);
    assertEqual(marked(box), []);
});

console.log(`passed: ${passed}, failed: ${failures.length}`);
failures.forEach(failure => console.log(`FAIL ${failure}`));
process.exit(failures.length === 0 ? 0 : 1);
