import math
from bisect import bisect_right


def _finite(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def signature_beats(numerator: int, denominator: int) -> float:
    if (type(numerator) is not int or numerator <= 0
            or type(denominator) is not int or denominator <= 0
            or denominator & (denominator - 1)):
        raise ValueError("A time signature requires a positive numerator and a power-of-two denominator.")
    return numerator * 4 / denominator


def validate_bar_map(value: list[dict]) -> list[dict]:
    if not isinstance(value, list) or not value:
        raise ValueError("The bar map must contain at least one measure.")
    end = 0.0
    for bar in value:
        if not isinstance(bar, dict):
            raise ValueError("The bar map contains an invalid measure.")
        start, beats = bar.get("startBeat"), bar.get("beats")
        numerator, denominator = bar.get("numerator"), bar.get("denominator")
        if (not _finite(start) or not _finite(beats) or beats <= 0
                or not math.isclose(start, end, abs_tol=1e-6, rel_tol=0)
                or type(numerator) is not int or numerator <= 0
                or type(denominator) is not int or denominator <= 0
                or denominator & (denominator - 1)):
            raise ValueError("The bar map requires contiguous positive measures and valid time signatures.")
        nominal = signature_beats(numerator, denominator)
        if (not bar.get("partial") and not math.isclose(beats, nominal, abs_tol=1e-6, rel_tol=0)
                or bar.get("partial") and beats > nominal + 1e-6):
            raise ValueError("A measure's duration does not match its time signature.")
        if bar.get("status", "explicit") not in ("explicit", "supported", "unverified"):
            raise ValueError("The bar map contains an invalid meter status.")
        end = start + beats
    return value


def build_bar_map(total_beats: float, changes: list[dict]) -> list[dict]:
    """Quarter-note positions are immutable; a change can end a partial measure."""
    if not _finite(total_beats) or total_beats <= 0 or not changes:
        raise ValueError("A bar map requires a positive duration and a starting meter.")
    points = []
    for change in changes:
        start = change.get("startBeat")
        if not _finite(start) or start < 0 or points and start <= points[-1]["startBeat"]:
            raise ValueError("Meter changes must be finite and strictly ordered.")
        numerator, denominator = change.get("numerator"), change.get("denominator")
        nominal = signature_beats(numerator, denominator)
        validate_bar_map([{"startBeat": 0, "beats": nominal,
                           "numerator": numerator, "denominator": denominator}])
        points.append(change)
    if points[0]["startBeat"] != 0:
        raise ValueError("The bar map's first meter must start at beat zero.")
    result = []
    for index, point in enumerate(points):
        start = point["startBeat"]
        stop = min(total_beats, points[index + 1]["startBeat"] if index + 1 < len(points) else total_beats)
        nominal = point["numerator"] * 4 / point["denominator"]
        while start < stop:
            length = min(nominal, stop - start)
            result.append({
                "startBeat": start, "beats": length,
                "numerator": point["numerator"], "denominator": point["denominator"],
                "status": point.get("status", "explicit"),
                **({"partial": True} if length < nominal - 1e-6 else {}),
            })
            start += length
    return validate_bar_map(result)


def song_bar_map(song: dict) -> list[dict]:
    if "barMap" in song:
        result = validate_bar_map(song["barMap"])
        if len(result) != song["bars"]:
            raise ValueError("The song's bar count does not match its bar map.")
        return result
    unit = song.get("beatUnit", 4)
    length = song["beatsPerBar"]
    return validate_bar_map([
        {"startBeat": index * length, "beats": length,
         "numerator": round(length * unit / 4), "denominator": unit}
        for index in range(song["bars"])
    ])


def bar_index(bars: list[dict], beat: float) -> int:
    return min(len(bars) - 1, max(0, bisect_right([bar["startBeat"] for bar in bars], beat) - 1))


def total_beats(song: dict) -> float:
    bars = song_bar_map(song)
    return bars[-1]["startBeat"] + bars[-1]["beats"]
