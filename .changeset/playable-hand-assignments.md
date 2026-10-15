---
"mizan": patch
---

Make piano hands and guitar and bass tab positions playable. When a transcription asks one hand for more than it can do (more than five keys, a stretch wider than a ninth, hands crossed for too long; two notes on one string, more frets than four fingers cover, a stretch wider than four or five frets, or more notes than strings), Mizan moves the fewest notes to the other hand or to other strings and frets, keeps the written split and positions wherever they already work, and recomputes suggested fingering for moved notes. The score puts moved notes on the other staff, the tab shows the repaired positions, and notes that still cannot be played are marked with a `!`. A small note above the practice view says how many notes changed, lists where, and switches between **Playable** and **As transcribed**. The stored transcription is never changed.
