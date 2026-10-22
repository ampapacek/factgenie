"""Shared configuration normalization and validation for human text lists."""

from uuid import uuid4


def _array(value, name):
    if not isinstance(value, list):
        raise ValueError(f"{name} must be a list")
    return value


def _string(value, name, allow_empty=False):
    if not isinstance(value, str) or (not value.strip() and not allow_empty):
        raise ValueError(f"{name} must be a nonempty string")
    return value.strip()


def _bool(obj, key, default=False):
    value = obj.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key} must be a boolean")
    return value


def _unique(values, name):
    if len(values) != len(set(values)):
        raise ValueError(f"Duplicate {name}")


def normalize_config(definitions):
    result = []
    for definition in _array(definitions, "text_lists"):
        if not isinstance(definition, dict):
            raise ValueError("Text list definition must be an object")
        label = _string(definition.get("label"), "List label")
        maximum = definition.get("max_items")
        if maximum is not None and (type(maximum) is not int or maximum <= 0):
            raise ValueError(f"{label}: max_items must be a positive integer or null")
        required = _bool(definition, "required")
        confirmation = _bool(definition, "empty_confirmation")
        if required and not confirmation:
            raise ValueError(f"{label}: required lists need empty_confirmation")
        groups = []
        for group in _array(definition.get("choice_groups", []), "choice_groups"):
            if not isinstance(group, dict):
                raise ValueError("Choice group must be an object")
            options = []
            for option in _array(group.get("options", []), "options"):
                if isinstance(option, str):
                    option = {"label": option}
                if not isinstance(option, dict):
                    raise ValueError("Option must be a string or object")
                code = option.get("code")
                options.append(
                    {
                        "label": _string(option.get("label"), "Option label"),
                        "code": None if code is None else _string(code, "Option code"),
                    }
                )
            if not options:
                raise ValueError("Choice groups need options")
            labels = [option["label"] for option in options]
            _unique(labels, "option labels")
            multiple = _bool(group, "multiple")
            defaults = [
                _string(value, "Default value") for value in _array(group.get("default_values", []), "default_values")
            ]
            _unique(defaults, "default values")
            if any(value not in labels for value in defaults) or (not multiple and len(defaults) > 1):
                raise ValueError("Invalid choice defaults")
            group_label = _string(group.get("label"), "Group label")
            group_required = _bool(group, "required")
            display = group.get("display", "choices")
            if display not in ("choices", "toggle"):
                raise ValueError(f"{group_label}: display must be 'choices' or 'toggle'")
            # A toggle is option 1 | unanswered | option 2; the neutral middle stores no value.
            if display == "toggle" and (multiple or group_required or defaults or len(options) != 2):
                raise ValueError(
                    f"{group_label}: toggle needs exactly two options and must be single-select, optional, without defaults"
                )
            groups.append(
                {
                    "label": group_label,
                    "multiple": multiple,
                    "required": group_required,
                    "display": display,
                    "default_values": defaults,
                    "options": options,
                }
            )
        _unique([group["label"] for group in groups], "group labels")
        result.append(
            {
                "label": label,
                "description": _string(definition.get("description", ""), "description", True),
                "placeholder": _string(definition.get("placeholder", ""), "placeholder", True),
                "max_items": maximum,
                "required": required,
                "empty_confirmation": confirmation,
                "empty_label": _string(definition.get("empty_label", "Nothing to add"), "empty_label"),
                "choice_groups": groups,
            }
        )
    _unique([definition["label"] for definition in result], "list labels")
    return result


def normalize_annotation(definitions, records, skipped=False):
    """Validate a submission, dropping blank rows and allocating only missing IDs.

    A skipped example keeps the structural checks but waives required lists and choices.
    """
    records = _array(records, "text_lists")
    supplied_ids = []
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Text list record must be an object")
        for item in _array(record.get("items", []), "items"):
            if not isinstance(item, dict):
                raise ValueError("List item must be an object")
            if item.get("id") is not None:
                _string(item["id"], "Item ID")
                supplied_ids.append(item["id"])
    _unique(supplied_ids, "item IDs")
    used_ids = set(supplied_ids)
    _unique([_string(record.get("label"), "List label") for record in records], "list labels")
    by_label = {record["label"]: record for record in records}
    if set(by_label) - {definition["label"] for definition in definitions}:
        raise ValueError("Unknown text list")
    result = []
    for definition in definitions:
        label = definition["label"]
        record = by_label.get(label, {})
        items = []
        for item in record.get("items", []):
            text = _string(item.get("text", ""), "Item text", True)
            if not text:
                continue
            choices = _array(item.get("choices", []), "choices")
            if any(not isinstance(choice, dict) for choice in choices):
                raise ValueError("Choice must be an object")
            _unique([_string(choice.get("label"), "Choice label") for choice in choices], "choice groups")
            choices_by_label = {choice["label"]: choice for choice in choices}
            if set(choices_by_label) - {group["label"] for group in definition["choice_groups"]}:
                raise ValueError(f"{label}: unknown choice group")
            normalized_choices = []
            for group in definition["choice_groups"]:
                values = _array(choices_by_label.get(group["label"], {}).get("values", []), "values")
                values = [_string(value, "Choice value") for value in values]
                _unique(values, "choice values")
                if (
                    any(value not in [option["label"] for option in group["options"]] for value in values)
                    or (not group["multiple"] and len(values) > 1)
                    or (group["required"] and not values and not skipped)
                ):
                    raise ValueError(f"{label} / {group['label']}: invalid or missing choice")
                normalized_choices.append({"label": group["label"], "values": values})
            item_id = item.get("id")
            if item_id is None:
                item_id = uuid4().hex
                while item_id in used_ids:
                    item_id = uuid4().hex
                used_ids.add(item_id)
            items.append({"id": item_id, "text": text, "choices": normalized_choices})
        maximum = definition["max_items"]
        if maximum is not None and len(items) > maximum:
            raise ValueError(f"{label}: too many items")
        confirmed = _bool(record, "empty_confirmed")
        if confirmed and (items or not definition["empty_confirmation"]):
            raise ValueError(f"{label}: invalid empty confirmation")
        if definition["required"] and not items and not confirmed and not skipped:
            raise ValueError(f"{label}: add an item or confirm the list is empty")
        result.append({"label": label, "empty_confirmed": confirmed, "items": items})
    return result


def is_skipped(annotation):
    """Same skip-flag convention as querying.is_skip_selected (labels containing skip/přeskoč)."""
    for flag in annotation.get("flags") or []:
        if not isinstance(flag, dict):
            continue
        label = str(flag.get("label", "")).lower()
        if ("skip" in label or "přeskoč" in label or "preskoc" in label) and flag.get("value") is True:
            return True
    return False


def submission_lists(config, annotation):
    return normalize_annotation(
        normalize_config(config.get("text_lists", [])),
        annotation.get("text_lists", annotation.get("textLists", [])),
        skipped=is_skipped(annotation),
    )


def reject_llm_lists(config):
    if config.get("text_lists") or config.get("textLists"):
        raise ValueError("Text lists are not supported in LLM campaigns yet.")
