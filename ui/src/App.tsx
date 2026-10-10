import { Component, useCallback, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Workspace } from './workspace/Workspace'
import type { PracticeView } from './workspace/PracticeViewPicker'
import { Library, type LibraryTab } from './library/Library'
import { JobPanel } from './library/JobPanel'
import { Credits } from './Credits'
import { host, type Entry, type Opened } from './library/bridge'
import { fromHost } from './library/adapt'
import { useQueue } from './library/useQueue'
import { activeAnalysis, analysisProgress, decodingErrorHeadline, jobTitle } from './library/format'
import { lessonById, lessonNote, lessonSong } from './course/curriculum'
import { LessonPanel, PianoLessonPanel } from './course/Course'
import { browseTo, DEFAULT_BROWSE, type CourseBrowse } from './course/browse'
import { pianoLessonById, pianoLessonNote, pianoLessonSong } from './course/piano'
import { lessonPosition, saveLessonPosition } from './course/state'

type View = { kind: 'library' } | { kind: 'job'; id: string; opened?: Opened } | { kind: 'song'; opened: Opened } | { kind: 'credits' } | { kind: 'lesson'; id: string }
type LessonViews = { piano?: PracticeView; drums?: PracticeView; noteNames?: boolean; fingering?: boolean }

const NOTE: Record<Entry['source'], string> = { youtube: 'Draft transcription', midi: 'Imported MIDI', musicxml: 'Imported MusicXML' }

class WorkspaceBoundary extends Component<{ children: ReactNode; onBack: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Workspace render failed', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="lib lib-empty">
        <main className="lib-main">
          <section className="intake">
            <h1>This song could not be displayed</h1>
            <p role="alert">{this.state.error.message || 'The workspace could not render this song.'}</p>
            <button className="btn btn-primary" onClick={this.props.onBack}>
              Back to library
            </button>
          </section>
        </main>
      </div>
    )
  }
}

export default function App() {
  const [view, setView] = useState<View>({ kind: 'library' })
  // Songs or Drum course, kept while a song or lesson is open so Back returns to the same tab.
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('songs')
  // Where the Course tab is (instrument, drum list, genre); Back shows the list a lesson came from. Not stored.
  const [courseBrowse, setCourseBrowse] = useState<CourseBrowse>(DEFAULT_BROWSE)
  // The practice view, Note letters and Fingering chosen in this run of lessons, so Next and Previous keep them; cleared on Back. Not stored.
  const [lessonViews, setLessonViews] = useState<LessonViews>({})
  const keepLessonView = useCallback((instrument: 'piano' | 'drums', practice: PracticeView) =>
    setLessonViews((current) => current[instrument] === practice ? current : { ...current, [instrument]: practice }), [])
  const keepGuides = useCallback(({ noteNames, fingering }: { noteNames: boolean; fingering: boolean }) =>
    setLessonViews((current) => current.noteNames === noteNames && current.fingering === fingering ? current : { ...current, noteNames, fingering }), [])
  const openLesson = useCallback((id: string) => {
    setCourseBrowse((current) => browseTo(id, current))
    setView({ kind: 'lesson', id })
  }, [])
  const [openError, setOpenError] = useState<string | null>(null)
  const [openRevision, setOpenRevision] = useState(0)
  const [reprocessing, setReprocessing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const queue = useQueue()
  const clearFinished = queue.clearFinished

  const open = useCallback(async (id: string) => {
    setOpenError(null)
    try {
      const opened = await host.open(id)
      clearFinished()
      setAnalysisError(null)
      setOpenRevision((revision) => revision + 1)
      setView({ kind: 'song', opened: { ...opened, song: fromHost(opened.song) } })
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : 'That song could not be opened.')
      setView({ kind: 'library' })
    }
  }, [clearFinished])

  const back = useCallback(() => {
    setView({ kind: 'library' })
    setLessonViews({})
    queue.bump()
  }, [queue])

  const closePanel = useCallback(() => setView((v) => (v.kind === 'job' ? v.opened ? { kind: 'song', opened: v.opened } : { kind: 'library' } : v)), [])

  const job = view.kind === 'job' ? queue.jobs.find((j) => j.id === view.id) : undefined
  const done = queue.finished
  const opened = view.kind === 'song' || view.kind === 'job' ? view.opened : undefined
  const lesson = view.kind === 'lesson' ? lessonById(view.id) : undefined
  const pianoLesson = view.kind === 'lesson' && !lesson ? pianoLessonById(view.id) : undefined
  // One song and starting setup per opened lesson, so the workspace keeps its engine across renders. A lesson always
  // starts at bar 1; its loop and other saved choices carry over.
  const practised = useMemo(() => lesson ? { song: lessonSong(lesson), start: { ...lessonPosition(lesson), bar: 1 } }
    : pianoLesson && { song: pianoLessonSong(pianoLesson), start: { ...lessonPosition(pianoLesson), bar: 1 } }, [lesson, pianoLesson])
  const updating = opened && activeAnalysis(queue.jobs, opened.entry.id)
  const updated = opened && done?.songId === opened.entry.id
  const decodingHeadline = decodingErrorHeadline(opened?.song.decodingErrors?.count)
  const hasAnalysisStatus = opened?.entry.source === 'youtube' &&
    (opened.entry.outdated || updating || updated)
  const reprocess = async () => {
    if (!opened || reprocessing) return
    setReprocessing(true)
    setAnalysisError(null)
    try {
      const job = await host.reprocess(opened.entry.id)
      await queue.refresh()
      setView((current) => (current.kind === 'song' || current.kind === 'job') && current.opened === opened
        ? { kind: 'job', id: job.id, opened } : current)
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : 'Analysis could not be queued.')
    } finally {
      setReprocessing(false)
    }
  }

  return (
    <>
      {view.kind === 'credits' ? (
        <Credits onBack={() => setView({ kind: 'library' })} />
      ) : lesson && practised ? (
        <WorkspaceBoundary key={`course:${lesson.id}`} onBack={back}>
          <Workspace
            key={`course:${lesson.id}`}
            song={practised.song}
            songId={`course:${lesson.id}`}
            start={practised.start}
            note={lessonNote(lesson)}
            defaults={{ click: true, drums: lessonViews.drums ?? 'kit', noteNames: lessonViews.noteNames, fingering: lessonViews.fingering }}
            onPracticeView={keepLessonView}
            onGuides={keepGuides}
            onPosition={(position) => saveLessonPosition(lesson, position)}
            onBack={back}
            analysisNotice={<LessonPanel lesson={lesson} onLesson={openLesson} />}
          />
        </WorkspaceBoundary>
      ) : pianoLesson && practised ? (
        <WorkspaceBoundary key={`course:${pianoLesson.id}`} onBack={back}>
          <Workspace
            key={`course:${pianoLesson.id}`}
            song={practised.song}
            songId={`course:${pianoLesson.id}`}
            start={practised.start}
            note={pianoLessonNote(pianoLesson)}
            defaults={{ click: true, piano: lessonViews.piano ?? 'keyboard', drums: lessonViews.drums, noteNames: lessonViews.noteNames, fingering: lessonViews.fingering }}
            onPracticeView={keepLessonView}
            onGuides={keepGuides}
            onPosition={(position) => saveLessonPosition(pianoLesson, position)}
            onBack={back}
            analysisNotice={<PianoLessonPanel lesson={pianoLesson} onLesson={openLesson} />}
          />
        </WorkspaceBoundary>
      ) : opened ? (
        <WorkspaceBoundary key={`${opened.entry.id}:${openRevision}`} onBack={back}>
          <Workspace
          key={`${opened.entry.id}:${openRevision}`}
          song={opened.song}
          songId={opened.entry.id}
          stems={opened.stems}
          // Opening a song starts it from the top; its saved loop, speed and mixer come with it.
          start={opened.entry.position && { ...opened.entry.position, bar: 1 }}
          note={`${NOTE[opened.entry.source]}${opened.entry.recording ? '' : ' · synth playback'}`}
          onPosition={(p) => void host.savePosition(opened.entry.id, p)}
          onDeleteTrack={async (trackId) => {
            const updated = await host.deleteScoreTrack(opened.entry.id, trackId)
            setOpenRevision((revision) => revision + 1)
            setView({ kind: 'song', opened: { ...updated, song: fromHost(updated.song) } })
          }}
          onBack={back}
          analysisNotice={decodingHeadline || hasAnalysisStatus ? (
            <aside className="analysis-notice" aria-label={decodingHeadline ? 'Transcription warning' : 'Analysis status'}>
              <div>
                {decodingHeadline && <>
                  <strong role="status">{decodingHeadline}</strong>
                  <p>Some notes may be missing or cut short. Check this saved draft against the recording.</p>
                </>}
                {hasAnalysisStatus && <>
                  <strong role={decodingHeadline ? undefined : 'status'}>
                    {updating ? analysisProgress(updating) : updated ? 'Updated analysis is ready' : 'Older analysis'}
                  </strong>
                  <p>You are viewing the saved result. {updating ? 'Keep practicing while it updates; new tracks appear when you open the finished result.' :
                    updated ? 'Open the updated result to see its tracks.' : 'Redo analysis with the selected model. Saved audio tracks are reused when possible; this result stays available.'}</p>
                </>}
                {analysisError && <p role="alert">{analysisError}</p>}
              </div>
              {hasAnalysisStatus && (updating ? <button className="btn" onClick={() => setView({ kind: 'job', id: updating.id, opened })}>View progress</button> :
                updated ? <button className="btn" onClick={() => { queue.clearFinished(); void open(opened.entry.id) }}>Open updated analysis</button> :
                  <button className="btn" disabled={reprocessing} onClick={() => void reprocess()}>{reprocessing ? 'Queuing...' : 'Redo analysis'}</button>)}
            </aside>
          ) : undefined}
          />
        </WorkspaceBoundary>
      ) : (
        <Library
          jobs={queue.jobs}
          version={queue.version}
          selectedJob={job?.id}
          onQueueChange={queue.refresh}
          onOpen={(e) => void open(e.id)}
          onCredits={() => setView({ kind: 'credits' })}
          onLesson={openLesson}
          courseBrowse={courseBrowse}
          onCourseBrowse={setCourseBrowse}
          tab={libraryTab}
          onTab={setLibraryTab}
          onDetails={(j) => setView((v) => (v.kind === 'job' && v.id === j.id ? { kind: 'library' } : { kind: 'job', id: j.id }))}
        />
      )}
      {job && <JobPanel job={job} jobs={queue.jobs} onClose={closePanel} onChange={queue.refresh} onOpen={(id) => void open(id)} />}
      {openError && (
        <div className="notice" role="alert">
          <p>{openError}</p>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setOpenError(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {done && view.kind === 'song' && !updated && (
        <div className="notice" role="status">
          <p>
            <strong>{jobTitle(done)}</strong> is ready
          </p>
          {done.songId && (
            <button className="btn btn-quiet" onClick={() => (queue.clearFinished(), void open(done.songId!))}>
              Open
            </button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={queue.clearFinished}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  )
}
