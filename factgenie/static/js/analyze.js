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
const annotatorBaseColumns = [
    { key: 'annotator_id', label: 'Annotator' },
    { key: 'example_count', label: 'Questions' },
    { key: 'avg_spans', label: 'Avg spans' },
    { key: 'text_questions_count', label: 'Questions w/ text' },
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

function renderAnnotatorTable(annotatorStats) {
    const table = $('#annotator-table');
    const headerRow = table.find('thead tr');
    headerRow.empty();

    if (!annotatorStats || !annotatorStats.rows || annotatorStats.rows.length === 0) {
        $('#annotator-stats-empty').show();
        return;
    }

    $('#annotator-stats-empty').hide();

    const columns = [];
    annotatorBaseColumns.forEach((col) => {
        columns.push(col.key);
        headerRow.append(`<th data-sortable="true" data-field="${col.key}">${col.label}</th>`);
    });

    const labelKeys = buildLabelKeys(annotatorStats.slider_labels || []);
    (annotatorStats.slider_labels || []).forEach((label) => {
        const field = `slider_${labelKeys[label]}_avg`;
        columns.push(field);
        headerRow.append(`<th data-sortable="true" data-field="${field}">${escapeHtml(label)} Avg</th>`);
    });

    const rows = annotatorStats.rows.map((row) => {
        const data = {
            annotator_id: row.annotator_id,
            example_count: row.example_count,
            avg_spans: row.avg_spans,
            text_questions_count: row.text_questions_count,
        };

        (annotatorStats.slider_labels || []).forEach((label) => {
            const field = `slider_${labelKeys[label]}_avg`;
            data[field] = row.slider_avgs?.[label] ?? '';
        });

        return data;
    });

    populateTable('annotator-table', rows, columns);
}

function buildBrowseUrl(row) {
    const params = new URLSearchParams({
        dataset: row.dataset,
        split: row.split,
        example_idx: row.example_idx,
        setup_id: row.setup_id,
    });
    return `${url_prefix}/browse?${params.toString()}`;
}

function statusBadge(status) {
    if (status === 'done') {
        return '<span class="badge bg-success">done</span>';
    }
    if (status === 'skipped') {
        return '<span class="badge bg-warning text-dark">skipped</span>';
    }
    return '<span class="badge bg-secondary">todo</span>';
}


function buildCoveragePlainExportTable() {
    const sourceTable = $('#coverage-matrix-table');
    if (sourceTable.length === 0) {
        return null;
    }

    const clone = sourceTable.clone();

    // Export plain text only: replace links with their visible text.
    clone.find('a').each(function () {
        const textValue = $(this).text();
        $(this).replaceWith(document.createTextNode(textValue));
    });

    return clone;
}

function exportCoverageTable(options) {
    const exportTable = buildCoveragePlainExportTable();
    if (!exportTable) {
        return;
    }

    const wrapper = $('<div style="display:none;"></div>');
    wrapper.append(exportTable);
    $('body').append(wrapper);

    try {
        exportTable.tableExport(options);
    } finally {
        wrapper.remove();
    }
}

function renderCoverageMatrix(coverageStats) {
    const matrix = coverageStats?.matrix;
    const annotators = matrix?.annotators || [];
    const rows = matrix?.rows || [];

    if (!matrix || annotators.length === 0 || rows.length === 0) {
        $('#coverage-stats-empty').show();
        $('#coverage-stats-content').hide();
        return;
    }

    $('#coverage-stats-empty').hide();
    $('#coverage-stats-content').show();

    const outputPaths = rows.map((row) => `${row.dataset}/${row.split}/${row.setup_id}`);
    const commonPrefix = (() => {
        if (outputPaths.length === 0) {
            return '';
        }
        let commonParts = outputPaths[0].split('/');
        for (let i = 1; i < outputPaths.length; i += 1) {
            const parts = outputPaths[i].split('/');
            let matchLen = 0;
            while (matchLen < commonParts.length && matchLen < parts.length && commonParts[matchLen] === parts[matchLen]) {
                matchLen += 1;
            }
            commonParts = commonParts.slice(0, matchLen);
            if (commonParts.length === 0) {
                break;
            }
        }
        return commonParts.length > 0 ? `${commonParts.join('/')}/` : '';
    })();

    let html = `
      <div class="table-responsive">
        <table id="coverage-matrix-table" class="table table-bordered table-sm align-middle">
          <thead>
            <tr>
              <th rowspan="3" style="min-width: 75px;">Done</th>
              <th rowspan="3" style="min-width: 160px;">Output</th>
    `;

    annotators.forEach((ann) => {
        html += `<th class="text-center" style="min-width: 120px;">${escapeHtml(ann.annotator_name || '-')}</th>`;
    });

    html += `
              <th rowspan="3" style="min-width: 240px;">Question</th>
            </tr>
            <tr>
    `;

    annotators.forEach((ann) => {
        const alias = ann.annotator_alias ? escapeHtml(ann.annotator_alias) : '-';
        html += `<th class="text-center text-muted">${alias}</th>`;
    });

    html += `
            </tr>
            <tr>
    `;

    annotators.forEach((ann) => {
        html += `<th class="text-center">${ann.done_count ?? 0}</th>`;
    });

    html += `
            </tr>
          </thead>
          <tbody>
    `;

    rows.forEach((row) => {
        const rowDone = Number(row.row_done_count || 0);
        const rowClass = Number(row.group_parity || 0) % 2 === 0 ? 'table-light' : '';
        const questionPreview = escapeHtml(row.question_preview || '');
        const fullOutputPath = `${row.dataset}/${row.split}/${row.setup_id}`;
        const outputPath = commonPrefix && fullOutputPath.startsWith(commonPrefix)
            ? fullOutputPath.slice(commonPrefix.length)
            : fullOutputPath;
        const outputLabel = `${escapeHtml(outputPath)} #${row.example_idx}`;
        const browseUrl = buildBrowseUrl(row);
        const doneCell = rowDone > 0
            ? `<span class="badge bg-success">${rowDone}</span>`
            : `<span class="badge bg-danger">${rowDone}</span>`;

        html += `<tr class="${rowClass}">`;
        html += `<td class="text-center">${doneCell}</td>`;
        html += `<td><a href="${browseUrl}" target="_blank">${outputLabel}</a></td>`;

        annotators.forEach((ann) => {
            const groupKey = ann.annotator_group_key;
            const status = row.statuses?.[groupKey] || 'todo';
            html += `<td class="text-center"><a href="${browseUrl}" target="_blank">${statusBadge(status)}</a></td>`;
        });

        html += `<td>${questionPreview}</td>`;
        html += '</tr>';
    });

    html += `
          </tbody>
        </table>
      </div>
    `;

    $('#coverage-matrix-container').html(html);

    $('#coverage-export-csv-btn').off('click').on('click', function () {
        exportCoverageTable({
            type: 'csv',
            fileName: `coverage-matrix-${metadata.id}`,
            escape: false,
        });
    });

    $('#coverage-export-xls-btn').off('click').on('click', function () {
        const commonOptions = {
            fileName: `coverage-matrix-${metadata.id}`,
            escape: false,
        };

        if (typeof window.XLSX !== 'undefined') {
            exportCoverageTable({
                ...commonOptions,
                type: 'xlsx',
            });
            return;
        }

        // Fallback to Excel 2003 XML to avoid extension/content mismatch warnings.
        exportCoverageTable({
            ...commonOptions,
            type: 'excel',
            mso: {
                fileFormat: 'xmlss',
            },
        });
    });
}


$(document).ready(function () {
    // if we are on a detail page, populate the tables
    if ($('#full-table').length > 0) {
        const statistics = window.statistics;
        const ann_counts = statistics.ann_counts || {
            full: [],
            span: [],
            setup: [],
            dataset: [],
        };

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
        if (statistics.annotator_stats) {
            renderAnnotatorTable(statistics.annotator_stats);
        } else {
            $('#annotator-stats-empty').show();
        }
        if (statistics.coverage_stats) {
            renderCoverageMatrix(statistics.coverage_stats);
        } else {
            $('#coverage-stats-empty').show();
            $('#coverage-stats-content').hide();
        }
    }
});


$(document).on('change', '.btn-check-campaign', updateComparisonData);
