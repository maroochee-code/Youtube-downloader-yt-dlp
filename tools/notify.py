"""텔레그램으로 진행 상황을 알린다.

사용법: python tools/notify.py "보내 메시지"
.env 의 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 를 읽는다. 값이 없으면 조용히 종료한다.
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ENV = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path = ENV) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip("\"'")
    return out


def send(text: str) -> bool:
    cfg = load_env()
    token, chat = cfg.get("TELEGRAM_BOT_TOKEN", ""), cfg.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat:
        return False
    data = urllib.parse.urlencode({"chat_id": chat, "text": text[:4000]}).encode()
    for _ in range(3):  # 첫 연결이 느릴 때가 있어 재시도
        try:
            with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", data, timeout=40) as r:
                return bool(json.load(r).get("ok"))
        except (OSError, ValueError):
            continue
    return False


if __name__ == "__main__":
    ok = send(" ".join(sys.argv[1:]) or "(빈 메시지)")
    print("sent" if ok else "not sent")
    sys.exit(0 if ok else 1)
