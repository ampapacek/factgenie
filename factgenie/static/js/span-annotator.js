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

    addDocument(objectId, htmlObject, dynamic = false, rawText = null) {
        const $element = $(htmlObject);
        const text = rawText ?? $element.text();
        const spans = this._createSpans(text);

        $element.empty().append(spans);

        this.documents.set(objectId, {
            element: $element,
            text: text,
            annotations: []
        });

        if (dynamic) {
            this._attachEventHandlers(objectId);
        }
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

    _appendWhitespace($element, whitespace) {
        for (const char of whitespace) {
            if (char === '\n') {
                $element.append($('<br>'));
            } else {
                $element.append(document.createTextNode(char));
            }
        }
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

    _createSpans(text) {
        const fragment = document.createDocumentFragment();
        let currentIndex = 0;
        if (this.granularity === 'words') {
            const parts = text.split(/(\s+)/);

            parts.forEach((part, arrayIndex) => {
                if (arrayIndex % 2 === 1) {
                    return;
                }

                const whitespace = arrayIndex < parts.length - 1 ? parts[arrayIndex + 1] : '';
                const fullContent = String(part) + whitespace;
                const span = document.createElement('span');
                span.className = 'annotatable';
                span.dataset.index = String(currentIndex);
                span.dataset.content = String(part);
                span.dataset.whitespace = whitespace;
                span.append(document.createTextNode(part));

                const whitespaceSpan = document.createElement('span');
                whitespaceSpan.className = 'whitespace';
                this._appendWhitespace($(whitespaceSpan), whitespace);
                span.append(whitespaceSpan);

                currentIndex += this._stringLength(fullContent);
                fragment.append(span);
            });
        } else {
            Array.from(text).forEach(char => {
                const span = document.createElement('span');
                span.className = 'annotatable';
                span.dataset.index = String(currentIndex);
                span.dataset.content = char;
                if (char === '\n') {
                    span.append(document.createElement('br'));
                } else {
                    span.append(document.createTextNode(char));
                }
                currentIndex += 1;
                fragment.append(span);
            });
        }

        return fragment;
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
            // Skip annotation logic in select mode
            if (this.currentType === -2) {
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
            if (!this.annotateReason) {
                return;
            }
            const $target = $(e.target).closest('.annotatable');
            if ($target.length === 0) {
                return;
            }
            const doc = this.documents.get(objectId);
            const position = parseInt($target.data('index'));
            const matching = doc.annotations.filter(a =>
                position >= a.start && position < a.start + a.text.length);
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
            if (e.buttons === 2) { // Right button pressed
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
            } else if (this.currentType === -1) {
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
                        const position = parseInt(endSpan.data('index'));
                        const matching = doc.annotations.filter(a =>
                            position >= a.start && position < a.start + a.text.length);
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
        const position = parseInt($span.data('index'));

        this.eraserPreviewActive = true;

        // Clear previous preview
        this._clearEraserPreview(objectId);

        // Find annotations that would be removed
        const affectedAnnotations = doc.annotations.filter(a =>
            position >= a.start && position < a.start + this._stringLength(a.text));

        // Highlight spans for each affected annotation
        affectedAnnotations.forEach(ann => {
            $('.annotatable', doc.element).each((_, span) => {
                const $span = $(span);
                const idx = parseInt($span.data('index'));
                if (idx >= ann.start && idx < ann.start + this._stringLength(ann.text)) {

                    // make the tokens more transparent by applying a filter
                    $span.css('filter', 'opacity(0.5)');
                }
            });
        });
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
        const maxWithLength = max + this._stringLength($end.data('content')) - 1;


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

    _showReasonDialog(annotation) {
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
                            <p>Please provide a reason for annotating "<strong>${annotation.text}</strong>":</p>
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

    _removeAnnotation(objectId, $span) {
        this._addToHistory(objectId);

        const doc = this.documents.get(objectId);
        const position = parseInt($span.data('index'));

        const removedAnnotations = doc.annotations.filter(a =>
            position >= a.start && position < a.start + this._stringLength(a.text));

        doc.annotations = doc.annotations.filter(a =>
            position < a.start || position >= a.start + this._stringLength(a.text));

        this._renderAnnotations(objectId);
        this.emit('annotationRemoved', { objectId, removedAnnotations });
    }

    _renderAnnotations(objectId) {
        const doc = this.documents.get(objectId);
        $('.annotatable', doc.element).each((_, span) => {
            const $span = $(span);
            const position = parseInt($span.data('index'));

            const spanAnnotations = doc.annotations.filter(a =>
                position >= a.start && position < a.start + this._stringLength(a.text));
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
                    if (this.granularity === 'words') {
                        const whitespace = String($span.attr('data-whitespace') || '');
                        const hasNewline = whitespace.includes('\n');
                        if (!hasNewline) {
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
                    const note = ann.reason || ann.note;
                    return note ? `${name} (${note})` : name;
                }).join(', ');

                // data-bs-toggle="tooltip" data-bs-placement="top" title="${tooltip_text}"
                $span.attr('data-bs-toggle', 'tooltip');
                $span.attr('data-bs-placement', 'top');
                $span.attr('title', tooltipText);
                $span.attr('data-bs-original-title', tooltipText);

            }
        });
        // enable displaying span annotation reasons when howering
        if (typeof enableTooltips === 'function') {
            enableTooltips();
        }
    }
}

const spanAnnotator = new SpanAnnotator();
