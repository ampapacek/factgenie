# conftest.py
import shutil

import pytest

from factgenie import MAIN_CONFIG_PATH


@pytest.fixture(scope="session", autouse=True)
def prepare_testing_config():
    # Run the suite against the template config, then restore the original file afterward.
    original_config = MAIN_CONFIG_PATH.read_bytes() if MAIN_CONFIG_PATH.exists() else None
    shutil.copy(MAIN_CONFIG_PATH.with_name("config_TEMPLATE.yml"), MAIN_CONFIG_PATH)
    assert MAIN_CONFIG_PATH.exists()
    try:
        yield
    finally:
        if original_config is None:
            MAIN_CONFIG_PATH.unlink(missing_ok=True)
        else:
            MAIN_CONFIG_PATH.write_bytes(original_config)
