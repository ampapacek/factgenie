from factgenie.datasets.basic import HTMLDataset


def _write_split(root, split, question_ids):
    split_dir = root / split
    split_dir.mkdir(parents=True)
    for idx, question_id in enumerate(question_ids, start=1):
        meta = f'<meta name="question-id" content="{question_id}">' if question_id else ""
        (split_dir / f"{idx:06d}.html").write_text(
            f'<!doctype html><html><head><meta charset="utf-8">{meta}</head><body>{question_id}</body></html>'
        )


def _dataset(tmp_path):
    _write_split(tmp_path, "a", ["povoden-1", "povoden-2", "povoden-3"])
    _write_split(tmp_path, "b", ["povoden-3", "povoden-1"])
    _write_split(tmp_path, "plain", [None, None])
    dataset = HTMLDataset("tmp", splits=["a", "b", "plain"])
    dataset.data_path = tmp_path
    return dataset


def test_html_question_id_is_read_from_meta(tmp_path):
    dataset = _dataset(tmp_path)
    assert dataset.get_question_id(dataset.get_example("a", 2)) == "povoden-3"
    assert dataset.get_question_id(dataset.get_example("plain", 0)) is None
    assert dataset.get_question_id('<meta content="x-1" name="question-id">') == "x-1"


def test_find_question_index_across_splits(tmp_path):
    dataset = _dataset(tmp_path)
    assert dataset.find_question_index("b", "povoden-1") == 1
    assert dataset.find_question_index("b", "povoden-3") == 0
    assert dataset.find_question_index("b", "povoden-2") is None
    assert dataset.find_question_index("plain", "povoden-1") is None
    assert dataset.find_question_index("a", None) is None
