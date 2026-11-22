# ffmpeg 9 에서 -filter_complex_script 옵션이 없어짐

- **증상**: 편집 내보내기가 "Unrecognized option 'filter_complex_script'" 로 실패
- **원인**: 번들 ffmpeg 9.0.2 에서 해당 옵션이 제거됨 (ffmpeg 7 이상은 `-/filter_complex 파일` 문법)
- **해결**: 그래프를 명령줄에 직접 전달하고, 2만 자를 넘는 긴 그래프(클립 약 40개 이상)만 `-/filter_complex graph.txt` 로 전달
- **확인**: `tests/test_editor.py::test_very_long_graph_uses_file`
- **관련 파일**: `editor.py` (`build_command`)
