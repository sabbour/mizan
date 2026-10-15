---
"mizan": patch
---

Keep the 3D fretting hand on the current note. Hand poses for the coming notes are now prepared ahead of the playhead for the whole upcoming part of the song, in time order and one pose per grip, instead of only the next four notes, and the pose solver finds a usable pose far faster (about 0.1 s instead of up to several seconds for a stretched grip). Grips that the remembered fingers would stretch too far, or that give an impossible barre, are planned again so the hand can reach them, and the markers and finger colours always match the pose that is drawn. On a fast let-ring arpeggio the hand no longer shows the previous note's pose.
