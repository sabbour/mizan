import pytest

from mizan.errors import InvalidUrl
from mizan.youtube import parse_video_id

VIDEO_ID = "aB_12-cD345"


@pytest.mark.parametrize("url", [
    f"https://youtube.com/watch?v={VIDEO_ID}",
    f"https://www.youtube.com/watch?list=example&v={VIDEO_ID}&t=23",
    f"https://youtu.be/{VIDEO_ID}?si=example&t=23",
    f"https://youtube.com/shorts/{VIDEO_ID}?feature=share",
    f"https://music.youtube.com/watch?v={VIDEO_ID}&list=example",
    f"https://m.youtube.com/watch?v={VIDEO_ID}",
    f"  http://YOUTUBE.COM/watch?v={VIDEO_ID}#t=10  ",
])
def test_valid_urls(url):
    assert parse_video_id(url) == VIDEO_ID


@pytest.mark.parametrize("url", [
    "", None, 123, VIDEO_ID, "youtube.com/watch?v=" + VIDEO_ID,
    "https://example.com/watch?v=" + VIDEO_ID,
    "https://youtube.com.evil.example/watch?v=" + VIDEO_ID,
    "https://youtube.com@evil.example/watch?v=" + VIDEO_ID,
    "https://user@youtube.com/watch?v=" + VIDEO_ID,
    "ftp://youtube.com/watch?v=" + VIDEO_ID,
    "https://youtube.com/watch", "https://youtube.com/watch?v=",
    "https://youtube.com/watch?v=short", "https://youtube.com/watch?v=123456789012",
    "https://youtube.com/watch?v=abcdefghij!",
    f"https://youtube.com/watch?v={VIDEO_ID}&v={VIDEO_ID}",
    f"https://youtu.be/{VIDEO_ID}/extra",
    f"https://youtube.com/shorts/{VIDEO_ID}/extra",
    f"https://youtube.com/embed/{VIDEO_ID}",
    f"https://youtube.com:bad/watch?v={VIDEO_ID}",
    f"https://youtube.com:8080/watch?v={VIDEO_ID}",
    f"https://you\ntube.com/watch?v={VIDEO_ID}",
    "https://[invalid/watch?v=" + VIDEO_ID,
])
def test_invalid_urls(url):
    with pytest.raises(InvalidUrl):
        parse_video_id(url)
