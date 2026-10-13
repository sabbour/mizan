from threading import Event, Thread

import pytest

from mizan import aws_cloud
from mizan.api import Api
from mizan.cloud_state import CloudOperations
from mizan.errors import Cancelled, MizanError


def test_setup_progress_and_state_are_provider_local():
    aws = CloudOperations("aws")
    gcp = CloudOperations("gcp")
    with aws.track_setup("configure", 2):
        aws.step("identity", 1, "Creating the job identity.")
        assert aws.setup_progress() == {
            "operation": "configure", "stage": "identity", "completed": 1,
            "total": 2, "detail": "Creating the job identity.",
        }
        assert gcp.setup_progress() == {
            "operation": None, "stage": "idle", "completed": 0,
            "total": 0, "detail": None,
        }
        assert gcp.cancel_setup() == {"cancelRequested": False}
    assert aws.setup_progress() == {
        "operation": "configure", "stage": "completed", "completed": 2,
        "total": 2, "detail": None,
    }


def test_only_active_provisioning_can_be_cancelled():
    aws = CloudOperations("aws")
    entered = Event()
    proceed = Event()
    cancelled = Event()

    def provision():
        try:
            with aws.track_setup("provision", 1):
                entered.set()
                proceed.wait(1)
                aws.check_cancelled()
        except Cancelled:
            cancelled.set()

    thread = Thread(target=provision)
    thread.start()
    assert entered.wait(1)
    assert aws.cancel_setup() == {"cancelRequested": True}
    proceed.set()
    thread.join(1)

    assert cancelled.is_set()
    assert not thread.is_alive()
    assert aws.setup_progress()["stage"] == "failed"
    assert aws.cancel_setup() == {"cancelRequested": False}


def test_setup_reenters_only_for_same_owner_and_operation():
    state = CloudOperations("aws")
    with state.track_setup("provision", 10):
        state.step("resources", 3, "Creating resources.")
        with state.track_setup("provision", 7):
            assert state.setup_progress() == {
                "operation": "provision", "stage": "resources", "completed": 3,
                "total": 10, "detail": "Creating resources.",
            }
            state.step("identity", 4, "Creating the job identity.")
        assert state.setup_progress() == {
            "operation": "provision", "stage": "identity", "completed": 4,
            "total": 10, "detail": "Creating the job identity.",
        }
    assert state.setup_progress() == {
        "operation": "provision", "stage": "completed", "completed": 10,
        "total": 10, "detail": None,
    }


def test_setup_rejects_different_operation_on_same_owner():
    state = CloudOperations("aws")
    with state.track_setup("provision", 10):
        with pytest.raises(MizanError, match="already in progress"):
            with state.track_setup("configure", 7):
                pytest.fail("Different setup operation entered.")
        assert state.setup_progress() == {
            "operation": "provision", "stage": "starting", "completed": 0,
            "total": 10, "detail": None,
        }


def test_setup_rejects_reentry_from_another_owner():
    state = CloudOperations("aws")
    entered = Event()
    finish = Event()
    result = {}

    def outer_setup():
        with state.track_setup("provision", 10):
            entered.set()
            finish.wait(1)

    def other_owner():
        with pytest.raises(MizanError, match="already in progress") as error:
            with state.track_setup("provision", 7):
                pytest.fail("A different thread entered setup.")
        result["error"] = str(error.value)

    owner = Thread(target=outer_setup)
    owner.start()
    assert entered.wait(1)
    other = Thread(target=other_owner)
    other.start()
    other.join(1)
    finish.set()
    owner.join(1)

    assert not other.is_alive()
    assert not owner.is_alive()
    assert "already in progress" in result["error"]
    assert state.setup_progress()["total"] == 10


def test_api_prepare_wrapper_allows_provider_setup_reentry(monkeypatch):
    state = CloudOperations("aws")
    monkeypatch.setattr(aws_cloud, "state", state)

    def prepare(_config, _consent):
        with aws_cloud.track_setup("provision", 7):
            aws_cloud._step("resources", 4, "Creating AWS resources.")
            assert state.setup_progress() == {
                "operation": "provision", "stage": "resources", "completed": 4,
                "total": 10, "detail": "Creating AWS resources.",
            }
        return {"ok": True, "provider": "aws"}

    monkeypatch.setattr(aws_cloud, "prepare", prepare)

    result = Api.__new__(Api).prepare_cloud({"provider": "aws"}, consent=True)

    assert result["ok"] is True
    assert result["provider"] == "aws"
    assert state.setup_progress() == {
        "operation": "provision", "stage": "completed", "completed": 10,
        "total": 10, "detail": None,
    }


def test_readiness_cancellation_blocks_late_success_and_is_request_local():
    gcp = CloudOperations("gcp")
    aws = CloudOperations("aws")
    entered = Event()
    finish = Event()
    result = {}
    received = {}

    def slow_check(cancelled):
        assert not cancelled.is_set()
        received["event"] = cancelled
        entered.set()
        finish.wait(1)
        return {"configured": True}

    thread = Thread(target=lambda: result.setdefault(
        "status", gcp.panel_status("request-1", slow_check)))
    thread.start()
    assert entered.wait(1)
    assert gcp.cancel_panel_status("request-1") == {"cancelRequested": True}
    assert aws.cancel_panel_status("request-1") == {"cancelRequested": False}
    assert received["event"].is_set()
    finish.set()
    thread.join(1)

    assert not thread.is_alive()
    assert result["status"] == {"issue": "The Google Cloud readiness check was cancelled."}
    assert gcp.readiness_progress("request-1") == {
        "stage": "cancelled",
        "detail": "The read-only access check was cancelled.",
        "elapsedSeconds": gcp.readiness_progress("request-1")["elapsedSeconds"],
        "timeoutSeconds": 120,
    }


def test_pre_cancelled_readiness_does_not_call_the_provider():
    state = CloudOperations("aws")
    calls = []
    state.cancel_panel_status("request-2")

    result = state.panel_status("request-2", lambda event: calls.append(event))

    assert result == {"issue": "The AWS readiness check was cancelled."}
    assert calls == []


def test_cancel_readiness_rejects_an_invalid_request_id():
    state = CloudOperations("gcp")

    with pytest.raises(MizanError, match="Google Cloud readiness request ID is invalid"):
        state.cancel_panel_status("")


def test_readiness_timeout_sets_cancel_event_and_keeps_timeout_progress():
    state = CloudOperations("aws", readiness_timeout=0.02)
    entered = Event()
    cancelled = Event()
    finish = Event()
    result = {}

    def late_check(event):
        entered.set()
        finish.wait(1)
        cancelled.set() if event.is_set() else None
        return {"configured": True}

    thread = Thread(target=lambda: result.setdefault(
        "status", state.panel_status("request-3", late_check)))
    thread.start()
    assert entered.wait(1)
    thread.join(1)
    assert not thread.is_alive()
    finish.set()

    assert cancelled.wait(1)
    assert result["status"] == {"issue": "The AWS readiness check timed out."}
    assert state.readiness_progress("request-3") == {
        "stage": "timed out",
        "detail": "The read-only access check timed out.",
        "elapsedSeconds": state.readiness_progress("request-3")["elapsedSeconds"],
        "timeoutSeconds": 0.02,
    }


def test_readiness_progress_shape_matches_bridge():
    state = CloudOperations("aws")
    assert state.readiness_progress("unknown") == {
        "stage": "idle", "detail": None, "elapsedSeconds": 0, "timeoutSeconds": 120,
    }
