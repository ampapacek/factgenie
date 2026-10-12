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
                const list = this._el(node.ordered ? 'ol' : 'ul', parent);
                if (node.ordered && Number.isInteger(node.start) && node.start !== 1) {
                    list.setAttribute('start', String(node.start));
                }
                (node.children || []).forEach(item => {
                    const li = this._el('li', list);
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
        this._align(ctx, container, start, end, String(node.value ?? ''), { code: true });
    }

    _codeBlock(node, container, ctx) {
        const range = this._range(node, ctx);
        if (!range) {
            return;
        }
        let [start, end] = range;
        const firstLine = ctx.chars.slice(start, end).join('').split('\n')[0];
        if (/^\s*(`{3,}|~{3,})/.test(firstLine)) {
            // fenced: skip the opening fence line and a closing fence line
            start += Array.from(firstLine).length + 1;
            const body = ctx.chars.slice(start, end).join('');
            const lastBreak = body.lastIndexOf('\n');
            const lastLine = body.slice(lastBreak + 1);
            if (/^\s*(`{3,}|~{3,})\s*$/.test(lastLine)) {
                end -= Array.from(lastLine).length;
            }
        }
        this._align(ctx, container, Math.min(start, end), end, String(node.value ?? ''), { code: true });
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

const SpanRenderers = {
    plain: new PlainRenderer(),
    markdown: new MarkdownRenderer(),

    get(format) {
        const renderer = this[format];
        return typeof renderer?.render === 'function' ? renderer : this.plain;
    },

    // Renders text without atoms (e.g. the Browse "original" box).
    // Returns { root, problems } where problems lists failed unit checks.
    renderStatic(rawText, format = 'plain') {
        const rendered = this.get(format).render(String(rawText));
        let lastContainer = null;
        let textNode = null;
        rendered.units.forEach(unit => {
            if (unit.display === '\n') {
                unit.container.append(document.createElement('br'));
                textNode = null;
                return;
            }
            if (unit.container !== lastContainer || !textNode) {
                textNode = document.createTextNode('');
                unit.container.append(textNode);
            }
            textNode.data += unit.display;
            lastContainer = unit.container;
        });
        return { root: rendered.root, problems: this.checkUnits(rendered) };
    },

    // Renderer-level checks: units lie inside the text, are in raw order, do
    // not overlap, and show their raw characters (or the decoded form of an
    // escape or entity).
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
                const decoded = raw === `\\${unit.display}`
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
    module.exports = { SpanRenderers, PlainRenderer, MarkdownRenderer };
}
