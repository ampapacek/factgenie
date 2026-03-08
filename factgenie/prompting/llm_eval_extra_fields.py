#!/usr/bin/env python3


def normalize_extra_fields_config(config: dict) -> dict:
    flags = [flag.strip() for flag in config.get("flags", []) or [] if isinstance(flag, str) and flag.strip()]

    options = []
    for option in config.get("options", []) or []:
        if not isinstance(option, dict):
            continue

        label = str(option.get("label", "")).strip()
        values = [str(value).strip() for value in option.get("values", []) or [] if str(value).strip()]
        if label and values:
            options.append({"label": label, "values": values})

    sliders = []
    for slider in config.get("sliders", []) or []:
        if not isinstance(slider, dict):
            continue

        label = str(slider.get("label", "")).strip()
        if not label:
            continue

        sliders.append(
            {
                "label": label,
                "min": slider.get("min"),
                "max": slider.get("max"),
                "step": slider.get("step"),
            }
        )

    text_fields = [
        field.strip()
        for field in config.get("text_fields", []) or []
        if isinstance(field, str) and field.strip()
    ]

    return {
        "flags": flags,
        "options": options,
        "sliders": sliders,
        "text_fields": text_fields,
    }


def has_extra_fields(config: dict) -> bool:
    normalized = normalize_extra_fields_config(config)
    return any(len(values) > 0 for values in normalized.values())


def build_extra_fields_followup_prompt(
    config: dict,
    include_context: bool = False,
    annotations_field: str = "annotations_raw",
) -> str:
    custom_prompt = str(config.get("extra_fields_prompt_template", "") or "").strip()
    if custom_prompt:
        return custom_prompt.replace("{annotations}", f"{{{annotations_field}}}")

    normalized = normalize_extra_fields_config(config)

    prompt_lines = []
    if include_context:
        prompt_lines.extend(
            [
                "You are reviewing the same evaluation example described below.",
                "",
                "Text:",
                "{text}",
                "",
                "Source data:",
                "{data}",
                "",
                "Span annotations already generated:",
                f"{{{annotations_field}}}",
                "",
            ]
        )
    else:
        prompt_lines.extend(
            [
                "You have already completed the span annotations for this example.",
                "Now answer the additional evaluation fields for the same example.",
                "",
            ]
        )

    prompt_lines.extend(
        [
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
            '- For flags, return only true or false values.',
            "- For options, return one of the listed option values exactly.",
            "- For sliders, return a numeric value inside the allowed range.",
            '- For text fields, return a string. Use an empty string when there is nothing to add.',
        ]
    )

    if normalized["flags"]:
        prompt_lines.extend(["", "Flags:"])
        prompt_lines.extend([f'- "{label}"' for label in normalized["flags"]])

    if normalized["options"]:
        prompt_lines.extend(["", "Options:"])
        prompt_lines.extend(
            [f'- "{option["label"]}": {", ".join(option["values"])}' for option in normalized["options"]]
        )

    if normalized["sliders"]:
        prompt_lines.extend(["", "Sliders:"])
        prompt_lines.extend(
            [
                f'- "{slider["label"]}": min={slider["min"]}, max={slider["max"]}, step={slider["step"]}'
                for slider in normalized["sliders"]
            ]
        )

    if normalized["text_fields"]:
        prompt_lines.extend(["", "Text fields:"])
        prompt_lines.extend([f'- "{label}"' for label in normalized["text_fields"]])

    return "\n".join(prompt_lines)
