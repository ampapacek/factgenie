# Markdown parser bundle

`factgenie/static/js/lib/mdast-gfm.bundle.js` is built from this directory and
committed. FactGenie has no JS build step at runtime; rebuild only when
upgrading the parser.

It exposes one global, `MdastGfm`:

- `MdastGfm.parse(text)`: mdast tree with GFM (tables, strikethrough,
  autolink literals, task list items, footnotes), with `position.offset` on
  every node. Offsets are UTF-16 units.
- `MdastGfm.decodeNamedCharacterReference(name)`: entity decoder used to align
  `&name;` in the raw text with the parsed text.

Used by the `markdown` renderer in `factgenie/static/js/span-renderers.js`.

## Pinned versions

| Package | Version |
|---|---|
| mdast-util-from-markdown | 2.1.0 |
| micromark-extension-gfm | 3.0.0 |
| mdast-util-gfm | 3.1.0 |
| decode-named-character-reference | 1.3.0 |
| esbuild | 0.28.2 |

`package-lock.json` pins the transitive dependencies.

## Rebuild

```bash
cd tools/mdast-bundle
npm ci
npm run build    # writes ../../factgenie/static/js/lib/mdast-gfm.bundle.js
```

To upgrade, change the versions in `package.json`, run `npm install`, rebuild,
update the table above, and rerun the checks:

```bash
cd tests/js && npm ci && cd ../..
node tests/js/verify_markdown_mapping.js <factgenie-dir>
node tests/js/verify_markdown_annotations.js <factgenie-dir>
```

`node_modules/` is not committed.
