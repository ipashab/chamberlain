/**
 * The pytest reporter the debug panel injects into pytest runs.
 *
 * The service writes this source into the run's temp directory, prepends that
 * directory to PYTHONPATH and adds `-p openchamber_pytest_reporter` to the
 * pytest arguments. Inside the process the plugin appends JSONL events to the
 * file named by OPENCHAMBER_DEBUG_EVENTS; with that variable absent (the
 * plugin reached a plain terminal run through a leftover PYTHONPATH, say) it
 * stays completely inert.
 *
 * Keeping the source as a string here rather than a sibling .py file is what
 * makes it survive the bundled desktop packaging: nothing but JS ships.
 */

export const PYTEST_REPORTER_PLUGIN = `"""Pytest reporter streaming results to the OpenChamber debug panel.

Loaded via -p when the debug panel launches pytest. Events (collection, test
started, merged per-test result) are appended as JSONL to the file named by
OPENCHAMBER_DEBUG_EVENTS; without that variable the plugin does nothing.
"""

import json
import os

_EVENTS_PATH = os.environ.get("OPENCHAMBER_DEBUG_EVENTS")

# Slightly under the server's caps so the clipping marker survives the trip.
_MAX_LOG_CHARS = 60_000
_MAX_ERROR_CHARS = 30_000

# Worst first: a failed test must outrank its own skipped teardown.
_STATUS_PRECEDENCE = ("error", "failed", "skipped", "passed")

_states = {}


def _emit(event):
    if not _EVENTS_PATH:
        return
    try:
        with open(_EVENTS_PATH, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\\n")
    except OSError:
        # The run matters more than the report about it.
        pass


def _clip(value, limit):
    value = value.strip()
    return value if len(value) <= limit else value[:limit] + "\\n…"


def _report_error(report):
    """The failure text exactly as pytest would print it."""
    if report.longrepr is None:
        return None
    # A plain skip carries its reason as a (path, lineno, reason) tuple.
    if isinstance(report.longrepr, tuple) and len(report.longrepr) == 3:
        location, line, reason = report.longrepr
        return _clip(f"{location}:{line}: {reason}", _MAX_ERROR_CHARS)
    try:
        import io

        from _pytest._io import TerminalWriter

        buffer = io.StringIO()
        writer = TerminalWriter()
        # The attribute is steadier across pytest versions than the
        # constructor's argument name ever was.
        writer._file = buffer
        text = report.longrepr.toterminal(writer)
        if text and text.strip():
            return _clip(text, _MAX_ERROR_CHARS)
    except Exception:
        # Never break the reporting machinery over one report's shape;
        # the plain str() below still gives the crash line.
        pass
    try:
        text = str(report.longrepr)
    except Exception:
        return None
    return _clip(text, _MAX_ERROR_CHARS) if text and text.strip() else None


def _sections(report):
    chunks = []
    for title, content in getattr(report, "sections", []):
        content = (content or "").strip()
        if content:
            chunks.append(f"--- {title} ---\\n{content}")
    return chunks


def pytest_collection_finish(session):
    _emit({"type": "collected", "nodeIds": [item.nodeid for item in session.items]})


def pytest_runtest_logstart(nodeid, location):
    _states[nodeid] = {"durations": [], "status": "passed", "log": [], "error": None}
    _emit({"type": "started", "nodeId": nodeid})


def pytest_runtest_logreport(report):
    state = _states.get(report.nodeid)
    if state is None:
        return
    state["durations"].append(report.duration)
    status = None
    if report.outcome == "failed":
        status = "failed" if report.when == "call" else "error"
    elif report.outcome == "skipped":
        status = "skipped"
    if status is not None:
        if _STATUS_PRECEDENCE.index(status) < _STATUS_PRECEDENCE.index(state["status"]):
            state["status"] = status
        if state["error"] is None:
            # For a skip this carries the reason line, which is worth showing.
            state["error"] = _report_error(report)
    # The teardown report restates every earlier stage's captured sections;
    # reading it too would print the test log twice.
    if report.when != "teardown":
        state["log"].extend(_sections(report))


def pytest_runtest_logfinish(nodeid, location):
    state = _states.pop(nodeid, None)
    if state is None:
        return
    log = "\\n\\n".join(state["log"])
    _emit(
        {
            "type": "result",
            "nodeId": nodeid,
            "status": state["status"],
            "durationMs": int(round(sum(state["durations"]) * 1000)),
            "log": _clip(log, _MAX_LOG_CHARS) if log.strip() else None,
            "error": state["error"],
        }
    )
`;
