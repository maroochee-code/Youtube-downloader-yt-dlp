"""YT 다운로더 - yt-dlp 기반 로컬 다운로더 (FastAPI + 웹 UI)."""
import argparse
import hashlib
import importlib.metadata
import io
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
import webbrowser
import zipfile
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)  # PyInstaller exe 로 실행 중인지
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent  # 쓰기 가능한 위치
RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))  # 번들된 리소스(static) 위치
UPDATE_DIR = APP_DIR / "yt_dlp_update"  # exe 에서 yt-dlp 업데이트 시 새 버전이 풀리는 곳
if (UPDATE_DIR / "yt_dlp").is_dir():
    sys.path.insert(0, str(UPDATE_DIR))

import uvicorn
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE = APP_DIR
STATIC = RES_DIR / "static"
CONFIG = APP_DIR / "config.json"
ARCHIVE = APP_DIR / "archive.txt"
DEFAULT_DIR = (str(Path.home() / "Downloads" / "YT다운로더") if FROZEN
               else r"D:\CusomProjectClaudCode\ytdlp\download")

DEFAULTS = {
    "download_dir": DEFAULT_DIR,
    "outtmpl": "%(title)s.%(ext)s",
    "rate_limit": "",
    "retries": 10,
    "cookies_browser": "",
    "proxy": "",
    "use_archive": False,
    "theme": "dark",  # dark | light | system
}
MEDIA_EXT = {".mp4", ".mkv", ".webm", ".mp3", ".m4a", ".opus", ".flac", ".m4v", ".mov", ".ogg", ".wav"}
AUDIO_EXT = {".mp3", ".m4a", ".opus", ".flac", ".ogg", ".wav"}
THUMB_EXT = (".jpg", ".jpeg", ".png", ".webp")
TEMP_RE = re.compile(r"\.f\d+\.[^.]+$|\.temp\.[^.]+$")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

app = FastAPI()
_lock = threading.Lock()
_dl_slot = threading.Semaphore(1)
jobs: dict[str, dict] = {}


# ---------- 설정 ----------
def get_settings() -> dict:
    s = dict(DEFAULTS)
    try:
        s.update(json.loads(CONFIG.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return s


def save_settings(s: dict) -> None:
    CONFIG.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


def media_dir() -> Path:
    p = Path(get_settings()["download_dir"])
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError:
        p = BASE / "download"
        p.mkdir(parents=True, exist_ok=True)
    return p


def clean(msg: str) -> str:
    return ANSI_RE.sub("", msg).replace("ERROR: ", "").strip()


def check_url(url: str) -> str:
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        raise HTTPException(400, "http:// 또는 https:// 로 시작하는 주소를 입력하세요.")
    return url


def common_args(s: dict) -> list[str]:
    a = ["--ignore-config", "--no-mtime", "--windows-filenames", "--no-warnings",
         "-R", str(int(s["retries"] or 10))]
    if s["rate_limit"]:
        a += ["-r", str(s["rate_limit"])]
    if s["proxy"]:
        a += ["--proxy", s["proxy"]]
    if s["cookies_browser"]:
        a += ["--cookies-from-browser", s["cookies_browser"]]
    local_ffmpeg = APP_DIR / "ffmpeg"
    if local_ffmpeg.exists():  # 함께 들어 있는 ffmpeg 를 우선 사용
        a += ["--ffmpeg-location", str(local_ffmpeg)]
    return a


# ---------- 정보 조회 ----------
class InfoReq(BaseModel):
    url: str
    playlist: bool = False


def thumb_of(d: dict) -> str | None:
    if d.get("thumbnail"):
        return d["thumbnail"]
    t = d.get("thumbnails") or []
    if t:
        return t[-1].get("url")
    if d.get("id") and "youtube" in str(d.get("ie_key") or d.get("extractor_key") or "").lower():
        return f"https://i.ytimg.com/vi/{d['id']}/mqdefault.jpg"
    return None


@app.post("/api/info")
def api_info(req: InfoReq):
    url = check_url(req.url)
    args = common_args(get_settings()) + ["--skip-download"]
    args += ["--yes-playlist" if req.playlist else "--no-playlist", "--flat-playlist"]
    opts = yt_dlp.parse_options(args).ydl_opts
    opts.update(quiet=True, noprogress=True)
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            d = y.extract_info(url, download=False)
    except Exception as e:  # yt-dlp 오류는 종류가 다양함
        raise HTTPException(400, clean(str(e)))
    if not d:
        raise HTTPException(400, "정보를 가져오지 못했습니다.")

    if d.get("_type") == "playlist":
        entries = []
        for i, e in enumerate(d.get("entries") or [], 1):
            if not e:
                continue
            entries.append({"index": i, "id": e.get("id"), "title": e.get("title") or e.get("id"),
                            "duration": e.get("duration"), "thumb": thumb_of(e)})
        return {"type": "playlist", "title": d.get("title"), "uploader": d.get("uploader") or d.get("channel"),
                "thumb": entries[0]["thumb"] if entries else None, "entries": entries,
                "extractor": d.get("extractor_key")}

    heights = sorted({f["height"] for f in d.get("formats", [])
                      if f.get("height") and f.get("vcodec") not in (None, "none")}, reverse=True)
    is_yt = str(d.get("extractor_key", "")).lower() == "youtube"
    return {"type": "video", "id": d.get("id"), "title": d.get("title"),
            "uploader": d.get("uploader") or d.get("channel"), "duration": d.get("duration"),
            "thumb": thumb_of(d), "heights": heights, "is_live": bool(d.get("is_live")),
            "embed": d.get("id") if is_yt and d.get("playable_in_embed") is not False else None,
            "page_url": d.get("webpage_url"), "extractor": d.get("extractor_key"),
            "has_list": "list=" in url}


# ---------- 다운로드 ----------
class DlReq(BaseModel):
    url: str
    mode: str = "video"          # video | audio
    height: int = 0              # 0 = 최고화질
    vformat: str = "mp4"
    aformat: str = "mp3"
    playlist: bool = False
    items: list[int] = []
    subs: bool = False
    sub_langs: str = "ko,en"
    sub_embed: bool = True
    start: str = ""
    end: str = ""
    embed_meta: bool = True
    embed_thumb: bool = True
    sponsorblock: bool = False


def build_args(req: DlReq, s: dict) -> list[str]:
    a = common_args(s)
    a += ["-P", str(media_dir()), "-o", s["outtmpl"] or DEFAULTS["outtmpl"]]
    if req.mode == "audio":
        if req.aformat not in ("mp3", "m4a", "opus", "flac"):
            raise HTTPException(400, "지원하지 않는 음원 형식입니다.")
        a += ["-f", "bestaudio/best", "-x", "--audio-format", req.aformat, "--audio-quality", "0"]
    else:
        if req.vformat not in ("mp4", "mkv", "webm"):
            raise HTTPException(400, "지원하지 않는 영상 형식입니다.")
        hs = f"[height<={int(req.height)}]" if req.height else ""
        if req.vformat == "mp4":
            fmt = f"bv*{hs}[ext=mp4]+ba[ext=m4a]/bv*{hs}+ba/b{hs}/b"
        elif req.vformat == "webm":
            fmt = f"bv*{hs}[ext=webm]+ba[ext=webm]/bv*{hs}+ba/b{hs}/b"
        else:
            fmt = f"bv*{hs}+ba/b{hs}/b"
        a += ["-f", fmt, "--merge-output-format", req.vformat]
    a += ["--write-thumbnail", "--convert-thumbnails", "jpg"]
    if req.embed_thumb:
        a += ["--embed-thumbnail"]
    if req.embed_meta:
        a += ["--embed-metadata", "--embed-chapters"]
    if req.subs:
        langs = re.sub(r"[^A-Za-z0-9,_\-\.\*]", "", req.sub_langs) or "ko,en"
        a += ["--write-subs", "--write-auto-subs", "--sub-langs", langs]
        if req.sub_embed and req.mode == "video":
            a += ["--embed-subs"]
    if req.start.strip() or req.end.strip():
        st = re.sub(r"[^0-9:.]", "", req.start) or "0"
        en = re.sub(r"[^0-9:.]", "", req.end) or "inf"
        a += ["--download-sections", f"*{st}-{en}"]
    if req.sponsorblock:
        a += ["--sponsorblock-remove", "sponsor,selfpromo,interaction"]
    if req.playlist:
        a += ["--yes-playlist"]
        if req.items:
            a += ["--playlist-items", ",".join(str(int(i)) for i in sorted(set(req.items)))]
    else:
        a += ["--no-playlist"]
    if s["use_archive"]:
        a += ["--download-archive", str(ARCHIVE)]
    return a


def run_job(jid: str, url: str, args: list[str]) -> None:
    job = jobs[jid]

    def hook(d):
        if job["cancel"]:
            raise yt_dlp.utils.DownloadCancelled()
        info = d.get("info_dict") or {}
        job["title"] = info.get("title") or job["title"]
        if info.get("playlist_index"):
            job["index"], job["total"] = info["playlist_index"], info.get("n_entries")
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            pct = d["downloaded_bytes"] / total * 100 if total else 0
            job.update(status="downloading", percent=round(pct, 1), speed=d.get("speed"), eta=d.get("eta"))
        elif d["status"] == "finished":
            job.update(status="processing", percent=100, speed=None, eta=None)

    def pp_hook(d):
        if d["status"] == "started":
            job.update(status="processing", stage=d.get("postprocessor"))

    with _dl_slot:  # 동시에 하나씩만 실행 (같은 제목의 파일을 동시에 쓰다 충돌하는 것을 방지)
        try:
            if job["cancel"]:
                raise yt_dlp.utils.DownloadCancelled()
            opts = yt_dlp.parse_options(args).ydl_opts
            opts.update(quiet=True, noprogress=True, progress_hooks=[hook], postprocessor_hooks=[pp_hook])
            with yt_dlp.YoutubeDL(opts) as y:
                y.download([url])
            job.update(status="done", percent=100, speed=None, eta=None)
        except yt_dlp.utils.DownloadCancelled:
            job.update(status="cancelled")
        except Exception as e:
            job.update(status="error", error=clean(str(e)))
        finally:
            job["finished"] = time.time()


@app.post("/api/download")
def api_download(req: DlReq):
    url = check_url(req.url)
    if req.playlist and not req.items:
        raise HTTPException(400, "받을 영상을 하나 이상 선택하세요.")
    args = build_args(req, get_settings())
    jid = uuid.uuid4().hex[:8]
    with _lock:
        jobs[jid] = {"id": jid, "url": url, "title": url, "status": "starting", "percent": 0, "speed": None,
                     "eta": None, "stage": None, "index": None, "total": None, "error": None,
                     "cancel": False, "started": time.time(), "finished": None, "mode": req.mode}
    threading.Thread(target=run_job, args=(jid, url, args), daemon=True).start()
    return {"id": jid}


@app.get("/api/jobs")
def api_jobs():
    with _lock:
        return sorted(jobs.values(), key=lambda j: j["started"], reverse=True)[:6]


@app.post("/api/jobs/{jid}/cancel")
def api_cancel(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    jobs[jid]["cancel"] = True
    return {"ok": True}


# ---------- 저장 목록 / 파일 ----------
def safe_file(name: str) -> Path:
    d = media_dir().resolve()
    p = (d / name).resolve()
    if p.parent != d or not p.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    return p


@app.get("/api/library")
def api_library():
    d = media_dir()
    items = []
    for p in d.iterdir():
        if not p.is_file() or p.suffix.lower() not in MEDIA_EXT or TEMP_RE.search(p.name):
            continue
        st = p.stat()
        thumb = next((p.with_suffix(e).name for e in THUMB_EXT if p.with_suffix(e).exists()), None)
        items.append({"name": p.name, "title": p.stem, "ext": p.suffix.lower().lstrip("."), "size": st.st_size,
                      "mtime": st.st_mtime, "audio": p.suffix.lower() in AUDIO_EXT, "thumb": thumb})
    items.sort(key=lambda i: i["mtime"], reverse=True)
    return {"dir": str(d), "items": items}


@app.get("/api/file")
def api_file(name: str):
    return FileResponse(safe_file(name))


class NameReq(BaseModel):
    name: str


@app.post("/api/reveal")
def api_reveal(req: NameReq):
    p = safe_file(req.name)
    subprocess.Popen(f'explorer /select,"{p}"')
    return {"ok": True}


@app.post("/api/open-folder")
def api_open_folder():
    os.startfile(media_dir())  # type: ignore[attr-defined]
    return {"ok": True}


@app.post("/api/pick-folder")
def api_pick_folder():
    out = ""
    try:
        import webview
        if webview.windows:  # 앱 창 안에서는 기본 폴더 선택 창 사용
            kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
            r = webview.windows[0].create_file_dialog(kind, directory=str(media_dir()))
            out = r[0] if r else ""
        elif not FROZEN:
            code = ("import tkinter as tk\nfrom tkinter import filedialog\nr=tk.Tk();r.withdraw();"
                    "r.attributes('-topmost',True)\nprint(filedialog.askdirectory(initialdir=%r) or '')"
                    % str(media_dir()))
            out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True).stdout.strip()
    except Exception as e:
        raise HTTPException(500, f"폴더 선택 창을 열지 못했습니다: {e}")
    if out:
        s = get_settings()
        s["download_dir"] = str(Path(out))
        save_settings(s)
    return {"dir": str(media_dir())}


# ---------- 설정 / 부가 ----------
@app.get("/api/settings")
def api_get_settings():
    return get_settings()


@app.post("/api/settings")
def api_set_settings(body: dict):
    s = get_settings()
    for k in DEFAULTS:
        if k in body:
            s[k] = body[k]
    try:
        s["retries"] = max(0, int(s["retries"]))
    except (TypeError, ValueError):
        s["retries"] = 10
    s["use_archive"] = bool(s["use_archive"])
    if s["theme"] not in ("dark", "light", "system"):
        s["theme"] = "dark"
    if s["rate_limit"] and yt_dlp.utils.parse_bytes(str(s["rate_limit"])) is None:
        raise HTTPException(400, "속도 제한 형식이 올바르지 않습니다. 예: 2M, 500K")
    try:
        Path(s["download_dir"]).mkdir(parents=True, exist_ok=True)
    except OSError:
        raise HTTPException(400, "다운로드 폴더를 만들 수 없습니다.")
    save_settings(s)
    return s


_sites_cache: list | None = None


@app.get("/api/extractors")
def api_extractors():
    global _sites_cache
    if _sites_cache is None:
        sites: dict[str, str] = {}
        for ie in yt_dlp.extractor.gen_extractor_classes():
            name = ie.IE_NAME
            if name == "generic" or getattr(ie, "IE_DESC", None) is False or not ie.working():
                continue
            key = name.split(":")[0]
            sites.setdefault(key, getattr(ie, "IE_DESC", None) or "")
        _sites_cache = [{"name": k, "desc": v} for k, v in sorted(sites.items(), key=lambda x: x[0].lower())]
    return _sites_cache


@app.get("/api/about")
def api_about():
    return {"yt_dlp": yt_dlp.version.__version__, "ffmpeg": bool(shutil.which("ffmpeg") or (APP_DIR / "ffmpeg").exists())}


def ver_key(v: str) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v))


def active_jobs() -> bool:
    return any(j["status"] in ("starting", "downloading", "processing") for j in jobs.values())


def update_frozen() -> str:
    with urllib.request.urlopen("https://pypi.org/pypi/yt-dlp/json", timeout=15) as r:
        meta = json.load(r)
    whl = next(u for u in meta["urls"] if u["filename"].endswith(".whl"))
    with urllib.request.urlopen(whl["url"], timeout=120) as r:
        data = r.read()
    if hashlib.sha256(data).hexdigest() != whl["digests"]["sha256"]:
        raise ValueError("내려받은 파일의 검증에 실패했습니다.")
    tmp = APP_DIR / "yt_dlp_update.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(tmp, [m for m in z.namelist() if m.startswith("yt_dlp/")])
    shutil.rmtree(UPDATE_DIR, ignore_errors=True)
    tmp.rename(UPDATE_DIR)
    return meta["info"]["version"]


@app.get("/api/update-check")
def api_update_check():
    cur = yt_dlp.version.__version__
    try:
        with urllib.request.urlopen("https://pypi.org/pypi/yt-dlp/json", timeout=6) as r:
            latest = json.load(r)["info"]["version"]
    except Exception:  # 오프라인 등
        return {"current": cur, "latest": None, "outdated": False}
    return {"current": cur, "latest": latest, "outdated": ver_key(latest) > ver_key(cur)}


@app.post("/api/update")
def api_update():
    if active_jobs():
        raise HTTPException(409, "진행 중인 다운로드가 있습니다. 끝난 뒤 업데이트하세요.")
    if FROZEN:  # exe 에는 pip 이 없으므로 PyPI 의 wheel 을 받아 yt_dlp_update 폴더에 푼다
        try:
            return {"ok": True, "version": update_frozen(), "log": ""}
        except Exception as e:
            return {"ok": False, "version": "", "log": f"{type(e).__name__}: {e}"[-300:]}
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-U", "yt-dlp"], capture_output=True, text=True,
                       creationflags=0x08000000)  # CREATE_NO_WINDOW
    try:
        ver = importlib.metadata.version("yt-dlp")
    except importlib.metadata.PackageNotFoundError:
        ver = ""
    return {"ok": r.returncode == 0, "version": ver, "log": (r.stdout + r.stderr)[-400:]}


@app.post("/api/restart")
def api_restart():
    if active_jobs():
        raise HTTPException(409, "진행 중인 다운로드가 있습니다. 끝난 뒤 다시 시작하세요.")

    def go():
        script = [] if FROZEN else [str(BASE / "app.py")]
        args = [sys.executable, *script, *sys.argv[1:], "--delay", "1.5"]
        subprocess.Popen(args, cwd=BASE, creationflags=0x00000008 | 0x00000200)  # DETACHED | NEW_PROCESS_GROUP
        os._exit(0)

    threading.Timer(0.3, go).start()
    return {"ok": True}


@app.post("/api/quit")
def api_quit():
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


# ---------- 실행 ----------
def free_port(preferred: int) -> int:
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", preferred)) != 0:
            return preferred
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def open_window(url: str) -> None:
    for exe in (shutil.which("msedge"), r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe", shutil.which("chrome")):
        if exe and Path(exe).exists():
            subprocess.Popen([exe, f"--app={url}", "--window-size=1240,860"])
            return
    webbrowser.open(url)


LOADING_HTML = ("<body style='margin:0;display:flex;align-items:center;justify-content:center;height:100vh;"
                "font:15px Segoe UI,Malgun Gothic,sans-serif;background:#1b1b1a;color:#b4b2a9'>"
                "YT 다운로더를 시작하는 중…</body>")


def run_with_window(port: int) -> bool:
    """UI 창을 먼저 띄우고, 같은 프로세스 안에서 서버를 시작한다. pywebview가 없으면 False."""
    try:
        import webview
    except ImportError:
        return False
    url = f"http://127.0.0.1:{port}"
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    window = webview.create_window("YT 다운로더", html=LOADING_HTML, width=1240, height=860, min_size=(900, 600))

    def boot():
        for _ in range(150):
            if server.started:
                break
            time.sleep(0.1)
        window.load_url(url)

    webview.start(boot)
    os._exit(0)  # 창을 닫으면 서버와 진행 중 작업도 함께 종료


if __name__ == "__main__":
    if sys.stdout is None or sys.stderr is None:  # pythonw(콘솔 없음) 실행 대비
        sys.stdout = sys.stderr = open(os.devnull, "w")
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-window", action="store_true")
    ap.add_argument("--delay", type=float, default=0)
    ns = ap.parse_args()
    time.sleep(ns.delay)  # 재시작 시 이전 프로세스가 포트를 놓을 때까지 대기
    port = free_port(ns.port)
    media_dir()
    if not ns.no_window and run_with_window(port):
        sys.exit(0)
    if not ns.no_window:
        threading.Timer(1.0, open_window, args=(f"http://127.0.0.1:{port}",)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
