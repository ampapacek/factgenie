// Entry point for the vendored Markdown parser bundle (see REBUILD.md).
// Exposes window.MdastGfm.parse(text) -> mdast tree with GFM tables,
// strikethrough, autolink literals and task list items.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

export function parse(text) {
    return fromMarkdown(text, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
    });
}

// Used by the Markdown renderer to align `&name;` entities with the parsed text.
export { decodeNamedCharacterReference } from 'decode-named-character-reference';
