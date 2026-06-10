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

function formatCoverageTimestamp(timestamp, options) {
    const numericTimestamp = Number(timestamp);
    if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
        return '';
    }

    const date = new Date(numericTimestamp * 1000);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const formatter = new Intl.DateTimeFormat(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        ...(options || {}),
    });
    return formatter.format(date);
}

function formatCoverageElapsed(startTimestamp, endTimestamp) {
    const start = Number(startTimestamp);
    if (!Number.isFinite(start) || start <= 0) {
        return '';
    }

    const end = Number(endTimestamp);
    const endMs = Number.isFinite(end) && end > 0 ? end * 1000 : Date.now();
    const diffSeconds = Math.max(0, Math.floor((endMs - (start * 1000)) / 1000));

    const hours = Math.floor(diffSeconds / 3600);
    const minutes = Math.floor((diffSeconds % 3600) / 60);
    const seconds = diffSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    }
    return `${seconds}s`;
}

function formatCoverageStateLabel(state) {
    if (state === 'done') {
        return 'Done';
    }
    if (state === 'skipped') {
        return 'Skipped';
    }
    if (state === 'assigned') {
        return 'Assigned';
    }
    return 'Todo';
}

function buildCoverageTooltip(cell) {
    const state = cell?.state || 'todo';
    const redoStatus = cell?.redo_status || '';
    const revisionCount = Number(cell?.revision_count || 0);
    const start = formatCoverageTimestamp(cell?.start, { second: '2-digit' });
    const end = formatCoverageTimestamp(cell?.end, { second: '2-digit' });
    const elapsed = formatCoverageElapsed(cell?.start, cell?.end);

    const rows = [
        `<div><strong>State:</strong> ${escapeHtml(formatCoverageStateLabel(state))}</div>`,
        `<div><strong>Started:</strong> ${escapeHtml(start || '-')}</div>`,
        `<div><strong>Ended:</strong> ${escapeHtml(end || '-')}</div>`,
        `<div><strong>Elapsed time:</strong> ${escapeHtml(elapsed || '-')}</div>`,
    ];
    if (redoStatus) {
        rows.push(`<div><strong>Redo:</strong> ${escapeHtml(redoStatus)}</div>`);
    }
    if (revisionCount > 0) {
        rows.push(`<div><strong>Revisions:</strong> ${escapeHtml(revisionCount)}</div>`);
        if (cell?.latest_revision_at) {
            rows.push(`<div><strong>Latest revision:</strong> ${escapeHtml(cell.latest_revision_at)}</div>`);
        }
        if (cell?.latest_revision_by) {
            rows.push(`<div><strong>Latest revised by:</strong> ${escapeHtml(cell.latest_revision_by)}</div>`);
        }
    }
    return rows.join('');
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

function collectSliderLabelOrder(sliderStats) {
    const labels = [];
    const seen = new Set();

    (sliderStats?.overall || []).forEach((row) => {
        const label = row?.label;
        if (label && !seen.has(label)) {
            seen.add(label);
            labels.push(label);
        }
    });

    (sliderStats?.by_setup || []).forEach((setup) => {
        (setup?.slider_labels || []).forEach((label) => {
            if (label && !seen.has(label)) {
                seen.add(label);
                labels.push(label);
            }
        });
    });

    return labels;
}

function deriveSetupAnnotationCount(setup) {
    const countsByLabel = {};

    (setup?.rows || []).forEach((row) => {
        Object.entries(row.stats || {}).forEach(([label, stats]) => {
            countsByLabel[label] = (countsByLabel[label] || 0) + (Number(stats?.count) || 0);
        });
    });

    const totals = Object.values(countsByLabel);
    return totals.length > 0 ? Math.max(...totals) : 0;
}

function renderSliderSetupSummaryTable(sliderStats) {
    const table = $('#slider-setup-summary-table');
    const headerRow = table.find('thead tr');
    headerRow.empty();

    if (!sliderStats || !sliderStats.by_setup || sliderStats.by_setup.length === 0) {
        table.hide();
        return;
    }

    table.show();

    const sliderLabels = collectSliderLabelOrder(sliderStats);
    const columns = ['slider_label', 'metric'];
    headerRow.append('<th data-sortable="true" data-field="slider_label">Slider</th>');
    headerRow.append('<th data-sortable="true" data-field="metric">Metric</th>');

    const setupSummaries = sliderStats.by_setup.map((setup, index) => {
        const aggregates = {};

        (setup.rows || []).forEach((row) => {
            Object.entries(row.stats || {}).forEach(([label, stats]) => {
                if (!aggregates[label]) {
                    aggregates[label] = {
                        count: 0,
                        weightedSum: 0,
                        min_value: null,
                        max_value: null,
                    };
                }

                const count = Number(stats.count) || 0;
                const avgValue = Number(stats.avg_value);
                const minValue = Number(stats.min_value);
                const maxValue = Number(stats.max_value);

                aggregates[label].count += count;
                if (Number.isFinite(avgValue)) {
                    aggregates[label].weightedSum += avgValue * count;
                }
                if (Number.isFinite(minValue)) {
                    aggregates[label].min_value = aggregates[label].min_value === null
                        ? minValue
                        : Math.min(aggregates[label].min_value, minValue);
                }
                if (Number.isFinite(maxValue)) {
                    aggregates[label].max_value = aggregates[label].max_value === null
                        ? maxValue
                        : Math.max(aggregates[label].max_value, maxValue);
                }
            });
        });

        const field = `setup_${index}`;
        const title = sliderStats.by_setup.length > 1
            ? escapeHtml(setup.setup_id)
            : escapeHtml(`${setup.dataset} / ${setup.split} / ${setup.setup_id}`);

        columns.push(field);
        headerRow.append(`<th data-sortable="true" data-field="${field}">${title}</th>`);

        return {
            field,
            annotation_count: Number(setup.annotation_count) > 0
                ? Number(setup.annotation_count)
                : deriveSetupAnnotationCount(setup),
            aggregates,
        };
    });

    const rows = [];

    const countRow = {
        slider_label: 'All sliders',
        metric: 'Non-skipped annotations',
    };
    setupSummaries.forEach((setup) => {
        countRow[setup.field] = setup.annotation_count;
    });
    rows.push(countRow);

    sliderLabels.forEach((label) => {
        ['avg_value', 'min_value', 'max_value'].forEach((metricKey) => {
            const metricMeta = sliderMetrics.find((metric) => metric.key === metricKey);
            const rowData = {
                slider_label: label,
                metric: metricMeta?.label || metricKey,
            };

            setupSummaries.forEach((setup) => {
                const stats = setup.aggregates[label];
                if (!stats) {
                    rowData[setup.field] = '';
                    return;
                }

                if (metricKey === 'avg_value') {
                    rowData[setup.field] = stats.count > 0 ? Number((stats.weightedSum / stats.count).toFixed(3)) : '';
                    return;
                }

                rowData[setup.field] = stats[metricKey] === null ? '' : Number(stats[metricKey].toFixed(3));
            });

            rows.push(rowData);
        });
    });

    populateTable('slider-setup-summary-table', rows, columns);

    let mergeIndex = 1;
    sliderLabels.forEach(() => {
        $('#slider-setup-summary-table').bootstrapTable('mergeCells', {
            index: mergeIndex,
            field: 'slider_label',
            rowspan: 3,
            colspan: 1,
        });
        mergeIndex += 3;
    });
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

function normalizeCoverageAnnotatorKey(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
        return '';
    }
    return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function buildCoverageCellBrowseUrl(row, annotatorId, status) {
    const browseUrl = buildBrowseUrl(row);
    if (!['done', 'skipped'].includes(status)) {
        return browseUrl;
    }

    const campaignId = String(metadata?.id || '').trim();
    const annotatorKey = normalizeCoverageAnnotatorKey(annotatorId);
    if (!campaignId || !annotatorKey) {
        return browseUrl;
    }

    const params = new URLSearchParams({
        dataset: row.dataset,
        split: row.split,
        example_idx: row.example_idx,
        setup_id: row.setup_id,
        ann_campaign: `${campaignId}-ann-${annotatorKey}`,
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
    if (status === 'assigned') {
        return '<span class="badge bg-assigned">assigned</span>';
    }
    return '<span class="badge bg-secondary">todo</span>';
}

const coverageTransposeStorageKey = `factgenie_coverage_transpose_${metadata?.id || 'default'}`;
const coverageSetupFilterStorageKey = `factgenie_coverage_setup_filter_${metadata?.id || 'default'}`;
let coverageTransposeMemoryPreference = false;
let coverageSetupMemoryPreference = null;

function getCoverageTransposePreference() {
    try {
        const stored = localStorage.getItem(coverageTransposeStorageKey);
        if (stored !== null) {
            return stored === 'true';
        }
    } catch (error) {
        return coverageTransposeMemoryPreference;
    }
    return coverageTransposeMemoryPreference;
}

function setCoverageTransposePreference(value) {
    coverageTransposeMemoryPreference = value;
    try {
        localStorage.setItem(coverageTransposeStorageKey, value ? 'true' : 'false');
    } catch (error) {
        // Ignore storage failures; the checkbox still works for the current page.
    }
}

function bindCoverageTransposeControl(coverageStats) {
    const checkbox = $('#coverage-transpose-checkbox');
    if (checkbox.length === 0) {
        return false;
    }

    const transposed = getCoverageTransposePreference();
    checkbox.prop('checked', transposed);
    checkbox.off('change.coverageTranspose').on('change.coverageTranspose', function () {
        setCoverageTransposePreference($(this).is(':checked'));
        renderCoverageMatrix(coverageStats);
    });
    return transposed;
}

function getCoverageSetupIds(rows) {
    return Array.from(new Set((rows || [])
        .map((row) => String(row.setup_id || '').trim())
        .filter((setupId) => setupId !== ''))).sort((a, b) => a.localeCompare(b));
}

function getCoverageSetupFilterPreference(setupIds) {
    const availableSetups = new Set(setupIds);
    let storedSetups = null;

    try {
        const stored = localStorage.getItem(coverageSetupFilterStorageKey);
        if (stored) {
            storedSetups = JSON.parse(stored);
        }
    } catch (error) {
        storedSetups = coverageSetupMemoryPreference;
    }

    if (!Array.isArray(storedSetups)) {
        storedSetups = coverageSetupMemoryPreference;
    }

    const selected = (storedSetups || [])
        .map((setupId) => String(setupId || '').trim())
        .filter((setupId) => availableSetups.has(setupId));

    return selected.length > 0 ? selected : setupIds;
}

function setCoverageSetupFilterPreference(setupIds) {
    coverageSetupMemoryPreference = setupIds;
    try {
        localStorage.setItem(coverageSetupFilterStorageKey, JSON.stringify(setupIds));
    } catch (error) {
        // Ignore storage failures; the checkboxes still work for the current page.
    }
}

function bindCoverageSetupFilter(coverageStats, rows) {
    const container = $('#coverage-setup-filter');
    const setupIds = getCoverageSetupIds(rows);
    if (container.length === 0 || setupIds.length <= 1) {
        container.empty();
        return setupIds;
    }

    const selectedSetups = getCoverageSetupFilterPreference(setupIds);
    const selectedSet = new Set(selectedSetups);
    const selectedCount = selectedSetups.length;
    let html = '<span class="small text-muted me-1">Setups:</span>';

    setupIds.forEach((setupId, index) => {
        const checked = selectedSet.has(setupId);
        const safeId = normalizeCoverageAnnotatorKey(setupId) || 'setup';
        const inputId = `coverage-setup-filter-${safeId}-${index}`;
        const disabled = checked && selectedCount === 1;
        html += `
            <div class="form-check form-check-inline mb-0">
              <input class="form-check-input coverage-setup-filter-checkbox" type="checkbox"
                id="${inputId}" value="${escapeHtml(setupId)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>
              <label class="form-check-label small" for="${inputId}">${escapeHtml(setupId)}</label>
            </div>
        `;
    });

    container.html(html);
    container.find('.coverage-setup-filter-checkbox').off('change.coverageSetupFilter').on('change.coverageSetupFilter', function () {
        const nextSelected = container.find('.coverage-setup-filter-checkbox:checked').map(function () {
            return $(this).val();
        }).get();
        if (nextSelected.length === 0) {
            $(this).prop('checked', true);
            return;
        }
        setCoverageSetupFilterPreference(nextSelected);
        renderCoverageMatrix(coverageStats);
    });

    return selectedSetups;
}

function coverageCountsBadgeGroup(counts) {
    return `
        <div class="d-flex justify-content-center align-items-center gap-1 flex-wrap">
          <span class="badge bg-success">${counts.done}</span>
          <span class="badge bg-warning text-dark">${counts.skipped}</span>
          <span class="badge bg-secondary">${counts.todo}</span>
        </div>
    `;
}

function getCoverageLabelContext(rows) {
    const datasets = new Set(rows.map((row) => String(row.dataset || '').trim()));
    const splits = new Set(rows.map((row) => String(row.split || '').trim()));
    return {
        showDataset: datasets.size > 1,
        showSplit: datasets.size > 1 || splits.size > 1,
    };
}

function getCoverageOutputLabels(row, labelContext) {
    const labelParts = [];
    if (labelContext?.showDataset) {
        labelParts.push(row.dataset || '-');
    }
    if (labelContext?.showSplit) {
        labelParts.push(row.split || '-');
    }
    labelParts.push(row.setup_id || '-');

    return {
        outputLabel: `${escapeHtml(labelParts.join('/'))} #${row.example_idx}`,
        questionPreview: escapeHtml(row.question_preview || ''),
    };
}

function coverageAnnotatorHeaderHtml(ann) {
    const alias = ann.annotator_alias ? escapeHtml(ann.annotator_alias) : '-';
    return `
        <div class="coverage-annotator-label">
          <div>${escapeHtml(ann.annotator_name || '-')}</div>
          <div class="text-muted small">${alias}</div>
        </div>
    `;
}

function coverageStatusCellHtml(row, groupKey, status) {
    const cell = row.cell_details?.[groupKey] || { state: status };
    const tooltip = buildCoverageTooltip(cell);
    const cellBrowseUrl = buildCoverageCellBrowseUrl(row, groupKey, status);
    const redoBadge = cell.redo_status ? `<div><span class="badge bg-info text-dark">redo ${escapeHtml(cell.redo_status)}</span></div>` : '';
    return `
        <td class="text-center">
          <a href="${cellBrowseUrl}" target="_blank" data-bs-toggle="tooltip" data-bs-html="true" title="${tooltip}">
            ${statusBadge(status)}
            ${redoBadge}
          </a>
        </td>
    `;
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

function exportCoverageXlsx(fileName) {
    const exportTable = buildCoveragePlainExportTable();
    if (!exportTable) {
        return;
    }
    if (typeof window.XLSX === 'undefined' || !window.XLSX.utils || !window.XLSX.writeFile) {
        return;
    }

    const wrapper = $('<div style="display:none;"></div>');
    wrapper.append(exportTable);
    $('body').append(wrapper);

    try {
        const worksheet = window.XLSX.utils.table_to_sheet(exportTable.get(0), { raw: false });
        const workbook = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(workbook, worksheet, 'Coverage');
        window.XLSX.writeFile(workbook, `${fileName}.xlsx`);
    } finally {
        wrapper.remove();
    }
}

let coverageStickyFrame = null;

function scheduleCoverageStickySync() {
    if (coverageStickyFrame !== null) {
        return;
    }

    coverageStickyFrame = window.requestAnimationFrame(() => {
        coverageStickyFrame = null;
        syncCoverageStickyHeader();
    });
}

function destroyCoverageStickyHeader() {
    $(window).off('.coverageSticky');
    $(document).off('.coverageSticky');
    $('.coverage-matrix-wrapper').off('.coverageSticky');

    if (coverageStickyFrame !== null) {
        window.cancelAnimationFrame(coverageStickyFrame);
        coverageStickyFrame = null;
    }

    $('#coverage-matrix-sticky-header').remove();
}

function buildCoverageStickyHeader() {
    const table = document.getElementById('coverage-matrix-table');
    if (!table) {
        return null;
    }

    const thead = table.querySelector('thead');
    if (!thead) {
        return null;
    }

    let stickyHost = document.getElementById('coverage-matrix-sticky-header');
    if (!stickyHost) {
        stickyHost = document.createElement('div');
        stickyHost.id = 'coverage-matrix-sticky-header';
        stickyHost.className = 'coverage-matrix-sticky-header';
        document.body.appendChild(stickyHost);
    }

    const stickyTable = document.createElement('table');
    stickyTable.className = table.className;
    stickyTable.appendChild(thead.cloneNode(true));

    stickyHost.replaceChildren(stickyTable);
    return stickyHost;
}

function syncCoverageStickyHeader() {
    const wrapper = document.querySelector('#coverage-matrix-container .coverage-matrix-wrapper');
    const table = document.getElementById('coverage-matrix-table');
    const thead = table?.querySelector('thead');
    const stickyHost = document.getElementById('coverage-matrix-sticky-header');
    const stickyTable = stickyHost?.querySelector('table');

    if (!wrapper || !table || !thead || !stickyHost || !stickyTable) {
        return;
    }

    if (wrapper.offsetParent === null || table.offsetWidth === 0 || wrapper.clientWidth === 0) {
        stickyHost.classList.remove('is-visible');
        return;
    }

    const sourceCells = table.querySelectorAll('thead th');
    const stickyCells = stickyTable.querySelectorAll('thead th');

    if (sourceCells.length !== stickyCells.length) {
        buildCoverageStickyHeader();
        scheduleCoverageStickySync();
        return;
    }

    sourceCells.forEach((cell, index) => {
        const width = Math.ceil(cell.getBoundingClientRect().width);
        stickyCells[index].style.width = `${width}px`;
        stickyCells[index].style.minWidth = `${width}px`;
        stickyCells[index].style.maxWidth = `${width}px`;
    });

    const wrapperRect = wrapper.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const headerRect = thead.getBoundingClientRect();
    const headerHeight = Math.ceil(headerRect.height || 0);

    stickyHost.style.left = `${Math.round(wrapperRect.left)}px`;
    stickyHost.style.width = `${Math.round(wrapperRect.width)}px`;
    stickyTable.style.width = `${Math.ceil(tableRect.width)}px`;
    stickyTable.style.transform = `translateX(${-wrapper.scrollLeft}px)`;

    const shouldShow = headerRect.top <= 0 && tableRect.bottom - headerHeight > 0;
    stickyHost.classList.toggle('is-visible', shouldShow);
}

function setupCoverageStickyHeader() {
    if (!buildCoverageStickyHeader()) {
        return;
    }

    scheduleCoverageStickySync();

    $(window)
        .off('scroll.coverageSticky resize.coverageSticky')
        .on('scroll.coverageSticky resize.coverageSticky', scheduleCoverageStickySync);

    $(document)
        .off('shown.bs.tab.coverageSticky')
        .on('shown.bs.tab.coverageSticky', '[data-bs-toggle="pill"], [data-bs-toggle="tab"]', scheduleCoverageStickySync);

    $('.coverage-matrix-wrapper')
        .off('scroll.coverageSticky')
        .on('scroll.coverageSticky', scheduleCoverageStickySync);
}

function computeCoverageHeaderCounts(rows, annotators) {
    const countsByGroup = {};

    annotators.forEach((ann) => {
        countsByGroup[ann.annotator_group_key] = {
            done: 0,
            skipped: 0,
            todo: 0,
        };
    });

    rows.forEach((row) => {
        annotators.forEach((ann) => {
            const groupKey = ann.annotator_group_key;
            const status = row.statuses?.[groupKey] || 'todo';
            if (status === 'done') {
                countsByGroup[groupKey].done += 1;
            } else if (status === 'skipped') {
                countsByGroup[groupKey].skipped += 1;
            } else {
                countsByGroup[groupKey].todo += 1;
            }
        });
    });

    return countsByGroup;
}

function computeCoverageRowCounts(row, annotators) {
    const counts = {
        done: 0,
        skipped: 0,
        todo: 0,
    };

    annotators.forEach((ann) => {
        const status = row.statuses?.[ann.annotator_group_key] || 'todo';
        if (status === 'done') {
            counts.done += 1;
        } else if (status === 'skipped') {
            counts.skipped += 1;
        } else {
            counts.todo += 1;
        }
    });

    return counts;
}

function renderCoverageMatrixDefault(rows, annotators, annotatorCounts, labelContext) {
    let html = `
      <div class="coverage-matrix-wrapper">
        <table id="coverage-matrix-table" class="table table-bordered table-sm align-middle">
          <thead>
            <tr>
              <th rowspan="3" style="min-width: 88px;">Totals</th>
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
        const counts = annotatorCounts[ann.annotator_group_key] || { done: 0, skipped: 0, todo: 0 };
        html += `
            <th class="text-center">
              ${coverageCountsBadgeGroup(counts)}
            </th>
        `;
    });

    html += `
            </tr>
          </thead>
          <tbody>
    `;

    rows.forEach((row) => {
        const rowCounts = computeCoverageRowCounts(row, annotators);
        const rowClass = Number(row.group_parity || 0) % 2 === 0 ? 'table-light' : '';
        const labels = getCoverageOutputLabels(row, labelContext);
        const browseUrl = buildBrowseUrl(row);

        html += `<tr class="${rowClass}">`;
        html += `<td class="text-center">${coverageCountsBadgeGroup(rowCounts)}</td>`;
        html += `<td><a href="${browseUrl}" target="_blank">${labels.outputLabel}</a></td>`;

        annotators.forEach((ann) => {
            const groupKey = ann.annotator_group_key;
            const status = row.statuses?.[groupKey] || 'todo';
            html += coverageStatusCellHtml(row, groupKey, status);
        });

        html += `<td>${labels.questionPreview}</td>`;
        html += '</tr>';
    });

    html += `
          </tbody>
        </table>
      </div>
    `;

    return html;
}

function renderCoverageMatrixTransposed(rows, annotators, annotatorCounts, labelContext) {
    let html = `
      <div class="coverage-matrix-wrapper">
        <table id="coverage-matrix-table" class="table table-bordered table-sm align-middle">
          <thead>
            <tr>
              <th rowspan="2" style="min-width: 170px;">Annotator</th>
              <th rowspan="2" style="min-width: 88px;">Totals</th>
    `;

    rows.forEach((row) => {
        const labels = getCoverageOutputLabels(row, labelContext);
        html += `
            <th class="text-center" style="min-width: 128px;">
              <a href="${buildBrowseUrl(row)}" target="_blank" data-bs-toggle="tooltip" title="${labels.questionPreview}">
                ${labels.outputLabel}
              </a>
            </th>
        `;
    });

    html += `
            </tr>
            <tr>
    `;

    rows.forEach((row) => {
        const rowCounts = computeCoverageRowCounts(row, annotators);
        html += `<th class="text-center">${coverageCountsBadgeGroup(rowCounts)}</th>`;
    });

    html += `
            </tr>
          </thead>
          <tbody>
    `;

    annotators.forEach((ann, index) => {
        const groupKey = ann.annotator_group_key;
        const rowClass = index % 2 === 0 ? 'table-light' : '';
        const counts = annotatorCounts[groupKey] || { done: 0, skipped: 0, todo: 0 };

        html += `<tr class="${rowClass}">`;
        html += `<td>${coverageAnnotatorHeaderHtml(ann)}</td>`;
        html += `<td class="text-center">${coverageCountsBadgeGroup(counts)}</td>`;

        rows.forEach((row) => {
            const status = row.statuses?.[groupKey] || 'todo';
            html += coverageStatusCellHtml(row, groupKey, status);
        });

        html += '</tr>';
    });

    html += `
          </tbody>
        </table>
      </div>
    `;

    return html;
}

function renderCoverageMatrix(coverageStats) {
    const matrix = coverageStats?.matrix;
    const annotators = matrix?.annotators || [];
    const rows = matrix?.rows || [];

    if (!matrix || annotators.length === 0 || rows.length === 0) {
        destroyCoverageStickyHeader();
        $('#coverage-stats-empty').show();
        $('#coverage-stats-content').hide();
        return;
    }

    $('#coverage-stats-empty').hide();
    $('#coverage-stats-content').show();

    const transposed = bindCoverageTransposeControl(coverageStats);
    const selectedSetupIds = bindCoverageSetupFilter(coverageStats, rows);
    const selectedSetupSet = new Set(selectedSetupIds);
    const visibleRows = rows.filter((row) => selectedSetupSet.has(String(row.setup_id || '').trim()));
    const annotatorCounts = computeCoverageHeaderCounts(visibleRows, annotators);
    const labelContext = getCoverageLabelContext(visibleRows);
    const html = transposed
        ? renderCoverageMatrixTransposed(visibleRows, annotators, annotatorCounts, labelContext)
        : renderCoverageMatrixDefault(visibleRows, annotators, annotatorCounts, labelContext);

    $('#coverage-matrix-container').html(html);
    setupCoverageStickyHeader();
    enableTooltips();

    $('#coverage-export-csv-btn').off('click').on('click', function () {
        exportCoverageTable({
            type: 'csv',
            fileName: `coverage-matrix-${metadata.id}`,
            escape: false,
        });
    });

    $('#coverage-export-xls-btn').off('click').on('click', function () {
        const fileName = `coverage-matrix-${metadata.id}`;

        if (typeof window.XLSX !== 'undefined' && window.XLSX.utils && window.XLSX.writeFile) {
            exportCoverageXlsx(fileName);
            return;
        }

        // Fallback to Excel 2003 XML when XLSX library is unavailable.
        exportCoverageTable({
            fileName,
            escape: false,
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
            renderSliderSetupSummaryTable(statistics.slider_stats);
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
