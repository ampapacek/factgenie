import json
import tempfile
import unittest
from pathlib import Path

from factgenie import workflows


class WorkflowOutputNormalizationTests(unittest.TestCase):
    def test_normalize_output_text_leaves_plain_text_unchanged(self):
        raw = "Plain text without escaped line breaks."
        normalized = workflows.normalize_output_text(raw)

        self.assertEqual(normalized, raw)

    def test_normalize_output_text_decodes_escaped_line_breaks(self):
        raw = "First line\\n\\nSecond line\\r\\nThird line"
        normalized = workflows.normalize_output_text(raw)

        self.assertEqual(normalized, "First line\n\nSecond line\nThird line")

    def test_load_outputs_from_file_normalizes_output_field(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            file_path = Path(tmp_dir) / "test-output.jsonl"
            file_path.write_text(
                json.dumps(
                    {
                        "dataset": "sample-dataset",
                        "split": "test",
                        "setup_id": "demo",
                        "example_idx": 0,
                        "output": "Line 1\\n\\nLine 2",
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            outputs = workflows.load_outputs_from_file(
                str(file_path),
                cols=["dataset", "split", "setup_id", "example_idx", "output"],
            )

            self.assertEqual(len(outputs), 1)
            self.assertEqual(outputs[0]["dataset"], "sample-dataset")
            self.assertEqual(outputs[0]["output"], "Line 1\n\nLine 2")


if __name__ == "__main__":
    unittest.main()
