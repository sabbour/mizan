import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Engine } from './engine'
import { useFrame } from './hooks'
import { chordsXml, drumXml, instrumentXml, pianoXml, vocalXml } from './musicxml'
import { Score } from './Score'
import { barAt, barStart, measures } from './meter'
import { buildSong, chordAt, hasPitchedScore, invert, sectionAt, slash, smoothInversions, type Instrument, type Song, type Track } from './song'
import type { Position, Stem } from '../library/bridge'
import { ArrowLeft } from 'lucide-react'
import { creativeTracks, HARMONY_DEFAULT, type HarmonyOptions } from './creative'
import { HarmonyLineView } from './HarmonyLineView'
import { Transport } from './Transport'
import { TrackPicker } from './TrackPicker'
import { ChordView, type ChordMode } from './ChordView'
import { PracticeViewPicker, type PracticeView } from './PracticeViewPicker'
import { ChordChart } from './ChordChart'
import { DrumKitView } from './DrumKitView'
import { DEFAULT_KIT_STYLE, loadPrefs, savePref, type KitStyle } from './prefs'
import { stickingFor } from './sticking'
import './workspace.css'

type Loop = { startBar: number; endBar: number } | null

type Props = {
  song?: Song
  songId?: string
  stems?: Stem[]
  /** Where practice left off last time. */
  start?: Position | null
  note?: string
  onPosition?: (p: Position) => void
  onBack?: () => void
  onDeleteTrack?: (trackId: string) => Promise<void>
  analysisNotice?: ReactNode
  /** Starting choices for this song only, e.g. a drum lesson opens with the click on and the 3D kit. */
  defaults?: { click?: boolean; drums?: PracticeView }
}

const DEMO = buildSong()
const EMPTY_STEMS: Stem[] = []

type StoredMixer = { muted: string[]; volumes: Record<string, number>; soloId?: string; beforeSolo?: string[]; enabledStems?: string[] }

export function Workspace({
  song = DEMO, songId = 'demo', stems = EMPTY_STEMS, start: saved = null, note = 'Draft transcription · synthetic demo', onPosition, onBack, onDeleteTrack, analysisNotice, defaults,
}: Props) {
  const visibleStems = stems
  const engine = useMemo(() => new Engine(song, visibleStems), [song, visibleStems])
  // A position saved before re-analysis can name bars this song no longer has (a 158-bar 4/4
  // reading re-analysed as 89 bars of 6/4); resume within this song's bars instead.
  const start = useMemo(() => saved && {
    ...saved,
    bar: Math.min(Math.max(1, saved.bar), song.bars),
    loop: saved.loop && saved.loop.startBar >= 1 && saved.loop.startBar <= saved.loop.endBar &&
      saved.loop.endBar <= song.bars ? saved.loop : null,
  }, [saved, song.bars])

  const [trackId, setTrackId] = useState(() => start?.trackId ?? song.tracks[0]?.id ?? '')
  // Count-in, speed, click and sticking letters follow the player everywhere once chosen; until then, this song's own setup.
  const [prefs] = useState(loadPrefs)
  const [rate, setRate] = useState(prefs.rate ?? start?.rate ?? 1)
  const [loop, setLoop] = useState<Loop>(start?.loop ?? null)
  const [countIn, setCountIn] = useState(prefs.countIn ?? true)
  const [click, setClick] = useState(prefs.click ?? defaults?.click ?? false)
  const [showSticking, setShowSticking] = useState(prefs.sticking ?? true)
  const [kitStyle, setKitStyle] = useState<KitStyle>(prefs.kitStyle ?? DEFAULT_KIT_STYLE)
  // Chord style and voicing belong to the Chords track; the other tracks always show chord names.
  const [chordMode, setChordMode] = useState<ChordMode>('names')
  // A view choice only; it never touches the engine, so playback, mixer and position carry on.
  const [practice, setPractice] = useState<{ piano: PracticeView; drums: PracticeView }>({ piano: 'score', drums: defaults?.drums ?? 'score' })
  const [noteNames, setNoteNames] = useState(false)
  const [smooth, setSmooth] = useState(false)
  // The accompaniment as played: with smooth voicing, each chord in the inversion nearest the one before (read as C/E).
  const voiced = useMemo(() => {
    if (!smooth) return song
    const inv = smoothInversions(song.chords)
    const chords = song.chords.map((c, i) => {
      if (!inv[i] || !c.tones.length || !c.symbol) return c
      const tones = invert(c.tones, inv[i])
      return { ...c, tones, symbol: slash(c.symbol, tones[0], c.flats) }
    })
    return { ...song, chords }
  }, [song, smooth])
  // Generated play-along parts, listed under "Creative" after the transcribed tracks.
  const [harmony, setHarmony] = useState<HarmonyOptions>(HARMONY_DEFAULT)
  const creative = useMemo(() => creativeTracks(song, harmony), [song, harmony])
  const tracks = useMemo<Track[]>(() => [...song.tracks, ...creative], [song, creative])
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0]
  const part = creative.find((t) => t.id === track?.id)
  const instrument: Instrument = track?.instrument ?? 'piano'
  const pitched = instrument !== 'drums'
  // Chord-based tracks can be read as notes (Names) or as a chord chart (Shapes); melodic parts read like their instrument.
  const playAlong = !!track?.chordal
  const chart = playAlong && chordMode === 'shapes'
  // The song as this track reads it: a creative part brings its own notes and chords.
  const viewed = useMemo(
    () => {
      if (part) return { ...song, chords: part.chords, piano: part.piano }
      if (instrument === 'chords') return voiced
      if (instrument === 'other') return song
      if (!track || !song.tracks.some((item) => item.id === track.id && item.group !== 'creative')) return song
      if (song.tracks.filter((item) => item.instrument === instrument && item.group !== 'creative').length < 2) return song
      return { ...song, [instrument]: song[instrument].filter((event) => event.trackId === track.id) }
    },
    [song, voiced, part, instrument, track],
  )
  // Lesson sticking as written, or a suggestion for transcribed drums; computed once per drum part, not per frame.
  const kitPane = !chart && instrument === 'drums' && practice.drums === 'kit'
  const sticking = useMemo(() => instrument === 'drums' && showSticking && viewed.drums.length ? stickingFor(viewed) : undefined,
    [instrument, showSticking, viewed])
  const xml = useMemo(() => {
    if (chart) return ''
    if (instrument === 'chords') return chordsXml(viewed)
    if (instrument === 'drums') return drumXml(viewed, hasPitchedScore(song), sticking?.hands)
    if (instrument === 'vocals') return vocalXml(viewed)
    if (instrument === 'other' && track) return instrumentXml(viewed, track)
    return pianoXml(viewed)
  }, [viewed, song, instrument, chart, track, sticking])
  // Play-along parts start muted: read one while the recording plays, unmute to hear it.
  const storageKey = `mizan:mixer:${songId}`
  const stored = useMemo<StoredMixer | null>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      if (value === null) return null
      if (typeof value !== 'object' || !('muted' in value) || !Array.isArray(value.muted) ||
          !value.muted.every((id) => typeof id === 'string') || !('volumes' in value) ||
          !value.volumes || typeof value.volumes !== 'object' || Array.isArray(value.volumes) ||
          !Object.values(value.volumes).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1.25) ||
          ('soloId' in value && typeof value.soloId !== 'string') ||
          ('enabledStems' in value && (!Array.isArray(value.enabledStems) || !value.enabledStems.every((id) => typeof id === 'string'))) ||
          ('beforeSolo' in value && (!Array.isArray(value.beforeSolo) || !value.beforeSolo.every((id) => typeof id === 'string')))) {
        throw new Error('Invalid saved mixer settings')
      }
      return value as StoredMixer
    } catch (error) {
      console.warn('Could not restore mixer settings; using the song defaults.', error)
      return null
    }
  }, [storageKey])
  const mixerIds = useMemo(() => [...tracks.map((track) => track.id), ...visibleStems.map((stem) => `stem:${stem.id}`)], [tracks, visibleStems])
  const restoredSolo = stored?.soloId && mixerIds.includes(stored.soloId) ? stored.soloId : undefined
  const defaultMuted = useMemo(() => [
    ...(start?.muted ?? []),
    ...tracks.filter((track) => track.group === 'creative').map((track) => track.id),
    ...visibleStems.map((stem) => `stem:${stem.id}`),
  ], [tracks, start, visibleStems])
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => {
    if (restoredSolo) return new Set(mixerIds.filter((id) => id !== restoredSolo))
    const saved = new Set((stored?.muted ?? defaultMuted).filter((id) => mixerIds.includes(id)))
    for (const stem of visibleStems) {
      if (stored?.enabledStems && !stored.enabledStems.includes(stem.id)) saved.add(`stem:${stem.id}`)
    }
    if (visibleStems.some((stem) => stem.id === 'mix') && !saved.has('stem:mix')) {
      visibleStems.filter((stem) => stem.id !== 'mix').forEach((stem) => saved.add(`stem:${stem.id}`))
    }
    return saved
  })
  const [volumes, setVolumes] = useState<Record<string, number>>(() =>
    Object.fromEntries(Object.entries(stored?.volumes ?? {}).filter(([id]) => mixerIds.includes(id))))
  // Solo really mutes: it unmutes the track and mutes all others, remembering the mutes to restore when solo ends.
  const [beforeSolo, setBeforeSolo] = useState<ReadonlySet<string> | null>(() =>
    restoredSolo && stored?.beforeSolo ? new Set(stored.beforeSolo.filter((id) => mixerIds.includes(id))) : null)
  const [soloId, setSoloId] = useState<string | undefined>(restoredSolo)
  const solo = useMemo<ReadonlySet<string>>(() => new Set(soloId && mixerIds.length > 1 ? [soloId] : []), [soloId, mixerIds.length])
  const toggleMute = useCallback((id: string) => {
    setBeforeSolo(null)
    setSoloId(undefined)
    setMuted((m) => {
      const next = new Set(m)
      if (!next.delete(id)) {
        next.add(id)
      } else if (id === 'stem:mix') {
        visibleStems.filter((stem) => stem.id !== 'mix').forEach((stem) => next.add(`stem:${stem.id}`))
      } else if (id.startsWith('stem:')) {
        next.add('stem:mix')
      }
      return next
    })
  }, [visibleStems])
  const toggleSolo = useCallback(
    (id: string) => {
      if (solo.has(id)) {
        setMuted(beforeSolo ?? new Set(defaultMuted))
        setBeforeSolo(null)
        setSoloId(undefined)
        return
      }
      setBeforeSolo((b) => b ?? muted)
      setSoloId(id)
      setMuted(new Set(mixerIds.filter((trackId) => trackId !== id)))
      const score = tracks.find((track) => track.id === id) ??
        (id.startsWith('stem:') ? tracks.find((track) => track.group !== 'creative' &&
          (track.instrument === id.slice(5) || (track.instrument === 'other' && track.id === `instrument-${id.slice(5)}`))) : undefined)
      if (score) setTrackId(score.id)
    },
    [solo, beforeSolo, muted, mixerIds, defaultMuted, tracks],
  )
  const silent = muted
  const [pos, setPos] = useState({ bar: start?.bar ?? 1, chordIdx: 0, playing: false, countBeat: 0 })
  const [effectiveBpm, setEffectiveBpm] = useState(() => Math.round(engine.getEffectiveQuarterBpm()))
  const effectiveBpmRef = useRef(effectiveBpm)
  const [typed, setTyped] = useState('')
  const [audioError, setAudioError] = useState<string | null>(null)
  const [audioLoading, setAudioLoading] = useState(false)
  const typedRef = useRef('')

  useEffect(() => {
    // Chords whose voicing differs from the detected one (smooth voicing) play as shown.
    const swaps = new Map<number, number[]>()
    voiced.chords.forEach((c, i) => c.tones !== song.chords[i].tones && swaps.set(i, c.tones))
    const extras = creative.map((t) => ({ id: t.id, notes: t.piano }))
    Object.assign(engine, { rate, loop, click, swaps, extras })
    engine.refresh()
  }, [engine, rate, loop, click, voiced, song, creative])
  useEffect(() => {
    Object.assign(engine, { muted: silent, trackGains: new Map(Object.entries(volumes)) })
    engine.refreshMix()
  }, [engine, silent, volumes])
  useEffect(() => {
    engine.countIn = countIn
  }, [engine, countIn])
  useEffect(() => {
    engine.onEnd = () => setPos((p) => ({ ...p, playing: false }))
    engine.onError = setAudioError
    engine.onLoading = (loading) => {
      setAudioLoading(loading)
      if (loading) setAudioError(null)
    }
    if (start) engine.seek(barStart(song, start.bar - 1))
    return () => {
      engine.onLoading = null
      engine.onError = null
      engine.dispose()
    }
    // Resume once per opened song; later position changes come from the transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        muted: [...muted], volumes, soloId, beforeSolo: beforeSolo ? [...beforeSolo] : undefined,
        enabledStems: visibleStems.filter((stem) => !muted.has(`stem:${stem.id}`)).map((stem) => stem.id),
      }))
    } catch (error) {
      console.error('Could not save mixer settings.', error)
      setAudioError('Mixer settings could not be saved on this device.')
    }
  }, [storageKey, muted, volumes, soloId, beforeSolo, visibleStems])

  useFrame(engine, (t) => {
    const bar = barAt(song, t.beat) + 1
    const chordIdx = chordAt(song, t.beat)
    if (bar !== pos.bar || chordIdx !== pos.chordIdx || t.playing !== pos.playing || t.countBeat !== pos.countBeat) {
      setPos({ bar, chordIdx, playing: t.playing, countBeat: t.countBeat })
    }
    const bpm = Math.round(engine.getEffectiveQuarterBpm())
    if (bpm !== effectiveBpmRef.current) {
      effectiveBpmRef.current = bpm
      setEffectiveBpm(bpm)
    }
  })

  const togglePlay = useCallback(() => {
    if (engine.playing) engine.pause()
    else void engine.play()
  }, [engine])

  const jump = useCallback((bar: number) => engine.seek(barStart(song, Math.max(1, Math.min(song.bars, bar)) - 1)), [engine, song])

  const section = song.sections[sectionAt(song, pos.bar)]
  const confidence = song.confidence[track?.chordal ? 'chords' : instrument] ?? []

  const toggleLoop = useCallback(() => {
    setLoop((l) => {
      if (l) return null
      if (section) return { startBar: section.startBar, endBar: section.startBar + section.bars - 1 }
      const start = Math.floor((pos.bar - 1) / 4) * 4 + 1
      return { startBar: start, endBar: Math.min(song.bars, start + 3) }
    })
  }, [section, pos.bar, song.bars])

  const pick = useCallback(
    (bar: number, extend: boolean) => {
      if (!extend) return jump(bar)
      const anchor = loop?.startBar ?? pos.bar
      setLoop({ startBar: Math.min(anchor, bar), endBar: Math.max(anchor, bar) })
    },
    [jump, loop, pos.bar],
  )

  // Practice position, saved while paused and whenever the setup changes, so the library can resume it.
  const position = useMemo<Position>(() => {
    const named = loop && song.sections.find((s) => s.startBar === loop.startBar && s.startBar + s.bars - 1 === loop.endBar)
    return { bar: pos.bar, loop, loopName: named ? named.name : null, rate, trackId: track?.id ?? '', muted: [...muted], solo: [...solo] }
  }, [pos.bar, loop, rate, track, muted, solo, song.sections])
  const latest = useRef(position)
  latest.current = position
  // Opening music starts it from the top; its stored position only changes once the player does something.
  const [opened] = useState(() => JSON.stringify(position))
  const savePosition = useRef((p: Position) => { if (JSON.stringify(p) !== opened) onPosition?.(p) })
  savePosition.current = (p: Position) => { if (JSON.stringify(p) !== opened) onPosition?.(p) }
  useEffect(() => {
    if (!onPosition || pos.playing || JSON.stringify(position) === opened) return
    const timer = setTimeout(() => onPosition(latest.current), 800)
    return () => clearTimeout(timer)
  }, [onPosition, position, pos.playing, opened])
  // Leaving by any route (next lesson, re-open) keeps the latest setup, not only the last debounced one.
  useEffect(() => () => savePosition.current(latest.current), [])
  const leave = useCallback(() => {
    engine.pause()
    savePosition.current(latest.current)
    onBack?.()
  }, [engine, onBack])

  const go = useCallback(
    (query: string) => {
      const q = query.trim().toLowerCase()
      if (!q) return false
      const n = Number(q)
      if (Number.isInteger(n) && n >= 1 && n <= song.bars) {
        jump(n)
        return true
      }
      const matches = song.sections.filter((s) => s.name.toLowerCase().startsWith(q))
      if (!matches.length) return false
      jump((matches.find((s) => s.startBar > pos.bar) ?? matches[0]).startBar)
      return true
    },
    [jump, pos.bar, song],
  )

  const setSpeed = useCallback((r: number) => {
    const next = Math.round(Math.min(1, Math.max(0.25, r)) * 20) / 20
    setRate(next)
    savePref('rate', next)
  }, [])
  // Each toggle stores the player's choice; opening a song or lesson never writes them.
  const toggleClick = useCallback(() => setClick((on) => { savePref('click', !on); return !on }), [])
  const toggleCountIn = useCallback(() => setCountIn((on) => { savePref('countIn', !on); return !on }), [])
  const toggleSticking = useCallback(() => setShowSticking((on) => { savePref('sticking', !on); return !on }), [])
  // A look only: the engine, position and sounds are untouched.
  const chooseKitStyle = useCallback((style: KitStyle) => { setKitStyle(style); savePref('kitStyle', style) }, [])
  // Choosing another track starts it from the beginning, stopped, like opening a new piece.
  const chooseTrack = useCallback((id: string) => {
    if (id === track?.id) return
    engine.pause()
    engine.seek(0)
    setTrackId(id)
  }, [engine, track])
  const setVolume = useCallback((id: string, value: number) => {
    setVolumes((current) => ({ ...current, [id]: Math.max(0, Math.min(1.25, value)) }))
  }, [])
  const synthOnly = useCallback(() => {
    setBeforeSolo(null)
    setSoloId(undefined)
    setMuted((current) => {
      const next = new Set(current)
      visibleStems.forEach((stem) => next.add(`stem:${stem.id}`))
      if (tracks.every((item) => next.has(item.id))) next.delete(track?.id ?? tracks[0]?.id)
      return next
    })
  }, [visibleStems, tracks, track])
  const originalOnly = useCallback(() => {
    if (!visibleStems.length) return
    setBeforeSolo(null)
    setSoloId(undefined)
    setMuted(new Set([
      ...tracks.map((item) => item.id),
      ...visibleStems.filter((stem) => stem.id !== 'mix' && visibleStems.some((item) => item.id === 'mix')).map((stem) => `stem:${stem.id}`),
    ]))
  }, [visibleStems, tracks])

  useEffect(() => {
    const setBuffer = (v: string) => {
      typedRef.current = v
      setTyped(v)
    }
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable ||
        (target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter'))
      if (editing || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      if (/^[0-9]$/.test(k)) {
        e.preventDefault()
        return setBuffer((typedRef.current + k).slice(0, 4))
      }
      if (k === 'Enter' && typedRef.current) {
        e.preventDefault()
        jump(Number(typedRef.current))
        return setBuffer('')
      }
      if (k === 'Escape') return setBuffer('')
      if (k === 'Backspace' && typedRef.current) return setBuffer(typedRef.current.slice(0, -1))
      const actions: Record<string, () => void> = {
        ' ': togglePlay,
        l: toggleLoop,
        m: () => track && toggleMute(track.id),
        c: toggleClick,
        n: () => pitched && setNoteNames((v) => !v),
        s: () => track && toggleSolo(track.id),
        k: () => playAlong && setChordMode((v) => (v === 'names' ? 'shapes' : 'names')),
        v: () => instrument === 'chords' && setSmooth((v) => !v),
        ArrowLeft: () => jump(pos.bar - 1),
        ArrowRight: () => jump(pos.bar + 1),
        '[': () => setSpeed(rate - 0.05),
        ']': () => setSpeed(rate + 0.05),
      }
      const act = actions[k.length === 1 ? k.toLowerCase() : k]
      if (act) {
        e.preventDefault()
        act()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, toggleLoop, toggleClick, jump, pos.bar, pos.chordIdx, rate, setSpeed, toggleMute, toggleSolo, track, pitched, instrument, playAlong])

  return (
    <div className="ws" data-instrument={instrument}>
      <header className="ws-head">
        <div className="ws-title">
          {onBack && (
            <button className="ws-back" onClick={leave} title="Back to the library" aria-label="Back to the library">
              <ArrowLeft size={18} />
            </button>
          )}
          <h1 className="ws-song" title={song.title}>{song.title}</h1>
          <p className="ws-draft">{note}</p>
        </div>
        <p className="ws-where" aria-live="polite">
          {typed ? (
            <>
              Go to bar <strong className="num">{typed}</strong> <span className="dim">Enter to jump · Esc to cancel</span>
            </>
          ) : (
            <>
              <span>
                Bar <strong className="num">{pos.bar}</strong>
                <span className="dim num"> / {song.bars}</span>
              </span>
              {section && <span className="ws-section">{section.name}</span>}
              <span className="num">
                <strong>{effectiveBpm}</strong> bpm{rate < 1 && <span className="dim"> · {Math.round(rate * 100)}%</span>}
              </span>
              {song.barMap && <span className="num" title={measures(song)[pos.bar - 1].status === 'explicit'
                ? 'Imported time signature' : 'Estimated grouping; written signature is unverified'}>
                {measures(song)[pos.bar - 1].numerator}/{measures(song)[pos.bar - 1].denominator}
                {measures(song)[pos.bar - 1].status !== 'explicit' && <span className="dim"> · unverified</span>}
              </span>}
            </>
          )}
        </p>
        {playAlong && (
          <ChordView value={chordMode} onChange={setChordMode} smooth={instrument === 'chords' ? smooth : null} onSmooth={() => setSmooth((v) => !v)} />
        )}
        {track?.id === 'harmony-line' && <HarmonyLineView value={harmony} onChange={setHarmony} />}
        {!chart && (instrument === 'piano' || instrument === 'drums') && (
          <PracticeViewPicker instrument={instrument} value={practice[instrument]}
            onChange={(view) => setPractice((current) => ({ ...current, [instrument]: view }))} />
        )}
        <TrackPicker
          tracks={tracks}
          stems={visibleStems}
          value={track?.id ?? ''}
          onChange={chooseTrack}
          onDelete={onDeleteTrack ? async (id) => {
            engine.pause()
            await onDeleteTrack(id)
          } : undefined}
          muted={muted}
          onMute={toggleMute}
          solo={solo}
          onSolo={toggleSolo}
          volumes={volumes}
          onVolume={setVolume}
          onSynthOnly={synthOnly}
          onOriginalOnly={originalOnly}
        />
        {analysisNotice}
      </header>

      {audioError && <div className="audio-error" role="alert">{audioError}</div>}
      {audioLoading && <div className="audio-error" role="status">Preparing sounds...</div>}

      {kitPane ? (
        <div className="ws-split">
          <Score xml={xml} song={viewed} engine={engine} bar={pos.bar} loop={loop} confidence={confidence} noteNames={false} instrument="drums" playing={pos.playing} audioLoading={audioLoading} audioError={!!audioError} practice="kit" onPick={pick} previewId={track?.id ?? 'chords'} />
          {/* The 3D kit sits beside the score, outside it, so redrawing the score never restarts the kit. */}
          <DrumKitView song={viewed} engine={engine} sticking={sticking} style={kitStyle} onStyle={chooseKitStyle} />
        </div>
      ) : chart ? (
        <ChordChart song={viewed} engine={engine} bar={pos.bar} loop={loop} confidence={confidence} onPick={pick} previewId={track?.id ?? 'chords'} />
      ) : (
        <Score xml={xml} song={viewed} engine={engine} bar={pos.bar} loop={loop} confidence={confidence} noteNames={noteNames && pitched} instrument={instrument} playing={pos.playing} audioLoading={audioLoading} audioError={!!audioError} vocalGuide={instrument === 'vocals'} instrumentGuide={instrument === 'other' ? track?.id : undefined} practice={instrument === 'piano' || instrument === 'drums' ? practice[instrument] : 'score'} onPick={pick} previewId={track?.id ?? 'chords'} />
      )}

      <footer className="ws-foot">
        <Transport
          playing={pos.playing}
          countBeat={pos.countBeat}
          rate={rate}
          loop={loop}
          countIn={countIn}
          click={click}
          noteNames={pitched ? noteNames : null}
          onNoteNames={() => setNoteNames((v) => !v)}
          onPlay={togglePlay}
          onStep={(d) => jump(pos.bar + d)}
          onRate={setSpeed}
          onLoop={toggleLoop}
          onCountIn={toggleCountIn}
          onClick={toggleClick}
          sticking={instrument === 'drums' ? showSticking : null}
          onSticking={toggleSticking}
          onGo={go}
        />
      </footer>
    </div>
  )
}
