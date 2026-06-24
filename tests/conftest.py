import pytest
from matchmaker.server import create_app

DATA_ROOT = "/Volumes/T7/Documents/2026_06MatchMaker/data/external"


@pytest.fixture
def app(tmp_path):
    application = create_app(str(tmp_path))
    application.config["TESTING"] = True
    return application


@pytest.fixture
def client(app):
    return app.test_client()
