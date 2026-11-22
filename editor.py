"""영상 편집 엔진: 편집 목록(JSON) -> ffmpeg 내보내기.

화면(static/editor.js)은 편집 목록만 고치고, 마지막에 이 모듈이 목록대로 ffmpeg 로 영상을 만든다.
원본 파일은 건드리지 않는다.
"""
from __future__ import annotations

import itertools
import json
import math
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080)}
SUB_POS = {"bottom": 2, "middle": 5, "top": 8}  # ASS 정렬 번호
FONT_FILES = ("malgun.ttf", "malgunbd.ttf")  # 윈도우 기본 한글 폰트(맑은 고딕)
CRF = {"high": 17, "normal": 20, "small": 25}
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif")
BAD_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class EditError(ValueError):
    """사용자에게 그대로 보여 줄 수 있는 편집 오류."""


# ---------- 도구 찾기 / 파일 정보 ----------
def find_tool(name: str, app_dir: Path) -> str:
    for d in (app_dir / "ffmpeg", app_dir / "ffmpeg_bin"):
        for exe in (d / f"{name}.exe", d / name):
            if exe.is_file():
                return str(exe)
    return shutil.which(name) or name


def probe(path: Path, app_dir: Path) -> dict:
    cmd = [find_tool("ffprobe", app_dir), "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
           str(path)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           check=False, creationflags=CREATE_NO_WINDOW, timeout=60)
        d = json.loads(r.stdout or "{}")
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        raise EditError(f"파일 정보를 읽지 못했습니다: {e}") from e
    vs = next((s for s in d.get("streams", []) if s.get("codec_type") == "video"
               and not (s.get("disposition") or {}).get("attached_pic")), None)
    has_audio = any(s.get("codec_type") == "audio" for s in d.get("streams", []))
    dur = float((d.get("format") or {}).get("duration") or (vs or {}).get("duration") or 0)
    if not vs and not has_audio:
        raise EditError("영상이나 오디오 파일이 아닙니다.")
    fps = 0.0
    if vs and "/" in str(vs.get("avg_frame_rate", "")):
        a, _, b = vs["avg_frame_rate"].partition("/")
        fps = float(a) / float(b) if float(b or 0) else 0.0
    return {"duration": round(dur, 3), "has_video": bool(vs), "has_audio": has_audio,
            "is_image": path.suffix.lower() in IMAGE_EXT and bool(vs),
            "width": int((vs or {}).get("width") or 0), "height": int((vs or {}).get("height") or 0),
            "fps": round(fps, 3)}


WAVE_RATE = 20  # 파형은 초당 20칸


def waveform(path: Path, app_dir: Path) -> list[int]:
    """오디오를 8kHz 모노로 풀어서 0.05초마다 가장 큰 소리 크기(0~100)를 구한다."""
    cmd = [find_tool("ffmpeg", app_dir), "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000",
           "-f", "s16le", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, check=False, creationflags=CREATE_NO_WINDOW, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise EditError(f"파형을 만들지 못했습니다: {e}") from e
    data = r.stdout
    step = 8000 // WAVE_RATE * 2
    peaks = []
    for i in range(0, len(data) - 1, step):
        chunk = memoryview(data[i:i + step]).cast("h")
        peaks.append(min(100, round(max((abs(v) for v in chunk), default=0) / 327.68)))
    return peaks


# ---------- 편집 목록 정리 ----------
VERSION = 2
MAX_TRACKS = 8
TRANS_TYPES = ("fade", "slide-l", "slide-r", "slide-u", "slide-d")  # 디졸브, 오른쪽/왼쪽/아래/위에서 밀려 들어옴


def _num(v, default: float, lo: float, hi: float) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        x = default
    return min(max(x, lo), hi)


def _id(item: dict, prefix: str) -> str:
    return str(item.get("id") or f"{prefix}{uuid.uuid4().hex[:6]}")


def _color(v, default: str) -> str:
    return v if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v) else default


FX_IN = ("none", "fade", "typing", "pop", "slide-l", "slide-r", "slide-u", "slide-d", "blur", "zoom")
FX_OUT = ("none", "fade")
FX_LOOP = ("none", "shake", "float", "marquee-l", "marquee-r")


def _fx(raw) -> dict | None:
    """자막/글자 연출 설정. 딕셔너리가 아니면 None(= 공통 설정을 따름)."""
    if not isinstance(raw, dict):
        return None
    return {"in": raw.get("in") if raw.get("in") in FX_IN else "none", "in_dur": _num(raw.get("in_dur"), 0.5, 0.1, 5),
            "out": raw.get("out") if raw.get("out") in FX_OUT else "none", "out_dur": _num(raw.get("out_dur"), 0.4, 0.1, 5),
            "loop": raw.get("loop") if raw.get("loop") in FX_LOOP else "none",
            "kara": bool(raw.get("kara")), "kara_color": _color(raw.get("kara_color"), "#ffd24d"),
            "box": bool(raw.get("box")), "box_color": _color(raw.get("box_color"), "#000000"),
            "box_opacity": _num(raw.get("box_opacity"), 0.6, 0, 1)}


NO_FX = _fx({})


def _kf(raw) -> list[dict]:
    """키프레임: 클립 안에서의 시간 t(초)와 그 순간의 위치/크기/투명도."""
    pts: dict[float, dict] = {}
    for k in (raw if isinstance(raw, list) else [])[:60]:
        if not isinstance(k, dict):
            continue
        t = round(_num(k.get("t"), 0, 0, 3600), 3)
        pts[t] = {"t": t, "x": _num(k.get("x"), 0.5, -2, 3), "y": _num(k.get("y"), 0.5, -2, 3),
                  "scale": _num(k.get("scale"), 1, 0.05, 5), "opacity": _num(k.get("opacity"), 1, 0, 1)}
    return [pts[t] for t in sorted(pts)]


def migrate(project: dict) -> dict:
    """v1(영상 한 줄, 순서대로) 프로젝트를 v2(줄 번호 + 시작 시간)로 바꾼다. 이미 v2면 그대로."""
    if not isinstance(project, dict):
        return {}
    if int(project.get("version") or 1) >= 2:
        return project
    p = dict(project)
    t = 0.0
    clips = []
    for c in project.get("clips") or []:
        c = dict(c)
        c.setdefault("track", 0)
        try:
            sp = min(max(float(c.get("speed") or 1), 0.25), 4)
            c["start"] = round(t, 3)
            t += (float(c.get("out") or 0) - float(c.get("in") or 0)) / sp
        except (TypeError, ValueError):
            c["start"] = round(t, 3)
        clips.append(c)
    auds = []
    for a in project.get("audios") or []:
        a = dict(a)
        a.setdefault("track", 0)
        a["start"] = a.get("at", 0)
        auds.append(a)
    p.update(version=2, clips=clips, audios=auds)
    return p


def _tracks(raw, need: int) -> list[dict]:
    arr = raw if isinstance(raw, list) else []
    out = [{"mute": bool(t.get("mute")), "lock": bool(t.get("lock")), "hide": bool(t.get("hide"))}
           for t in arr[:MAX_TRACKS] if isinstance(t, dict)]
    while len(out) < max(need, 1):
        out.append({"mute": False, "lock": False, "hide": False})
    return out


def normalize(project: dict) -> dict:
    """화면에서 온 값을 안전한 범위로 정리한다. 영상이 하나도 없으면 오류."""
    project = migrate(project)
    out = {
        "version": VERSION,
        "name": BAD_NAME.sub("_", str(project.get("name") or "편집본")).strip(" .") or "편집본",
        "tracks": {}, "clips": [], "audios": [], "subs": [], "texts": [],
        "sub_style": {}, "output": {},
    }
    raw_tr = project.get("tracks") or {}
    vmax = amax = 0
    for c in project.get("clips") or []:
        src = str(c.get("src") or "")
        sd = c.get("solid") if isinstance(c.get("solid"), dict) else None
        if not src and not sd:
            continue
        track = int(_num(c.get("track"), 0, 0, MAX_TRACKS - 1))
        vmax = max(vmax, track)
        solid = None
        if sd:
            solid = {"shape": sd.get("shape") if sd.get("shape") in ("rect", "ellipse") else "rect",
                     "color": _color(sd.get("color"), "#000000"),
                     "w": _num(sd.get("w"), 1, 0.01, 1), "h": _num(sd.get("h"), 1, 0.01, 1)}
            src = ""
        image = bool(c.get("image")) and not solid
        freeze = bool(c.get("freeze")) or image or bool(solid)
        cin = _num(c.get("in"), 0, 0, 1e6)
        cout = _num(c.get("out"), cin + 1, 0, 1e6)
        if freeze:
            cout = cin + 0.1
        elif cout - cin < 0.05:
            raise EditError("자른 구간이 너무 짧습니다. (0.05초 이상)")
        trans = c.get("trans")
        ttype = trans.get("type") if isinstance(trans, dict) else None
        out["clips"].append({
            "id": _id(c, "c"), "src": src, "track": track, "start": _num(c.get("start"), 0, 0, 1e6),
            "in": cin, "out": cout, "speed": 1.0 if freeze else _num(c.get("speed"), 1, 0.25, 4),
            "volume": _num(c.get("volume"), 1, 0, 4), "mute": bool(c.get("mute")) or freeze,
            "x": _num(c.get("x"), 0.5, -2, 3), "y": _num(c.get("y"), 0.5, -2, 3),
            "scale": _num(c.get("scale"), 1, 0.05, 5), "opacity": _num(c.get("opacity"), 1, 0, 1),
            "fade_in": _num(c.get("fade_in"), 0, 0, 60), "fade_out": _num(c.get("fade_out"), 0, 0, 60),
            "trans": {"type": ttype} if ttype in TRANS_TYPES else None,
            "freeze": freeze, "image": image, "solid": solid, "hold": _num(c.get("hold"), 2, 0.1, 3600),
            "fit": c.get("fit") if c.get("fit") in ("contain", "cover") else None,
            "brightness": _num(c.get("brightness"), 0, -1, 1), "contrast": _num(c.get("contrast"), 1, 0, 3),
            "saturation": _num(c.get("saturation"), 1, 0, 3), "gray": bool(c.get("gray")),
            "blur": _num(c.get("blur"), 0, 0, 30), "flip_h": bool(c.get("flip_h")), "flip_v": bool(c.get("flip_v")),
            "rotate": int(_num(c.get("rotate"), 0, 0, 270)) // 90 * 90 % 360, "angle": _num(c.get("angle"), 0, -360, 360),
            "reverse": bool(c.get("reverse")) and not freeze, "kf": _kf(c.get("kf")),
            "link": c.get("link") or None})
    if not out["clips"]:
        raise EditError("타임라인에 영상이 없습니다. 왼쪽 목록에서 영상을 추가하세요.")
    for a in project.get("audios") or []:
        src = str(a.get("src") or "")
        if not src:
            continue
        track = int(_num(a.get("track"), 0, 0, MAX_TRACKS - 1))
        amax = max(amax, track)
        end = a.get("out")
        out["audios"].append({"id": _id(a, "a"), "src": src, "track": track,
                              "start": _num(a.get("start", a.get("at")), 0, 0, 1e6),
                              "in": _num(a.get("in"), 0, 0, 1e6),
                              "out": None if end in (None, "", 0) else _num(end, 0, 0, 1e6),
                              "speed": _num(a.get("speed"), 1, 0.25, 4),
                              "volume": _num(a.get("volume"), 1, 0, 4),
                              "fade_in": _num(a.get("fade_in"), 0, 0, 60), "fade_out": _num(a.get("fade_out"), 0, 0, 60),
                              "duck": bool(a.get("duck")), "duck_level": _num(a.get("duck_level"), 0.25, 0, 1),
                              "link": a.get("link") or None})
    out["tracks"] = {"v": _tracks(raw_tr.get("v"), vmax + 1), "a": _tracks(raw_tr.get("a"), amax + 1)}
    for s in project.get("subs") or []:
        text = str(s.get("text") or "").strip()
        st = _num(s.get("start"), 0, 0, 1e6)
        en = _num(s.get("end"), st + 2, 0, 1e6)
        if text and en > st:
            out["subs"].append({"id": _id(s, "s"), "start": st, "end": en, "text": text, "fx": _fx(s.get("fx"))})
    for t in project.get("texts") or []:
        text = str(t.get("text") or "").strip()
        st = _num(t.get("start"), 0, 0, 1e6)
        en = _num(t.get("end"), st + 3, 0, 1e6)
        if text and en > st:
            out["texts"].append({"id": _id(t, "t"), "start": st, "end": en, "text": text,
                                 "x": _num(t.get("x"), 0.5, 0, 1), "y": _num(t.get("y"), 0.15, 0, 1),
                                 "size": _num(t.get("size"), 56, 10, 300), "color": _color(t.get("color"), "#ffffff"),
                                 "fx": _fx(t.get("fx")) or dict(NO_FX)})
    ss = project.get("sub_style") or {}
    pos = ss.get("pos") if ss.get("pos") in SUB_POS else "bottom"
    out["sub_style"] = {"size": _num(ss.get("size"), 48, 10, 200), "color": _color(ss.get("color"), "#ffffff"),
                        "outline": _color(ss.get("outline"), "#000000"), "pos": pos,
                        "fx": _fx(ss.get("fx")) or dict(NO_FX)}
    o = project.get("output") or {}
    size = o.get("size")
    fps_o = o.get("fps")
    cover = o.get("cover_t")
    out["output"] = {"aspect": o.get("aspect") if o.get("aspect") in ASPECTS else "original",
                     "loudnorm": bool(o.get("loudnorm")), "fill": bool(o.get("fill")),
                     "size": int(size) if str(size).isdigit() and 240 <= int(size) <= 2160 else "auto",
                     "quality": o.get("quality") if o.get("quality") in CRF else "normal",
                     "fps": int(fps_o) if str(fps_o).isdigit() and 10 <= int(fps_o) <= 60 else "auto",
                     "format": o.get("format") if o.get("format") in ("mp4", "gif", "mp3") else "mp4",
                     "cover_t": None if cover in (None, "") else _num(cover, 0, 0, 1e5)}
    return out


def clip_duration(c: dict) -> float:
    return c["hold"] if c.get("freeze") else (c["out"] - c["in"]) / c["speed"]


def audio_duration(a: dict, src_duration: float) -> float:
    end = a["out"] if a["out"] else src_duration
    return max(0.05, end - a["in"]) / a["speed"]


def total_duration(p: dict) -> float:
    return max(c["start"] + clip_duration(c) for c in p["clips"])


def overlap_in(p: dict, c: dict) -> float:
    """c 가 같은 줄의 앞 클립과 겹친 길이(초). 전환이 지정된 경우에만 전환 길이가 된다."""
    if not c.get("trans"):
        return 0.0
    cs, ce = c["start"], c["start"] + clip_duration(c)
    best = 0.0
    for o in p["clips"]:
        if o is c or o["track"] != c["track"]:
            continue
        os_, oe = o["start"], o["start"] + clip_duration(o)
        if os_ < cs < oe:
            best = max(best, min(oe, ce) - cs)
    return round(best, 3)


def overlap_out(p: dict, c: dict) -> float:
    """c 의 뒤쪽에서 다음 클립이 전환으로 덮는 길이(초)."""
    cs, ce = c["start"], c["start"] + clip_duration(c)
    best = 0.0
    for d in p["clips"]:
        if d is c or d["track"] != c["track"] or not d.get("trans"):
            continue
        if cs < d["start"] < ce:
            best = max(best, min(ce, d["start"] + clip_duration(d)) - d["start"])
    return round(best, 3)


# ---------- SRT / ASS ----------
SRT_TIME = re.compile(r"(\d+):(\d+):(\d+)[,.](\d{1,3})\s*-->\s*(\d+):(\d+):(\d+)[,.](\d{1,3})")


def parse_srt(text: str) -> list[dict]:
    text = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    subs = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            m = SRT_TIME.search(line)
            if m:
                g = m.groups()
                st = int(g[0]) * 3600 + int(g[1]) * 60 + int(g[2]) + int(g[3].ljust(3, "0")) / 1000
                en = int(g[4]) * 3600 + int(g[5]) * 60 + int(g[6]) + int(g[7].ljust(3, "0")) / 1000
                body = "\n".join(lines[i + 1:]).strip()
                if body and en > st:
                    subs.append({"id": f"s{uuid.uuid4().hex[:6]}", "start": round(st, 3), "end": round(en, 3),
                                 "text": body})
                break
    return subs


def _srt_time(t: float) -> str:
    ms = round(t * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_srt(subs: list[dict]) -> str:
    rows = sorted((s for s in subs if str(s.get("text", "")).strip()), key=lambda s: float(s["start"]))
    return "\n".join(f"{i}\n{_srt_time(float(s['start']))} --> {_srt_time(float(s['end']))}\n{s['text'].strip()}\n"
                     for i, s in enumerate(rows, 1))


def ass_time(t: float) -> str:
    cs = round(t * 100)
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_color(hex_color: str) -> str:
    r, g, b = hex_color[1:3], hex_color[3:5], hex_color[5:7]
    return f"&H00{b}{g}{r}".upper()


def ass_text(t: str) -> str:
    return t.replace("\r", "").replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")


def text_width(text: str, size: float) -> float:
    """글자 폭 어림값(한글/한자는 글자 크기, 영문/숫자는 약 0.55배). 흐르는 자막의 이동 거리 계산용."""
    return max((sum(size if ord(ch) > 0x2E80 else size * 0.55 for ch in line) for line in text.split("\n")), default=0)


def _alpha(op: float) -> str:
    return f"&H{round((1 - op) * 255):02X}&"


def fx_dialogues(layer: int, style: str, start: float, end: float, text: str, fx: dict, *, w: int, h: int,
                 size: float, an: int, pos: tuple[float, float], base: str, color: str, place: bool) -> list[str]:
    """한 줄의 자막/글자를 연출 효과가 들어간 ASS Dialogue 줄(들)로 만든다.

    place=True 이면 \\an/\\pos 를 직접 지정한다(글자 클립은 항상, 자막은 슬라이드/흐름처럼 위치가 필요할 때만).
    """
    dur = max(end - start, 0.05)
    dms = round(dur * 1000)
    ims = min(round(fx["in_dur"] * 1000), dms)
    oms = min(round(fx["out_dur"] * 1000), dms) if fx["out"] == "fade" else 0
    x, y = pos
    tags = base
    kind, loop = fx["in"], fx["loop"]
    need_pos = place or kind.startswith("slide") or loop.startswith("marquee")
    move = ""
    if need_pos:
        tags += f"\\an{an}"
    if loop.startswith("marquee"):
        tw = text_width(text, size)
        x1, x2 = (w + tw / 2, -tw / 2) if loop == "marquee-l" else (-tw / 2, w + tw / 2)
        yy = y - (size / 2 if an == 2 else -size / 2 if an == 8 else 0)
        move = f"\\an5\\move({x1:.0f},{yy:.0f},{x2:.0f},{yy:.0f},0,{dms})"
        tags = tags.replace(f"\\an{an}", "", 1) + move
        kind = "none"
        oms = 0
    elif kind.startswith("slide"):
        d = {"slide-l": (-w * 0.45, 0), "slide-r": (w * 0.45, 0), "slide-u": (0, -h * 0.3), "slide-d": (0, h * 0.3)}[kind]
        tags += f"\\move({x + d[0]:.0f},{y + d[1]:.0f},{x:.0f},{y:.0f},0,{ims})"
    elif need_pos:
        tags += f"\\pos({x:.0f},{y:.0f})"
    if kind == "pop":
        tags += f"\\fscx45\\fscy45\\t(0,{ims},\\fscx112\\fscy112)\\t({ims},{ims + 160},\\fscx100\\fscy100)"
    elif kind == "zoom":
        tags += f"\\fscx230\\fscy230\\alpha&HFF&\\t(0,{ims},\\fscx100\\fscy100\\alpha&H00&)"
    elif kind == "blur":
        tags += f"\\blur28\\t(0,{ims},\\blur0)"
    fin = ims if kind == "fade" else 0
    if fin or oms:
        tags += f"\\fad({fin},{oms})"
    if loop == "shake":
        step = max(60, dms // 200)
        for i, t0 in enumerate(range(0, dms, step)):
            tags += f"\\t({t0},{t0 + step},\\frz{2.2 if i % 2 == 0 else -2.2})"
    elif loop == "float":
        step = max(140, dms // 200)
        for i, t0 in enumerate(range(0, dms, step)):
            sw = math.sin(i * 0.9)
            tags += f"\\t({t0},{t0 + step},\\frz{1.6 * sw:.2f}\\fscy{100 + 4 * sw:.1f})"
    if fx["box"]:
        tags += f"\\3c{ass_color(fx['box_color'])}\\3a{_alpha(fx['box_opacity'])}\\4a&HFF&"
    chars = [c for c in text.replace("\r", "")]

    def one(t0: float, t1: float, body: str, extra: str = "") -> str:
        return f"Dialogue: {layer},{ass_time(t0)},{ass_time(t1)},{style},,0,0,0,,{{{tags}{extra}}}{body}"

    if kind == "typing":
        visible = [c for c in chars if c not in " \n"]
        n = max(len(visible), 1)
        per = min(fx["in_dur"], dur) / n
        out = []
        seen = 0
        for i, ch in enumerate(chars):
            if ch not in " \n":
                seen += 1
            else:
                continue
            # i번째 글자까지 보이고 나머지는 투명하게 둬서 가운데 정렬이 흔들리지 않게 한다
            head = ass_text("".join(chars[:i + 1]))
            tail = ass_text("".join(chars[i + 1:]))
            t0 = start + per * (seen - 1)
            t1 = end if seen == n else start + per * seen
            body = head + (f"{{\\alpha&HFF&}}{tail}" if tail else "")
            out.append(one(t0, t1, body))
        return out or [one(start, end, ass_text(text))]
    if fx["kara"]:
        n = max(len([c for c in chars if c != "\n"]), 1)
        cs = max(1, round(dur * 100 * 0.85 / n))
        body = "".join("\\N" if ch == "\n" else f"{{\\kf{cs}}}{ass_text(ch)}" for ch in chars)
        extra = f"\\1c{ass_color(fx['kara_color'])}\\2c{ass_color(color)}"
        return [one(start, end, body, extra)]
    return [one(start, end, ass_text(text))]


def build_ass(p: dict, w: int, h: int, font: str = "Malgun Gothic") -> str:
    scale = min(w, h) / 1080
    st = p["sub_style"]
    size = round(st["size"] * scale)
    margin_v = round(h * 0.06)
    pad = max(4, round(16 * scale))
    fmt = ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
           "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
           "MarginR, MarginV, Encoding")
    ml = round(w * 0.05)
    out_w = max(1, round(3 * scale))
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]", fmt,
        (f"Style: Sub,{font},{size},{ass_color(st['color'])},{ass_color(st['color'])},{ass_color(st['outline'])},"
         f"&H64000000,1,0,0,0,100,100,0,0,1,{out_w},1,{SUB_POS[st['pos']]},{ml},{ml},{margin_v},1"),
        (f"Style: SubBox,{font},{size},{ass_color(st['color'])},{ass_color(st['color'])},&H80000000,&HFF000000,1,0,0,0,"
         f"100,100,0,0,3,{pad},0,{SUB_POS[st['pos']]},{ml},{ml},{margin_v},1"),
        (f"Style: Txt,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,"
         f"{out_w},1,5,20,20,20,1"),
        (f"Style: TxtBox,{font},{size},&H00FFFFFF,&H00FFFFFF,&H80000000,&HFF000000,1,0,0,0,100,100,0,0,3,{pad},0,5,"
         "20,20,20,1"),
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    an = SUB_POS[st["pos"]]
    sy = {2: h - margin_v, 5: h / 2, 8: margin_v}[an]
    for sub in p["subs"]:
        fx = sub["fx"] or st["fx"]
        lines += fx_dialogues(0, "SubBox" if fx["box"] else "Sub", sub["start"], sub["end"], sub["text"], fx, w=w, h=h,
                              size=size, an=an, pos=(w / 2, sy), base="", color=st["color"], place=False)
    for t in p["texts"]:
        fs = round(t["size"] * scale)
        lines += fx_dialogues(1, "TxtBox" if t["fx"]["box"] else "Txt", t["start"], t["end"], t["text"], t["fx"], w=w,
                              h=h, size=fs, an=5, pos=(t["x"] * w, t["y"] * h), base=f"\\fs{fs}\\c{ass_color(t['color'])}",
                              color=t["color"], place=True)
    return "\n".join(lines) + "\n"


# ---------- ffmpeg 필터 그래프 ----------
def atempo_chain(speed: float) -> str:
    parts, s = [], speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    if abs(s - 1.0) > 1e-6 or not parts:
        parts.append(f"atempo={s:.5f}")
    return ",".join(parts) if abs(speed - 1.0) > 1e-6 else ""


AFMT = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo"


def _slide(kind: str, W: int, H: int, start: float, ov: float) -> tuple[str, str]:
    """슬라이드 전환의 가로/세로 이동량 식. 전환이 시작되면 화면 밖에서 제자리로 들어온다."""
    prog = f"(1-clip((t-{start:.3f})/{ov:.3f},0,1))"
    return {"slide-l": (f"+{W}*{prog}", ""), "slide-r": (f"-{W}*{prog}", ""),
            "slide-u": ("", f"+{H}*{prog}"), "slide-d": ("", f"-{H}*{prog}")}[kind]


DUCK_RAMP = 0.25      # 배경음악이 작아지고 커지는 데 걸리는 시간(초)
DUCK_MAX_SPANS = 60   # 식이 너무 길어지지 않게 말하는 구간은 최대 60개로 합친다


def voice_intervals(p: dict, infos: dict) -> list[tuple[float, float]]:
    """오디오 더킹 기준: 소리가 나는 영상 클립과 더킹이 아닌 오디오가 재생되는 구간."""
    spans = []
    for c in p["clips"]:
        if not (c["freeze"] or c["mute"] or p["tracks"]["v"][c["track"]]["mute"])                 and infos.get(c["src"], {}).get("has_audio"):
            spans.append((c["start"], c["start"] + clip_duration(c)))
    for a in p["audios"]:
        if not a["duck"] and not p["tracks"]["a"][a["track"]]["mute"] and a["src"] in infos:
            end = a["out"] if a["out"] else infos[a["src"]]["duration"]
            spans.append((a["start"], a["start"] + max(0.05, end - a["in"]) / a["speed"]))
    return merge_spans(spans)


def merge_spans(spans: list[tuple[float, float]], gap: float = 2 * DUCK_RAMP) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for s, e in sorted(spans):
        if out and s - out[-1][1] < gap:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    while len(out) > DUCK_MAX_SPANS:
        i = min(range(len(out) - 1), key=lambda k: out[k + 1][0] - out[k][1])
        out[i][1] = out[i + 1][1]
        del out[i + 1]
    return [(s, e) for s, e in out]


def duck_expr(spans: list[tuple[float, float]], level: float) -> str:
    """시간 t 에서의 음량 배율: 말하는 구간이면 level, 앞뒤 DUCK_RAMP 초 동안 서서히 변한다."""
    r = DUCK_RAMP
    terms = [f"clip(min((t-{s - r:.3f})/{r},({e + r:.3f}-t)/{r}),0,1)" for s, e in spans]
    acc = terms[0]
    for t in terms[1:]:
        acc = f"max({acc},{t})"
    return f"1-{1 - level:.3f}*{acc}"


def pw_expr(points: list[tuple[float, float]], var: str) -> str:
    """(시간, 값) 목록을 직선으로 이어 주는 ffmpeg 식. 첫 점 이전/마지막 점 이후에는 그 값을 유지한다."""
    if len(points) == 1:
        return f"{points[0][1]:.5f}"
    expr = f"{points[-1][1]:.5f}"
    for (t0, v0), (t1, v1) in reversed(list(itertools.pairwise(points))):
        span = max(t1 - t0, 1e-3)
        seg = f"{v0:.5f}+({v1 - v0:.5f})*clip(({var}-{t0:.3f})/{span:.3f},0,1)"
        expr = f"if(lt({var},{t1:.3f}),{seg},{expr})"
    return expr


def kf_points(c: dict, key: str, shift: float = 0.0) -> list[tuple[float, float]]:
    return [(k["t"] + shift, k[key]) for k in c["kf"]]


def canvas_size(p: dict, first: dict) -> tuple[int, int]:
    o = p["output"]
    asp, short = o["aspect"], o["size"]
    if asp in ASPECTS:
        w, h = ASPECTS[asp]
        if short != "auto":
            k = short / min(w, h)
            w, h = round(w * k / 2) * 2, round(h * k / 2) * 2
        return w, h
    w, h = (first["width"] // 2 * 2) or 1280, (first["height"] // 2 * 2) or 720
    if short != "auto":
        k = short / min(w, h)
        w, h = round(w * k / 2) * 2, round(h * k / 2) * 2
    return w, h


def build_plan(project: dict, resolve, probe_fn) -> dict:
    """편집 목록 -> {graph, inputs, size, duration, ass, ...}. resolve(src)->Path, probe_fn(Path)->dict.

    검은 바탕 위에 영상 클립을 줄 번호(아래->위) 순서로 겹쳐 놓고, 소리는 모두 시간 위치에 맞춰 섞는다.
    graph = 영상 부분(vgraph) + 소리 부분(agraph). mp3 는 소리만, gif/프레임 캡처는 영상만 쓴다.
    """
    p = normalize(project)
    inputs: list[str] = []
    infos: dict[str, dict] = {}
    index: dict[str, int] = {}
    out_o = p["output"]
    fmt = out_o["format"]

    def use(src: str) -> int:
        if src not in index:
            path = resolve(src)
            infos[src] = probe_fn(path)
            index[src] = len(inputs)
            inputs.append(str(path))
        return index[src]

    for c in p["clips"]:
        if c["solid"]:
            continue
        use(c["src"])
        info = infos[c["src"]]
        if not info["has_video"]:
            raise EditError(f"영상이 아닌 파일은 타임라인에 넣을 수 없습니다: {c['src']}")
        if c["freeze"]:
            c["in"] = min(c["in"], max(0.0, (info["duration"] or c["in"]) - 0.1))
            c["out"] = c["in"] + 0.1
        else:
            c["out"] = min(c["out"], info["duration"] or c["out"])
            if c["out"] - c["in"] < 0.05:
                raise EditError("자른 구간이 영상 길이를 벗어났습니다.")
            if c["reverse"] and c["out"] - c["in"] > MAX_REVERSE:
                raise EditError(f"역재생은 {MAX_REVERSE}초 이하의 구간만 가능합니다. 클립을 나눠서 적용하세요.")
    media = sorted((c for c in p["clips"] if not c["solid"]), key=lambda c: c["start"])
    first = next((infos[c["src"]] for c in media if not infos[c["src"]].get("is_image")), None) \
        or (infos[media[0]["src"]] if media else {"width": 0, "height": 0, "fps": 30})
    w, h = canvas_size(p, first)
    fps = out_o["fps"] if out_o["fps"] != "auto" else int(min(60, max(15, round(first["fps"] or 30))))
    dur = max(total_duration(p), 0.1)
    vtr = p["tracks"]["v"]

    gv: list[str] = []
    ga: list[str] = []
    last = "b0"
    ass = None
    if fmt != "mp3":
        gv.append(f"color=c=black:s={w}x{h}:r={fps}:d={dur:.3f},format=yuv420p[b0]")
        layers = sorted((c for c in p["clips"] if not vtr[c["track"]]["hide"]),
                        key=lambda c: (c["track"], c["start"]))
        for n, c in enumerate(layers):
            last = _layer(p, c, n, last, gv, index, w, h, fps)
        if p["subs"] or p["texts"]:
            ass = build_ass(p, w, h)
            gv.append(f"[{last}]ass=sub.ass:fontsdir=fonts[vout]")
            last = "vout"
        if fmt == "gif":
            gv.append(f"[{last}]fps=12,scale=w='min(480,iw)':h=-2:flags=lanczos,split[g0][g1];[g0]palettegen[gp];"
                      "[g1][gp]paletteuse[gifout]")
            last = "gifout"

    if fmt != "gif":
        _audio(p, infos, index, use, dur, ga)
    amap = "[am]" if ga and ga[-1].endswith("[am]") else "[ab]"
    graph = ";".join(gv if fmt == "gif" else ga if fmt == "mp3" else gv + ga)
    return {"project": p, "graph": graph, "vgraph": ";".join(gv), "inputs": inputs, "size": (w, h), "duration": dur,
            "ass": ass, "vmap": f"[{last}]", "amap": amap, "format": fmt, "fps": fps,
            "ext": {"mp4": ".mp4", "gif": ".gif", "mp3": ".mp3"}[fmt]}


MAX_REVERSE = 120


def _layer(p: dict, c: dict, n: int, last: str, g: list[str], index: dict, w: int, h: int, fps: int) -> str:
    cd = clip_duration(c)
    i = index.get(c["src"])
    ov_in, ttype = overlap_in(p, c), (c["trans"] or {}).get("type")
    fit = c["fit"] or ("cover" if p["output"]["fill"] and not (c["solid"] or c["image"]) else "contain")
    ratio = "increase" if fit == "cover" else "decrease"
    anim = {k: len(c["kf"]) > 0 for k in ("x", "y", "scale", "opacity")}
    sc_expr = pw_expr(kf_points(c, "scale"), "t") if anim["scale"] else None
    sw, sh = max(2, round(w * c["scale"] / 2) * 2), max(2, round(h * c["scale"] / 2) * 2)
    if c["solid"]:
        sd = c["solid"]
        bw, bh = w * sd["w"], h * sd["h"]
        sw, sh = max(2, round(bw * c["scale"] / 2) * 2), max(2, round(bh * c["scale"] / 2) * 2)
        f = f"color=c=0x{sd['color'][1:]}:s={sw}x{sh}:r={fps}:d={cd:.3f},format=yuva420p"
        if sc_expr:
            f += f",scale=w='max(2,trunc({bw:.2f}*({sc_expr})/2)*2)':h='max(2,trunc({bh:.2f}*({sc_expr})/2)*2)':eval=frame"
        if sd["shape"] == "ellipse":
            f += (",geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':"
                  "a='if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)'")
    elif c["freeze"]:
        f = (f"[{i}:v]trim=start={c['in']:.3f}:end={c['in'] + 1:.3f},setpts=PTS-STARTPTS,select='eq(n,0)',"
             f"tpad=stop_mode=clone:stop_duration={c['hold']:.3f},trim=duration={cd:.3f},setpts=PTS-STARTPTS")
    else:
        f = f"[{i}:v]trim=start={c['in']:.3f}:end={c['out']:.3f},setpts=PTS-STARTPTS"
        if c["reverse"]:
            f += ",reverse,setpts=PTS-STARTPTS"
        f += f",setpts=PTS/{c['speed']:.5f}"
    if not c["solid"]:
        f += f",fps={fps}"
        pre = []
        if c["flip_h"]:
            pre.append("hflip")
        if c["flip_v"]:
            pre.append("vflip")
        pre += {0: [], 90: ["transpose=1"], 180: ["hflip", "vflip"], 270: ["transpose=2"]}[c["rotate"]]
        if pre:
            f += "," + ",".join(pre)
        if sc_expr:
            f += (f",scale=w='max(2,trunc({w}*({sc_expr})/2)*2)':h='max(2,trunc({h}*({sc_expr})/2)*2)':"
                  f"force_original_aspect_ratio={ratio}:eval=frame,setsar=1")
        else:
            f += f",scale={sw}:{sh}:force_original_aspect_ratio={ratio}:force_divisible_by=2,setsar=1"
    # 색 보정 / 흑백 / 흐림
    rot_a = abs(c["angle"]) > 0.05
    needs_alpha = c["image"] or bool(c["solid"]) or rot_a
    if needs_alpha:
        f += ",format=yuva420p"
    eqs = []
    if abs(c["brightness"]) > 1e-3:
        eqs.append(f"brightness={c['brightness']:.3f}")
    if abs(c["contrast"] - 1) > 1e-3:
        eqs.append(f"contrast={c['contrast']:.3f}")
    if abs(c["saturation"] - 1) > 1e-3:
        eqs.append(f"saturation={c['saturation']:.3f}")
    if eqs:
        f += ",eq=" + ":".join(eqs)
    if c["gray"]:
        f += ",hue=s=0"
    if c["blur"] > 0.05:
        f += f",gblur=sigma={c['blur']:.2f}"
    if rot_a:
        f += (f",format=rgba,rotate=a={math.radians(c['angle']):.5f}:ow='ceil(hypot(iw,ih)/2)*2':"
              "oh='ceil(hypot(iw,ih)/2)*2':c=none")
    # 페이드 / 투명도
    fin = ov_in if ttype == "fade" and ov_in > 0 else c["fade_in"]
    fout = c["fade_out"]
    fades = []
    if fin > 0:
        fades.append(f"fade=t=in:st=0:d={min(fin, cd):.3f}:alpha=1")
    if fout > 0:
        fades.append(f"fade=t=out:st={max(0.0, cd - fout):.3f}:d={min(fout, cd):.3f}:alpha=1")
    static_op = c["opacity"] < 0.999 and not anim["opacity"]
    if fades or static_op or anim["opacity"] or needs_alpha:
        f += ",format=yuva420p" + "".join("," + x for x in fades)
        if anim["opacity"]:
            oe = pw_expr(kf_points(c, "opacity"), "T")
            f += f",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip({oe},0,1)'"
        elif static_op:
            f += f",format=rgba,colorchannelmixer=aa={c['opacity']:.3f}"
    else:
        f += ",format=yuv420p"
    f += f",setpts=PTS+{c['start']:.3f}/TB[l{n}]"
    g.append(f)
    dx, dy = ("", "")
    if ttype in TRANS_TYPES and ttype != "fade" and ov_in > 0:
        dx, dy = _slide(ttype, w, h, c["start"], ov_in)
    xv = pw_expr(kf_points(c, "x", c["start"]), "t") if anim["x"] else f"{c['x']:.4f}"
    yv = pw_expr(kf_points(c, "y", c["start"]), "t") if anim["y"] else f"{c['y']:.4f}"
    g.append(f"[{last}][l{n}]overlay=x='W*({xv})-w/2{dx}':y='H*({yv})-h/2{dy}':eof_action=pass:"
             f"enable='between(t,{c['start']:.3f},{c['start'] + cd:.3f})':format=auto[b{n + 1}]")
    return f"b{n + 1}"


def _audio(p: dict, infos: dict, index: dict, use, dur: float, g: list[str]) -> None:
    """소리: 모든 클립/오디오를 자기 시작 시간만큼 늦춰서 섞는다. 마지막 줄이 [am] 또는 [ab] 로 끝난다."""
    vtr, atr = p["tracks"]["v"], p["tracks"]["a"]
    g.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={dur:.3f},asetpts=PTS-STARTPTS[ab]")
    mixin = ["[ab]"]
    for a in p["audios"]:
        use(a["src"])
    voices = voice_intervals(p, infos)

    def tail(f: str, start: float, k: int, duck: dict | None = None) -> None:
        f += f",{AFMT}"
        if start > 0:
            f += f",adelay={round(start * 1000)}:all=1"
        if duck and voices:
            f += f",volume='{duck_expr(voices, duck['duck_level'])}':eval=frame"
        g.append(f"{f}[m{k}]")
        mixin.append(f"[m{k}]")

    k = 0
    for c in p["clips"]:
        if c["freeze"] or c["mute"] or not infos[c["src"]]["has_audio"] or atr_muted(vtr, c["track"]):
            continue
        cd = clip_duration(c)
        tempo = atempo_chain(c["speed"])
        f = (f"[{index[c['src']]}:a]atrim=start={c['in']:.3f}:end={c['out']:.3f},asetpts=PTS-STARTPTS,"
             + ("areverse," if c["reverse"] else "") + (tempo + "," if tempo else "") + f"volume={c['volume']:.3f}")
        fin = max(c["fade_in"], overlap_in(p, c))
        fout = max(c["fade_out"], overlap_out(p, c))
        if fin > 0:
            f += f",afade=t=in:st=0:d={min(fin, cd):.3f}"
        if fout > 0:
            f += f",afade=t=out:st={max(0.0, cd - fout):.3f}:d={min(fout, cd):.3f}"
        tail(f, c["start"], k)
        k += 1
    for a in p["audios"]:
        j = index[a["src"]]
        if not infos[a["src"]]["has_audio"]:
            raise EditError(f"오디오가 없는 파일입니다: {a['src']}")
        if atr[a["track"]]["mute"]:
            continue
        end = a["out"] if a["out"] else infos[a["src"]]["duration"]
        d_src = max(0.05, end - a["in"])
        ad = d_src / a["speed"]
        tempo = atempo_chain(a["speed"])
        f = (f"[{j}:a]atrim=start={a['in']:.3f}:end={a['in'] + d_src:.3f},asetpts=PTS-STARTPTS,"
             + (tempo + "," if tempo else "") + f"volume={a['volume']:.3f}")
        if a["fade_in"]:
            f += f",afade=t=in:st=0:d={min(a['fade_in'], ad):.3f}"
        if a["fade_out"]:
            fo = min(a["fade_out"], ad)
            f += f",afade=t=out:st={ad - fo:.3f}:d={fo:.3f}"
        tail(f, a["start"], k, a if a["duck"] else None)
        k += 1
    if k:
        mix = "".join(mixin) + f"amix=inputs={len(mixin)}:duration=first:normalize=0,alimiter=limit=0.95"
        if p["output"]["loudnorm"]:
            mix += ",loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo"
        g.append(mix + "[am]")


def atr_muted(vtr: list[dict], track: int) -> bool:
    """영상 줄을 음소거하면 그 줄 클립의 원본 소리도 꺼진다."""
    return bool(vtr[track]["mute"])


def prepare_workdir(plan: dict, work: Path, app_dir: Path) -> None:
    """그래프/자막/폰트 파일을 작업 폴더에 쓴다. (경로 이스케이프 문제를 피하려고 상대 경로로 쓴다.)"""
    work.mkdir(parents=True, exist_ok=True)
    (work / "graph.txt").write_text(plan["graph"], encoding="utf-8")
    if plan["ass"]:
        (work / "sub.ass").write_text(plan["ass"], encoding="utf-8")
        fonts = work / "fonts"
        fonts.mkdir(exist_ok=True)
        for src in (app_dir / "fonts", Path(r"C:\Windows\Fonts")):
            found = [src / f for f in FONT_FILES if (src / f).is_file()]
            if not found and src.is_dir() and src == app_dir / "fonts":
                found = list(src.glob("*.[to]tf"))
            for f in found:
                shutil.copy2(f, fonts / f.name)
            if found:
                break


def build_command(plan: dict, out_path: Path, app_dir: Path, cover: Path | None = None) -> list[str]:
    cmd = [find_tool("ffmpeg", app_dir), "-hide_banner", "-nostdin", "-y"]
    for path in plan["inputs"]:
        cmd += ["-i", path]
    if cover:
        cmd += ["-i", str(cover)]
    # 명령줄 길이 제한(윈도우 약 3만 자)을 넘는 긴 그래프만 파일로 전달한다. (ffmpeg 7 이상의 -/옵션 문법)
    graph = ["-/filter_complex", "graph.txt"] if len(plan["graph"]) > 20000 else ["-filter_complex", plan["graph"]]
    o = plan["project"]["output"]
    tail = ["-progress", "pipe:1", "-nostats", str(out_path)]
    if plan["format"] == "mp3":
        return cmd + graph + ["-map", plan["amap"], "-c:a", "libmp3lame", "-q:a", "2"] + tail
    if plan["format"] == "gif":
        return cmd + graph + ["-map", plan["vmap"], "-loop", "0"] + tail
    maps = ["-map", plan["vmap"], "-map", plan["amap"]]
    extra: list[str] = []
    if cover:
        k = len(plan["inputs"])
        maps += ["-map", f"{k}:v"]
        extra = ["-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic"]
    return cmd + graph + maps + ["-c:v:0", "libx264", "-preset", "veryfast", "-crf", str(CRF[o["quality"]]),
                                 "-pix_fmt", "yuv420p", "-r", str(plan["fps"]), "-c:a", "aac", "-b:a", "192k",
                                 "-movflags", "+faststart"] + extra + tail


def frame_command(plan: dict, t: float, out_path: Path, app_dir: Path) -> list[str]:
    """타임라인의 t 초 화면 한 장(PNG)을 만드는 명령. 영상 부분 그래프만 쓴다."""
    cmd = [find_tool("ffmpeg", app_dir), "-hide_banner", "-nostdin", "-y"]
    for path in plan["inputs"]:
        cmd += ["-i", path]
    return cmd + ["-filter_complex", plan["vgraph"], "-map", plan["vmap"], "-ss", f"{t:.3f}", "-frames:v", "1",
                  str(out_path)]


def unique_path(d: Path, name: str, ext: str = ".mp4") -> Path:
    p = d / f"{name}{ext}"
    n = 2
    while p.exists():
        p = d / f"{name} ({n}){ext}"
        n += 1
    return p


# ---------- 서버 연결 ----------
def make_router(app_dir: Path, media_dir, jobs: dict, lock: threading.Lock) -> APIRouter:
    r = APIRouter(prefix="/api/edit")
    assets = app_dir / "edit_assets"
    projects = app_dir / "projects"
    wave_cache: dict = {}

    def resolve(src: str) -> Path:
        if src.startswith("asset:"):
            base, name = assets.resolve(), src[6:]
        else:
            base, name = media_dir().resolve(), src
        p = (base / name).resolve()
        if p.parent != base or not p.is_file():
            raise EditError(f"파일을 찾을 수 없습니다: {src}")
        return p

    def pr(path: Path) -> dict:
        return probe(path, app_dir)

    def guard(fn):
        try:
            return fn()
        except EditError as e:
            raise HTTPException(400, str(e)) from e

    @r.get("/probe")
    def api_probe(src: str):
        return guard(lambda: pr(resolve(src)))

    @r.get("/media")
    def api_media(src: str):
        return guard(lambda: FileResponse(resolve(src)))

    @r.post("/asset")
    async def api_asset(request: Request, name: str):
        safe = BAD_NAME.sub("_", Path(name).name).strip(" .") or "audio"
        assets.mkdir(parents=True, exist_ok=True)
        dest = unique_path(assets, Path(safe).stem, Path(safe).suffix)
        with dest.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        try:
            info = pr(dest)
        except EditError as e:
            dest.unlink(missing_ok=True)
            raise HTTPException(400, str(e)) from e
        return {"src": f"asset:{dest.name}", "name": dest.name, **info}

    @r.get("/projects")
    def api_projects():
        projects.mkdir(parents=True, exist_ok=True)
        rows = [{"name": p.stem, "mtime": p.stat().st_mtime} for p in projects.glob("*.json")]
        return sorted(rows, key=lambda x: x["mtime"], reverse=True)

    def project_path(name: str) -> Path:
        safe = BAD_NAME.sub("_", name).strip(" .")
        if not safe:
            raise HTTPException(400, "프로젝트 이름을 입력하세요.")
        projects.mkdir(parents=True, exist_ok=True)
        return projects / f"{safe}.json"

    @r.get("/project")
    def api_project_load(name: str):
        p = project_path(name)
        if not p.is_file():
            raise HTTPException(404, "프로젝트를 찾을 수 없습니다.")
        return migrate(json.loads(p.read_text(encoding="utf-8")))

    @r.get("/wave")
    def api_wave(src: str):
        """소리 파형: 초당 20개의 크기(0~100) 목록."""
        path = guard(lambda: resolve(src))
        key = (str(path), path.stat().st_mtime)
        if key not in wave_cache:
            wave_cache[key] = guard(lambda: waveform(path, app_dir))
        return {"peaks": wave_cache[key], "rate": WAVE_RATE}

    @r.post("/project")
    def api_project_save(body: dict):
        data = body.get("data")
        if not isinstance(data, dict):
            raise HTTPException(400, "저장할 내용이 없습니다.")
        p = project_path(str(body.get("name") or data.get("name") or ""))
        data["name"] = p.stem
        p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        return {"ok": True, "name": p.stem}

    @r.post("/project/delete")
    def api_project_delete(body: dict):
        project_path(str(body.get("name") or "")).unlink(missing_ok=True)
        return {"ok": True}

    @r.post("/srt/parse")
    def api_srt_parse(body: dict):
        subs = parse_srt(str(body.get("text") or ""))
        if not subs:
            raise HTTPException(400, "자막 형식(SRT)을 읽지 못했습니다.")
        return {"subs": subs}

    @r.post("/srt/format")
    def api_srt_format(body: dict):
        return {"text": format_srt(body.get("subs") or [])}

    export_lock = threading.Lock()   # 내보내기는 한 번에 하나씩 (일괄 내보내기는 줄을 서서 차례로)

    def run_export(jid: str, plan: dict, work: Path, tmp: Path, final: Path) -> None:
        job = jobs[jid]
        proc = None
        try:
            with export_lock:
                if job["cancel"]:
                    job["status"] = "cancelled"
                    return
                job["stage"] = "Export"
                prepare_workdir(plan, work, app_dir)
                cover = None
                cov_t = plan["project"]["output"]["cover_t"]
                if cov_t is not None and plan["format"] == "mp4":
                    cover = work / "cover.jpg"
                    fr = subprocess.run(frame_command(plan, min(cov_t, max(plan["duration"] - 0.05, 0)), cover, app_dir),
                                        cwd=work, capture_output=True, check=False, creationflags=CREATE_NO_WINDOW,
                                        timeout=300)
                    if fr.returncode != 0 or not cover.is_file():
                        cover = None
                log = (work / "ffmpeg.log").open("w", encoding="utf-8", errors="replace")
                proc = subprocess.Popen(build_command(plan, tmp, app_dir, cover), cwd=work, stdout=subprocess.PIPE,
                                        stderr=log, text=True, encoding="utf-8", errors="replace",
                                        creationflags=CREATE_NO_WINDOW)
                total = max(plan["duration"], 0.1)
                for line in proc.stdout:
                    if job["cancel"]:
                        proc.kill()
                        break
                    m = re.match(r"out_time_(?:us|ms)=(\d+)", line)
                    if m:
                        job["percent"] = round(min(99.0, int(m.group(1)) / 1e6 / total * 100), 1)
                proc.wait()
                log.close()
            if job["cancel"]:
                job["status"] = "cancelled"
                tmp.unlink(missing_ok=True)
            elif proc.returncode != 0:
                tail = (work / "ffmpeg.log").read_text(encoding="utf-8", errors="replace").strip().splitlines()[-4:]
                job.update(status="error", error="내보내기 실패: " + " / ".join(tail)[-300:])
                tmp.unlink(missing_ok=True)
            else:
                tmp.replace(final)
                job.update(status="done", percent=100, title=final.name, output=final.name)
        except (EditError, OSError, subprocess.TimeoutExpired) as e:
            job.update(status="error", error=str(e))
            if proc and proc.poll() is None:
                proc.kill()
            tmp.unlink(missing_ok=True)
        finally:
            job["finished"] = time.time()
            shutil.rmtree(work, ignore_errors=True)

    def start_export(project: dict, suffix: str = "") -> dict:
        plan = guard(lambda: build_plan(project, resolve, pr))
        d = media_dir()
        final = unique_path(d, plan["project"]["name"] + suffix, plan["ext"])
        tmp = d / f"{final.stem}.temp{plan['ext']}"
        work = app_dir / "edit_work" / uuid.uuid4().hex[:8]
        jid = uuid.uuid4().hex[:8]
        with lock:
            jobs[jid] = {"id": jid, "url": "", "title": f"편집 내보내기: {final.name}", "status": "processing",
                         "percent": 0, "speed": None, "eta": None, "stage": "Export", "index": None, "total": None,
                         "error": None, "cancel": False, "started": time.time(), "finished": None, "mode": "edit"}
        threading.Thread(target=run_export, args=(jid, plan, work, tmp, final), daemon=True).start()
        return {"id": jid, "output": final.name}

    @r.post("/export")
    def api_export(body: dict):
        batch = [a for a in (body.get("batch") or []) if a in ASPECTS][:3]
        if not batch:
            return start_export(body)
        # 일괄 내보내기: 비율마다 따로 만든다 (먼저 모두 검사한 뒤 시작)
        projects_ = []
        for a in batch:
            pj = json.loads(json.dumps(body))
            pj["output"] = {**(pj.get("output") or {}), "aspect": a}
            guard(lambda pj=pj: build_plan(pj, resolve, pr))
            projects_.append((pj, "_" + a.replace(":", "x")))
        res = [start_export(pj, sfx) for pj, sfx in projects_]
        return {"id": res[0]["id"], "output": ", ".join(x["output"] for x in res), "jobs": res}

    @r.post("/frame")
    def api_frame(body: dict):
        """현재 화면 한 장을 PNG 로 저장한다 (자막/겹침/효과 모두 반영)."""
        t = _num(body.get("t"), 0, 0, 1e5)
        project = json.loads(json.dumps(body.get("project") or {}))
        project["output"] = {**(project.get("output") or {}), "format": "mp4"}
        plan = guard(lambda: build_plan(project, resolve, pr))
        d = media_dir()
        final = unique_path(d, f"{plan['project']['name']}_화면_{int(t // 60):02d}분{int(t % 60):02d}초", ".png")
        work = app_dir / "edit_work" / uuid.uuid4().hex[:8]
        try:
            prepare_workdir(plan, work, app_dir)
            res = subprocess.run(frame_command(plan, min(t, max(plan["duration"] - 0.05, 0)), final, app_dir), cwd=work,
                                 capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
                                 creationflags=CREATE_NO_WINDOW, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise HTTPException(500, f"화면을 저장하지 못했습니다: {e}") from e
        finally:
            shutil.rmtree(work, ignore_errors=True)
        if res.returncode != 0 or not final.is_file():
            raise HTTPException(500, "화면을 저장하지 못했습니다: " + " / ".join(res.stderr.strip().splitlines()[-3:])[-250:])
        return {"output": final.name}

    return r
