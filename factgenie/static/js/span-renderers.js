// Output renderers for the span annotator.
//
// A renderer turns the raw output text (the normalized string that annotation
// offsets refer to) into a DOM skeleton plus a list of visible units:
//
//   render(rawText, options) -> {
//       chars,      // raw text as an array of code points
//       root,       // DocumentFragment with the rendered skeleton
//       units,      // [{ start, end, container, display }] in raw order
//   }
//
// A unit covers the raw code points [start, end) and shows `display` inside
// `container` (an element of `root`, or `root` itself). A display of "\n" is
// shown as <br>. Raw code points not covered by any unit are hidden syntax.
// A unit with kind "citation" shows a citation label instead of its raw text.
// Units must come in raw order, and text inside one container must not be
// followed by element children of that container (renderers use one slot
// element per text run). The annotator builds atoms (`.annotatable` spans)
// from the units and has no knowledge of the format.

class PlainRenderer {
    render(rawText) {
        const chars = Array.from(String(rawText));
        const root = document.createDocumentFragment();
        const units = chars.map((char, index) => ({
            start: index,
            end: index + 1,
            container: root,
            display: char,
        }));
        return { chars, root, units };
    }
}

// Markdown (GFM) renderer. Parses with the vendored MdastGfm bundle and maps
// every visible character back to its raw code-point range. The DOM is built
// with createElement/textContent only; raw HTML in the text stays text.
const MD_ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
const MD_ENTITY = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));/;
const MD_SAFE_URL = /^https?:\/\//i;
const MD_INLINE_PARENTS = new Set([
    'paragraph', 'heading', 'tableCell', 'strong', 'emphasis', 'delete', 'link', 'linkReference',
]);

class MarkdownRenderer {
    render(rawText) {
        const text = String(rawText);
        const chars = Array.from(text);
        const root = document.createDocumentFragment();
        const units = [];
        if (typeof MdastGfm === 'undefined') {
            throw new Error('MdastGfm bundle is not loaded');
        }
        const tree = MdastGfm.parse(text);

        // parser offsets are UTF-16 units; atoms use code points
        const cpAt = new Array(text.length + 1);
        let cp = 0;
        for (let i = 0; i < text.length; cp++) {
            const width = text.codePointAt(i) > 0xffff ? 2 : 1;
            cpAt[i] = cp;
            if (width === 2) {
                cpAt[i + 1] = cp;
            }
            i += width;
        }
        cpAt[text.length] = cp;

        const ctx = { chars, units, cpAt };
        this._blocks(tree, root, ctx);
        return { chars, root, units };
    }

    _range(node, ctx) {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (!Number.isInteger(start) || !Number.isInteger(end)) {
            return null;
        }
        return [ctx.cpAt[start], ctx.cpAt[end]];
    }

    _el(tag, parent, className = null) {
        const el = document.createElement(tag);
        if (className) {
            el.className = className;
        }
        parent.append(el);
        return el;
    }

    // A fresh container for text that atoms are appended to later; one per
    // text node keeps atoms in document order around inline elements.
    _slot(parent, tag = 'span', className = 'md-text') {
        return this._el(tag, parent, className);
    }

    _blocks(node, parent, ctx, tight = false) {
        (node.children || []).forEach(child => this._block(child, parent, ctx, tight));
    }

    _block(node, parent, ctx, tight) {
        switch (node.type) {
            case 'paragraph':
                this._inlines(node, tight ? parent : this._el('p', parent), ctx);
                if (tight) {
                    this._el('span', parent, 'md-tight-break');
                }
                return;
            case 'heading':
                this._inlines(node, this._el(`h${Math.min(Math.max(node.depth || 1, 1), 6)}`, parent, 'md-heading'), ctx);
                return;
            case 'thematicBreak':
                this._el('hr', parent);
                return;
            case 'blockquote':
                this._blocks(node, this._el('blockquote', parent, 'md-blockquote'), ctx);
                return;
            case 'list': {
                // ordered lists show their numbers as written (visible text
                // that can be annotated); bullets are drawn by the <ul>
                const list = this._el(node.ordered ? 'ol' : 'ul', parent, node.ordered ? 'md-ol' : null);
                (node.children || []).forEach(item => {
                    const li = this._el('li', list);
                    if (node.ordered) {
                        this._listNumber(item, this._slot(li, 'span', 'md-list-number'), ctx);
                    }
                    if (typeof item.checked === 'boolean') {
                        this._el('span', li, 'md-task').textContent = item.checked ? '☑ ' : '☐ ';
                    }
                    this._blocks(item, li, ctx, !(node.spread || item.spread));
                    // drop the separator after the last tight paragraph
                    if (li.lastChild?.className === 'md-tight-break') {
                        li.lastChild.remove();
                    }
                });
                return;
            }
            case 'code': {
                const code = this._slot(this._el('pre', parent, 'md-code'), 'code', null);
                this._codeBlock(node, code, ctx);
                return;
            }
            case 'table':
                this._table(node, parent, ctx);
                return;
            default:
                // html, definitions, footnote definitions, anything unknown:
                // the raw text stays visible as written
                this._rawVisible(node, this._slot(parent, 'div', 'md-raw'), ctx);
        }
    }

    _listNumber(item, container, ctx) {
        const range = this._range(item, ctx);
        if (!range) {
            return;
        }
        const head = ctx.chars.slice(range[0], Math.min(range[1], range[0] + 11)).join('');
        const marker = head.match(/^\d{1,9}[.)]/);
        if (!marker) {
            return;
        }
        for (let i = range[0]; i < range[0] + marker[0].length; i++) {
            this._push(ctx, container, i, i + 1, ctx.chars[i]);
        }
    }

    _table(node, parent, ctx) {
        const table = this._el('table', parent, 'md-table');
        const align = Array.isArray(node.align) ? node.align : [];
        (node.children || []).forEach((row, rowIndex) => {
            const section = rowIndex === 0
                ? this._el('thead', table)
                : (table.tBodies[0] || this._el('tbody', table));
            const tr = this._el('tr', section);
            (row.children || []).forEach((cell, cellIndex) => {
                const td = this._el(rowIndex === 0 ? 'th' : 'td', tr);
                if (['left', 'right', 'center'].includes(align[cellIndex])) {
                    td.style.textAlign = align[cellIndex];
                }
                this._inlines(cell, td, ctx);
            });
        });
    }

    _inlines(node, parent, ctx) {
        (node.children || []).forEach(child => this._inline(child, parent, ctx));
    }

    _inline(node, parent, ctx) {
        switch (node.type) {
            case 'text':
                this._text(node, this._slot(parent), ctx, {});
                return;
            case 'inlineCode':
                this._inlineCode(node, this._slot(parent, 'code', null), ctx);
                return;
            case 'strong':
                this._inlines(node, this._el('strong', parent), ctx);
                return;
            case 'emphasis':
                this._inlines(node, this._el('em', parent), ctx);
                return;
            case 'delete':
                this._inlines(node, this._el('del', parent), ctx);
                return;
            case 'link': {
                let link;
                if (MD_SAFE_URL.test(String(node.url || ''))) {
                    link = this._el('a', parent, 'md-link');
                    link.setAttribute('href', node.url);
                    link.setAttribute('target', '_blank');
                    link.setAttribute('rel', 'noopener noreferrer');
                } else {
                    link = this._el('span', parent, 'md-link');
                }
                this._inlines(node, link, ctx);
                return;
            }
            case 'linkReference':
                this._inlines(node, this._el('span', parent, 'md-link'), ctx);
                return;
            case 'break':
                this._break(node, this._slot(parent), ctx);
                return;
            default:
                // inline html, images, footnote calls, anything unknown
                this._rawVisible(node, this._slot(parent), ctx);
        }
    }

    _push(ctx, container, start, end, display) {
        ctx.units.push({ start, end, container, display });
    }

    _rawVisible(node, container, ctx) {
        const range = this._range(node, ctx);
        if (!range) {
            return;
        }
        for (let i = range[0]; i < range[1]; i++) {
            this._push(ctx, container, i, i + 1, ctx.chars[i]);
        }
    }

    _break(node, container, ctx) {
        const range = this._range(node, ctx);
        if (!range) {
            return;
        }
        for (let i = range[1] - 1; i >= range[0]; i--) {
            if (ctx.chars[i] === '\n') {
                this._push(ctx, container, i, i + 1, '\n');
                return;
            }
        }
    }

    _text(node, container, ctx, opts) {
        const range = this._range(node, ctx);
        if (range) {
            this._align(ctx, container, range[0], range[1], String(node.value ?? ''), opts);
        }
    }

    _inlineCode(node, container, ctx) {
        const range = this._range(node, ctx);
        if (!range) {
            return;
        }
        let [start, end] = range;
        while (start < end && ctx.chars[start] === '`') start++;
        while (end > start && ctx.chars[end - 1] === '`') end--;
        // one padding space (or line ending) on both sides is stripped
        // unless the content is only spaces
        const padding = char => char === ' ' || char === '\n';
        const content = ctx.chars.slice(start, end);
        if (content.length >= 2 && padding(content[0]) && padding(content[content.length - 1]) && !content.every(char => char === ' ')) {
            start += 1;
            end -= 1;
        }
        this._align(ctx, container, start, end, String(node.value ?? ''), { code: true });
    }

    _codeBlock(node, container, ctx) {
        const range = this._range(node, ctx);
        if (!range) {
            return;
        }
        let [start, end] = range;
        const firstLine = ctx.chars.slice(start, end).join('').split('\n')[0];
        const fence = firstLine.match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
            // fenced: skip the opening fence line and a closing fence line
            // (same character, at least as long as the opening fence)
            start += Array.from(firstLine).length + 1;
            const body = ctx.chars.slice(start, end).join('');
            const lastBreak = body.lastIndexOf('\n');
            const lastLine = body.slice(lastBreak + 1);
            const closing = lastLine.match(/^\s*(`+|~+)\s*$/);
            if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) {
                end -= Array.from(lastLine).length;
            }
        }
        this._align(ctx, container, Math.min(start, end), end, String(node.value ?? ''), { code: true, block: true });
    }

    // Maps the characters of a parsed value onto the raw range [start, end).
    // Raw characters that do not appear in the value are hidden syntax (line
    // prefixes, indentation, escape backslashes, entity sources). If the value
    // cannot be aligned, the whole range becomes one unit.
    _align(ctx, container, start, end, value, opts) {
        const raw = ctx.chars;
        const target = Array.from(value);
        const units = [];
        let i = start;
        let j = 0;
        let atLineStart = false;

        while (j < target.length) {
            if (i >= end) {
                return this._alignFailed(ctx, container, start, end, value);
            }
            if (opts.block && (i === start || atLineStart)) {
                i = this._skipLinePrefix(raw, i, end, target, j);
                atLineStart = false;
            }
            const char = raw[i];
            if (!opts.code && char === '\\' && i + 1 < end && raw[i + 1] === target[j] && MD_ASCII_PUNCT.test(target[j])) {
                units.push([i, i + 2, target[j]]);
                i += 2;
                j += 1;
                atLineStart = false;
                continue;
            }
            if (!opts.code && char === '&') {
                const decoded = this._entityAt(raw, i, end);
                // autolink literals keep entities undecoded
                const literal = decoded && target.slice(j, j + decoded.length).join('') === raw.slice(i, i + decoded.length).join('');
                if (decoded && !literal) {
                    const decodedChars = Array.from(decoded.value);
                    if (target.slice(j, j + decodedChars.length).join('') === decoded.value) {
                        units.push([i, i + decoded.length, decoded.value]);
                        i += decoded.length;
                        j += decodedChars.length;
                        atLineStart = false;
                        continue;
                    }
                }
            }
            if (char === target[j]) {
                units.push([i, i + 1, char]);
                atLineStart = char === '\n';
                i += 1;
                j += 1;
                continue;
            }
            if (opts.code && char === '\n' && target[j] === ' ') {
                // line endings in inline code are shown as spaces
                units.push([i, i + 1, ' ']);
                i += 1;
                j += 1;
                continue;
            }
            if (/\s/.test(char) || (atLineStart && char === '>')) {
                i += 1;
                continue;
            }
            return this._alignFailed(ctx, container, start, end, value);
        }
        units.forEach(([unitStart, unitEnd, display]) => this._push(ctx, container, unitStart, unitEnd, display));
    }

    // In code blocks a line of the value is the end of its raw line; the
    // rest of the raw line before it is indentation or container prefix.
    // Skipping it here keeps whitespace in the code on its own offsets
    // (greedy alignment would take the indentation for it).
    _skipLinePrefix(raw, i, end, target, j) {
        let lineEnd = i;
        while (lineEnd < end && raw[lineEnd] !== '\n') lineEnd++;
        let targetEnd = j;
        while (targetEnd < target.length && target[targetEnd] !== '\n') targetEnd++;
        const length = targetEnd - j;
        const from = lineEnd - length;
        if (from < i) {
            return i;
        }
        for (let k = i; k < from; k++) {
            if (!/[\s>]/.test(raw[k])) {
                return i;
            }
        }
        for (let k = 0; k < length; k++) {
            if (raw[from + k] !== target[j + k]) {
                return i;
            }
        }
        return from;
    }

    _alignFailed(ctx, container, start, end, value) {
        console.warn('[FactGenie markdown] could not align text node', { start, end, value });
        if (end > start) {
            this._push(ctx, container, start, end, value);
        }
    }

    _entityAt(raw, i, end) {
        const source = raw.slice(i, Math.min(end, i + 40)).join('');
        const match = source.match(MD_ENTITY);
        if (!match) {
            return null;
        }
        let value;
        if (match[3]) {
            value = MdastGfm.decodeNamedCharacterReference(match[3]);
            if (!value) {
                return null;
            }
        } else {
            const code = parseInt(match[1] ?? match[2], match[1] ? 16 : 10);
            value = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
                ? '�'
                : String.fromCodePoint(code);
        }
        return { value, length: Array.from(match[0]).length };
    }
}

// Citation markers as produced by CZD-Avatar: `[^Z7]` or `[Z7]`, one label
// per marker, stacked without spaces for several sources. A bare `[1]` and
// footnotes like `[^1]` are not citations.
const CITATION_MARKER = /\[\^?([A-Z]{1,3}\d+)\]/g;
const CITATION_MARKER_EXACT = /^\[\^?([A-Z]{1,3}\d+)\]$/;

// A pass over the units of any renderer. With display "superscript" each
// marker becomes one unit shown as its label number in a <sup>; adjacent
// markers share one <sup> separated by commas. With "hidden" the markers
// become hidden syntax. Any other display leaves the units unchanged.
// Markers are converted only where all their characters are visible as
// written in one container outside code.
const CitationPass = {
    apply(rendered, display) {
        rendered.citations = [];
        if (display !== 'superscript' && display !== 'hidden') {
            return rendered;
        }
        const groups = this._groups(rendered);
        if (groups.length === 0) {
            return rendered;
        }
        const groupAt = new Map(groups.map(group => [group.start, group]));
        const touched = new Set(groups.map(group => group.container));
        const runs = new Map();
        const runSlot = container => {
            if (!runs.has(container)) {
                const slot = document.createElement('span');
                slot.className = 'citation-run';
                container.append(slot);
                runs.set(container, slot);
            }
            return runs.get(container);
        };

        const units = [];
        let skipUntil = 0;
        rendered.units.forEach(unit => {
            if (unit.start < skipUntil) {
                return;
            }
            const group = groupAt.get(unit.start);
            if (group) {
                skipUntil = group.end;
                rendered.citations.push(...group.markers);
                if (display === 'superscript') {
                    units.push(...this._superscript(group));
                    // text after the superscript goes into a new run
                    runs.delete(group.container);
                }
                return;
            }
            units.push(touched.has(unit.container) ? { ...unit, container: runSlot(unit.container) } : unit);
        });
        rendered.units = units;
        return rendered;
    },

    // Markers whose characters are all visible as written in one container,
    // grouped when they follow each other directly.
    _groups(rendered) {
        const text = rendered.chars.join('');
        const unitAt = new Map(rendered.units.map(unit => [unit.start, unit]));
        const groups = [];
        let cp = 0;
        let last = 0;
        for (const match of text.matchAll(CITATION_MARKER)) {
            cp += Array.from(text.slice(last, match.index)).length;
            last = match.index;
            const start = cp;
            const end = start + Array.from(match[0]).length;
            const container = unitAt.get(start)?.container;
            let visible = Boolean(container) && !(container.nodeType === 1 && container.closest('code, pre'));
            for (let i = start; visible && i < end; i++) {
                const unit = unitAt.get(i);
                visible = unit && unit.end === i + 1 && unit.container === container && unit.display === rendered.chars[i];
            }
            if (!visible) {
                continue;
            }
            const marker = { start, end, label: match[1] };
            const previous = groups[groups.length - 1];
            if (previous && previous.end === start && previous.container === container) {
                previous.markers.push(marker);
                previous.end = end;
            } else {
                groups.push({ start, end, container, markers: [marker] });
            }
        }
        return groups;
    },

    _superscript(group) {
        const sup = document.createElement('sup');
        sup.className = 'citation-group';
        group.container.append(sup);
        return group.markers.map((marker, index) => {
            if (index > 0) {
                sup.append(document.createTextNode(','));
            }
            const citation = document.createElement('span');
            citation.className = 'citation';
            citation.dataset.label = marker.label;
            sup.append(citation);
            return {
                start: marker.start,
                end: marker.end,
                container: citation,
                display: marker.label.match(/\d+$/)[0],
                kind: 'citation',
            };
        });
    },
};

const SpanRenderers = {
    plain: new PlainRenderer(),
    markdown: new MarkdownRenderer(),

    get(format) {
        const renderer = this[format];
        return typeof renderer?.render === 'function' ? renderer : this.plain;
    },

    // Renders with the renderer for `format`, then applies the citation pass
    // (options.citations: superscript | hidden | raw; unset = raw).
    render(rawText, format = 'plain', options = {}) {
        const rendered = this.get(format).render(String(rawText), options);
        return CitationPass.apply(rendered, options.citations);
    },

    // Renders text without atoms (e.g. the Browse "original" box).
    // Returns { root, problems, segments } where problems lists failed unit
    // checks and segments maps the shown text back to raw offsets:
    // [{ element, units: [{ start, end, from, to }] }] where each element is
    // a span with one text node and from/to are offsets into its text.
    renderStatic(rawText, format = 'plain', options = {}) {
        const rendered = this.render(rawText, format, options);
        const segments = [];
        let lastContainer = null;
        let segment = null;
        let text = '';
        const flush = () => {
            if (segment) {
                segment.element.textContent = text;
            }
        };
        rendered.units.forEach(unit => {
            if (unit.display === '\n') {
                flush();
                unit.container.append(document.createElement('br'));
                segment = null;
                return;
            }
            if (unit.container !== lastContainer || !segment) {
                flush();
                segment = { element: document.createElement('span'), units: [] };
                text = '';
                unit.container.append(segment.element);
                segments.push(segment);
            }
            const from = text.length;
            text += unit.display;
            segment.units.push({ start: unit.start, end: unit.end, from, to: text.length });
            lastContainer = unit.container;
        });
        flush();
        return { root: rendered.root, problems: this.checkUnits(rendered), segments };
    },

    // Renderer-level checks: units lie inside the text, are in raw order, do
    // not overlap, and show their raw characters (or the decoded form of an
    // escape or entity, or the label of a citation marker).
    checkUnits(rendered) {
        const problems = [];
        let previousEnd = 0;
        rendered.units.forEach((unit, index) => {
            if (!(unit.start >= 0 && unit.end > unit.start && unit.end <= rendered.chars.length)) {
                problems.push({ check: 1, message: 'unit outside the text', index, start: unit.start, end: unit.end });
            } else if (unit.start < previousEnd) {
                problems.push({ check: 1, message: 'units out of order or overlapping', index, start: unit.start });
            } else {
                const raw = rendered.chars.slice(unit.start, unit.end).join('');
                const citation = unit.kind === 'citation' && CITATION_MARKER_EXACT.test(raw);
                const decoded = citation
                    || raw === `\\${unit.display}`
                    || (raw.startsWith('&') && raw.endsWith(';'))
                    || (raw === '\n' && unit.display === ' ');
                if (unit.display !== raw && !decoded) {
                    problems.push({ check: 2, message: 'unit shows other text than its raw characters', index, start: unit.start, raw, display: unit.display });
                }
            }
            previousEnd = Math.max(previousEnd, unit.end);
        });
        return problems;
    },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SpanRenderers, PlainRenderer, MarkdownRenderer, CitationPass };
}
