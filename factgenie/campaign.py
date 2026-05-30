#!/usr/bin/env python3
import ast
import glob
import json
import logging
import os
from datetime import datetime

import pandas as pd

from factgenie import CAMPAIGN_DIR

logger = logging.getLogger("factgenie")


class CampaignMode:
    CROWDSOURCING = "crowdsourcing"
    LLM_EVAL = "llm_eval"
    LLM_GEN = "llm_gen"
    EXTERNAL = "external"
    HIDDEN = "hidden"


class CampaignStatus:
    IDLE = "idle"
    RUNNING = "running"
    FINISHED = "finished"


class ExampleStatus:
    FREE = "free"
    ASSIGNED = "assigned"
    FINISHED = "finished"


class Campaign:
    @classmethod
    def get_name(cls):
        return cls.__name__

    def __init__(self, campaign_id):
        self.campaign_id = campaign_id
        self.dir = os.path.join(CAMPAIGN_DIR, campaign_id)
        self.db_path = os.path.join(self.dir, "db.csv")
        self.metadata_path = os.path.join(self.dir, "metadata.json")

        self.load_metadata()
        self.load_db()

        self.check_db_consistency()

    def check_db_consistency(self):
        # Detect issues with the database
        if not self.db.empty:
            # Check for duplicate entries based on key columns
            duplicate_columns = ["dataset", "split", "setup_id", "example_idx", "annotator_group"]
            # Make sure all columns exist in the dataframe
            check_columns = [col for col in duplicate_columns if col in self.db.columns]
            if len(check_columns) > 0:  # Only check if relevant columns exist
                duplicates = self.db.duplicated(subset=check_columns, keep=False)
                if duplicates.any():
                    duplicate_rows = self.db[duplicates]
                    logger.warning(
                        f"Duplicated annotator group for an entry found in campaign {self.campaign_id}: rows {duplicate_rows.index.tolist()}"
                    )

    def get_finished_examples(self):
        # load all the JSONL files in the "files" subdirectory
        examples_finished = []

        for jsonl_file in glob.glob(os.path.join(self.dir, "files/*.jsonl")):
            with open(jsonl_file) as f:
                for line in f:
                    example = json.loads(line)
                    examples_finished.append(example)

        return examples_finished

    def update_db(self, db):
        self.db = db
        db.to_csv(self.db_path, index=False)

    def load_db(self):
        # do not assume db for external campaigns
        if self.metadata.get("mode") == CampaignMode.EXTERNAL and not os.path.exists(self.db_path):
            self.db = pd.DataFrame()
            return

        dtype_dict = {"annotator_id": str, "start": float, "end": float}
        with open(self.db_path) as f:
            self.db = pd.read_csv(f, dtype=dtype_dict)

    def update_metadata(self):
        with open(self.metadata_path, "w") as f:
            json.dump(self.metadata, f, indent=4, ensure_ascii=False)

    def load_metadata(self):
        with open(self.metadata_path) as f:
            self.metadata = json.load(f)

    def clear_all_outputs(self):
        # remove files
        for jsonl_file in glob.glob(os.path.join(self.dir, "files/*.jsonl")):
            os.remove(jsonl_file)

        self.db["status"] = ExampleStatus.FREE
        self.db["annotator_id"] = ""
        self.db["start"] = None
        self.db["end"] = None
        self.update_db(self.db)

        self.metadata["status"] = CampaignStatus.IDLE
        self.update_metadata()

    def clear_output_by_idx(self, db_idx):
        self.db.loc[db_idx, "status"] = ExampleStatus.FREE
        self.db.loc[db_idx, "annotator_id"] = ""
        self.db.loc[db_idx, "start"] = None
        self.db.loc[db_idx, "end"] = None

        self.update_db(self.db)

        if self.metadata.get("status") == CampaignStatus.FINISHED:
            self.metadata["status"] = CampaignStatus.IDLE
            self.update_metadata()

        # remove any outputs from JSONL files
        dataset = self.db.loc[db_idx, "dataset"]
        split = self.db.loc[db_idx, "split"]
        setup_id = self.db.loc[db_idx, "setup_id"]
        example_idx = self.db.loc[db_idx, "example_idx"]

        for jsonl_file in glob.glob(os.path.join(self.dir, "files/*.jsonl")):
            with open(jsonl_file, "r") as f:
                lines = f.readlines()

            with open(jsonl_file, "w") as f:
                for line in lines:
                    data = json.loads(line)
                    if not (
                        data["dataset"] == dataset
                        and data["split"] == split
                        and data.get("setup_id") == setup_id
                        and data["example_idx"] == example_idx
                        and data["metadata"].get("annotator_group", 0) == self.db.loc[db_idx, "annotator_group"]
                    ):
                        f.write(line)

        logger.info(f"Cleared outputs and assignments for {db_idx}")


class ExternalCampaign(Campaign):
    def get_stats(self):
        return {}


class HumanCampaign(Campaign):
    def __init__(self, campaign_id, scheduler, lock=None):
        super().__init__(campaign_id)
        self.lock = lock

        scheduler.add_job(
            self.check_idle_time, "interval", minutes=1, id=f"idle_time_{self.campaign_id}", replace_existing=True
        )

    def check_idle_time(self):
        if self.lock is None:
            return

        with self.lock:
            self.load_db()
            current_time = datetime.now()
            idle_indexes = []

            for _, example in self.db.iterrows():
                if (
                    example.status == ExampleStatus.ASSIGNED
                    and (current_time - datetime.fromtimestamp(example.start)).total_seconds()
                    > self.metadata["config"]["idle_time"] * 60
                ):
                    idle_indexes.append(example.name)

            for db_index in idle_indexes:
                example = self.db.loc[db_index]
                logger.info(f"Freeing example {example.example_idx} for {self.campaign_id} due to idle time")
                self.clear_output_by_idx(db_index)

    def get_stats(self):
        overview = self.get_overview()
        if not overview:
            return {
                "total": 0,
                "assigned": 0,
                "finished": 0,
                "free": 0,
            }
        batch_stats = pd.DataFrame(overview)

        return {
            "total": len(batch_stats),
            "assigned": len(batch_stats[batch_stats["status"] == ExampleStatus.ASSIGNED]),
            "finished": len(batch_stats[batch_stats["status"] == ExampleStatus.FINISHED]),
            "free": len(batch_stats[batch_stats["status"] == ExampleStatus.FREE]),
        }

    def clear_output(self, idx):
        self.load_db()
        examples_for_batch = self.db[self.db["batch_idx"] == idx]

        for _, example in examples_for_batch.iterrows():
            db_index = example.name
            self.clear_output_by_idx(db_index)

    @staticmethod
    def _batch_status(statuses):
        normalized = [str(status) for status in statuses if pd.notnull(status) and str(status)]
        if not normalized:
            return ExampleStatus.FREE
        if all(status == ExampleStatus.FINISHED for status in normalized):
            return ExampleStatus.FINISHED
        if any(status in {ExampleStatus.ASSIGNED, ExampleStatus.FINISHED} for status in normalized):
            return ExampleStatus.ASSIGNED
        return ExampleStatus.FREE

    @staticmethod
    def _first_non_empty(values):
        for value in values:
            if pd.notnull(value) and str(value):
                return value
        return ""

    def get_overview(self):
        self.load_db()
        df = self.db.copy()

        # Group by batch_idx and annotator_group
        if "batch_idx" not in df.columns:
            df["batch_idx"] = df["example_idx"]

        # Keep timestamps numeric while aggregating. Replacing missing values
        # with "" before min/max makes pandas compare strings with floats when
        # a batch mixes finished and unfinished setup rows.
        for col in ["start", "end"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        grouped = df.groupby(["batch_idx"])

        # Aggregate the necessary columns
        overview_df = grouped.agg(
            example_list=pd.NamedAgg(
                column="example_idx",
                aggfunc=lambda x: x.index.map(
                    lambda idx: {
                        "dataset": df.at[idx, "dataset"],
                        "split": df.at[idx, "split"],
                        "setup_id": df.at[idx, "setup_id"],
                        "example_idx": df.at[idx, "example_idx"],
                        "annotator_group": df.at[idx, "annotator_group"],
                        "status": df.at[idx, "status"],
                    }
                ).tolist(),
            ),
            example_cnt=pd.NamedAgg(column="example_idx", aggfunc="count"),
            finished_cnt=pd.NamedAgg(column="status", aggfunc=lambda x: int((x == ExampleStatus.FINISHED).sum())),
            assigned_cnt=pd.NamedAgg(column="status", aggfunc=lambda x: int((x == ExampleStatus.ASSIGNED).sum())),
            free_cnt=pd.NamedAgg(column="status", aggfunc=lambda x: int((x == ExampleStatus.FREE).sum())),
            status=pd.NamedAgg(column="status", aggfunc=self._batch_status),
            annotator_id=pd.NamedAgg(column="annotator_id", aggfunc=self._first_non_empty),
            start=pd.NamedAgg(column="start", aggfunc="min"),
            end=pd.NamedAgg(column="end", aggfunc="max"),
        ).reset_index()

        # replace NaN with empty string for rendering after numeric aggregation
        overview_df = overview_df.where(pd.notnull(overview_df), "")

        for col in ["status", "annotator_id"]:
            overview_df[col] = overview_df[col].astype(df[col].dtype)

        return overview_df.to_dict(orient="records")


class LLMCampaign(Campaign):
    def get_stats(self):
        return {
            "total": len(self.db),
            "finished": len(self.db[self.db["status"] == ExampleStatus.FINISHED]),
            "free": len(self.db[self.db["status"] == ExampleStatus.FREE]),
        }

    def clear_output(self, idx):
        example_row = self.db[self.db["example_idx"] == idx].iloc[0]
        db_idx = example_row.name
        self.clear_output_by_idx(db_idx)


class LLMCampaignEval(LLMCampaign):
    def get_overview(self):
        self.load_db()
        overview_db = self.db.copy()
        overview_db["output"] = ""

        # get the finished examples
        finished_examples = self.get_finished_examples()
        example_index = {
            (ex["dataset"], ex["split"], ex["setup_id"], ex["example_idx"]): str(ex) for ex in finished_examples
        }
        overview_db["record"] = {}

        for i, row in self.db.iterrows():
            key = (row["dataset"], row["split"], row["setup_id"], row["example_idx"])
            example = ast.literal_eval(example_index.get(key, "{}"))

            annotations = example.get("annotations", [])
            overview_db.at[i, "record"] = str(annotations)

        overview_db = overview_db.to_dict(orient="records")

        return overview_db


class LLMCampaignGen(LLMCampaign):
    # Enables showing the generated outputs on the campaign detail page even though the outputs are not yet exported
    def get_overview(self):
        finished_examples = self.get_finished_examples()

        example_index = {(ex["dataset"], ex["split"], ex["example_idx"]): str(ex) for ex in finished_examples}

        self.load_db()
        overview_db = self.db.copy()
        overview_db["record"] = ""

        for i, row in self.db.iterrows():
            key = (row["dataset"], row["split"], row["example_idx"])
            example = ast.literal_eval(example_index.get(key, "{}"))

            overview_db.at[i, "record"] = str(example.get("output", ""))

        overview_db = overview_db.to_dict(orient="records")
        return overview_db
