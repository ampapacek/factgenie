#!/usr/bin/env python3

import datetime
import hashlib
import json
import logging
import os
import random
import shutil
import time
from pathlib import Path

import markdown
import pandas as pd
from flask import jsonify
from jinja2 import Template

import factgenie.utils as utils
import factgenie.redo as redo
import factgenie.workflows as workflows
from factgenie import CAMPAIGN_DIR, PREVIEW_STUDY_ID, TEMPLATES_DIR
from factgenie.campaign import CampaignMode, ExampleStatus

logger = logging.getLogger("factgenie")


def is_preview_annotator(annotator_id):
    return annotator_id == PREVIEW_STUDY_ID


def _sanitize_redo_annotations_for_campaign(campaign, item, annotations):
    if not isinstance(annotations, list):
        return []

    categories = campaign.metadata.get("config", {}).get("annotation_span_categories", [])
    valid_annotations = []

    for index, annotation in enumerate(annotations):
        try:
            annotation_type = int(annotation.get("type"))
        except (TypeError, ValueError, AttributeError):
            annotation_type = None

        if annotation_type is not None and 0 <= annotation_type < len(categories):
            valid_annotations.append(annotation)
            continue

        logger.warning(
            "Skipping redo annotation with unknown type: campaign=%s redo_id=%s dataset=%s split=%s setup_id=%s example_idx=%s annotator_id=%s annotation_index=%s type=%r text=%r start=%r available_types=%s",
            campaign.campaign_id,
            item.get("redo_id"),
            item.get("dataset"),
            item.get("split"),
            item.get("setup_id"),
            item.get("example_idx"),
            item.get("annotator_id"),
            index,
            annotation.get("type") if isinstance(annotation, dict) else None,
            annotation.get("text") if isinstance(annotation, dict) else None,
            annotation.get("start") if isinstance(annotation, dict) else None,
            [category.get("name", "") for category in categories],
        )

    return valid_annotations


def create_crowdsourcing_campaign(app, campaign_id, config, campaign_data):
    # create a new directory
    if os.path.exists(os.path.join(CAMPAIGN_DIR, campaign_id)):
        return jsonify({"error": "Campaign already exists"})

    try:
        os.makedirs(os.path.join(CAMPAIGN_DIR, campaign_id, "files"), exist_ok=True)

        # create the annotation CSV
        db = generate_crowdsourcing_campaign_db(app, campaign_data, config=config)
        db.to_csv(os.path.join(CAMPAIGN_DIR, campaign_id, "db.csv"), index=False)

        # save metadata
        with open(os.path.join(CAMPAIGN_DIR, campaign_id, "metadata.json"), "w") as f:
            json.dump(
                {
                    "id": campaign_id,
                    "mode": CampaignMode.CROWDSOURCING,
                    "config": config,
                    "created": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "hidden_from_regular_users": False,
                },
                f,
                indent=4,
                ensure_ascii=False,
            )

        # prepare the crowdsourcing HTML page
        create_crowdsourcing_page(campaign_id, config)

        workflows.load_campaign(app, campaign_id)
    except Exception as e:
        # cleanup
        shutil.rmtree(os.path.join(CAMPAIGN_DIR, campaign_id))
        raise e


def create_crowdsourcing_page(campaign_id, config):
    final_page_path = os.path.join(CAMPAIGN_DIR, campaign_id, "pages", "annotate.html")

    os.makedirs(os.path.dirname(final_page_path), exist_ok=True)

    # assemble the crowdsourcing page
    parts = []
    for part in ["header", "body", "footer"]:
        part_path = os.path.join(TEMPLATES_DIR, CampaignMode.CROWDSOURCING, "annotate_{}.html".format(part))

        with open(part_path, "r") as f:
            parts.append(f.read())

    instructions_html = markdown.markdown(config["annotator_instructions"])

    # format only the body, keeping the unfilled templates in header and footer
    template = Template(parts[1])

    rendered_content = template.render(
        instructions=instructions_html,
        annotator_preferences={"hide_instructions_next_time": False},
        annotation_span_categories=config.get("annotation_span_categories", []),
        flags=generate_flags(config.get("flags", [])),
        options=generate_options(config.get("options", [])),
        sliders=generate_sliders(config.get("sliders", [])),
        text_fields=generate_text_fields(config.get("text_fields", [])),
    )

    # concatenate with header and footer
    content = parts[0] + rendered_content + parts[2]

    with open(final_page_path, "w") as f:
        f.write(content)


def ensure_crowdsourcing_page_current(campaign_id, config):
    final_page_path = os.path.join(CAMPAIGN_DIR, campaign_id, "pages", "annotate.html")
    template_paths = [
        os.path.join(TEMPLATES_DIR, CampaignMode.CROWDSOURCING, "annotate_{}.html".format(part))
        for part in ["header", "body", "footer"]
    ]
    if not os.path.exists(final_page_path):
        create_crowdsourcing_page(campaign_id, config)
        return

    page_mtime = os.path.getmtime(final_page_path)
    if any(os.path.getmtime(path) > page_mtime for path in template_paths):
        create_crowdsourcing_page(campaign_id, config)


def generate_text_fields(text_fields):
    if not text_fields:
        return ""

    text_fields_segment = "<div class='mt-2 mb-3'>"
    for i, text_field in enumerate(text_fields):
        text_fields_segment += f"""
            <div class="form-group crowdsourcing-text mb-4">
                <label for="textbox-crowdsourcing-{i}"><b>{text_field}</b></label>
                <textarea cols="50" rows="5" style="resize: both;" class="form-control textbox-crowdsourcing" id="textbox-crowdsourcing-{i}"></textarea>
            </div>
        """
    text_fields_segment += "</div>"
    return text_fields_segment


def generate_options(options):
    if not options:
        return ""

    options_segment = "<div class='mt-2 mb-3'>"
    for i, option in enumerate(options):
        options_segment += f"""
            <div class="form-group crowdsourcing-option option-select mb-4">
                <div><label for="select-{i}"><b>{option["label"]}</b></label></div>
                <select class="form-select select-crowdsourcing mb-1" id="select-crowdsourcing-{i}">
                    <option value="" selected disabled>Select an option...</option>
        """
        for j, value in enumerate(option["values"]):
            options_segment += f"""<option class="select-crowdsourcing-{i}-value" value="{j}">{value}</option>
            """
        options_segment += """
                </select>
            </div>
        """

    return options_segment


def generate_sliders(sliders):
    if not sliders:
        return ""

    sliders_segment = "<div class='mt-2 mb-3'>"
    for i, slider in enumerate(sliders):
        sliders_segment += f"""
            <div class="form-group crowdsourcing-slider mb-4">
                <label for="slider-{i}"><b>{slider["label"]}</b></label>
                <input type="range" class="form-range slider-crowdsourcing" id="slider-crowdsourcing-{i}" min="{slider["min"]}" max="{slider["max"]}" step="{slider["step"]}" value="{slider["min"]}">
                <div class="d-flex justify-content-between">
                    <div class="text-muted small"><span>{slider["min"]}</span></div>
                    <div><span id="slider-crowdsourcing-{i}-value" class="slider-crowdsourcing-value" data-default-value="{slider["min"]}"></span></div>
                    <div class="text-muted small"><span>{slider["max"]}</span></div>
                </div>
            </div>
        """
    sliders_segment += "</div>"
    sliders_segment += """<script src="{{ host_prefix }}/static/js/render-sliders.js"></script>"""
    return sliders_segment


def generate_flags(flags):
    if not flags:
        return ""

    flags_segment = "<div class='mb-4'><p><b>Please check if you agree with any of the following statements:</b></p>"
    for i, flag in enumerate(flags):
        flags_segment += f"""
            <div class="form-check crowdsourcing-flag">
                <input class="form-check-input" type="checkbox" value="{i}" id="checkbox-{i}">
                <label class="form-check-label" for="checkbox-{i}">
                    {flag}
                </label>
            </div>
        """
    flags_segment += "</div>"

    return flags_segment


def generate_crowdsourcing_campaign_db(app, campaign_data, config):
    # load all outputs
    all_examples = []

    examples_per_batch = config["examples_per_batch"]
    annotators_per_example = config["annotators_per_example"]
    sort_order = config["sort_order"]

    for c in campaign_data:
        for i in workflows.get_output_ids(app, c["dataset"], c["split"], c["setup_id"]):
            all_examples.append(
                {
                    "dataset": c["dataset"],
                    "split": c["split"],
                    "example_idx": i,
                    "setup_id": c["setup_id"],
                }
            )

    # deterministic shuffling
    random.seed(42)

    # shuffle all examples and setups
    if sort_order == "shuffle-all":
        random.shuffle(all_examples)
    # sort examples by example_idx, shuffle setups
    elif sort_order == "sort-example-ids-shuffle-setups":
        random.shuffle(all_examples)
        all_examples = sorted(all_examples, key=lambda x: (x["example_idx"], x["dataset"], x["split"]))
    # sort examples by example_idx, keep the setup order
    elif sort_order == "sort-example-ids-keep-setups":
        all_examples = sorted(all_examples, key=lambda x: (x["example_idx"], x["dataset"], x["split"]))
    # keep all examples and setups in the default order
    elif sort_order == "keep-all":
        pass
    else:
        raise ValueError(f"Unknown sort order {sort_order}")

    df = pd.DataFrame.from_records(all_examples)

    # create a column for batch index and assign each example to a batch
    df["batch_idx"] = df.index // examples_per_batch
    batch_count = int(df["batch_idx"].max()) + 1 if not df.empty else 0

    # Create multiple copies of the dataframe for each annotator group
    dfs = []
    for annotator_group in range(annotators_per_example):
        df_copy = df.copy()
        df_copy["annotator_group"] = annotator_group
        # Offset by the actual number of batches so new campaigns get contiguous ids.
        df_copy["batch_idx"] += annotator_group * batch_count
        dfs.append(df_copy)

    # Combine all dataframes
    df = pd.concat(dfs, ignore_index=True)

    df["annotator_id"] = ""
    df["status"] = ExampleStatus.FREE
    df["start"] = None
    df["end"] = None

    return df


def get_service_ids(service, args):
    # we always need to have at least the annotator_id
    service_ids = {
        "annotator_id": None,
    }
    if service == "local":
        service_ids["annotator_id"] = args.get("annotatorId", PREVIEW_STUDY_ID)
    elif service == "prolific":
        service_ids["annotator_id"] = args.get("PROLIFIC_PID", PREVIEW_STUDY_ID)
        service_ids["session_id"] = args.get("SESSION_ID", PREVIEW_STUDY_ID)
        service_ids["study_id"] = args.get("STUDY_ID", PREVIEW_STUDY_ID)
    elif service == "mturk":
        service_ids["annotator_id"] = args.get("workerId", PREVIEW_STUDY_ID)
        service_ids["session_id"] = args.get("assignmentId", PREVIEW_STUDY_ID)
        service_ids["study_id"] = args.get("hitId", PREVIEW_STUDY_ID)
    else:
        raise ValueError(f"Unknown service {service}")

    return service_ids


def parse_crowdsourcing_config(config):
    # parse Nones or empty strings
    examples_per_batch = config.get("examplesPerBatch")
    examples_per_batch = int(examples_per_batch) if examples_per_batch else 10
    annotators_per_example = config.get("annotatorsPerExample")
    annotators_per_example = int(annotators_per_example) if annotators_per_example else 1
    idle_time = config.get("idleTime")
    idle_time = int(idle_time) if idle_time else 120
    config = {
        "annotator_instructions": config.get("annotatorInstructions", "No instructions needed :)"),
        "final_message": config.get("finalMessage"),
        "examples_per_batch": int(examples_per_batch),
        "annotators_per_example": int(annotators_per_example),
        "idle_time": int(idle_time),
        "annotation_granularity": config.get("annotationGranularity"),
        "annotation_overlap_allowed": config.get("annotationOverlapAllowed", False),
        "annotate_reason": config.get("annotateReason", False),
        "pseudonymize_annotators": config.get("pseudonymizeAnnotators", True),
        "service": config.get("service"),
        "sort_order": config.get("sortOrder"),
        "annotation_span_categories": config.get("annotationSpanCategories"),
        "flags": config.get("flags"),
        "options": config.get("options"),
        "sliders": config.get("sliders"),
        "text_fields": config.get("textFields"),
    }

    return config


def select_batch(db, seed, annotator_id):
    # If the annotator already has any examples with ExampleStatus.ASSIGNED, return that batch
    if annotator_id != PREVIEW_STUDY_ID:
        if not db.loc[(db["annotator_id"] == annotator_id) & (db["status"] == ExampleStatus.ASSIGNED)].empty:
            assigned_batch = db.loc[
                (db["annotator_id"] == annotator_id) & (db["status"] == ExampleStatus.ASSIGNED)
            ].iloc[0]
            logging.info(f"Reusing batch {assigned_batch['batch_idx']}")
            return assigned_batch["batch_idx"]
    
    free_batches = db[db["status"] == ExampleStatus.FREE]

    # Ensure a single annotator does not see the same underlying example multiple times
    # when annotators_per_example > 1 (examples are duplicated across annotator_group).
    if annotator_id != PREVIEW_STUDY_ID:
        key_cols = ["dataset", "split", "setup_id", "example_idx"]
        annotated = db.loc[
            (db["annotator_id"] == annotator_id) & (db["status"] != ExampleStatus.FREE),
            key_cols,
        ]
        if not annotated.empty:
            annotated_keys = set(map(tuple, annotated.to_numpy()))
            free_keys = pd.Series(
                list(
                    zip(
                        free_batches["dataset"],
                        free_batches["split"],
                        free_batches["setup_id"],
                        free_batches["example_idx"],
                    )
                ),
                index=free_batches.index,
            )
            free_batches = free_batches[~free_keys.isin(annotated_keys)]



    # Choose from the batches with the lowest annotator group
    eligible_batches = free_batches.groupby("batch_idx")["annotator_group"].min()

    eligible_batches = eligible_batches[eligible_batches == eligible_batches.min()]

    eligible_examples = free_batches[free_batches["batch_idx"].isin(eligible_batches.index)]

    # Randomly select an example (with its batch) from the eligible ones
    if not eligible_examples.empty:
        selected_example = eligible_examples.sample(n=1, random_state=seed).iloc[0]
        selected_batch_idx = selected_example["batch_idx"]

        logging.info(f"Selected batch {selected_batch_idx}")
        return selected_batch_idx
    else:
        raise ValueError("No available batches")


def get_examples_for_batch(db, batch_idx):
    annotator_batch = []

    # find all examples for this batch and annotator group
    batch_examples = db[db["batch_idx"] == batch_idx]

    for _, row in batch_examples.iterrows():
        annotator_batch.append(
            {
                "dataset": row["dataset"],
                "split": row["split"],
                "setup_id": row["setup_id"],
                "example_idx": row["example_idx"],
                "batch_idx": row["batch_idx"],
                "annotator_group": row["annotator_group"],
            }
        )

    return annotator_batch


def select_preview_batch(db):
    if db.empty or "batch_idx" not in db:
        raise ValueError("No available batches")
    batch_ids = sorted(db["batch_idx"].dropna().unique())
    if not batch_ids:
        raise ValueError("No available batches")
    return batch_ids[0]


def get_redo_annotation_set(app, campaign, db, annotator_id, include_completed=False):
    items = redo.list_items_for_annotator(campaign.campaign_id, annotator_id, include_completed=include_completed)
    annotation_set = []

    for item in items:
        active_record = redo.latest_active_record(campaign.campaign_id, item) or {}
        annotations = _sanitize_redo_annotations_for_campaign(campaign, item, active_record.get("annotations", []))
        annotation_set.append(
            {
                "dataset": item["dataset"],
                "split": item["split"],
                "setup_id": item["setup_id"],
                "example_idx": int(item["example_idx"]),
                "batch_idx": int(item["batch_idx"]),
                "annotator_group": int(item.get("annotator_group", 0)),
                "output": active_record.get("output", ""),
                "annotations": annotations,
                "flags": active_record.get("flags", []),
                "options": active_record.get("options", []),
                "sliders": active_record.get("sliders", []),
                "textFields": active_record.get("text_fields", []),
                "redo": True,
                "redo_id": item["redo_id"],
                "redo_status": item.get("status", redo.STATUS_PENDING),
                "redo_instruction": item.get("instruction"),
            }
        )

    return annotation_set


def get_annotator_batch(app, campaign, service_ids, batch_idx=None, include_completed_redo=False, return_context=False):
    # simple locking over the CSV file to prevent double writes
    redo_context = {
        "mode": "normal",
        "is_redo": False,
        "empty_redo_fallback": False,
        "show_completed": include_completed_redo,
    }
    with app.db["lock"]:
        campaign.load_db()
        db = campaign.db
        annotator_id = service_ids["annotator_id"]

        logger.info(f"Acquiring lock for {annotator_id}")
        start = int(time.time())
        seed_source = json.dumps({"start": start, "service_ids": service_ids}, sort_keys=True, default=str)
        seed = int(hashlib.sha256(seed_source.encode("utf-8")).hexdigest()[:8], 16)

        should_serve_redo = False
        if annotator_id != PREVIEW_STUDY_ID and (batch_idx is None or batch_idx == ""):
            should_serve_redo = redo.is_redo_mode(campaign.campaign_id, annotator_id)
            if include_completed_redo and not should_serve_redo:
                should_serve_redo = bool(
                    redo.list_items_for_annotator(campaign.campaign_id, annotator_id, include_completed=True)
                )

        if should_serve_redo:
            redo_context["mode"] = "redo"
            redo_set = get_redo_annotation_set(app, campaign, db, annotator_id, include_completed_redo)
            if redo_set:
                redo_context["is_redo"] = True
                logging.info(f"Serving {len(redo_set)} redo item(s) for {annotator_id}")
                if return_context:
                    return redo_set, redo_context
                return redo_set
            redo_context["empty_redo_fallback"] = True

        if batch_idx is None or batch_idx == "":
            try:
                if annotator_id == PREVIEW_STUDY_ID:
                    batch_idx = select_preview_batch(db)
                else:
                    # usual case: an annotator opened the annotation page, we need to select the batch
                    batch_idx = select_batch(db, seed, annotator_id)
            except ValueError as e:
                logger.info(str(e))
                # no available batches
                if return_context:
                    return [], redo_context
                return []
        else:
            # preview mode with the specific batch
            batch_idx = int(batch_idx)

        mask = db["batch_idx"] == batch_idx

        # we do not block the example if we are in preview mode
        if annotator_id != PREVIEW_STUDY_ID:
            db.loc[mask, "status"] = ExampleStatus.ASSIGNED
            db.loc[mask, "start"] = start
            db.loc[mask, "annotator_id"] = annotator_id

            campaign.update_db(db)

        annotator_batch = get_examples_for_batch(db, batch_idx)
        logging.info(f"Releasing lock for {annotator_id}")

    if return_context:
        return annotator_batch, redo_context
    return annotator_batch


def save_redo_annotation(app, campaign_id, redo_id, annotation, annotator_id):
    if not campaign_id or not redo_id or not annotator_id or not isinstance(annotation, dict):
        return utils.error("Missing campaign_id, redo_id, annotator_id, or annotation")

    now = int(time.time())
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)

    with app.db["lock"]:
        queue_path = redo.queue_path(campaign_id)
        revision_path = redo.revision_log_path(campaign_id)
        db_path = Path(CAMPAIGN_DIR) / campaign_id / "db.csv"
        queue_backup = queue_path.read_text(encoding="utf-8") if queue_path.exists() else None
        revision_backup = revision_path.read_text(encoding="utf-8") if revision_path.exists() else None
        db_backup = db_path.read_text(encoding="utf-8") if db_path.exists() else None

        queue = redo.load_queue(campaign_id)
        item = redo.find_item(queue, redo_id)
        if item is None:
            return utils.error(f"Unknown redo item: {redo_id}")
        if item.get("campaign_id") != campaign_id:
            return utils.error("Redo item does not belong to this campaign")
        if redo.normalize_annotator_id(item.get("annotator_id")) != redo.normalize_annotator_id(annotator_id):
            return utils.error(f"Redo item not assigned to annotator {annotator_id}")
        if item.get("status") == redo.STATUS_CANCELLED:
            return utils.error("Redo item is cancelled")

        campaign.load_db()
        db = campaign.db
        mask = (
            (db["dataset"].astype(str) == str(item["dataset"]))
            & (db["split"].astype(str) == str(item["split"]))
            & (db["setup_id"].astype(str) == str(item["setup_id"]))
            & (db["example_idx"].astype(int) == int(item["example_idx"]))
            & (db["annotator_group"].astype(int) == int(item.get("annotator_group", 0)))
            & (db["annotator_id"].fillna("").astype(str) == str(annotator_id))
        )
        if mask.sum() != 1:
            return utils.error("Could not find a unique assigned campaign row for this redo item")

        row_idx = db[mask].index[0]
        row = db.loc[row_idx]
        save_dir = os.path.join(CAMPAIGN_DIR, campaign_id, "files")
        batch_end = int(row["end"])
        save_filename = f"{row['batch_idx']}-{row.get('annotator_group', 0)}-{annotator_id}-{batch_end}.jsonl"
        save_path = os.path.join(save_dir, save_filename)

        active_matches = redo.find_active_records(campaign_id, item)
        active_backups = {}
        for match in active_matches:
            match_path = str(match["file"])
            if match_path not in active_backups:
                active_backups[match_path] = match["file"].read_text(encoding="utf-8")

        save_path_backup = Path(save_path).read_text(encoding="utf-8") if Path(save_path).exists() else None

        def restore_backups():
            if queue_backup is not None:
                queue_path.write_text(queue_backup, encoding="utf-8")
            elif queue_path.exists():
                queue_path.unlink()

            if revision_backup is not None:
                revision_path.parent.mkdir(parents=True, exist_ok=True)
                revision_path.write_text(revision_backup, encoding="utf-8")
            elif revision_path.exists():
                revision_path.unlink()

            for match_path, content in active_backups.items():
                Path(match_path).write_text(content, encoding="utf-8")

            if save_path_backup is not None:
                Path(save_path).write_text(save_path_backup, encoding="utf-8")
            elif Path(save_path).exists():
                Path(save_path).unlink()

            if db_backup is not None:
                db_path.write_text(db_backup, encoding="utf-8")
            elif db_path.exists():
                db_path.unlink()

        try:
            output = workflows.get_output_for_setup(
                dataset=row["dataset"],
                split=row["split"],
                setup_id=row["setup_id"],
                example_idx=row["example_idx"],
                app=app,
                force_reload=False,
            )["output"]

            annotations = [a for a in annotation.get("annotations", []) if a.get("text")]
            result = {
                "annotations": annotations,
                "flags": annotation.get("flags", []),
                "options": annotation.get("options", []),
                "sliders": annotation.get("sliders", []),
                "text_fields": annotation.get("textFields", annotation.get("text_fields", [])),
                "time_last_saved": annotation.get("timeLastSaved", annotation.get("time_last_saved")),
                "time_last_accessed": annotation.get("timeLastAccessed", annotation.get("time_last_accessed")),
                "output": output,
            }

            redo.archive_and_remove_active_records(
                campaign_id,
                item,
                archived_by=annotator_id,
                replacement_saved_at=redo.utc_now(),
            )
            workflows.save_record(
                mode=CampaignMode.CROWDSOURCING,
                campaign=campaign,
                row=row,
                result=result,
            )
            completed = redo.mark_completed(campaign_id, redo_id, saved_by=annotator_id)

            updated_db = db.copy()
            updated_db.loc[row_idx, "status"] = ExampleStatus.FINISHED
            updated_db.loc[row_idx, "end"] = now
            campaign.update_db(updated_db)
        except Exception as exc:
            restore_backups()
            return utils.error(f"Redo item could not be saved: {exc}")

    workflows.refresh_indexes(app)
    logger.info(
        "Redo annotation saved for %s by %s (%s/%s/%s/%s)",
        campaign_id,
        annotator_id,
        item["dataset"],
        item["split"],
        item["setup_id"],
        item["example_idx"],
    )
    final_message_html = markdown.markdown(campaign.metadata["config"].get("final_message", "Thank you."))
    return jsonify(
        success=True,
        item=completed,
        message="Redo item saved.",
        final_message=final_message_html,
        remaining_pending=redo.pending_count(campaign_id, annotator_id),
    )


def keep_redo_annotation(app, campaign_id, redo_id, annotator_id):
    if not campaign_id or not redo_id or not annotator_id:
        return utils.error("Missing campaign_id, redo_id, or annotator_id")

    campaign = workflows.load_campaign(app, campaign_id=campaign_id)

    with app.db["lock"]:
        queue = redo.load_queue(campaign_id)
        item = redo.find_item(queue, redo_id)
        if item is None:
            return utils.error(f"Unknown redo item: {redo_id}")
        if item.get("campaign_id") != campaign_id:
            return utils.error("Redo item does not belong to this campaign")
        if redo.normalize_annotator_id(item.get("annotator_id")) != redo.normalize_annotator_id(annotator_id):
            return utils.error(f"Redo item not assigned to annotator {annotator_id}")
        if item.get("status") == redo.STATUS_CANCELLED:
            return utils.error("Redo item is cancelled")

        if item.get("status") == redo.STATUS_PENDING:
            kept_item = redo.mark_completed(campaign_id, redo_id, saved_by=annotator_id)
        else:
            kept_item = item

    final_message_html = markdown.markdown(campaign.metadata["config"].get("final_message", "Thank you."))
    return jsonify(
        success=True,
        item=kept_item,
        message="Redo item kept.",
        final_message=final_message_html,
        remaining_pending=redo.pending_count(campaign_id, annotator_id),
    )


def save_annotations(app, campaign_id, annotation_set, annotator_id, is_backup_import=False):
    if is_preview_annotator(annotator_id) and not is_backup_import:
        logger.info(f"Rejected preview annotation submit for {campaign_id}")
        return utils.error("Preview mode is read-only. Preview annotations are not saved.")

    now = int(time.time())

    save_dir = os.path.join(CAMPAIGN_DIR, campaign_id, "files")
    os.makedirs(save_dir, exist_ok=True)
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)

    with app.db["lock"]:
        campaign.load_db()
        db = campaign.db
        batch_idx = annotation_set[0]["batch_idx"]

        # select the examples for this batch and annotator group
        mask = db["batch_idx"] == batch_idx

        # if the batch is not assigned to this annotator, return an error
        # Skip this check for backup imports (administrators can override)
        if not is_backup_import:
            batch_annotator_id = db.loc[mask].iloc[0]["annotator_id"]

            if batch_annotator_id != annotator_id and not is_preview_annotator(annotator_id):
                logger.info(
                    f"Annotations rejected: batch {batch_idx} in {campaign_id} not assigned to annotator {annotator_id}"
                )
                return utils.error(f"Batch not assigned to annotator {annotator_id}")

        # update the db
        db.loc[mask, "status"] = ExampleStatus.FINISHED
        db.loc[mask, "end"] = now
        campaign.update_db(db)

        # save the annotations
        for i, ann in enumerate(annotation_set):
            row = db.loc[mask].iloc[i]

            # retrieve the related model output to save it with the annotations
            output = workflows.get_output_for_setup(
                dataset=row["dataset"],
                split=row["split"],
                setup_id=row["setup_id"],
                example_idx=row["example_idx"],
                app=app,
                force_reload=False,
            )["output"]

            annotations = ann["annotations"]
            # remove empty annotations
            annotations = [a for a in annotations if a["text"]]

            res = {
                "annotations": annotations,
                "flags": ann["flags"],
                "options": ann["options"],
                "sliders": ann["sliders"],
                "text_fields": ann["textFields"],
                "time_last_saved": ann.get("timeLastSaved"),
                "time_last_accessed": ann.get("timeLastAccessed"),
                "output": output,
            }
            # save the record to a JSONL file
            workflows.save_record(
                mode=CampaignMode.CROWDSOURCING,
                campaign=campaign,
                row=row,
                result=res,
            )
        logger.info(
            f"Annotations for {campaign_id} (batch {batch_idx}, annotator {annotator_id}) saved{' from backup import' if is_backup_import else ''}."
        )

    final_message_html = markdown.markdown(campaign.metadata["config"]["final_message"])

    if is_preview_annotator(annotator_id):
        preview_message = f'<div class="alert alert-info" role="alert"><p>You are in a preview mode. Click <a href="{app.config["host_prefix"]}/crowdsourcing"><b>here</b></a> to go back to the campaign view.</p><p><i>This message will not be displayed to the annotators.</i></p></div>'

        return utils.success(message=final_message_html + preview_message)

    return utils.success(message=final_message_html)
