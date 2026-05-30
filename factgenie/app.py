#!/usr/bin/env python3
import datetime
import json
import logging
import os
import queue
import re
import shutil
import threading
import traceback
import urllib.parse

from flask import (
    Flask,
    Response,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    send_from_directory,
)
from math import isnan
from slugify import slugify
from werkzeug.middleware.proxy_fix import ProxyFix

import factgenie.analysis as analysis
import factgenie.crowdsourcing as crowdsourcing
import factgenie.llm_campaign as llm_campaign
import factgenie.querying as querying
import factgenie.redo as redo
import factgenie.utils as utils
import factgenie.workflows as workflows
from factgenie import CAMPAIGN_DIR, INPUT_DIR, PACKAGE_DIR, PREVIEW_STUDY_ID, STATIC_DIR, TEMPLATES_DIR
from factgenie.campaign import CampaignMode, CampaignStatus, ExampleStatus
from factgenie.models import ModelFactory

app = Flask("factgenie", template_folder=TEMPLATES_DIR, static_folder=STATIC_DIR)
app.db = {}
app.db["annotation_index"] = None
app.db["annotation_index_cache"] = {}
app.db["output_index"] = None
app.db["output_index_cache"] = {}
app.db["lock"] = threading.Lock()
app.db["running_campaigns"] = set()
app.db["running_campaign_threads"] = {}
app.db["announcers"] = {}
app.wsgi_app = ProxyFix(app.wsgi_app, x_host=1)

logger = logging.getLogger("factgenie")

ANNOTATOR_PSEUDONYM_CITIES = [
    "Tokyo",
    "Paris",
    "London",
    "New York",
    "Sydney",
    "Berlin",
    "Rome",
    "Cairo",
    "Mumbai",
    "Mexico City",
]


def run_llm_campaign_background(app, mode, campaign_id, announcer, campaign, datasets, model):
    with app.app_context():
        try:
            running_campaigns = app.db["running_campaigns"]
            response = llm_campaign.run_llm_campaign(
                app, mode, campaign_id, announcer, campaign, datasets, model, running_campaigns
            )

            payload = response.get_json(silent=True) if hasattr(response, "get_json") else None
            if payload and payload.get("success") is False:
                llm_campaign.pause_llm_campaign(app, campaign_id)
                utils.announce(
                    announcer,
                    {
                        "campaign_id": campaign_id,
                        "type": "error",
                        "message": payload.get("error", "Unknown error while running campaign."),
                    },
                )

        except Exception as e:
            traceback.print_exc()
            llm_campaign.pause_llm_campaign(app, campaign_id)
            utils.announce(
                announcer,
                {
                    "campaign_id": campaign_id,
                    "type": "error",
                    "message": f"Error while running campaign: {e}",
                },
            )
        finally:
            app.db["running_campaign_threads"].pop(campaign_id, None)


def start_llm_campaign_background(app, mode, campaign_id, announcer, campaign, datasets, model):
    thread = threading.Thread(
        target=run_llm_campaign_background,
        args=(app, mode, campaign_id, announcer, campaign, datasets, model),
        daemon=True,
    )
    app.db["running_campaign_threads"][campaign_id] = thread
    thread.start()
    return thread


def reconcile_llm_campaign_runtime_state(app, campaign):
    campaign_id = campaign.metadata["id"]
    thread = app.db["running_campaign_threads"].get(campaign_id)
    is_running = thread is not None and thread.is_alive()
    had_local_thread = thread is not None

    if had_local_thread and not is_running and campaign_id in app.db["running_campaigns"]:
        app.db["running_campaigns"].discard(campaign_id)
        app.db["running_campaign_threads"].pop(campaign_id, None)
        app.db["announcers"].pop(campaign_id, None)

    if is_running and campaign.metadata["status"] != CampaignStatus.RUNNING:
        campaign.metadata["status"] = CampaignStatus.RUNNING
        campaign.update_metadata()
    elif had_local_thread and not is_running and campaign.metadata["status"] == CampaignStatus.RUNNING:
        campaign.metadata["status"] = CampaignStatus.IDLE
        campaign.update_metadata()

    return is_running


# -----------------
# Jinja filters
# -----------------
@app.template_filter("ctime")
def timectime(timestamp):
    try:
        s = datetime.datetime.fromtimestamp(timestamp)
        return s.strftime("%Y-%m-%d %H:%M:%S")
    except:
        return timestamp


@app.template_filter("elapsed")
def time_elapsed(batch):
    start_timestamp = batch["start"]
    end_timestamp = batch["end"]
    try:
        if end_timestamp:
            s = datetime.datetime.fromtimestamp(start_timestamp)
            e = datetime.datetime.fromtimestamp(end_timestamp)
            diff = str(e - s)
            return diff.split(".")[0]
        else:

            s = datetime.datetime.fromtimestamp(start_timestamp)
            diff = str(datetime.datetime.now() - s)
            return diff.split(".")[0]
    except:
        return ""


@app.template_filter("annotate_url")
def annotate_url(current_url):
    # get the base url (without any "browse", "crowdsourcing" or "crowdsourcing/campaign" in it)
    parsed = urllib.parse.urlparse(current_url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"
    host_prefix = app.config["host_prefix"]
    return f"{base_url}{host_prefix}/annotate"


@app.template_filter("prettify_json")
def prettify_json(value):
    return json.dumps(value, sort_keys=True, indent=4, separators=(",", ": "), ensure_ascii=False)


# -----------------
# Decorators
# -----------------
# Very simple decorator to protect routes


def is_browse_public():
    return not app.config["login"].get("lock_view_pages", True)


def is_analyze_public():
    return app.config["login"].get("show_analyze_without_login", True)


def is_annotator_name_toggle_public():
    return app.config["login"].get("show_annotator_names_toggle_without_login", False)


def has_public_view_pages():
    return is_browse_public() or is_analyze_public()


def is_view_allowed(path):
    if path == "/":
        return has_public_view_pages()

    if path.startswith("/browse"):
        return is_browse_public()

    if path.startswith("/analyze"):
        return is_analyze_public()

    if path.startswith("/query"):
        return is_browse_public() or is_analyze_public()

    # and lock the rest of pages
    return False


def login_required(f):
    def wrapper(*args, **kwargs):
        # the browse/analyze pages are allowed without login
        if app.config["login"]["active"] and not is_view_allowed(request.path):
            auth = request.cookies.get("auth")
            if not auth:
                return redirect(app.config["host_prefix"] + "/login")
            username, password = auth.split(":")
            if not utils.check_login(app, username, password):
                return redirect(app.config["host_prefix"] + "/login")

        return f(*args, **kwargs)

    wrapper.__name__ = f.__name__
    return wrapper


def _is_authenticated_viewer():
    if not app.config["login"].get("active", False):
        return True

    auth = request.cookies.get("auth")
    if not auth:
        return False

    parts = auth.split(":", 1)
    if len(parts) != 2:
        return False

    return utils.check_login(app, parts[0], parts[1])


def _filter_datasets_for_viewer(datasets, is_authenticated):
    if is_authenticated:
        return datasets

    return {k: v for k, v in datasets.items() if not v.get("hidden_from_regular_users", False)}


def _get_campaign_dataset_ids(campaign_data):
    return {slugify(str(row.get("dataset"))) for row in campaign_data if row.get("dataset")}


def _filter_campaigns_for_viewer(campaigns, visible_dataset_ids):
    filtered = {}

    for campaign_id, campaign in campaigns.items():
        if campaign["metadata"].get("hidden_from_regular_users", False):
            continue

        campaign_dataset_ids = _get_campaign_dataset_ids(campaign.get("data", []))
        if campaign_dataset_ids and not campaign_dataset_ids.issubset(visible_dataset_ids):
            continue
        filtered[campaign_id] = campaign

    return filtered


def _get_visible_query_scope():
    is_authenticated = _is_authenticated_viewer()
    datasets = workflows.get_local_dataset_overview(app)
    datasets = {k: v for k, v in datasets.items() if v["enabled"]}
    visible_datasets = _filter_datasets_for_viewer(datasets, is_authenticated=is_authenticated)
    campaigns = workflows.get_sorted_campaign_list(
        app, modes=[CampaignMode.CROWDSOURCING, CampaignMode.LLM_EVAL, CampaignMode.EXTERNAL]
    )
    if not is_authenticated:
        campaigns = _filter_campaigns_for_viewer(campaigns, visible_dataset_ids=set(visible_datasets.keys()))
    return set(campaigns.keys()), set(visible_datasets.keys())


def _get_query_tables():
    workflows.refresh_indexes(app)
    visible_campaign_ids, visible_dataset_ids = _get_visible_query_scope()
    return querying.build_query_tables(
        app,
        visible_campaign_ids=visible_campaign_ids,
        visible_dataset_ids=visible_dataset_ids,
    )


def _campaign_pseudonymizes_annotators(campaign_id):
    try:
        campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    except Exception:
        return True
    return campaign.metadata.get("config", {}).get("pseudonymize_annotators", True) is not False


def _can_reveal_campaign_annotator_ids(campaign_id, is_authenticated):
    return bool(is_authenticated or not _campaign_pseudonymizes_annotators(campaign_id))


def _has_public_annotator_name_campaign(visible_dataset_ids):
    campaigns = workflows.get_sorted_campaign_list(
        app, modes=[CampaignMode.CROWDSOURCING, CampaignMode.LLM_EVAL, CampaignMode.EXTERNAL]
    )
    campaigns = _filter_campaigns_for_viewer(campaigns, visible_dataset_ids=set(visible_dataset_ids))
    return any(not _campaign_pseudonymizes_annotators(campaign_id) for campaign_id in campaigns)


# -----------------
# Flask endpoints
# -----------------
@app.route("/", methods=["GET", "POST"])
@login_required
def index():
    logger.info(f"Main page loaded")

    login_active = app.config["login"]["active"]
    browse_public = is_browse_public()
    analyze_public = is_analyze_public()
    has_public_pages = has_public_view_pages()

    return render_template(
        "pages/index.html",
        host_prefix=app.config["host_prefix"],
        dim_browse_page=login_active and has_public_pages and not browse_public,
        dim_analyze_page=login_active and has_public_pages and not analyze_public,
        dim_manage_pages=login_active and has_public_pages,
    )


@app.route("/analyze", methods=["GET", "POST"])
@login_required
def analyze():
    campaigns = workflows.get_sorted_campaign_list(
        app, modes=[CampaignMode.CROWDSOURCING, CampaignMode.LLM_EVAL, CampaignMode.EXTERNAL]
    )
    is_authenticated = _is_authenticated_viewer()

    if not is_authenticated:
        datasets = workflows.get_local_dataset_overview(app)
        datasets = {k: v for k, v in datasets.items() if v["enabled"]}
        datasets = _filter_datasets_for_viewer(datasets, is_authenticated=is_authenticated)
        campaigns = _filter_campaigns_for_viewer(campaigns, visible_dataset_ids=set(datasets.keys()))

    return render_template(
        "pages/analyze.html",
        campaigns=campaigns,
        is_authenticated=is_authenticated,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/analyze/detail/<campaign_id>", methods=["GET", "POST"])
@login_required
def analyze_detail(campaign_id):
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    is_authenticated = _is_authenticated_viewer()

    if not is_authenticated:
        if campaign.metadata.get("hidden_from_regular_users", False):
            return redirect(app.config["host_prefix"] + "/analyze")

        datasets = workflows.get_local_dataset_overview(app)
        datasets = {k: v for k, v in datasets.items() if v["enabled"]}
        datasets = _filter_datasets_for_viewer(datasets, is_authenticated=is_authenticated)
        visible_dataset_ids = set(datasets.keys())
        campaign_dataset_ids = _get_campaign_dataset_ids(workflows.get_campaign_data(campaign))
        if campaign_dataset_ids and not campaign_dataset_ids.issubset(visible_dataset_ids):
            return redirect(app.config["host_prefix"] + "/analyze")

    show_real_annotator_names = _can_reveal_campaign_annotator_ids(campaign_id, is_authenticated)
    rag_mistake_setup_id = request.args.get("summary_setup_id")
    rag_mistake_span_category = request.args.get("summary_span_category")
    active_stats_tab = request.args.get("tab")
    if active_stats_tab not in {"spans", "summaries", "sliders", "annotators", "coverage"}:
        active_stats_tab = "summaries" if (rag_mistake_setup_id or rag_mistake_span_category) else "spans"

    statistics = analysis.compute_statistics(
        app,
        campaign,
        show_real_annotator_names=show_real_annotator_names,
        rag_mistake_setup_id=rag_mistake_setup_id,
        rag_mistake_span_category=rag_mistake_span_category,
    )

    return render_template(
        "pages/analyze_detail.html",
        statistics=statistics,
        campaign=campaign,
        is_authenticated=is_authenticated,
        show_real_annotator_names=show_real_annotator_names,
        active_stats_tab=active_stats_tab,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/annotate/<campaign_id>", methods=["GET", "POST"])
def annotate(campaign_id):
    workflows.refresh_indexes(app)

    # only for preview purposes, batch index is otherwise randomly generated
    batch_idx = request.args.get("batch_idx", None)
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)

    service = campaign.metadata["config"]["service"]
    raw_annotator_id = request.args.get("annotatorId")
    service_ids = crowdsourcing.get_service_ids(service, request.args)
    template_annotator_id = service_ids["annotator_id"]
    needs_annotator_auth = False

    if service == "local":
        missing_local_annotator = (
            not raw_annotator_id or raw_annotator_id.strip() == "" or raw_annotator_id.strip() == "FILL_YOUR_NAME_HERE"
        )
        if missing_local_annotator and (batch_idx is None or batch_idx == ""):
            # Keep the annotator ID empty so the auth modal can prompt for
            # registration/login on direct links without an explicit id.
            # We intentionally avoid loading a batch here so the page behind
            # the modal stays on instructions until the user identifies themself.
            service_ids["annotator_id"] = ""
            template_annotator_id = ""
            needs_annotator_auth = True

    metadata = campaign.metadata
    annotator_preferences = {"hide_instructions_next_time": False}
    normalized_annotator_id = _normalize_annotator_id(template_annotator_id)
    if normalized_annotator_id and normalized_annotator_id != PREVIEW_STUDY_ID:
        existing = _find_existing_annotator(_load_annotator_registry(campaign_id), normalized_annotator_id)
        if existing:
            annotator_preferences["hide_instructions_next_time"] = existing.get("hide_instructions_next_time", False)
    if needs_annotator_auth:
        annotation_set = []
        redo_context = {
            "mode": "normal",
            "is_redo": False,
            "empty_redo_fallback": False,
            "show_completed": False,
            "needs_auth": True,
        }
    else:
        show_completed_redo = request.args.get("show_completed_redo") == "1" or request.args.get("redo_review") == "1"
        show_saved_examples = request.args.get("show_saved_items") == "1" or request.args.get("saved_review") == "1"
        annotation_set, redo_context = crowdsourcing.get_annotator_batch(
            app,
            campaign,
            service_ids,
            batch_idx=batch_idx,
            include_completed_redo=show_completed_redo,
            include_saved_examples=show_saved_examples,
            return_context=True,
        )

    if needs_annotator_auth:
        return render_template(
            "crowdsourcing/annotate_auth.html",
            host_prefix=app.config["host_prefix"],
            campaign=campaign,
            campaign_id=campaign.campaign_id,
            auth_redirect_template=_build_auth_redirect_template(app.config["host_prefix"], campaign.campaign_id),
        )

    if not annotation_set:
        # no more available examples
        return render_template(
            "crowdsourcing/closed.html",
            host_prefix=app.config["host_prefix"],
            redo_context=redo_context,
        )

    crowdsourcing.ensure_crowdsourcing_page_current(campaign.campaign_id, metadata["config"])

    return utils.render_from_folder(
        f"annotate.html",
        custom_folder=f"{PACKAGE_DIR}/campaigns/{campaign.campaign_id}/pages",
        host_prefix=app.config["host_prefix"],
        annotation_set=annotation_set,
        annotator_id=template_annotator_id,
        annotator_preferences=annotator_preferences,
        metadata=metadata,
        redo_context=redo_context,
    )


def _annotator_registry_path(campaign_id):
    return os.path.join(CAMPAIGN_DIR, campaign_id, "annotators.json")


def _normalize_annotator_id(value):
    if value is None:
        return ""
    try:
        if isnan(value):
            return ""
    except (TypeError, ValueError):
        pass
    text = str(value).strip()
    if not text or text.lower() in {"nan", "<na>"}:
        return ""
    text = re.sub(r"\s+", "_", text)
    text = text.replace("/", "_").replace("\\", "_")
    return text


def _city_alias_from_index(index):
    if index < 0:
        index = 0
    base_index = index % len(ANNOTATOR_PSEUDONYM_CITIES)
    suffix_index = (index // len(ANNOTATOR_PSEUDONYM_CITIES)) + 1
    alias = ANNOTATOR_PSEUDONYM_CITIES[base_index]
    if suffix_index > 1:
        alias = f"{alias} {suffix_index}"
    return alias


def _next_available_alias(used_aliases):
    index = 0
    while True:
        alias = _city_alias_from_index(index)
        if alias not in used_aliases:
            return alias
        index += 1


def _normalize_annotator_records(records):
    normalized = []
    seen_ids = set()
    used_aliases = set()

    for record in records:
        annotator_id = ""
        alias = ""
        if isinstance(record, dict):
            annotator_id = _normalize_annotator_id(record.get("id"))
            alias = str(record.get("alias", "")).strip()
        else:
            annotator_id = _normalize_annotator_id(record)

        if not annotator_id:
            continue

        key = annotator_id.lower()
        if key in seen_ids:
            continue

        if not alias or alias in used_aliases:
            alias = _next_available_alias(used_aliases)
        hide_instructions_next_time = False
        if isinstance(record, dict):
            hide_instructions_next_time = bool(record.get("hide_instructions_next_time", False))

        normalized.append(
            {
                "id": annotator_id,
                "alias": alias,
                "hide_instructions_next_time": hide_instructions_next_time,
            }
        )
        seen_ids.add(key)
        used_aliases.add(alias)

    return normalized


def _build_auth_redirect_template(host_prefix, campaign_id):
    return f"{host_prefix}/annotate/{campaign_id}?annotatorId=__ANNOTATOR__"


def _load_annotator_registry(campaign_id):
    path = _annotator_registry_path(campaign_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            data = json.load(f)

        if isinstance(data, list):
            # Legacy format: list of annotator IDs.
            return _normalize_annotator_records(data)

        if isinstance(data, dict) and isinstance(data.get("annotators"), list):
            return _normalize_annotator_records(data.get("annotators"))
    except Exception:
        logger.warning(f"Failed to read annotator registry for {campaign_id}")
    return []


def _save_annotator_registry(campaign_id, records):
    path = _annotator_registry_path(campaign_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    normalized = _normalize_annotator_records(records)
    normalized.sort(key=lambda x: x["id"].lower())
    with open(path, "w") as f:
        json.dump({"annotators": normalized}, f, indent=2, ensure_ascii=False)


def _find_existing_annotator(records, candidate):
    candidate_norm = candidate.lower()
    for existing in records:
        if existing["id"].lower() == candidate_norm:
            return existing
    return None


def _annotator_alias_map(campaign_id):
    records = _load_annotator_registry(campaign_id)
    return {record["id"].lower(): record["alias"] for record in records}


def _attach_annotation_aliases(example_data):
    generated_outputs = example_data.get("generated_outputs")
    if not isinstance(generated_outputs, list):
        return

    alias_cache = {}
    for output in generated_outputs:
        annotations = output.get("annotations", [])
        if not isinstance(annotations, list):
            continue
        for annotation in annotations:
            campaign_id = annotation.get("campaign_id")
            annotator_id = _normalize_annotator_id(annotation.get("annotator_id"))
            if not campaign_id or not annotator_id:
                continue

            if campaign_id not in alias_cache:
                alias_cache[campaign_id] = _annotator_alias_map(campaign_id)

            alias = alias_cache[campaign_id].get(annotator_id.lower()) or querying._fallback_alias(campaign_id, annotator_id)
            annotation["annotator_alias"] = alias


def _sanitize_example_annotator_ids(example_data, is_authenticated):
    generated_outputs = example_data.get("generated_outputs")
    if not isinstance(generated_outputs, list):
        return

    for output in generated_outputs:
        annotations = output.get("annotations", [])
        if not isinstance(annotations, list):
            continue
        for annotation in annotations:
            campaign_id = annotation.get("campaign_id")
            if not _can_reveal_campaign_annotator_ids(campaign_id, is_authenticated):
                annotation.pop("annotator_id", None)


@app.route("/annotator/exists", methods=["GET"])
def annotator_exists():
    campaign_id = request.args.get("campaign_id")
    annotator_id = _normalize_annotator_id(request.args.get("annotator_id"))

    if not campaign_id or not annotator_id:
        return jsonify(success=True, exists=False)

    annotators = _load_annotator_registry(campaign_id)
    existing = _find_existing_annotator(annotators, annotator_id)
    return jsonify(
        success=True,
        exists=existing is not None,
        annotator_id=(existing["id"] if existing else annotator_id),
        annotator_alias=(existing["alias"] if existing else None),
        hide_instructions_next_time=(existing.get("hide_instructions_next_time", False) if existing else False),
    )


@app.route("/annotator/register", methods=["POST"])
def annotator_register():
    data = request.get_json() or {}
    campaign_id = data.get("campaign_id")
    annotator_id = _normalize_annotator_id(data.get("annotator_id"))
    hide_instructions_next_time = bool(data.get("hide_instructions_next_time", False))

    if not campaign_id or not annotator_id:
        return utils.error("Missing campaign_id or annotator_id")

    if annotator_id in [PREVIEW_STUDY_ID, "FILL_YOUR_NAME_HERE"]:
        return utils.error("Invalid annotator ID")

    annotators = _load_annotator_registry(campaign_id)
    existing = _find_existing_annotator(annotators, annotator_id)
    if existing:
        return utils.error("This annotator name already exists. Please use Login instead.")

    used_aliases = {record["alias"] for record in annotators}
    alias = _next_available_alias(used_aliases)
    annotators.append(
        {
            "id": annotator_id,
            "alias": alias,
            "hide_instructions_next_time": hide_instructions_next_time,
        }
    )
    _save_annotator_registry(campaign_id, annotators)
    return jsonify(
        success=True,
        annotator_id=annotator_id,
        annotator_alias=alias,
        exists=False,
        hide_instructions_next_time=hide_instructions_next_time,
    )


@app.route("/annotator/login", methods=["POST"])
def annotator_login():
    data = request.get_json() or {}
    campaign_id = data.get("campaign_id")
    annotator_id = _normalize_annotator_id(data.get("annotator_id"))

    if not campaign_id or not annotator_id:
        return utils.error("Missing campaign_id or annotator_id")

    annotators = _load_annotator_registry(campaign_id)
    existing = _find_existing_annotator(annotators, annotator_id)
    if not existing:
        return utils.error("Annotator not found. Please register first.")

    return jsonify(
        success=True,
        annotator_id=existing["id"],
        annotator_alias=existing["alias"],
        hide_instructions_next_time=existing.get("hide_instructions_next_time", False),
    )


@app.route("/annotator/update_preferences", methods=["POST"])
def annotator_update_preferences():
    data = request.get_json() or {}
    campaign_id = data.get("campaign_id")
    annotator_id = _normalize_annotator_id(data.get("annotator_id"))

    if not campaign_id or not annotator_id:
        return utils.error("Missing campaign_id or annotator_id")

    annotators = _load_annotator_registry(campaign_id)
    existing = _find_existing_annotator(annotators, annotator_id)
    if not existing:
        return utils.error("Annotator not found.")

    existing["hide_instructions_next_time"] = bool(data.get("hide_instructions_next_time", False))
    _save_annotator_registry(campaign_id, annotators)

    return jsonify(
        success=True,
        annotator_id=existing["id"],
        hide_instructions_next_time=existing["hide_instructions_next_time"],
    )

@app.route("/app_config", methods=["GET"])
@login_required
def app_config():
    return render_template(
        "pages/app_config.html",
        app_config=app.config,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/browse", methods=["GET", "POST"])
@login_required
def browse():
    dataset_id = request.args.get("dataset")
    split = request.args.get("split")
    example_idx = request.args.get("example_idx")
    setup_id = request.args.get("setup_id")
    ann_campaign = request.args.get("ann_campaign")
    is_authenticated = _is_authenticated_viewer()

    workflows.refresh_indexes(app)
    datasets = workflows.get_local_dataset_overview(app)
    datasets = {k: v for k, v in datasets.items() if v["enabled"]}
    visible_datasets = _filter_datasets_for_viewer(datasets, is_authenticated=is_authenticated)
    show_annotator_toggle = is_authenticated or _has_public_annotator_name_campaign(visible_datasets.keys())

    browse_access_error = None
    response_status = 200

    if dataset_id and split and example_idx and dataset_id in visible_datasets:
        display_example = {"dataset": dataset_id, "split": split, "example_idx": int(example_idx)}
        logger.info(f"Serving permalink {dataset_id} / {split} / {example_idx}")
    else:
        display_example = None
        if dataset_id and split and example_idx:
            requested_dataset = datasets.get(dataset_id)
            if requested_dataset and not is_authenticated and requested_dataset.get("hidden_from_regular_users", False):
                browse_access_error = (
                    "The requested dataset is hidden. Please sign in to access it. "
                    "Redirected to an available dataset."
                )
                response_status = 403
                logger.info(f"Blocked hidden dataset permalink for anonymous viewer: {dataset_id} / {split} / {example_idx}")
            elif requested_dataset is None:
                browse_access_error = "The requested dataset does not exist or is not enabled."
                response_status = 404

    if not visible_datasets:
        return render_template(
            "pages/no_datasets.html",
            host_prefix=app.config["host_prefix"],
        )
    return (
        render_template(
            "pages/browse.html",
            display_example=display_example,
            browse_access_error=browse_access_error,
            highlight_setup_id=setup_id,
            highlight_ann_campaign=ann_campaign,
            datasets=visible_datasets,
            show_annotator_toggle=show_annotator_toggle,
            host_prefix=app.config["host_prefix"],
        ),
        response_status,
    )


@app.route("/query/schema", methods=["GET"])
@login_required
def query_schema():
    is_authenticated = _is_authenticated_viewer()
    dataset = str(request.args.get("dataset") or "").strip()
    split = str(request.args.get("split") or "").strip()
    tables = _get_query_tables()
    scoped_tables = querying.scope_tables(
        tables,
        datasets=[dataset] if dataset else None,
        splits=[split] if split else None,
    )
    return jsonify(success=True, **querying.schema_payload(scoped_tables, authenticated=is_authenticated))


@app.route("/query/filter", methods=["POST"])
@login_required
def query_filter():
    is_authenticated = _is_authenticated_viewer()
    data = request.get_json() or {}
    dataset = str(data.get("dataset") or "").strip()
    split = str(data.get("split") or "").strip()
    filters = data.get("filters") or {}
    limit = int(data.get("limit") or 500)
    tables = querying.scope_tables(
        _get_query_tables(),
        datasets=[dataset] if dataset else None,
        splits=[split] if split else None,
    )
    try:
        rows = querying.apply_condition_filter(tables, filters, authenticated=is_authenticated)
    except querying.QueryFilterError as exc:
        return utils.error(str(exc))
    payload = querying.table_payload(rows, limit=limit, authenticated=is_authenticated)
    return jsonify(success=True, **payload)


@app.route("/clear_campaign", methods=["POST"])
@login_required
def clear_campaign():
    data = request.get_json()
    campaign_id = data.get("campaignId")

    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    campaign.clear_all_outputs()

    return utils.success()


@app.route("/clear_output", methods=["GET", "POST"])
@login_required
def clear_output():
    data = request.get_json()
    campaign_id = data.get("campaignId")
    idx = int(data.get("idx"))

    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    campaign.clear_output(idx)

    return utils.success()


@app.route("/crowdsourcing", methods=["GET", "POST"])
@login_required
def crowdsourcing_page():
    llm_configs = workflows.load_configs(mode=CampaignMode.LLM_EVAL)
    crowdsourcing_configs = workflows.load_configs(mode=CampaignMode.CROWDSOURCING)
    campaigns = workflows.get_sorted_campaign_list(app, modes=[CampaignMode.CROWDSOURCING])

    return render_template(
        "pages/crowdsourcing.html",
        campaigns=campaigns,
        llm_configs=llm_configs,
        crowdsourcing_configs=crowdsourcing_configs,
        is_password_protected=app.config["login"]["active"],
        host_prefix=app.config["host_prefix"],
    )


@app.route("/crowdsourcing/detail/<campaign_id>", methods=["GET", "POST"])
@login_required
def crowdsourcing_detail(campaign_id):
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    overview = campaign.get_overview()
    stats = campaign.get_stats()
    redo_admin = redo.build_admin_overview(campaign, _annotator_alias_map(campaign_id))

    return render_template(
        "pages/crowdsourcing_detail.html",
        mode=CampaignMode.CROWDSOURCING,
        campaign_id=campaign_id,
        overview=overview,
        stats=stats,
        metadata=campaign.metadata,
        redo_admin=redo_admin,
        host_prefix=app.config["host_prefix"],
    )


def _download_json(payload, filename):
    response = make_response(json.dumps(payload, indent=2, ensure_ascii=False))
    response.headers["Content-Type"] = "application/json; charset=utf-8"
    response.headers["Content-Disposition"] = f"attachment; filename={filename}"
    return response


def _download_csv(rows, filename):
    response = make_response(redo.rows_to_csv(rows))
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = f"attachment; filename={filename}"
    return response


@app.route("/redo/<campaign_id>/queue.json", methods=["GET"])
@login_required
def redo_queue_json(campaign_id):
    return _download_json(redo.load_queue(campaign_id), f"{campaign_id}-redo-queue.json")


@app.route("/redo/<campaign_id>/queue.csv", methods=["GET"])
@login_required
def redo_queue_csv(campaign_id):
    return _download_csv(redo.load_queue(campaign_id).get("items", []), f"{campaign_id}-redo-queue.csv")


@app.route("/redo/<campaign_id>/revisions.json", methods=["GET"])
@login_required
def redo_revisions_json(campaign_id):
    return _download_json(redo.load_revision_log(campaign_id), f"{campaign_id}-redo-revisions.json")


@app.route("/redo/<campaign_id>/revisions.csv", methods=["GET"])
@login_required
def redo_revisions_csv(campaign_id):
    return _download_csv(redo.load_revision_log(campaign_id), f"{campaign_id}-redo-revisions.csv")


@app.route("/redo/<campaign_id>/filter_data", methods=["GET"])
@login_required
def redo_filter_data(campaign_id):
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    return jsonify(success=True, **redo.build_admin_filter_result(campaign))


@app.route("/redo/<campaign_id>/filter", methods=["POST"])
@login_required
def redo_filter(campaign_id):
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    data = request.get_json() or {}
    try:
        payload = redo.build_admin_filter_result(
            campaign,
            filters=data.get("filters") or {},
            annotator_id=data.get("annotatorId") or "",
        )
    except querying.QueryFilterError as exc:
        return utils.error(str(exc))
    return jsonify(success=True, **payload)


@app.route("/redo/<campaign_id>/items", methods=["POST"])
@login_required
def redo_add_items(campaign_id):
    data = request.get_json() or {}
    include_skipped = bool(data.get("includeSkipped", False))
    include_completed = bool(data.get("includeCompleted", False))
    instruction = data.get("instruction") or None
    rows = data.get("items", [])
    queue = redo.load_queue(campaign_id)
    active_queue_by_key = {
        redo.item_key(item): item
        for item in queue.get("items", [])
        if item.get("status") != redo.STATUS_CANCELLED
    }

    selected_rows = []
    for row in rows:
        item = redo.row_to_item(campaign_id, row, annotator_id=row.get("annotator_id"))
        active_record = redo.latest_active_record(campaign_id, item)
        if not include_skipped and active_record and redo.is_skip_selected(active_record.get("flags", [])):
            continue
        existing = active_queue_by_key.get(redo.item_key(item))
        if not include_completed and existing and existing.get("status") == redo.STATUS_COMPLETED:
            continue
        selected_rows.append(row)

    result = redo.add_items(
        campaign_id,
        selected_rows,
        created_by="admin",
        instruction=instruction,
        source={"type": "manual", "selector": data.get("selector", "example")},
    )
    return jsonify(
        success=True,
        added=len(result["added"]),
        reused=len(result["reused"]),
    )


@app.route("/redo/<campaign_id>/items/cancel", methods=["POST"])
@login_required
def redo_cancel_items(campaign_id):
    data = request.get_json() or {}
    cancelled = redo.cancel_items(campaign_id, data.get("redo_ids", []))
    return jsonify(success=True, cancelled=len(cancelled))


@app.route("/redo/<campaign_id>/items/restore_original", methods=["POST"])
@login_required
def redo_restore_original_items(campaign_id):
    data = request.get_json() or {}
    result = redo.restore_original_annotations(campaign_id, data.get("redo_ids", []), restored_by="admin")
    if result["restored"]:
        campaign = workflows.load_campaign(app, campaign_id=campaign_id)
        campaign.load_db()
        db = campaign.db
        for item in result["restored"]:
            original_revision = redo.find_original_revision(campaign_id, item.get("redo_id"))
            record = original_revision.get("record", {}) if original_revision else {}
            metadata = record.get("metadata", {})
            mask = (
                (db["dataset"].astype(str) == str(item["dataset"]))
                & (db["split"].astype(str) == str(item["split"]))
                & (db["setup_id"].astype(str) == str(item["setup_id"]))
                & (db["example_idx"].astype(int) == int(item["example_idx"]))
                & (db["annotator_group"].astype(int) == int(item.get("annotator_group", 0)))
                & (db["annotator_id"].fillna("").astype(str) == str(item.get("annotator_id")))
            )
            if mask.sum() == 1:
                db.loc[mask, "status"] = ExampleStatus.FINISHED
                restored_end = metadata.get("end_timestamp")
                if restored_end:
                    db.loc[mask, "end"] = restored_end
        campaign.update_db(db)
        workflows.refresh_indexes(app)
    return jsonify(success=True, restored=len(result["restored"]), errors=result["errors"])


@app.route("/redo/save_item", methods=["POST"])
def redo_save_item():
    data = request.get_json() or {}
    return crowdsourcing.save_redo_annotation(
        app,
        data.get("campaign_id"),
        data.get("redo_id"),
        data.get("annotation"),
        data.get("annotator_id"),
    )


@app.route("/redo/keep_item", methods=["POST"])
def redo_keep_item():
    data = request.get_json() or {}
    return crowdsourcing.keep_redo_annotation(
        app,
        data.get("campaign_id"),
        data.get("redo_id"),
        data.get("annotator_id"),
    )


@app.route("/save_annotation_item", methods=["POST"])
def save_annotation_item():
    data = request.get_json() or {}
    return crowdsourcing.save_annotation_item(
        app,
        data.get("campaign_id"),
        data.get("annotation"),
        data.get("annotator_id"),
    )


@app.route("/crowdsourcing/create", methods=["POST"])
@login_required
def crowdsourcing_create():
    data = request.get_json()

    campaign_id = slugify(data.get("campaignId"))
    campaign_data = data.get("campaignData")
    config = data.get("config")

    config = crowdsourcing.parse_crowdsourcing_config(config)

    try:
        crowdsourcing.create_crowdsourcing_campaign(app, campaign_id, config, campaign_data)
        workflows.load_campaign(app, campaign_id=campaign_id)
    except Exception as e:
        traceback.print_exc()
        return utils.error(f"Error while creating campaign: {e}")

    return utils.success()


@app.route("/crowdsourcing/new", methods=["GET", "POST"])
@login_required
def crowdsourcing_new():
    datasets = workflows.get_local_dataset_overview(app)
    datasets = {k: v for k, v in datasets.items() if v["enabled"]}

    available_data = workflows.get_model_outputs_overview(app, datasets)
    configs = workflows.load_configs(mode=CampaignMode.CROWDSOURCING)
    default_prompts = utils.load_default_prompts()

    default_campaign_id = workflows.generate_default_id(app=app, mode=CampaignMode.CROWDSOURCING, prefix="campaign")

    return render_template(
        "pages/crowdsourcing_new.html",
        default_campaign_id=default_campaign_id,
        default_prompts=default_prompts,
        datasets=datasets,
        available_data=available_data,
        configs=configs,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/delete_campaign", methods=["POST"])
@login_required
def delete_campaign():
    data = request.get_json()
    campaign_id = data.get("campaignId")

    shutil.rmtree(os.path.join(CAMPAIGN_DIR, campaign_id))
    symlink_dir = os.path.join(TEMPLATES_DIR, "campaigns", campaign_id)

    if os.path.exists(symlink_dir):
        shutil.rmtree(symlink_dir)

    return utils.success()


@app.route("/delete_dataset", methods=["POST"])
@login_required
def delete_dataset():
    data = request.get_json()
    dataset_id = data.get("datasetId")
    workflows.delete_dataset(app, dataset_id)

    return utils.success()


@app.route("/delete_model_outputs", methods=["POST"])
@login_required
def delete_model_outputs():
    data = request.get_json()

    # get dataset, split, setup
    dataset_id = data.get("dataset")
    split = data.get("split")
    setup_id = data.get("setup_id")

    dataset = app.db["datasets_obj"][dataset_id]
    workflows.delete_model_outputs(dataset, split, setup_id)

    return utils.success()


@app.route("/download_dataset", methods=["POST"])
@login_required
def download_dataset():
    data = request.get_json()
    dataset_id = data.get("datasetId")

    try:
        workflows.download_dataset(app, dataset_id)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": f"Error while downloading dataset: {e.__class__.__name__}: {e}"})

    return utils.success()


@app.route("/duplicate_config", methods=["POST"])
def duplicate_config():
    data = request.get_json()
    filename = data.get("filename")
    mode_from = data.get("modeFrom")
    mode_to = data.get("modeTo")
    campaign_id = data.get("campaignId")

    campaign_index = workflows.generate_campaign_index(app, force_reload=False)

    if mode_from == mode_to:
        campaign = campaign_index[campaign_id]
        config = campaign.metadata["config"]
    else:
        # currently we only support copying the annotation_span_categories between modes
        campaign = campaign_index[campaign_id]
        llm_config = campaign.metadata["config"]
        config = {"annotation_span_categories": llm_config["annotation_span_categories"]}

    utils.save_config(filename, config, mode=mode_to)

    return utils.success()


@app.route("/duplicate_eval", methods=["POST"])
def duplicate_eval():
    data = request.get_json()
    mode = data.get("mode")
    campaign_id = data.get("campaignId")
    new_campaign_id = slugify(data.get("newCampaignId"))

    ret = llm_campaign.duplicate_llm_campaign(app, mode, campaign_id, new_campaign_id)

    return ret


def sanitize_json(json_val):
    if isinstance(json_val, dict):
        return {k: sanitize_json(v) for k, v in json_val.items()}
    elif isinstance(json_val, list):
        return [sanitize_json(v) for v in json_val]
    elif isinstance(json_val, float) and isnan(json_val):
        return None
    else:
        return json_val


@app.route("/example", methods=["GET", "POST"])
def render_example():
    dataset_id = request.args.get("dataset")
    split = request.args.get("split")
    example_idx = max(int(request.args.get("example_idx")), 0)
    setup_id = request.args.get("setup_id", None)
    request_mode = request.args.get("mode")

    if split in (None, "", "null", "undefined"):
        dataset = workflows.get_dataset(app, dataset_id)
        if dataset is not None and getattr(dataset, "splits", None):
            split = dataset.splits[0]

    if request_mode != "annotate" and not _is_authenticated_viewer():
        dataset_config = utils.load_dataset_config().get(slugify(dataset_id))
        if dataset_config and dataset_config.get("hidden_from_regular_users", False):
            return utils.error("Dataset is not available.")

    try:
        example_data = workflows.get_example_data(app, dataset_id, split, example_idx, setup_id)
        is_authenticated = _is_authenticated_viewer()
        _attach_annotation_aliases(example_data)
        _sanitize_example_annotator_ids(example_data, is_authenticated=is_authenticated)
        example_data = sanitize_json(example_data)
        return jsonify(example_data)
    except Exception as e:
        print("EXCEPT")
        traceback.print_exc()
        logger.error(f"Error while getting example data: {e}")
        logger.error(f"{dataset_id=}, {split=}, {example_idx=}")
        return utils.error(
            f"Error\n\t{e.__class__.__name__}: {e}\nwhile getting example data: {dataset_id=}, {split=}, {example_idx=}"
        )


@app.route("/export_campaign_outputs/<campaign_id>", methods=["GET", "POST"])
@login_required
def export_campaign_outputs(campaign_id):
    return workflows.export_campaign_outputs(campaign_id)


@app.route("/export_dataset", methods=["POST", "GET"])
@login_required
def export_dataset():
    dataset_id = request.args.get("dataset_id")

    return workflows.export_dataset(app, dataset_id)


@app.route("/export_outputs", methods=["POST", "GET"])
@login_required
def export_outputs():
    dataset_id = request.args.get("dataset")
    split = request.args.get("split")
    setup_id = request.args.get("setup_id")

    return workflows.export_outputs(app, dataset_id, split, setup_id)


@app.route("/files/<path:filename>", methods=["GET", "POST"])
def download_file(filename):
    # serving external files for datasets
    return send_from_directory(INPUT_DIR, filename)


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form["username"]
        password = request.form["password"]
        if utils.check_login(app, username, password):
            # redirect to the home page ("/")
            resp = make_response(redirect(app.config["host_prefix"] + "/"))
            resp.set_cookie("auth", f"{username}:{password}", path="/")
            return resp
        else:
            return "Login failed", 401
    return render_template("pages/login.html", host_prefix=app.config["host_prefix"])


@app.route("/logout", methods=["GET"])
def logout():
    resp = make_response(redirect(app.config["host_prefix"] + "/"))
    resp.set_cookie("auth", "", expires=0, path="/")
    return resp


@app.route("/llm_eval", methods=["GET", "POST"])
@app.route("/llm_gen", methods=["GET", "POST"])
@login_required
def llm_campaign_page():
    mode = utils.get_mode_from_path(request.path)

    campaigns = workflows.get_sorted_campaign_list(app, modes=[mode])
    for campaign_id, campaign_info in campaigns.items():
        campaign = workflows.load_campaign(app, campaign_id=campaign_id)
        if campaign is None:
            continue
        reconcile_llm_campaign_runtime_state(app, campaign)
        campaign_info["metadata"] = campaign.metadata
        campaign_info["stats"] = campaign.get_stats()

    llm_configs = workflows.load_configs(mode=mode)
    crowdsourcing_configs = workflows.load_configs(mode=CampaignMode.CROWDSOURCING)

    return render_template(
        f"pages/llm_campaign.html",
        mode=mode,
        llm_configs=llm_configs,
        crowdsourcing_configs=crowdsourcing_configs,
        campaigns=campaigns,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/llm_eval/create", methods=["GET", "POST"])
@app.route("/llm_gen/create", methods=["GET", "POST"])
@login_required
def llm_campaign_create():
    mode = utils.get_mode_from_path(request.path)
    data = request.get_json()

    campaign_id = slugify(data.get("campaignId"))
    campaign_data = data.get("campaignData")
    config = data.get("config")

    if mode == CampaignMode.LLM_EVAL:
        config = llm_campaign.parse_llm_eval_config(config)
    elif mode == CampaignMode.LLM_GEN:
        config = llm_campaign.parse_llm_gen_config(config)

    datasets = app.db["datasets_obj"]

    try:
        llm_campaign.create_llm_campaign(app, mode, campaign_id, config, campaign_data, datasets)
        workflows.load_campaign(app, campaign_id=campaign_id)
    except Exception as e:
        traceback.print_exc()
        return utils.error(f"Error while creating campaign: {e}")

    return utils.success()


@app.route("/llm_eval/detail/<campaign_id>", methods=["GET", "POST"])
@app.route("/llm_gen/detail/<campaign_id>", methods=["GET", "POST"])
@login_required
def llm_campaign_detail(campaign_id):
    workflows.refresh_indexes(app)

    mode = utils.get_mode_from_path(request.path)
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    reconcile_llm_campaign_runtime_state(app, campaign)

    overview = campaign.get_overview()

    finished_examples = [x for x in overview if x["status"] == ExampleStatus.FINISHED]

    return render_template(
        f"pages/llm_campaign_detail.html",
        mode=mode,
        campaign_id=campaign_id,
        overview=overview,
        finished_examples=finished_examples,
        metadata=campaign.metadata,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/llm_eval/new", methods=["GET", "POST"])
@app.route("/llm_gen/new", methods=["GET", "POST"])
@login_required
def llm_campaign_new():
    mode = utils.get_mode_from_path(request.path)

    datasets = workflows.get_local_dataset_overview(app)
    datasets = {k: v for k, v in datasets.items() if v["enabled"]}

    if mode == CampaignMode.LLM_EVAL:
        available_data = workflows.get_model_outputs_overview(app, datasets)
    else:
        available_data = workflows.get_available_data(app, datasets)

    # get a list of available metrics
    llm_configs = workflows.load_configs(mode=mode)
    crowdsourcing_configs = workflows.load_configs(mode=CampaignMode.CROWDSOURCING)
    model_apis = list(ModelFactory.get_model_apis().keys())
    prompt_strats = list(ModelFactory.get_prompt_strategies()[mode].keys())

    if "default" in prompt_strats:
        prompt_strats.remove("default")
        prompt_strats = ["default"] + prompt_strats

    default_campaign_id = workflows.generate_default_id(app, mode=mode, prefix=mode.replace("_", "-"))
    default_prompts = utils.load_default_prompts()

    return render_template(
        f"pages/llm_campaign_new.html",
        mode=mode,
        datasets=datasets,
        default_campaign_id=default_campaign_id,
        default_prompts=default_prompts,
        available_data=available_data,
        configs=llm_configs,
        crowdsourcing_configs=crowdsourcing_configs,
        model_apis=model_apis,
        prompt_strats=prompt_strats,
        host_prefix=app.config["host_prefix"],
    )


@app.route("/llm_eval/run", methods=["POST"])
@app.route("/llm_gen/run", methods=["POST"])
@login_required
def llm_campaign_run():
    mode = utils.get_mode_from_path(request.path)
    data = request.get_json()
    campaign_id = data.get("campaignId")

    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    if campaign is None:
        return utils.error(f"Unknown campaign: {campaign_id}")

    if campaign.metadata.get("status") == CampaignStatus.RUNNING:
        return utils.error(f"Campaign {campaign_id} is already running.")

    if reconcile_llm_campaign_runtime_state(app, campaign):
        return utils.error(f"Campaign {campaign_id} is already running.")

    app.db["announcers"][campaign_id] = announcer = utils.MessageAnnouncer()
    app.db["running_campaigns"].add(campaign_id)

    try:
        datasets = app.db["datasets_obj"]

        config = campaign.metadata["config"]
        model = ModelFactory.from_config(config, mode=mode)
        start_llm_campaign_background(app, mode, campaign_id, announcer, campaign, datasets, model)
        return jsonify(success=True, status=CampaignStatus.RUNNING)

    except Exception as e:
        app.db["running_campaigns"].discard(campaign_id)
        app.db["running_campaign_threads"].pop(campaign_id, None)
        traceback.print_exc()
        return utils.error(f"Error while running campaign: {e}")


@app.route("/llm_campaign/update_metadata", methods=["POST"])
@login_required
def llm_campaign_update_config():
    data = request.get_json()

    campaign_id = data.get("campaignId")
    config = data.get("config")

    config = llm_campaign.parse_campaign_config(config)
    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    campaign.metadata["config"] = config
    campaign.update_metadata()

    return utils.success()


@app.route("/llm_campaign/validate_model", methods=["POST"])
@login_required
def llm_campaign_validate_model():
    data = request.get_json() or {}
    provider = data.get("provider")
    model_name = data.get("model")

    if provider != "openrouter":
        return jsonify(
            success=True,
            available=True,
            lookup_failed=False,
            suggestions=[],
            message=None,
        )

    result = llm_campaign.validate_openrouter_model(model_name)
    return jsonify(success=True, **result)


@app.route("/llm_campaign/progress/<campaign_id>", methods=["GET", "POST"])
@login_required
def listen(campaign_id):
    if not app.db["announcers"].get(campaign_id):
        return Response(status=404)

    def stream():
        messages = app.db["announcers"][campaign_id].listen()
        while True:
            try:
                msg = messages.get(timeout=10)
                yield msg
            except queue.Empty:
                # Keep the SSE connection active so sync Gunicorn workers are not
                # treated as hung while waiting for the next campaign event.
                yield ": keepalive\n\n"

    return Response(
        stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/llm_campaign/pause", methods=["POST"])
@login_required
def llm_campaign_pause():
    data = request.get_json()
    campaign_id = data.get("campaignId")

    llm_campaign.pause_llm_campaign(app, campaign_id)

    resp = jsonify(success=True, status=CampaignStatus.IDLE)
    return resp


@app.route("/manage", methods=["GET", "POST"])
@login_required
def manage():
    datasets = workflows.get_local_dataset_overview(app)

    datasets_enabled = {k: v for k, v in datasets.items() if v["enabled"]}
    model_outputs = workflows.get_model_outputs_overview(app, datasets_enabled)

    resources = utils.load_resources_config()

    # set as `downloaded` the datasets that are already downloaded
    for dataset_id in resources.keys():
        resources[dataset_id]["downloaded"] = dataset_id in datasets

    campaigns = workflows.get_sorted_campaign_list(
        app, modes=[CampaignMode.CROWDSOURCING, CampaignMode.LLM_EVAL, CampaignMode.LLM_GEN, CampaignMode.EXTERNAL]
    )

    return render_template(
        "pages/manage.html",
        datasets=datasets,
        resources=resources,
        host_prefix=app.config["host_prefix"],
        model_outputs=model_outputs,
        campaigns=campaigns,
    )


@app.route("/save_config", methods=["POST"])
def save_config():
    data = request.get_json()
    filename = data.get("filename")
    config = data.get("config")
    mode = data.get("mode")

    if mode == CampaignMode.LLM_EVAL:
        config = llm_campaign.parse_llm_eval_config(config)
    elif mode == CampaignMode.LLM_GEN:
        config = llm_campaign.parse_llm_gen_config(config)
    elif mode == CampaignMode.CROWDSOURCING:
        config = crowdsourcing.parse_crowdsourcing_config(config)
    else:
        return utils.error(f"Invalid mode: {mode}")

    utils.save_config(filename, config, mode=mode)

    return utils.success()


@app.route("/save_generation_outputs", methods=["GET", "POST"])
@login_required
def save_generation_outputs():
    data = request.get_json()
    campaign_id = data.get("campaignId")
    model_name = slugify(data.get("modelName"))

    llm_campaign.save_generation_outputs(app, campaign_id, model_name)

    return utils.success()


@app.route("/submit_annotations", methods=["POST"])
def submit_annotations():
    data = request.get_json()
    campaign_id = data["campaign_id"]
    annotation_set = data["annotation_set"]
    annotator_id = data["annotator_id"]

    logger.info(f"Received annotations for {campaign_id} by {annotator_id}")
    if crowdsourcing.is_preview_annotator(annotator_id):
        return crowdsourcing.preview_submission_response(app, campaign_id)
    if any(annotation.get("redo_id") for annotation in annotation_set):
        return utils.error("Redo annotations must be saved with Save current item.")

    campaign = workflows.load_campaign(app, campaign_id=campaign_id)
    if crowdsourcing.is_per_example_save_campaign(campaign):
        return crowdsourcing.save_per_example_annotations(app, campaign_id, annotation_set, annotator_id)

    return crowdsourcing.save_annotations(app, campaign_id, annotation_set, annotator_id)


@app.route("/set_dataset_enabled", methods=["POST"])
@login_required
def set_dataset_enabled():
    data = request.get_json()
    dataset_id = data.get("datasetId")
    enabled = data.get("enabled")

    workflows.set_dataset_enabled(app, dataset_id, enabled)

    return utils.success()


@app.route("/set_dataset_hidden_from_regular_users", methods=["POST"])
@login_required
def set_dataset_hidden_from_regular_users():
    data = request.get_json()
    dataset_id = data.get("datasetId")
    hidden_from_regular_users = data.get("hiddenFromRegularUsers")

    workflows.set_dataset_hidden_from_regular_users(dataset_id, hidden_from_regular_users)

    return utils.success()


@app.route("/set_campaign_hidden_from_regular_users", methods=["POST"])
@login_required
def set_campaign_hidden_from_regular_users():
    data = request.get_json()
    campaign_id = data.get("campaignId")
    hidden_from_regular_users = data.get("hiddenFromRegularUsers")

    workflows.set_campaign_hidden_from_regular_users(app, campaign_id, hidden_from_regular_users)

    return utils.success()


@app.route("/set_campaign_pseudonymize_annotators", methods=["POST"])
@login_required
def set_campaign_pseudonymize_annotators():
    data = request.get_json()
    campaign_id = data.get("campaignId")
    pseudonymize_annotators = data.get("pseudonymizeAnnotators")

    workflows.set_campaign_pseudonymize_annotators(app, campaign_id, pseudonymize_annotators)

    return utils.success()


@app.route("/update_config", methods=["POST"])
@login_required
def update_config():
    try:
        data = request.get_json()
        app.config.update(data)
        utils.save_app_config(data)
        return utils.success()
    except Exception as e:
        traceback.print_exc()
        return utils.error(f"Error while updating config: {e.__class__.__name__}: {e}")


@app.route("/upload_dataset", methods=["POST"])
@login_required
def upload_dataset():
    data = request.get_json()
    dataset_id = slugify(data.get("name"))
    dataset_name = data.get("name")
    dataset_description = data.get("description")
    dataset_format = data.get("format")
    dataset_data = data.get("dataset")

    try:
        workflows.upload_dataset(app, dataset_id, dataset_name, dataset_description, dataset_format, dataset_data)
    except Exception as e:
        traceback.print_exc()
        return utils.error(f"Error while uploading dataset: {e}")

    return utils.success()


@app.route("/upload_model_outputs", methods=["POST"])
@login_required
def upload_model_outputs():
    logger.info(f"Received model outputs")
    data = request.get_json()
    dataset_id = slugify(data["dataset"])
    split = slugify(data["split"])
    setup_id = data["setup_id"]
    model_outputs = data["outputs"]

    dataset = app.db["datasets_obj"].get(dataset_id)
    if dataset is None:
        dataset_config = utils.load_dataset_config().get(dataset_id)
        if dataset_config is None:
            return utils.error(f"Unknown dataset: {dataset_id}")

        try:
            dataset = workflows.instantiate_dataset(dataset_id, dataset_config)
            app.db["datasets_obj"][dataset_id] = dataset
        except Exception as e:
            traceback.print_exc()
            return utils.error(f"Error while loading dataset {dataset_id}: {e}")

    try:
        workflows.upload_model_outputs(dataset, split, setup_id, model_outputs)
    except Exception as e:
        traceback.print_exc()
        return utils.error(f"Error while adding model outputs: {e}")

    return utils.success()


@app.route("/import_annotations", methods=["POST"])
@login_required
def import_annotations():
    """
    Process uploaded backup file
    """
    try:
        file = request.files["backup_file"]
        # Validate file type
        if not file.filename.endswith(".json"):
            return utils.error("Invalid file type. Only JSON backup files are allowed.")

        # Read and parse the backup file
        try:
            backup_data = json.loads(file.read().decode("utf-8"))
        except json.JSONDecodeError as e:
            return utils.error(f"Invalid JSON format: {str(e)}")

        # Validate backup data structure
        required_fields = ["campaign_id", "annotator_id", "annotation_set", "timestamp"]
        missing_fields = [field for field in required_fields if field not in backup_data]
        if missing_fields:
            return utils.error(f'Invalid backup file format. Missing fields: {", ".join(missing_fields)}')

        # Extract data from backup
        campaign_id = backup_data["campaign_id"]
        annotator_id = backup_data["annotator_id"]
        annotation_set = backup_data["annotation_set"]
        timestamp = backup_data["timestamp"]

        # Log the import attempt
        logger.info(f"Importing annotations for campaign {campaign_id} by {annotator_id} from backup dated {timestamp}")

        # Attempt to save the annotations using the existing save function
        result = crowdsourcing.save_annotations(app, campaign_id, annotation_set, annotator_id, is_backup_import=True)

        if result.json.get("success"):
            logger.info(f"Successfully imported backup annotations for {campaign_id}/{annotator_id}")
        else:
            error_msg = result.get("message")
            logger.error(f"Failed to import backup annotations: {error_msg}")

    except Exception as e:
        logger.exception(f"Error importing annotations: {str(e)}")

    return utils.success(
        message=f"Backup annotations for campaign {campaign_id} by {annotator_id} imported successfully."
    )
