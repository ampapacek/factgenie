const sizes = [50, 50];
const annotator_id = window.annotator_id;
const metadata = window.metadata;
const redo_context = window.redo_context || {};
const INVALID_ANNOTATOR_IDS = ["", "FILL_YOUR_NAME_HERE", null, undefined];

var current_example_idx = 0;
var redoFinalMessage = "";
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
        $(this).text($(this).attr('data-default-value'));
    });

    // clear the values in free-text fields
    $(".crowdsourcing-text .textbox-crowdsourcing").val("");
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
        const myId = $(this).find("input[type='range']").attr('id');
        const sliderValueId = `${myId}-value`;

        if ($(`#${sliderValueId}`).text() == $(`#${sliderValueId}`).attr('data-default-value')) {
            return;
        }

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

            // we have always only a single generated output here
            data.generated_outputs = data.generated_outputs[0];
            examples_cached[annotation_idx] = data;
            resolve();
        }).fail(function () {
            reject();
        });
    });
}


function goToAnnotation(example_idx) {
    $(".page-link").removeClass("bg-active");
    $(`#page-link-${example_idx}`).addClass("bg-active");

    $(".annotate-box").hide();
    $(`#out-text-${example_idx}`).show();

    const data = examples_cached[example_idx];
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
}

function goToPage(page) {
    const example_idx = current_example_idx;

    current_example_idx = page;
    current_example_idx = mod(current_example_idx, total_examples);

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
    Promise.all(promises)
        .then(() => {
            // take from metadata if defined, else false
            const annotationOverlapAllowed = metadata.config.annotation_overlap_allowed || false;
            const annotateReason = metadata.config.annotate_reason || false;
            spanAnnotator.init(metadata.config.annotation_granularity, annotationOverlapAllowed, annotation_span_categories, annotateReason);

            for (const [annotation_idx, data] of Object.entries(examples_cached)) {
                const normalizedOutput = normalizeNewlines(data.generated_outputs.output);
                const p = $('<p>', { id: `out-text-${annotation_idx}-par`, class: 'annotatable-paragraph' });
                $(`#out-text-${annotation_idx}`).append(p);
                spanAnnotator.addDocument(`p${annotation_idx}`, p, true, normalizedOutput);
                if (Array.isArray(annotation_set[annotation_idx].annotations)) {
                    spanAnnotator.addAnnotations(`p${annotation_idx}`, annotation_set[annotation_idx].annotations);
                }
                spanAnnotator.setCurrentAnnotationType(0);
                addPageLink(annotation_idx);
            }

            goToAnnotation(0);

            $("#hideOverlayBtn").attr("disabled", false);
            $("#hideOverlayBtn").html("View the annotation page");
        })
        .catch((e) => {
            // Handle errors if any request fails
            console.error("One or more requests failed.");
            // Log the error
            console.error(e);

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

        // check whether no .slider-crowdsourcing-value contains its data-default-value
        const allSlidersFilled = $(".slider-crowdsourcing-value")
            .filter(function () { return $(this).text() == $(this).attr('data-default-value'); }).length == 0;

        if (!allSlidersFilled) {
            alert("Please set all the sliders before saving this annotation.");
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

function saveCurrentAnnotations(example_idx) {
    const annotations = spanAnnotator.getAnnotations(`p${example_idx}`);

    annotation_set[example_idx]["annotations"] = annotations;
    annotation_set[example_idx]["flags"] = collectFlags();
    annotation_set[example_idx]["options"] = collectOptions();
    annotation_set[example_idx]["sliders"] = collectSliders();
    annotation_set[example_idx]["textFields"] = collectTextFields();
    annotation_set[example_idx]["timeLastSaved"] = Math.floor(Date.now() / 1000);
}

function submitAnnotations(campaign_id) {
    if (redo_context.is_redo === true || annotation_set.some(annotation => annotation.redo_id)) {
        alert("Redo annotations must be saved with Save current item.");
        $("#submit-annotations-btn").hide();
        $("#redo-save-current-btn").show();
        return;
    }

    // Save to local storage before attempting submission
    saveAnnotationsToLocalStorage();

    const submissionData = {
        campaign_id: metadata.id,
        annotator_id: annotator_id,
        annotation_set: annotation_set
    };

    $("#submit-annotations-btn").prop("disabled", true).text("Submitting...");

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
    $("#submit-annotations-btn").prop("disabled", false).text("👉️ Submit Annotations");

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
        submitAnnotations();
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
