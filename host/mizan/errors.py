class MizanError(Exception):
    code = "internal_error"
    message = "An unexpected error occurred. Check the host logs."

    def __init__(self, message: str | None = None):
        super().__init__(message or self.message)


class InvalidUrl(MizanError):
    code = "invalid_url"
    message = "Paste a valid YouTube video link."


class InvalidSearch(MizanError):
    code = "invalid_search"
    message = "Use a search query of at most 200 characters."


class YoutubeSearchFailed(MizanError):
    code = "youtube_search_failed"
    message = "YouTube search is unavailable right now. Your library search still works."


class YoutubeMusicSearchFailed(MizanError):
    code = "youtube_music_search_failed"
    message = "YouTube Music search is unavailable right now."


class PopularChartUnavailable(MizanError):
    code = "popular_playlist_unavailable"
    message = "The official YouTube Music Global Charts playlist is unavailable right now."


class MidiSearchFailed(MizanError):
    code = "midi_search_failed"
    message = "MIDI search is unavailable right now. Try again."


class VideoUnavailable(MizanError):
    code = "video_unavailable"
    message = "This YouTube video is unavailable."


class DownloadFailed(MizanError):
    code = "download_failed"
    message = "The video could not be downloaded."


class UnsupportedMedia(MizanError):
    code = "unsupported_media"
    message = "This video's media format is not supported."


class FFmpegUnavailable(MizanError):
    code = "ffmpeg_unavailable"
    message = "FFmpeg is not available. Install it or choose its executable in Song analysis settings."


class ModelFailed(MizanError):
    code = "model_failed"
    message = "The music processing model could not finish."


class ModelUnavailable(MizanError):
    code = "model_unavailable"
    message = "This PC does not have the resources for the selected model."


class InsufficientDisk(MizanError):
    code = "insufficient_disk"
    message = "There is not enough free disk space to process this video."


class Cancelled(MizanError):
    code = "cancelled"
    message = "The job was cancelled."


class PipelineNotReady(MizanError):
    code = "pipeline_not_ready"
    message = "This job has not finished processing yet."


class InvalidInstrument(MizanError):
    code = "invalid_instrument"
    message = "Choose piano or drums."


class InvalidTranscriptionModel(MizanError):
    code = "invalid_transcription_model"
    message = "Choose MuScriptor Small, Medium, or Large."


class JobNotFound(MizanError):
    code = "job_not_found"
    message = "This job could not be found."


class SongNotFound(MizanError):
    code = "song_not_found"
    message = "This song could not be found."


class ScoreTrackNotFound(MizanError):
    code = "score_track_not_found"
    message = "This transcribed score track could not be found."


class ScoreTrackAmbiguous(MizanError):
    code = "score_track_ambiguous"
    message = "This older score does not identify which notes belong to this track. Re-import the score to delete this part."


class FolderNotFound(MizanError):
    code = "folder_not_found"
    message = "This folder could not be found."


class InvalidFolderName(MizanError):
    code = "invalid_folder_name"
    message = "Folder names must be between 1 and 60 characters."


class FolderNameExists(MizanError):
    code = "folder_name_exists"
    message = "A folder with that name already exists."


class InvalidFile(MizanError):
    code = "invalid_file"
    message = "Choose a valid MIDI or MusicXML file."


class InvalidPosition(MizanError):
    code = "invalid_position"
    message = "The saved practice position is invalid."


class InvalidTiming(MizanError):
    code = "invalid_timing"
    message = "The timing adjustment is invalid."
