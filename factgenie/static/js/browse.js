var current_example_idx = 0;
var selected_campaigns = [];
var collapsed_boxes = [];
var showAnnotatorNames = false;
var preferredAnnotatorNames = [];
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

function isSkipSelected(annotations) {
    const flags = annotations?.flags || [];
    return flags.some((flag) => {
        const label = String(flag?.label || "").toLowerCase();
        if (!label.includes("skip")) {
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
    fetchExample(dataset, split, current_example_idx);
    $("#page-input").val(current_example_idx);
}

function changeSplit() {
    $("#dataset-spinner").show();
    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();
    current_example_idx = 0;
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


function createOutputBox(content, exampleLevelFields, annId, annLabel, setup_id) {
    var card = $('<div>', { class: `card output-box generated-output-box box-${setup_id} box-${annId} box-${setup_id}-${annId}` });

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
            if (isInvalidAnnotatorId(annotator_id)) {
                return;
            }
            const ann_id = generateAnnotatorKey(campaign_id, annotator_id) ||
                generateAnnotatorShortId(campaign_id, annotator_group);

            if (!annIds.has(ann_id)) {
                annIds.set(ann_id, {
                    campaign_id: campaign_id,
                    annotator_group: annotator_group,
                    annotator_id: annotator_id || null,
                    annotator_ids: new Set(),
                    annotator_aliases: new Set(),
                });
            }
            if (annotator_id) {
                annIds.get(ann_id).annotator_ids.add(annotator_id);
            }
            let alias = String(annotation.annotator_alias || "").trim();
            if (!alias && annotator_id) {
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

function getAnnotatorLabel(annId, annInfo) {
    if (!annInfo) {
        return annId;
    }
    const names = showAnnotatorNames ? getAnnotatorNames(annInfo) : getDisplayAnnotatorAliases(annId, annInfo);
    if (names.length === 0) {
        return annId;
    }
    return names.join(", ");
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
            const label = String(flag?.label || "").toLowerCase();
            return label.includes("skip") && isTruthyFlagValue(flag?.value);
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

function refreshPreferredAnnotators() {
    if (!selected_campaigns || selected_campaigns.length === 0) {
        return;
    }

    const names = new Set();
    selected_campaigns.forEach((annId) => {
        const info = currentAnnInfo.get(annId);
        getAnnotatorNames(info).forEach((name) => {
            const normalized = String(name || "").trim().toLowerCase();
            if (normalized) {
                names.add(normalized);
            }
        });
    });

    if (names.size > 0) {
        preferredAnnotatorNames = Array.from(names);
    }
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

    // add an option for each campaign id
    for (const ann_id of sortedAnnIds) {
        const annLabel = getAnnotatorLabel(ann_id, annIds.get(ann_id));
        const button = $(`<button type="button" class="btn btn-sm btn-primary btn-ann-select" data-ann="${ann_id}">${annLabel}</button>`);
        button.on('click', function () {
            $(this).toggleClass('active');
            updateDisplayedAnnotations();
        });
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
            let annotations;
            if (info.annotator_id) {
                annotations = output.annotations.filter(a => a.campaign_id == info.campaign_id && a.annotator_id == info.annotator_id)[0];
            } else {
                annotations = output.annotations.filter(a => a.campaign_id == info.campaign_id && a.annotator_group == info.annotator_group)[0];
            }
            if (!annotations || isInvalidAnnotatorId(annotations.annotator_id)) {
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

            const annLabel = getAnnotatorLabel(annId, annInfo);
            card = createOutputBox(annotated_output, exampleLevelFields, annId, annLabel, output.setup_id);
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
        const specificBox = $(`.output-box.box-${window.highlight_setup_id}-${window.highlight_ann_campaign}`);
        specificBox.addClass('border border-primary border-2');

        // Make sure the highlighted campaign is visible if not already
        if (!specificBox.is(":visible")) {
            // Add this campaign to selected campaigns if not already there
            if (!selected_campaigns.includes(window.highlight_ann_campaign)) {
                $(`.btn-ann-select[data-ann="${window.highlight_ann_campaign}"]`).addClass("active");
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
        const visibleBoxes = $(`.output-box.box-${window.highlight_setup_id}:visible`);
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


        window.highlight_ann_campaign = null;
        window.highlight_setup_id = null;
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
    var flags = annotations.flags;
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
            var labelDiv = $('<div>', { class: "small text-muted" }).text(`${slider.label}`);
            var valueDiv = $('<div>', { class: "small mb-1 fw-bold" }).text(`${slider.value}`);

            slidersDiv.append(labelDiv);
            slidersDiv.append(valueDiv);
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

function goToPage(page) {
    current_example_idx = Math.min(page, total_examples - 1);
    current_example_idx = Math.max(0, current_example_idx);

    const dataset = $('#dataset-select').val();
    const split = $('#split-select').val();

    fetchExample(dataset, split, current_example_idx);

    $("#page-input").val(current_example_idx);
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
    // if the annotator is still among the values, restore it
    // prevent resetting to the first annotation when switching examples
    $(".btn-ann-select").each(function () {
        if (selected_campaigns.includes($(this).data('ann'))) {
            $(this).addClass("active").trigger("change");
        } else {
            $(this).removeClass("active");
        }
    });

    // if window.highlight_ann_campaign is set, select the corresponding campaign
    if (window.highlight_ann_campaign) {
        $(`.btn-ann-select[data-ann="${window.highlight_ann_campaign}"]`).addClass("active").trigger("change");
        return;
    }

    // keep exact previous selections when they exist for this example
    if ($(".btn-ann-select.active").length > 0) {
        selected_campaigns = $('.btn-ann-select.active').map(function () {
            return $(this).data('ann');
        }).get();
        refreshPreferredAnnotators();
        return;
    }

    if (preferredAnnotatorNames.length > 0) {
        const preferred = new Set(preferredAnnotatorNames);
        const matching = [];
        $(".btn-ann-select").each(function () {
            const annId = $(this).data('ann');
            const info = currentAnnInfo.get(annId);
            const names = getAnnotatorNames(info).map((name) => String(name).toLowerCase());
            if (names.some((name) => preferred.has(name))) {
                $(this).addClass("active").trigger("change");
                matching.push(annId);
            } else {
                $(this).removeClass("active");
            }
        });
        if (matching.length > 0) {
            selected_campaigns = matching;
            refreshPreferredAnnotators();
            return;
        }
    }
    // if no campaigns were selected (no $(".btn-ann-select") has class `active), select the first one
    if (!window.highlight_ann_campaign && $(".btn-ann-select").length > 0 && $(".btn-ann-select.active").length == 0) {
        const first = $(".btn-ann-select").first();
        first.addClass("active").trigger("change");
        const annId = first.data("ann");
        selected_campaigns = [annId];
        refreshPreferredAnnotators();
    }
}

function toggleRaw() {
    // toggle display: none on rawarea and examplearea
    $("#rawarea").toggle();
    $("#examplearea").toggle();
}

function toggleAnnotatorNames() {
    showAnnotatorNames = !showAnnotatorNames;

    const label = showAnnotatorNames ? "Hide annotator names" : "Show annotator names";
    $("#toggle-annotator-names-btn small").text(label);

    if (window.generated_outputs) {
        createOutputBoxes(window.generated_outputs);
        showSelectedCampaigns();
        updateDisplayedAnnotations();
        highlightSetup();
    }
}


function updateDisplayedAnnotations() {
    const activeButtons = $('.btn-ann-select.active');
    selected_campaigns = activeButtons.map(function () {
        return $(this).data('ann');
    }).get();
    refreshPreferredAnnotators();
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
}

$('#page-input').keypress(function (event) {
    // Enter = Go to page
    if (event.keyCode == 13) {
        goToBtn();
    }
});

$("#dataset-select").on("change", changeDataset);
$("#split-select").on("change", changeSplit);

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

    if (window.display_example != null) {
        const e = window.display_example;
        changeExample(e.dataset, e.split, e.example_idx);
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
