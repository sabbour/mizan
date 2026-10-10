/**
 * Inspired lessons grouped by artist: the artists ordered by their most approachable study, and each artist's studies
 * in learning order (level, then title). The same order drives the lists and Previous and Next.
 */

type Inspired = { artist?: string; style?: string; influence?: string; level: number; title: string }

/** The artist a study is grouped under: its `artist`, else the name before the track in its credit. */
export const artistOf = (lesson: Inspired) =>
  lesson.artist ?? (lesson.influence ?? lesson.style ?? '').replace(/^Inspired by /, '').split(' — ')[0]

export function byArtist<T extends Inspired>(lessons: T[]): { artist: string; lessons: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const lesson of lessons) groups.set(artistOf(lesson), [...groups.get(artistOf(lesson)) ?? [], lesson])
  const ordered = [...groups].map(([artist, list]) => ({
    artist, lessons: [...list].sort((a, b) => a.level - b.level || a.title.localeCompare(b.title)),
  }))
  return ordered.sort((a, b) => a.lessons[0].level - b.lessons[0].level || a.artist.localeCompare(b.artist))
}

/** Every study in the grouped order: artist by artist, each in learning order. */
export const inspiredOrder = <T extends Inspired>(lessons: T[]) => byArtist(lessons).flatMap((group) => group.lessons)
