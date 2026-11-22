import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import editor

APP_DIR = Path(__file__).resolve().parent.parent
FFMPEG = editor.find_tool("ffmpeg", APP_DIR)


def run(*args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    run("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", d / "a.mp4")
    run("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3", "-pix_fmt", "yuv420p", d / "silent.mp4")
    run("-f", "lavfi", "-i", "sine=frequency=880:duration=6", d / "music.wav")
    return d


def make_client(media_dir: Path, tmp_path: Path):
    app = FastAPI()
    jobs: dict = {}
    app.include_router(editor.make_router(tmp_path, lambda: media_dir, jobs, threading.Lock()))
    return TestClient(app), jobs


def wait_done(jobs, jid, timeout=90):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if jobs[jid]["status"] in ("done", "error", "cancelled"):
            return jobs[jid]
        time.sleep(0.3)
    raise AssertionError("내보내기가 끝나지 않음")


def ffprobe_of(path: Path) -> dict:
    return editor.probe(path, APP_DIR)


# ---------- 순수 함수 ----------
def test_srt_roundtrip():
    text = "﻿1\r\n00:00:01,500 --> 00:00:03,000\r\n안녕하세요\r\n두 줄\r\n\r\n2\r\n00:01:00.250 --> 00:01:02,000\r\n끝\r\n"
    subs = editor.parse_srt(text)
    assert [s["start"] for s in subs] == [1.5, 60.25]
    assert subs[0]["text"] == "안녕하세요\n두 줄"
    again = editor.parse_srt(editor.format_srt(subs))
    assert [(s["start"], s["end"], s["text"]) for s in again] == [(s["start"], s["end"], s["text"]) for s in subs]


def test_ass_helpers():
    assert editor.ass_time(3661.5) == "1:01:01.50"
    assert editor.ass_color("#ff8000") == "&H000080FF"
    assert editor.ass_text("a{b}\nc") == "a\\{b\\}\\Nc"


def test_atempo_chain():
    assert editor.atempo_chain(1.0) == ""
    assert editor.atempo_chain(4.0).count("atempo") == 2
    assert editor.atempo_chain(0.25).count("atempo") == 2
    assert editor.atempo_chain(1.5) == "atempo=1.50000"


def test_normalize_errors_and_clamps():
    with pytest.raises(editor.EditError):
        editor.normalize({"clips": []})
    with pytest.raises(editor.EditError):
        editor.normalize({"clips": [{"src": "a.mp4", "in": 5, "out": 5.01}]})
    p = editor.normalize({"name": 'a:b*c', "clips": [{"src": "a.mp4", "in": 0, "out": 2, "speed": 99}],
                          "subs": [{"start": 3, "end": 1, "text": "x"}, {"start": 0, "end": 1, "text": " "}],
                          "output": {"aspect": "bogus"}})
    assert p["name"] == "a_b_c"
    assert p["clips"][0]["speed"] == 4
    assert p["subs"] == [] and p["output"]["aspect"] == "original"


# ---------- 실제 ffmpeg 내보내기 ----------
def export(media, tmp_path, project, expect_ok=True):
    client, jobs = make_client(media, tmp_path)
    r = client.post("/api/edit/export", json=project)
    if not expect_ok:
        return r
    assert r.status_code == 200, r.text
    job = wait_done(jobs, r.json()["id"])
    assert job["status"] == "done", job.get("error")
    return media / r.json()["output"]


def test_cut_and_concat_with_silent_clip(media, tmp_path):
    out = export(media, tmp_path, {"name": "concat", "clips": [
        {"src": "a.mp4", "in": 1, "out": 3},
        {"src": "silent.mp4", "in": 0, "out": 1.5}]})
    info = ffprobe_of(out)
    assert info["has_audio"] and info["has_video"]
    assert info["duration"] == pytest.approx(3.5, abs=0.25)
    assert (info["width"], info["height"]) == (640, 360)


def test_speed_and_aspect(media, tmp_path):
    out = export(media, tmp_path, {"name": "fast", "clips": [{"src": "a.mp4", "in": 0, "out": 4, "speed": 2}],
                                   "output": {"aspect": "9:16"}})
    info = ffprobe_of(out)
    assert info["duration"] == pytest.approx(2.0, abs=0.25)
    assert (info["width"], info["height"]) == (1080, 1920)


def test_audio_mix_subs_and_text(media, tmp_path):
    out = export(media, tmp_path, {
        "name": "full", "clips": [{"src": "a.mp4", "in": 0, "out": 3, "mute": True}],
        "audios": [{"src": "music.wav", "at": 0.5, "in": 0, "out": 4, "volume": 0.5, "fade_in": 0.5, "fade_out": 1}],
        "subs": [{"start": 0.2, "end": 2, "text": "안녕하세요\n두 번째 줄 {테스트}"}],
        "texts": [{"start": 1, "end": 3, "text": "제목", "x": 0.5, "y": 0.2, "size": 60, "color": "#ffcc00"}]})
    info = ffprobe_of(out)
    assert info["has_audio"]
    assert info["duration"] == pytest.approx(3.0, abs=0.3)


def test_very_long_graph_uses_file(media, tmp_path):
    clips = [{"src": "a.mp4", "in": (i % 30) * 0.1, "out": (i % 30) * 0.1 + 0.2} for i in range(60)]
    plan = editor.build_plan({"clips": clips}, lambda s: media / s, lambda p: ffprobe_of(p))
    assert len(plan["graph"]) > 20000
    assert "-/filter_complex" in editor.build_command(plan, tmp_path / "o.mp4", APP_DIR)
    out = export(media, tmp_path, {"name": "many", "clips": clips})
    assert ffprobe_of(out)["duration"] == pytest.approx(12.0, abs=0.6)


def test_rejects_bad_requests(media, tmp_path):
    r = export(media, tmp_path, {"clips": [{"src": "nope.mp4", "in": 0, "out": 1}]}, expect_ok=False)
    assert r.status_code == 400 and "찾을 수 없" in r.json()["detail"]
    r = export(media, tmp_path, {"clips": [{"src": "../a.mp4", "in": 0, "out": 1}]}, expect_ok=False)
    assert r.status_code == 400
    r = export(media, tmp_path, {"clips": [{"src": "music.wav", "in": 0, "out": 1}]}, expect_ok=False)
    assert r.status_code == 400 and "영상이 아닌" in r.json()["detail"]
    r = export(media, tmp_path, {"clips": [{"src": "a.mp4", "in": 10, "out": 12}]}, expect_ok=False)
    assert r.status_code == 400


# ---------- API ----------
def test_project_asset_and_srt_api(media, tmp_path):
    client, _ = make_client(media, tmp_path)
    assert client.get("/api/edit/probe", params={"src": "a.mp4"}).json()["has_audio"] is True
    assert client.post("/api/edit/project", json={"name": "내 작업", "data": {"clips": []}}).json()["ok"]
    assert [p["name"] for p in client.get("/api/edit/projects").json()] == ["내 작업"]
    assert client.get("/api/edit/project", params={"name": "내 작업"}).json()["name"] == "내 작업"
    client.post("/api/edit/project/delete", json={"name": "내 작업"})
    assert client.get("/api/edit/projects").json() == []

    up = client.post("/api/edit/asset", params={"name": "m.wav"}, content=(media / "music.wav").read_bytes())
    assert up.status_code == 200 and up.json()["src"] == "asset:m.wav"
    assert client.get("/api/edit/media", params={"src": "asset:m.wav"}).status_code == 200
    bad = client.post("/api/edit/asset", params={"name": "x.txt"}, content=b"not media")
    assert bad.status_code == 400

    subs = client.post("/api/edit/srt/parse", json={"text": "1\n00:00:01,000 --> 00:00:02,000\n안녕\n"}).json()["subs"]
    assert subs[0]["text"] == "안녕"
    assert "-->" in client.post("/api/edit/srt/format", json={"subs": subs}).json()["text"]
    assert client.post("/api/edit/srt/parse", json={"text": "이건 자막이 아님"}).status_code == 400


def test_cancel_export(media, tmp_path):
    client, jobs = make_client(media, tmp_path)
    r = client.post("/api/edit/export", json={"name": "cx", "clips": [{"src": "a.mp4", "in": 0, "out": 4}] * 6})
    jid = r.json()["id"]
    jobs[jid]["cancel"] = True
    job = wait_done(jobs, jid)
    assert job["status"] in ("cancelled", "done")
    assert not list(media.glob("*.temp.mp4"))


# ---------- v1.1: 여러 줄 / 자유 위치 / 전환 / 소리 분리 ----------
def frame_png(video: Path, t: float, out: Path) -> Path:
    run("-ss", t, "-i", video, "-frames:v", 1, out)
    return out


def test_migrate_v1_to_v2():
    p = editor.migrate({"clips": [{"src": "a", "in": 0, "out": 2}, {"src": "b", "in": 1, "out": 4, "speed": 2}],
                        "audios": [{"src": "m", "at": 1.5}]})
    assert p["version"] == 2
    assert [c["start"] for c in p["clips"]] == [0, 2]
    assert p["audios"][0]["start"] == 1.5
    n = editor.normalize(p)
    assert n["clips"][1]["start"] == pytest.approx(2) and n["tracks"]["v"] and n["tracks"]["a"]
    assert editor.migrate(n) is n


def test_gap_and_free_position(media, tmp_path):
    out = export(media, tmp_path, {"name": "gap", "version": 2, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 1},
        {"src": "a.mp4", "track": 0, "start": 3, "in": 1, "out": 2}]})
    info = ffprobe_of(out)
    assert info["duration"] == pytest.approx(4.0, abs=0.3)


def test_overlay_layer_and_transition(media, tmp_path):
    p = {"name": "layers", "version": 2, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 4},
        {"src": "silent.mp4", "track": 1, "start": 1, "in": 0, "out": 2, "x": 0.8, "y": 0.2, "scale": 0.4,
         "opacity": 0.8, "fade_in": 0.3, "fade_out": 0.3},
        {"src": "silent.mp4", "track": 0, "start": 3.5, "in": 0, "out": 2.5, "trans": {"type": "slide-l"}}]}
    plan = editor.build_plan(p, lambda s: media / s, ffprobe_of)
    assert plan["graph"].count("overlay=") == 3
    out = export(media, tmp_path, p)
    info = ffprobe_of(out)
    assert info["duration"] == pytest.approx(6.0, abs=0.3)
    assert info["has_audio"]
    # 겹침이 실제로 그려졌는지: 위 레이어가 있는 구간과 없는 구간의 프레임이 달라야 한다.
    a = frame_png(out, 0.5, tmp_path / "f0.png").read_bytes()
    b = frame_png(out, 1.8, tmp_path / "f1.png").read_bytes()
    assert a != b


@pytest.mark.parametrize("kind", ["fade", "slide-r", "slide-u", "slide-d"])
def test_transition_kinds_and_audio_overlap(media, tmp_path, kind):
    p = {"name": "tr-" + kind, "version": 2, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 3},
        {"src": "a.mp4", "track": 0, "start": 2.5, "in": 1, "out": 4, "trans": {"type": kind}}]}
    n = editor.normalize(p)
    assert editor.overlap_in(n, n["clips"][1]) == pytest.approx(0.5)
    assert editor.overlap_out(n, n["clips"][0]) == pytest.approx(0.5)
    out = export(media, tmp_path, p)
    assert ffprobe_of(out)["duration"] == pytest.approx(5.5, abs=0.3)


def test_freeze_frame_detached_audio_tracks(media, tmp_path):
    out = export(media, tmp_path, {"name": "frz", "version": 2,
        "tracks": {"v": [{}, {"hide": True}], "a": [{}, {"mute": True}]},
        "clips": [{"src": "a.mp4", "track": 0, "start": 0, "in": 1, "out": 2, "mute": True, "link": "L1"},
                  {"src": "a.mp4", "track": 0, "start": 1, "in": 1.5, "out": 1.6, "freeze": True, "hold": 1.5},
                  {"src": "a.mp4", "track": 1, "start": 0, "in": 0, "out": 2}],
        "audios": [{"src": "a.mp4", "track": 0, "start": 0, "in": 1, "out": 2, "speed": 1, "link": "L1"},
                   {"src": "music.wav", "track": 1, "start": 0, "in": 0, "out": 3}]})
    info = ffprobe_of(out)
    assert info["duration"] == pytest.approx(2.5, abs=0.3) and info["has_audio"]


def test_waveform_api(media, tmp_path):
    client, _ = make_client(media, tmp_path)
    r = client.get("/api/edit/wave", params={"src": "music.wav"}).json()
    assert r["rate"] == 20 and 110 <= len(r["peaks"]) <= 125 and max(r["peaks"]) > 10
    assert client.get("/api/edit/wave", params={"src": "nope.wav"}).status_code == 400


# ---------- v1.2: 이미지 / 도형 / 더킹 / 평준화 ----------
@pytest.fixture(scope="module")
def pics(media):
    run("-f", "lavfi", "-i", "color=c=red:s=300x200:d=1", "-frames:v", 1, media / "red.png")
    run("-f", "lavfi", "-i", "color=c=blue:s=200x200:d=1", "-frames:v", 1, media / "blue.jpg")
    return media


def mean_color(video: Path, t: float, tmp: Path, crop: str) -> tuple[int, int, int]:
    png = tmp / f"px_{t}_{abs(hash(crop))}.png"
    run("-ss", t, "-i", video, "-vf", f"crop={crop},scale=1:1", "-frames:v", 1, png)
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return raw[0], raw[1], raw[2]


def test_probe_marks_images(pics):
    assert ffprobe_of(pics / "red.png")["is_image"] is True
    assert ffprobe_of(pics / "a.mp4")["is_image"] is False


def test_image_slideshow_and_solid(pics, tmp_path):
    out = export(pics, tmp_path, {"name": "slides", "version": 2, "output": {"aspect": "16:9"}, "clips": [
        {"src": "red.png", "image": True, "track": 0, "start": 0, "hold": 2},
        {"src": "blue.jpg", "image": True, "track": 0, "start": 2, "hold": 2},
        {"solid": {"shape": "rect", "color": "#00ff00", "w": 0.2, "h": 0.2}, "track": 1, "start": 0.5, "hold": 1,
         "x": 0.1, "y": 0.1},
        {"solid": {"shape": "ellipse", "color": "#ffff00", "w": 0.3, "h": 0.3}, "track": 1, "start": 2.5, "hold": 1}]})
    info = ffprobe_of(out)
    assert info["duration"] == pytest.approx(4.0, abs=0.3) and (info["width"], info["height"]) == (1920, 1080)
    r, g, b = mean_color(out, 1.0, tmp_path, "400:300:900:400")      # 가운데 = 빨강 이미지
    assert r > 200 and g < 60 and b < 60
    r, g, b = mean_color(out, 3.5, tmp_path, "100:100:900:400")     # 파랑 이미지
    assert b > 200 and r < 60
    r, g, b = mean_color(out, 1.0, tmp_path, "100:100:100:70")      # 왼쪽 위 초록 사각형
    assert g > 200 and r < 60


def test_duck_and_loudnorm(media, tmp_path):
    p = {"name": "duck", "version": 2, "output": {"loudnorm": True}, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 2}, {"src": "silent.mp4", "track": 0, "start": 2, "in": 0, "out": 2}],
         "audios": [{"src": "music.wav", "track": 0, "start": 0, "in": 0, "out": 4, "duck": True, "duck_level": 0.2}]}
    plan = editor.build_plan(p, lambda s: media / s, ffprobe_of)
    assert "eval=frame" in plan["graph"] and "loudnorm" in plan["graph"]
    out = export(media, tmp_path, p)
    assert ffprobe_of(out)["has_audio"]
    assert editor.merge_spans([(0, 1), (1.2, 2), (5, 6)]) == [(0, 2), (5, 6)]
    spans = [(i * 3.0, i * 3.0 + 1) for i in range(100)]
    assert len(editor.merge_spans(spans)) <= editor.DUCK_MAX_SPANS


# ---------- v1.3: 효과 / 키프레임 / 채우기 / 내보내기 설정 ----------
def test_pw_expr_and_normalize_kf():
    e = editor.pw_expr([(0, 0.0), (2, 1.0)], "t")
    assert "clip((t-0.000)/2.000,0,1)" in e and e.startswith("if(lt(t,2.000)")
    assert editor.pw_expr([(0, 0.4)], "t") == "0.40000"
    n = editor.normalize({"clips": [{"src": "a", "in": 0, "out": 2, "rotate": 450, "blur": 99,
                                     "kf": [{"t": 1, "x": 0.2}, {"t": 0, "x": 0.8}, {"t": 1, "x": 0.5}]}]})
    c = n["clips"][0]
    assert [k["t"] for k in c["kf"]] == [0, 1] and c["kf"][1]["x"] == 0.5
    assert c["rotate"] in (0, 90, 180, 270) and c["blur"] == 30


def test_effects_flip_rotate_reverse(media, tmp_path):
    out = export(media, tmp_path, {"name": "fx", "version": 2, "output": {"aspect": "16:9"}, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 2, "brightness": 0.2, "contrast": 1.3, "saturation": 0,
         "blur": 3, "flip_h": True, "rotate": 90},
        {"src": "a.mp4", "track": 0, "start": 2, "in": 0, "out": 2, "reverse": True, "gray": True, "fit": "cover"}]})
    info = ffprobe_of(out)
    assert info["duration"] == pytest.approx(4.0, abs=0.3) and info["has_audio"]


def test_reverse_limit():
    fake = {"duration": 300.0, "has_video": True, "has_audio": True, "width": 640, "height": 360, "fps": 30,
            "is_image": False}
    with pytest.raises(editor.EditError, match="역재생"):
        editor.build_plan({"clips": [{"src": "x.mp4", "in": 0, "out": 200, "reverse": True}]}, lambda s_: Path(s_), lambda _p: fake)
    plan = editor.build_plan({"clips": [{"src": "x.mp4", "in": 0, "out": 100, "reverse": True}]}, lambda s_: Path(s_), lambda _p: fake)
    assert "reverse" in plan["graph"] and "areverse" in plan["graph"]


def test_cover_fill_vs_contain(pics, tmp_path):
    base = {"version": 2, "output": {"aspect": "9:16"}, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 2}]}
    plain = export(pics, tmp_path, {**base, "name": "contain"})
    fill = export(pics, tmp_path, {**base, "name": "fill", "output": {"aspect": "9:16", "fill": True}})
    top = "1080:200:0:0"      # 위쪽 검은 띠 자리
    assert sum(mean_color(plain, 1.0, tmp_path, top)) < 30
    assert sum(mean_color(fill, 1.0, tmp_path, top)) > 60


def test_keyframes_move_and_opacity(media, tmp_path):
    p = {"name": "kf", "version": 2, "output": {"aspect": "16:9"}, "clips": [
        {"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 4},
        {"solid": {"shape": "rect", "color": "#ff0000", "w": 0.2, "h": 0.2}, "track": 1, "start": 0, "hold": 4,
         "kf": [{"t": 0, "x": 0.1, "y": 0.5, "scale": 1, "opacity": 1}, {"t": 4, "x": 0.9, "y": 0.5, "scale": 2, "opacity": 1}]}]}
    out = export(media, tmp_path, p)
    left = mean_color(out, 0.2, tmp_path, "100:100:100:470")
    right = mean_color(out, 3.8, tmp_path, "100:100:1700:470")
    assert left[0] > 200 and left[1] < 60 and right[0] > 200 and right[1] < 60
    mid = mean_color(out, 0.2, tmp_path, "100:100:1700:470")
    assert not (mid[0] > 200 and mid[1] < 60)
    p["clips"][1]["kf"] = [{"t": 0, "x": 0.5, "y": 0.5, "scale": 1, "opacity": 0}, {"t": 4, "x": 0.5, "y": 0.5, "scale": 1, "opacity": 1}]
    out2 = export(media, tmp_path, {**p, "name": "kf2"})
    assert ffprobe_of(out2)["duration"] == pytest.approx(4.0, abs=0.3)


def test_output_options_gif_mp3_size(media, tmp_path):
    base = {"version": 2, "clips": [{"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 2}]}
    out = export(media, tmp_path, {**base, "name": "small", "output": {"aspect": "16:9", "size": 360, "quality": "small", "fps": 24}})
    info = ffprobe_of(out)
    assert (info["width"], info["height"]) == (640, 360) and info["fps"] == pytest.approx(24, abs=0.5)
    mp3 = export(media, tmp_path, {**base, "name": "aud", "output": {"format": "mp3"}})
    assert mp3.suffix == ".mp3" and ffprobe_of(mp3)["has_audio"] and not ffprobe_of(mp3)["has_video"]
    gif = export(media, tmp_path, {**base, "name": "ani", "output": {"format": "gif"}})
    assert gif.suffix == ".gif" and ffprobe_of(gif)["has_video"]


def test_cover_image_and_frame_capture_and_batch(media, tmp_path):
    client, jobs = make_client(media, tmp_path)
    base = {"name": "cov", "version": 2, "clips": [{"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 3}],
            "output": {"cover_t": 1.5}}
    r = client.post("/api/edit/export", json=base)
    assert wait_done(jobs, r.json()["id"])["status"] == "done"
    probe_out = subprocess.run([editor.find_tool("ffprobe", APP_DIR), "-v", "error", "-show_entries", "stream=codec_name:stream_disposition=attached_pic",
                                "-of", "json", str(media / r.json()["output"])], capture_output=True, text=True, check=False).stdout
    assert "mjpeg" in probe_out and '"attached_pic": 1' in probe_out
    fr = client.post("/api/edit/frame", json={"project": base, "t": 1.0})
    assert fr.status_code == 200 and (media / fr.json()["output"]).stat().st_size > 1000
    b = client.post("/api/edit/export", json={**base, "name": "bat", "output": {}, "batch": ["16:9", "9:16", "bogus"]})
    res = b.json()["jobs"]
    assert len(res) == 2 and {x["output"] for x in res} == {"bat_16x9.mp4", "bat_9x16.mp4"}
    for x in res:
        assert wait_done(jobs, x["id"])["status"] == "done"
    assert ffprobe_of(media / "bat_9x16.mp4")["height"] == 1920


# ---------- v1.3.1: 자막/글자 연출 ----------
@pytest.mark.parametrize("fx,needle", [
    ({"in": "fade", "out": "fade"}, r"\fad("), ({"in": "pop"}, r"\fscx45"), ({"in": "slide-l"}, r"\move("),
    ({"in": "blur"}, r"\blur28"), ({"in": "zoom"}, r"\fscx230"), ({"loop": "marquee-r"}, r"\move("),
    ({"loop": "shake"}, r"\frz"), ({"loop": "float"}, r"\fscy"), ({"kara": True}, r"\kf"),
    ({"box": True, "box_color": "#ff0000"}, r"\3c&H000000FF")])
def test_ass_effects_tags(fx, needle):
    p = editor.normalize({"clips": [{"src": "a", "in": 0, "out": 3}],
                          "subs": [{"start": 0, "end": 3, "text": "안녕 하세요", "fx": fx}],
                          "texts": [{"start": 0, "end": 3, "text": "제목", "fx": fx}]})
    ass = editor.build_ass(p, 1920, 1080)
    assert ass.count(needle) >= 2


def test_ass_typing_events_and_default_fx():
    p = editor.normalize({"clips": [{"src": "a", "in": 0, "out": 3}], "subs": [{"start": 1, "end": 4, "text": "가나다"}],
                          "sub_style": {"fx": {"in": "typing", "in_dur": 1.5}}})
    ev = [ln for ln in editor.build_ass(p, 1280, 720).splitlines() if ln.startswith("Dialogue")]
    assert len(ev) == 3 and ev[-1].endswith("가나다") and r"{\alpha&HFF&}" in ev[0]
    assert p["subs"][0]["fx"] is None and p["sub_style"]["fx"]["in"] == "typing"


def test_export_with_effects(media, tmp_path):
    out = export(media, tmp_path, {
        "name": "fxsub", "version": 2, "clips": [{"src": "a.mp4", "track": 0, "start": 0, "in": 0, "out": 3}],
        "subs": [{"start": 0, "end": 3, "text": "타이핑 자막", "fx": {"in": "typing", "out": "fade", "box": True}}],
        "texts": [{"start": 0, "end": 3, "text": "흐르는 글자", "x": 0.5, "y": 0.2, "fx": {"loop": "marquee-l"}}]})
    assert ffprobe_of(out)["duration"] == pytest.approx(3.0, abs=0.3)


def test_free_rotation_angle(media, tmp_path):
    p = {"name": "rot", "version": 2, "output": {"aspect": "16:9"}, "clips": [
        {"solid": {"shape": "rect", "color": "#ff0000", "w": 0.5, "h": 0.1}, "track": 0, "start": 0, "hold": 2, "angle": 90}]}
    out = export(media, tmp_path, p)
    # 가로로 긴 막대를 90도 돌렸으니 중앙 세로축에는 빨강, 가로 끝(왼쪽 위쪽)은 검정
    assert mean_color(out, 1.0, tmp_path, "40:200:940:100")[0] > 200
    assert sum(mean_color(out, 1.0, tmp_path, "100:40:400:520")) < 40
