from mizan import telemetry
from mizan.api import Api


def test_sampler_is_throttled_and_counts_worker(monkeypatch):
    clock = [10.0]
    ticks = {123: (1.0, 100), 456: (2.0, 200), 789: (3.0, 700)}
    calls = []

    def stats(pid):
        calls.append(pid)
        return ticks[pid]

    monkeypatch.setattr(telemetry.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(telemetry.os, "getpid", lambda: 123)
    monkeypatch.setattr(telemetry.os, "cpu_count", lambda: 2)
    monkeypatch.setattr(telemetry, "worker_pid", 456)
    monkeypatch.setattr(telemetry, "_descendant_pids", lambda pid: {789})
    monkeypatch.setattr(telemetry, "_process_stats", stats)
    sampler = telemetry.UsageSampler()
    assert sampler.read(True) == {"cpu": None, "ramBytes": 1000, "gpu": None, "npu": None}
    clock[0] += 1
    assert sampler.read(True)["cpu"] is None
    assert calls == [123, 456, 789]
    clock[0] += 1
    ticks.update({123: (1.5, 150), 456: (3.5, 250), 789: (4.0, 1000)})
    assert sampler.read(True) == {"cpu": 75, "ramBytes": 1400, "gpu": None, "npu": None}
    assert calls == [123, 456, 789, 123, 456, 789]
    assert sampler.read(False) is None
    assert sampler.read(True)["cpu"] is None
    clock[0] += 6
    assert sampler.read(True)["cpu"] is None
    ticks[456] = (3.5, None)
    clock[0] += 2
    assert sampler.read(True)["ramBytes"] is None


def test_api_samples_only_while_running(monkeypatch):
    class Store:
        @staticmethod
        def list_queue():
            return [{"status": "queued"}, {"status": "running"}]

    class Runner:
        store = Store()
        library = None

    api = Api(Runner())
    running = []
    monkeypatch.setattr(api._usage, "read", lambda value: running.append(value) or
                        ({"cpu": 3, "ramBytes": 120, "gpu": None, "npu": None} if value else None))
    assert api.resource_usage() == {"ok": True, "usage": {"cpu": 3, "ramBytes": 120, "gpu": None, "npu": None}}
    monkeypatch.setattr(Store, "list_queue", lambda self: [{"status": "queued"}])
    assert api.resource_usage() == {"ok": True, "usage": None}
    assert running == [True, False]
