@echo off
rem 지인 배포용 포터블 폴더(dist\YT다운로더)를 만든다. 사전 준비: pip install pyinstaller
cd /d "%~dp0"
python -m PyInstaller --noconfirm --clean --onedir --noconsole --name "YT다운로더" ^
  --add-data "static;static" ^
  --collect-submodules yt_dlp --collect-submodules uvicorn ^
  --hidden-import webview.platforms.edgechromium --hidden-import webview.platforms.winforms ^
  app.py
if errorlevel 1 exit /b 1
rem ffmpeg / ffprobe 를 함께 넣는다 (ffmpeg_bin 폴더에 두 파일을 미리 복사해 둘 것)
if exist ffmpeg_bin xcopy /E /I /Y ffmpeg_bin "dist\YT다운로더\ffmpeg" >nul
echo 완료: dist\YT다운로더
