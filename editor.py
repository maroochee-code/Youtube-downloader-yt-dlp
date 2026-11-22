"""영상 편집 엔진: 편집 목록(JSON) -> ffmpeg 내보내기.

화면(static/editor.js)은 편집 목록만 고치고, 마지막에 이 모듈이 목록대로 ffmpeg 로 영상을 만든다.
원본 파일은 건드리지 않는다.
"""
from __future__ import annotations

import json
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
            out["subs"].append({"id": _id(s, "s"), "start": st, "end": en, "text": text})
    for t in project.get("texts") or []:
        text = str(t.get("text") or "").strip()
        st = _num(t.get("start"), 0, 0, 1e6)
        en = _num(t.get("end"), st + 3, 0, 1e6)
        if text and en > st:
            out["texts"].append({"id": _id(t, "t"), "start": st, "end": en, "text": text,
                                 "x": _num(t.get("x"), 0.5, 0, 1), "y": _num(t.get("y"), 0.15, 0, 1),
                                 "size": _num(t.get("size"), 56, 10, 300), "color": _color(t.get("color"), "#ffffff")})
    ss = project.get("sub_style") or {}
    pos = ss.get("pos") if ss.get("pos") in SUB_POS else "bottom"
    out["sub_style"] = {"size": _num(ss.get("size"), 48, 10, 200), "color": _color(ss.get("color"), "#ffffff"),
                        "outline": _color(ss.get("outline"), "#000000"), "pos": pos}
    o = project.get("output") or {}
    out["output"] = {"aspect": o.get("aspect") if o.get("aspect") in ASPECTS else "original",
                     "loudnorm": bool(o.get("loudnorm"))}
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


def build_ass(p: dict, w: int, h: int, font: str = "Malgun Gothic") -> str:
    scale = min(w, h) / 1080
    st = p["sub_style"]
    size = round(st["size"] * scale)
    margin_v = round(h * 0.06)
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]",
        ("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
         "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
         "MarginR, MarginV, Encoding"),
        (f"Style: Sub,{font},{size},{ass_color(st['color'])},&H000000FF,{ass_color(st['outline'])},&H64000000,1,0,0,0,"
         f"100,100,0,0,1,{max(1, round(3 * scale))},1,{SUB_POS[st['pos']]},{round(w * 0.05)},{round(w * 0.05)},"
         f"{margin_v},1"),
        (f"Style: Txt,{font},{size},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,"
         f"{max(1, round(3 * scale))},1,5,20,20,20,1"),
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for s in p["subs"]:
        lines.append(f"Dialogue: 0,{ass_time(s['start'])},{ass_time(s['end'])},Sub,,0,0,0,,{ass_text(s['text'])}")
    for t in p["texts"]:
        tag = (f"{{\\an5\\pos({round(t['x'] * w)},{round(t['y'] * h)})\\fs{round(t['size'] * scale)}"
               f"\\c{ass_color(t['color'])}}}")
        lines.append(f"Dialogue: 1,{ass_time(t['start'])},{ass_time(t['end'])},Txt,,0,0,0,,{tag}{ass_text(t['text'])}")
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


def build_plan(project: dict, resolve, probe_fn) -> dict:
    """편집 목록 -> {graph, inputs, size, duration, ass}. resolve(src)->Path, probe_fn(Path)->dict.

    검은 바탕 위에 영상 클립을 줄 번호(아래->위) 순서로 겹쳐 놓고, 소리는 모두 시간 위치에 맞춰 섞는다.
    """
    p = normalize(project)
    inputs: list[str] = []
    infos: dict[str, dict] = {}
    index: dict[str, int] = {}

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
    media = sorted((c for c in p["clips"] if not c["solid"]), key=lambda c: c["start"])
    first = next((infos[c["src"]] for c in media if not infos[c["src"]].get("is_image")), None)         or (infos[media[0]["src"]] if media else {"width": 0, "height": 0, "fps": 30})
    asp = p["output"]["aspect"]
    if asp in ASPECTS:
        w, h = ASPECTS[asp]
    else:
        w, h = (first["width"] // 2 * 2) or 1280, (first["height"] // 2 * 2) or 720
    fps = int(min(60, max(15, round(first["fps"] or 30))))
    dur = max(total_duration(p), 0.1)
    vtr, atr = p["tracks"]["v"], p["tracks"]["a"]

    g = [f"color=c=black:s={w}x{h}:r={fps}:d={dur:.3f},format=yuv420p[b0]"]
    last = "b0"
    layers = sorted((c for c in p["clips"] if not vtr[c["track"]]["hide"]), key=lambda c: (c["track"], c["start"]))
    for n, c in enumerate(layers):
        cd = clip_duration(c)
        i = index.get(c["src"])
        ov_in, ttype = overlap_in(p, c), (c["trans"] or {}).get("type")
        sw, sh = max(2, round(w * c["scale"] / 2) * 2), max(2, round(h * c["scale"] / 2) * 2)
        if c["solid"]:
            sd = c["solid"]
            sw, sh = max(2, round(w * sd["w"] * c["scale"] / 2) * 2), max(2, round(h * sd["h"] * c["scale"] / 2) * 2)
            f = f"color=c=0x{sd['color'][1:]}:s={sw}x{sh}:r={fps}:d={cd:.3f},format=yuva420p"
            if sd["shape"] == "ellipse":
                f += (",geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':"
                      "a='if(lte(pow((X-W/2)/(W/2),2)+pow((Y-H/2)/(H/2),2),1),255,0)'")
        elif c["freeze"]:
            f = (f"[{i}:v]trim=start={c['in']:.3f}:end={c['in'] + 1:.3f},setpts=PTS-STARTPTS,select='eq(n,0)',"
                 f"tpad=stop_mode=clone:stop_duration={c['hold']:.3f},trim=duration={cd:.3f},setpts=PTS-STARTPTS")
        else:
            f = (f"[{i}:v]trim=start={c['in']:.3f}:end={c['out']:.3f},"
                 f"setpts=(PTS-STARTPTS)/{c['speed']:.5f}")
        if not c["solid"]:
            f += f",fps={fps},scale={sw}:{sh}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
        fin = ov_in if ttype == "fade" and ov_in > 0 else c["fade_in"]
        fout = c["fade_out"]
        fades = []
        if fin > 0:
            fades.append(f"fade=t=in:st=0:d={min(fin, cd):.3f}:alpha=1")
        if fout > 0:
            fades.append(f"fade=t=out:st={max(0.0, cd - fout):.3f}:d={min(fout, cd):.3f}:alpha=1")
        if fades or c["opacity"] < 0.999 or c["image"] or c["solid"]:
            f += ",format=yuva420p" + "".join("," + x for x in fades)
            if c["opacity"] < 0.999:
                f += f",format=rgba,colorchannelmixer=aa={c['opacity']:.3f}"
        else:
            f += ",format=yuv420p"
        f += f",setpts=PTS+{c['start']:.3f}/TB[l{n}]"
        g.append(f)
        dx, dy = ("", "")
        if ttype in TRANS_TYPES and ttype != "fade" and ov_in > 0:
            dx, dy = _slide(ttype, w, h, c["start"], ov_in)
        x = f"W*{c['x']:.4f}-w/2{dx}"
        y = f"H*{c['y']:.4f}-h/2{dy}"
        g.append(f"[{last}][l{n}]overlay=x='{x}':y='{y}':eof_action=pass:"
                 f"enable='between(t,{c['start']:.3f},{c['start'] + cd:.3f})':format=auto[b{n + 1}]")
        last = f"b{n + 1}"

    # 소리: 모든 클립/오디오를 자기 시작 시간만큼 늦춰서 섞는다.
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
             + (tempo + "," if tempo else "") + f"volume={c['volume']:.3f}")
        fin = max(c["fade_in"], overlap_in(p, c))
        fout = max(c["fade_out"], overlap_out(p, c))
        if fin > 0:
            f += f",afade=t=in:st=0:d={min(fin, cd):.3f}"
        if fout > 0:
            f += f",afade=t=out:st={max(0.0, cd - fout):.3f}:d={min(fout, cd):.3f}"
        tail(f, c["start"], k)
        k += 1
    for a in p["audios"]:
        j = use(a["src"])
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
        amap = "[am]"
    else:
        amap = "[ab]"

    ass = None
    if p["subs"] or p["texts"]:
        ass = build_ass(p, w, h)
        g.append(f"[{last}]ass=sub.ass:fontsdir=fonts[vout]")
        vmap = "[vout]"
    else:
        vmap = f"[{last}]"
    return {"project": p, "graph": ";".join(g), "inputs": inputs, "size": (w, h), "duration": dur,
            "ass": ass, "vmap": vmap, "amap": amap}


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


def build_command(plan: dict, out_path: Path, app_dir: Path) -> list[str]:
    cmd = [find_tool("ffmpeg", app_dir), "-hide_banner", "-nostdin", "-y"]
    for path in plan["inputs"]:
        cmd += ["-i", path]
    # 명령줄 길이 제한(윈도우 약 3만 자)을 넘는 긴 그래프만 파일로 전달한다. (ffmpeg 7 이상의 -/옵션 문법)
    graph = ["-/filter_complex", "graph.txt"] if len(plan["graph"]) > 20000 else ["-filter_complex", plan["graph"]]
    return cmd + graph + ["-map", plan["vmap"], "-map", plan["amap"],
                  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                  "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
                  "-progress", "pipe:1", "-nostats", str(out_path)]


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

    def run_export(jid: str, plan: dict, work: Path, tmp: Path, final: Path) -> None:
        job = jobs[jid]
        proc = None
        try:
            prepare_workdir(plan, work, app_dir)
            log = (work / "ffmpeg.log").open("w", encoding="utf-8", errors="replace")
            proc = subprocess.Popen(build_command(plan, tmp, app_dir), cwd=work, stdout=subprocess.PIPE, stderr=log,
                                    text=True, encoding="utf-8", errors="replace", creationflags=CREATE_NO_WINDOW)
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
        except (EditError, OSError) as e:
            job.update(status="error", error=str(e))
            if proc and proc.poll() is None:
                proc.kill()
            tmp.unlink(missing_ok=True)
        finally:
            job["finished"] = time.time()
            shutil.rmtree(work, ignore_errors=True)

    @r.post("/export")
    def api_export(body: dict):
        plan = guard(lambda: build_plan(body, resolve, pr))
        d = media_dir()
        final = unique_path(d, plan["project"]["name"])
        tmp = d / f"{final.stem}.temp.mp4"
        work = app_dir / "edit_work" / uuid.uuid4().hex[:8]
        jid = uuid.uuid4().hex[:8]
        with lock:
            jobs[jid] = {"id": jid, "url": "", "title": f"편집 내보내기: {final.name}", "status": "processing",
                         "percent": 0, "speed": None, "eta": None, "stage": "Export", "index": None, "total": None,
                         "error": None, "cancel": False, "started": time.time(), "finished": None, "mode": "edit"}
        threading.Thread(target=run_export, args=(jid, plan, work, tmp, final), daemon=True).start()
        return {"id": jid, "output": final.name}

    return r
