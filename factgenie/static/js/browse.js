var current_example_idx = 0;
var selected_campaigns = [];
var collapsed_boxes = [];
var showAnnotatorNames = false;
var preferredAnnotatorIds = [];
var browseFilterSchema = {};
var filteredResults = [];
var filteredQueueActive = false;
var filteredQueueIndex = 0;
var activeBrowseMatchDetails = [];
var browseHighlightsEnabled = true;
var browsePreviewMatchActive = false;
var browseResultUnitLabel = "question";
var browseResultUnitPlural = "questions";
var currentAnnInfo = new Map();
var annotatorAliases = new Map();
var annotatorAliasList = [
    "Tokyo",
    "Paris",
    "London",
    "New York",
    "Sydney",
    "Berlin",
    "Rome",
    "Cairo",
    "Mumbai",
    "Mexico City",
];
var annotatorAliasStorageKey = "factgenie_browse_annotator_aliases";
const DEFAULT_SPLIT_SIZES = [66, 33];
const SPLIT_STORAGE_KEY = "factgenie:splitSizes";
const REDO_PREVIEW_MATCH_PREFIX = "factgenie_redo_preview_match:";

function loadSplitSizes() {
    try {
        return JSON.parse(localStorage.getItem(SPLIT_STORAGE_KEY)) || DEFAULT_SPLIT_SIZES;
    } catch {
        return DEFAULT_SPLIT_SIZES;
    }
}

function saveSplitSizes() {
    localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(splitInstance.getSizes()));
}

var splitInstance = Split(['#centerpanel', '#rightpanel'], {
    sizes: loadSplitSizes(),
    gutterSize: 1,
});

function normalizeNewlines(text) {
    if (text === null || text === undefined) return "";
    return String(text)
        .replace(/\r\n/g, "\n")
        .replace(/\\r\\n/g, "\n")
        .replace(/\\n/g, "\n");
}

function escapeHtml(text) {
    return $('<div>').text(String(text ?? "")).html();
}

function normalizeAnnotatorKey(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) {
        return "";
    }
    return text.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isInvalidAnnotatorId(value) {
    if (typeof value === "number" && Number.isNaN(value)) {
        return true;
    }
    const text = String(value || "").trim();
    if (!text) {
        return false;
    }
    return text.toLowerCase() === "nan";
}

function isTruthyFlagValue(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value !== 0 && !Number.isNaN(value);
    }
    const text = String(value || "").trim().toLowerCase();
    if (!text) {
        return false;
    }
    return !["false", "0", "no", "off"].includes(text);
}

function normalizeFlagLabel(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function isSkipSelected(annotations) {
    const flags = annotations?.flags || [];
    return flags.some((flag) => {
        const label = normalizeFlagLabel(flag?.label);
        if (!label.includes("skip") && !label.includes("preskoc")) {
            return false;
        }
        return isTruthyFlagValue(flag?.value);
    });
}

function getAnnotatorAliasKey(campaignId, annotatorId) {
    const campaignKey = normalizeAnnotatorKey(campaignId);
    const annotatorKey = normalizeAnnotatorKey(annotatorId);
    if (!campaignKey || !annotatorKey) {
        return "";
    }
    return `${campaignKey}:${annotatorKey}`;
}

function loadAnnotatorAliases() {
    try {
        const stored = localStorage.getItem(annotatorAliasStorageKey);
        if (!stored) {
            return;
        }
        const data = JSON.parse(stored);
        if (!data || typeof data !== "object") {
            return;
        }
        Object.entries(data).forEach(([key, value]) => {
            if (key && value) {
                annotatorAliases.set(key, value);
            }
        });
    } catch (error) {
        console.warn("Failed to load annotator aliases.", error);
    }
}

function saveAnnotatorAliases() {
    try {
        const data = Object.fromEntries(annotatorAliases.entries());
        localStorage.setItem(annotatorAliasStorageKey, JSON.stringify(data));
    } catch (error) {
        console.warn("Failed to save annotator aliases.", error);
    }
}

function getOrCreateAnnotatorAlias(campaignId, annotatorId) {
    const key = getAnnotatorAliasKey(campaignId, annotatorId);
    if (!key) {
        return "";
    }
    const campaignKey = `${normalizeAnnotatorKey(campaignId)}:`;
    const campaignEntries = Array.from(annotatorAliases.entries())
        .filter(([aliasKey]) => aliasKey.startsWith(campaignKey) && aliasKey !== key);
    const usedAliases = new Set(campaignEntries.map(([, value]) => value));

    if (annotatorAliases.has(key)) {
        const currentAlias = annotatorAliases.get(key);
        if (!usedAliases.has(currentAlias)) {
            return currentAlias;
        }
    }

    let index = 0;
    let alias = "";
    while (true) {
        const baseIndex = index % annotatorAliasList.length;
        const suffixIndex = Math.floor(index / annotatorAliasList.length) + 1;
        alias = annotatorAliasList[baseIndex];
        if (suffixIndex > 1) {
            alias = `${alias} ${suffixIndex}`;
        }
        if (!usedAliases.has(alias)) {
            break;
        }
        index += 1;
    }

    annotatorAliases.set(key, alias);
    saveAnnotatorAliases();
    return alias;
}

function generateAnnotatorKey(campaign_id, annotator_id) {
    const key = normalizeAnnotatorKey(annotator_id);
    if (!key) {
        return null;
    }
    return `${campaign_id}-ann-${key}`;
}

function changeDataset() {
    $("#dataset-spinner").show();
    const dataset = $('#dataset-select').val();

    // set available splits in #split-select
    $('#split-select').empty();
    for (const split of datasets[dataset].splits) {
        $('#split-select').append(`<option value="${split}">${split}</option>`);
    }
    const split = $('#split-select').val();

    current_example_idx = 0;
    clearFilteredQueue();
    loadBrowseFilterSchema();
    fetchExample(dataset, split, current_example_idx);
    $("#page-input").val(current_example_idx);
}

function changeSplit() {
    $("#dataset-spinner").show();
    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();
    current_example_idx = 0;
    clearFilteredQueue();
    loadBrowseFilterSchema();
    fetchExample(dataset, split, current_example_idx);
    $("#page-input").val(current_example_idx);
}

function changeExample(dataset, split, example_idx) {
    $("#dataset-spinner").show();
    $('#dataset-select').val(dataset);
    $('#split-select').empty();
    for (const split of datasets[dataset].splits) {
        $('#split-select').append(`<option value="${split}">${split}</option>`);
    }
    $('#split-select').val(split);
    current_example_idx = example_idx;
    fetchExample(dataset, split, example_idx);
    $("#page-input").val(example_idx);
}


function createOutputBox(content, exampleLevelFields, annId, annLabel, setup_id, extraClasses = "") {
    var card = $('<div>', { class: `card output-box generated-output-box box-${setup_id} box-${annId} box-${setup_id}-${annId} ${extraClasses}`.trim() });
    card.attr("data-setup-id", setup_id);
    card.attr("data-ann-id", annId);

    const badgeLabel = annLabel || annId;
    var annotationBadge = (annId !== "original")
        ? (showAnnotatorNames
            ? `<span class="small">${badgeLabel}</span>`
            : `<span class="small"><i class="fa fa-pencil"></i> ${badgeLabel}</span>`)
        : "";
    var permalinkButton = `<button class="btn btn-link p-0 text-muted permalink-btn" data-setup-id="${setup_id}" data-ann-id="${annId}" title="Copy permalink to clipboard"><i class="fa fa-link"></i></button>`;
    var headerHTML = `<div class="d-flex justify-content-between">
    <span class="small">${setup_id}</span>
    <div class="d-flex align-items-center gap-2">
        ${annotationBadge}
        ${permalinkButton}
    </div>
    </div>
    `
    var cardHeader = $('<div>', { class: "card-header card-header-collapse small", "data-bs-toggle": "collapse", "data-bs-target": `#out-${setup_id}-${annId}` }).html(headerHTML);
    var cardBody = $('<div>', { class: "card-body show", id: `out-${setup_id}-${annId}`, "aria-expanded": "true" });
    // var cardTitle = $('<h5>', { class: "card-title" }).text(setup_id);
    var cardText = $('<div>', { class: "card-text mt-2" }).html(content);

    // cardBody.append(cardTitle);
    cardBody.append(cardText);
    card.append(cardHeader);
    card.append(cardBody);

    if (exampleLevelFields !== null) {
        cardBody.append(exampleLevelFields);
    }

    return card;
}

function generatePermalink(setup_id, ann_id) {
    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();
    const example_idx = current_example_idx;

    let permalink = `${window.location.origin}${url_prefix}/browse?dataset=${dataset}&split=${split}&example_idx=${example_idx}&setup_id=${setup_id}`;

    if (ann_id !== "original") {
        permalink += `&ann_campaign=${ann_id}`;
    }

    return permalink;
}

function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;

    // Avoid scrolling to bottom
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            console.log('Fallback: Copying text command was successful');
            return true;
        } else {
            console.log('Fallback: Copying text command was unsuccessful');
            return false;
        }
    } catch (err) {
        console.error('Fallback: Oops, unable to copy', err);
        return false;
    } finally {
        document.body.removeChild(textArea);
    }
}

function generateAnnotatorShortId(campaign_id, annotator_group) {
    const ann_id = `${campaign_id}-ann${annotator_group}`;
    return ann_id;
}

function buildAnnotationInfo(generated_outputs) {
    const annIds = new Map();

    generated_outputs.forEach(output => {
        output.annotations.forEach(annotation => {
            const campaign_id = annotation.campaign_id;
            const annotator_group = annotation.annotator_group;
            const annotator_id = String(annotation.annotator_id || "").trim();
            const annotator_alias = String(annotation.annotator_alias || "").trim();
            const hasAnnotatorId = annotator_id !== "" && !isInvalidAnnotatorId(annotator_id);
            if (!campaign_id) {
                return;
            }
            const ann_id = (hasAnnotatorId ? generateAnnotatorKey(campaign_id, annotator_id) : null) ||
                (annotator_alias ? generateAnnotatorKey(campaign_id, annotator_alias) : null) ||
                generateAnnotatorShortId(campaign_id, annotator_group);

            if (!annIds.has(ann_id)) {
                annIds.set(ann_id, {
                    campaign_id: campaign_id,
                    annotator_group: annotator_group,
                    annotator_id: hasAnnotatorId ? annotator_id : null,
                    annotator_ids: new Set(),
                    annotator_aliases: new Set(),
                    has_non_skipped_annotation: false,
                    has_skipped_annotation: false,
                });
            }
            const isSkipped = isSkipSelected(annotation);
            if (isSkipped) {
                annIds.get(ann_id).has_skipped_annotation = true;
            } else {
                annIds.get(ann_id).has_non_skipped_annotation = true;
            }
            if (hasAnnotatorId) {
                annIds.get(ann_id).annotator_ids.add(annotator_id);
            }
            let alias = annotator_alias;
            if (!alias && hasAnnotatorId) {
                alias = getOrCreateAnnotatorAlias(campaign_id, annotator_id);
            }
            if (alias) {
                annIds.get(ann_id).annotator_aliases.add(alias);
            }
        });
    });

    return annIds;
}

function getAnnotatorAliasCounts() {
    const counts = new Map();
    currentAnnInfo.forEach((annInfo) => {
        getAnnotatorAliases(annInfo).forEach((alias) => {
            counts.set(alias, (counts.get(alias) || 0) + 1);
        });
    });
    return counts;
}

function getAnnotatorQualifier(annId, annInfo) {
    const campaignId = String(annInfo?.campaign_id || "").trim();
    if (campaignId) {
        return campaignId;
    }

    const names = getAnnotatorNames(annInfo);
    if (names.length > 0) {
        return names.join(", ");
    }

    return String(annId || "").trim();
}

function getDisplayAnnotatorAliases(annId, annInfo) {
    const aliases = getAnnotatorAliases(annInfo);
    if (aliases.length === 0) {
        return [];
    }

    const aliasCounts = getAnnotatorAliasCounts();
    const qualifier = getAnnotatorQualifier(annId, annInfo);

    return aliases.map((alias) => {
        if ((aliasCounts.get(alias) || 0) <= 1 || !qualifier) {
            return alias;
        }
        return `${alias} [${qualifier}]`;
    });
}

function getAnnotatorPrimaryLabel(annId, annInfo) {
    if (!annInfo) {
        return String(annId || "");
    }
    const aliases = getDisplayAnnotatorAliases(annId, annInfo);
    if (aliases.length > 0) {
        return aliases.join(", ");
    }
    const names = getAnnotatorNames(annInfo);
    if (names.length > 0) {
        return names.join(", ");
    }
    return String(annId || "");
}

function getAnnotatorLabel(annId, annInfo) {
    return getAnnotatorPrimaryLabel(annId, annInfo);
}

function getAnnotatorLabelHtml(annId, annInfo) {
    if (!showAnnotatorNames) {
        const primaryLabel = getAnnotatorPrimaryLabel(annId, annInfo);
        const primaryHtml = `<span class="annotator-primary-label">${escapeHtml(primaryLabel)}</span>`;
        return primaryHtml;
    }

    const names = getAnnotatorNames(annInfo);
    if (names.length === 0) {
        const fallbackLabel = getAnnotatorPrimaryLabel(annId, annInfo);
        return `<span class="annotator-primary-label">${escapeHtml(fallbackLabel)}</span>`;
    }

    return `<span class="annotator-primary-label">${escapeHtml(names.join(", "))}</span>`;
}

function getAnnotatorDisplayBoth(annId, annInfo) {
    const aliases = getDisplayAnnotatorAliases(annId, annInfo);
    const names = getAnnotatorNames(annInfo);

    if (aliases.length > 0 && names.length > 0) {
        return `${aliases.join(", ")} (${names.join(", ")})`;
    }
    if (aliases.length > 0) {
        return aliases.join(", ");
    }
    if (names.length > 0) {
        return names.join(", ");
    }
    return "unknown annotator";
}

function getSkipMessage(annInfo, annotations) {
    const who = getAnnotatorDisplayBoth(annotations?.annotator_id, annInfo);
    const skipFlags = (annotations?.flags || [])
        .filter((flag) => {
            const label = normalizeFlagLabel(flag?.label);
            return (label.includes("skip") || label.includes("preskoc")) && isTruthyFlagValue(flag?.value);
        })
        .map((flag) => String(flag?.label || "skip").trim())
        .filter((label) => label.length > 0);

    const details = skipFlags.length > 0
        ? `<div class="small text-muted mt-1">${skipFlags.join(", ")}</div>`
        : "";

    return `
        <div class="alert alert-warning mb-0 py-2 px-3" role="alert">
            <div><b>Skipped annotation</b> by ${who}.</div>
            ${details}
        </div>
    `;
}

function getAnnotatorNames(annInfo) {
    const names = Array.from(annInfo?.annotator_ids || [])
        .map((name) => String(name || "").trim())
        .filter((name) => name !== "");
    const primaryName = String(annInfo?.annotator_id || "").trim();
    if (primaryName) {
        names.push(primaryName);
    }
    return Array.from(new Set(names));
}

function getAnnotatorAliases(annInfo) {
    const aliases = Array.from(annInfo?.annotator_aliases || [])
        .map((alias) => String(alias || "").trim())
        .filter((alias) => alias !== "");
    return Array.from(new Set(aliases));
}

function getAnnotatorSortKey(annId, annInfo) {
    const names = getAnnotatorNames(annInfo)
        .map((name) => String(name).toLowerCase())
        .sort();
    if (names.length > 0) {
        return names[0];
    }
    return String(annId).toLowerCase();
}

function savePreferredAnnotatorsFromSelection(selection) {
    preferredAnnotatorIds = Array.from(new Set((selection || [])
        .map((annId) => String(annId || "").trim())
        .filter((annId) => annId !== "")));
}

function getSelectableAnnotatorIds() {
    return $(".btn-ann-select").not(".btn-ann-select-skipped").map(function () {
        return $(this).data('ann');
    }).get();
}

function setActiveAnnotatorButtons(annIds) {
    const selectableSet = new Set(getSelectableAnnotatorIds());
    const activeSet = new Set((annIds || []).filter((annId) => selectableSet.has(annId)));
    $(".btn-ann-select").each(function () {
        const annId = $(this).data('ann');
        if (activeSet.has(annId)) {
            $(this).addClass("active");
        } else {
            $(this).removeClass("active");
        }
    });
}

function resolveSelectableAnnotatorId(value, availableSet) {
    const requested = String(value || "").trim();
    if (!requested) {
        return null;
    }
    if (availableSet.has(requested)) {
        return requested;
    }
    const requestedKey = normalizeAnnotatorKey(requested);
    for (const [annId, info] of currentAnnInfo.entries()) {
        if (!availableSet.has(annId)) {
            continue;
        }
        const campaignId = String(info?.campaign_id || "").trim();
        const candidates = [annId];
        if (info?.annotator_id) {
            candidates.push(String(info.annotator_id).trim());
            if (campaignId) {
                candidates.push(generateAnnotatorKey(campaignId, info.annotator_id));
            }
        }
        getAnnotatorNames(info).forEach((name) => candidates.push(name));
        getAnnotatorAliases(info).forEach((alias) => candidates.push(alias));
        if (candidates.some((candidate) => {
            const candidateText = String(candidate || "").trim();
            return candidateText === requested || normalizeAnnotatorKey(candidateText) === requestedKey;
        })) {
            return annId;
        }
    }
    return null;
}

function currentExampleCanShowAnnotatorNames() {
    if ($("#toggle-annotator-names-btn").length === 0) {
        return false;
    }
    for (const annInfo of currentAnnInfo.values()) {
        if (getAnnotatorNames(annInfo).length > 0) {
            return true;
        }
    }
    return false;
}

function updateAnnotatorNamesToggleAvailability() {
    const button = $("#toggle-annotator-names-btn");
    if (button.length === 0) {
        showAnnotatorNames = false;
        return;
    }

    const canShowNames = currentExampleCanShowAnnotatorNames();
    button.closest(".page-item").toggle(canShowNames);
    if (!canShowNames) {
        showAnnotatorNames = false;
    }

    const label = showAnnotatorNames ? "Hide annotator names" : "Show annotator names";
    button.find("small").text(label);
}

function createOutputBoxes(generated_outputs) {
    // clear the output area
    $("#outputarea").empty();

    // sort outputs by setup id
    generated_outputs.sort(function (a, b) {
        return a.setup_id.localeCompare(b.setup_id);
    });

    // find all campaign ids in output annotations
    const annIds = buildAnnotationInfo(generated_outputs);
    currentAnnInfo = annIds;
    updateAnnotatorNamesToggleAvailability();

    const selectBox = $("#annotations-select");
    // clear the selectbox
    selectBox.empty();

    const sortedAnnIds = Array.from(annIds.keys()).sort((a, b) => {
        const aInfo = annIds.get(a);
        const bInfo = annIds.get(b);
        const aKey = getAnnotatorSortKey(a, aInfo);
        const bKey = getAnnotatorSortKey(b, bInfo);
        if (aKey === bKey) {
            return String(a).localeCompare(String(b));
        }
        return aKey.localeCompare(bKey);
    });
    const selectorAnnIds = sortedAnnIds.filter((annId) => {
        const info = annIds.get(annId);
        return showAnnotatorNames || info?.has_non_skipped_annotation;
    });

    // add an option for each campaign id
    for (const ann_id of selectorAnnIds) {
        const annInfo = annIds.get(ann_id);
        const annLabel = getAnnotatorLabelHtml(ann_id, annInfo);
        const isSkippedOnly = !annInfo?.has_non_skipped_annotation && annInfo?.has_skipped_annotation;
        const extraClasses = isSkippedOnly ? " btn-ann-select-skipped disabled" : "";
        const disabledAttr = isSkippedOnly ? ' disabled aria-disabled="true"' : "";
        const button = $(`<button type="button" class="btn btn-sm btn-primary btn-ann-select${extraClasses}" data-ann="${ann_id}"${disabledAttr}>${annLabel}</button>`);
        if (!isSkippedOnly) {
            button.on('click', function () {
                $(this).toggleClass('active');
                const activeSelection = $('.btn-ann-select.active').map(function () {
                    return $(this).data('ann');
                }).get();
                savePreferredAnnotatorsFromSelection(activeSelection);
                updateDisplayedAnnotations();
            });
        }
        selectBox.append(button);
    }
    if (annIds.size > 0) {
        $("#setuparea").show();
    } else {
        $("#setuparea").hide();
    }

    // add the annotated outputs
    for (const output of generated_outputs) {
        var groupDiv = $('<div>', { class: `output-group box-${output.setup_id} d-inline-flex gap-2` });
        groupDiv.appendTo("#outputarea");

        const plain_output = getAnnotatedOutput(output, "original", null);
        card = createOutputBox(plain_output, null, "original", null, output.setup_id);
        card.appendTo(groupDiv);

        for (const annId of sortedAnnIds) {
            const info = annIds.get(annId);
            let annotations = null;
            if (info.annotator_id) {
                annotations = output.annotations.find(a => a.campaign_id == info.campaign_id && a.annotator_id == info.annotator_id) || null;
            }
            if (!annotations) {
                const aliases = getAnnotatorAliases(info);
                annotations = output.annotations.find(a => a.campaign_id == info.campaign_id && aliases.includes(String(a.annotator_alias || "").trim())) || null;
            }
            if (!annotations) {
                annotations = output.annotations.find(a => a.campaign_id == info.campaign_id && a.annotator_group == info.annotator_group) || null;
            }
            if (!annotations) {
                continue;
            }

            const annInfo = annIds.get(annId);
            const isSkipped = isSkipSelected(annotations);
            const annotated_output = isSkipped
                ? getAnnotatedOutput(output, annId, null, false)
                : getAnnotatedOutput(output, annId, annotations);

            let exampleLevelFields;
            if (isSkipped) {
                exampleLevelFields = $('<div>', { class: "p-2 extra-fields" });
                exampleLevelFields.append($('<div>', { class: "small text-muted fw-bold" }).text('skip = True'));
            } else {
                exampleLevelFields = getExampleLevelFields(annotations);
            }

            const annLabel = getAnnotatorLabelHtml(annId, annInfo);
            const extraClasses = isSkipped ? "output-box-skipped" : "";
            card = createOutputBox(annotated_output, exampleLevelFields, annId, annLabel, output.setup_id, extraClasses);
            card.appendTo(groupDiv);
            card.hide();
        }
    }
}

function highlightSetup() {
    // Remove any previous highlighting
    $(".output-box").removeClass('border border-primary border-2');
    $(".output-group").css({ animation: 'none' });

    // If no highlight parameters are set, exit early
    if (!window.highlight_setup_id) {
        return;
    }

    // Get all output groups that match the highlighted setup_id
    const matchingGroups = $(`.output-group.box-${window.highlight_setup_id}`);

    // Apply animation to matching groups
    matchingGroups.css({ animation: 'jump-out 0.5s ease' });

    if (window.highlight_ann_campaign) {
        // If both setup_id and campaign are highlighted, highlight that specific box
        const specificBox = $(".output-box").filter(function () {
            return String($(this).data("setup-id") || "") === String(window.highlight_setup_id) &&
                String($(this).data("ann-id") || "") === String(window.highlight_ann_campaign);
        });
        specificBox.addClass('border border-primary border-2');

        // Make sure the highlighted campaign is visible if not already
        if (!specificBox.is(":visible")) {
            // Add this campaign to selected campaigns if not already there
            const highlightButton = $(`.btn-ann-select[data-ann="${window.highlight_ann_campaign}"]`);
            if (!selected_campaigns.includes(window.highlight_ann_campaign) && !highlightButton.hasClass("btn-ann-select-skipped")) {
                highlightButton.addClass("active");
                selected_campaigns.push(window.highlight_ann_campaign);
                updateDisplayedAnnotations();
            }
        }

        // Scroll to the specific highlighted box after a brief delay to ensure it's visible
        setTimeout(function () {
            if (specificBox.is(":visible")) {
                specificBox[0].scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        }, 100);
    } else {
        // If only setup_id is highlighted, highlight all boxes with that setup_id that are currently visible
        const visibleBoxes = $(".output-box:visible").filter(function () {
            return String($(this).data("setup-id") || "") === String(window.highlight_setup_id);
        });
        visibleBoxes.addClass('border border-primary border-2');

        // Scroll to the first visible highlighted box
        if (visibleBoxes.length > 0) {
            setTimeout(function () {
                visibleBoxes[0].scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }, 100);
        }
    }
}

function getDetailAnnotatorId(detail) {
    const rawId = String(detail?.annotator_id || "").trim();
    const campaignId = String(detail?.campaign_id || "").trim();
    if (rawId && campaignId) {
        return generateAnnotatorKey(campaignId, rawId) || rawId;
    }
    return String(detail?.annotator_alias || rawId || "").trim();
}

function getDetailAnnotatorIds(detail) {
    const ids = [];
    const rawId = String(detail?.annotator_id || "").trim();
    const campaignId = String(detail?.campaign_id || "").trim();
    const alias = String(detail?.annotator_alias || "").trim();
    if (rawId && campaignId) {
        ids.push(generateAnnotatorKey(campaignId, rawId) || rawId);
    }
    if (rawId) {
        ids.push(rawId);
    }
    if (alias) {
        currentAnnInfo.forEach(function (info, annId) {
            if (getAnnotatorAliases(info).includes(alias) && (!campaignId || String(info?.campaign_id || "") === campaignId)) {
                ids.push(annId);
            }
        });
        ids.push(alias);
    }
    return Array.from(new Set(ids.filter((value) => String(value || "").trim())));
}

function matchedAnnotatorIdsFromDetails(details) {
    const ids = [];
    (details || []).forEach(function (detail) {
        getDetailAnnotatorIds(detail).forEach(function (annId) {
            if (annId && !ids.includes(annId)) {
                ids.push(annId);
            }
        });
    });
    return ids;
}

function browseDetailBox(detail) {
    const setupId = String(detail?.setup_id || "");
    const annIds = getDetailAnnotatorIds(detail);
    if (setupId && annIds.length) {
        return $(".output-box").filter(function () {
            return String($(this).data("setup-id") || "") === setupId && annIds.includes(String($(this).data("ann-id") || ""));
        });
    }
    if (setupId) {
        return $(".output-box").filter(function () {
            return String($(this).data("setup-id") || "") === setupId;
        });
    }
    if (annIds.length) {
        return $(".output-box").filter(function () {
            return annIds.includes(String($(this).data("ann-id") || ""));
        });
    }
    return $();
}

function detailLabel(detail) {
    // Visible Browse labels intentionally differ from backend field names.
    const fieldLabels = {
        setup: "Answer source",
        annotation_state: "State",
        annotator: "Annotator",
        span_category: "Span category",
        span_reason: "Span reason",
        span_text: "Span text",
        question: "Question",
        output: "Answer",
        any_text: "Any text",
        slider: "Slider",
    };
    const opLabels = {
        contains: "contains",
        not_contains: "does not contain",
        eq: "is",
        neq: "is not",
        missing: "is missing",
        not_missing: "is not missing",
        regex: "matches regex",
        not_regex: "does not match regex",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
    };
    const field = fieldLabels[detail.field] || detail.field || "Filter";
    const op = opLabels[detail.op] || detail.op || "";
    const setup = detail.setup_id ? ` · ${detail.setup_id}` : "";
    const who = detailAnnotatorLabel(detail);
    if (detail.target === "span") {
        const spanText = shortenMatchText(detail.span_text || detail.matched_text || detail.reason || "", 60);
        const category = detail.category ? `${detail.category}: ` : "";
        return `Span ${category}${spanText || "(empty)"}${setup}${who}`;
    }
    const value = detail.slider_label
        ? `${detail.slider_label}${detail.value ? ` ${detail.value}` : ""}`
        : (detail.matched_text || detail.value || detail.span_text || detail.reason || "");
    return `${field} ${op}${value ? ` ${shortenMatchText(value, 60)}` : ""}${setup}${who}`;
}

function detailAnnotatorLabel(detail) {
    const alias = String(detail?.annotator_alias || "").trim();
    const rawId = String(detail?.annotator_id || "").trim();
    if (alias && rawId && alias !== rawId) {
        return ` · ${alias} (${rawId})`;
    }
    if (alias || rawId) {
        return ` · ${alias || rawId}`;
    }
    return "";
}

function shortenMatchText(text, maxLength) {
    const normalized = String(text || "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function renderBrowseMatchDetails() {
    const panel = $("#browse-match-details");
    panel.empty();
    if (!(filteredQueueActive || browsePreviewMatchActive) || !activeBrowseMatchDetails.length) {
        panel.hide();
        return;
    }
    panel.append($('<div>', { class: "small text-muted mb-1" }).text("Matched occurrences in this question"));
    const chips = $('<div>');
    activeBrowseMatchDetails.forEach(function (detail) {
        const chip = $('<span>', { class: "browse-match-chip", title: detailLabel(detail) });
        chip.text(detailLabel(detail));
        chips.append(chip);
    });
    panel.append(chips).show();
}

function clearBrowseMatchHighlights() {
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
    $(".browse-match-box").removeClass("browse-match-box border border-primary border-2");
}

function markTextNodes(container, text) {
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

function markAnnotatableRange(box, start, length) {
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

function markAnnotatableText(box, text) {
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

function applyBrowseMatchHighlights() {
    clearBrowseMatchHighlights();
    if (!browseHighlightsEnabled || !(filteredQueueActive || browsePreviewMatchActive) || !activeBrowseMatchDetails.length) {
        return;
    }
    activeBrowseMatchDetails.forEach(function (detail) {
        const box = browseDetailBox(detail);
        if (detail.target === "span") {
            const marked = markAnnotatableRange(box, detail.start, String(detail.span_text || "").length);
            if (!marked) {
                markAnnotatableText(box, detail.span_text || detail.matched_text);
            }
            box.addClass("browse-match-box border border-primary border-2");
        } else if (detail.target === "slider") {
            box.find(".browse-slider-row").filter(function () {
                return String($(this).data("slider-label") || "") === String(detail.slider_label || detail.sliderLabel || "");
            }).addClass("browse-match-slider");
            box.addClass("browse-match-box border border-primary border-2");
        } else if (detail.target === "question") {
            markTextNodes($("#examplearea"), detail.matched_text || detail.value);
        } else if (detail.target === "output") {
            if (!markAnnotatableText(box, detail.matched_text || detail.value)) {
                markTextNodes(box, detail.matched_text || detail.value);
            }
            box.addClass("browse-match-box border border-primary border-2");
        } else if (detail.matched_text) {
            markTextNodes(box.length ? box : $("#examplearea"), detail.matched_text);
        }
    });
}

function fetchExample(dataset, split, example_idx) {
    saveSplitSizes();
    // change the URL so that it shows the permalink
    const newUrl = `${url_prefix}/browse?dataset=${dataset}&split=${split}&example_idx=${example_idx}`;

    // the check prevents being stuck at the same URL
    if (!window.location.href.includes(newUrl)) {
        history.pushState(null, '', newUrl);
    }
    $.get(`${url_prefix}/example`, {
        "dataset": dataset,
        "example_idx": example_idx,
        "split": split,
    }, function (data) {
        if (data.error !== undefined) {
            console.log(data.error);
            alert(data.error);
            return;
        }
        $("#dataset-spinner").hide();

        if (data.html === null) {
            $("#centerpanel").hide();
            // disable Split.js
            splitInstance.setSizes([0, 100]);
            // center the right panel
            $("#rightpanel").css("width", "50%");
            $("#rightpanel").css("margin", "auto");

        } else {
            $("#examplearea").html(data.html);
            $("#centerpanel").show();
            // enable Split.js
            splitInstance.setSizes(loadSplitSizes());
            // reset the right panel width
        }

        showRawData(data);

        total_examples = datasets[dataset].example_count[split];
        $("#total-examples").html(total_examples - 1);

        window.generated_outputs = data.generated_outputs;

        createOutputBoxes(data.generated_outputs);
        showSelectedCampaigns();
        updateDisplayedAnnotations();
        highlightSetup();
        applyBrowseMatchHighlights();


        window.highlight_ann_campaign = null;
        window.highlight_setup_id = null;
        window.highlight_ann_campaigns = [];
    }).fail(function (response) {
        console.log(response);
        alert("Failed to fetch example.");
    });
}

function getAnnotatedOutput(output, annId, annotations, muteMissing = true) {
    const setup_id = output.setup_id;
    const normalized = normalizeNewlines(output.output);
    const contentHtml = normalized.replace(/\n/g, '<br>');

    var placeholder = $('<pre>', { id: `out-${setup_id}-${annId}-placeholder`, class: `font-mono out-placeholder out-${annId}-placeholder` });
    var annotated_content;

    if (annotations !== null && annotations !== undefined) {
        const annotation_span_categories = annotations.annotation_span_categories;

        // always enable showing overlapping annotations
        const overlapAllowed = true;
        // don't collect reasons when just browsing existing annotations
        const annotateReason = false;
        spanAnnotator.init(annotations.annotation_granularity, overlapAllowed, annotation_span_categories, annotateReason);

        const parId = `out-text-${annId}-par`;

        annotated_content = $('<p>', { id: parId });
        spanAnnotator.addDocument(parId, annotated_content, false, normalized);
        spanAnnotator.addAnnotations(parId, annotations.annotations);
    } else {
        // we do not have outputs for the particular campaign -> grey out the text
        if (annId != "original" && muteMissing) {
            placeholder.css("color", "#c2c2c2");
        }
        annotated_content = contentHtml;
    }
    placeholder.html(annotated_content);
    // placeholder.hide();
    return placeholder;
}

function getExampleLevelFields(annotations) {
    if (annotations === null || annotations === undefined) {
        return null;
    }
    // show `outputs.flags`, `outputs.options`, and `outputs.textFields`
    var flags = (annotations.flags || []).filter((flag) => {
        const label = normalizeFlagLabel(flag?.label);
        if ((label.includes("skip") || label.includes("preskoc")) && !isTruthyFlagValue(flag?.value)) {
            return false;
        }
        return true;
    });
    var options = annotations.options;
    var sliders = annotations.sliders;
    var textFields = annotations.text_fields;

    var html = $('<div>', { class: "p-2 extra-fields" });

    if (flags !== undefined && flags.length > 0) {
        var flagsDiv = $('<div>', { class: "small" });
        // flagsDiv.append($('<span class="badge bg-secondary">').html("Flags"));
        for (const flag of flags) {
            var labelDiv = $('<div>', { class: "small text-muted " }).text(`${flag.label}`);
            var valueDiv = $('<div>', { class: "small mb-1 fw-bold" }).text(`${flag.value}`);

            flagsDiv.append(labelDiv);
            flagsDiv.append(valueDiv);
        }
        html.append(flagsDiv);
    }

    if (options !== undefined && options.length > 0) {
        var optionsDiv = $('<div>', { class: "small" });

        for (const option of options) {
            var labelDiv = $('<div>', { class: "small text-muted" }).text(`${option.label}`);
            var valueDiv = $('<div>', { class: "small mb-1 fw-bold" }).text(`${option.value}`);

            optionsDiv.append(labelDiv);
            optionsDiv.append(valueDiv);
        }
        html.append(optionsDiv);
    }

    if (sliders !== undefined && sliders.length > 0) {
        var slidersDiv = $('<div>', { class: "small" });

        for (const slider of sliders) {
            var sliderRow = $('<div>', { class: "browse-slider-row", "data-slider-label": String(slider.label || "") });
            var labelDiv = $('<div>', { class: "small text-muted" }).text(`${slider.label}`);
            var valueDiv = $('<div>', { class: "small mb-1 fw-bold" }).text(`${slider.value}`);

            sliderRow.append(labelDiv);
            sliderRow.append(valueDiv);
            slidersDiv.append(sliderRow);
        }
        html.append(slidersDiv);
    }

    if (textFields !== undefined && textFields.length > 0) {
        var textFieldsDiv = $('<div>', { class: "small" });

        for (const textField of textFields) {
            var labelDiv = $('<div>', { class: "small text-muted" }).text(`${textField.label}`);
            var valueDiv = $('<div>', { class: "small mb-1 fw-bold" }).text(`${textField.value}`);

            textFieldsDiv.append(labelDiv);
            textFieldsDiv.append(valueDiv);
        }
        html.append(textFieldsDiv);
    }
    return html;
}

function browseTextOperators(field) {
    if (field === "slider") {
        return [
            ["eq", "equals"],
            ["neq", "does not equal"],
            ["gt", ">"],
            ["gte", ">="],
            ["lt", "<"],
            ["lte", "<="],
            ["missing", "is missing"],
            ["not_missing", "is not missing"],
        ];
    }
    return [
        ["contains", "contains"],
        ["not_contains", "does not contain"],
        ["eq", "is"],
        ["neq", "is not"],
        ["missing", "is missing"],
        ["not_missing", "is not missing"],
        ["regex", "matches regex"],
        ["not_regex", "does not match regex"],
    ];
}

function browseFieldOptions() {
    // Visible Browse labels intentionally differ from backend field names.
    return [
        ["setup", "Answer source"],
        ["annotation_state", "Annotation state"],
        ["annotator", "Annotator"],
        ["span_category", "Span category"],
        ["span_reason", "Span reason"],
        ["span_text", "Span text"],
        ["question", "Question"],
        ["output", "Answer"],
        ["any_text", "Any text"],
        ["slider", "Slider"],
    ];
}

function browseConditionValues(row) {
    return {
        field: row.find(".browse-condition-field").val(),
        op: row.find(".browse-condition-op").val(),
        value: row.find(".browse-condition-value").val(),
        sliderLabel: row.find(".browse-condition-slider-label").val(),
    };
}

function escapeBrowseOption(value) {
    return $("<option>").attr("value", value).text(value);
}

function addBrowseFilterCondition(condition) {
    const row = $(`
      <div class="row g-2 align-items-end browse-filter-condition">
        <div class="col-md-3">
          <label class="form-label small mb-1">Field</label>
          <select class="form-select form-select-sm browse-condition-field"></select>
        </div>
        <div class="col-md-3">
          <label class="form-label small mb-1">Operator</label>
          <select class="form-select form-select-sm browse-condition-op"></select>
        </div>
        <div class="col-md-5 browse-condition-value-wrap"></div>
        <div class="col-md-1">
          <button type="button" class="btn btn-sm btn-outline-secondary w-100 browse-remove-condition" title="Remove condition">
            <i class="fa fa-times"></i>
          </button>
        </div>
      </div>
    `);
    const fieldSelect = row.find(".browse-condition-field");
    browseFieldOptions().forEach(function ([value, label]) {
        fieldSelect.append(escapeBrowseOption(value).text(label));
    });
    $("#browse-filter-conditions").append(row);
    fieldSelect.val(condition?.field || "span_category");
    renderBrowseConditionControls(row, condition || {});
}

function renderBrowseConditionControls(row, condition) {
    const field = row.find(".browse-condition-field").val();
    const opSelect = row.find(".browse-condition-op");
    const previousOp = condition.op || opSelect.val();
    opSelect.empty();
    browseTextOperators(field).forEach(function ([value, label]) {
        opSelect.append(escapeBrowseOption(value).text(label));
    });
    if (previousOp && opSelect.find(`option[value="${previousOp}"]`).length) {
        opSelect.val(previousOp);
    }

    const wrap = row.find(".browse-condition-value-wrap");
    wrap.empty();
    const selectFields = {
        setup: ["Select answer source...", browseFilterSchema.setups || []],
        annotation_state: ["Select state...", browseFilterSchema.annotation_states || []],
        annotator: ["Select annotator...", browseFilterSchema.annotators || []],
        span_category: ["Select category...", browseFilterSchema.categories || []],
    };
    if (field in selectFields) {
        const [placeholder, values] = selectFields[field];
        const select = $('<select class="form-select form-select-sm browse-condition-value"></select>');
        select.append(escapeBrowseOption("").text(placeholder));
        values.forEach(function (value) {
            select.append(escapeBrowseOption(value));
        });
        wrap.append('<label class="form-label small mb-1">Value</label>');
        wrap.append(select);
        select.val(condition.value || "");
    } else if (field === "slider") {
        const controls = $(`
          <div class="row g-2">
            <div class="col-md-6">
              <label class="form-label small mb-1">Slider</label>
              <select class="form-select form-select-sm browse-condition-slider-label"></select>
            </div>
            <div class="col-md-6">
              <label class="form-label small mb-1">Value</label>
              <input class="form-control form-control-sm browse-condition-value" type="number" step="any">
            </div>
          </div>
        `);
        const labelSelect = controls.find(".browse-condition-slider-label");
        labelSelect.append(escapeBrowseOption("").text("Select slider..."));
        (browseFilterSchema.slider_labels || []).forEach(function (label) {
            labelSelect.append(escapeBrowseOption(label));
        });
        wrap.append(controls);
        labelSelect.val(condition.sliderLabel || "");
        controls.find(".browse-condition-value").val(condition.value || "");
    } else {
        wrap.append('<label class="form-label small mb-1">Value</label>');
        wrap.append('<input class="form-control form-control-sm browse-condition-value" type="search">');
        wrap.find(".browse-condition-value").val(condition.value || "");
    }
    row.find(".browse-condition-value").prop("disabled", ["missing", "not_missing"].includes(opSelect.val()));
}

function browseActiveConditions() {
    const conditions = [];
    $(".browse-filter-condition").each(function () {
        const condition = browseConditionValues($(this));
        const valueRequired = !["missing", "not_missing"].includes(condition.op);
        const hasValue = condition.field === "slider" ? condition.value !== "" : String(condition.value || "").trim() !== "";
        const hasSliderLabel = condition.field !== "slider" || condition.sliderLabel;
        if (condition.field && condition.op && (!valueRequired || hasValue) && hasSliderLabel) {
            conditions.push(condition);
        }
    });
    return conditions;
}

function loadBrowseFilterSchema() {
    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();
    if (!dataset || !split) {
        return;
    }
    const params = new URLSearchParams({ dataset, split });
    $.get(`${url_prefix}/query/schema?${params.toString()}`, function (schema) {
        if (!schema.success) {
            return;
        }
        browseFilterSchema = schema;
        updateBrowseResultUnitMetadata(schema);
        const conditions = $(".browse-filter-condition").map(function () {
            return browseConditionValues($(this));
        }).get();
        $("#browse-filter-conditions").empty();
        if (conditions.length) {
            conditions.forEach(addBrowseFilterCondition);
        } else {
            addBrowseFilterCondition();
        }
    });
}

function clearFilteredQueue() {
    const wasActive = filteredQueueActive;
    filteredResults = [];
    filteredQueueActive = false;
    browsePreviewMatchActive = false;
    filteredQueueIndex = 0;
    activeBrowseMatchDetails = [];
    renderBrowseMatchDetails();
    clearBrowseMatchHighlights();
    $("#browse-filter-count").removeClass("text-danger").text("");
    $("#browse-filter-error").text("");
    $("#browse-toggle-highlights").hide();
    if (wasActive) {
        $("#page-input").val(current_example_idx);
    }
}

function loadRedoPreviewMatch(params) {
    const token = params.get("redo_preview_match");
    if (!token) {
        return;
    }
    try {
        const storageKey = `${REDO_PREVIEW_MATCH_PREFIX}${token}`;
        const payload = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
        const details = Array.isArray(payload.match_details) ? payload.match_details : [];
        if (!details.length) {
            return;
        }
        activeBrowseMatchDetails = details;
        browsePreviewMatchActive = true;
        window.highlight_ann_campaigns = matchedAnnotatorIdsFromDetails(details);
        const firstDetail = details[0] || {};
        if (!window.highlight_setup_id && firstDetail.setup_id) {
            window.highlight_setup_id = firstDetail.setup_id;
        }
        if (!window.highlight_ann_campaign) {
            window.highlight_ann_campaign = firstDetail.annotator_id || firstDetail.annotator_alias || null;
        }
        updateBrowseHighlightsToggleLabel();
        $("#browse-toggle-highlights").show();
        renderBrowseMatchDetails();
        window.localStorage.removeItem(storageKey);
    } catch (error) {
        console.warn("Could not load redo preview highlights.", error);
    }
}

function resetBrowseFilters() {
    clearFilteredQueue();
    $("#browse-filter-match-mode").val("all");
    $("#browse-filter-conditions").empty();
    addBrowseFilterCondition();
    $("#page-input").val(current_example_idx);
}

function setBrowseFilterStatus(message, isError = false) {
    $("#browse-filter-count").toggleClass("text-danger", isError).text(message || "");
}

function updateBrowseResultUnitMetadata(payload) {
    browseResultUnitLabel = payload?.result_unit_label || browseResultUnitLabel || "question";
    browseResultUnitPlural = payload?.result_unit_plural || browseResultUnitPlural || `${browseResultUnitLabel}s`;
}

function browseMatchedQuestionStatus(count) {
    if (count === 0) {
        return `No matched ${browseResultUnitPlural}`;
    }
    const unit = count === 1 ? browseResultUnitLabel : browseResultUnitPlural;
    return `${count} matched ${unit}`;
}

function updateBrowseHighlightsToggleLabel() {
    $("#browse-toggle-highlights").text(browseHighlightsEnabled ? "Hide highlights" : "Show highlights");
}

function applyBrowseFilters() {
    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();
    const conditions = browseActiveConditions();
    $("#browse-filter-error").text("");
    if (!conditions.length) {
        resetBrowseFilters();
        return;
    }
    setBrowseFilterStatus("Finding matched questions...");
    $.ajax({
        url: `${url_prefix}/query/filter`,
        method: "POST",
        contentType: "application/json",
        data: JSON.stringify({
            dataset,
            split,
            filters: {
                mode: $("#browse-filter-match-mode").val(),
                conditions,
            },
            limit: 5000,
        }),
        success: function (payload) {
            if (!payload.success) {
                clearFilteredQueue();
                $("#browse-filter-error").text(payload.error || "Filter failed.");
                setBrowseFilterStatus("Filter failed.", true);
                return;
            }
            updateBrowseResultUnitMetadata(payload);
            filteredResults = payload.rows || [];
            filteredQueueActive = filteredResults.length > 0;
            filteredQueueIndex = 0;
            setBrowseFilterStatus(browseMatchedQuestionStatus(filteredResults.length));
            updateBrowseHighlightsToggleLabel();
            $("#browse-toggle-highlights").toggle(filteredQueueActive);
            if (filteredQueueActive) {
                goToPage(0);
            }
        },
        error: function () {
            clearFilteredQueue();
            setBrowseFilterStatus("Filter failed.", true);
        }
    });
}

function goToPage(page) {
    if (filteredQueueActive) {
        filteredQueueIndex = Math.min(Math.max(Number(page), 0), filteredResults.length - 1);
        const row = filteredResults[filteredQueueIndex];
        current_example_idx = Number(row.example_idx);
        activeBrowseMatchDetails = row.match_details || [];
        window.highlight_setup_id = row.match_setup_id || null;
        window.highlight_ann_campaign = row.match_annotator_id || row.match_annotator_alias || null;
        window.highlight_ann_campaigns = matchedAnnotatorIdsFromDetails(activeBrowseMatchDetails);
        fetchExample(row.dataset, row.split, current_example_idx);
        renderBrowseMatchDetails();
        $("#page-input").val(`${filteredQueueIndex + 1}/${filteredResults.length}`);
        return;
    }

    current_example_idx = Math.min(page, total_examples - 1);
    current_example_idx = Math.max(0, current_example_idx);

    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();

    fetchExample(dataset, split, current_example_idx);

    $("#page-input").val(current_example_idx);
}

function nextBtn() {
    if (filteredQueueActive) {
        goToPage(filteredQueueIndex + 1);
        return;
    }
    goToPage(current_example_idx + 1);
}

function prevBtn() {
    if (filteredQueueActive) {
        goToPage(filteredQueueIndex - 1);
        return;
    }
    goToPage(current_example_idx - 1);
}

function startBtn() {
    goToPage(0);
}

function endBtn() {
    if (filteredQueueActive) {
        goToPage(filteredResults.length - 1);
        return;
    }
    goToPage(total_examples - 1);
}

function randomBtn() {
    if (filteredQueueActive) {
        goToPage(randInt(filteredResults.length));
        return;
    }
    goToPage(randInt(total_examples));
}

function goToBtn() {
    if (filteredQueueActive) {
        const raw = String($("#page-input").val() || "1").split("/")[0];
        goToPage(Number(raw) - 1);
        return;
    }
    goToPage($("#page-input").val());
}

function showRawData(data) {
    var rawDataStr = JSON.stringify(data.raw_data, null, 2).replace(/\\n/g, '\n');

    if (rawDataStr[0] == '"') {
        // remove the first and last double quotes
        rawDataStr = rawDataStr.slice(1, -1);
    }
    rawDataStr = rawDataStr.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    $("#rawarea").html(`<pre>${rawDataStr}</pre>`);
}


function showSelectedCampaigns() {
    const availableAnnIds = getSelectableAnnotatorIds();
    const availableSet = new Set(availableAnnIds);
    const highlightedAnnIds = matchedAnnotatorIdsFromDetails(activeBrowseMatchDetails).filter((annId) => availableSet.has(annId));

    if (highlightedAnnIds.length > 0) {
        selected_campaigns = highlightedAnnIds;
        setActiveAnnotatorButtons(selected_campaigns);
        return;
    }

    // if window.highlight_ann_campaign is set, select the corresponding campaign
    const highlightedAnnId = resolveSelectableAnnotatorId(window.highlight_ann_campaign, availableSet);
    if (highlightedAnnId) {
        selected_campaigns = [highlightedAnnId];
        setActiveAnnotatorButtons(selected_campaigns);
        return;
    }

    const matchingPreferred = preferredAnnotatorIds.filter((annId) => availableSet.has(annId));
    if (matchingPreferred.length > 0) {
        selected_campaigns = matchingPreferred;
        setActiveAnnotatorButtons(selected_campaigns);
        return;
    }

    setActiveAnnotatorButtons([]);

    // if no campaigns were selected (no $(".btn-ann-select") has class `active), select the first one
    if (!window.highlight_ann_campaign && availableAnnIds.length > 0) {
        const annId = availableAnnIds[0];
        selected_campaigns = [annId];
        setActiveAnnotatorButtons(selected_campaigns);
    } else {
        selected_campaigns = [];
    }
}

function toggleRaw() {
    // toggle display: none on rawarea and examplearea
    $("#rawarea").toggle();
    $("#examplearea").toggle();
}

function toggleAnnotatorNames() {
    showAnnotatorNames = !showAnnotatorNames;
    updateAnnotatorNamesToggleAvailability();

    if (window.generated_outputs) {
        createOutputBoxes(window.generated_outputs);
        const availableSet = new Set(getSelectableAnnotatorIds());
        selected_campaigns = selected_campaigns.filter((annId) => availableSet.has(annId));
        setActiveAnnotatorButtons(selected_campaigns);
        updateDisplayedAnnotations();
        highlightSetup();
    }
}


function updateDisplayedAnnotations() {
    const activeButtons = $('.btn-ann-select.active');
    selected_campaigns = activeButtons.map(function () {
        return $(this).data('ann');
    }).get();
    // hide all placeholders
    $(".output-box").hide();

    // if no campaign ids, show the original output
    if (selected_campaigns.length == 0) {
        $(".box-original").show();
    }
    for (const campaign_id of selected_campaigns) {
        // show the selected annotator
        $(`.box-${campaign_id}`).show();
    }

    // If a setup has no matching selected annotation, keep its original output visible.
    if (selected_campaigns.length > 0) {
        $(".output-group").each(function () {
            const group = $(this);
            const hasVisibleSelected = group.find(".output-box:visible").not(".box-original").length > 0;
            if (!hasVisibleSelected) {
                group.find(".box-original").show();
            }
        });
    }

    restoreCollapsedStates();
    enableTooltips();
    applyBrowseMatchHighlights();
}

$('#page-input').keypress(function (event) {
    // Enter = Go to page
    if (event.keyCode == 13) {
        goToBtn();
    }
});

$("#dataset-select").on("change", changeDataset);
$("#split-select").on("change", changeSplit);
$("#browse-filter-match-mode").on("change", clearFilteredQueue);
$("#browse-add-condition").on("click", function () {
    addBrowseFilterCondition();
});
$("#browse-apply-filters").on("click", applyBrowseFilters);
$("#browse-reset-filters").on("click", resetBrowseFilters);
$("#browse-toggle-highlights").on("click", function () {
    browseHighlightsEnabled = !browseHighlightsEnabled;
    updateBrowseHighlightsToggleLabel();
    applyBrowseMatchHighlights();
});
$("#browse-filter-conditions").on("change", ".browse-condition-field", function () {
    const row = $(this).closest(".browse-filter-condition");
    renderBrowseConditionControls(row, browseConditionValues(row));
    clearFilteredQueue();
});
$("#browse-filter-conditions").on("change", ".browse-condition-op", function () {
    const row = $(this).closest(".browse-filter-condition");
    row.find(".browse-condition-value").prop("disabled", ["missing", "not_missing"].includes($(this).val()));
    clearFilteredQueue();
});
$("#browse-filter-conditions").on("input change", ".browse-condition-value, .browse-condition-slider-label", clearFilteredQueue);
$("#browse-filter-conditions").on("click", ".browse-remove-condition", function () {
    $(this).closest(".browse-filter-condition").remove();
    if (!$(".browse-filter-condition").length) {
        addBrowseFilterCondition();
    }
    clearFilteredQueue();
});

// Handle permalink button clicks
$(document).on('click', '.permalink-btn', function (e) {
    e.stopPropagation(); // Prevent collapsing the card
    e.preventDefault(); // Prevent any default button behavior

    const setup_id = $(this).data('setup-id');
    const ann_id = $(this).data('ann-id');
    const permalink = generatePermalink(setup_id, ann_id);

    // Copy to clipboard
    navigator.clipboard.writeText(permalink).then(function () {
        console.log('Permalink copied to clipboard');
        // Show a brief success indicator
        const btn = e.target.closest('.permalink-btn');
        const originalIcon = btn.innerHTML;
        btn.innerHTML = '<i class="fa fa-check"></i>';
        setTimeout(function () {
            btn.innerHTML = originalIcon;
        }, 1000);
    }).catch(function (err) {
        console.error('Failed to copy permalink to clipboard: ', err);
        // Fallback for older browsers
        const success = fallbackCopyTextToClipboard(permalink);
        if (success) {
            // Show success indicator for fallback method too
            const btn = e.target.closest('.permalink-btn');
            const originalIcon = btn.innerHTML;
            btn.innerHTML = '<i class="fa fa-check"></i>';
            setTimeout(function () {
                btn.innerHTML = originalIcon;
            }, 1000);
        }
    });

    // Update the browser URL
    history.pushState(null, '', permalink);

    // Update window variables for highlighting
    window.highlight_setup_id = setup_id;
    window.highlight_ann_campaign = ann_id !== "original" ? ann_id : null;

    // Ensure the output box is expanded (not collapsed)
    const targetId = `out-${setup_id}-${ann_id}`;
    const targetElement = document.getElementById(targetId);
    if (targetElement && !targetElement.classList.contains('show')) {
        const bsCollapse = new bootstrap.Collapse(targetElement, {
            toggle: false
        });
        bsCollapse.show();
        // Remove from collapsed_boxes array if present
        collapsed_boxes = collapsed_boxes.filter(id => id !== targetId);
    }

    // Re-highlight the output
    highlightSetup();

    // Scroll to the target output box
    const targetBox = $(`.output-box.box-${setup_id}-${ann_id}`);
    if (targetBox.length > 0) {
        targetBox[0].scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }
});

$("#badgesSwitch").on("change", function () {
    createOutputBoxes(window.generated_outputs);
    showSelectedCampaigns();
    updateDisplayedAnnotations();
});

$(document).keydown(function (event) {
    const key = event.key;

    if (key === "ArrowRight") {
        event.preventDefault();
        nextBtn();
    } else if (key === "ArrowLeft") {
        event.preventDefault();
        prevBtn();
    }
});

// checking whether the user is navigating to an example using history: if so, we need to load the particular example
window.addEventListener('popstate', function (event) {
    if (window.location.pathname === `/browse`) {
        const params = new URLSearchParams(window.location.search);
        const dataset = params.get('dataset');
        const split = params.get('split');
        const example_idx = params.get('example_idx');
        const setup_id = params.get('setup_id');
        const ann_campaign = params.get('ann_campaign');

        if (dataset && split && example_idx) {
            // Set highlight parameters before loading the example
            window.highlight_setup_id = setup_id;
            window.highlight_ann_campaign = ann_campaign;

            changeExample(dataset, split, example_idx);
        }
    }
});


$(document).ready(function () {
    loadAnnotatorAliases();

    // Check for URL parameters on initial load
    const urlParams = new URLSearchParams(window.location.search);
    const setup_id = urlParams.get('setup_id');
    const ann_campaign = urlParams.get('ann_campaign');

    if (setup_id) {
        window.highlight_setup_id = setup_id;
    }
    if (ann_campaign) {
        window.highlight_ann_campaign = ann_campaign;
    }
    loadRedoPreviewMatch(urlParams);

    if (window.display_example != null) {
        const e = window.display_example;
        changeExample(e.dataset, e.split, e.example_idx);
        loadBrowseFilterSchema();
    }
    else {
        // select the first dataset from the selectbox
        $("#dataset-select").val(
            $("#dataset-select option:first").val()
        ).trigger("change");
        $("#page-input").val(current_example_idx);
    }

    enableTooltips();
});

// Restore collapsed states after page change/content load
function restoreCollapsedStates() {
    collapsed_boxes.forEach(targetId => {
        const element = document.getElementById(targetId);
        if (element) {
            const bsCollapse = new bootstrap.Collapse(element, {
                toggle: false
            });
            bsCollapse.hide();
        }
    });
}

// Store collapsed state when boxes are toggled
document.addEventListener('shown.bs.collapse', function (e) {
    const targetId = e.target.id;
    collapsed_boxes = collapsed_boxes.filter(id => id !== targetId);
});

document.addEventListener('hidden.bs.collapse', function (e) {
    const targetId = e.target.id;
    if (!collapsed_boxes.includes(targetId)) {
        collapsed_boxes.push(targetId);
    }
});
