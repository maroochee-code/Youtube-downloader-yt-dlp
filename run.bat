@echo off
cd /d "%~dp0"
python -c "import webview, fastapi, uvicorn, yt_dlp" 2>nul || python -m pip install -q -r requirements.txt
start "" pythonw app.py
