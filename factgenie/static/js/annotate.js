const sizes = [50, 50];
const annotator_id = window.annotator_id;
const metadata = window.metadata;
const redo_context = window.redo_context || {};
const INVALID_ANNOTATOR_IDS = ["", "FILL_YOUR_NAME_HERE", null, undefined];
const perExampleSaveMode = metadata?.config?.save_mode === "per_example";

var current_example_idx = 0;
var redoFinalMessage = "";
var perExampleFinalMessage = "";
var annotation_set = window.annotation_set;

const total_examples = annotation_set.length;
const annotator_preferences = window.annotator_preferences || { hide_instructions_next_time: false };

var examples_cached = {};
var annotatorAuthMode = "login";
var annotatorAuthModal = null;

var splitInstance = Split(['#centerpanel', '#rightpanel'], {
    sizes: sizes,
    gutterSize: 1,
});

function initStickyAnnotationCategories() {
    const sticky = document.querySelector(".annotation-categories-sticky");
    if (!sticky) {
        return;
    }

    const placeholder = document.createElement("div");
    placeholder.style.display = "none";
    sticky.parentNode.insertBefore(placeholder, sticky);

    let stickyStartY = 0;
    let isFixed = false;
    let fixedTop = 0;

    function calculateFixedTop() {
        return 0;
    }

    function applyTopOffset() {
        fixedTop = calculateFixedTop();
        document.documentElement.style.setProperty("--annotation-categories-top", `${fixedTop}px`);
    }

    function recalcStart() {
        disableFixed();
        applyTopOffset();
        const rect = sticky.getBoundingClientRect();
        stickyStartY = window.scrollY + rect.top - fixedTop;
    }

    function updateFixedGeometry() {
        const rect = placeholder.getBoundingClientRect();
        sticky.style.left = `${rect.left}px`;
        sticky.style.width = `${rect.width}px`;
        sticky.style.top = `${fixedTop}px`;
    }

    function enableFixed() {
        if (isFixed) {
            updateFixedGeometry();
            return;
        }
        placeholder.style.height = `${sticky.offsetHeight}px`;
        placeholder.style.display = "block";
        sticky.classList.add("annotation-categories-fixed");
        updateFixedGeometry();
        isFixed = true;
    }

    function disableFixed() {
        if (!isFixed) {
            return;
        }
        sticky.classList.remove("annotation-categories-fixed");
        sticky.style.left = "";
        sticky.style.width = "";
        sticky.style.top = "";
        placeholder.style.display = "none";
        placeholder.style.height = "";
        isFixed = false;
    }

    function onScroll() {
        if (window.scrollY >= stickyStartY) {
            enableFixed();
        } else {
            disableFixed();
        }
    }

    recalcStart();
    onScroll();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", function () {
        recalcStart();
        onScroll();
    });
}

function maybeWarnMissingAnnotatorId() {
    const placeholder = "FILL_YOUR_NAME_HERE";
    const annotatorIdNormalized = String(annotator_id || "").trim();

    if (
        annotatorIdNormalized === "" ||
        annotatorIdNormalized === placeholder 
    ) {
        alert(
            `Annotator ID is not set.\n\n` +
            `Please open the link with your name/id, e.g.:\n` +
            `${window.location.origin}${window.location.pathname}?annotatorId=pepa_novak\n\n` +
            `Current annotatorId: "${annotatorIdNormalized || "(empty)"}"`
        );
    }
}

function normalizeAnnotatorId(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[\\/]/g, "_");
}

function setAnnotatorAuthMode(mode) {
    annotatorAuthMode = mode;
    if (mode === "register") {
        $("#annotator-auth-register-btn").addClass("active");
        $("#annotator-auth-login-btn").removeClass("active");
    } else {
        $("#annotator-auth-login-btn").addClass("active");
        $("#annotator-auth-register-btn").removeClass("active");
    }
}

function showAnnotatorAuthModal(mode, message) {
    setAnnotatorAuthMode(mode || "login");
    if (message) {
        $("#annotator-auth-error").text(message).show();
    } else {
        $("#annotator-auth-error").hide().text("");
    }

    // The start overlay uses a higher z-index than the Bootstrap modal, so
    // hide it while the annotator auth dialog is visible.
    $("#overlay-start").hide();
    syncOverlayScrollLock();

    if (!annotatorAuthModal) {
        annotatorAuthModal = new bootstrap.Modal(document.getElementById("annotator-auth-modal"));
    }
    annotatorAuthModal.show();
}

function redirectWithAnnotatorId(annotatorId, forceShowInstructions = false) {
    const url = new URL(window.location.href);
    url.searchParams.set("annotatorId", annotatorId);
    if (forceShowInstructions) {
        url.searchParams.set("showInstructions", "1");
    } else {
        url.searchParams.delete("showInstructions");
    }
    window.onbeforeunload = null;
    window.location.href = url.toString();
}

function applyOverlayInstructionPreference() {
    const url = new URL(window.location.href);
    const forceShowInstructions = url.searchParams.get("showInstructions") === "1";
    const hidden = !forceShowInstructions && !!annotator_preferences.hide_instructions_next_time;
    $("#hide-instructions-next-time").prop("checked", !!annotator_preferences.hide_instructions_next_time);
    $("#overlay-start-hidden-message").toggle(hidden);
    $("#overlay-start-instructions").toggle(!hidden);

    if (forceShowInstructions) {
        url.searchParams.delete("showInstructions");
        window.history.replaceState({}, "", url.toString());
    } else if (hidden) {
        $("body").addClass("annotation-ui-ready");
        $("#overlay-start").hide();
        syncOverlayScrollLock();
        window.dispatchEvent(new Event("resize"));
    }
}

function checkAnnotatorExists(annotatorId) {
    return $.get(`${url_prefix}/annotator/exists`, {
        campaign_id: metadata.id,
        annotator_id: annotatorId,
    });
}

function saveOverlayInstructionPreference() {
    const hidden = $("#hide-instructions-next-time").is(":checked");
    annotator_preferences.hide_instructions_next_time = hidden;

    return $.ajax({
        method: "POST",
        url: `${url_prefix}/annotator/update_preferences`,
        contentType: "application/json",
        data: JSON.stringify({
            campaign_id: metadata.id,
            annotator_id: annotator_id,
            hide_instructions_next_time: hidden,
        }),
    }).fail(function () {
        console.error("Failed to update annotator preferences.");
    });
}

function submitAnnotatorAuth() {
    const rawName = $("#annotator-name-input").val();
    const normalized = normalizeAnnotatorId(rawName);
    if (!normalized) {
        $("#annotator-auth-error").text("Please enter your name.").show();
        return;
    }

    const endpoint = annotatorAuthMode === "register" ? "register" : "login";
    $("#annotator-auth-submit-btn").prop("disabled", true);
    $("#annotator-auth-error").hide().text("");

    if (annotatorAuthMode === "register") {
        checkAnnotatorExists(normalized)
            .done((response) => {
                if (response.exists) {
                    setAnnotatorAuthMode("login");
                    $("#annotator-auth-error")
                        .text("This annotator name already exists. Please use Login instead.")
                        .show();
                    $("#annotator-auth-submit-btn").prop("disabled", false);
                    return;
                }
                postAnnotatorAuth(endpoint, normalized);
            })
            .fail(() => {
                $("#annotator-auth-error").text("Could not verify annotator. Please try again.").show();
                $("#annotator-auth-submit-btn").prop("disabled", false);
            });
        return;
    }

    postAnnotatorAuth(endpoint, normalized);
}

function postAnnotatorAuth(endpoint, annotatorId) {
    $.post({
        url: `${url_prefix}/annotator/${endpoint}`,
        contentType: "application/json",
        data: JSON.stringify({
            campaign_id: metadata.id,
            annotator_id: annotatorId,
        }),
        success: function (response) {
            if (response.success !== true) {
                const errorMsg = response.error || "Authentication failed.";
                if (endpoint === "register" && errorMsg.toLowerCase().includes("already exists")) {
                    setAnnotatorAuthMode("login");
                }
                $("#annotator-auth-error").text(errorMsg).show();
                $("#annotator-auth-submit-btn").prop("disabled", false);
                return;
            }
            localStorage.setItem(`factgenie_annotator_id_${metadata.id}`, response.annotator_id);
            redirectWithAnnotatorId(response.annotator_id);
        },
        error: function (xhr) {
            const errorMsg = xhr.responseJSON?.error || "Authentication failed.";
            $("#annotator-auth-error").text(errorMsg).show();
            $("#annotator-auth-submit-btn").prop("disabled", false);
        }
    });
}

function ensureAnnotatorAuth() {
    return new Promise((resolve) => {
        const normalized = normalizeAnnotatorId(annotator_id);
        if (normalized === "factgenie_preview") {
            resolve();
            return;
        }
        const isInvalid = INVALID_ANNOTATOR_IDS.includes(normalized);

        if (isInvalid) {
            $("#annotator-name-input").val("");
            showAnnotatorAuthModal("register");
            return;
        }

        checkAnnotatorExists(normalized)
            .done((response) => {
                if (response.exists) {
                    resolve();
                } else {
                    $("#annotator-name-input").val(normalized);
                    showAnnotatorAuthModal("login", "Annotator not found. Please register first.");
                }
            })
            .fail(() => {
                $("#annotator-name-input").val(normalized);
                showAnnotatorAuthModal("login", "Could not verify annotator. Please try again.");
            });
    });
}


function clearExampleLevelFields() {
    // uncheck all checkboxes
    $(".crowdsourcing-flag input[type='checkbox']").prop("checked", false);

    // reset all options to the first value
    $(".crowdsourcing-option select").val("");


    $(".crowdsourcing-slider input[type='range']").each(function () {
        $(this).val($(this).attr('min') || 0);
    });
    $(".slider-crowdsourcing-value").each(function () {
        const sliderId = $(this).attr("id").replace(/-value$/, "");
        $(this).text($(`#${sliderId}`).val());
    });

    // clear the values in free-text fields
    $(".crowdsourcing-text .textbox-crowdsourcing").val("");
}


function clearRedoMatchHighlights() {
    $("#redo-match-box").hide().empty();
    $(".browse-match-highlight").each(function () {
        const node = $(this);
        if (node.is("mark")) {
            node.replaceWith(document.createTextNode(node.text()));
        } else {
            node.removeClass("browse-match-highlight");
        }
    });
    $(".browse-match-span").removeClass("browse-match-span");
    $(".browse-match-slider").removeClass("browse-match-slider");
    $(".browse-match-focus, .browse-match-focus-inline").removeClass("browse-match-focus browse-match-focus-inline");
}

function markRedoTextNodes(container, text) {
    const needle = String(text || "");
    if (!needle) {
        return false;
    }
    const element = $(container).get(0);
    if (!element) {
        return false;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            if (!node.nodeValue || !node.nodeValue.trim()) {
                return NodeFilter.FILTER_REJECT;
            }
            if ($(node.parentElement).closest("mark, script, style").length) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const nodes = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }
    let marked = false;
    nodes.forEach(function (node) {
        let current = node;
        while (current && current.nodeType === Node.TEXT_NODE) {
            const index = current.nodeValue.toLowerCase().indexOf(needle.toLowerCase());
            if (index < 0) {
                break;
            }
            const after = current.splitText(index);
            const rest = after.splitText(needle.length);
            const mark = document.createElement("mark");
            mark.className = "browse-match-highlight";
            mark.textContent = after.nodeValue;
            after.parentNode.replaceChild(mark, after);
            current = rest;
            marked = true;
        }
    });
    return marked;
}

function markRedoAnnotatableRange(box, start, length) {
    if (start === null || start === undefined || String(start).trim() === "") {
        return false;
    }
    const numericStart = Number(start);
    const numericLength = Number(length);
    if (!Number.isFinite(numericStart) || !Number.isFinite(numericLength) || numericLength <= 0) {
        return false;
    }
    const end = numericStart + numericLength;
    let marked = false;
    box.find(".annotatable").each(function () {
        const span = $(this);
        const idx = Number(span.data("index"));
        const contentLength = String(span.data("content") || "").length;
        if (Number.isFinite(idx) && idx < end && idx + Math.max(contentLength, 1) > numericStart) {
            span.addClass("browse-match-span");
            marked = true;
        }
    });
    return marked;
}

function markRedoAnnotatableText(box, text) {
    const needle = String(text || "");
    if (!needle) {
        return false;
    }
    let fullText = "";
    const spans = [];
    box.find(".annotatable").each(function () {
        const span = $(this);
        const chunk = String(span.data("content") || "");
        spans.push({ span, start: fullText.length, end: fullText.length + chunk.length });
        fullText += chunk + String(span.data("whitespace") || "");
    });
    const ranges = [];
    const haystack = fullText.toLowerCase();
    const loweredNeedle = needle.toLowerCase();
    let searchFrom = 0;
    while (searchFrom <= haystack.length) {
        const index = haystack.indexOf(loweredNeedle, searchFrom);
        if (index < 0) {
            break;
        }
        ranges.push({ start: index, end: index + needle.length });
        searchFrom = index + Math.max(needle.length, 1);
    }
    if (!ranges.length) {
        return false;
    }
    spans.forEach(function (item) {
        if (ranges.some((range) => item.start < range.end && item.end > range.start)) {
            item.span.addClass("browse-match-span");
        }
    });
    return true;
}

function redoMatchLabel(detail) {
    const fieldLabels = {
        question: "question",
        output: "answer",
        span_text: "span text",
        span_reason: "span reason",
        span_category: "span category",
        slider: "slider",
        any_text: "text",
    };
    return fieldLabels[detail.field] || fieldLabels[detail.target] || detail.target || "match";
}

function redoMatchEvidence(detail) {
    return detail.matched_text || detail.span_text || detail.reason || detail.text || detail.value || detail.slider_value || "";
}

function applyRedoMatchDetail(detail) {
    const outputBox = $(`#out-text-${current_example_idx}`);
    if (detail.target === "question") {
        return markRedoTextNodes($("#examplearea"), detail.matched_text || detail.value);
    }
    if (detail.target === "output") {
        if (markRedoAnnotatableText(outputBox, detail.matched_text || detail.value)) {
            return true;
        }
        return markRedoTextNodes(outputBox, detail.matched_text || detail.value);
    }
    if (detail.target === "span") {
        const marked = markRedoAnnotatableRange(outputBox, detail.start, String(detail.span_text || "").length);
        if (marked) {
            return true;
        }
        return markRedoAnnotatableText(outputBox, detail.span_text || detail.matched_text);
    }
    if (detail.target === "slider") {
        const label = String(detail.slider_label || detail.sliderLabel || "");
        const rows = $(".crowdsourcing-slider").filter(function () {
            return String($(this).find("label").first().text() || "").trim() === label;
        });
        rows.addClass("browse-match-slider");
        return rows.length > 0;
    }
    const text = detail.matched_text || detail.value;
    if (text) {
        return markRedoTextNodes(outputBox, text) || markRedoTextNodes($("#examplearea"), text);
    }
    return false;
}

function showRedoMatchGuidance(details, matchSource, highlightedCount) {
    const box = $("#redo-match-box");
    box.empty();
    if (matchSource === "batch_context" && !details.length) {
        box
            .removeClass("alert-warning")
            .addClass("alert-secondary")
            .text("This item was included with a selected batch. No direct filter match was stored for this answer.");
        box.show();
        return;
    }
    if (!details.length) {
        box.hide();
        return;
    }

    box.removeClass("alert-secondary").addClass("alert-warning");
    box.append($("<div>").append($("<b>").text("Matched filter content")));
    const list = $("<ul>", { class: "mb-0 ps-3" });
    details.slice(0, 4).forEach(function (detail) {
        const evidence = redoMatchEvidence(detail);
        const text = evidence
            ? `${redoMatchLabel(detail)}: ${evidence}`
            : redoMatchLabel(detail);
        list.append($("<li>").text(text));
    });
    if (details.length > 4) {
        list.append($("<li>").text(`${details.length - 4} more match(es)`));
    }
    box.append(list);
    if (highlightedCount === 0) {
        box.append($("<div>", { class: "small mt-2" }).text("The match metadata is stored, but no visible text or control could be highlighted on this page."));
    }
    box.show();
}

function applyRedoMatchHighlights() {
    clearRedoMatchHighlights();
    if (redo_context.is_redo !== true || !annotation_set[current_example_idx]) {
        return;
    }
    const current = annotation_set[current_example_idx];
    const details = Array.isArray(current.redo_match_details) ? current.redo_match_details : [];
    const matchSource = current.redo_match_source || "";
    let highlightedCount = 0;
    details.forEach(function (detail) {
        if (detail && applyRedoMatchDetail(detail)) {
            highlightedCount += 1;
        }
    });
    showRedoMatchGuidance(details, matchSource, highlightedCount);
}


function collectFlags() {
    const flags = [];
    $(".crowdsourcing-flag").each(function () {
        const label = $(this).find("label").text().trim();
        const value = $(this).find("input[type='checkbox']").prop("checked");
        flags.push({
            label: label,
            value: value
        });
    });
    return flags;
}

function collectOptions() {
    const options = [];

    $(".crowdsourcing-option").each(function (x) {
        // backwards compatibility with old sliders
        if ($(this).hasClass("option-slider")) {
            const type = "slider";
            const label = $(this).find("label").text();
            const index = $(this).find("input[type='range']").val();
            const value = $(this).find("datalist option")[index].value;
            const optionList = $(this).find("datalist option").map(function () {
                return $(this).val();
            }).get();
            options.push({ type: type, label: label, index: index, value: value, optionList: optionList });
        } else {
            const label = $(this).find("label").text().trim();
            const index = $(this).find("select").val();
            const value = $(this).find("select option:selected").text();

            const optionList = $(this).find("select option").map(function () {
                return $(this).text();
            }).get();
            options.push({ label: label, index: index, value: value, optionList: optionList });
        }
    });
    return options;
}

function collectSliders() {
    const sliders = [];

    $(".crowdsourcing-slider").each(function (x) {
        const label = $(this).find("label").text();
        const value = $(this).find("input[type='range']").val();
        const min = $(this).find("input[type='range']").attr('min');
        const max = $(this).find("input[type='range']").attr('max');
        const step = $(this).find("input[type='range']").attr('step');

        sliders.push({ label: label, value: value, min: min, max: max, step: step });
    });
    return sliders;
}

function collectTextFields() {
    const textFields = [];

    $(".crowdsourcing-text").each(function (x) {
        const label = $(this).find("label").text().trim();
        const value = $(this).find(".textbox-crowdsourcing").val();
        textFields.push({ label: label, value: value });
    });
    return textFields;
}


function fetchAnnotation(dataset, split, setup_id, example_idx, annotation_idx) {
    return new Promise((resolve, reject) => {
        $.get(`${url_prefix}/example`, {
            "dataset": dataset,
            "example_idx": example_idx,
            "split": split,
            "setup_id": setup_id,
            "mode": window.mode,
        }, function (data) {
            $('<div>', {
                id: `out-text-${annotation_idx}`,
                class: `annotate-box`,
                style: 'display: none;'
            }).appendTo('#outputarea');

            if (data.html === null) {
                $("#centerpanel").hide();
                // disable Split.js
                splitInstance.setSizes([0, 100]);
                // center the right panel
                $("#rightpanel").css("width", "50%");
                $("#rightpanel").css("margin", "auto");

            } else {
                $("#examplearea").html(data.html);
            }

            // We normally have a single generated output here. Redo items can
            // outlive the current output index, so fall back to the saved redo
            // record's text when the original setup output is no longer present.
            const fallbackOutput = annotation_set[annotation_idx]?.output || "";
            const generatedOutputs = Array.isArray(data.generated_outputs) ? data.generated_outputs : [];
            let generatedOutput = generatedOutputs[0] || null;
            if ((!generatedOutput || generatedOutput.output === undefined || generatedOutput.output === null) && fallbackOutput) {
                generatedOutput = {
                    ...(generatedOutput || {}),
                    output: fallbackOutput,
                    setup_id: generatedOutput?.setup_id || setup_id,
                };
            }
            if (!generatedOutput) {
                generatedOutput = {
                    setup_id: setup_id,
                    output: fallbackOutput,
                };
            }
            data.generated_outputs = generatedOutput;
            examples_cached[annotation_idx] = data;
            resolve({ annotation_idx });
        }).fail(function (xhr, textStatus, errorThrown) {
            reject({
                annotation_idx,
                dataset,
                split,
                setup_id,
                example_idx,
                status: xhr?.status,
                textStatus: textStatus || "",
                errorThrown: errorThrown || "",
                responseError: xhr?.responseJSON?.error || "",
                responseText: xhr?.responseText || "",
            });
        });
    });
}

function getLoadedExampleIndexes() {
    return Object.keys(examples_cached)
        .map((idx) => parseInt(idx, 10))
        .filter((idx) => !Number.isNaN(idx))
        .sort((a, b) => a - b);
}

function findNextLoadedIndex(targetPage, direction = 1) {
    if (total_examples <= 0) {
        return null;
    }
    const step = direction >= 0 ? 1 : -1;
    let candidate = targetPage;
    for (let checked = 0; checked < total_examples; checked += 1) {
        const normalized = mod(candidate, total_examples);
        if (examples_cached[normalized]) {
            return normalized;
        }
        candidate += step;
    }
    return null;
}


function goToAnnotation(example_idx) {
    current_example_idx = example_idx;
    $(".page-link").removeClass("bg-active");
    $(`#page-link-${example_idx}`).addClass("bg-active");

    $(".annotate-box").hide();
    $(`#out-text-${example_idx}`).show();

    const data = examples_cached[example_idx];
    if (!data) {
        console.warn(`Missing cached example data for annotation index ${example_idx}.`);
        return;
    }
    $("#examplearea").html(data.html);

    const flags = annotation_set[example_idx].flags;
    const options = annotation_set[example_idx].options;
    const sliders = annotation_set[example_idx].sliders;
    const textFields = annotation_set[example_idx].textFields;
    const redoInstruction = annotation_set[example_idx].redo_instruction;
    let originalSkipSelected = false;

    annotation_set[example_idx]["timeLastAccessed"] = Math.floor(Date.now() / 1000);

    clearExampleLevelFields();

    if (flags !== undefined) {
        $(".crowdsourcing-flag").each(function (i) {
            $(this).find("input[type='checkbox']").prop("checked", flags[i]["value"]);
        });
        originalSkipSelected = $(".crowdsourcing-flag").toArray().some(function (flagElem, i) {
            const label = $(flagElem).find("label").text().trim().toLowerCase();
            return (label.includes("skip") || label.includes("přeskoč")) && !!flags[i]?.value;
        });
        if (redo_context.is_redo === true) {
            $(".crowdsourcing-flag").each(function () {
                const label = $(this).find("label").text().trim().toLowerCase();
                if (label.includes("skip") || label.includes("přeskoč")) {
                    $(this).find("input[type='checkbox']").prop("checked", false);
                }
            });
        }
    }

    if (options !== undefined) {
        for (const [i, option] of Object.entries(options)) {
            const div = $(`.crowdsourcing-option:eq(${i})`);
            // we can have either a select or a slider (we can tell by `type`)
            // we need to set the option defined by `index`
            div.find("select").val(option.index);

            // backwards compatibility with old sliders
            if (option.type == "slider") {
                div.find("input[type='range']").val(option.index);
            }
        }
    }

    if (sliders !== undefined) {
        for (const [i, slider] of Object.entries(sliders)) {
            $(`.crowdsourcing-slider input:eq(${i})`).val(slider.value);
            $(`.slider-crowdsourcing-value:eq(${i})`).text(slider.value);
        }
    }

    if (textFields !== undefined) {
        for (const [i, textField] of Object.entries(textFields)) {
            $(`.crowdsourcing-text .textbox-crowdsourcing:eq(${i})`).val(textField.value);
        }
    }

    if (redoInstruction) {
        $("#redo-instruction-box").text(redoInstruction).show();
    } else {
        $("#redo-instruction-box").hide().text("");
    }

    if (redo_context.is_redo === true && originalSkipSelected) {
        $("#redo-action-help").show();
    } else {
        $("#redo-action-help").hide();
    }

    updateRedoActionStatus();
    updatePerExampleActionStatus();
    applyRedoMatchHighlights();
}

function goToPage(page) {
    const example_idx = current_example_idx;
    const direction = page >= current_example_idx ? 1 : -1;
    const resolvedPage = findNextLoadedIndex(page, direction);
    if (resolvedPage === null) {
        console.warn("No loaded annotation examples are available.");
        return;
    }
    current_example_idx = resolvedPage;

    saveCurrentAnnotations(example_idx);
    goToAnnotation(current_example_idx);
}

function addPageLink(annotation_idx) {
    const li = $('<li>', { class: "page-item" });
    const a = $('<a>', { class: "page-link bg-incomplete", style: "min-height: 28px;", id: `page-link-${annotation_idx}` }).text(parseInt(annotation_idx) + 1);
    li.append(a);
    $("#nav-example-cnt").append(li);

    // switch to the corresponding example when clicking on the page number
    $(`#page-link-${annotation_idx}`).click(function () {
        goToPage(annotation_idx);
    });
}

function normalizeNewlines(text) {
    if (text === null || text === undefined) return "";
    return String(text)
        .replace(/\r\n/g, "\n")
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n");
}


function loadAnnotations() {
    $("#dataset-spinner").show();
    initializeRedoControls();
    initializePerExampleControls();

    const promises = [];
    const annotation_span_categories = metadata.config.annotation_span_categories;

    // prefetch the examples for annotation
    for (const [annotation_idx, example] of Object.entries(annotation_set)) {
        const dataset = example.dataset;
        const split = example.split;
        const example_idx = example.example_idx;
        const setup_id = example.setup_id;

        const promise = fetchAnnotation(dataset, split, setup_id, example_idx, annotation_idx);
        promises.push(promise);
    }
    Promise.allSettled(promises)
        .then((results) => {
            const loadedIndexes = getLoadedExampleIndexes();
            const failed = results
                .filter((result) => result.status === "rejected")
                .map((result) => result.reason || {});

            if (loadedIndexes.length === 0) {
                console.error("No annotation examples could be loaded.", failed);
                $("#hideOverlayBtn")
                    .attr("disabled", false)
                    .removeClass("btn-primary")
                    .addClass("btn-danger")
                    .text("Failed to load examples");
                $("#redo-instruction-box")
                    .text("No annotation examples could be loaded. Please refresh the page. If the problem continues, contact the campaign administrator.")
                    .show();
                return;
            }

            // take from metadata if defined, else false
            const annotationOverlapAllowed = metadata.config.annotation_overlap_allowed || false;
            const annotateReason = metadata.config.annotate_reason || false;
            spanAnnotator.init(metadata.config.annotation_granularity, annotationOverlapAllowed, annotation_span_categories, annotateReason);

            for (const annotation_idx of loadedIndexes) {
                const data = examples_cached[annotation_idx];
                const normalizedOutput = normalizeNewlines(data.generated_outputs.output);
                const p = $('<p>', { id: `out-text-${annotation_idx}-par`, class: 'annotatable-paragraph' });
                $(`#out-text-${annotation_idx}`).append(p);
                spanAnnotator.addDocument(`p${annotation_idx}`, p, true, normalizedOutput);
                if (Array.isArray(annotation_set[annotation_idx].annotations)) {
                    spanAnnotator.addAnnotations(`p${annotation_idx}`, annotation_set[annotation_idx].annotations);
                }
                spanAnnotator.setCurrentAnnotationType(0);
                addPageLink(annotation_idx);
                if (perExampleSaveMode && annotation_set[annotation_idx].per_example_saved === true) {
                    $(`#page-link-${annotation_idx}`).removeClass("bg-incomplete").addClass("bg-complete");
                }
            }

            initializePerExampleSavedVisibility();

            const visibleIndexes = visiblePerExampleIndexes();
            if (perExampleSaveMode && redo_context.show_saved !== true && visibleIndexes.length === 0) {
                $("#hideOverlayBtn").attr("disabled", false);
                $("#hideOverlayBtn").html("View the annotation page");
                finishPerExampleAnnotations();
                return;
            }

            const firstLoadedIndex = visibleIndexes[0] ?? loadedIndexes[0];
            current_example_idx = firstLoadedIndex;
            goToAnnotation(firstLoadedIndex);

            $("#hideOverlayBtn").attr("disabled", false);
            $("#hideOverlayBtn").html("View the annotation page");
            if (failed.length > 0) {
                console.warn("Some annotation examples failed to load.", failed);
                failed.forEach((failure) => {
                    const summary = [
                        `annotation_idx=${failure.annotation_idx}`,
                        `dataset=${failure.dataset}`,
                        `split=${failure.split}`,
                        `setup_id=${failure.setup_id}`,
                        `example_idx=${failure.example_idx}`,
                        `status=${failure.status ?? "unknown"}`,
                    ].join(", ");
                    console.error(`[FactGenie redo] Failed to load example: ${summary}`);
                    if (failure.responseError) {
                        console.error(`[FactGenie redo] Server error: ${failure.responseError}`);
                    } else if (failure.responseText) {
                        console.error(`[FactGenie redo] Server response: ${failure.responseText}`);
                    } else if (failure.textStatus || failure.errorThrown) {
                        console.error(
                            `[FactGenie redo] Request failure: ${failure.textStatus || "error"} ${failure.errorThrown || ""}`.trim()
                        );
                    }
                });
                $("#redo-instruction-box")
                    .text(`Loaded ${loadedIndexes.length} annotation example(s), but ${failed.length} item(s) could not be loaded. You can continue with the loaded items. Check the browser console for details if needed.`)
                    .show();
            }
        })
        .finally(() => {
            // This block will be executed regardless of success or failure
            $("#dataset-spinner").hide();
        });
}

function initializeRedoControls() {
    if (redo_context.empty_redo_fallback === true) {
        $("#redo-empty-fallback-message").show();
    }
    if (redo_context.is_redo === true) {
        $("#redo-mode-nav-badge").show();
        $("#redo-mode-banner").show();
        $("#mark-annotation-complete-btn").hide();
        $("#redo-keep-current-btn").show();
        $("#redo-save-current-btn").show();
        $("#redo-action-help").show();
        $("#submit-annotations-btn").hide();
        $("#redo-show-completed-item").show();
        const url = new URL(window.location.href);
        $("#redo-show-completed-link").off("click");
        if (redo_context.show_completed === true) {
            setRedoSavedItemsToggle(false);
        } else {
            $("#redo-show-completed-link").text("Show saved items");
            url.searchParams.set("show_completed_redo", "1");
            url.searchParams.set("redo_review", "1");
            $("#redo-show-completed-link").attr("href", url.toString());
        }
    }
}

function submitButtonText() {
    return perExampleSaveMode ? "Finish / save remaining" : "👉️ Submit Annotations";
}

function initializePerExampleControls() {
    if (!perExampleSaveMode || redo_context.is_redo === true) {
        return;
    }
    $("#submit-annotations-btn").show().text(submitButtonText());
    $("#redo-show-completed-item").show();
    $("#redo-mode-banner")
        .removeClass("alert-warning")
        .addClass("alert-info")
        .text("Each example is saved when you mark it complete. Use Show saved items to review and edit saved examples.")
        .show();
    $("#redo-action-status").hide().text("");

    const url = new URL(window.location.href);
    $("#redo-show-completed-link").off("click");
    if (redo_context.show_saved === true) {
        setPerExampleSavedItemsToggle(false);
    } else {
        $("#redo-show-completed-link").text("Show saved items");
        url.searchParams.set("show_saved_items", "1");
        url.searchParams.set("saved_review", "1");
        $("#redo-show-completed-link").attr("href", url.toString());
    }
}

function setPerExampleActionStatus(message, level = "muted") {
    if (!perExampleSaveMode || redo_context.is_redo === true) {
        return;
    }
    const status = $("#redo-action-status");
    status.removeClass("text-muted text-success text-danger text-warning");
    status.addClass(`text-${level}`).text(message).show();
}

function setRedoActionStatus(message, level = "muted") {
    if (redo_context.is_redo !== true) {
        return;
    }
    const status = $("#redo-action-status");
    status.removeClass("text-muted text-success text-danger text-warning");
    status.addClass(`text-${level}`).text(message).show();
}

function updateRedoActionStatus() {
    if (redo_context.is_redo !== true || !annotation_set[current_example_idx]) {
        return;
    }
    const current = annotation_set[current_example_idx];
    if (current.redo_status === "completed") {
        setRedoActionStatus("This item is saved as the current annotation. You can edit and save it again if needed.", "success");
        return;
    }
    $("#redo-action-status").hide().text("");
}

function updatePerExampleActionStatus() {
    if (!perExampleSaveMode || redo_context.is_redo === true || !annotation_set[current_example_idx]) {
        return;
    }
    if (annotation_set[current_example_idx].per_example_saved === true) {
        setPerExampleActionStatus("This example is saved. You can edit it and mark it complete again to replace the saved annotation.", "success");
        return;
    }
    $("#redo-action-status").hide().text("");
}

function isSkipAnnotationSelected() {
    const skipMarkers = ["skip", "přeskoč"];
    let skipSelected = false;
    $(".crowdsourcing-flag").each(function () {
        const label = $(this).find("label").text().trim().toLowerCase();
        const checked = $(this).find("input[type='checkbox']").prop("checked");
        if (!checked) return;
        if (skipMarkers.some(marker => label.includes(marker))) {
            skipSelected = true;
        }
    });
    return skipSelected;
}

function isSkipFlagLabel(label) {
    const normalized = (label || "").trim().toLowerCase();
    return normalized.includes("skip") || normalized.includes("přeskoč");
}

function flagDefinitionsFromTemplate() {
    const flags = [];
    $(".crowdsourcing-flag").each(function () {
        const label = $(this).find("label").text().trim();
        flags.push({ label: label, value: false });
    });
    return flags;
}

function hasSkipFlagAvailable(annotation) {
    const flags = Array.isArray(annotation?.flags) && annotation.flags.length > 0
        ? annotation.flags
        : flagDefinitionsFromTemplate();
    return flags.some(flag => isSkipFlagLabel(flag.label));
}

function markAnnotationSkipped(annotation) {
    const baseFlags = Array.isArray(annotation.flags) && annotation.flags.length > 0
        ? annotation.flags
        : flagDefinitionsFromTemplate();
    annotation.flags = baseFlags.map(flag => ({
        ...flag,
        value: isSkipFlagLabel(flag.label) ? true : !!flag.value,
    }));
    annotation.timeLastSaved = Math.floor(Date.now() / 1000);
}

function hasStoredAnnotationContent(annotation) {
    if (!annotation) {
        return false;
    }
    if (Array.isArray(annotation.annotations) && annotation.annotations.some(item => (item?.text || "").trim() !== "")) {
        return true;
    }
    if (Array.isArray(annotation.flags) && annotation.flags.some(flag => flag.value === true)) {
        return true;
    }
    if (Array.isArray(annotation.options) && annotation.options.some(option => `${option?.index ?? ""}` !== "")) {
        return true;
    }
    const textFields = Array.isArray(annotation.textFields) ? annotation.textFields : annotation.text_fields;
    if (Array.isArray(textFields) && textFields.some(field => `${field?.value ?? ""}`.trim() !== "")) {
        return true;
    }
    if (Array.isArray(annotation.sliders)) {
        return annotation.sliders.some(slider => {
            const value = Number(slider?.value);
            const min = Number(slider?.min ?? 0);
            return !Number.isNaN(value) && !Number.isNaN(min) && value !== min;
        });
    }
    return false;
}

function preparePerExampleFinishSubmission() {
    let skippedCount = 0;
    annotation_set.forEach(annotation => {
        if (annotation.per_example_saved === true) {
            return;
        }
        if (!hasStoredAnnotationContent(annotation) && hasSkipFlagAvailable(annotation)) {
            markAnnotationSkipped(annotation);
            skippedCount += 1;
        }
    });
    return skippedCount;
}

function validateCurrentAnnotationComplete() {
    const skipSelected = isSkipAnnotationSelected();

    // if skip flag was set, dont check initialization of the values
    if (!skipSelected) {
        
        // check whether all the selects have been filled (the default value is not selected)
        const allSelectsFilled = $(".crowdsourcing-option").find("select option:selected")
            .filter(function () { return $(this).val() == ""; }).length == 0;

        if (!allSelectsFilled) {
            alert("Please select all the options before saving this annotation.");
            return false;
        }

    }
    return true;
}

function markAnnotationAsComplete() {
    if (redo_context.is_redo === true) {
        saveCurrentRedoItem();
        return;
    }

    if (perExampleSaveMode) {
        saveCurrentAnnotationItem();
        return;
    }

    if (!validateCurrentAnnotationComplete()) {
        return;
    }

    $('#page-link-' + current_example_idx).removeClass("bg-incomplete");
    $('#page-link-' + current_example_idx).addClass("bg-complete");

    // if all the examples are annotated, post the annotations
    if ($(".bg-incomplete").length == 0) {
        saveCurrentAnnotations(current_example_idx);

        if (redo_context.is_redo === true) {
            $("#redo-save-current-btn").show();
        } else {
            // show the `submit` button
            $("#submit-annotations-btn").show();
        }

        // scroll to the top
        $('html, body').animate({
            scrollTop: (redo_context.is_redo === true ? $("#redo-save-current-btn") : $("#submit-annotations-btn")).offset().top
        }, 500);

    } else if (current_example_idx < total_examples - 1) {
        // annotations will be saved automatically
        nextBtn();
    }
}

function visibleRedoIndexes() {
    const includeCompleted = redo_context.show_completed === true;
    return annotation_set
        .map((annotation, index) => ({ annotation, index }))
        .filter(({ annotation, index }) =>
            annotation.redo_id &&
            (includeCompleted || annotation.redo_status !== "completed") &&
            !$(`#page-link-${index}`).closest(".page-item").hasClass("redo-saved-hidden")
        )
        .map(({ index }) => index);
}

function hideCompletedRedoItems() {
    $(".page-item").has(".page-link.bg-complete").addClass("redo-saved-hidden").hide();
    $(".output-element").hide();
}

function showCompletedRedoItems() {
    $(".redo-saved-hidden").removeClass("redo-saved-hidden").show();
    $(".output-element").show();
}

function setRedoSavedItemsToggle(hidden) {
    const link = $("#redo-show-completed-link");
    link.off("click");
    if (hidden) {
        link.text("Show saved items");
        link.attr("href", "#");
        link.on("click", function (event) {
            event.preventDefault();
            showCompletedRedoItems();
            setRedoSavedItemsToggle(false);
        });
    } else {
        link.text("Hide saved items");
        link.attr("href", "#");
        link.on("click", function (event) {
            event.preventDefault();
            handleHideSavedItemsClick();
        });
    }
}

function handleHideSavedItemsClick() {
    const current = annotation_set[current_example_idx] || {};
    hideCompletedRedoItems();

    const remaining = visibleRedoIndexes();
    if (remaining.length === 0) {
        showRedoFinish();
        return;
    }

    const currentIsHiddenCompleted =
        current.redo_status === "completed" ||
        $(`#page-link-${current_example_idx}`).closest(".page-item").hasClass("redo-saved-hidden");

    if (currentIsHiddenCompleted) {
        goToPage(remaining[0]);
    }

    setRedoSavedItemsToggle(true);
}

function showRedoFinish(finalMessage) {
    if (finalMessage) {
        redoFinalMessage = finalMessage;
    }
    $("#output-content").hide();
    $("#redo-save-current-btn").hide();
    finishRedoAnnotations();
}

function finishRedoAnnotations() {
    const reviewUrl = new URL(window.location.href);
    reviewUrl.searchParams.set("show_completed_redo", "1");
    reviewUrl.searchParams.set("redo_review", "1");
    // The overlay uses a generic completion message for now. We keep the
    // campaign-specific final message in redoFinalMessage as a future hook.
    $("#final-message").html(`
        <p class="mt-4">
            Redo annotations are complete. You can close this page, or review the saved annotations again if you want to edit them.
        </p>
        <a class="btn btn-primary mt-2" href="${reviewUrl.toString()}">Review saved annotations</a>
    `);
    $("#overlay-end").show();
    window.onbeforeunload = null;
    syncOverlayScrollLock();
}

function goToNextVisibleRedoItem(finalMessage) {
    const remaining = visibleRedoIndexes();
    if (remaining.length === 0) {
        showRedoFinish(finalMessage);
        return;
    }

    const next = remaining.find(index => index > current_example_idx) ?? remaining[0];
    goToPage(next);
}

function visiblePerExampleIndexes() {
    if (!perExampleSaveMode || redo_context.is_redo === true) {
        return getLoadedExampleIndexes();
    }
    const includeSaved = redo_context.show_saved === true;
    return annotation_set
        .map((annotation, index) => ({ annotation, index }))
        .filter(({ annotation, index }) =>
            examples_cached[index] &&
            (includeSaved || annotation.per_example_saved !== true) &&
            !$(`#page-link-${index}`).closest(".page-item").hasClass("per-example-saved-hidden")
        )
        .map(({ index }) => index);
}

function hideCompletedPerExampleItems() {
    $(".page-item").has(".page-link.bg-complete").addClass("per-example-saved-hidden").hide();
    $(".output-element").hide();
}

function showCompletedPerExampleItems() {
    $(".per-example-saved-hidden").removeClass("per-example-saved-hidden").show();
    $(".output-element").show();
}

function setPerExampleSavedItemsToggle(hidden) {
    const link = $("#redo-show-completed-link");
    link.off("click");
    if (hidden) {
        link.text("Show saved items");
        link.attr("href", "#");
        link.on("click", function (event) {
            event.preventDefault();
            showCompletedPerExampleItems();
            setPerExampleSavedItemsToggle(false);
        });
    } else {
        link.text("Hide saved items");
        link.attr("href", "#");
        link.on("click", function (event) {
            event.preventDefault();
            handleHidePerExampleSavedItemsClick();
        });
    }
}

function initializePerExampleSavedVisibility() {
    if (!perExampleSaveMode || redo_context.is_redo === true) {
        return;
    }
    if (redo_context.show_saved === true) {
        setPerExampleSavedItemsToggle(false);
        return;
    }
    annotation_set.forEach((annotation, index) => {
        if (annotation.per_example_saved === true) {
            $(`#page-link-${index}`).closest(".page-item").addClass("per-example-saved-hidden").hide();
            $(`#out-text-${index}`).hide();
        }
    });
}

function handleHidePerExampleSavedItemsClick() {
    const current = annotation_set[current_example_idx] || {};
    hideCompletedPerExampleItems();

    const remaining = visiblePerExampleIndexes();
    if (remaining.length === 0) {
        finishPerExampleAnnotations();
        return;
    }

    const currentIsHiddenCompleted =
        current.per_example_saved === true ||
        $(`#page-link-${current_example_idx}`).closest(".page-item").hasClass("per-example-saved-hidden");

    if (currentIsHiddenCompleted) {
        goToPage(remaining[0]);
    }

    setPerExampleSavedItemsToggle(true);
}

function finishPerExampleAnnotations(finalMessage) {
    if (finalMessage) {
        perExampleFinalMessage = finalMessage;
    }
    const reviewUrl = new URL(window.location.href);
    reviewUrl.searchParams.set("show_saved_items", "1");
    reviewUrl.searchParams.set("saved_review", "1");
    const message = perExampleFinalMessage || metadata.config.final_message || "Thank you.";
    $("#final-message").html(`
        ${message}
        <p class="mt-4">
            Your annotations are saved. You can close this page, or review saved examples again if you want to edit them.
        </p>
        <a class="btn btn-primary mt-2" href="${reviewUrl.toString()}">Review saved annotations</a>
    `);
    $("#overlay-end").show();
    window.onbeforeunload = null;
    syncOverlayScrollLock();
}

function goToNextVisiblePerExampleItem(finalMessage) {
    const remaining = visiblePerExampleIndexes();
    if (remaining.length === 0) {
        finishPerExampleAnnotations(finalMessage);
        return;
    }

    const next = remaining.find(index => index > current_example_idx) ?? remaining[0];
    goToPage(next);
}

function saveCurrentRedoItem() {
    if (redo_context.is_redo !== true) {
        return;
    }
    if (!validateCurrentAnnotationComplete()) {
        return;
    }
    saveCurrentAnnotations(current_example_idx);
    const current = annotation_set[current_example_idx];
    if (!current.redo_id) {
        alert("This item is missing redo metadata and cannot be saved as redo.");
        return;
    }

    const submissionData = {
        campaign_id: metadata.id,
        annotator_id: annotator_id,
        redo_id: current.redo_id,
        annotation: current,
    };

    $("#redo-save-current-btn").prop("disabled", true).text("Saving...");
    setRedoActionStatus("Saving this redo item...", "muted");
    $.post({
        url: `${url_prefix}/redo/save_item`,
        contentType: 'application/json',
        data: JSON.stringify(submissionData),
        timeout: 30000,
        success: function (response) {
            if (response.success !== true) {
                alert(response.error || "Redo item could not be saved.");
                $("#redo-save-current-btn").prop("disabled", false).text("Save current item");
                setRedoActionStatus(response.error || "Redo item could not be saved.", "danger");
                return;
            }
            redoFinalMessage = response.final_message || redoFinalMessage;
            annotation_set[current_example_idx].redo_status = "completed";
            $(`#page-link-${current_example_idx}`).removeClass("bg-incomplete").addClass("bg-complete");
            if (redo_context.show_completed !== true) {
                $(`#page-link-${current_example_idx}`).closest(".page-item").addClass("redo-saved-hidden").hide();
                $(`#out-text-${current_example_idx}`).hide();
            }
            $("#redo-save-current-btn").prop("disabled", false).text("Save current item");
            setRedoActionStatus("Saved. This is now the current real annotation.", "success");
            goToNextVisibleRedoItem(response.final_message);
        },
        error: function () {
            alert("Redo item could not be saved.");
            $("#redo-save-current-btn").prop("disabled", false).text("Save current item");
            setRedoActionStatus("Redo item could not be saved.", "danger");
        }
    });
}

function keepCurrentRedoItem() {
    if (redo_context.is_redo !== true) {
        return;
    }
    const current = annotation_set[current_example_idx];
    if (!current || !current.redo_id) {
        alert("This item is missing redo metadata and cannot be kept as redo.");
        return;
    }

    $("#redo-keep-current-btn").prop("disabled", true).text("Keeping...");
    setRedoActionStatus("Keeping this annotation without writing a new revision...", "muted");
    $.post({
        url: `${url_prefix}/redo/keep_item`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaign_id: metadata.id,
            annotator_id: annotator_id,
            redo_id: current.redo_id,
        }),
        timeout: 30000,
        success: function (response) {
            if (response.success !== true) {
                alert(response.error || "Redo item could not be kept.");
                $("#redo-keep-current-btn").prop("disabled", false).text("Keep annotation");
                setRedoActionStatus(response.error || "Redo item could not be kept.", "danger");
                return;
            }
            redoFinalMessage = response.final_message || redoFinalMessage;
            annotation_set[current_example_idx].redo_status = "completed";
            $(`#page-link-${current_example_idx}`).removeClass("bg-incomplete").addClass("bg-complete");
            if (redo_context.show_completed !== true) {
                $(`#page-link-${current_example_idx}`).closest(".page-item").addClass("redo-saved-hidden").hide();
                $(`#out-text-${current_example_idx}`).hide();
            }
            $("#redo-keep-current-btn").prop("disabled", false).text("Keep annotation");
            setRedoActionStatus("Kept. The original annotation stays unchanged and the redo item is completed.", "success");
            goToNextVisibleRedoItem(response.final_message);
        },
        error: function () {
            alert("Redo item could not be kept.");
            $("#redo-keep-current-btn").prop("disabled", false).text("Keep annotation");
            setRedoActionStatus("Redo item could not be kept.", "danger");
        }
    });
}

function saveCurrentAnnotationItem() {
    if (!perExampleSaveMode || redo_context.is_redo === true) {
        return;
    }
    if (!validateCurrentAnnotationComplete()) {
        return;
    }
    saveCurrentAnnotations(current_example_idx);
    const current = annotation_set[current_example_idx];

    const submissionData = {
        campaign_id: metadata.id,
        annotator_id: annotator_id,
        annotation: current,
    };

    $("#mark-annotation-complete-btn").prop("disabled", true).text("Saving...");
    $("#submit-annotations-btn").prop("disabled", true);
    setPerExampleActionStatus("Saving this example...", "muted");
    $.post({
        url: `${url_prefix}/save_annotation_item`,
        contentType: 'application/json',
        data: JSON.stringify(submissionData),
        timeout: 30000,
        success: function (response) {
            if (response.success !== true) {
                alert(response.error || "Example could not be saved.");
                $("#mark-annotation-complete-btn").prop("disabled", false).text("✅ Mark example as complete");
                $("#submit-annotations-btn").prop("disabled", false).text(submitButtonText());
                setPerExampleActionStatus(response.error || "Example could not be saved.", "danger");
                return;
            }
            perExampleFinalMessage = response.final_message || perExampleFinalMessage;
            annotation_set[current_example_idx].per_example_saved = true;
            $(`#page-link-${current_example_idx}`).removeClass("bg-incomplete").addClass("bg-complete");
            if (redo_context.show_saved !== true) {
                $(`#page-link-${current_example_idx}`).closest(".page-item").addClass("per-example-saved-hidden").hide();
                $(`#out-text-${current_example_idx}`).hide();
            }
            $("#mark-annotation-complete-btn").prop("disabled", false).text("✅ Mark example as complete");
            $("#submit-annotations-btn").prop("disabled", false).text(submitButtonText());
            setPerExampleActionStatus("Saved.", "success");
            goToNextVisiblePerExampleItem(response.final_message);
        },
        error: function () {
            alert("Example could not be saved.");
            $("#mark-annotation-complete-btn").prop("disabled", false).text("✅ Mark example as complete");
            $("#submit-annotations-btn").prop("disabled", false).text(submitButtonText());
            setPerExampleActionStatus("Example could not be saved.", "danger");
        }
    });
}

function saveCurrentAnnotations(example_idx) {
    const annotations = spanAnnotator.getAnnotations(`p${example_idx}`);

    annotation_set[example_idx]["annotations"] = annotations;
    annotation_set[example_idx]["flags"] = collectFlags();
    annotation_set[example_idx]["options"] = collectOptions();
    annotation_set[example_idx]["sliders"] = collectSliders();
    annotation_set[example_idx]["textFields"] = collectTextFields();
    annotation_set[example_idx]["timeLastSaved"] = Math.floor(Date.now() / 1000);
}

function showPerExampleFinishConfirmation() {
    const modalElement = document.getElementById("per-example-finish-modal");
    if (!modalElement || typeof bootstrap === "undefined") {
        if (window.confirm("Save all remaining examples and finish this batch? Empty examples will be marked as skipped when a skip checkbox is available. You cannot go back after finishing.")) {
            submitAnnotations({ confirmed: true });
        }
        return;
    }

    const modal = new bootstrap.Modal(modalElement);
    $("#per-example-finish-confirm-btn")
        .off("click")
        .on("click", function () {
            modal.hide();
            submitAnnotations({ confirmed: true });
        });
    modal.show();
}

function submitAnnotations(campaign_id, options) {
    let submitOptions = options || {};
    if (typeof campaign_id === "object" && campaign_id !== null) {
        submitOptions = campaign_id;
        campaign_id = undefined;
    }
    if (redo_context.is_redo === true || annotation_set.some(annotation => annotation.redo_id)) {
        alert("Redo annotations must be saved with Save current item.");
        $("#submit-annotations-btn").hide();
        $("#redo-save-current-btn").show();
        return;
    }

    if (annotation_set[current_example_idx]) {
        saveCurrentAnnotations(current_example_idx);
    }

    if (perExampleSaveMode && submitOptions.confirmed !== true) {
        showPerExampleFinishConfirmation();
        return;
    }

    if (perExampleSaveMode) {
        preparePerExampleFinishSubmission();
    }

    // Save to local storage before attempting submission
    saveAnnotationsToLocalStorage();

    const submissionData = {
        campaign_id: metadata.id,
        annotator_id: annotator_id,
        annotation_set: annotation_set
    };

    $("#submit-annotations-btn").prop("disabled", true).text(perExampleSaveMode ? "Saving..." : "Submitting...");

    $.post({
        url: `${url_prefix}/submit_annotations`,
        contentType: 'application/json',
        data: JSON.stringify(submissionData),
        timeout: 30000, // 30 second timeout
        success: function (response) {
            console.log(response);
            window.onbeforeunload = null;

            // Clear local storage backup on successful submission
            clearAnnotationsFromLocalStorage();

            if (response.success !== true) {
                handleSubmissionError(response.error, submissionData);
            } else {
                if (perExampleSaveMode) {
                    annotation_set.forEach((annotation) => {
                        annotation.per_example_saved = true;
                    });
                }
                $("#final-message").html(response.message);
                $("#overlay-end").show();
                syncOverlayScrollLock();
            }
        },
        error: function (xhr, textStatus, errorThrown) {
            console.log('Submission error:', xhr, textStatus, errorThrown);

            handleSubmissionError(submissionData);
        }
    });
}

function handleSubmissionError(submissionData) {
    $("#submit-annotations-btn").prop("disabled", false).text(submitButtonText());

    $("#retry-section").show();
    $("#backup-section").show();
    $("#overlay-fail").show();
    syncOverlayScrollLock();
}

function retrySubmission() {
    // Disable the retry button and show retrying status
    $("#retry-btn").prop("disabled", true).text("Retrying...");

    // Add a brief delay to show the "Retrying..." status and prevent flicker
    setTimeout(() => {
        $("#overlay-fail").hide();
        syncOverlayScrollLock();
        submitAnnotations(perExampleSaveMode ? { confirmed: true } : undefined);
        // Re-enable the button in case of another error
        $("#retry-btn").prop("disabled", false).text("🔄 Retry Now");
    }, 800); // 800ms delay
}

function saveAnnotationsToLocalStorage() {
    try {
        const backupData = {
            timestamp: new Date().toISOString(),
            campaign_id: metadata.id,
            annotator_id: annotator_id,
            annotation_set: annotation_set,
            metadata: {
                total_examples: total_examples
            }
        };

        localStorage.setItem('factgenie_annotation_backup', JSON.stringify(backupData));
        console.log('Annotations saved to local storage');
    } catch (error) {
        console.error('Failed to save annotations to local storage:', error);
    }
}

function clearAnnotationsFromLocalStorage() {
    try {
        localStorage.removeItem('factgenie_annotation_backup');
        console.log('Local storage backup cleared');
    } catch (error) {
        console.error('Failed to clear local storage:', error);
    }
}

function downloadAnnotationBackup() {
    try {
        const backupData = {
            timestamp: new Date().toISOString(),
            campaign_id: metadata.id,
            annotator_id: annotator_id,
            annotation_set: annotation_set,
            metadata: {
                campaign_name: metadata.name || 'Unknown Campaign',
                total_examples: total_examples,
                user_agent: navigator.userAgent,
                url: window.location.href
            }
        };

        const blob = new Blob([JSON.stringify(backupData, null, 2)], {
            type: 'application/json'
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `factgenie_backup_${metadata.id}_${annotator_id}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log('Annotation backup downloaded');
    } catch (error) {
        console.error('Failed to download backup:', error);
        alert('Failed to download backup. Please try again.');
    }
}

function syncOverlayScrollLock() {
    $("body").toggleClass("overlay-open", $(".overlay:visible").length > 0);
}


$("#hideOverlayBtn").click(function () {
    saveOverlayInstructionPreference();
    $("body").addClass("annotation-ui-ready");
    $("#overlay-start").fadeOut(function () {
        syncOverlayScrollLock();
        window.dispatchEvent(new Event("resize"));
    });
});

$("#undo-button").click(function () {
    // Get current document ID based on current example index
    const currentDocId = `p${current_example_idx}`;
    spanAnnotator.undo(currentDocId);
});

$(".btn-err-cat").change(function () {
    if (this.checked) {
        const cat_idx = $(this).attr("data-cat-idx");
        spanAnnotator.setCurrentAnnotationType(cat_idx);
    }
});

$(".btn-eraser").change(function () {
    if (this.checked) {
        spanAnnotator.setCurrentAnnotationType(-1);
    }
});

$(".btn-select").change(function () {
    if (this.checked) {
        spanAnnotator.setCurrentAnnotationType(-2);
    }
});

$('.btn-check').on('change', function () {
    $('.btn-check').each(function () {
        const label = $(`label[for=${this.id}]`);
        if (this.checked) {
            label.addClass('active');
        } else {
            label.removeClass('active');
        }
    });
});

$(document).ready(function () {
    if ($("#overlay-start").is(":hidden")) {
        $("body").addClass("annotation-ui-ready");
    }
    syncOverlayScrollLock();

    initStickyAnnotationCategories();
    applyOverlayInstructionPreference();

    $("#show-overlay-instructions-link").on("click", function (e) {
        e.preventDefault();
        $("#overlay-start-hidden-message").hide();
        $("#overlay-start-instructions").show();
    });

    $("#close-error-overlay-btn").click(function () {
        setTimeout(syncOverlayScrollLock, 0);
    });

    $("#annotator-auth-login-btn").click(function () {
        setAnnotatorAuthMode("login");
    });
    $("#annotator-auth-register-btn").click(function () {
        setAnnotatorAuthMode("register");
    });
    $("#annotator-auth-submit-btn").click(function () {
        submitAnnotatorAuth();
    });
    $("#annotator-name-input").on("keydown", function (e) {
        if (e.key === "Enter") {
            e.preventDefault();
            submitAnnotatorAuth();
        }
    });

    ensureAnnotatorAuth().then(() => {
        loadAnnotations();
        $("#total-examples").html(total_examples - 1);
        enableTooltips();
    });

    // Auto-save to local storage every 30 seconds while annotating
    setInterval(function () {
        if (annotation_set && annotation_set.length > 0) {
            saveAnnotationsToLocalStorage();
        }
    }, 30000);
});

window.onbeforeunload = function () {
    return "Are you sure you want to reload the page? Your work will be lost.";
}
