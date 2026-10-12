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

test('backticks indented four spaces are code, not a fence', () => {
    // indented code block starting with backticks
    assertEqual(units('    ```\n    a'), [[4, '`'], [5, '`'], [6, '`'], [7, '\n'], [12, 'a']]);
    assertChecksPass('    ```\n    a');
    assertChecksPass('- x\n\n      ```\n      a');
    assertChecksPass('>     ```\n>     a');
    // an indented backtick line inside a fenced block is content
    assertEqual(units('```\na\n    ```'), [[4, 'a'], [5, '\n'], [6, ' '], [7, ' '], [8, ' '], [9, ' '], [10, '`'], [11, '`'], [12, '`']]);
    assertChecksPass('```\na\n    ```');
    assertChecksPass('```\na\n    ```\n```');
});

test('fences inside containers', () => {
    assertEqual(units('> ```\n> a\n> ```'), [[8, 'a']]);
    assertEqual(units('- ```\n  a\n  ```'), [[8, 'a']]);
    assertEqual(units('  ```\n  a\n  ```'), [[8, 'a']]);
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
['markSegmentRange', 'markRenderedOutputText'].forEach(loadBrowseFunction);

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
    assertEqual(window.SpanRenderers.findText('😀 Ab ab', 'AB'), [{ start: 2, end: 4 }, { start: 5, end: 7 }]);
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

test('several searches in the same original box', () => {
    const box = outputBox('one two **three**');
    assertEqual(window.markRenderedOutputText(box, 'one'), true);
    assertEqual(window.markRenderedOutputText(box, 'two **three**'), true);
    assertEqual(marked(box), ['one', 'two ', 'three']);
    const overlapping = outputBox('one two three');
    assertEqual(window.markRenderedOutputText(overlapping, 'two'), true);
    assertEqual(window.markRenderedOutputText(overlapping, 'one two three'), true);
    assertEqual(overlapping.text(), 'one two three');
    assertEqual(marked(overlapping), ['one ', 'two', ' three']);
});

test('no match leaves the box unchanged', () => {
    const box = outputBox('Hello **world**');
    assertEqual(window.markRenderedOutputText(box, 'missing'), false);
    assertEqual(marked(box), []);
});

// V4: renderer cases from the spec (offsets are code points into the raw text).

test('emoji and other non-BMP characters keep code-point offsets', () => {
    assertEqual(units('a 😀 **b**'), [[0, 'a'], [1, ' '], [2, '😀'], [3, ' '], [6, 'b']]);
    assertChecksPass('a 😀 **b** 𝒳 c');
});

test('entities show the decoded character on the raw range', () => {
    assertEqual(units('x &amp; y &#128512;'), [[0, 'x'], [1, ' '], [2, '&'], [7, ' '], [8, 'y'], [9, ' '], [10, '😀']]);
    assertChecksPass('x &amp; y &#128512; &nbsp;z');
});

test('escapes show the escaped character', () => {
    assertEqual(units('\\*a\\*'), [[0, '*'], [2, 'a'], [3, '*']]);
    assertChecksPass('\\*a\\* \\_b\\_ 1\\. c');
});

test('bold inside a word keeps one atom in words mode', () => {
    const result = renderDocument(window, 'wo**rd** x', 'words');
    assertEqual(result.atoms, [{ start: 0, end: 8 }, { start: 9, end: 10 }]);
    const fragments = Array.from(result.element.querySelectorAll('.annotatable[data-index="0"]')).map(span => span.firstChild.data);
    assertEqual(fragments, ['wo', 'rd']);
    assertChecksPass('wo**rd** x');
});

test('tables with and without spaces around pipes', () => {
    assertEqual(units('| a | b |\n|---|---|\n| 1 | 2 |'), [[2, 'a'], [6, 'b'], [22, '1'], [26, '2']]);
    assertEqual(units('|a|b|\n|-|-|\n|1|2|'), [[1, 'a'], [3, 'b'], [13, '1'], [15, '2']]);
    assertChecksPass('| a | b |\n|---|---|\n| 1 | 2 |');
    assertChecksPass('|a|b|\n|-|-|\n|1|2|');
});

test('lists hide bullets and show ordered list numbers', () => {
    assertEqual(units('- a\n- b'), [[2, 'a'], [6, 'b']]);
    assertEqual(units('1. x\n2. y'), [[0, '1'], [1, '.'], [3, 'x'], [5, '2'], [6, '.'], [8, 'y']]);
    assertChecksPass('- a\n  - nested **b**\n1. x\n2. y');
});

const citationUnits = (text, display = 'superscript') =>
    window.SpanRenderers.render(text, 'markdown', { citations: display }).units
        .filter(unit => unit.kind === 'citation').map(unit => [unit.start, unit.end, unit.display]);

test('stacked citations share one superscript', () => {
    assertEqual(citationUnits('Text.[^Z7][^Z10] end'), [[5, 10, '7'], [10, 16, '10']]);
    const result = renderDocument(window, 'Text.[^Z7][^Z10] end', 'words', 'markdown', null, [], 'superscript');
    assertEqual(result.check.ok, true, 'checks');
    const groups = result.element.querySelectorAll('sup.citation-group');
    assertEqual(groups.length, 1, 'superscripts');
    assertEqual(groups[0].textContent, '7,10');
    // without a citation format the markers stay as written
    assertEqual(citationUnits('Text.[^Z7] end', null), []);
    assertEqual(units('Text.[^Z7] end', 'markdown', null).length, 14);
});

test('citation_display values', () => {
    const display = value => window.SpanRenderers.citationDisplay(value);
    assertEqual([display(undefined), display(null), display(''), display(NaN)], [null, null, null, null]);
    assertEqual(display('superscript'), 'superscript');
    // old or unknown values are used as superscript
    assertEqual([display('hidden'), display('raw')], ['superscript', 'superscript']);
});

test('citations inside table cells', () => {
    const text = '| a |\n|---|\n| x[^Z2] |';
    assertEqual(citationUnits(text), [[15, 20, '2']]);
    for (const granularity of ['words', 'chars']) {
        assertEqual(renderDocument(window, text, granularity, 'markdown', null, [], 'superscript').check.ok, true, granularity);
    }
});

test('citation sources: label match, nth item fallback, unresolved labels', () => {
    const area = window.document.createElement('div');
    area.innerHTML = '<ol><li><code>[Z1] docs/one.pdf</code></li><li><code>[Z7] docs/seven.pdf</code></li></ol>';
    assertEqual(window.CitationSources.find('Z7', area).path, 'docs/seven.pdf');
    assertEqual(window.CitationSources.find('Z9', area), null);
    const plainArea = window.document.createElement('div');
    plainArea.innerHTML = '<ol><li>one</li><li>two</li></ol>';
    assertEqual(window.CitationSources.find('Z2', plainArea).item.textContent, 'two');

    const rendered = window.SpanRenderers.renderStatic('A.[^Z7][^Z9]', 'markdown', { citations: 'superscript' });
    window.CitationSources.resolve(rendered.root, area, ' (hint)');
    const citations = Array.from(rendered.root.querySelectorAll('.citation'));
    assertEqual(citations.map(c => c.title), ['Z7: docs/seven.pdf (hint)', 'Z9: source not found in the input']);
    assertEqual(citations.map(c => c.classList.contains('citation-unresolved')), [false, true]);
});

// Annotation page: view switches, read-only views and citation clicks.

const categories = [{ name: 'Error', color: '#f00' }];

function annotationPageDoc(text, granularity, options) {
    const $ = window.$;
    const annotator = new window.SpanAnnotator();
    annotator.init(granularity, true, categories, false);
    const box = $('<div>', { class: 'annotate-box' }).appendTo(window.document.body);
    const paragraph = $('<p>', { class: 'annotatable-paragraph' }).appendTo(box);
    annotator.addDocument('p0', paragraph, true, text, options);
    return { annotator, box, paragraph };
}

const highlighted = paragraph => [...new Set(paragraph.find('.annotatable').filter((_, el) => el.style.background).map((_, el) => Number(el.dataset.index)).get())];

test('switching views keeps annotations and the undo history', () => {
    const $ = window.$;
    const text = 'Hello **world** today';
    const { annotator, paragraph } = annotationPageDoc(text, 'words', { format: 'plain' });
    const atom = index => paragraph.find(`.annotatable[data-index="${index}"]`).last();
    annotator._createAnnotation('p0', atom(6), atom(6));
    assertEqual(annotator.getAnnotations('p0').map(a => [a.start, a.text]), [[6, '**world**']]);

    annotator.renderDocument('p0', { format: 'markdown', citations: 'superscript' });
    assertEqual(annotator.getAnnotations('p0').map(a => [a.start, a.text]), [[6, '**world**']]);
    assertEqual(highlighted(paragraph), [6]);
    assertEqual(paragraph.find('strong .annotatable').length, 1, 'rendered as bold');

    annotator._createAnnotation('p0', atom(16), atom(16));
    annotator.renderDocument('p0', { format: 'plain' });
    assertEqual(highlighted(paragraph), [6, 16]);
    annotator.undo('p0');
    assertEqual(annotator.getAnnotations('p0').map(a => a.start), [6]);
    annotator.undo('p0');
    assertEqual(annotator.getAnnotations('p0'), []);
    $(window.document.body).empty();
});

test('read-only documents ignore annotating and erasing', () => {
    const $ = window.$;
    const { annotator, box, paragraph } = annotationPageDoc('Hello world', 'words', { format: 'markdown' });
    annotator.addAnnotations('p0', [{ type: 0, start: 0, text: 'Hello' }]);
    annotator.setDocumentReadOnly('p0', true);
    assertEqual(box.hasClass('annotate-box-readonly'), true);
    const atom = paragraph.find('.annotatable').first();
    atom.trigger($.Event('mousedown', { button: 0 }));
    assertEqual(annotator.isSelecting, false, 'selecting');
    atom.trigger($.Event('mousedown', { button: 2 }));
    assertEqual(annotator.getAnnotations('p0').length, 1, 'annotations');
    annotator.setDocumentReadOnly('p0', false);
    assertEqual(box.hasClass('annotate-box-readonly'), false);
    $(window.document.body).empty();
});

test('a marker for a hidden annotation can be edited and removed', () => {
    const $ = window.$;
    const text = 'See [docs](https://example.org) now';
    const { annotator, paragraph } = annotationPageDoc(text, 'chars', { format: 'markdown' });
    annotator.annotateReason = true;
    const url = { type: 0, start: 11, text: 'https://example.org' };
    annotator.addAnnotations('p0', [url, { type: 0, start: 0, text: 'See' }]);
    const marker = () => paragraph.find('.annotation-marker');
    assertEqual(marker().length, 1, 'markers');
    assertEqual(marker().hasClass('annotation-marker-editable'), true, 'editable');
    const shown = [];
    annotator._showReasonDialog = annotation => shown.push(annotation.text);
    marker().trigger($.Event('mousedown', { button: 0 }));
    assertEqual(annotator.isSelecting, false, 'selecting');
    marker().trigger('click');
    assertEqual(shown, ['https://example.org']);
    marker().trigger($.Event('mousedown', { button: 2 }));
    assertEqual(annotator.getAnnotations('p0').map(a => a.text), ['See']);
    assertEqual(marker().length, 0, 'markers after removal');
    annotator.undo('p0');
    assertEqual(annotator.getAnnotations('p0').length, 2, 'undo');
    // read-only views keep the marker passive
    annotator.setDocumentReadOnly('p0', true);
    assertEqual(marker().hasClass('annotation-marker-editable'), false, 'read-only');
    marker().trigger($.Event('mousedown', { button: 2 }));
    assertEqual(annotator.getAnnotations('p0').length, 2, 'read-only removal');
    $(window.document.body).empty();
});

test('ctrl/cmd+click on a citation reports its label', () => {
    const $ = window.$;
    const { annotator, paragraph } = annotationPageDoc('Text.[^Z7][^Z10]', 'words', { format: 'markdown', citations: 'superscript' });
    const clicked = [];
    annotator.addEventListener('citationClicked', ({ label }) => clicked.push(label));
    const citation = paragraph.find('.citation[data-label="Z10"] .annotatable');
    citation.trigger($.Event('mousedown', { button: 0, ctrlKey: true }));
    citation.trigger($.Event('mousedown', { button: 0, metaKey: true }));
    assertEqual(clicked, ['Z10', 'Z10']);
    assertEqual(annotator.isSelecting, false, 'selecting');
    $(window.document.body).empty();
});

test('reason edit finds annotations overlapping a rendered atom', () => {
    const $ = window.$;
    const { annotator, paragraph } = annotationPageDoc('wo**rd** x', 'words', { format: 'markdown' });
    annotator.annotateReason = true;
    annotator.addAnnotations('p0', [{ type: 0, start: 4, text: 'rd' }]);
    const shown = [];
    annotator._showReasonDialog = annotation => shown.push(annotation.text);
    paragraph.find('strong .annotatable').trigger('click');
    assertEqual(shown, ['rd']);
    $(window.document.body).empty();
});

// Annotation page: redo markers search the raw output.

// Single citations as words-mode units (campaigns with citation_display).

test('words tokens split at citation markers only with splitCitations', () => {
    const annotator = new window.SpanAnnotator();
    const text = 'Ve budov.[^Z7][^Z10] a[^Z1]b [1] x';
    assertEqual(annotator._wordTokens(text, true).map(t => [t.part, t.whitespace]), [
        ['Ve', ' '], ['budov.', ''], ['[^Z7]', ''], ['[^Z10]', ' '], ['a', ''], ['[^Z1]', ''], ['b', ' '], ['[1]', ' '], ['x', ''],
    ]);
    assertEqual(annotator._wordTokens(text, false).map(t => t.part), ['Ve', 'budov.[^Z7][^Z10]', 'a[^Z1]b', '[1]', 'x']);
});

const atomIndexes = paragraph => [...new Set(paragraph.find('.annotatable').map((_, el) => Number(el.dataset.index)).get())];

test('a single citation is its own atom in both views', () => {
    const text = 'Ve **budov**.[^Z7][^Z10] dnes';
    const rendered = { format: 'markdown', citations: 'superscript', splitCitations: true };
    const raw = { format: 'plain', citations: null, splitCitations: true };
    const { annotator, paragraph } = annotationPageDoc(text, 'words', rendered);
    assertEqual(atomIndexes(paragraph), [0, 3, 13, 18, 25]);
    const citation = paragraph.find('.citation[data-label="Z7"] .annotatable');
    assertEqual(citation.attr('data-content'), '[^Z7]');
    annotator._createAnnotation('p0', citation, citation);
    assertEqual(annotator.getAnnotations('p0').map(a => [a.start, a.text]), [[13, '[^Z7]']]);
    assertEqual(highlighted(paragraph), [13]);
    annotator.renderDocument('p0', raw);
    assertEqual(atomIndexes(paragraph), [0, 3, 13, 18, 25]);
    assertEqual(highlighted(paragraph), [13]);
    // the same selection in Raw stores the same annotation
    const rawAtom = paragraph.find('.annotatable[data-index="13"]');
    annotator._createAnnotation('p0', rawAtom, rawAtom);
    assertEqual(annotator.getAnnotations('p0').length, 1, 'no duplicate');
    // without the split the citation stays part of the word
    annotator.renderDocument('p0', { ...rendered, splitCitations: false });
    assertEqual(atomIndexes(paragraph), [0, 3, 25]);
    window.$(window.document.body).empty();
});

test('no annotation gap inside a token split at a citation', () => {
    const { annotator, paragraph } = annotationPageDoc('budov.[^Z7] dnes', 'words', { format: 'markdown', citations: 'superscript', splitCitations: true });
    annotator.addAnnotations('p0', [{ type: 0, start: 0, text: 'budov.' }, { type: 0, start: 6, text: '[^Z7]' }]);
    const atom = index => paragraph.find(`.annotatable[data-index="${index}"]`);
    assertEqual(atom(0)[0].style.marginRight, '', 'before the citation');
    assertEqual(atom(6)[0].style.marginRight, '9px', 'after the token');
    window.$(window.document.body).empty();
});

test('the reason dialog quotes the visible text', () => {
    const text = 'Ve **budov**.[^Z7][^Z10] dnes';
    const { annotator, paragraph } = annotationPageDoc(text, 'words', { format: 'markdown', citations: 'superscript', splitCitations: true });
    const shown = annotation => annotator._visibleText('p0', annotation);
    assertEqual(shown({ start: 3, text: '**budov**.' }), 'budov.');
    assertEqual(shown({ start: 13, text: '[^Z7]' }), '⁷');
    assertEqual(shown({ start: 13, text: '[^Z7][^Z10]' }), '⁷˒¹⁰');
    assertEqual(shown({ start: 0, text: 'Ve **budov**.[^Z7]' }), 'Ve budov.⁷');
    annotator.renderDocument('p0', { format: 'plain', splitCitations: true });
    assertEqual(shown({ start: 13, text: '[^Z7]' }), '[^Z7]');
    // the dialog escapes the text
    annotator.renderDocument('p0', { format: 'plain' });
    annotator.documents.get('p0').text = 'Ve <b> x';
    annotator.renderDocument('p0', { format: 'plain' });
    annotator.pendingAnnotation = { objectId: 'p0' };
    window.bootstrap = { Modal: class { show() {} hide() {} static getInstance() { return null; } } };
    try {
        annotator._showReasonDialog({ start: 0, text: 'Ve <b>' });
    } finally {
        delete window.bootstrap;
    }
    assertEqual(window.$('#annotation-reason-modal strong').text(), 'Ve <b>');
    window.$(window.document.body).empty();
});

function loadAnnotateFunction(name) {
    const source = env.readStatic('annotate.js');
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!match) {
        throw new Error(`${name}() not found in annotate.js`);
    }
    window.eval(`${match[0]}; window.${name} = ${name};`);
}
['markRedoAnnotatableRange', 'markRedoAnnotatableText'].forEach(loadAnnotateFunction);

test('redo markers cross formatting in the rendered view', () => {
    const text = 'Hello **world** today 😀 end';
    const words = outputBox(text, 'words');
    assertEqual(window.markRedoAnnotatableText(words, 'Hello **world**', text), true);
    assertEqual([...new Set(markedAtoms(words))], [0, 6]);
    const chars = outputBox(text, 'chars');
    assertEqual(window.markRedoAnnotatableText(chars, '😀 e', text), true);
    assertEqual([...new Set(markedAtoms(chars))], [22, 23, 24]);
    assertEqual(window.markRedoAnnotatableText(chars, 'missing', text), false);
});

console.log(`passed: ${passed}, failed: ${failures.length}`);
failures.forEach(failure => console.log(`FAIL ${failure}`));
process.exit(failures.length === 0 ? 0 : 1);
