"""Low-cost, process-scoped CPU and resident memory for the live queue."""

import ctypes
import logging
import os
import sys
import time
from ctypes import wintypes
from threading import Lock

worker_pid: int | None = None
logger = logging.getLogger(__name__)


class _MemoryCounters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
            "PagefileUsage", "PeakPagefileUsage")]


class _ProcessEntry(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
    ]


def _descendant_pids(pid: int) -> set[int] | None:
    if sys.platform != "win32":
        return set()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = (wintypes.DWORD, wintypes.DWORD)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_ProcessEntry))
    kernel.Process32FirstW.restype = wintypes.BOOL
    kernel.Process32NextW.argtypes = (wintypes.HANDLE, ctypes.POINTER(_ProcessEntry))
    kernel.Process32NextW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(0x2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        logger.warning("Could not enumerate transcription worker processes: %s", ctypes.WinError(ctypes.get_last_error()))
        return None
    try:
        entry = _ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        if not kernel.Process32FirstW(snapshot, ctypes.byref(entry)):
            logger.warning("Could not read transcription worker processes: %s", ctypes.WinError(ctypes.get_last_error()))
            return None
        children: dict[int, list[int]] = {}
        while True:
            children.setdefault(entry.th32ParentProcessID, []).append(entry.th32ProcessID)
            if not kernel.Process32NextW(snapshot, ctypes.byref(entry)):
                error = ctypes.get_last_error()
                if error != 18:  # ERROR_NO_MORE_FILES
                    logger.warning("Could not finish enumerating transcription worker processes: %s", ctypes.WinError(error))
                    return None
                break
        found: set[int] = set()
        pending = [pid]
        while pending:
            for child in children.get(pending.pop(), []):
                if child not in found and child != pid:
                    found.add(child)
                    pending.append(child)
        return found
    finally:
        kernel.CloseHandle(snapshot)


def _process_stats(pid: int) -> tuple[float | None, int | None]:
    if sys.platform != "win32":
        return None, None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = (wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_void_p, ctypes.c_void_p)
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.CloseHandle.restype = wintypes.BOOL
    psapi.GetProcessMemoryInfo.argtypes = (wintypes.HANDLE, ctypes.POINTER(_MemoryCounters), wintypes.DWORD)
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x1010, False, pid)  # QUERY_LIMITED_INFORMATION | VM_READ
    if not handle:
        return None, None
    try:
        created, exited, system, user = (ctypes.c_ulonglong() for _ in range(4))
        cpu = ((system.value + user.value) / 10_000_000
               if kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                         ctypes.byref(system), ctypes.byref(user)) else None)
        counters = _MemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        ram = (counters.WorkingSetSize if psapi.GetProcessMemoryInfo(
            handle, ctypes.byref(counters), counters.cb) else None)
        return cpu, ram
    finally:
        kernel.CloseHandle(handle)


class UsageSampler:
    def __init__(self):
        self._lock = Lock()
        self._last_time = 0.0
        self._previous: dict[int, float] = {}
        self._cpu: int | None = None
        self._ram_bytes: int | None = None

    def read(self, running: bool) -> dict[str, int | None] | None:
        with self._lock:
            if not running:
                self._last_time = 0
                self._previous = {}
                self._cpu = None
                self._ram_bytes = None
                return None
            now = time.monotonic()
            if now - self._last_time >= 2:
                descendants = _descendant_pids(worker_pid) if worker_pid else set()
                if descendants is None:
                    self._cpu = self._ram_bytes = None
                    self._previous = {}
                    self._last_time = now
                    return {"cpu": None, "ramBytes": None, "gpu": None, "npu": None}
                pids = (os.getpid(),) + ((worker_pid, *sorted(descendants)) if worker_pid else ())
                stats = {pid: _process_stats(pid) for pid in pids}
                current = {pid: cpu for pid, (cpu, _) in stats.items() if cpu is not None}
                self._ram_bytes = (sum(ram for _, ram in stats.values() if ram is not None)
                                   if all(ram is not None for _, ram in stats.values()) else None)
                elapsed = now - self._last_time
                if self._previous and 0 < elapsed <= 5 and current:
                    delta = sum(max(0, value - self._previous[pid])
                                for pid, value in current.items() if pid in self._previous)
                    self._cpu = min(100, round(100 * delta / (elapsed * (os.cpu_count() or 1))))
                else:
                    self._cpu = None
                self._previous = current
                self._last_time = now
            return {"cpu": self._cpu, "ramBytes": self._ram_bytes, "gpu": None, "npu": None}
