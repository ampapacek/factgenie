import pandas as pd

from factgenie.crowdsourcing import ExampleStatus, normalize_batch_order, select_batch


def make_db(groups=3, batches=4):
    rows = []
    for g in range(groups):
        for b in range(batches):
            for setup in ("a", "b"):
                rows.append(
                    {
                        "dataset": "d",
                        "split": "s",
                        "example_idx": b,
                        "setup_id": setup,
                        "batch_idx": g * batches + b,
                        "annotator_group": g,
                        "annotator_id": "",
                        "status": ExampleStatus.FREE,
                    }
                )
    return pd.DataFrame(rows)


def finish(db, batch_idx, annotator_id):
    mask = db["batch_idx"] == batch_idx
    db.loc[mask, "annotator_id"] = annotator_id
    db.loc[mask, "status"] = ExampleStatus.FINISHED


def test_everybody_gets_the_same_order_and_groups_fill_up():
    db = make_db()
    seen = {}
    for annotator in ["x", "y", "z"]:
        seen[annotator] = []
        for _ in range(4):
            batch = select_batch(db, 1, annotator, "sequential")
            seen[annotator].append(batch % 4)
            finish(db, batch, annotator)
    for order in seen.values():
        assert order == [0, 1, 2, 3]


def test_lowest_group_is_used_first():
    db = make_db()
    assert select_batch(db, 1, "x", "sequential") == 0
    finish(db, 0, "x")
    assert select_batch(db, 1, "y", "sequential") == 4  # group 1, position 0
    assert select_batch(db, 1, "x", "sequential") == 1  # group 0, position 1


def test_random_is_default():
    assert normalize_batch_order(None) == "random"
    assert normalize_batch_order("bogus") == "random"
    assert normalize_batch_order("sequential") == "sequential"
