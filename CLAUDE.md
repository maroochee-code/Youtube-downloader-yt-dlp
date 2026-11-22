# YT 다운로더 작업 규칙

## 작업 완료 필수 규칙

1. 외부 라이브러리 API를 사용할 때는 추측하지 말고 반드시 `context7` MCP로 최신 문서를 먼저 조회한다.
2. 3개 이상의 파일을 동시에 수정해야 할 때는 `sequential-thinking` MCP로 영향도를 먼저 분석한다.
3. 모든 기능 구현 및 수정이 끝나면 아래 두 검사를 실행해 경고가 0개가 될 때까지 정리한 뒤 보고한다.

## 검사 명령 (이 프로젝트는 Python이라 `knip`(JS 전용) 대신 `ruff`를 쓴다)

```bash
ruff check . --exclude build,dist,release,ffmpeg_bin
```

`semgrep`은 Windows에서 직접 실행되지 않아 WSL(Ubuntu)의 `~/semgrep-venv`에 설치되어 있다.

```bash
wsl -d Ubuntu -- bash -lc 'cd /mnt/d/CusomProjectClaudCode/ytdlp && ~/semgrep-venv/bin/semgrep scan --config p/python --metrics=off app.py'
```

- 의도한 예외(넓은 `except` 등)는 `# noqa: 규칙번호 - 이유`로 남긴다.
- `fastapi`는 0.160 이상이어야 한다 (`docs/bugs/` 참고).
