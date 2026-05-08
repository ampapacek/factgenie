const available_data = window.available_data;
window.llmCampaignListeners = window.llmCampaignListeners || {};
let openRouterValidationTimer = null;
let openRouterValidationRequestId = 0;

function getAvailableSetupIds() {
    return [...new Set(
        (available_data || [])
            .map(item => item.setup_id)
            .filter(setupId => typeof setupId === "string" && setupId.trim() !== "")
    )].sort((a, b) => a.localeCompare(b));
}

function populateAdditionalContextSetupIdOptions() {
    const datalist = $("#llm-context-setup-id-options");
    if (datalist.length === 0) {
        return;
    }

    datalist.empty();
    getAvailableSetupIds().forEach(setupId => {
        datalist.append(`<option value="${setupId}"></option>`);
    });
}

function renderAdditionalContextSources(sources) {
    const container = $("#additional-context-sources");
    if (container.length === 0) {
        return;
    }

    container.empty();
    (sources || []).forEach(source => {
        const field = source.field || "";
        const setupId = source.setup_id || source.setupId || "";
        const description = source.description || "";
        container.append(createAdditionalContextSourceElem(field, setupId, description));
    });
}

function collectConfiguredAdditionalContextSources() {
    return getAdditionalContextSources()
        .map(source => ({
            field: (source.field || "").trim(),
            setupId: (source.setupId || "").trim(),
            description: (source.description || "").trim(),
        }))
        .filter(source => source.field || source.setupId || source.description);
}

function validateAdditionalContextSources(sources, campaignData) {
    const seenFields = new Set();

    for (const source of sources) {
        if (!source.field) {
            return "Each additional context row must have a prompt field name.";
        }
        if (!source.setupId) {
            return `Additional context source '${source.field}' is missing a setup id.`;
        }
        if (/[{}\[\]]/.test(source.field)) {
            return `Additional context field '${source.field}' cannot contain square or curly brackets.`;
        }
        if (seenFields.has(source.field)) {
            return `Additional context field '${source.field}' is defined more than once.`;
        }
        seenFields.add(source.field);

        const missingCombinations = campaignData.filter(combination =>
            !available_data.some(item =>
                item.dataset === combination.dataset
                && item.split === combination.split
                && item.setup_id === source.setupId
            )
        );

        if (missingCombinations.length > 0) {
            const preview = missingCombinations
                .slice(0, 3)
                .map(item => `${item.dataset}/${item.split}`)
                .join(", ");
            const suffix = missingCombinations.length > 3 ? ", ..." : "";
            return `Additional context source '${source.field}' uses setup id '${source.setupId}', but that output is not available for: ${preview}${suffix}`;
        }
    }

    return null;
}

function setOpenRouterModelStatus(message, level) {
    const statusElem = $("#openrouter-model-status");
    if (statusElem.length === 0) {
        return;
    }

    statusElem
        .removeClass("d-none text-muted text-success text-warning text-danger")
        .addClass(level)
        .text(message);
}

function clearOpenRouterModelStatus() {
    const statusElem = $("#openrouter-model-status");
    if (statusElem.length === 0) {
        return;
    }

    statusElem
        .removeClass("text-success text-warning text-danger")
        .addClass("d-none text-muted")
        .text("");
}

function scheduleOpenRouterValidation() {
    if (openRouterValidationTimer) {
        clearTimeout(openRouterValidationTimer);
    }

    const provider = $("#api-provider").val();
    const modelName = $("#model-name").val().trim();

    if (provider !== "openrouter") {
        clearOpenRouterModelStatus();
        return;
    }

    if (modelName.length === 0) {
        setOpenRouterModelStatus("Enter an OpenRouter model name to validate it while typing.", "text-muted");
        return;
    }

    setOpenRouterModelStatus("Checking OpenRouter model availability...", "text-muted");
    openRouterValidationTimer = setTimeout(function () {
        validateOpenRouterModel(
            {
                apiProvider: provider,
                modelName: modelName,
            },
            {
                showAlerts: false,
                allowLookupFailure: false,
                updateStatus: true,
            }
        );
    }, 350);
}

function submitLLMCampaignCreate(campaignId, campaignData, config) {
    $.post({
        url: `${url_prefix}/${mode}/create`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaignId: campaignId,
            campaignData: campaignData,
            config: config
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                window.location.href = `${url_prefix}/${mode}`;
            }
        }
    });
}

function validateOpenRouterModel(config, options) {
    options = options || {};
    const requestId = ++openRouterValidationRequestId;

    $.post({
        url: `${url_prefix}/llm_campaign/validate_model`,
        contentType: 'application/json',
        data: JSON.stringify({
            provider: config.apiProvider,
            model: config.modelName,
        }),
        success: function (response) {
            console.log(response);

            if (options.updateStatus && requestId !== openRouterValidationRequestId) {
                return;
            }

            if (response.success !== true) {
                if (options.updateStatus) {
                    setOpenRouterModelStatus(response.error || "Failed to validate the OpenRouter model.", "text-danger");
                }
                if (options.showAlerts) {
                    alert(response.error || "Failed to validate the OpenRouter model.");
                }
                return;
            }

            if (response.lookup_failed) {
                if (options.updateStatus) {
                    setOpenRouterModelStatus(
                        response.message || "Could not verify OpenRouter model availability.",
                        "text-warning"
                    );
                }
                if (options.showAlerts) {
                    alert(response.message || "Could not verify OpenRouter model availability. Proceeding anyway.");
                }
                if (options.allowLookupFailure && options.onValid) {
                    options.onValid();
                }
                return;
            }

            if (!response.available) {
                if (options.updateStatus) {
                    setOpenRouterModelStatus(response.message || "OpenRouter model is not available.", "text-danger");
                }
                if (options.showAlerts) {
                    alert(response.message || "OpenRouter model is not available.");
                }
                return;
            }

            if (options.updateStatus) {
                setOpenRouterModelStatus(response.message || "OpenRouter model is available.", "text-success");
            }
            if (options.onValid) {
                options.onValid();
            }
        },
        error: function (error) {
            const message = (error.responseJSON && error.responseJSON.error)
                || "Could not verify OpenRouter model availability. Proceeding anyway.";

            if (options.updateStatus && requestId !== openRouterValidationRequestId) {
                return;
            }

            if (options.updateStatus) {
                setOpenRouterModelStatus(message, "text-warning");
            }
            if (options.showAlerts) {
                alert(message);
            }
            if (options.allowLookupFailure && options.onValid) {
                options.onValid();
            }
        }
    });
}

function clearCampaign(campaignId) {
    // ask for confirmation
    if (!confirm("Are you sure you want to clear all campaign outputs?")) {
        return;
    }
    $.post({
        url: `${url_prefix}/clear_campaign`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaignId: campaignId,
            mode: mode
        }),
        success: function (response) {
            console.log(response);
            window.location.reload();
        }
    });
}

function clearOutput(campaignId, mode, idx) {
    // ask for confirmation
    if (!confirm(`Are you sure you want to free the batch id ${idx}? All related outputs will be deleted.`)) {
        return;
    }
    $.post({
        url: `${url_prefix}/clear_output`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            campaignId: campaignId,
            mode: mode,
            idx: idx,
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                // reload the page
                location.reload();
            }
        }
    });
}

function createLLMCampaign() {
    const campaignId = $('#campaignId').val();
    // const llmConfig = $('#llmConfig').val();

    const config = gatherConfig();
    const campaignData = gatherSelectedCombinations();

    // if no annotation categories are created, show an alert
    if (mode != "llm_gen" && config.annotationSpanCategories.length == 0) {
        alert("Please add at least one annotation span category.");
        return;
    }

    // if no datasets are selected, show an alert
    if (campaignData.length == 0) {
        alert("Please select at least one existing combination of dataset, split, and output.");
        return;
    }

    if (mode === "llm_eval") {
        const additionalContextError = validateAdditionalContextSources(config.additionalContextSources || [], campaignData);
        if (additionalContextError) {
            alert(additionalContextError);
            return;
        }
    }

    if (config.apiProvider === "openrouter") {
        validateOpenRouterModel(config, {
            showAlerts: true,
            allowLookupFailure: true,
            updateStatus: true,
            onValid: function () {
                submitLLMCampaignCreate(campaignId, campaignData, config);
            }
        });
        return;
    }

    submitLLMCampaignCreate(campaignId, campaignData, config);
}

function createHumanCampaign() {
    const campaignId = $('#campaignId').val();
    const config = gatherConfig();
    var campaignData = gatherSelectedCombinations();

    // if no datasets are selected, show an alert
    if (campaignData.length == 0) {
        alert("Please select at least one existing combination of dataset, split, and output.");
        return;
    }

    $.post({
        url: `${url_prefix}/crowdsourcing/create`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            campaignId: campaignId,
            config: config,
            campaignData: campaignData
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                window.location.href = `${url_prefix}/crowdsourcing`;
            }
        }
    });
}

function deleteCampaign(campaignId, mode) {
    // ask for confirmation
    if (!confirm(`Are you sure you want to delete the campaign ${campaignId}? All the data will be lost!`)) {
        return;
    }

    $.post({
        url: `${url_prefix}/delete_campaign`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            campaignId: campaignId,
            mode: mode,
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                // remove the campaign from the list
                $(`#campaign-${campaignId}`).remove();

                // reload the page
                location.reload();
            }
        }
    });
}

function duplicateConfig(btnElem, filenameElemId, modeTo, campaignId) {
    const filename = $("#" + filenameElemId).val() + ".yaml";
    const modeFrom = window.mode;

    // TODO warn overwrite
    $.post({
        url: `${url_prefix}/duplicate_config`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            campaignId: campaignId,
            modeFrom: modeFrom,
            modeTo: modeTo,
            filename: filename,
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                // change color of the button save-cfg-submit to green for a second with the label "Saved!", then back to normal
                const origText = $(btnElem).text();
                $(btnElem).removeClass("btn-primary").addClass("btn-success").text("Saved!");
                setTimeout(function () {
                    $('#save-cfg-modal').modal('hide');
                    $(btnElem).removeClass("btn-success").addClass("btn-primary").text(origText);
                }, 1500);
            }
        }
    });
}

function duplicateEval(inputDuplicateId, campaignId) {
    newCampaignId = $(`#${inputDuplicateId}`).val();

    $.post({
        url: `${url_prefix}/duplicate_eval`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            campaignId: campaignId,
            newCampaignId: newCampaignId,
            mode: window.mode
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                // hide the modal and reload the page
                $('#duplicate-eval-modal').modal('hide');
                location.reload();
            }
        }
    });
}


function gatherConfig() {
    var config = {};

    if (window.mode == "crowdsourcing") {
        config.annotatorInstructions = annotatorInstructionsMDE.value();
        // config.annotatorPrompt = $("#annotatorPrompt").val();
        config.finalMessage = finalMessageMDE.value();
        config.examplesPerBatch = $("#examplesPerBatch").val();
        config.annotatorsPerExample = $("#annotatorsPerExample").val();
        config.idleTime = $("#idleTime").val();
        config.annotationGranularity = $("#annotationGranularity").val();
        config.annotationOverlapAllowed = $("#annotationOverlapAllowed").is(":checked");
        config.annotateReason = $("#annotateReason").is(":checked");
        config.pseudonymizeAnnotators = $("#pseudonymizeAnnotators").is(":checked");
        config.service = $("#service").val();
        config.sortOrder = $("#sortOrder").val();
        config.annotationSpanCategories = getAnnotationSpanCategories();
        config.flags = getKeys($("#flags"));
        config.options = getOptions();
        config.sliders = getSliders();
        config.textFields = getKeys($("#textFields"));
    } else if (window.mode == "llm_eval" || window.mode == "llm_gen") {
        config.promptStrat = $("#prompt-strat").val();
        config.modelName = $("#model-name").val();
        config.apiProvider = $("#api-provider").val();
        config.promptTemplate = $("#prompt-template").val();
        config.systemMessage = $("#system-message").val();
        config.annotationOverlapAllowed = $("#annotationOverlapAllowed").is(":checked");
        config.apiUrl = $("#api-url").val();
        config.modelArguments = getKeysAndValues($("#model-arguments"));
        config.extraArguments = getKeysAndValues($("#extra-arguments"));

        // Add annotation field checkboxes to extra arguments for llm_eval mode
        if (window.mode == "llm_eval") {
            // Add with_reason and with_occurence_index from checkboxes
            config.extraArguments.with_reason = $("#annotation-field-reason").is(":checked");
            config.extraArguments.with_occurence_index = $("#annotation-field-occurrence").is(":checked");

            config.annotationSpanCategories = getAnnotationSpanCategories();
            config.annotationGranularity = $("#annotationGranularity").val();
            config.flags = getKeys($("#flags"));
            config.options = getOptions();
            config.sliders = getSliders();
            config.textFields = getKeys($("#textFields"));
            config.extraFieldsPromptTemplate = $("#extra-fields-prompt-template").val();
            config.additionalContextSources = collectConfiguredAdditionalContextSources();
            config.purpose = "metric"
        }
        if (window.mode == "llm_gen") {
            config.startWith = $("#start-with").val();
            config.purpose = "gen"
        }
    }
    return config;
}

function buildExtraFieldsPromptTemplate() {
    const flags = getKeys($("#flags")).filter(flag => flag && flag.trim() !== "");
    const options = getOptions().filter(option => option.label && option.values && option.values.some(value => value));
    const sliders = getSliders().filter(slider => slider.label);
    const textFields = getKeys($("#textFields")).filter(field => field && field.trim() !== "");
    const additionalContextSources = collectConfiguredAdditionalContextSources();

    const lines = [
        "You are reviewing the same evaluation example described below.",
        "",
        "Text:",
        "{text}",
        "",
        "Source data:",
        "{data}",
        "",
    ];

    if (additionalContextSources.length > 0) {
        lines.push("Additional context for this example:");
        additionalContextSources.forEach(source => {
            const label = source.description || source.field;
            lines.push(`- ${label}: {context[${source.field}]}`);
        });
        lines.push("");
    }

    lines.push(
        "Span annotations already generated:",
        "{annotations}",
        "",
        "Return valid JSON only. Do not include markdown fences or any extra commentary.",
        "",
        "Use this JSON shape:",
        "{",
        '  "flags": {"Label": true},',
        '  "options": {"Label": "selected value"},',
        '  "sliders": {"Label": 0},',
        '  "text_fields": {"Label": "free text"}',
        "}",
        "",
        "Rules:",
        "- Include every configured field exactly once.",
        "- For flags, return only true or false values.",
        "- For options, return one of the listed option values exactly.",
        "- For sliders, return a numeric value inside the allowed range.",
        '- For text fields, return a string. Use an empty string when there is nothing to add.',
    );

    if (flags.length > 0) {
        lines.push("", "Flags:");
        flags.forEach(flag => lines.push(`- "${flag}"`));
    }

    if (options.length > 0) {
        lines.push("", "Options:");
        options.forEach(option => lines.push(`- "${option.label}": ${option.values.join(", ")}`));
    }

    if (sliders.length > 0) {
        lines.push("", "Sliders:");
        sliders.forEach(slider => lines.push(`- "${slider.label}": min=${slider.min}, max=${slider.max}, step=${slider.step}`));
    }

    if (textFields.length > 0) {
        lines.push("", "Text fields:");
        textFields.forEach(textField => lines.push(`- "${textField}"`));
    }

    return lines.join("\n");
}

function updateExtraFieldsPromptEditor(forceOverwrite = false) {
    if (window.mode !== "llm_eval") {
        return;
    }

    const hasExtraFields =
        getKeys($("#flags")).filter(flag => flag && flag.trim() !== "").length > 0 ||
        getOptions().filter(option => option.label && option.values && option.values.some(value => value)).length > 0 ||
        getSliders().filter(slider => slider.label).length > 0 ||
        getKeys($("#textFields")).filter(field => field && field.trim() !== "").length > 0;

    const editorWrapper = $("#extra-fields-prompt-editor");
    const editor = $("#extra-fields-prompt-template");

    if (!hasExtraFields) {
        editorWrapper.hide();
        editor.val("");
        editor.data("autoGenerated", true);
        return;
    }

    editorWrapper.show();
    if (forceOverwrite || !editor.val().trim() || editor.data("autoGenerated") === true) {
        editor.val(buildExtraFieldsPromptTemplate());
        editor.data("autoGenerated", true);
    }
}


function pauseLLMCampaign(campaignId) {
    $(`#run-button-${campaignId}`).show();
    $(`#stop-button-${campaignId}`).hide();
    setCampaignStatus(campaignId, "idle");

    if (window.llmCampaignListeners[campaignId]) {
        window.llmCampaignListeners[campaignId].close();
        delete window.llmCampaignListeners[campaignId];
    }

    $.post({
        url: `${url_prefix}/llm_campaign/pause`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaignId: campaignId
        }),
        success: function (response) {
            console.log(response);
            $("#log-area").append("Pause requested. The current model call may still finish before the campaign stops.\n");
        }
    });
}

function prefillInstructions() {
    const annotationSpanCategories = getAnnotationSpanCategories();
    const defaultInstructions = window.default_prompts.crowdsourcing;

    if (annotationSpanCategories.length == 0) {
        alert("Please add at least one annotation span category.");
        return;
    }
    // if annotatorInstructionsMDE contains some text, ask for confirmation
    if (annotatorInstructionsMDE.value().length > 0) {
        if (!confirm("Are you sure you want to overwrite the current instructions?")) {
            return;
        }
    }

    var errorList = [];
    annotationSpanCategories.forEach((category) => {
        const span = `- <span style="color: ${category.color}; text-decoration: underline; text-decoration-thickness: 4px; text-decoration-skip-ink: none"><b>${category.name}</b></span>: ${category.description}`;
        errorList.push(span);
    });
    var instructions = defaultInstructions.replace(/{error_list}/g, errorList.join("\n") + "\n");
    annotatorInstructionsMDE.value(instructions);
}

function prefillPrompt() {
    const annotationSpanCategories = getAnnotationSpanCategories();
    const defaultPrompt = window.default_prompts.llm_eval;

    if (annotationSpanCategories.length == 0) {
        alert("Please add at least one annotation span category.");
        return;
    }

    // if promptTemplate contains some text, ask for confirmation
    if ($("#prompt-template").val().length > 0) {
        if (!confirm("Are you sure you want to overwrite the current prompt?")) {
            return;
        }
    }
    var errorList = [];

    annotationSpanCategories.forEach((category, idx) => {
        const span = `${idx}: ${category.name} (${category.description})`;
        errorList.push(span);
    });

    var prompt = defaultPrompt.replace(/{error_list}/g, errorList.join("\n"));
    $("#prompt-template").val(prompt);
}


function runLLMCampaign(campaignId) {
    $(`#run-button-${campaignId}`).hide();
    $(`#stop-button-${campaignId}`).show();
    setCampaignStatus(campaignId, "running");

    startLLMCampaignListener(campaignId);

    $.post({
        url: `${url_prefix}/${mode}/run`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaignId: campaignId
        }),
        success: function (response) {
            if (response.success !== true) {
                alert(response.error);
                $("#log-area").text(JSON.stringify(response.error));
                console.log(JSON.stringify(response));

                setCampaignStatus(campaignId, "idle");
                $(`#run-button-${campaignId}`).show();
                $(`#stop-button-${campaignId}`).hide();
            } else {
                console.log(response);
            }
        }
    });
}

function saveConfig(mode) {
    const filename = $("#config-save-filename").val() + ".yaml";
    const config = gatherConfig();

    if (filename in window.configs) {
        if (!confirm(`The configuration with the name ${filename} already exists. Do you want to overwrite it?`)) {
            return;
        }
    }
    $.post({
        url: `${url_prefix}/save_config`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            mode: mode,
            filename: filename,
            config: config
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                // change color of the button save-cfg-submit to green for a second with the label "Saved!", then back to normal
                $("#save-cfg-submit").removeClass("btn-primary").addClass("btn-success").text("Saved!");
                setTimeout(function () {
                    $('#save-cfg-modal').modal('hide');
                    $("#save-cfg-submit").removeClass("btn-success").addClass("btn-primary").text("Save");
                }, 1500);
            }
        }
    });

}

function saveGenerationOutputs(campaignId) {
    modelName = $("#save-generations-model-name").val();

    $.post({
        url: `${url_prefix}/save_generation_outputs`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            campaignId: campaignId,
            modelName: modelName
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                // change color of the button save-cfg-submit to green for a second with the label "Saved!", then back to normal
                $("#save-generations-submit").removeClass("btn-primary").addClass("btn-success").text("Saved!");
                setTimeout(function () {
                    $('#save-generations-modal').modal('hide');
                    $("#save-generations-submit").removeClass("btn-success").addClass("btn-primary").text("Save");
                }, 1500);
            }
        }
    });
}

function setCampaignStatus(campaignId, status) {
    $(`#metadata-status-${campaignId}`).html(status);
    $(`#metadata-status-${campaignId}`).removeClass("bg-idle bg-running bg-finished bg-error");
    $(`#metadata-status-${campaignId}`).addClass(`bg-${status}`);
}

function setExampleStatus(status, button) {
    button.removeClass("bg-free bg-finished");
    button.addClass(`bg-${status}`);
    button.text(status);
}


function showResult(payload, campaignId) {
    const finished_examples = payload.stats.finished;
    const total_examples = payload.stats.total;
    const progress = Math.round((finished_examples / total_examples) * 100);
    $(`#llm-progress-bar-${campaignId}`).css("width", `${progress}%`);
    $(`#llm-progress-bar-${campaignId}`).attr("aria-valuenow", progress);
    $(`#metadata-example-cnt-${campaignId}`).html(`${finished_examples} / ${total_examples}`);
    console.log(`Progress: ${progress}%`);


    // update the annotation button
    const example = payload.response;
    const dataset = example.dataset;
    const split = example.split;
    const setup_id = example.setup_id || campaignId;
    const example_idx = example.example_idx;
    const rowId = `${dataset}-${split}-${setup_id}-${example_idx}`;
    const annotation_button = $(`#annotBtn${rowId}`);
    annotation_button.show();

    const clear_output_button = $(`#clearOutput${rowId}`);
    clear_output_button.show();

    // update the annotation content
    const annotation_div = $(`#annotPre${rowId}`);

    // llm_eval mode
    if (example.annotations !== undefined) {
        annotation_div.text(JSON.stringify(example.annotations));
    } else { // llm_gen mode
        annotation_div.text(example.output);
    }
    $(`#annotCard${rowId}`).show();
    // update the status
    const status_button = $(`#statusBtn${rowId}`);
    setExampleStatus("finished", status_button);
}

function finalizeCampaign(campaignId) {
    console.log("Closing the connection");

    if (window.llmCampaignListeners[campaignId]) {
        delete window.llmCampaignListeners[campaignId];
    }

    setCampaignStatus(campaignId, "finished");
    $(`#run-button-${campaignId}`).hide();
    $(`#stop-button-${campaignId}`).hide();
    $(`#download-button-${campaignId}`).show();

    if (window.mode == "llm_gen") {
        $("#save-generations-button").show();
    }

}

function failCampaign(campaignId, message) {
    if (window.llmCampaignListeners[campaignId]) {
        window.llmCampaignListeners[campaignId].close();
        delete window.llmCampaignListeners[campaignId];
    }

    setCampaignStatus(campaignId, "idle");
    $(`#run-button-${campaignId}`).show();
    $(`#stop-button-${campaignId}`).hide();
    $("#log-area").text(message);
    alert(message);
}

function startLLMCampaignListener(campaignId) {
    if (window.llmCampaignListeners[campaignId]) {
        window.llmCampaignListeners[campaignId].close();
    }

    var source = new EventSource(`${url_prefix}/llm_campaign/progress/${campaignId}`);
    window.llmCampaignListeners[campaignId] = source;
    console.log(`Listening for progress events for campaign ${campaignId}`);

    source.onmessage = function (event) {
        // update the progress bar
        var payload = JSON.parse(event.data);

        if (payload.type === "status") {
            console.log(payload.message);
        }
        else if (payload.type === "result") {
            showResult(payload, campaignId);

            if (payload.stats.finished == payload.stats.total) {
                source.close();
                delete window.llmCampaignListeners[campaignId];
                finalizeCampaign(campaignId);
            }
        }
        else if (payload.type === "error") {
            failCampaign(campaignId, payload.message || "Unknown campaign error.");
        }
    };

    source.onerror = function () {
        if (window.llmCampaignListeners[campaignId] === source) {
            source.close();
            delete window.llmCampaignListeners[campaignId];
        }
    };
}


function updateCampaignConfig(campaignId) {
    // collect values of all .campaign-metadata textareas, for each input also extract the key in `data-key`
    var config = {};
    $(`.campaign-metadata-${campaignId}`).each(function () {
        const key = $(this).data("key");
        const value = $(this).val();
        config[key] = value;
    });

    $.post({
        url: `${url_prefix}/llm_campaign/update_metadata`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaignId: campaignId,
            config: config
        }),
        success: function (response) {
            console.log(response);
            $(".update-config-btn").removeClass("btn-danger").addClass("btn-success").text("Saved!");

            setTimeout(function () {
                $(`#config-modal-${campaignId}`).modal('hide');
                $(".update-config-btn").removeClass("btn-success").addClass("btn-danger").text("Update configuration");
            }, 1500);

        }
    });
}

function setCampaignPseudonymizeAnnotators(campaignId, pseudonymizeAnnotators) {
    $.post({
        url: `${url_prefix}/set_campaign_pseudonymize_annotators`,
        contentType: 'application/json',
        data: JSON.stringify({
            campaignId: campaignId,
            pseudonymizeAnnotators: pseudonymizeAnnotators
        }),
        success: function (response) {
            console.log(response);

            if (response.success !== true) {
                alert(response.error);
            } else {
                location.reload();
            }
        }
    });
}

function updateCrowdsourcingConfig() {
    const crowdsourcingConfig = $('#crowdsourcingConfig').val();

    if (crowdsourcingConfig === "[None]") {
        annotatorInstructionsMDE.value("");
        // $("#annotatorPrompt").val("");
        finalMessageMDE.value("");
        $("#examplesPerBatch").val("");
        $("#annotatorsPerExample").val("");
        $("#idleTime").val("");
        $("#annotationOverlapAllowed").prop("checked", false);
        $("#annotateReason").prop("checked", false);
        $("#pseudonymizeAnnotators").prop("checked", true);
        $("#annotation-span-categories").empty();
        $("#flags").empty();
        $("#options").empty();
        $("#sliders").empty();
        $("#textFields").empty();
        return;
    }
    const cfg = window.configs[crowdsourcingConfig];

    const annotatorInstructions = cfg.annotator_instructions;
    const finalMessage = cfg.final_message;
    const examplesPerBatch = cfg.examples_per_batch;
    const annotatorsPerExample = cfg.annotators_per_example;
    const idleTime = cfg.idle_time;
    const annotationGranularity = cfg.annotation_granularity;
    const annotationOverlapAllowed = cfg.annotation_overlap_allowed;
    const annotateReason = cfg.annotate_reason;
    const pseudonymizeAnnotators = cfg.pseudonymize_annotators !== false;
    const service = cfg.service;
    const sortOrder = cfg.sort_order;
    const annotationSpanCategories = cfg.annotation_span_categories;
    const flags = cfg.flags;
    const options = cfg.options;
    const sliders = cfg.sliders;
    const textFields = cfg.text_fields;

    annotatorInstructionsMDE.value(annotatorInstructions);
    // $("#annotatorPrompt").val(annotatorPrompt);
    finalMessageMDE.value(finalMessage);
    $("#examplesPerBatch").val(examplesPerBatch);
    $("#annotatorsPerExample").val(annotatorsPerExample);
    $("#idleTime").val(idleTime);
    $("#annotationGranularity").val(annotationGranularity);
    $("#annotationOverlapAllowed").prop("checked", annotationOverlapAllowed);
    $("#annotateReason").prop("checked", annotateReason);
    $("#pseudonymizeAnnotators").prop("checked", pseudonymizeAnnotators);
    $("#service").val(service);
    $("#sortOrder").val(sortOrder);
    $("#annotation-span-categories").empty();

    annotationSpanCategories.forEach((annotationSpanCategory) => {
        addAnnotationSpanCategory(
            annotationSpanCategory.name,
            annotationSpanCategory.description,
            annotationSpanCategory.color,
            annotationSpanCategory
        );
    });
    $("#flags").empty();

    if (flags !== undefined) {
        flags.forEach((flag) => {
            const newFlag = createFlagElem(flag);
            $("#flags").append(newFlag);
        });
    }

    $("#options").empty();

    if (options !== undefined) {
        options.forEach((option) => {
            const newOption = createOptionElem(option.label, option.values.join(", "));
            $("#options").append(newOption);
        });
    }

    $("#sliders").empty();

    if (sliders !== undefined) {
        sliders.forEach((slider) => {
            const newSlider = createSliderElem(slider.label, slider.min, slider.max, slider.step);
            $("#sliders").append(newSlider);
        });
    }

    $("#textFields").empty();

    if (textFields !== undefined) {
        textFields.forEach((textField) => {
            const newTextField = createTextFieldElem(textField);
            $("#textFields").append(newTextField);
        });
    }
}

function importCrowdsourcingConfigToLLM() {
    const crowdsourcingConfig = $('#crowdsourcingImportConfig').val();

    if (crowdsourcingConfig === "[None]") {
        return;
    }

    const cfg = window.crowdsourcing_configs ? window.crowdsourcing_configs[crowdsourcingConfig] : undefined;
    if (cfg === undefined) {
        alert(`Unknown crowdsourcing config: ${crowdsourcingConfig}`);
        return;
    }

    const annotationSpanCategories = cfg.annotation_span_categories || [];
    const annotationGranularity = cfg.annotation_granularity || "words";
    const annotationOverlapAllowed = cfg.annotation_overlap_allowed || false;
    const annotateReason = cfg.annotate_reason || false;
    const annotatorInstructions = cfg.annotator_instructions || "";
    const extraFieldsPromptTemplate = cfg.extra_fields_prompt_template || "";
    const flags = cfg.flags;
    const options = cfg.options;
    const sliders = cfg.sliders;
    const textFields = cfg.text_fields;

    $("#annotation-span-categories").empty();
    $("#annotationGranularity").val(annotationGranularity);
    $("#annotationOverlapAllowed").prop("checked", annotationOverlapAllowed);
    $("#annotation-field-reason").prop("checked", annotateReason);
    $("#system-message").val(annotatorInstructions);

    annotationSpanCategories.forEach((annotationSpanCategory) => {
        addAnnotationSpanCategory(
            annotationSpanCategory.name,
            annotationSpanCategory.description,
            annotationSpanCategory.color,
            annotationSpanCategory
        );
    });

    $("#flags").empty();
    if (flags !== undefined) {
        flags.forEach((flag) => {
            const newFlag = createFlagElem(flag);
            $("#flags").append(newFlag);
        });
    }

    $("#options").empty();
    if (options !== undefined) {
        options.forEach((option) => {
            const newOption = createOptionElem(option.label, option.values.join(", "));
            $("#options").append(newOption);
        });
    }

    $("#sliders").empty();
    if (sliders !== undefined) {
        sliders.forEach((slider) => {
            const newSlider = createSliderElem(slider.label, slider.min, slider.max, slider.step);
            $("#sliders").append(newSlider);
        });
    }

    $("#textFields").empty();
    if (textFields !== undefined) {
        textFields.forEach((textField) => {
            const newTextField = createTextFieldElem(textField);
            $("#textFields").append(newTextField);
        });
    }

    if (extraFieldsPromptTemplate) {
        $("#extra-fields-prompt-template").val(extraFieldsPromptTemplate);
        $("#extra-fields-prompt-template").data("autoGenerated", false);
    }
    updateExtraFieldsPromptEditor(!extraFieldsPromptTemplate);
}


function updateLLMMetricConfig() {
    const llmConfigValue = $('#llmConfig').val();

    if (llmConfigValue === "[None]") {
        $("#model-name").val("");
        $("#prompt-template").val("");
        $("#system-message").val("");
        $("#api-url").val("");
        $("#model-arguments").empty();
        $("#annotation-span-categories").empty();
        $("#extra-arguments").empty();
        $("#annotationOverlapAllowed").prop("checked", false);

        // Reset annotation field checkboxes to default values for llm_eval mode
        if (mode == "llm_eval") {
            $("#annotation-field-reason").prop("checked", true);  // Default: checked
            $("#annotation-field-occurrence").prop("checked", false);  // Default: unchecked
            $("#flags").empty();
            $("#options").empty();
            $("#sliders").empty();
            $("#textFields").empty();
            renderAdditionalContextSources([]);
            $("#extra-fields-prompt-template").val("");
            $("#extra-fields-prompt-template").data("autoGenerated", true);
            updateExtraFieldsPromptEditor(true);
        }
        return;
    }
    const cfg = window.configs[llmConfigValue];

    // Supporting a deprecated `type` field
    const api_provider = cfg.api_provider || cfg.type;
    const prompt_strat = cfg.prompt_strat;
    const model_name = cfg.model;
    const prompt_template = cfg.prompt_template;
    const system_msg = cfg.system_msg;
    const annotation_overlap_allowed = cfg.annotation_overlap_allowed;
    const api_url = cfg.api_url;
    const model_args = cfg.model_args;
    const extra_args = cfg.extra_args;
    const extra_fields_prompt_template = cfg.extra_fields_prompt_template || "";

    // for metric, we need to select the appropriate one from the values in the select box
    $("#api-provider").val(api_provider);
    $("#prompt-strat").val(prompt_strat);
    $("#model-name").html(model_name);
    $("#prompt-template").html(prompt_template);
    $("#system-message").html(system_msg);
    $("#annotationOverlapAllowed").prop("checked", annotation_overlap_allowed);
    $("#api-url").html(api_url);
    $("#model-arguments").empty();
    $("#extra-arguments").empty();

    $.each(model_args, function (key, value) {
        const newArg = createArgElem(key, value);
        $("#model-arguments").append(newArg);
    });

    // Track which annotation field checkboxes were explicitly set
    let withReasonSet = false;
    let withOccurrenceSet = false;

    $.each(extra_args, function (key, value) {
        // Handle special annotation field checkboxes for llm_eval mode
        if (mode == "llm_eval" && (key === "with_reason" || key === "with_occurence_index")) {
            if (key === "with_reason") {
                $("#annotation-field-reason").prop("checked", value);
                withReasonSet = true;
            } else if (key === "with_occurence_index") {
                $("#annotation-field-occurrence").prop("checked", value);
                withOccurrenceSet = true;
            }
        } else {
            // Add other extra arguments as usual
            const newArg = createArgElem(key, value);
            $("#extra-arguments").append(newArg);
        }
    });

    // Set default values for annotation field checkboxes if they weren't explicitly set
    if (mode == "llm_eval") {
        if (!withReasonSet) {
            $("#annotation-field-reason").prop("checked", true);  // Default: checked
        }
        if (!withOccurrenceSet) {
            $("#annotation-field-occurrence").prop("checked", false);  // Default: unchecked
        }
    }

    if (mode == "llm_eval") {
        const annotationSpanCategories = cfg.annotation_span_categories;
        const annotation_granularity = cfg.annotation_granularity || "words";
        const flags = cfg.flags;
        const options = cfg.options;
        const sliders = cfg.sliders;
        const textFields = cfg.text_fields || cfg.textFields;
        const additionalContextSources = cfg.additional_context_sources || cfg.additionalContextSources || [];
        $("#annotation-span-categories").empty();
        $("#annotationGranularity").val(annotation_granularity);

        annotationSpanCategories.forEach((annotationSpanCategory) => {
            addAnnotationSpanCategory(
                annotationSpanCategory.name,
                annotationSpanCategory.description,
                annotationSpanCategory.color,
                annotationSpanCategory
            );
        });

        $("#flags").empty();
        if (flags !== undefined) {
            flags.forEach((flag) => {
                const newFlag = createFlagElem(flag);
                $("#flags").append(newFlag);
            });
        }

        $("#options").empty();
        if (options !== undefined) {
            options.forEach((option) => {
                const newOption = createOptionElem(option.label, option.values.join(", "));
                $("#options").append(newOption);
            });
        }

        $("#sliders").empty();
        if (sliders !== undefined) {
            sliders.forEach((slider) => {
                const newSlider = createSliderElem(slider.label, slider.min, slider.max, slider.step);
                $("#sliders").append(newSlider);
            });
        }

        $("#textFields").empty();
        if (textFields !== undefined) {
            textFields.forEach((textField) => {
                const newTextField = createTextFieldElem(textField);
                $("#textFields").append(newTextField);
            });
        }

        renderAdditionalContextSources(additionalContextSources);

        if (extra_fields_prompt_template) {
            $("#extra-fields-prompt-template").val(extra_fields_prompt_template);
            $("#extra-fields-prompt-template").data("autoGenerated", false);
        } else {
            $("#extra-fields-prompt-template").data("autoGenerated", true);
        }
        updateExtraFieldsPromptEditor(!extra_fields_prompt_template);
    }
    if (mode == "llm_gen") {
        const start_with = cfg.start_with;
        $("#start-with").val(start_with);
    }

    scheduleOpenRouterValidation();
}

$(document).on("input", "#extra-fields-prompt-template", function () {
    $(this).data("autoGenerated", false);
});

$(document).on(
    "input change",
    "#flags input, #options input, #sliders input, #textFields input, #additional-context-sources input",
    function () {
        updateExtraFieldsPromptEditor();
    }
);
$("#api-provider").on("change", scheduleOpenRouterValidation);
$("#model-name").on("input", scheduleOpenRouterValidation);

$(document).ready(function () {
    populateAdditionalContextSetupIdOptions();
});
