// Initialize an array to store annotations
let annotations = [];

function getExampleFieldConfig() {
    return {
        flags: getKeys($("#flags")).filter(flag => flag && flag.trim() !== ""),
        options: getOptions().filter(option => option.label && option.values && option.values.length > 0),
        sliders: getSliders().filter(slider => slider.label),
        textFields: getKeys($("#textFields")).filter(field => field && field.trim() !== "")
    };
}

function renderExampleFields() {
    const { flags, options, sliders, textFields } = getExampleFieldConfig();

    $("#example-flags").empty();
    $("#example-options").empty();
    $("#example-sliders").empty();
    $("#example-text-fields").empty();

    if (flags.length === 0 && options.length === 0 && sliders.length === 0 && textFields.length === 0) {
        $("#example-fields-area").hide();
        return;
    }

    $("#example-fields-area").show();

    if (flags.length > 0) {
        const flagsWrapper = $('<div>', { class: 'small' });
        flags.forEach((flag, index) => {
            const id = `example-flag-${index}`;
            const row = $('<div>', { class: 'form-check mb-1 crowdsourcing-flag example-flag' });
            row.append($('<input>', { class: 'form-check-input', type: 'checkbox', id: id }));
            row.append($('<label>', { class: 'form-check-label', for: id }).text(flag));
            flagsWrapper.append(row);
        });
        $("#example-flags").append(flagsWrapper);
    }

    if (options.length > 0) {
        const optionsWrapper = $('<div>');
        options.forEach((option, index) => {
            const id = `example-option-${index}`;
            const row = $('<div>', { class: 'mb-2 crowdsourcing-option example-option' });
            row.append($('<label>', { class: 'form-label', for: id }).text(option.label));
            const select = $('<select>', { class: 'form-select', id: id });
            option.values.forEach((value, valueIndex) => {
                select.append($('<option>', { value: valueIndex }).text(value));
            });
            row.append(select);
            optionsWrapper.append(row);
        });
        $("#example-options").append(optionsWrapper);
    }

    if (sliders.length > 0) {
        const slidersWrapper = $('<div>');
        sliders.forEach((slider, index) => {
            const id = `example-slider-${index}`;
            const valueId = `${id}-value`;
            const row = $('<div>', { class: 'mb-3 crowdsourcing-slider example-slider' });
            row.append($('<label>', { class: 'form-label', for: id }).text(slider.label));
            row.append(
                $('<input>', {
                    class: 'form-range example-slider-input',
                    type: 'range',
                    id: id,
                    min: slider.min,
                    max: slider.max,
                    step: slider.step || 1,
                    value: slider.min
                })
            );
            row.append(
                $('<div>', {
                    class: 'small text-muted slider-crowdsourcing-value',
                    id: valueId,
                    'data-default-value': slider.min
                }).text(slider.min)
            );
            slidersWrapper.append(row);
        });
        $("#example-sliders").append(slidersWrapper);
        $(".example-slider-input").off("input.exampleSliderValue change.exampleSliderValue").on("input.exampleSliderValue change.exampleSliderValue", function () {
            const valueId = `${$(this).attr("id")}-value`;
            $(`#${valueId}`).text($(this).val());
        });
    }

    if (textFields.length > 0) {
        const textFieldsWrapper = $('<div>');
        textFields.forEach((textField, index) => {
            const id = `example-text-field-${index}`;
            const row = $('<div>', { class: 'mb-2 crowdsourcing-text example-text-field' });
            row.append($('<label>', { class: 'form-label', for: id }).text(textField));
            row.append($('<input>', { class: 'form-control', type: 'text', id: id }));
            textFieldsWrapper.append(row);
        });
        $("#example-text-fields").append(textFieldsWrapper);
    }
}

function collectExampleFlags() {
    const flags = [];
    $("#example-flags .crowdsourcing-flag").each(function () {
        const label = $(this).find("label").text().trim();
        const value = $(this).find("input[type='checkbox']").prop("checked");
        flags.push({ label: label, value: value });
    });
    return flags;
}

function collectExampleOptions() {
    const options = [];
    $("#example-options .crowdsourcing-option").each(function () {
        const label = $(this).find("label").text().trim();
        const index = $(this).find("select").val();
        const value = $(this).find("select option:selected").text();
        const optionList = $(this).find("select option").map(function () {
            return $(this).text();
        }).get();
        options.push({ label: label, index: index, value: value, optionList: optionList });
    });
    return options;
}

function collectExampleSliders() {
    const sliders = [];
    $("#example-sliders .crowdsourcing-slider").each(function () {
        const input = $(this).find("input[type='range']");
        sliders.push({
            label: $(this).find("label").text().trim(),
            value: input.val(),
            min: input.attr("min"),
            max: input.attr("max"),
            step: input.attr("step")
        });
    });
    return sliders;
}

function collectExampleTextFields() {
    const textFields = [];
    $("#example-text-fields .crowdsourcing-text").each(function () {
        textFields.push({
            label: $(this).find("label").text().trim(),
            value: $(this).find("input[type='text']").val()
        });
    });
    return textFields;
}

// Function to update the outputarea with the annotations JSON
function updateOutputArea() {
    // include only the fields reason, text and type in the stringified JSON and omit the rest
    const output = {
        "annotations": annotations.map(a => ({ "reason": a.reason, "text": a.text, "type": a.type }))
    };
    const flags = collectExampleFlags();
    const options = collectExampleOptions();
    const sliders = collectExampleSliders();
    const textFields = collectExampleTextFields();

    if (flags.length > 0) {
        output.flags = flags;
    }
    if (options.length > 0) {
        output.options = options;
    }
    if (sliders.length > 0) {
        output.sliders = sliders;
    }
    if (textFields.length > 0) {
        output.text_fields = textFields;
    }

    $('#outputarea').text(JSON.stringify(output, null, 4));
}

// Function to handle adding a new annotation
function onAnnotationAdded(annotation) {
    // Add the annotation to the annotations array
    annotations.push(annotation);
    const categoryName = getAnnotationSpanCategories()[annotation.type].name;

    // Add a new row to the errorarea
    const row = $(`
         <tr id="error-row-${annotation.id}">
             <td>${categoryName}</td>
             <td>${annotation.text}</td>
             <td>
                 <input type="text" class="form-control reason-input" data-id="${annotation.id}" placeholder="Enter reason">
             </td>
         </tr>
     `);
    $('#errorarea').append(row);

    // Attach event listener to the reason input
    row.find('.reason-input').on('input', function () {
        const id = $(this).data('id');
        const reason = $(this).val();
        // Update the reason in the annotations array
        const annotation = annotations.find(a => a.id === id);
        if (annotation) {
            annotation.reason = reason;
            updateOutputArea();
        }
    });

    // Update the output area
    updateOutputArea();
}

// Function to handle deleting an annotation
function onAnnotationDeleted(annotation) {
    const annotationId = annotation.cid;

    // Remove the annotation from the annotations array
    annotations = annotations.filter(a => a.id !== annotationId);

    // Remove the corresponding row from errorarea
    $(`#error-row-${annotationId}`).remove();

    // Update the output area
    updateOutputArea();
}

function pasteExampleIntoPrompt() {
    const exampleData = $('#example-data').val();
    const exampleText = $('#example-text').val();
    const output = $('#outputarea').text();
    const prompt = `\n\n*Example:*\ninput:\n\`\`\`\n${exampleData}\n\`\`\`\ntext:\n\`\`\`\n${exampleText}\n\`\`\`\noutput:\n\`\`\`\n${output}\n`;
    $('#prompt-template').val($('#prompt-template').val() + prompt);
    $('#exampleAnnotation').modal('hide');
}

function createButtons() {
    // if buttons already exist, remove them
    $('#buttons-area').empty();

    const annotationSpanCategories = getAnnotationSpanCategories();

    for (const [idx, category] of Object.entries(annotationSpanCategories)) {
        const input = $('<input>', {
            type: "radio",
            class: "btn-check btn-outline-secondary btn-err-cat",
            name: "btnradio",
            id: `btnradio${idx}`,
            autocomplete: "off",
            "data-cat-idx": idx
        });

        const label = $('<label>', {
            class: "btn btn-err-cat-label me-1",
            for: `btnradio${idx}`,
            style: `background-color: ${category.color};`
        }).text(category.name);

        if (idx == 0) {
            input.attr('checked', 'checked');
            label.addClass('active');
        }

        $('#buttons-area').append(input);
        $('#buttons-area').append(label);
    }

    // Add eraser button
    const eraserInput = $('<input>', {
        type: "radio",
        class: "btn-check btn-outline-secondary btn-eraser",
        name: "btnradio",
        id: "btnradioeraser",
        autocomplete: "off",
        "data-cat-idx": "-1"
    });

    const eraserLabel = $('<label>', {
        class: "btn btn-err-cat-label ms-auto",
        for: "btnradioeraser",
        style: "background-color: #FFF; color: #000 !important;"
    }).text("Erase mode");

    $('#buttons-area').append(eraserInput);
    $('#buttons-area').append(eraserLabel);

    // Event handlers
    $(".btn-err-cat, .btn-eraser").change(function () {
        if (this.checked) {
            const cat_idx = $(this).attr("data-cat-idx");
            spanAnnotator.setCurrentAnnotationType(cat_idx);
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
}

function initAnnotation() {
    $("#nextsteparea").show();
    $('#errorarea').empty();
    $('#outputarea').empty();
    $('#annotationarea').empty();
    annotations = [];

    const annotationSpanCategories = getAnnotationSpanCategories();

    spanAnnotator.init(
        "words",
        true,
        annotationSpanCategories
    );

    const exampleText = $('#example-text').val();
    const p = $('<p>', { class: 'annotatable-paragraph' }).html(exampleText);

    // add paragraph to #annotationarea
    $('#annotationarea').append(p);

    spanAnnotator.addDocument("p-example", p, true);
    spanAnnotator.setCurrentAnnotationType(0);
    renderExampleFields();
    updateOutputArea();
    spanAnnotator.clearEventListeners('annotationAdded');
    spanAnnotator.clearEventListeners('annotationRemoved');

    spanAnnotator.addEventListener('annotationAdded', function (data) {
        onAnnotationAdded(data.annotation);
    });

    spanAnnotator.addEventListener('annotationRemoved', function (data) {
        data.removedAnnotations.forEach(annotation => {
            onAnnotationDeleted(annotation);
        });
    });

    $("#example-fields-area input, #example-fields-area select")
        .off("input.exampleOutput change.exampleOutput")
        .on("input.exampleOutput change.exampleOutput", function () {
        updateOutputArea();
        });
}

function checkAndOpenModal() {
    const annotationSpanCategories = getAnnotationSpanCategories();
    if (annotationSpanCategories.length == 0) {
        alert("Please add at least one annotation span category.");
        return;
    }
    createButtons();
    var modal = new bootstrap.Modal('#exampleAnnotation');
    modal.show();
}
