const metadata = window.metadata;
const campaigns = window.campaigns;

function deleteRow(button) {
    $(button).parent().parent().remove();
}

function getSelectedCampaigns() {
    const selectedCampaigns = $('.btn-check-campaign:checked').map(function () {
        return $(this).data('content');
    }).get();
    return selectedCampaigns;
}

function downloadBlob(data, filename) {
    const blob = new Blob([data], { type: 'application/zip' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'agreement_files.zip';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
}

function downloadIaaFiles() {
    // get the selected campaigns and ask the backend
    const selectedCombinations = gatherSelectedCombinations();
    const selectedCampaigns = getSelectedCampaigns();

    if (selectedCombinations.length == 0) {
        alert("Please select some data for comparison.");
        return;
    }

    $("#agreement-spinner").show();

    $.post({
        url: `${url_prefix}/compute_agreement`,
        contentType: 'application/json', // Specify JSON content type
        data: JSON.stringify({
            selectedCampaigns: selectedCampaigns,
            combinations: selectedCombinations,
        }),
        xhrFields: {
            responseType: 'blob'  // Set response type to blob for binary data
        },
        success: function (response) {
            downloadBlob(response, 'agreement_files.zip');
            $("#agreement-spinner").hide();
        },
        error: function (response) {
            alert("An error occurred: " + response.responseText);
        }
    });
}


function populateTable(tableId, data, columns) {
    var table = $(`#${tableId} tbody`);
    table.empty(); // Clear existing rows

    for (const obj of data) {
        let row = '<tr>';
        for (const col of columns) {
            if (col === 'annotation_type') {
                row += `<td>
                    <span class="badge" style="background-color: ${metadata.config.annotation_span_categories[obj[col]].color}; color: rgb(253, 253, 253);">
                        ${metadata.config.annotation_span_categories[obj[col]].name}
                    </span>
                </td>`;
            } else {
                row += `<td>${obj[col]}</td>`;
            }
        }
        row += '</tr>';
        table.append(row);
    }
    $(`#${tableId}`).bootstrapTable();
}

function updateComparisonData() {
    const selectedCampaigns = getSelectedCampaigns();

    $('#common-categories').html("None");
    $('#common-examples').html("0");
    $("#selectedDatasetsContent").empty();
    $("#agreement-btn").addClass("disabled")

    // find which category label names are common to all campaigns
    const campaignCategories = selectedCampaigns.map(c => campaigns[c].metadata.config.annotation_span_categories).map(c => c.map(cat => cat.name));
    const commonCategories = campaignCategories.reduce((acc, val) => {
        return acc.filter(x => val.some(y => y === x));
    });

    $('#common-categories').html(
        commonCategories.map(c => `<span class="badge bg-secondary">${c}</span>`).join("\n")
    );

    // Create campaign-annotator group combinations
    const campaignAnnotatorGroups = selectedCampaigns.flatMap(campaign => {
        const campaignData = campaigns[campaign].data;
        const annotatorGroups = [...new Set(campaignData.map(d => d.annotator_group))];
        return annotatorGroups.map(group => ({ campaign, group }));
    });

    // Get examples for each campaign-annotator group combination
    const combinations = campaignAnnotatorGroups.map(({ campaign, group }) =>
        campaigns[campaign].data.filter(d => d.annotator_group === group)
    );

    // Find common examples across all combinations
    const commonExamples = combinations.reduce((acc, val) => {
        return acc.filter(x => val.some(y =>
            y.dataset === x.dataset &&
            y.split === x.split &&
            y.setup_id === x.setup_id
        ));
    });
    const finishedExamples = commonExamples.filter(e => e.status === 'finished');

    // Count examples per dataset-split-setup combination
    const exampleCounts = finishedExamples.reduce((acc, val) => {
        const key = `${val.dataset}|${val.split}|${val.setup_id}`;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const filteredExampleCounts = Object.entries(exampleCounts).reduce((acc, [key, count]) => {
        const [dataset, split, setup_id] = key.split('|');
        const groupsWithExample = campaignAnnotatorGroups.filter(({ campaign, group }) => {
            return campaigns[campaign].data.some(d =>
                d.annotator_group === group &&
                d.dataset === dataset &&
                d.split === split &&
                d.setup_id === setup_id &&
                d.status === 'finished'
            );
        });

        if (groupsWithExample.length >= 2) {
            acc[key] = count;
        }
        return acc;
    }, {});

    const comparisonData = Object.entries(filteredExampleCounts).map(([key, count]) => {
        const [dataset, split, setup_id] = key.split('|');
        const groups = campaignAnnotatorGroups
            .map(({ campaign, group }) => `${campaign}:${group}`)
            .join(", ");
        return { dataset, split, setup_id, example_count: count, groups };
    });

    $("#selectedDatasetsContent").html(
        comparisonData.map(d =>
            `<tr>
                <td>${d.dataset}</td>
                <td>${d.split}</td>
                <td>${d.setup_id}</td>
                <td>${d.example_count}</td>
                <td><small>${d.groups}</small></td>
                <td><button type="button" class="btn btn-sm btn-secondary" onclick="deleteRow(this);">x</button></td>
            </tr>`
        ).join("\n")
    );

    $('#common-examples').html(finishedExamples.length);
    $("#agreement-btn").removeClass("disabled");

    return combinations;
}

const fullTableColumns = ['dataset', 'split', 'setup_id', 'example_count', 'annotation_type', 'ann_count', 'avg_count', 'prevalence'];
const spanTableColumns = ['example_count', 'annotation_type', 'ann_count', 'avg_count', 'prevalence'];
const setupTableColumns = ['setup_id', 'example_count', 'annotation_type', 'ann_count', 'avg_count', 'prevalence'];
const datasetTableColumns = ['dataset', 'split', 'example_count', 'annotation_type', 'ann_count', 'avg_count', 'prevalence'];
const sliderOverallColumns = ['label', 'count', 'min_value', 'max_value', 'avg_value', 'std_value'];
const sliderMetrics = [
    { key: 'count', label: 'Count' },
    { key: 'avg_value', label: 'Avg' },
    { key: 'min_value', label: 'Min' },
    { key: 'max_value', label: 'Max' },
];

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function slugifyField(label) {
    const base = String(label ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return base || 'slider';
}

function buildLabelKeys(labels) {
    const keys = {};
    const used = new Set();
    labels.forEach((label, idx) => {
        let base = slugifyField(label);
        let key = base;
        let suffix = 1;
        while (used.has(key)) {
            key = `${base}_${suffix}`;
            suffix += 1;
        }
        used.add(key);
        keys[label] = key || `slider_${idx}`;
    });
    return keys;
}

function buildExampleCell(row) {
    const preview = escapeHtml(row.example_preview || '');
    const full = escapeHtml(row.example_full || '');
    if (!full || preview === full) {
        return preview || '<span class="text-muted">(empty)</span>';
    }
    const summaryText = preview ? `${preview}…` : 'Show';
    return `
        <details>
            <summary>${summaryText}</summary>
            <div class="text-muted small" style="white-space: pre-wrap;">${full}</div>
        </details>
    `;
}

function renderSliderSetupTables(sliderStats) {
    const container = $('#slider-setup-tables');
    container.empty();

    if (!sliderStats || !sliderStats.by_setup || sliderStats.by_setup.length === 0) {
        $('#slider-stats-empty').show();
        return;
    }

    $('#slider-stats-empty').hide();

    sliderStats.by_setup.forEach((setup, index) => {
        const title = `${setup.dataset} / ${setup.split} / ${setup.setup_id}`;
        const tableId = `slider-setup-table-${index}`;

        container.append(`<div class="mt-4 text-muted small">Dataset and setup</div>`);
        container.append(`<h5 class="mt-1">${escapeHtml(title)}</h5>`);

        const table = $(`
            <table id="${tableId}" class="table table-bordered table-hover" data-show-export="true"
              data-sortable="true" data-toolbar="#toolbar">
              <thead><tr></tr></thead>
              <tbody></tbody>
            </table>
        `);

        const headerRow = table.find('thead tr');
        const columns = ['example_idx', 'example'];

        headerRow.append(`<th data-sortable="true" data-field="example_idx">Example</th>`);
        headerRow.append(`<th data-sortable="true" data-field="example">Data</th>`);

        const labelKeys = buildLabelKeys(setup.slider_labels || []);
        (setup.slider_labels || []).forEach((label) => {
            const labelKey = labelKeys[label];
            sliderMetrics.forEach((metric) => {
                const field = `slider_${labelKey}_${metric.key}`;
                columns.push(field);
                headerRow.append(
                    `<th data-sortable="true" data-field="${field}">${escapeHtml(label)} ${metric.label}</th>`
                );
            });
        });

        const rows = (setup.rows || []).map((row) => {
            const rowData = {
                example_idx: row.example_idx,
                example: buildExampleCell(row),
            };

            (setup.slider_labels || []).forEach((label) => {
                const labelKey = labelKeys[label];
                const stats = (row.stats || {})[label] || {};
                sliderMetrics.forEach((metric) => {
                    const field = `slider_${labelKey}_${metric.key}`;
                    rowData[field] = stats[metric.key] ?? '';
                });
            });

            return rowData;
        });

        container.append(table);
        populateTable(tableId, rows, columns);
    });
}


$(document).ready(function () {
    // if we are on a detail page, populate the tables
    if ($('#full-table').length > 0) {
        const statistics = window.statistics;
        const ann_counts = statistics.ann_counts;

        populateTable('full-table', ann_counts.full, fullTableColumns);
        populateTable('span-table', ann_counts.span, spanTableColumns);
        populateTable('setup-table', ann_counts.setup, setupTableColumns);
        populateTable('dataset-table', ann_counts.dataset, datasetTableColumns);

        if (statistics.slider_stats) {
            populateTable('slider-overall-table', statistics.slider_stats.overall, sliderOverallColumns);
            renderSliderSetupTables(statistics.slider_stats);
        } else {
            $('#slider-stats-empty').show();
        }
    }
});


$(document).on('change', '.btn-check-campaign', updateComparisonData);
