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
// The annotator builds atoms (`.annotatable` spans) from the units and has no
// knowledge of the format.

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

const SpanRenderers = {
    plain: new PlainRenderer(),

    get(format) {
        const renderer = this[format];
        return typeof renderer?.render === 'function' ? renderer : this.plain;
    },
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SpanRenderers, PlainRenderer };
}
