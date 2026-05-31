from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd

import factgenie.app as app_module
from factgenie import querying
from factgenie.app import app as flask_app
from factgenie.campaign import ExampleStatus


class DummyDataset:
    def get_example(self, split, example_idx):
        questions = {
            0: "Question about Prague history",
            1: "Question about Brno transport",
            2: "Question about Ostrava culture",
        }
        return {"question": questions[example_idx]}


class WP1Dataset:
    def get_example(self, split, example_idx):
        examples = {
            0: {
                "question": (
                    "<h4>Otázka</h4>"
                    "<div>Kdo byl Masaryk?</div>"
                    "<h4>Nalezené relevantní dokumenty</h4>"
                    "<ol>"
                    "<li><details><summary>Rozbalit text dokumentu</summary>"
                    "<div>Archivní dokument uvádí zdroj pouze ve source datech.</div>"
                    "</details></li>"
                    "<li><details><summary>Rozbalit text dokumentu</summary>"
                    "<div>Unique source B lives in the second source item.</div>"
                    "</details></li>"
                    "</ol>"
                )
            },
            1: {"question": "Plain fallback text mentions archiv without section labels."},
            2: {"question": "Otázka\nSamostatná otázka bez zdrojové části."},
        }
        return examples[example_idx]


def make_app():
    return SimpleNamespace(db={"datasets_obj": {"demo": DummyDataset()}})


def make_wp1_app():
    return SimpleNamespace(db={"datasets_obj": {"wp1": WP1Dataset()}})


def condition(field, op, value="", slider_label="", span_group=""):
    data = {"field": field, "op": op, "value": value}
    if slider_label:
        data["sliderLabel"] = slider_label
    if span_group:
        data["spanGroup"] = span_group
    return data


def filter_rows(tables, conditions, mode="all", authenticated=True):
    return querying.apply_condition_filter(
        tables,
        {"mode": mode, "conditions": conditions},
        authenticated=authenticated,
    )


def sample_tables(pseudonymize_annotators=False):
    app = make_app()
    outputs = pd.DataFrame(
        [
            {"dataset": "demo", "split": "test", "setup_id": "rag-generated", "example_idx": 0, "output": "Alpha answer with castle detail"},
            {"dataset": "demo", "split": "test", "setup_id": "rag-generated", "example_idx": 1, "output": "Beta answer about tram lines"},
            {"dataset": "demo", "split": "test", "setup_id": "plain", "example_idx": 1, "output": "Second setup answer"},
            {"dataset": "demo", "split": "dev", "setup_id": "rag-generated", "example_idx": 2, "output": "Dev answer"},
        ]
    )
    annotation_index = pd.DataFrame(
        [
            {
                "campaign_id": "camp",
                "dataset": "demo",
                "split": "test",
                "setup_id": "rag-generated",
                "example_idx": 0,
                "annotator_id": "alice",
                "annotator_group": 0,
                "annotations": [
                    {"type": 0, "start": 0, "text": "Alpha", "reason": "NotInTop10 but cited"},
                    {"type": 1, "start": 10, "text": "castle", "reason": "needs source"},
                ],
                "flags": [{"label": "Skip", "value": False}],
                "options": [],
                "sliders": [{"label": "Tón", "value": 4}],
                "text_fields": [{"label": "Comment", "value": "check quote"}],
            },
            {
                "campaign_id": "camp",
                "dataset": "demo",
                "split": "test",
                "setup_id": "rag-generated",
                "example_idx": 0,
                "annotator_id": "bob",
                "annotator_group": 0,
                "annotations": [{"type": 0, "start": 0, "text": "Alpha", "reason": "inseafile only"}],
                "flags": [{"label": "Skip", "value": False}],
                "options": [],
                "sliders": [{"label": "Tón", "value": 6}],
                "text_fields": [{"label": "Comment", "value": "second opinion"}],
            },
            {
                "campaign_id": "camp",
                "dataset": "demo",
                "split": "test",
                "setup_id": "rag-generated",
                "example_idx": 1,
                "annotator_id": "bob",
                "annotator_group": 0,
                "annotations": [{"type": 0, "start": 0, "text": "Beta", "reason": "InTop10"}],
                "flags": [{"label": "Skip", "value": False}],
                "options": [],
                "sliders": [{"label": "Tón", "value": 8}],
                "text_fields": [{"label": "Comment", "value": "looks good"}],
            },
            {
                "campaign_id": "camp",
                "dataset": "demo",
                "split": "test",
                "setup_id": "plain",
                "example_idx": 1,
                "annotator_id": "carol",
                "annotator_group": 0,
                "annotations": [],
                "flags": [{"label": "Skip", "value": True}],
                "options": [],
                "sliders": [{"label": "Tón", "value": 1}],
                "text_fields": [{"label": "Comment", "value": "skip this"}],
            },
        ]
    )
    campaign = SimpleNamespace(
        metadata={
            "mode": "crowdsourcing",
            "config": {
                "annotation_span_categories": [
                    {"name": "Chybí"},
                    {"name": "Nesrozumitelné"},
                ],
                "pseudonymize_annotators": pseudonymize_annotators,
            },
        },
        db=pd.DataFrame(
            [
                {
                    "dataset": "demo",
                    "split": "dev",
                    "setup_id": "rag-generated",
                    "example_idx": 2,
                    "annotator_id": "dana",
                    "status": ExampleStatus.ASSIGNED,
                }
            ]
        ),
    )
    submissions = querying._build_submissions(annotation_index, {"camp": campaign})
    spans = querying._build_spans(submissions, {"camp": campaign})
    assignments = querying._build_assignments({"camp": campaign}, {"camp"}, {"demo"})
    rows = querying._build_example_rows(app, outputs, submissions, spans, assignments)
    return {"outputs": outputs, "submissions": submissions, "spans": spans, "assignments": assignments, "rows": rows}


def wp1_tables():
    outputs = pd.DataFrame(
        [
            {"dataset": "wp1", "split": "test", "setup_id": "rag-generated", "example_idx": 0, "output": "Answer 0"},
            {"dataset": "wp1", "split": "test", "setup_id": "rag-generated", "example_idx": 1, "output": "Answer 1"},
            {"dataset": "wp1", "split": "test", "setup_id": "rag-generated", "example_idx": 2, "output": "Answer 2"},
        ]
    )
    rows = querying._build_example_rows(make_wp1_app(), outputs, pd.DataFrame(), pd.DataFrame(), pd.DataFrame())
    return {"outputs": outputs, "submissions": pd.DataFrame(), "spans": pd.DataFrame(), "assignments": pd.DataFrame(), "rows": rows}


def test_query_tables_are_question_centric_and_extract_annotations():
    tables = sample_tables()

    assert tables["rows"]["example_idx"].tolist() == [2, 0, 1]
    test_rows = querying.scope_tables(tables, datasets=["demo"], splits=["test"])["rows"]

    assert test_rows["example_idx"].tolist() == [0, 1]
    assert test_rows.loc[test_rows["example_idx"] == 0, "span_count"].item() == 3
    assert "Chybí" in tables["spans"]["category_name"].tolist()
    assert "Nesrozumitelné" in tables["spans"]["category_name"].tolist()


def test_question_and_output_text_filters_are_separate():
    tables = sample_tables()

    question_rows = filter_rows(tables, [condition("question", "contains", "Brno")])
    output_rows = filter_rows(tables, [condition("output", "contains", "Brno")])
    answer_rows = filter_rows(tables, [condition("output", "contains", "tram")])

    assert question_rows["example_idx"].tolist() == [1]
    assert output_rows.empty
    assert answer_rows["example_idx"].tolist() == [1]


def test_wp1_question_filter_ignores_detected_source_data_section():
    tables = wp1_tables()

    question_rows = filter_rows(tables, [condition("question", "contains", "Masaryk")])
    source_only_question_rows = filter_rows(tables, [condition("question", "contains", "Archivní")])
    source_rows = filter_rows(tables, [condition("source_data", "contains", "Archivní")])
    second_source_rows = filter_rows(tables, [condition("source_data", "contains", "Unique source B")])
    fallback_rows = filter_rows(tables, [condition("question", "contains", "fallback")])

    assert question_rows["example_idx"].tolist() == [0]
    assert source_only_question_rows["example_idx"].tolist() == []
    assert source_rows["example_idx"].tolist() == [0]
    assert second_source_rows["example_idx"].tolist() == [0]
    assert fallback_rows["example_idx"].tolist() == [1]
    assert source_rows.loc[0, "match_details"][0]["target"] == "source_data"
    assert source_rows.loc[0, "match_details"][0]["source_index"] == 1
    assert second_source_rows.loc[0, "match_details"][0]["source_index"] == 2


def test_source_data_field_is_advertised_only_when_detected():
    tables = wp1_tables()
    with_source = querying.schema_payload(tables)
    without_source = querying.schema_payload(
        {
            **tables,
            "rows": tables["rows"][tables["rows"]["example_idx"] == 2],
        }
    )

    assert with_source["source_data_available"] is True
    assert without_source["source_data_available"] is False


def test_span_filters_use_same_span_for_match_all():
    tables = sample_tables()

    same_span = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Chybí"),
            condition("span_reason", "contains", "NotInTop10"),
        ],
    )
    crossed_spans = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Nesrozumitelné"),
            condition("span_reason", "contains", "NotInTop10"),
        ],
    )

    assert same_span["example_idx"].tolist() == [0]
    assert crossed_spans.empty


def test_span_groups_can_match_different_spans_in_same_submission():
    tables = sample_tables()

    same_group = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Chybí"),
            condition("span_category", "eq", "Nesrozumitelné"),
        ],
    )
    different_groups = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Chybí", span_group="1"),
            condition("span_category", "eq", "Nesrozumitelné", span_group="2"),
        ],
    )

    assert same_group.empty
    assert different_groups["example_idx"].tolist() == [0]
    details = different_groups.loc[0, "match_details"]
    assert {detail["spanGroup"] for detail in details if detail["target"] == "span"} == {"1", "2"}
    assert {detail["span_text"] for detail in details if detail["target"] == "span"} == {"Alpha", "castle"}


def test_annotation_filters_use_same_submission_for_match_all():
    tables = sample_tables()

    same_submission = filter_rows(
        tables,
        [
            condition("annotator", "eq", "alice"),
            condition("span_category", "eq", "Chybí"),
            condition("span_reason", "contains", "NotInTop10"),
        ],
    )
    crossed_submissions = filter_rows(
        tables,
        [
            condition("annotator", "eq", "bob"),
            condition("span_category", "eq", "Chybí"),
            condition("span_reason", "contains", "NotInTop10"),
        ],
    )

    assert same_submission["example_idx"].tolist() == [0]
    assert crossed_submissions.empty


def test_slider_filters_use_same_submission_for_match_all():
    tables = sample_tables()

    alice_low = filter_rows(
        tables,
        [
            condition("annotator", "eq", "alice"),
            condition("slider", "lt", "5", slider_label="Tón"),
        ],
    )
    bob_low = filter_rows(
        tables,
        [
            condition("annotator", "eq", "bob"),
            condition("slider", "lt", "5", slider_label="Tón"),
        ],
    )

    assert alice_low["example_idx"].tolist() == [0]
    assert bob_low.empty


def test_slider_missing_matches_absent_slider_label_in_submission_scope():
    tables = sample_tables()

    alice_missing = filter_rows(
        tables,
        [
            condition("annotator", "eq", "alice"),
            condition("slider", "missing", slider_label="Missing slider"),
        ],
    )
    bob_missing = filter_rows(
        tables,
        [
            condition("annotator", "eq", "bob"),
            condition("slider", "missing", slider_label="Missing slider"),
        ],
    )

    assert alice_missing["example_idx"].tolist() == [0]
    assert bob_missing["example_idx"].tolist() == [0, 1]
    assert all(
        detail["slider_label"] == "Missing slider"
        for detail in alice_missing.loc[alice_missing["example_idx"] == 0, "match_details"].item()
        if detail["target"] == "slider"
    )


def test_filter_returns_condition_level_match_details():
    tables = sample_tables()

    rows = filter_rows(
        tables,
        [
            condition("annotator", "eq", "alice"),
            condition("span_category", "eq", "Chybí"),
            condition("span_reason", "contains", "NotInTop10"),
            condition("slider", "lt", "5", slider_label="Tón"),
        ],
    )

    details = rows.loc[0, "match_details"]
    assert rows.loc[0, "match_annotator_id"] == "alice"
    assert {detail["field"] for detail in details} == {"annotator", "span_category", "span_reason", "slider"}
    span_details = [detail for detail in details if detail["target"] == "span"]
    assert all(detail["span_text"] == "Alpha" for detail in span_details)
    assert all(detail["campaign_id"] == "camp" for detail in span_details)
    assert any(detail["matched_text"] == "NotInTop10" for detail in span_details)
    slider_detail = next(detail for detail in details if detail["target"] == "slider")
    assert slider_detail["campaign_id"] == "camp"
    assert slider_detail["slider_label"] == "Tón"
    assert slider_detail["slider_value"] == 4


def test_summary_counts_distinct_span_occurrences_not_condition_details():
    tables = sample_tables()

    rows = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Chybí"),
            condition("span_text", "contains", "Alpha"),
        ],
    )
    payload = querying.table_payload(rows)

    assert payload["summary"]["total"] == 1
    assert payload["summary"]["matched_occurrence_count"] == 2
    assert payload["summary"]["occurrence_unit"] == "span"
    assert payload["summary"]["occurrence_unit_label"] == "span"
    assert payload["summary"]["occurrence_unit_plural"] == "spans"
    assert payload["summary"]["matched_answer_count"] == 1
    assert payload["summary"]["matched_annotation_count"] == 2
    assert payload["summary"]["matched_span_count"] == 2


def test_summary_prefers_span_count_when_setup_filter_is_annotation_scoped():
    tables = sample_tables()

    rows = filter_rows(
        tables,
        [
            condition("setup", "eq", "rag-generated"),
            condition("span_category", "eq", "Chybí"),
        ],
    )
    payload = querying.table_payload(rows)

    assert payload["summary"]["total"] == 2
    assert payload["summary"]["matched_occurrence_count"] == 3
    assert payload["summary"]["occurrence_unit"] == "span"
    assert payload["summary"]["matched_answer_count"] == 2
    assert payload["summary"]["matched_annotation_count"] == 3
    assert payload["summary"]["matched_span_count"] == 3


def test_summary_counts_distinct_spans_across_span_groups():
    tables = sample_tables()

    rows = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Chybí", span_group="1"),
            condition("span_text", "contains", "castle", span_group="2"),
        ],
    )
    payload = querying.table_payload(rows)

    assert payload["summary"]["total"] == 1
    assert payload["summary"]["matched_occurrence_count"] == 2
    assert payload["summary"]["occurrence_unit"] == "span"
    assert payload["summary"]["matched_answer_count"] == 1
    assert payload["summary"]["matched_annotation_count"] == 1
    assert payload["summary"]["matched_span_count"] == 2


def test_summary_counts_source_data_occurrences():
    rows = filter_rows(wp1_tables(), [condition("source_data", "contains", "source")])
    payload = querying.table_payload(rows)

    assert payload["summary"]["total"] == 1
    assert payload["summary"]["matched_occurrence_count"] == 2
    assert payload["summary"]["occurrence_unit"] == "source_data"
    assert payload["summary"]["occurrence_unit_label"] == "source data item"
    assert payload["summary"]["occurrence_unit_plural"] == "source data items"


def test_match_all_returns_all_matching_spans_and_annotators():
    tables = sample_tables()
    row_index = tables["rows"].index[tables["rows"]["example_idx"] == 0][0]
    extra_span = dict(tables["rows"].at[row_index, "spans"][0])
    extra_span["text"] = "Alpha again"
    extra_span["start"] = 20
    extra_span["reason"] = "another matching span"
    tables["rows"].at[row_index, "spans"] = tables["rows"].at[row_index, "spans"] + [extra_span]

    rows = filter_rows(
        tables,
        [
            condition("span_category", "eq", "Chybí"),
            condition("span_text", "contains", "Alpha"),
        ],
    )

    details = rows.loc[rows["example_idx"] == 0, "match_details"].item()
    span_text_details = [detail for detail in details if detail["field"] == "span_text"]

    assert {detail["annotator_id"] for detail in span_text_details} == {"alice", "bob"}
    assert [detail["start"] for detail in span_text_details].count(0) == 2
    assert 20 in [detail["start"] for detail in span_text_details]


def test_match_any_returns_all_matching_details():
    tables = sample_tables()

    rows = filter_rows(
        tables,
        [
            condition("span_reason", "contains", "NotInTop10"),
            condition("span_reason", "contains", "inseafile"),
        ],
        mode="any",
    )

    details = rows.loc[rows["example_idx"] == 0, "match_details"].item()
    assert {detail["annotator_id"] for detail in details} == {"alice", "bob"}
    assert {detail["matched_text"] for detail in details} == {"NotInTop10", "inseafile"}


def test_match_any_ors_conditions():
    tables = sample_tables()

    rows = filter_rows(
        tables,
        [
            condition("question", "contains", "Ostrava"),
            condition("span_reason", "contains", "NotInTop10"),
        ],
        mode="any",
    )

    assert rows["example_idx"].tolist() == [2, 0]


def test_regex_filter_and_invalid_regex_error():
    tables = sample_tables()

    rows = filter_rows(tables, [condition("span_reason", "regex", "notintop10")])
    assert rows["example_idx"].tolist() == [0]

    try:
        filter_rows(tables, [condition("span_reason", "regex", "[")])
    except querying.QueryFilterError as exc:
        assert "Invalid regex" in str(exc)
    else:
        raise AssertionError("Invalid regex should fail with QueryFilterError")


def test_slider_filters_ignore_skipped_submissions():
    tables = sample_tables()

    low = filter_rows(tables, [condition("slider", "lt", "5", slider_label="Tón")])
    embedded_label = filter_rows(tables, [condition("slider:Tón", "lt", "5")])
    high = filter_rows(tables, [condition("slider", "gte", "8", slider_label="Tón")])
    skipped_low = filter_rows(tables, [condition("slider", "eq", "1", slider_label="Tón")])

    assert low["example_idx"].tolist() == [0]
    assert embedded_label["example_idx"].tolist() == [0]
    assert high["example_idx"].tolist() == [1]
    assert skipped_low.empty


def test_public_payload_removes_raw_annotator_ids_from_match_details():
    tables = sample_tables(pseudonymize_annotators=True)
    rows = filter_rows(tables, [condition("annotator", "eq", "alice")], authenticated=True)

    payload = querying.table_payload(rows, authenticated=False)

    row = payload["rows"][0]
    assert row["match_annotator_id"] == ""
    assert row["match_details"]
    assert "annotator_id" not in row["match_details"][0]
    assert row["match_details"][0]["annotator_alias"]
    assert row["match_details"][0]["annotator_alias"] != "alice"


def test_schema_payload_is_scoped_and_public_uses_aliases_only():
    tables = querying.scope_tables(sample_tables(pseudonymize_annotators=True), datasets=["demo"], splits=["test"])

    public_schema = querying.schema_payload(tables, authenticated=False)
    private_schema = querying.schema_payload(tables, authenticated=True)

    assert public_schema["result_unit"] == "question"
    assert public_schema["result_unit_label"] == "question"
    assert public_schema["result_unit_plural"] == "questions"
    assert public_schema["datasets"] == ["demo"]
    assert public_schema["splits"] == ["test"]
    assert public_schema["setups"] == ["plain", "rag-generated"]
    assert "alice" not in public_schema["annotators"]
    assert "alice" in private_schema["annotators"]


def test_public_filters_include_raw_annotators_when_campaign_pseudonymization_is_off():
    tables = querying.scope_tables(sample_tables(pseudonymize_annotators=False), datasets=["demo"], splits=["test"])

    schema = querying.schema_payload(tables, authenticated=False)
    raw_id_rows = filter_rows(tables, [condition("annotator", "eq", "alice")], authenticated=False)
    alias = tables["submissions"].loc[tables["submissions"]["annotator_id"] == "alice", "annotator_alias"].iloc[0]
    alias_rows = filter_rows(tables, [condition("annotator", "eq", alias)], authenticated=False)
    payload = querying.table_payload(raw_id_rows, authenticated=False)

    assert "alice" in schema["annotators"]
    assert alias in schema["annotators"]
    assert raw_id_rows["example_idx"].tolist() == [0]
    assert alias_rows["example_idx"].tolist() == [0]
    assert payload["rows"][0]["match_annotator_id"] == "alice"
    assert payload["rows"][0]["match_details"][0]["annotator_id"] == "alice"


def test_authenticated_filters_include_raw_annotators_even_when_pseudonymized():
    tables = querying.scope_tables(sample_tables(pseudonymize_annotators=True), datasets=["demo"], splits=["test"])

    schema = querying.schema_payload(tables, authenticated=True)
    raw_id_rows = filter_rows(tables, [condition("annotator", "eq", "alice")], authenticated=True)
    alias = tables["submissions"].loc[tables["submissions"]["annotator_id"] == "alice", "annotator_alias"].iloc[0]
    alias_rows = filter_rows(tables, [condition("annotator", "eq", alias)], authenticated=True)

    assert "alice" in schema["annotators"]
    assert alias in schema["annotators"]
    assert raw_id_rows["example_idx"].tolist() == [0]
    assert alias_rows["example_idx"].tolist() == [0]


def test_example_sanitizer_keeps_raw_ids_for_authenticated_and_public_non_pseudonymized_campaigns():
    example_data = {
        "generated_outputs": [
            {
                "annotations": [
                    {"campaign_id": "public-camp", "annotator_id": "alice", "annotator_alias": "Tokyo"},
                    {"campaign_id": "private-camp", "annotator_id": "bob", "annotator_alias": "Paris"},
                ]
            }
        ]
    }

    with patch("factgenie.app._can_reveal_campaign_annotator_ids", return_value=True):
        app_module._sanitize_example_annotator_ids(example_data, is_authenticated=True)

    annotations = example_data["generated_outputs"][0]["annotations"]
    assert annotations[0]["annotator_id"] == "alice"
    assert annotations[1]["annotator_id"] == "bob"

    with patch(
        "factgenie.app._can_reveal_campaign_annotator_ids",
        side_effect=lambda campaign_id, is_authenticated: campaign_id == "public-camp",
    ):
        app_module._sanitize_example_annotator_ids(example_data, is_authenticated=False)

    assert annotations[0]["annotator_id"] == "alice"
    assert "annotator_id" not in annotations[1]


def test_query_filter_route_returns_scoped_rows_and_handles_regex_error():
    flask_app.config.update(TESTING=True, login={"active": False, "lock_view_pages": True}, host_prefix="")
    with flask_app.test_client() as client:
        with patch("factgenie.app._get_query_tables", return_value=sample_tables()):
            response = client.post(
                "/query/filter",
                json={
                    "dataset": "demo",
                    "split": "test",
                    "filters": {"mode": "all", "conditions": [condition("span_category", "eq", "Chybí")]},
                },
            )
            regex_response = client.post(
                "/query/filter",
                json={
                    "dataset": "demo",
                    "split": "test",
                    "filters": {"mode": "all", "conditions": [condition("span_reason", "regex", "[")]},
                },
            )

    data = response.get_json()
    assert data["success"] is True
    assert data["result_unit"] == "question"
    assert data["result_unit_label"] == "question"
    assert data["result_unit_plural"] == "questions"
    assert data["summary"]["total"] == 2
    assert data["summary"]["matched_occurrence_count"] == 3
    assert data["summary"]["occurrence_unit"] == "span"
    assert [row["example_idx"] for row in data["rows"]] == [0, 1]

    error = regex_response.get_json()
    assert error["success"] is False
    assert "Invalid regex" in error["error"]


def test_query_schema_route_scopes_to_selected_dataset_and_split():
    flask_app.config.update(TESTING=True, login={"active": False, "lock_view_pages": True}, host_prefix="")
    with flask_app.test_client() as client:
        with patch("factgenie.app._get_query_tables", return_value=sample_tables()):
            response = client.get("/query/schema?dataset=demo&split=test")

    data = response.get_json()
    assert data["success"] is True
    assert data["result_unit"] == "question"
    assert data["result_unit_label"] == "question"
    assert data["result_unit_plural"] == "questions"
    assert data["splits"] == ["test"]
    assert data["setups"] == ["plain", "rag-generated"]


def test_public_query_scope_excludes_hidden_datasets_and_campaigns():
    flask_app.config.update(
        TESTING=True,
        login={"active": True, "lock_view_pages": False, "show_analyze_without_login": True},
        host_prefix="",
    )
    datasets = {
        "demo": {"enabled": True, "name": "Visible", "splits": ["test"]},
        "secret": {"enabled": True, "name": "Hidden", "splits": ["test"], "hidden_from_regular_users": True},
    }
    campaigns = {
        "camp": {"metadata": {"hidden_from_regular_users": False}, "data": [{"dataset": "demo"}]},
        "hidden-camp": {"metadata": {"hidden_from_regular_users": True}, "data": [{"dataset": "demo"}]},
        "secret-camp": {"metadata": {"hidden_from_regular_users": False}, "data": [{"dataset": "secret"}]},
    }

    with flask_app.test_client() as client:
        with patch("factgenie.app.workflows.refresh_indexes"), patch(
            "factgenie.app.workflows.get_local_dataset_overview",
            return_value=datasets,
        ), patch(
            "factgenie.app.workflows.get_sorted_campaign_list",
            return_value=campaigns,
        ), patch(
            "factgenie.querying.build_query_tables",
            return_value=sample_tables(),
        ) as build_query_tables:
            response = client.get("/query/schema?dataset=demo&split=test")

    assert response.status_code == 200
    kwargs = build_query_tables.call_args.kwargs
    assert kwargs["visible_dataset_ids"] == {"demo"}
    assert kwargs["visible_campaign_ids"] == {"camp"}
