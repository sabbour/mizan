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


def build_bar_map(total_beats: float, changes: list[dict], pickup: float = 0.0) -> list[dict]:
    """Quarter-note positions are immutable; a change can end a partial measure.

    ``pickup`` beats before the first change are filled backwards with the first meter,
    so an anacrusis becomes a leading partial measure instead of shifting every barline.
    """
    if not _finite(pickup) or pickup < 0:
        raise ValueError("A pickup must be a finite, non-negative beat count.")
    if pickup > 0:
        if not changes or changes[0].get("startBeat") != 0:
            raise ValueError("The bar map's first meter must start at beat zero.")
        if pickup >= total_beats:
            raise ValueError("A pickup must end before the bar map does.")
        first = changes[0]
        nominal = signature_beats(first["numerator"], first["denominator"])
        whole = math.floor(pickup / nominal)
        partial = pickup - whole * nominal
        if partial < 0:
            whole -= 1
            partial += nominal
        lead = ([{"startBeat": 0.0, "beats": partial, "numerator": first["numerator"],
                  "denominator": first["denominator"], "status": first.get("status", "explicit"),
                  "partial": True}] if partial > 0 else [])
        lead.extend({"startBeat": pickup - (whole - index) * nominal, "beats": nominal,
                     "numerator": first["numerator"], "denominator": first["denominator"],
                     "status": first.get("status", "explicit")} for index in range(whole))
        # Bars from the first downbeat onward start exactly at the pickup and end exactly at the extent.
        shifted = [{**change, "startBeat": change["startBeat"] + pickup} for change in changes]
        rest = [bar for bar in build_bar_map(total_beats, [{**first, "startBeat": 0.0}, *shifted])
                if bar["startBeat"] >= pickup]
        return validate_bar_map(lead + rest)
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


def time_at_beat(tempo_map: list[dict] | None, bpm: float, beat: float) -> float:
    """Recording seconds for a score beat, extrapolating exactly like the workspace engine."""
    if not tempo_map:
        return beat * 60 / bpm
    first = tempo_map[0]
    if beat <= first["beat"] or len(tempo_map) == 1:
        return first["time"] + (beat - first["beat"]) * 60 / bpm
    index = min(len(tempo_map) - 1, max(1, bisect_right([point["beat"] for point in tempo_map], beat)))
    left, right = tempo_map[index - 1], tempo_map[index]
    return left["time"] + (beat - left["beat"]) / (right["beat"] - left["beat"]) * (right["time"] - left["time"])


def beat_at_time(tempo_map: list[dict] | None, bpm: float, seconds: float) -> float:
    """Inverse of :func:`time_at_beat`; source seconds stay authoritative."""
    if not tempo_map:
        return seconds * bpm / 60
    first = tempo_map[0]
    if seconds <= first["time"] or len(tempo_map) == 1:
        return first["beat"] + (seconds - first["time"]) * bpm / 60
    index = min(len(tempo_map) - 1, max(1, bisect_right([point["time"] for point in tempo_map], seconds)))
    left, right = tempo_map[index - 1], tempo_map[index]
    return left["beat"] + (seconds - left["time"]) / (right["time"] - left["time"]) * (right["beat"] - left["beat"])
