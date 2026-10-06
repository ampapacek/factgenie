from types import SimpleNamespace

import pandas as pd

import factgenie.analysis as analysis
from factgenie.analysis import classify_rag_mistake_reason


def test_classify_rag_mistake_reason_collection_bucket():
    assert classify_rag_mistake_reason("NotInSeafile NotInTop10 práce s významností") == "collection"


def test_classify_rag_mistake_reason_search_bucket():
    assert classify_rag_mistake_reason("InSeafile NotInTop10 Základní charakteristika") == "search"


def test_classify_rag_mistake_reason_generation_bucket():
    assert classify_rag_mistake_reason("InSeafile InTop10 Chybí úvod odpovědi") == "generation"


def test_classify_rag_mistake_reason_ignores_unrelated_text():
    assert classify_rag_mistake_reason("Bez markerů") is None


def test_rag_summary_defaults_prefer_rag_and_chybi():
    span_index = pd.DataFrame(
        [
            {"setup_id": "plain"},
            {"setup_id": "rag-basic"},
            {"setup_id": "rag-advanced"},
        ]
    )
    campaign = SimpleNamespace(
        metadata={
            "config": {
                "annotation_span_categories": [
                    {"name": "Nesrozumitelné"},
                    {"name": "Chybí"},
                ]
            }
        }
    )

    defaults = analysis._get_rag_summary_defaults(span_index, campaign)

    assert defaults["default_setup_id"].startswith("rag-")
    assert defaults["default_span_category"] == "Chybí"


def test_rag_mistake_stats_respects_selected_setup_and_span(monkeypatch):
    span_index = pd.DataFrame(
        [
            {
                "dataset": "demo",
                "split": "test",
                "setup_id": "rag-foo",
                "example_idx": 1,
                "annotator_id": "alice",
                "annotation_type": 0,
                "annotation_text": "one",
                "annotation_reason": "InSeafile NotInTop10",
            },
            {
                "dataset": "demo",
                "split": "test",
                "setup_id": "plain",
                "example_idx": 2,
                "annotator_id": "bob",
                "annotation_type": 1,
                "annotation_text": "two",
                "annotation_reason": "InSeafile NotInTop10",
            },
        ]
    )
    campaign = SimpleNamespace(
        metadata={
            "config": {
                "annotation_span_categories": [
                    {"name": "Chybí"},
                    {"name": "Jiná"},
                ]
            }
        }
    )

    monkeypatch.setattr(analysis, "generate_span_index", lambda app, campaign: span_index)
    monkeypatch.setattr(analysis, "_load_campaign_annotator_alias_map", lambda campaign: {})

    stats = analysis.compute_rag_mistake_stats(
        app=SimpleNamespace(),
        campaign=campaign,
        selected_setup_id="rag-foo",
        selected_span_category="Chybí",
        show_real_annotator_names=True,
        span_index=span_index,
    )

    assert stats[1]["example_count"] == 1
    assert stats[1]["examples"][0]["setup_id"] == "rag-foo"

    filtered = analysis.compute_rag_mistake_stats(
        app=SimpleNamespace(),
        campaign=campaign,
        selected_setup_id="plain",
        selected_span_category="Jiná",
        show_real_annotator_names=True,
        span_index=span_index,
    )

    assert filtered[1]["example_count"] == 1
    assert filtered[1]["examples"][0]["setup_id"] == "plain"


def _span_count_fixture():
    # Two annotators annotate the same single output; only alice marks two category-0 spans.
    example_index = pd.DataFrame(
        [
            {"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": 0, "annotator_id": "alice", "cat_0": 2},
            {"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": 0, "annotator_id": "bob", "cat_0": 0},
        ]
    )
    span_index = pd.DataFrame(
        [
            {"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": 0, "annotator_id": "alice", "annotation_type": 0},
            {"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": 0, "annotator_id": "alice", "annotation_type": 0},
        ]
    )
    return example_index, span_index


def test_span_averages_are_per_annotation_not_per_output():
    example_index, span_index = _span_count_fixture()

    counts = analysis.compute_ann_counts(span_index)
    counts = analysis.compute_avg_ann_counts(counts, example_index)
    counts = analysis.compute_prevalence(counts, example_index)
    row = counts.iloc[0]

    assert row["example_count"] == 1
    assert row["annotation_count"] == 2
    assert row["avg_count"] == 1.0
    assert row["prevalence"] == 0.5


def test_per_annotator_span_averages_weigh_annotators_equally():
    # alice annotates 3 outputs with 2 spans each, bob 1 output with none.
    example_index = pd.DataFrame(
        [
            {"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": idx, "annotator_id": "alice", "cat_0": 2}
            for idx in range(3)
        ]
        + [{"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": 0, "annotator_id": "bob", "cat_0": 0}]
    )
    span_index = pd.DataFrame(
        [
            {"dataset": "demo", "split": "test", "setup_id": "rag", "example_idx": idx, "annotator_id": "alice", "annotation_type": 0}
            for idx in range(3)
            for _ in range(2)
        ]
    )

    counts = analysis.compute_ann_counts(span_index)
    counts = analysis.compute_avg_ann_counts(counts, example_index)
    counts = analysis.compute_prevalence(counts, example_index)
    pooled = counts.iloc[0]
    assert pooled["avg_count"] == 1.5
    assert pooled["prevalence"] == 0.75

    per_annotator = analysis.apply_per_annotator_span_averages(counts, span_index, example_index).iloc[0]
    assert per_annotator["avg_count"] == 1.0
    assert per_annotator["prevalence"] == 0.5
    assert per_annotator["annotation_count"] == 4


def _slider_example_index():
    def record(example_idx, annotator_id, value):
        return {
            "dataset": "demo",
            "split": "test",
            "setup_id": "rag",
            "example_idx": example_idx,
            "annotator_id": annotator_id,
            "sliders": [{"label": "Quality", "value": str(value)}],
        }

    return pd.DataFrame([record(0, "alice", 8), record(1, "alice", 8), record(2, "alice", 8), record(0, "bob", 4)])


def test_slider_stats_pooled_and_per_annotator():
    example_index = _slider_example_index()

    pooled = analysis.compute_slider_stats(example_index, {}, averaging="pooled")
    assert pooled["overall"][0]["avg_value"] == 7.0
    assert pooled["overall"][0]["count"] == 4
    assert pooled["overall"][0]["annotator_count"] == 2
    assert pooled["by_setup"][0]["summary"]["Quality"]["avg_value"] == 7.0

    per_annotator = analysis.compute_slider_stats(example_index, {}, averaging="annotator")
    assert per_annotator["overall"][0]["avg_value"] == 6.0
    assert per_annotator["overall"][0]["min_value"] == 4.0
    assert per_annotator["by_setup"][0]["summary"]["Quality"]["avg_value"] == 6.0


def test_annotator_filter_uses_pseudonyms_when_names_hidden():
    example_index = pd.DataFrame([{"annotator_id": "alice"}, {"annotator_id": "bob"}])
    aliases = {"alice": "Paris", "bob": "Tokyo"}

    hidden, hidden_ids = analysis.build_annotator_filter(example_index, aliases, False, ["alice", "Tokyo"])
    assert [option["value"] for option in hidden["options"]] == ["Paris", "Tokyo"]
    assert "alice" not in str(hidden)
    assert hidden["selected"] == ["Tokyo"]
    assert hidden_ids == ["bob"]

    shown, shown_ids = analysis.build_annotator_filter(example_index, aliases, True, ["alice", "bob", "unknown-x"])
    assert shown["selected"] == ["alice", "bob"]
    assert shown["selected_label"] == "alice (Paris), bob (Tokyo)"
    assert shown_ids == ["alice", "bob"]

    nothing, nothing_ids = analysis.build_annotator_filter(example_index, aliases, True, [])
    assert nothing["selected_label"] == "All annotators"
    assert nothing_ids == []


def test_compute_statistics_filters_selected_annotators(monkeypatch):
    example_index = _slider_example_index()
    example_index["annotations"] = [[{"type": 0}], [], [], []]
    example_index["flags"] = [[], [], [], [{"label": "skip", "value": False}]]
    example_index["cat_0"] = [1, 0, 0, 0]
    for field in ["options", "text_fields"]:
        example_index[field] = [[] for _ in range(len(example_index))]
    skipped = example_index.iloc[[0]].copy()
    skipped["annotator_id"] = "carol"
    skipped["flags"] = [[{"label": "skip", "value": True}]]
    example_index = pd.concat([example_index, skipped], ignore_index=True)
    span_index = example_index[example_index["cat_0"] > 0].drop(columns=["annotations"]).assign(
        annotation_type=0, annotation_text="x", annotation_reason=""
    )
    campaign = SimpleNamespace(
        campaign_id="demo-campaign",
        metadata={"config": {"annotation_span_categories": [{"name": "Chybí"}], "sliders": []}},
    )
    app = SimpleNamespace(db={"datasets_obj": {}})

    monkeypatch.setattr(analysis, "generate_span_index", lambda app, campaign: span_index)
    monkeypatch.setattr(analysis, "generate_example_index", lambda app, campaign: example_index)
    monkeypatch.setattr(analysis, "_load_campaign_annotator_alias_map", lambda campaign: {})
    monkeypatch.setattr(analysis, "compute_question_coverage_stats", lambda *args, **kwargs: None)

    everyone = analysis.compute_statistics(app, campaign)
    assert [option["value"] for option in everyone["annotator_filter"]["options"]] == ["alice", "bob"]
    assert everyone["slider_stats"]["overall"][0]["avg_value"] == 7.0
    assert everyone["ann_counts"]["setup"][0]["annotation_count"] == 4

    bob = analysis.compute_statistics(app, campaign, selected_annotators=["bob"])
    assert bob["annotator_filter"]["selected"] == ["bob"]
    assert bob["slider_stats"]["overall"][0]["avg_value"] == 4.0
    assert "ann_counts" not in bob
    assert bob.get("rag_mistake_stats") is None
    assert len(bob["annotator_stats"]["rows"]) == 2

    per_annotator = analysis.compute_statistics(app, campaign, averaging="annotator")
    assert per_annotator["slider_stats"]["overall"][0]["avg_value"] == 6.0
    assert per_annotator["annotator_filter"]["averaging"] == "annotator"
