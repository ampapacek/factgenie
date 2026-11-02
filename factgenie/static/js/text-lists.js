/* Human text-list controls. Blank rows are presentation state, never items. */
const textListsUI = (() => {
    const root = document.getElementById('text-lists');
    const config = JSON.parse(root?.dataset.config || '[]');
    let lists = [];
    let usedIds = new Set();
    const element = (tag, text, className = '') => {
        const node = document.createElement(tag);
        node.textContent = text;
        node.className = className;
        return node;
    };
    const changed = () => {
        if (typeof saveCurrentAnnotations === 'function' && window.annotation_set?.[current_example_idx]) {
            saveCurrentAnnotations(current_example_idx);
            saveAnnotationsToLocalStorage();
        }
    };
    // Single-line by default; grows with wrapped or multi-line text.
    const grow = textarea => {
        textarea.style.height = 'auto';
        if (textarea.scrollHeight) textarea.style.height = textarea.scrollHeight + 2 + 'px';
    };
    // Re-measure when the width changes (panel resize, page reveal); height changes are our own.
    const widths = new WeakMap();
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
        entries.forEach(({target, contentRect}) => {
            if (widths.get(target) === contentRect.width) return;
            widths.set(target, contentRect.width);
            grow(target);
        });
    }) : null;
    // crypto.randomUUID needs a secure context (HTTPS or localhost); plain-HTTP servers fall back to getRandomValues.
    const randomId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    const makeId = () => {
        let id;
        do { id = randomId(); } while (usedIds.has(id));
        usedIds.add(id);
        return id;
    };
    function refresh(list) {
        const count = list.rows.filter(row => row.item).length;
        if (list.confirmation) {
            list.confirmation.disabled = count > 0;
            if (count) list.confirmation.checked = false;
        }
        const belowLimit = list.definition.max_items === null || count < list.definition.max_items;
        list.copyButton.disabled = !count;
        const last = list.rows.at(-1);
        if (belowLimit && (!last || last.item)) addRow(list);
        if (!belowLimit) {
            list.rows.filter(row => !row.item && row.textarea !== document.activeElement).forEach(row => removeRow(list, row));
        }
    }
    function removeRow(list, row) {
        resizeObserver?.unobserve(row.textarea);
        row.node.remove();
        list.rows = list.rows.filter(candidate => candidate !== row);
    }
    function renderChoices(list, row) {
        row.choices.replaceChildren();
        row.deleteButton.hidden = !row.item;
        if (!row.item) return;
        list.definition.choice_groups.forEach((group, groupIndex) => {
            const fieldset = element('fieldset', '', 'd-flex flex-wrap align-items-center column-gap-2 m-0');
            const legend = element('legend', group.label + (group.required ? ' *' : '') + ':');
            fieldset.append(legend);
            const choice = row.item.choices.find(value => value.label === group.label);
            if (group.display === 'toggle') {
                fieldset.append(renderToggle(list, row, group, groupIndex, choice));
                row.choices.append(fieldset);
                return;
            }
            group.options.forEach(option => {
                const label = element('label', '', 'text-nowrap');
                const input = document.createElement('input');
                input.type = group.multiple ? 'checkbox' : 'radio';
                input.name = `text-list-${row.item.id}-${groupIndex}`;
                input.value = option.label;
                input.checked = choice.values.includes(option.label);
                input.className = 'me-1';
                input.addEventListener('change', () => {
                    choice.values = [...fieldset.querySelectorAll('input:checked')].map(node => node.value);
                    list.error.textContent = '';
                    changed();
                });
                label.append(input, document.createTextNode(option.label));
                fieldset.append(label);
            });
            row.choices.append(fieldset);
        });
    }
    // Three-position switch: first option | neutral (no value) | second option.
    function renderToggle(list, row, group, groupIndex, choice) {
        const toggle = element('div', '', 'btn-group btn-group-sm text-list-toggle');
        toggle.setAttribute('role', 'group');
        [group.options[0], null, group.options[1]].forEach((option, position) => {
            const input = document.createElement('input');
            input.type = 'radio';
            input.className = 'btn-check';
            input.name = `text-list-${row.item.id}-${groupIndex}`;
            input.id = `${input.name}-${position}`;
            input.value = option?.label ?? '';
            input.checked = option ? choice.values.includes(option.label) : !choice.values.length;
            input.addEventListener('change', () => {
                choice.values = option ? [option.label] : [];
                list.error.textContent = '';
                changed();
            });
            const label = element('label', option?.label ?? '?',
                option ? 'btn btn-outline-primary' : 'btn btn-outline-secondary text-list-toggle-neutral');
            label.htmlFor = input.id;
            if (!option) label.title = 'Nevyplněno';
            toggle.append(input, label);
        });
        return toggle;
    }
    function addRow(list, savedItem = null) {
        const node = element('div', '', 'text-list-item border rounded px-2 py-1 mb-1');
        const line = element('div', '', 'text-list-line d-flex align-items-start gap-2');
        const textarea = element('textarea', '', 'form-control form-control-sm');
        textarea.rows = 1;
        textarea.placeholder = list.definition.placeholder;
        textarea.setAttribute('aria-label', list.definition.label + ' — item text');
        textarea.value = savedItem?.text || '';
        const row = {node, textarea, item: savedItem ? structuredClone(savedItem) : null,
            choices: element('div', '', 'text-list-choices d-flex flex-wrap column-gap-4 row-gap-1 small'),
            deleteButton: element('button', 'Delete', 'btn btn-sm btn-outline-danger')};
        if (row.item) {
            if (row.item.id === undefined || row.item.id === null) row.item.id = makeId();
            row.item.choices = list.definition.choice_groups.map(group => ({label: group.label,
                values: [...(savedItem.choices?.find(choice => choice.label === group.label)?.values || [])]}));
        }
        row.deleteButton.type = 'button';
        row.deleteButton.addEventListener('click', () => {
            removeRow(list, row);
            refresh(list);
            changed();
        });
        textarea.addEventListener('input', () => {
            list.error.textContent = '';
            const text = textarea.value.trim();
            if (text && !row.item) {
                const count = list.rows.filter(candidate => candidate.item).length;
                if (list.definition.max_items !== null && count >= list.definition.max_items) {
                    textarea.value = '';
                    list.error.textContent = 'Maximum number of items reached.';
                    return;
                }
                row.item = {id: makeId(), text, choices: list.definition.choice_groups.map(group =>
                    ({label: group.label, values: [...group.default_values]}))};
                renderChoices(list, row);
            } else if (!text && row.item) {
                row.item = null;
                renderChoices(list, row);
            }
            if (row.item) row.item.text = text;
            refresh(list);
            grow(textarea); // after Delete visibility changes the available width
            changed();
        });
        textarea.addEventListener('keydown', event => {
            // Enter moves to the next row; Shift+Enter keeps a line break inside the item.
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
            event.preventDefault();
            const next = list.rows[list.rows.indexOf(row) + 1];
            if (next) next.textarea.focus();
        });
        textarea.addEventListener('blur', () => {
            // Delay until the next focus target is known, so clicking choices/delete remains safe.
            setTimeout(() => {
                const blanks = list.rows.filter(candidate => !candidate.item);
                blanks.forEach(candidate => {
                    if (candidate !== list.rows.at(-1)) removeRow(list, candidate);
                });
                refresh(list);
            }, 0);
        });
        line.append(textarea, row.deleteButton);
        node.append(line, row.choices);
        list.rows.push(row);
        list.container.append(node);
        renderChoices(list, row);
        grow(textarea);
        resizeObserver?.observe(textarea);
    }
    // Clipboard survives batch submission and reloads; kept per campaign and list label.
    const clipboardKey = `factgenie_text_list_clipboard_${window.metadata?.id || ''}`;
    const readClipboard = () => {
        try { return JSON.parse(localStorage.getItem(clipboardKey)) || {}; } catch { return {}; }
    };
    const filledItems = records => (records || []).filter(item => item.text?.trim());
    const option = (text, value) => Object.assign(element('option', text), {value});
    const itemCount = count => `${count} ${count === 1 ? 'item' : 'items'}`;
    // Other answers of this batch with items in the list, as [annotation index, items].
    function batchSources(list) {
        const set = window.annotation_set || [];
        const current = typeof current_example_idx === 'number' ? current_example_idx : -1;
        return set.map((annotation, index) => [index,
            filledItems((annotation?.text_lists || annotation?.textLists || [])
                .find(record => record.label === list.definition.label)?.items)])
            .filter(([index, items]) => index !== current && items.length);
    }
    function showStatus(list, message, undo = null) {
        clearTimeout(list.statusTimer);
        list.status.replaceChildren(document.createTextNode(message));
        if (undo) {
            const button = element('button', 'Undo', 'btn btn-link btn-sm p-0 ms-2 align-baseline');
            button.type = 'button';
            button.addEventListener('click', () => { undo(); list.status.replaceChildren(); });
            list.status.append(button);
        }
        list.statusTimer = setTimeout(() => list.status.replaceChildren(), 10000);
    }
    function buildPasteMenu(list) {
        const select = list.pasteMenu;
        select.replaceChildren(option('Paste from…', ''));
        const sources = batchSources(list);
        if (sources.length) {
            const group = document.createElement('optgroup');
            group.label = 'This batch';
            sources.forEach(([index, items]) =>
                group.append(option(`Answer ${index + 1} · ${itemCount(items.length)}`, `batch:${index}`)));
            select.append(group);
        }
        const stored = readClipboard()[list.definition.label];
        if (stored?.items?.length) {
            const group = document.createElement('optgroup');
            group.label = 'Clipboard';
            group.append(option(`${stored.source} · ${itemCount(stored.items.length)}`, 'clipboard'));
            select.append(group);
        }
        select.hidden = !sources.length && !stored?.items?.length;
    }
    function copyToClipboard(list) {
        const items = list.rows.filter(row => row.item).map(row =>
            ({text: row.item.text, choices: structuredClone(row.item.choices)}));
        const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
        const clipboard = readClipboard();
        clipboard[list.definition.label] = {source: `Answer ${current_example_idx + 1} (${time})`, items};
        try {
            localStorage.setItem(clipboardKey, JSON.stringify(clipboard));
        } catch {
            return showStatus(list, 'Could not save to clipboard (browser storage unavailable).');
        }
        lists.forEach(buildPasteMenu);
        showStatus(list, `Copied ${itemCount(items.length)} to clipboard.`);
    }
    // Append pasted items with their choices; an item with the same text takes the pasted choices.
    function pasteItems(list, items, sourceName) {
        const before = list.rows.filter(row => row.item).map(row => structuredClone(row.item));
        const wasConfirmed = list.confirmation?.checked === true;
        const byText = new Map(list.rows.filter(row => row.item).map(row => [row.item.text.trim(), row]));
        const maximum = list.definition.max_items;
        let added = 0, updated = 0, unchanged = 0, overLimit = 0;
        const highlight = node => {
            node.classList.add('text-list-copied');
            setTimeout(() => node.classList.remove('text-list-copied'), 2000);
        };
        list.rows.filter(row => !row.item).forEach(row => removeRow(list, row));
        filledItems(items).forEach(item => {
            const text = item.text.trim();
            // Keep only values the current config still offers.
            const choices = list.definition.choice_groups.map(group => {
                const values = (item.choices?.find(choice => choice.label === group.label)?.values || [])
                    .filter(value => group.options.some(option => option.label === value));
                return {label: group.label, values: group.multiple ? [...new Set(values)] : values.slice(0, 1)};
            });
            const existing = byText.get(text);
            if (existing) {
                if (JSON.stringify(existing.item.choices) === JSON.stringify(choices)) return unchanged++;
                existing.item.choices = choices;
                renderChoices(list, existing);
                highlight(existing.node);
                return updated++;
            }
            if (maximum !== null && byText.size >= maximum) return overLimit++;
            addRow(list, {text, choices});
            byText.set(text, list.rows.at(-1));
            highlight(list.rows.at(-1).node);
            added++;
        });
        list.error.textContent = '';
        refresh(list);
        changed();
        let message = `Pasted ${itemCount(added)} from ${sourceName}.`;
        if (updated) message += ` Choices updated on ${itemCount(updated)} already in the list.`;
        if (unchanged) message += ` ${itemCount(unchanged)} already in the list unchanged.`;
        if (overLimit) message += ` ${overLimit} not pasted (limit of ${maximum}).`;
        showStatus(list, message, added || updated ? () => {
            [...list.rows].forEach(row => removeRow(list, row));
            before.forEach(item => addRow(list, item));
            if (list.confirmation) list.confirmation.checked = wasConfirmed;
            refresh(list);
            changed();
        } : null);
    }
    function load(records) {
        if (!root) return;
        resizeObserver?.disconnect();
        usedIds = new Set(records.flatMap(record => (record.items || []).map(item => item.id).filter(Boolean)));
        root.replaceChildren();
        lists = config.map(definition => {
            const saved = records.find(record => record.label === definition.label);
            const section = element('section', '', 'my-3');
            const header = element('div', '', 'd-flex align-items-center justify-content-between gap-2 mb-1');
            const controls = element('div', '', 'd-flex align-items-center gap-2');
            const copyButton = element('button', 'Copy', 'btn btn-sm btn-outline-secondary');
            copyButton.type = 'button';
            copyButton.title = 'Copy this list to the clipboard';
            const pasteMenu = element('select', '', 'form-select form-select-sm w-auto');
            pasteMenu.setAttribute('aria-label', definition.label + ' — paste items');
            controls.append(copyButton, pasteMenu);
            header.append(element('h5', definition.label + (definition.required ? ' *' : ''), 'mb-0'), controls);
            section.append(header);
            if (definition.description) section.append(element('p', definition.description, 'text-muted small mb-2'));
            const error = element('div', '', 'text-danger small mb-1');
            error.setAttribute('role', 'alert');
            const container = element('div', '', 'text-list-rows');
            container.style.maxHeight = '65vh';
            container.style.overflowY = 'auto';
            const status = element('div', '', 'text-muted small mb-1');
            status.setAttribute('role', 'status');
            const list = {definition, rows: [], container, error, status, copyButton, pasteMenu, confirmation: null};
            copyButton.addEventListener('click', () => copyToClipboard(list));
            pasteMenu.addEventListener('change', () => {
                const value = pasteMenu.value;
                pasteMenu.value = '';
                if (value === 'clipboard') {
                    const stored = readClipboard()[definition.label];
                    if (stored) pasteItems(list, stored.items, `clipboard (${stored.source})`);
                } else if (value.startsWith('batch:')) {
                    const index = Number(value.slice(6));
                    const source = batchSources(list).find(([candidate]) => candidate === index);
                    if (source) pasteItems(list, source[1], `Answer ${index + 1}`);
                }
            });
            buildPasteMenu(list);
            if (definition.empty_confirmation) {
                const label = element('label', '', 'd-block small mb-1');
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'me-2';
                input.checked = saved?.empty_confirmed === true;
                input.addEventListener('change', () => { error.textContent = ''; changed(); });
                label.append(input, document.createTextNode(definition.empty_label));
                section.append(label);
                list.confirmation = input;
            }
            section.append(status, error, container);
            root.append(section);
            (saved?.items || []).filter(item => item.text?.trim()).forEach(item => addRow(list, item));
            refresh(list);
            return list;
        });
    }
    function collect() {
        return lists.map(list => ({label: list.definition.label,
            empty_confirmed: list.confirmation?.checked === true,
            items: list.rows.filter(row => row.item).map(row => structuredClone(row.item))}));
    }
    // Skipped examples keep structural checks but waive required lists and choices.
    function errors(records, skipped = false) {
        const ids = records.flatMap(record => (record.items || []).map(item => item.id).filter(Boolean));
        return config.map(definition => {
            if (ids.length !== new Set(ids).size) return 'Duplicate item IDs. Please correct the recovery data.';
            const record = records.find(value => value.label === definition.label) || {items: []};
            const items = (record.items || []).filter(item => item.text?.trim());
            if (definition.required && !skipped && !items.length && !record.empty_confirmed)
                return 'Add an item or confirm that there is nothing to add.';
            if (definition.max_items !== null && items.length > definition.max_items)
                return 'Maximum number of items exceeded.';
            if (record.empty_confirmed && (items.length || !definition.empty_confirmation))
                return 'Empty confirmation is only valid for an empty list.';
            for (const item of items) {
                for (const group of definition.choice_groups) {
                    const values = item.choices?.find(choice => choice.label === group.label)?.values || [];
                    if ((group.required && !skipped && !values.length) || (!group.multiple && values.length > 1) ||
                        new Set(values).size !== values.length ||
                        values.some(value => !group.options.some(option => option.label === value)))
                        return `Select valid choices for ${group.label}.`;
                }
            }
            return '';
        });
    }
    function validate(skipped = false) {
        const messages = errors(collect(), skipped);
        lists.forEach((list, index) => { list.error.textContent = messages[index]; });
        const first = lists.find((list, index) => messages[index]);
        if (first) first.error.scrollIntoView({block: 'center'});
        return !first;
    }
    return {load, collect, validate, errors};
})();
