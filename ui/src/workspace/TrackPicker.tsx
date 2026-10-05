import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, Drum, Headphones, KeyboardMusic, Mic, Music2, Piano, Trash2, Volume2, VolumeX } from 'lucide-react'
import type { Stem } from '../library/bridge'
import type { Instrument, Track } from './song'

const ICON: Record<Instrument, typeof Piano> = { piano: Piano, drums: Drum, chords: KeyboardMusic, vocals: Mic, other: Music2 }
const stemId = (id: Stem['id']) => `stem:${id}`

type Props = {
  tracks: Track[]
  stems: Stem[]
  value: string
  onChange: (id: string) => void
  onDelete?: (id: string) => Promise<void>
  muted: ReadonlySet<string>
  onMute: (id: string) => void
  solo: ReadonlySet<string>
  onSolo: (id: string) => void
  volumes: Readonly<Record<string, number>>
  onVolume: (id: string, value: number) => void
  onSynthOnly: () => void
  onOriginalOnly: () => void
}

export function TrackPicker({
  tracks, stems, value, onChange, onDelete, muted, onMute, solo, onSolo, volumes, onVolume, onSynthOnly, onOriginalOnly,
}: Props) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const current = tracks.find((t) => t.id === value) ?? tracks[0]

  useEffect(() => {
    if (!open) return
    const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
    items().find((el) => el.getAttribute('role') === 'menuitemradio' && el.getAttribute('aria-checked') === 'true')?.focus()
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === ' ' || event.key === 'Enter' || /^[0-9]$/.test(event.key)) event.stopPropagation()
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        button.current?.focus()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (event.target instanceof HTMLInputElement) return
        event.preventDefault()
        event.stopPropagation()
        const list = items()
        const index = list.indexOf(document.activeElement as HTMLButtonElement)
        list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    root.current?.addEventListener('keydown', onKey)
    const element = root.current
    return () => {
      document.removeEventListener('pointerdown', onDown)
      element?.removeEventListener('keydown', onKey)
    }
  }, [open])

  const Icon = current?.chordal ? KeyboardMusic : current ? ICON[current.instrument] : Headphones
  const synthOn = tracks.some((track) => !muted.has(track.id) && (volumes[track.id] ?? 1) > 0)
  const activeStems = stems.filter((stem) => !muted.has(stemId(stem.id)) && (volumes[stemId(stem.id)] ?? 1) > 0)
  const recordingOn = activeStems.length > 0
  const recording = activeStems.length === 1
    ? activeStems[0].id === 'mix' ? 'Full recording' : `${activeStems[0].label} recording`
    : `${activeStems.length} recording stems`
  const sounds = recordingOn ? `${recording}${synthOn ? ' + synth' : ' only'}` : synthOn ? 'Synth only' : 'All sounds muted'
  const soloName = tracks.find((track) => solo.has(track.id))?.name ?? stems.find((stem) => solo.has(stemId(stem.id)))?.label
  const source = soloName ? `${soloName} solo: ${sounds}` : sounds
  const currentQuiet = current && (muted.has(current.id) || (volumes[current.id] ?? 1) === 0)

  const controls = (id: string, name: string) => {
    const quiet = muted.has(id)
    const alone = solo.has(id)
    return (
      <>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={quiet}
          className="track-mute"
          onClick={() => onMute(id)}
          aria-label={`${quiet ? 'Unmute' : 'Mute'} ${name}`}
          title={quiet ? `Unmute ${name}` : `Mute ${name}`}
        >
          {quiet ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={alone}
          className="track-mute track-solo"
          onClick={() => onSolo(id)}
          aria-label={`Solo ${name}`}
          title={alone ? `Stop soloing ${name}` : `Solo ${name}`}
        >
          <Headphones aria-hidden="true" />
        </button>
        <label className="track-volume" title={`${name} volume`}>
          <span className="visually-hidden">{name} volume</span>
          <input
            type="range"
            min="0"
            max="1.25"
            step="0.05"
            value={volumes[id] ?? 1}
            onChange={(event) => onVolume(id, Number(event.target.value))}
          />
        </label>
      </>
    )
  }

  return (
    <div className="track" ref={root}>
      <button
        ref={button}
        type="button"
        className="track-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        title={`Choose sounds and tracks. ${source}.${currentQuiet ? ` ${current.name} is muted.` : ''}`}
      >
        <Icon aria-hidden="true" className="track-icon" />
        <span className="track-text">
          <span className="track-name">{current?.name ?? 'Sounds'}{currentQuiet ? ' (muted)' : ''}</span>
          <span className="track-detail">{source}</span>
        </span>
        <ChevronDown aria-hidden="true" className="track-chevron" />
      </button>
      {open && (
        <div className="track-menu" id={menuId} role="menu" aria-label="Sounds and tracks">
          <div className="sound-presets" role="group" aria-label="Sound source">
            <button type="button" onClick={onSynthOnly} aria-pressed={synthOn && !recordingOn}>Synth only</button>
            <button type="button" onClick={onOriginalOnly} disabled={!stems.length} aria-pressed={!synthOn && recordingOn}>Original only</button>
          </div>
          {current && <p className="track-empty" role="status">
            Viewing {current.name}{currentQuiet ? ' (muted)' : ''}. Choosing a score does not change the mix.
            {' Solo opens its matching score when available.'}
            {!synthOn && activeStems.length === 1 && activeStems[0].id !== 'mix' && ' An isolated recording can be silent between phrases; choose Original only for the full song.'}
          </p>}
          {!stems.length && <p className="track-empty">No recording is linked to this song.</p>}
          {deleteError && <p className="track-empty" role="alert">{deleteError}</p>}
          <div className="track-group" role="presentation">
            <span>Transcribed</span>
            <span className="track-group-note">Draft score notes · deleting a score keeps its recording</span>
          </div>
          {!tracks.some((track) => track.group !== 'creative') &&
            <p className="track-empty">No transcribed score is available; uncertain candidates may have been withheld.{stems.length ? ' You can still listen to the recording below.' : ''}</p>}
          {tracks.map((track, index) => {
            const TrackIcon = track.chordal ? KeyboardMusic : ICON[track.instrument]
            const selected = track.id === current?.id
            const firstCreative = track.group === 'creative' && tracks[index - 1]?.group !== 'creative'
            return (
              <Fragment key={track.id}>
                {firstCreative && (
                  <div className="track-group" role="presentation">
                    <span>Creative</span>
                    <span className="track-group-note">Generated to play along, not transcribed</span>
                  </div>
                )}
                <div className="track-row" data-muted={muted.has(track.id) || undefined}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="track-item"
                    onClick={() => {
                      onChange(track.id)
                      setOpen(false)
                      button.current?.focus()
                    }}
                  >
                    <TrackIcon aria-hidden="true" className="track-icon" />
                    <span className="track-text">
                      <span className="track-name">{track.name}</span>
                      <span className="track-detail">{track.detail}{track.instrument === 'other'
                        ? track.id === 'instrument-organ' ? ' · organ synth'
                          : track.gmProgram != null && track.gmProgram >= 0 && track.gmProgram <= 127
                            ? ' · GM sample' : ' · piano preview'
                        : track.instrument === 'vocals' ? ' · vowel synth, no lyrics' : ''}</span>
                    </span>
                    {selected && <Check aria-hidden="true" className="track-check" />}
                  </button>
                  {controls(track.id, track.name)}
                  {onDelete && track.group !== 'creative' && (
                    <button type="button" role="menuitem" className="track-mute"
                      disabled={deleting !== null}
                      aria-label={`Delete ${track.name} score`}
                      title={`Delete ${track.name} score (keep recording)`}
                      onClick={async () => {
                        if (!window.confirm(`Delete the ${track.name} score and its notes? This cannot be undone. The original recording and isolated audio stems will stay.`)) return
                        setDeleteError(null)
                        setDeleting(track.id)
                        try {
                          await onDelete(track.id)
                          setOpen(false)
                        } catch (error) {
                          setDeleteError(error instanceof Error ? error.message : 'The score could not be deleted.')
                        } finally {
                          setDeleting(null)
                        }
                      }}>
                      <Trash2 aria-hidden="true" />
                    </button>
                  )}
                </div>
              </Fragment>
            )
          })}
          {!!stems.length && (
            <>
              <div className="track-group" role="presentation">
                <span>Recording</span>
                <span className="track-group-note">Original isolated stems, sample-aligned</span>
              </div>
              {stems.map((stem) => {
                const id = stemId(stem.id)
                return (
                  <div className="track-row track-stem" data-muted={muted.has(id) || undefined} key={stem.id}>
                    <div className="track-item" role="presentation">
                      <Headphones aria-hidden="true" className="track-icon" />
                      <span className="track-text">
                        <span className="track-name">{stem.label}</span>
                        <span className="track-detail">
                          {stem.id === 'mix' ? 'Full recording' : !tracks.some((track) => track.id === stem.id && track.group !== 'creative')
                            ? stem.id === 'guitar' || stem.id === 'bass'
                              ? 'Recording only · no transcribed notes or score'
                              : 'Recording only · no verified score'
                            : 'Isolated recording stem'}
                        </span>
                      </span>
                    </div>
                    {controls(id, stem.label)}
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
