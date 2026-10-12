class SpanAnnotator {
    constructor() {
        this.documents = new Map();
        this.currentType = 0;
        this.annotationTypes = [];
        this.isSelecting = false;
        this.startSpan = null;
        this.throttledFindClosestSpan = this._throttle(
            (objectId, x, y) => this._findClosestSpan(objectId, x, y),
            100
        );
        this.eraserPreviewActive = false;
        this.rightClickPreviewActive = false;
        this.eventListeners = new Map();
        this.history = new Map(); // Map of document ID -> array of history states
        this.currentHistoryIndex = new Map(); // Map of document ID -> current history index
        this.annotateReason = false; // Whether to collect reasons for annotations
        this.pendingAnnotation = null; // Store annotation data while waiting for reason input
        this.suppressClickOnce = false;
    }

    init(granularity, overlapAllowed, annotationTypes, annotateReason = false) {
        this.granularity = granularity;
        this.overlapAllowed = overlapAllowed;
        this.annotationTypes = annotationTypes;
        this.annotateReason = annotateReason;
        return this;
    }

    setCurrentAnnotationType(type) {
        // make sure that type is integer
        this.currentType = parseInt(type);

        // Get all annotatable paragraph boxes
        const paragraphBoxes = $('.annotate-box');
        const paragraphs = $('.annotatable-paragraph');

        if (type === -2) {
            // Select mode - use text cursor
            paragraphs.addClass('select-mode-enabled');
            paragraphBoxes.css('cursor', 'text');
        } else if (type === -1) {
            paragraphs.removeClass('select-mode-enabled');
            // Eraser mode - use eraser cursor
            paragraphBoxes.css('cursor', 'pointer');
        } else if (type != null) {
            paragraphs.removeClass('select-mode-enabled');
            // Annotation mode - use colored brush cursor based on category
            const color = this.annotationTypes[type]?.color;
            if (color) {
                // Create colored cursor style
                paragraphBoxes.css({
                    'cursor': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='25' height='25' viewBox='0 0 328.862 328.862'%3E%3Cg%3E%3Cpath fill='${encodeURIComponent(color)}' d='M251.217,195.25L56.286,69.063c-4.609-2.984-10.48-3.21-15.308-0.591c-4.826,2.62-7.835,7.667-7.844,13.158l-0.375,232.206c-0.01,6.371,4.006,12.054,10.016,14.172c1.633,0.576,3.315,0.854,4.981,0.854c4.464,0,8.802-1.997,11.704-5.617l71.455-89.101l113.645-11.378c6.34-0.635,11.587-5.206,13.085-11.398C259.143,205.176,256.566,198.712,251.217,195.25z'/%3E%3C/g%3E%3C/svg%3E") 7 7, pointer`
                });
            }
        }
    }

    addEventListener(eventName, callback) {
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push(callback);
    }

    clearEventListeners(eventName = null) {
        if (eventName === null) {
            this.eventListeners.clear();
            return;
        }

        this.eventListeners.set(eventName, []);
    }

    _addToHistory(objectId) {
        const doc = this.documents.get(objectId);
        if (!this.history.has(objectId)) {
            this.history.set(objectId, []);
            this.currentHistoryIndex.set(objectId, -1);
        }

        // Remove any future history after current index
        const currentIndex = this.currentHistoryIndex.get(objectId);
        this.history.get(objectId).splice(currentIndex + 1);

        // Add new state
        this.history.get(objectId).push({
            annotations: JSON.parse(JSON.stringify(doc.annotations)) // Deep copy
        });
        this.currentHistoryIndex.set(objectId, this.currentHistoryIndex.get(objectId) + 1);
    }

    undo(objectId) {
        if (!this.history.has(objectId)) return;

        const currentIndex = this.currentHistoryIndex.get(objectId);
        if (currentIndex < 0) return;

        // Restore previous state
        const previousState = this.history.get(objectId)[currentIndex];
        const doc = this.documents.get(objectId);
        doc.annotations = JSON.parse(JSON.stringify(previousState.annotations));

        // Update index
        this.currentHistoryIndex.set(objectId, currentIndex - 1);

        // Rerender
        this._renderAnnotations(objectId);
        this.emit('annotationUndone', { objectId });
    }

    emit(eventName, data) {
        if (this.eventListeners.has(eventName)) {
            this.eventListeners.get(eventName).forEach(callback => callback(data));
        }
    }

    // options.format selects the renderer from SpanRenderers (default: plain);
    // options.citations is the citation display (see CitationPass)
    addDocument(objectId, htmlObject, dynamic = false, rawText = null, options = {}) {
        const $element = $(htmlObject);
        const text = rawText ?? $element.text();
        this.documents.set(objectId, {
            element: $element,
            text: text,
            annotations: [],
            readOnly: false,
            dynamic: Boolean(dynamic)
        });
        this._renderDocument(objectId, options);

        if (dynamic) {
            this._attachEventHandlers(objectId);
        }
    }

    // Renders a document again with other renderer options (e.g. a view
    // switch). Annotations and the undo history are raw offsets, so both
    // are kept.
    renderDocument(objectId, options = {}) {
        if (!this.documents.has(objectId)) {
            return;
        }
        this._renderDocument(objectId, options);
        this._renderAnnotations(objectId);
    }

    _renderDocument(objectId, options) {
        const doc = this.documents.get(objectId);
        const format = options.format || 'plain';
        const rendered = SpanRenderers.render(doc.text, format, options);
        doc.splitCitations = Boolean(options.splitCitations);
        this._createSpans(doc.text, rendered, doc.splitCitations);
        const check = this._checkDocument(rendered);
        if (!check.ok) {
            console.warn(`[FactGenie spans] Rendering checks failed for ${objectId} (${format}):`, check.problems);
        }

        // native append: moving a large fragment through jQuery is slow
        doc.element.empty();
        doc.element[0]?.appendChild(rendered.root);

        doc.format = format;
        doc.units = rendered.units;
        // plain documents without citations keep the original highlighting
        doc.exactPlain = format === 'plain' && rendered.citations.length === 0;
        doc.check = check;
    }

    // A read-only document shows its annotations but cannot be annotated.
    setDocumentReadOnly(objectId, readOnly) {
        const doc = this.documents.get(objectId);
        if (!doc) {
            return;
        }
        doc.readOnly = Boolean(readOnly);
        doc.element.parent().toggleClass('annotate-box-readonly', doc.readOnly);
        // the marker tooltips mention the actions
        this._renderAnnotations(objectId);
    }

    getDocumentText(objectId) {
        return this.documents.get(objectId)?.text ?? null;
    }

    // used to add annotations externally
    addAnnotations(objectId, annotations) {
        const doc = this.documents.get(objectId);
        doc.annotations = this._sanitizeAnnotations(objectId, annotations);
        this._renderAnnotations(objectId);
    }

    getAnnotations(objectId) {
        return this.documents.get(objectId)?.annotations || [];
    }

    // Result of the runtime checks: { ok, problems, hiddenAnnotations }.
    getDocumentCheck(objectId) {
        return this.documents.get(objectId)?.check || null;
    }

    // Runtime checks 1-3 on the atoms of a rendered document:
    // 1. atoms are in raw order, do not overlap and lie inside the text;
    // 2. each atom's data-content equals the raw slice at its index;
    // 3. every visible character is inside exactly one atom (or is whitespace
    //    between atoms), and the atoms show the units in raw order.
    _checkDocument(rendered) {
        const chars = rendered.chars;
        const problems = SpanRenderers.checkUnits(rendered);
        const atoms = [];
        rendered.root.querySelectorAll('.annotatable').forEach(span => {
            const start = Number(span.dataset.index);
            const content = String(span.dataset.content ?? '');
            const last = atoms[atoms.length - 1];
            if (last && last.start === start) {
                if (last.content !== content) {
                    problems.push({ check: 2, message: 'fragments of one atom differ', start });
                }
                return;
            }
            atoms.push({ start, end: start + this._stringLength(content), content });
        });

        let previousEnd = 0;
        atoms.forEach(atom => {
            if (!Number.isInteger(atom.start) || atom.start < previousEnd || atom.end > chars.length) {
                problems.push({ check: 1, message: 'atom out of order, overlapping or outside the text', start: atom.start, content: atom.content });
            }
            previousEnd = Math.max(previousEnd, atom.end);
            if (chars.slice(atom.start, atom.end).join('') !== atom.content) {
                problems.push({ check: 2, message: 'data-content differs from the raw text', start: atom.start, content: atom.content });
            }
        });

        let atomIndex = 0;
        rendered.units.forEach(unit => {
            while (atomIndex < atoms.length && atoms[atomIndex].end <= unit.start) {
                atomIndex++;
            }
            const atom = atoms[atomIndex];
            const inAtom = atom && atom.start <= unit.start && unit.end <= atom.end;
            const isWhitespace = /^\s+$/.test(chars.slice(unit.start, unit.end).join(''));
            if (!inAtom && !isWhitespace) {
                problems.push({ check: 3, message: 'visible character outside atoms', start: unit.start, display: unit.display });
            }
        });

        const expected = rendered.units.map(unit => unit.display === '\n' ? '' : unit.display).join('');
        let shown = '';
        const walker = document.createTreeWalker(rendered.root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            if (walker.currentNode.parentElement?.closest('.annotatable, .whitespace')) {
                shown += walker.currentNode.data;
            }
        }
        if (shown !== expected) {
            problems.push({ check: 3, message: 'shown text differs from the rendered units' });
        }

        return { ok: problems.length === 0, problems, hiddenAnnotations: [] };
    }

    // Annotations shown on an atom. Plain documents keep the original rule
    // (the atom starts inside the annotation); other renderings highlight every
    // atom whose raw range overlaps the annotation.
    _annotationsForSpan(doc, $span, annotations = doc.annotations) {
        const position = parseInt($span.data('index'));
        if (doc.exactPlain) {
            return annotations.filter(a =>
                position >= a.start && position < a.start + this._stringLength(a.text));
        }
        const end = position + Math.max(this._stringLength(String($span.data('content') ?? '')), 1);
        return annotations.filter(a =>
            a.start < end && a.start + this._stringLength(a.text) > position);
    }

    _stringLength(text) {
        return Array.from(String(text)).length;
    }

    _annotationTypeFor(ann) {
        const typeIndex = parseInt(ann?.type, 10);
        if (Number.isNaN(typeIndex) || typeIndex < 0) {
            return null;
        }
        return this.annotationTypes?.[typeIndex] || null;
    }

    _sanitizeAnnotations(objectId, annotations) {
        if (!Array.isArray(annotations)) {
            return [];
        }

        return annotations.filter((ann, index) => {
            const annotationType = this._annotationTypeFor(ann);
            if (annotationType) {
                return true;
            }
            console.warn(
                `[FactGenie spans] Skipping annotation with unknown type for ${objectId}:`,
                {
                    annotationIndex: index,
                    type: ann?.type,
                    text: ann?.text,
                    start: ann?.start,
                    availableTypes: this.annotationTypes?.map((item, idx) => ({
                        index: idx,
                        name: item?.name || "",
                    })) || [],
                }
            );
            return false;
        });
    }

    _appendUnitDisplays(element, units) {
        units.forEach(unit => {
            if (unit.display === '\n') {
                element.append(document.createElement('br'));
            } else {
                element.append(document.createTextNode(unit.display));
            }
        });
    }

    _groupUnitsByContainer(units) {
        const groups = [];
        units.forEach(unit => {
            const last = groups[groups.length - 1];
            if (last && last.container === unit.container) {
                last.units.push(unit);
            } else {
                groups.push({ container: unit.container, units: [unit] });
            }
        });
        return groups;
    }

    // The words-mode tokens of a raw text as [{ part, whitespace }]: the raw
    // whitespace-delimited tokens, and with splitCitations also split before
    // and after each citation marker (`budov.` | `[^Z7]` | `[^Z10]`), so a
    // single citation can be annotated. The split depends only on the raw
    // text, so the Rendered and Raw views get the same atoms.
    _wordTokens(text, splitCitations = false) {
        const parts = text.split(/(\s+)/);
        const tokens = [];
        for (let i = 0; i < parts.length; i += 2) {
            const part = parts[i];
            const whitespace = i < parts.length - 1 ? parts[i + 1] : '';
            const pieces = [];
            if (splitCitations) {
                let last = 0;
                for (const match of part.matchAll(CITATION_MARKER)) {
                    if (match.index > last) {
                        pieces.push(part.slice(last, match.index));
                    }
                    pieces.push(match[0]);
                    last = match.index + match[0].length;
                }
                if (last > 0 && last < part.length) {
                    pieces.push(part.slice(last));
                }
            }
            if (pieces.length === 0) {
                tokens.push({ part, whitespace });
                continue;
            }
            pieces.forEach((piece, index) => {
                tokens.push({ part: piece, whitespace: index === pieces.length - 1 ? whitespace : '' });
            });
        }
        return tokens;
    }

    // Builds the atoms (`.annotatable` spans) for the configured granularity
    // inside the containers of the renderer output.
    _createSpans(text, rendered, splitCitations = false) {
        if (this.granularity !== 'words') {
            rendered.units.forEach(unit => {
                const span = document.createElement('span');
                span.className = 'annotatable';
                span.dataset.index = String(unit.start);
                span.dataset.content = rendered.chars.slice(unit.start, unit.end).join('');
                this._appendUnitDisplays(span, [unit]);
                unit.container.append(span);
            });
            return;
        }

        const unitAt = new Array(rendered.chars.length).fill(null);
        rendered.units.forEach(unit => {
            unitAt[unit.start] = unit;
        });
        const unitsIn = (start, end) => unitAt.slice(start, end).filter(unit => unit !== null);

        // Atoms are the raw tokens (see _wordTokens). The visible characters
        // of a token may land in several containers; each container gets its
        // own fragment sharing the token's data-index and data-content.
        const tokens = this._wordTokens(text, splitCitations);
        let currentIndex = 0;
        let lastContainer = rendered.root;

        tokens.forEach(({ part, whitespace }, tokenIndex) => {
            const partEnd = currentIndex + this._stringLength(part);
            const wordEnd = partEnd + this._stringLength(whitespace);
            const wordGroups = this._groupUnitsByContainer(unitsIn(currentIndex, partEnd));
            const whitespaceGroups = this._groupUnitsByContainer(unitsIn(partEnd, wordEnd));

            if (wordGroups.length === 0 && part === '' && (whitespaceGroups.length > 0 || tokenIndex > 0 || tokens.length === 1)) {
                // keep the empty token atom (e.g. before leading whitespace)
                wordGroups.push({ container: whitespaceGroups[0]?.container ?? lastContainer, units: [] });
            }

            let lastSpan = null;
            wordGroups.forEach(group => {
                const span = document.createElement('span');
                span.className = 'annotatable';
                span.dataset.index = String(currentIndex);
                span.dataset.content = String(part);
                span.dataset.whitespace = whitespace;
                if (whitespace === '' && tokenIndex < tokens.length - 1) {
                    // the next token follows directly (split at a citation)
                    span.dataset.joined = '';
                }
                span.append(document.createTextNode(group.units.map(unit => unit.display).join('')));
                group.container.append(span);
                lastSpan = span;
                lastContainer = group.container;
            });

            if (lastSpan) {
                const whitespaceSpan = document.createElement('span');
                whitespaceSpan.className = 'whitespace';
                lastSpan.append(whitespaceSpan);
                if (whitespaceGroups[0]?.container === lastContainer) {
                    this._appendUnitDisplays(whitespaceSpan, whitespaceGroups.shift().units);
                }
            }
            // visible whitespace outside the token's last container
            whitespaceGroups.forEach(group => {
                const whitespaceSpan = document.createElement('span');
                whitespaceSpan.className = 'whitespace';
                this._appendUnitDisplays(whitespaceSpan, group.units);
                group.container.append(whitespaceSpan);
                lastContainer = group.container;
            });

            currentIndex = wordEnd;
        });
    }

    _attachEventHandlers(objectId) {
        const doc = this.documents.get(objectId);
        const $elementPar = doc.element;

        // Change element to parent's div
        const $element = $elementPar.parent();

        $element.on('selectstart', (e) => {
            // Only prevent selection when not in select mode
            if (this.currentType !== -2) {
                e.preventDefault();
            }
        });

        $element.on('contextmenu', (e) => {
            e.preventDefault();
        });

        $element.on('mousedown', (e) => {
            // Ctrl/Cmd+click on a citation shows its source instead
            const $citation = $(e.target).closest('.citation');
            if ((e.ctrlKey || e.metaKey) && $citation.length > 0) {
                e.preventDefault();
                this.emit('citationClicked', { objectId, label: String($citation.data('label')) });
                return;
            }
            // Skip annotation logic in select mode and read-only documents
            if (this.currentType === -2 || this.documents.get(objectId).readOnly) {
                return;
            }
            // a marker stands in for annotations with no visible character:
            // right-click or the eraser removes them, a click edits the reason
            const $marker = $(e.target).closest('.annotation-marker');
            if ($marker.length > 0) {
                if (e.button === 2 || this.currentType === -1) {
                    this._removeAnnotations(objectId, $marker.data('annotations') || []);
                }
                return;
            }

            if (e.button === 2) { // Right click
                const span = this._findClosestSpan(objectId, e.clientX, e.clientY);
                if (span) {
                    this._removeAnnotation(objectId, span);
                }
                return;
            }
            this.isSelecting = true;
            this.startSpan = this._findClosestSpan(objectId, e.clientX, e.clientY);
        });

        $element.on('click', (e) => {
            if (this.isSelecting || this.currentType === -2 || this.currentType === -1) {
                return;
            }
            if (this.suppressClickOnce) {
                this.suppressClickOnce = false;
                return;
            }
            if (!this.annotateReason || this.documents.get(objectId).readOnly || e.ctrlKey || e.metaKey) {
                return;
            }
            const doc = this.documents.get(objectId);
            const $marker = $(e.target).closest('.annotation-marker');
            const $target = $(e.target).closest('.annotatable');
            if ($marker.length === 0 && $target.length === 0) {
                return;
            }
            const matching = $marker.length > 0
                ? ($marker.data('annotations') || [])
                : this._annotationsForSpan(doc, $target);
            if (matching.length === 0) {
                return;
            }
            const annotation = matching[matching.length - 1];
            if (annotation.type !== this.currentType) {
                return;
            }
            this.pendingAnnotation = { objectId, annotation, isEdit: true };
            this._showReasonDialog(annotation);
        });

        $element.on('mousemove', (e) => {
            if (!this.isSelecting && $(e.target).closest('.annotation-marker').length > 0) {
                // over a marker the eraser targets the marker, not the closest atom
                this._clearEraserPreview(objectId);
                return;
            }
            if (e.buttons === 2) { // Right button pressed
                if (this.documents.get(objectId).readOnly) {
                    return;
                }
                const closestSpan = this._findClosestSpan(objectId, e.clientX, e.clientY);
                if (closestSpan) {
                    this._previewEraserEffect(objectId, closestSpan);
                    this.rightClickPreviewActive = true;
                }
                return;
            }
            if (this.isSelecting) {
                const closestSpan = this.throttledFindClosestSpan(objectId, e.clientX, e.clientY);
                if (closestSpan) {
                    this._updateHighlight(objectId, this.startSpan, closestSpan);
                }
            } else if (this.currentType === -1 && !this.documents.get(objectId).readOnly) {
                const closestSpan = this._findClosestSpan(objectId, e.clientX, e.clientY);
                if (closestSpan) {
                    this._previewEraserEffect(objectId, closestSpan);
                }
            }
        });


        $element.on('mouseup', (e) => {
            if (!this.isSelecting) return;
            this.isSelecting = false;
            const endSpan = this._findClosestSpan(objectId, e.clientX, e.clientY);

            if (this.startSpan && endSpan) {
                if (this.currentType === -1) {
                    this._removeAnnotation(objectId, endSpan);
                } else {
                    if (this.annotateReason && this.startSpan.is(endSpan)) {
                        const doc = this.documents.get(objectId);
                        const matching = this._annotationsForSpan(doc, endSpan);
                        if (matching.length > 0) {
                            const annotation = matching[matching.length - 1];
                            if (annotation.type === this.currentType) {
                                this.pendingAnnotation = { objectId, annotation, isEdit: true };
                                this._showReasonDialog(annotation);
                                this.suppressClickOnce = true;
                                return;
                            }
                        }
                    }
                    this._createAnnotation(objectId, this.startSpan, endSpan);
                }
            }
        });

        // Handle mouse leaving the element
        $element.on('mouseleave', () => {
            if (this.isSelecting) {
                this.isSelecting = false;
                this._renderAnnotations(objectId);
            }
            if (this.eraserPreviewActive) {
                this._clearEraserPreview(objectId);
            }
            if (this.rightClickPreviewActive) {
                this._clearEraserPreview(objectId);
                this.rightClickPreviewActive = false;
            }
        });
    }

    _previewEraserEffect(objectId, $span) {
        const doc = this.documents.get(objectId);
        this.eraserPreviewActive = true;

        // Clear previous preview
        this._clearEraserPreview(objectId);

        // Find annotations that would be removed
        const affectedAnnotations = this._annotationsForSpan(doc, $span);

        // Highlight spans for each affected annotation
        if (affectedAnnotations.length > 0) {
            $('.annotatable', doc.element).each((_, span) => {
                const $other = $(span);
                if (this._annotationsForSpan(doc, $other, affectedAnnotations).length > 0) {
                    // make the tokens more transparent by applying a filter
                    $other.css('filter', 'opacity(0.5)');
                }
            });
        }
    }

    _clearEraserPreview(objectId) {
        if (!this.eraserPreviewActive) return;

        const doc = this.documents.get(objectId);
        // remove the filter from all spans
        $('.annotatable', doc.element).css('filter', '');
        this.eraserPreviewActive = false;
    }

    _throttle(func, limit) {
        let lastResult;
        let lastRun;

        return function (...args) {
            if (!lastRun || Date.now() - lastRun >= limit) {
                lastResult = func.apply(this, args);
                lastRun = Date.now();
            }
            return lastResult;
        }
    }

    _hasExistingAnnotations(doc, startIdx, endIdx) {
        return doc.annotations.some(ann => {
            // Check if any part of the new annotation overlaps with existing ones
            const annotationEnd = ann.start + this._stringLength(ann.text) - 1;
            return (startIdx <= annotationEnd && endIdx >= ann.start);
        });
    }

    _findClosestSpan(objectId, x, y) {
        const doc = this.documents.get(objectId);
        let closestSpan = null;
        let minDistance = Infinity;

        // if we already are over a span, return that
        const currentSpan = $(document.elementFromPoint(x, y)).closest('.annotatable');
        if (currentSpan.length > 0) {
            return currentSpan;
        }


        $('.annotatable', doc.element).each((_, span) => {
            const $span = $(span);
            const rect = span.getBoundingClientRect();
            // hidden and zero-size atoms cannot be targeted
            if (rect.width === 0 || span.getClientRects().length === 0) {
                return;
            }
            const left = rect.left;
            const top = rect.top;
            const right = left + $span.width();
            const bottom = top + $span.height();

            const dx = Math.abs((left + right) / 2 - x);
            const dy = Math.abs((top + bottom) / 2 - y);
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < minDistance) {
                minDistance = distance;
                closestSpan = $span;
            }
        });

        return closestSpan;
    }

    _updateHighlight(objectId, $start, $end) {
        const doc = this.documents.get(objectId);
        $('.annotatable', doc.element).css('background', '');

        const startIdx = parseInt($start.data('index'));
        const endIdx = parseInt($end.data('index'));
        const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];

        $('.annotatable', doc.element).each((_, span) => {
            const $span = $(span);
            const idx = parseInt($span.data('index'));
            if (idx >= min && idx <= max) {
                const color = this.annotationTypes[this.currentType]?.color;
                $span.css({
                    'background': `linear-gradient(0deg, ${color} 2px, transparent 2px)`,
                    'background-position': '0 100%',
                    'padding-bottom': '3px'
                });
            }
        });
    }

    _createAnnotation(objectId, $start, $end) {
        this._addToHistory(objectId);

        const doc = this.documents.get(objectId);
        const startIdx = parseInt($start.data('index'));
        const endIdx = parseInt($end.data('index')); // Remove the content length adjustment
        const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];

        // Get the actual end position by adding length of the last token
        const $last = startIdx > endIdx ? $start : $end;
        const maxWithLength = max + this._stringLength($last.data('content')) - 1;


        // Check for exactly matching annotations
        const isExisting = doc.annotations.some(ann =>
            ann.start === min &&
            ann.start + this._stringLength(ann.text) === maxWithLength + 1 &&
            ann.type === this.currentType
        );

        // Check for overlap if not allowed
        if ((!this.overlapAllowed && this._hasExistingAnnotations(doc, min, maxWithLength)) || isExisting) {
            this._renderAnnotations(objectId);
            return;
        }

        const text = Array.from(doc.text).slice(min, maxWithLength + 1).join('');
        const id = Math.random().toString(36).substring(2, 10);

        const annotation = {
            type: this.currentType,
            text: text,
            start: min,
            id: id
        };

        // If reason collection is enabled, show reason input dialog
        if (this.annotateReason) {
            this.pendingAnnotation = { objectId, annotation };
            this._showReasonDialog(annotation);
        } else {
            // Add annotation directly without reason
            doc.annotations.push(annotation);
            this._renderAnnotations(objectId);
            this.emit('annotationAdded', { objectId, annotation });
        }
    }

    // The annotated text as the current view shows it (hidden syntax left
    // out, citations as superscript numbers); the stored text stays raw.
    _visibleText(objectId, annotation) {
        const doc = this.documents.get(objectId);
        const start = annotation.start;
        const end = start + this._stringLength(annotation.text);
        const superscript = digits => Array.from(digits, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)] ?? d).join('');
        let text = '';
        let previous = null;
        (doc?.units || []).forEach(unit => {
            if (unit.start < start || unit.end > end) {
                return;
            }
            if (unit.kind === 'citation') {
                const stacked = previous?.kind === 'citation' && previous.end === unit.start;
                text += (stacked ? '˒' : '') + superscript(unit.display);
            } else {
                text += unit.display === '\n' ? ' ' : unit.display;
            }
            previous = unit;
        });
        return text.trim() ? text.trim() : annotation.text;
    }

    _showReasonDialog(annotation) {
        const shownText = $('<div>').text(this._visibleText(this.pendingAnnotation?.objectId, annotation)).html();
        // Create modal dialog for reason input
        const modalHtml = `
            <div class="modal fade" id="annotation-reason-modal" tabindex="-1" aria-hidden="true">
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Annotation reason</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                        </div>
                        <div class="modal-body">
                            <p>Please provide a reason for annotating "<strong>${shownText}</strong>":</p>
                            <div id="annotation-reason-presets" class="d-flex flex-wrap gap-2 mb-2"></div>
                            <textarea class="form-control" id="annotation-reason-input" rows="3" placeholder="Enter your reason..."></textarea>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" onclick="spanAnnotator._handleReasonCancel()">Cancel</button>
                            <button type="button" class="btn btn-secondary" id="annotation-reason-skip" data-bs-dismiss="modal" onclick="spanAnnotator._handleReasonSubmit('')">Skip</button>
                            <button type="button" class="btn btn-primary" onclick="spanAnnotator._handleReasonSubmit(document.getElementById('annotation-reason-input').value)">Submit</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Remove existing modal if any
        $('#annotation-reason-modal').remove();

        // Add modal to body
        $('body').append(modalHtml);
        const skipBtn = document.getElementById('annotation-reason-skip');
        if (skipBtn) {
            skipBtn.disabled = !!this.pendingAnnotation?.isEdit;
        }

        const presets = this._normalizeReasonPresets(this.annotationTypes?.[annotation.type]?.reason_presets);
        let initialReason = "";
        if (this.pendingAnnotation?.isEdit) {
            initialReason = String(annotation.reason || annotation.note || "").trim();
        }
        const { presetSet, remainingText } = this._splitReasonPresets(initialReason, presets);
        if (this.pendingAnnotation) {
            this.pendingAnnotation.selectedPresets = presetSet;
        }
        const presetContainer = $('#annotation-reason-presets');
        if (presetContainer.length && presets.length > 0) {
            presets.forEach((preset) => {
                const label = preset.label;
                if (!label) {
                    return;
                }
                const button = $('<button type="button" class="btn btn-outline-secondary btn-sm"></button>');
                button.text(label);
                button.on('click', function () {
                    const presetSet = spanAnnotator.pendingAnnotation?.selectedPresets;
                    if (!presetSet) {
                        return;
                    }
                    const oppositeLabels = Array.isArray(preset.oppositeLabels)
                        ? preset.oppositeLabels
                        : [];
                    const isActive = presetSet.has(label);
                    if (isActive) {
                        presetSet.delete(label);
                    } else {
                        presetSet.add(label);
                        oppositeLabels.forEach((oppositeLabel) => {
                            if (oppositeLabel && presetSet.has(oppositeLabel)) {
                                presetSet.delete(oppositeLabel);
                            }
                        });
                    }
                    $(this).toggleClass("active", !isActive);
                    if (oppositeLabels.length > 0) {
                        $('#annotation-reason-presets button').each(function () {
                            const buttonLabel = $(this).text().trim();
                            if (oppositeLabels.includes(buttonLabel)) {
                                $(this).toggleClass("active", presetSet.has(buttonLabel));
                            }
                        });
                    }
                    $('#annotation-reason-input').focus();
                });
                presetContainer.append(button);
            });
        } else {
            presetContainer.remove();
        }

        $('#annotation-reason-input').val(remainingText);

        // Show modal
        const modal = new bootstrap.Modal(document.getElementById('annotation-reason-modal'));
        modal.show();

        $('#annotation-reason-modal').on('hidden.bs.modal', function () {
            if (spanAnnotator.pendingAnnotation) {
                spanAnnotator._handleReasonCancel();
            }
            spanAnnotator._restoreBodyScroll();
        });

        // Focus on text area
        $('#annotation-reason-modal').on('shown.bs.modal', function () {
            const presetSet = spanAnnotator.pendingAnnotation?.selectedPresets || new Set();
            $('#annotation-reason-presets button').each(function () {
                const label = $(this).text().trim();
                $(this).toggleClass("active", presetSet.has(label));
            });
            $('#annotation-reason-input').focus();
        });

        // Handle Enter key to submit
        $('#annotation-reason-input').on('keydown', function (e) {
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                spanAnnotator._handleReasonSubmit($(this).val());
            }
        });
    }

    _handleReasonSubmit(reason) {
        if (!this.pendingAnnotation) return;

        const { objectId, annotation, isEdit } = this.pendingAnnotation;
        const doc = this.documents.get(objectId);
        const presetSet = this.pendingAnnotation.selectedPresets || new Set();
        const presetText = Array.from(presetSet).map((label) => `[[${label}]]`).join(" ").trim();

        // Add reason to annotation if provided
        const reasonText = String(reason || "").trim();
        if (presetText || reasonText) {
            annotation.reason = presetText
                ? (reasonText ? `${presetText} ${reasonText}` : presetText)
                : reasonText;
        }

        if (!isEdit) {
            // Add annotation to document
            doc.annotations.push(annotation);
            this.emit('annotationAdded', { objectId, annotation });
        }
        this._renderAnnotations(objectId);

        // Clean up
        this.pendingAnnotation = null;

        // Hide modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('annotation-reason-modal'));
        if (modal) {
            modal.hide();
        }
        $('#annotation-reason-modal').remove();
        this._restoreBodyScroll();
    }

    _handleReasonCancel() {
        const objectId = this.pendingAnnotation?.objectId;
        this.pendingAnnotation = null;

        if (objectId) {
            this._renderAnnotations(objectId);
        }

        const modalElement = document.getElementById('annotation-reason-modal');
        if (modalElement) {
            const modal = bootstrap.Modal.getOrCreateInstance(modalElement);
            modal.hide();
            $('#annotation-reason-modal').remove();
            this._restoreBodyScroll();
        }
    }

    _splitReasonPresets(reason, presets) {
        let remainingReason = String(reason || "");
        const presetSet = new Set();
        const presetList = Array.isArray(presets) ? presets : [];
        const presetLabels = presetList.map((preset) => preset.label);

        remainingReason = remainingReason.replace(/\[\[([^[\]]+)\]\]/g, (_, rawLabel) => {
            const label = String(rawLabel || "").trim();
            if (presetLabels.includes(label)) {
                presetSet.add(label);
                return " ";
            }
            return _;
        });

        const tokens = remainingReason.split(/\s+/).filter((token) => token.length > 0);
        const remaining = [];
        tokens.forEach((token) => {
            if (presetLabels.includes(token)) {
                presetSet.add(token);
            } else {
                remaining.push(token);
            }
        });

        return { presetSet, remainingText: remaining.join(" ") };
    }

    _formatReasonForDisplay(reason) {
        return String(reason || "")
            .replace(/\[\[([^[\]]+)\]\]/g, (_, label) => String(label || "").trim())
            .replace(/\s+/g, " ")
            .trim();
    }

    _normalizeReasonPresets(presets) {
        if (!Array.isArray(presets)) {
            return [];
        }

        return presets
            .map((preset) => {
                if (typeof preset === "string") {
                    const label = preset.trim();
                    if (!label) {
                        return null;
                    }
                    const oppositeLabel = label.startsWith("NotIn")
                        ? `In${label.slice(5)}`
                        : (label.startsWith("In") ? `NotIn${label.slice(2)}` : null);
                    return { label, oppositeLabels: oppositeLabel ? [oppositeLabel] : [] };
                }

                if (!preset || typeof preset !== "object") {
                    return null;
                }

                const label = String(preset.label || "").trim();
                if (!label) {
                    return null;
                }

                const oppositeLabels = [];
                const oppositeLabel = String(
                    preset.opposite_label ?? preset.oppositeLabel ?? ""
                ).trim();
                if (oppositeLabel) {
                    oppositeLabels.push(oppositeLabel);
                }

                const rawOppositeLabels = preset.opposite_labels ?? preset.oppositeLabels;
                if (Array.isArray(rawOppositeLabels)) {
                    rawOppositeLabels.forEach((item) => {
                        const normalized = String(item || "").trim();
                        if (normalized && !oppositeLabels.includes(normalized)) {
                            oppositeLabels.push(normalized);
                        }
                    });
                }

                return { label, oppositeLabels };
            })
            .filter((preset) => preset && preset.label);
    }

    _restoreBodyScroll() {
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
        $('.modal-backdrop').remove();
    }

    // Runtime check 4: annotations without any visible atom (e.g. only a link
    // URL) are shown as a small marker at their raw position.
    _renderHiddenAnnotationMarkers(doc, shownAnnotations) {
        const hidden = doc.annotations.filter(ann => !shownAnnotations.has(ann) && this._annotationTypeFor(ann));
        if (doc.check) {
            doc.check.hiddenAnnotations = hidden;
        }
        const atoms = $('.annotatable', doc.element).toArray();
        const editable = doc.dynamic && !doc.readOnly;
        hidden.forEach(ann => {
            const annotationType = this._annotationTypeFor(ann);
            const note = this._formatReasonForDisplay(ann.reason || ann.note);
            const actions = editable
                ? (this.annotateReason ? '; right-click to remove, click to edit the reason' : '; right-click to remove')
                : '';
            const marker = $('<span>', { class: 'annotation-marker' })
                .text('\u25C6')
                .css('color', annotationType.color)
                .toggleClass('annotation-marker-editable', editable)
                .attr({
                    'data-start': ann.start,
                    'data-bs-toggle': 'tooltip',
                    'data-bs-placement': 'top',
                    title: `${annotationType.name}${note ? ` (${note})` : ''}: ${ann.text} (hidden in this view${actions})`,
                })
                .data('annotations', [ann]);
            // place it before the next visible atom, or after the last one
            const next = atoms.find(atom => parseInt(atom.dataset.index) >= ann.start);
            if (next) {
                $(next).before(marker);
            } else if (atoms.length > 0) {
                $(atoms[atoms.length - 1]).after(marker);
            } else {
                doc.element.append(marker);
            }
        });
    }

    _removeAnnotation(objectId, $span) {
        const doc = this.documents.get(objectId);
        this._removeAnnotations(objectId, this._annotationsForSpan(doc, $span));
    }

    _removeAnnotations(objectId, removedAnnotations) {
        this._addToHistory(objectId);

        const doc = this.documents.get(objectId);
        doc.annotations = doc.annotations.filter(a => !removedAnnotations.includes(a));

        this._renderAnnotations(objectId);
        this.emit('annotationRemoved', { objectId, removedAnnotations });
    }

    _renderAnnotations(objectId) {
        const doc = this.documents.get(objectId);
        const shownAnnotations = new Set();
        $('.annotation-marker', doc.element).remove();
        $('.annotatable', doc.element).each((_, span) => {
            const $span = $(span);
            const position = parseInt($span.data('index'));

            const spanAnnotations = this._annotationsForSpan(doc, $span);
            spanAnnotations.forEach(ann => shownAnnotations.add(ann));
            const validSpanAnnotations = spanAnnotations.filter((ann) => this._annotationTypeFor(ann));

            // Reset styling
            $span.attr('style', '');
            $span.removeAttr('data-bs-toggle data-bs-placement title data-bs-original-title');
            $('.whitespace', $span).removeClass('whitespace-hidden');

            if (validSpanAnnotations.length > 0) {
                const content = String($span.data('content'));
                const isLastInAnyAnnotation = validSpanAnnotations.some(ann =>
                    position + this._stringLength(content) >= ann.start + this._stringLength(ann.text));
                const hasMultipleAnnotations = validSpanAnnotations.length > 1;

                if (isLastInAnyAnnotation && !hasMultipleAnnotations) {
                    // add right padding to the last span in the annotation
                    // (in rendered views only to the token's last fragment,
                    // which holds the whitespace)
                    if (this.granularity === 'words' && $span.children('.whitespace').length > 0) {
                        const whitespace = String($span.attr('data-whitespace') || '');
                        const hasNewline = whitespace.includes('\n');
                        // no gap inside a token split at a citation marker
                        if (!hasNewline && $span.attr('data-joined') === undefined) {
                            $('.whitespace', $span).addClass('whitespace-hidden');
                            $span.css('margin-right', '9px');
                        }
                    }
                }

                const gradients = validSpanAnnotations.map((ann, i) => {
                    const offset = i * 3;
                    const color = this._annotationTypeFor(ann).color;
                    return `linear-gradient(0deg, ${color} ${4 + offset}px, transparent ${4 + offset}px)`;
                });

                $span.css({
                    'background': gradients.join(', '),
                    'background-position': '0 100%',
                    'line-height': '8px',
                    'padding-bottom': `${3 + (validSpanAnnotations.length - 1) * 3}px`,
                    'color': this._annotationTypeFor(validSpanAnnotations[validSpanAnnotations.length - 1]).color,
                    'font-weight': 'bold'
                });

                // const note = annotation.reason || annotation.note;
                // const tooltip_text = note ? `${error_name} (${note})` : error_name;

                const tooltipText = validSpanAnnotations.map(ann => {
                    const name = this._annotationTypeFor(ann).name;
                    const note = this._formatReasonForDisplay(ann.reason || ann.note);
                    return note ? `${name} (${note})` : name;
                }).join(', ');

                // data-bs-toggle="tooltip" data-bs-placement="top" title="${tooltip_text}"
                $span.attr('data-bs-toggle', 'tooltip');
                $span.attr('data-bs-placement', 'top');
                $span.attr('title', tooltipText);
                $span.attr('data-bs-original-title', tooltipText);

            }
        });
        if (!doc.exactPlain) {
            this._renderHiddenAnnotationMarkers(doc, shownAnnotations);
        }
        // enable displaying span annotation reasons when howering
        if (typeof enableTooltips === 'function') {
            enableTooltips();
        }
    }
}

const spanAnnotator = new SpanAnnotator();
