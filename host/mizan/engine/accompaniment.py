from itertools import product
import math

from ..meter import bar_index, song_bar_map

def voice_chord(tones: list[int], previous: list[int] | None = None) -> list[int]:
    pcs = sorted({tone % 12 for tone in tones})
    if not pcs:
        return []
    choices = [[note for note in range(60, 85) if note % 12 == pc] for pc in pcs]
    candidates = [sorted(notes) for notes in product(*choices) if max(notes) - min(notes) <= 12]
    reference = previous or [64, 67, 72]

    def cost(notes):
        if len(notes) == len(reference):
            distance = sum(abs(note - other) for note, other in zip(notes, sorted(reference)))
        else:
            distance = sum(min(abs(note - other) for other in reference) for note in notes)
            distance += sum(min(abs(note - other) for other in notes) for note in reference)
        return distance, abs(sum(notes) / len(notes) - 70), notes

    return min(candidates, key=cost)


def generate_accompaniment(harmony: dict) -> list[dict]:
    notes = []
    previous = None
    bar_map = song_bar_map(harmony) if "bars" in harmony else None
    beats_per_bar = harmony.get("beatsPerBar", 4)
    for chord in harmony["chords"]:
        if chord["symbol"] in (None, "N.C.") or not chord["tones"]:
            continue
        voiced = voice_chord(chord["tones"], previous)
        previous = voiced
        root = 36 + chord["tones"][0] % 12
        position = chord["startBeat"]
        end = position + chord["beats"]
        if bar_map:
            map_end = bar_map[-1]["startBeat"] + bar_map[-1]["beats"]
            if end <= map_end + 1e-6:
                end = min(end, map_end)
        while position < end - 1e-8:
            index = bar_index(bar_map, position) if bar_map else math.floor(position / beats_per_bar)
            bar_end = (bar_map[index]["startBeat"] + bar_map[index]["beats"] if bar_map else
                       (index + 1) * beats_per_bar)
            length = min(end, bar_end) - position
            if length <= 1e-8:
                raise ValueError("Generated accompaniment extends beyond the bar map.")
            section = next((i for i, section in enumerate(harmony["sections"])
                            if section["startBar"] - 1 <= index < section["startBar"] - 1 + section["bars"]), 0)
            energy = harmony["sectionEnergy"][section] if harmony["sectionEnergy"] else 0
            style = "block" if energy < 0.35 else "arpeggio" if energy < 0.7 else "pop"

            def add(midi, offset, duration, hand):
                if offset < length:
                    notes.append({"midi": midi, "startBeat": round(position + offset, 6),
                                  "beats": round(min(duration, length - offset), 6), "hand": hand,
                                  "velocity": 0.65 if hand == "right" else 0.55,
                                  "confidence": chord["confidence"], "generated": True, "style": style})

            if style == "block":
                add(root, 0, length, "left")
                add(root + 7, 0, length, "left")
                for pitch in voiced:
                    add(pitch, 0, length, "right")
            else:
                left = ((0, root), (1, root + 7), (2, root + 12), (3, root + 7))
                for offset, pitch in left:
                    add(pitch, offset, min(1, length - offset), "left")
                if style == "arpeggio":
                    for step in range(math.ceil(length * 2)):
                        add(voiced[step % len(voiced)], step / 2, 0.5, "right")
                else:
                    offsets = (0, 1.5, 2.5, 3.5)
                    for index, offset in enumerate(offsets):
                        duration = (offsets[index + 1] if index + 1 < len(offsets) else length) - offset
                        for pitch in voiced:
                            add(pitch, offset, duration, "right")
            position += length
    return sorted(notes, key=lambda note: (note["startBeat"], note["midi"]))
