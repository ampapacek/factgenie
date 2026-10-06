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
