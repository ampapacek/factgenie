const sizes = [50, 50];
const annotator_id = window.annotator_id;
const metadata = window.metadata;
const INVALID_ANNOTATOR_IDS = ["", "FILL_YOUR_NAME_HERE", null, undefined];

var current_example_idx = 0;
var annotation_set = window.annotation_set;

const total_examples = annotation_set.length;

var examples_cached = {};
var annotatorAuthMode = "login";
var annotatorAuthModal = null;

var splitInstance = Split(['#centerpanel', '#rightpanel'], {
    sizes: sizes,
    gutterSize: 1,
});

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

    if (!annotatorAuthModal) {
        annotatorAuthModal = new bootstrap.Modal(document.getElementById("annotator-auth-modal"));
    }
    annotatorAuthModal.show();
}

function redirectWithAnnotatorId(annotatorId) {
    const url = new URL(window.location.href);
    url.searchParams.set("annotatorId", annotatorId);
    window.onbeforeunload = null;
    window.location.href = url.toString();
}

function checkAnnotatorExists(annotatorId) {
    return $.get(`${url_prefix}/annotator/exists`, {
        campaign_id: metadata.id,
        annotator_id: annotatorId,
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

    $.post({
        url: `${url_prefix}/annotator/${endpoint}`,
        contentType: "application/json",
        data: JSON.stringify({
            campaign_id: metadata.id,
            annotator_id: normalized,
        }),
        success: function (response) {
            if (response.success !== true) {
                const errorMsg = response.error || "Authentication failed.";
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
            const stored = localStorage.getItem(`factgenie_annotator_id_${metadata.id}`) || "";
            $("#annotator-name-input").val(stored);
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
            "setup_id": setup_id
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

    annotation_set[example_idx]["timeLastAccessed"] = Math.floor(Date.now() / 1000);

    clearExampleLevelFields();

    if (flags !== undefined) {
        $(".crowdsourcing-flag").each(function (i) {
            $(this).find("input[type='checkbox']").prop("checked", flags[i]["value"]);
        });
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
                const p = $('<p>', { id: `out-text-${annotation_idx}-par`, class: 'annotatable-paragraph' })
                    .html(normalizeNewlines(data.generated_outputs.output));
                $(`#out-text-${annotation_idx}`).append(p);
                spanAnnotator.addDocument(`p${annotation_idx}`, p, true);
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

function isSkipAnnotationSelected() {
    let skipSelected = false;
    $(".crowdsourcing-flag").each(function () {
        const label = $(this).find("label").text().trim().toLowerCase();
        const checked = $(this).find("input[type='checkbox']").prop("checked");
        if (!checked) return;
        if (label.includes("skip")) {
            skipSelected = true;
        }
    });
    return skipSelected;
}

function markAnnotationAsComplete() {
    const skipSelected = isSkipAnnotationSelected();

    // if skip flag was set, dont check initialization of the values
    if (!skipSelected) {
        
        // check whether all the selects have been filled (the default value is not selected)
        const allSelectsFilled = $(".crowdsourcing-option").find("select option:selected")
            .filter(function () { return $(this).val() == ""; }).length == 0;

        if (!allSelectsFilled) {
            alert("Please select all the options before marking the annotation as complete.");
            return;
        }

        // check whether no .slider-crowdsourcing-value contains its data-default-value
        const allSlidersFilled = $(".slider-crowdsourcing-value")
            .filter(function () { return $(this).text() == $(this).attr('data-default-value'); }).length == 0;

        if (!allSlidersFilled) {
            alert("Please set all the sliders before marking the annotation as complete.");
            return;
        }
    }

    $('#page-link-' + current_example_idx).removeClass("bg-incomplete");
    $('#page-link-' + current_example_idx).addClass("bg-complete");

    // if all the examples are annotated, post the annotations
    if ($(".bg-incomplete").length == 0) {
        saveCurrentAnnotations(current_example_idx);

        // show the `submit` button
        $("#submit-annotations-btn").show();

        // scroll to the top
        $('html, body').animate({
            scrollTop: $("#submit-annotations-btn").offset().top
        }, 500);

    } else if (current_example_idx < total_examples - 1) {
        // annotations will be saved automatically
        nextBtn();
    }
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
}

function retrySubmission() {
    // Disable the retry button and show retrying status
    $("#retry-btn").prop("disabled", true).text("Retrying...");

    // Add a brief delay to show the "Retrying..." status and prevent flicker
    setTimeout(() => {
        $("#overlay-fail").hide();
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


$("#hideOverlayBtn").click(function () {
    $("#overlay-start").fadeOut();
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
