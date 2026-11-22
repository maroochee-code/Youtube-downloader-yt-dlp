/* 편집 탭: 편집 목록(P)만 고치고, 내보내기 때 서버(ffmpeg)가 목록대로 영상을 만든다. */
const Editor = (() => {
  const uid = () => 'x' + Math.random().toString(36).slice(2, 8);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const num = (v, d = 0) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60); return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
  const srcUrl = s => '/api/edit/media?src=' + encodeURIComponent(s);
  const blank = () => ({name: '편집본', clips: [], audios: [], subs: [], texts: [],
    sub_style: {size: 48, color: '#ffffff', outline: '#000000', pos: 'bottom'}, output: {aspect: 'original'}});

  let P = blank(), sel = null, T = 0, playing = false, pps = 40, cur = -1, pending = null, tab = 'video';
  let lib = [], assets = [], built = false, undo = [], redo = [], lastKey = '', lastAt = 0;
  const info = {}, auds = {};
  const R = {};  // 자주 쓰는 DOM

  /* ---------- 계산 ---------- */
  const cdur = c => (c.out - c.in) / c.speed;
  const layout = () => { let t = 0; return P.clips.map(c => { const s = t; t += cdur(c); return s; }); };
  const total = () => P.clips.reduce((a, c) => a + cdur(c), 0);
  const adur = a => Math.max(0.05, (a.out || (info[a.src]?.duration ?? 0)) - a.in);
  const nameOf = s => s.replace(/^asset:/, '').replace(/\.[^.]+$/, '');
  const find = (type, id) => ({clip: P.clips, audio: P.audios, sub: P.subs, text: P.texts}[type] || []).find(x => x.id === id);
  const selObj = () => (sel ? find(sel.type, sel.id) : null);
  const say = (t, err) => { if (R.msg) { R.msg.textContent = t || ''; R.msg.className = 'ed-msg' + (err ? ' err' : ''); } };

  async function probe(src) {
    if (!info[src]) {
      try { info[src] = await api('/api/edit/probe?src=' + encodeURIComponent(src)); }
      catch (e) { info[src] = {missing: true, duration: 0, has_video: false, has_audio: false, width: 0, height: 0}; throw e; }
    }
    return info[src];
  }

  /* ---------- 되돌리기 ---------- */
  function mutate(fn, structural = true, ck = '') {
    const now = Date.now();
    if (!(ck && ck === lastKey && now - lastAt < 800)) { undo.push(JSON.stringify(P)); if (undo.length > 100) undo.shift(); redo = []; }
    lastKey = ck; lastAt = now;
    fn();
    structural ? renderAll() : renderLight();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(P));
    P = JSON.parse(from.pop());
    if (sel && !selObj()) sel = null;
    lastKey = '';
    renderAll();
  }

  /* ---------- 편집 동작 ---------- */
  async function addClip(src) {
    try {
      const i = await probe(src);
      if (!i.has_video) { say('영상 파일만 타임라인에 넣을 수 있습니다.', true); return; }
      const id = uid();
      mutate(() => P.clips.push({id, src, in: 0, out: i.duration, speed: 1, volume: 1, mute: false}));
      sel = {type: 'clip', id}; renderAll(); say('');
      if (P.clips.length === 1) seek(0);
    } catch (e) { say(e.message, true); }
  }
  async function addAudio(src) {
    try {
      const i = await probe(src);
      if (!i.has_audio) { say('오디오가 없는 파일입니다.', true); return; }
      const id = uid();
      mutate(() => P.audios.push({id, src, at: T, in: 0, out: 0, volume: 1, fade_in: 0, fade_out: 0}));
      sel = {type: 'audio', id}; renderAll(); say('');
    } catch (e) { say(e.message, true); }
  }
  function addSub() {
    const id = uid();
    mutate(() => P.subs.push({id, start: +T.toFixed(2), end: +(T + 2).toFixed(2), text: '새 자막'}));
    sel = {type: 'sub', id}; renderAll();
  }
  function addText() {
    const id = uid();
    mutate(() => P.texts.push({id, start: +T.toFixed(2), end: +(T + 3).toFixed(2), text: '글자', x: 0.5, y: 0.15, size: 64, color: '#ffffff'}));
    sel = {type: 'text', id}; renderAll();
  }
  function split() {
    const st = layout(); const i = P.clips.findIndex((c, k) => T > st[k] + 0.001 && T < st[k] + cdur(c) - 0.001);
    if (i < 0) { say('나눌 영상 위에 재생선을 놓으세요.', true); return; }
    const c = P.clips[i], at = c.in + (T - st[i]) * c.speed;
    if (at - c.in < 0.1 || c.out - at < 0.1) { say('양 끝에 너무 가깝습니다.', true); return; }
    const b = {...c, id: uid(), in: at};
    mutate(() => { c.out = at; P.clips.splice(i + 1, 0, b); });
    sel = {type: 'clip', id: b.id}; renderAll(); say('');
  }
  function removeSel() {
    if (!sel) return;
    const arr = {clip: P.clips, audio: P.audios, sub: P.subs, text: P.texts}[sel.type];
    mutate(() => { arr.splice(arr.findIndex(x => x.id === sel.id), 1); });
    sel = null; renderAll(); seek(Math.min(T, total()));
  }
  function moveClip(d) {
    if (sel?.type !== 'clip') return;
    const i = P.clips.findIndex(c => c.id === sel.id), j = i + d;
    if (j < 0 || j >= P.clips.length) return;
    mutate(() => { [P.clips[i], P.clips[j]] = [P.clips[j], P.clips[i]]; });
  }

  /* ---------- 재생 ---------- */
  const clipIndexAt = t => { const st = layout(); for (let i = 0; i < P.clips.length; i++) if (t >= st[i] && t < st[i] + cdur(P.clips[i])) return i; return -1; };
  function setClip(i, t) {
    const c = P.clips[i], url = srcUrl(c.src), target = c.in + (t - layout()[i]) * c.speed;
    cur = i;
    R.video.playbackRate = c.speed; R.video.muted = c.mute; R.video.volume = clamp(c.volume, 0, 1);
    if (R.video.dataset.src !== url) { R.video.dataset.src = url; pending = target; R.video.src = url; }
    else if (R.video.readyState >= 1) R.video.currentTime = target;
    else pending = target;
  }
  function seek(t) {
    T = clamp(t, 0, Math.max(total(), 0));
    const i = clipIndexAt(T >= total() ? total() - 0.001 : T);
    if (i >= 0) setClip(i, T);
    syncAudio(true); movePh(); renderOv(); renderTime();
  }
  function getAud(a) {
    if (!auds[a.id] || auds[a.id].dataset.src !== a.src) { const el = new Audio(srcUrl(a.src)); el.dataset.src = a.src; el.preload = 'auto'; auds[a.id] = el; }
    return auds[a.id];
  }
  function syncAudio(force) {
    for (const a of P.audios) {
      const el = getAud(a), d = adur(a), rel = T - a.at;
      if (playing && rel >= 0 && rel < d) {
        const want = a.in + rel;
        if (el.paused || force || Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
        let v = a.volume;
        if (a.fade_in && rel < a.fade_in) v *= rel / a.fade_in;
        if (a.fade_out && d - rel < a.fade_out) v *= (d - rel) / a.fade_out;
        el.volume = clamp(v, 0, 1);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
  }
  function play() {
    if (!P.clips.length) return;
    if (T >= total() - 0.05) seek(0);
    playing = true; R.play.textContent = '⏸';
    const i = clipIndexAt(T); if (i >= 0) { setClip(i, T); R.video.play().catch(() => {}); }
    syncAudio(true); requestAnimationFrame(tick);
  }
  function pause() { playing = false; R.play.textContent = '▶'; R.video.pause(); syncAudio(false); }
  function tick() {
    if (!playing) return;
    const c = P.clips[cur];
    if (c && R.video.readyState >= 1) {
      const vt = R.video.currentTime;
      if (vt >= c.out - 0.04) {
        if (cur + 1 < P.clips.length) { setClip(cur + 1, layout()[cur + 1]); R.video.play().catch(() => {}); }
        else { T = total(); pause(); movePh(); renderOv(); renderTime(); return; }
      } else T = clamp(layout()[cur] + (vt - c.in) / c.speed, 0, total());
    }
    syncAudio(false); movePh(); renderOv(); renderTime();
    requestAnimationFrame(tick);
  }

  /* ---------- 그리기 ---------- */
  function build() {
    const v = $('#viewEdit');
    v.innerHTML = `
      <div class="ed-bar">
        <input type="text" id="edName" placeholder="프로젝트 이름">
        <button id="edNew">새로 만들기</button><button id="edOpen">열기</button><button id="edSave">저장</button>
        <span style="flex:1"></span><span class="ed-msg" id="edMsg"></span>
        <button class="primary" id="edExport">내보내기 (mp4)</button>
      </div>
      <div class="ed-main">
        <div class="ed-left"><div class="ed-ltabs" id="edLtabs"></div><div class="ed-lbody" id="edLbody"></div></div>
        <div class="ed-center">
          <div class="ed-wrap" id="edWrap"><div id="edStage"><video id="edVideo" playsinline preload="auto"></video><div id="edOv"></div><div class="empty" id="edEmpty">왼쪽 목록에서 영상을 눌러 추가하세요</div></div></div>
          <div class="ed-ctl"><button id="edToStart" title="처음으로">⏮</button><button id="edPlay" title="재생/정지 (Space)">▶</button><span id="edTime">00:00.0 / 00:00.0</span></div>
        </div>
        <div class="ed-right" id="edProps"></div>
      </div>
      <div class="ed-tools">
        <button id="edSplit" title="재생선 위치에서 나누기 (S)">✂ 나누기</button><button id="edDel" title="선택 삭제 (Delete)">🗑 삭제</button>
        <button id="edLeft" title="클립 앞으로">◀</button><button id="edRight" title="클립 뒤로">▶</button>
        <span class="sep"></span><button id="edUndo" title="되돌리기 (Ctrl+Z)">↶</button><button id="edRedo" title="다시 실행 (Ctrl+Y)">↷</button>
        <span style="flex:1"></span><span style="font-size:12px;color:var(--mute)">확대</span><input type="range" id="edZoom" min="8" max="160" value="${pps}">
      </div>
      <div class="ed-tl"><div class="ed-gut"><div style="height:60px">영상</div><div style="height:44px">오디오</div><div style="height:36px">자막</div><div style="height:36px">글자</div></div>
        <div class="ed-scroll" id="edScroll"><div id="edInner"></div></div></div>`;
    Object.assign(R, {video: $('#edVideo'), play: $('#edPlay'), msg: $('#edMsg'), stage: $('#edStage'), wrap: $('#edWrap'), ov: $('#edOv'),
      inner: $('#edInner'), scroll: $('#edScroll'), props: $('#edProps'), lbody: $('#edLbody'), time: $('#edTime'), name: $('#edName')});
    R.video.addEventListener('loadedmetadata', () => {
      if (pending != null) { R.video.currentTime = pending; pending = null; }
      renderStage();
    });
    new ResizeObserver(fitStage).observe(R.wrap);
    $('#edPlay').onclick = () => (playing ? pause() : play());
    $('#edToStart').onclick = () => { pause(); seek(0); };
    $('#edSplit').onclick = split; $('#edDel').onclick = removeSel;
    $('#edLeft').onclick = () => moveClip(-1); $('#edRight').onclick = () => moveClip(1);
    $('#edUndo').onclick = () => restore(undo, redo); $('#edRedo').onclick = () => restore(redo, undo);
    $('#edZoom').oninput = e => { pps = +e.target.value; renderTimeline(); };
    R.name.oninput = () => { P.name = R.name.value; };
    $('#edNew').onclick = () => { if (P.clips.length && !confirm('지금 편집 중인 내용이 사라집니다. 새로 만들까요?')) return; pause(); P = blank(); sel = null; undo = []; redo = []; renderAll(); seek(0); };
    $('#edSave').onclick = saveProject; $('#edOpen').onclick = openDialog; $('#edExport').onclick = exportNow;
    $('#edLtabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderLeft(); } };
    R.lbody.addEventListener('click', onLeftClick);
    R.lbody.addEventListener('input', onStyleInput);
    R.props.addEventListener('input', onPropInput);
    R.props.addEventListener('change', onPropInput);
    R.props.addEventListener('click', onPropClick);
    R.inner.addEventListener('pointerdown', onTlDown);
    document.addEventListener('keydown', onKey);
    built = true;
  }

  function renderAll() { renderBar(); renderLeft(); renderTimeline(); renderProps(); renderStage(); renderOv(); renderTime(); }
  function renderLight() { renderTimeline(); renderStage(); renderOv(); renderTime(); }
  function renderBar() { if (document.activeElement !== R.name) R.name.value = P.name; }

  const LTABS = [['video', '영상'], ['audio', '오디오'], ['sub', '자막'], ['text', '글자']];
  async function loadLib() { try { lib = (await api('/api/library')).items; } catch (e) { say(e.message, true); } renderLeft(); }
  function libRows(items, kind) {
    return items.map(it => `<div class="row" data-add="${kind}" data-src="${esc(it.src ?? it.name)}">
      ${it.thumb ? `<img loading="lazy" src="/api/file?name=${encodeURIComponent(it.thumb)}">` : `<div class="ph">${kind === 'video' ? '영상' : '음원'}</div>`}
      <div style="min-width:0"><div class="t">${esc(it.title ?? nameOf(it.name))}</div></div><button class="add" tabindex="-1">＋</button></div>`).join('')
      || '<div class="hint">저장된 파일이 없습니다. 다운로드 탭에서 먼저 받아 주세요.</div>';
  }
  function renderLeft() {
    $('#edLtabs').innerHTML = LTABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('');
    const b = R.lbody;
    if (tab === 'video') b.innerHTML = libRows(lib.filter(i => !i.audio), 'video');
    else if (tab === 'audio') {
      b.innerHTML = `<div class="btns"><button id="edUp">📁 내 PC에서 불러오기</button><input type="file" id="edUpFile" accept="audio/*,video/*,.mp3,.m4a,.wav,.flac,.ogg,.opus" hidden></div>
        <div class="hint" style="padding-top:0">재생선 위치에 오디오가 들어갑니다.</div>
        ${assets.length ? '<div class="hint">불러온 파일</div>' + libRows(assets.map(a => ({src: a.src, title: a.name})), 'audio') : ''}
        <div class="hint">저장한 파일 (영상에서 소리만 쓸 수도 있습니다)</div>${libRows(lib, 'audio')}`;
    } else if (tab === 'sub') {
      const st = P.sub_style;
      b.innerHTML = `<div class="btns"><button data-act="addSub">＋ 현재 위치에 자막</button><button data-act="srtIn">SRT 불러오기</button><button data-act="srtOut">SRT 내보내기</button><input type="file" id="edSrtFile" accept=".srt,.txt" hidden></div>
        ${[...P.subs].sort((x, y) => x.start - y.start).map(s => `<div class="row srow ${sel?.id === s.id ? 'on' : ''}" data-sel="sub" data-id="${s.id}"><div style="min-width:0"><div class="t">${esc(s.text)}</div><div class="m">${fmt(s.start)} → ${fmt(s.end)}</div></div></div>`).join('') || '<div class="hint">자막이 없습니다.</div>'}
        <div class="sty"><span>크기</span><input type="number" data-sty="size" value="${st.size}" min="10" max="200">
        <span>글자색</span><input type="color" data-sty="color" value="${st.color}"><span>테두리색</span><input type="color" data-sty="outline" value="${st.outline}">
        <span>위치</span><select data-sty="pos">${[['bottom', '아래'], ['middle', '가운데'], ['top', '위']].map(([k, n]) => `<option value="${k}" ${st.pos === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    } else {
      b.innerHTML = `<div class="btns"><button data-act="addText">＋ 현재 위치에 글자</button></div>
        ${P.texts.map(s => `<div class="row srow ${sel?.id === s.id ? 'on' : ''}" data-sel="text" data-id="${s.id}"><div style="min-width:0"><div class="t">${esc(s.text)}</div><div class="m">${fmt(s.start)} → ${fmt(s.end)}</div></div></div>`).join('') || '<div class="hint">글자가 없습니다.</div>'}`;
    }
  }
  async function onLeftClick(e) {
    const row = e.target.closest('[data-add]');
    if (row) { row.dataset.add === 'video' ? addClip(row.dataset.src) : addAudio(row.dataset.src); return; }
    const s = e.target.closest('[data-sel]');
    if (s) { sel = {type: s.dataset.sel, id: s.dataset.id}; const o = selObj(); if (o) seek(o.start); renderAll(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'addSub') addSub();
    else if (a === 'addText') addText();
    else if (a === 'srtIn') $('#edSrtFile').click();
    else if (a === 'srtOut') exportSrt();
    else if (e.target.id === 'edUp') $('#edUpFile').click();
  }
  document.addEventListener('change', async e => {
    if (e.target.id === 'edUpFile' && e.target.files[0]) {
      try { say('불러오는 중…'); const f = e.target.files[0]; const r = await fetch('/api/edit/asset?name=' + encodeURIComponent(f.name), {method: 'POST', body: f}); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.detail || '불러오지 못했습니다.'); info[j.src] = j; assets.push(j); say(`불러옴: ${j.name}`); renderLeft(); }
      catch (x) { say(x.message, true); }
      e.target.value = '';
    } else if (e.target.id === 'edSrtFile' && e.target.files[0]) {
      try {
        const buf = await e.target.files[0].arrayBuffer(); let text;
        try { text = new TextDecoder('utf-8', {fatal: true}).decode(buf); } catch { text = new TextDecoder('euc-kr').decode(buf); }
        const r = await api('/api/edit/srt/parse', {text});
        mutate(() => { P.subs.push(...r.subs); }); say(`자막 ${r.subs.length}개를 불러왔습니다.`);
      } catch (x) { say(x.message, true); }
      e.target.value = '';
    }
  });
  function onStyleInput(e) {
    const k = e.target.dataset.sty; if (!k) return;
    mutate(() => { P.sub_style[k] = k === 'size' ? clamp(num(e.target.value, 48), 10, 200) : e.target.value; }, false, 'sty' + k);
  }
  async function exportSrt() {
    if (!P.subs.length) { say('내보낼 자막이 없습니다.', true); return; }
    try {
      const r = await api('/api/edit/srt/format', {subs: P.subs});
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + r.text], {type: 'text/plain'})); a.download = (P.name || '자막') + '.srt'; a.click();
    } catch (x) { say(x.message, true); }
  }

  /* 오른쪽 속성 패널 */
  const FIELDS = {
    clip: [['in', '시작(초)', 'n'], ['out', '끝(초)', 'n'], ['speed', '속도(배)', 'n'], ['volume', '볼륨(%)', 'p'], ['mute', '소리 끄기', 'b']],
    audio: [['at', '시작 위치(초)', 'n'], ['in', '원본 시작(초)', 'n'], ['out', '끝(초, 0=끝까지)', 'n'], ['volume', '볼륨(%)', 'p'], ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n']],
    sub: [['start', '시작(초)', 'n'], ['end', '끝(초)', 'n'], ['text', '내용', 't']],
    text: [['start', '시작(초)', 'n'], ['end', '끝(초)', 'n'], ['text', '내용', 't'], ['size', '크기', 'n'], ['color', '색', 'c'], ['x', '가로 위치(%)', 'p'], ['y', '세로 위치(%)', 'p']],
  };
  const TITLES = {clip: '영상 클립', audio: '오디오', sub: '자막', text: '글자'};
  function fieldHtml(k, label, type, v) {
    let inp;
    if (type === 'n') inp = `<input type="number" step="${k === 'speed' ? 0.25 : 0.1}" data-k="${k}" data-t="n" value="${+(+v).toFixed(3)}">`;
    else if (type === 'p') inp = `<input type="number" step="5" data-k="${k}" data-t="p" value="${Math.round(v * 100)}">`;
    else if (type === 'b') inp = `<input type="checkbox" data-k="${k}" data-t="b" ${v ? 'checked' : ''}>`;
    else if (type === 'c') inp = `<input type="color" data-k="${k}" data-t="c" value="${v}">`;
    else inp = `<textarea data-k="${k}" data-t="t">${esc(v)}</textarea>`;
    return type === 't' ? `<div style="margin:6px 0"><div style="font-size:12px;margin-bottom:3px">${label}</div>${inp}</div>` : `<label>${label}</label>${inp}`;
  }
  function renderProps() {
    const o = selObj();
    if (!o) {
      R.props.innerHTML = `<h4>프로젝트</h4><div class="f"><label>화면 비율</label><select data-proj="aspect">${[['original', '원본 그대로'], ['16:9', '16:9 가로'], ['9:16', '9:16 세로(쇼츠)'], ['1:1', '1:1 정사각']].map(([k, n]) => `<option value="${k}" ${P.output.aspect === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <p class="note">총 길이 ${fmt(total())} · 클립 ${P.clips.length}개 · 오디오 ${P.audios.length}개 · 자막 ${P.subs.length}개<br>타임라인에서 항목을 누르면 세부 설정이 나옵니다.<br>비율이 원본과 다르면 남는 곳은 검은색으로 채웁니다.</p>`;
      return;
    }
    let extra = '';
    if (sel.type === 'clip') extra = `<div class="acts"><button data-do="setIn">현재 위치를 시작으로</button><button data-do="setOut">현재 위치를 끝으로</button></div><div class="note">원본 길이 ${fmt(info[o.src]?.duration || 0)} · ${esc(nameOf(o.src))}</div>`;
    if (sel.type === 'audio') extra = `<div class="note">${esc(nameOf(o.src))} · 원본 길이 ${fmt(info[o.src]?.duration || 0)}</div>`;
    R.props.innerHTML = `<h4>${TITLES[sel.type]}</h4><div class="f">${FIELDS[sel.type].map(([k, l, t]) => fieldHtml(k, l, t, o[k])).join('')}</div>${extra}
      <div class="acts"><button data-do="del">삭제</button></div>`;
  }
  function onPropInput(e) {
    const el = e.target;
    if (el.dataset.proj) { mutate(() => { P.output.aspect = el.value; }); return; }
    const o = selObj(), k = el.dataset.k; if (!o || !k) return;
    if (e.type === 'input' && el.dataset.t === 'b') return;
    let v = el.dataset.t === 'n' ? num(el.value) : el.dataset.t === 'p' ? num(el.value) / 100 : el.dataset.t === 'b' ? el.checked : el.value;
    if (el.dataset.t === 'n' && el.value === '') return;
    mutate(() => {
      o[k] = v;
      if (sel.type === 'clip') {
        const d = info[o.src]?.duration || o.out;
        o.speed = clamp(o.speed, 0.25, 4); o.out = clamp(o.out, 0.05, d); o.in = clamp(o.in, 0, o.out - 0.05); o.volume = clamp(o.volume, 0, 4);
      } else if (sel.type === 'sub' || sel.type === 'text') { o.start = Math.max(0, o.start); if (o.end <= o.start) o.end = o.start + 0.1; }
      else if (sel.type === 'audio') { o.at = Math.max(0, o.at); o.in = Math.max(0, o.in); o.out = Math.max(0, o.out); o.volume = clamp(o.volume, 0, 4); }
    }, e.type === 'change', 'p' + k);
    if (e.type === 'change') renderProps();
  }
  function onPropClick(e) {
    const d = e.target.dataset.do; if (!d) return;
    if (d === 'del') { removeSel(); return; }
    const o = selObj(); if (!o || sel.type !== 'clip') return;
    const i = P.clips.indexOf(o), at = o.in + (T - layout()[i]) * o.speed;
    if (T < layout()[i] || T > layout()[i] + cdur(o)) { say('재생선을 이 클립 위에 놓아 주세요.', true); return; }
    if (d === 'setIn' && at < o.out - 0.05) mutate(() => { o.in = at; });
    else if (d === 'setOut' && at > o.in + 0.05) mutate(() => { o.out = at; });
  }

  /* 미리보기 */
  function aspectRatio() {
    const a = P.output.aspect;
    if (a === '16:9') return 16 / 9; if (a === '9:16') return 9 / 16; if (a === '1:1') return 1;
    const i = P.clips[0] && info[P.clips[0].src]; return i?.width && i?.height ? i.width / i.height : 16 / 9;
  }
  function fitStage() {
    if (!R.wrap) return;
    const w = R.wrap.clientWidth - 20, h = R.wrap.clientHeight - 20, ar = aspectRatio();
    if (w <= 0 || h <= 0) return;
    let sw = w, sh = w / ar; if (sh > h) { sh = h; sw = h * ar; }
    R.stage.style.width = sw + 'px'; R.stage.style.height = sh + 'px';
    R.stage.style.setProperty('--k', (Math.min(sw, sh) / 1080).toFixed(4));
    renderOv();
  }
  function renderStage() { $('#edEmpty').style.display = P.clips.length ? 'none' : 'flex'; fitStage(); }
  function renderOv() {
    const st = P.sub_style, k = parseFloat(R.stage.style.getPropertyValue('--k')) || .4;
    const subs = P.subs.filter(s => T >= s.start && T < s.end).map(s => {
      const pos = st.pos === 'top' ? 'top:6%' : st.pos === 'middle' ? 'top:50%;transform:translateY(-50%)' : 'bottom:6%';
      return `<div class="sub" style="${pos};font-size:${st.size * k}px;color:${st.color};text-shadow:0 0 ${3 * k}px ${st.outline},0 0 ${3 * k}px ${st.outline},0 0 ${3 * k}px ${st.outline}">${esc(s.text)}</div>`;
    });
    const txts = P.texts.filter(s => T >= s.start && T < s.end).map(s =>
      `<div class="txt" style="left:${s.x * 100}%;top:${s.y * 100}%;font-size:${s.size * k}px;color:${s.color}">${esc(s.text)}</div>`);
    R.ov.innerHTML = subs.join('') + txts.join('');
  }
  const renderTime = () => { R.time.textContent = `${fmt(T)} / ${fmt(total())}`; };

  /* 타임라인 */
  function renderTimeline() {
    const st = layout();
    const end = Math.max(total(), ...P.audios.map(a => a.at + adur(a)), ...P.subs.map(s => s.end), ...P.texts.map(s => s.end), 0) + 8;
    R.inner.style.width = Math.max(end * pps, R.scroll.clientWidth) + 'px';
    const step = pps >= 100 ? 1 : pps >= 50 ? 2 : pps >= 25 ? 5 : pps >= 12 ? 10 : 30;
    let ruler = '';
    for (let t = 0; t < end; t += step) ruler += `<b style="left:${t * pps}px">${fmt(t).slice(0, 5)}</b>`;
    const blk = (type, o, left, width, label, extra = '') =>
      `<div class="blk ${type} ${sel?.id === o.id ? 'on' : ''} ${extra}" data-type="${type}" data-id="${o.id}" style="left:${left * pps}px;width:${Math.max(width * pps, 14)}px" title="${esc(label)}"><i class="h l" data-h="l"></i><span>${esc(label)}</span><i class="h r" data-h="r"></i></div>`;
    R.inner.innerHTML = `<div class="ruler" data-seek>${ruler}</div>
      <div class="lane v" data-seek>${P.clips.map((c, i) => blk('clip', c, st[i], cdur(c), `${nameOf(c.src)} · ${cdur(c).toFixed(1)}초${c.speed !== 1 ? ' · ' + c.speed + 'x' : ''}`, info[c.src]?.missing ? 'missing' : '')).join('')}</div>
      <div class="lane a" data-seek>${P.audios.map(a => blk('audio', a, a.at, adur(a), nameOf(a.src), info[a.src]?.missing ? 'missing' : '')).join('')}</div>
      <div class="lane s" data-seek>${P.subs.map(s => blk('sub', s, s.start, s.end - s.start, s.text)).join('')}</div>
      <div class="lane x" data-seek>${P.texts.map(s => blk('text', s, s.start, s.end - s.start, s.text)).join('')}</div>
      <div class="ph" id="edPh"></div>`;
    movePh();
  }
  function movePh() {
    const ph = $('#edPh'); if (!ph) return;
    ph.style.left = T * pps + 'px';
    if (playing) { const x = T * pps, s = R.scroll; if (x < s.scrollLeft || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = Math.max(0, x - 80); }
  }
  function onTlDown(e) {
    const b = e.target.closest('.blk');
    if (!b) {
      if (!e.target.closest('[data-seek]') && e.target !== R.inner) return;
      const rect = R.inner.getBoundingClientRect(), go = ev => { pause(); seek((ev.clientX - rect.left) / pps); };
      if (sel) { sel = null; renderProps(); renderLeft(); renderTimeline(); }  // 빈 곳을 누르면 선택 해제 -> 프로젝트 설정
      go(e); const mv = ev => go(ev), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up); return;
    }
    const type = b.dataset.type, id = b.dataset.id, o = find(type, id), mode = e.target.dataset.h || 'move';
    sel = {type, id}; const before = JSON.stringify(P), orig = {...o}, x0 = e.clientX;
    renderProps();
    const dMax = info[o.src]?.duration || 1e6;
    const mv = ev => {
      const dt = (ev.clientX - x0) / pps;
      if (type === 'clip') {
        if (mode === 'r') o.out = clamp(orig.out + dt * o.speed, orig.in + 0.1, dMax);
        else if (mode === 'l') o.in = clamp(orig.in + dt * o.speed, 0, orig.out - 0.1);
      } else if (type === 'audio') {
        if (mode === 'move') o.at = Math.max(0, orig.at + dt);
        else if (mode === 'r') o.out = clamp((orig.out || adur(orig) + orig.in) + dt, orig.in + 0.1, dMax);
        else { const d2 = clamp(dt, -orig.at, adur(orig) - 0.1); o.at = orig.at + d2; o.in = Math.max(0, orig.in + d2); }
      } else {
        const len = orig.end - orig.start;
        if (mode === 'move') { o.start = Math.max(0, orig.start + dt); o.end = o.start + len; }
        else if (mode === 'r') o.end = Math.max(orig.start + 0.1, orig.end + dt);
        else o.start = clamp(orig.start + dt, 0, orig.end - 0.1);
      }
      renderTimeline(); renderStage(); renderOv(); renderTime();
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      if (JSON.stringify(P) !== before) { undo.push(before); redo = []; lastKey = ''; }
      renderAll();
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
    renderTimeline();
  }
  function onKey(e) {
    if (!$('#viewEdit') || $('#viewEdit').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z') { e.preventDefault(); restore(undo, redo); }
    else if (e.ctrlKey && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); restore(redo, undo); }
    else if (e.ctrlKey && k === 's') { e.preventDefault(); saveProject(); }
    else if (k === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (k === 's' && !e.ctrlKey) split();
    else if (k === 'delete' || k === 'backspace') removeSel();
    else if (k === 'arrowleft') { pause(); seek(T - (e.shiftKey ? 1 : 1 / 30)); }
    else if (k === 'arrowright') { pause(); seek(T + (e.shiftKey ? 1 : 1 / 30)); }
  }

  /* ---------- 저장 / 열기 / 내보내기 ---------- */
  async function saveProject() {
    try { const r = await api('/api/edit/project', {name: P.name, data: P}); P.name = r.name; renderBar(); say(`저장했습니다: ${r.name}`); }
    catch (e) { say(e.message, true); }
  }
  async function openDialog() {
    let dlg = $('#dlgProjects');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dlgProjects'; document.body.appendChild(dlg); }
    let list = []; try { list = await api('/api/edit/projects'); } catch (e) { say(e.message, true); return; }
    dlg.innerHTML = `<div class="dh">저장한 프로젝트 <button class="ico" data-x>✕</button></div><div class="db">${list.length ? list.map(p => `<div class="row" style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)"><span style="flex:1;word-break:break-all">${esc(p.name)}</span><button data-open="${esc(p.name)}">열기</button><button data-rm="${esc(p.name)}">삭제</button></div>`).join('') : '저장한 프로젝트가 없습니다.'}</div>`;
    dlg.onclick = async e => {
      if (e.target.dataset.x !== undefined) dlg.close();
      else if (e.target.dataset.open) { dlg.close(); await loadProject(e.target.dataset.open); }
      else if (e.target.dataset.rm && confirm(`"${e.target.dataset.rm}" 프로젝트를 삭제할까요?`)) { await api('/api/edit/project/delete', {name: e.target.dataset.rm}); openDialog(); }
    };
    dlg.showModal();
  }
  async function loadProject(name) {
    try {
      const d = await api('/api/edit/project?name=' + encodeURIComponent(name));
      pause(); P = Object.assign(blank(), d); sel = null; undo = []; redo = [];
      const miss = [];
      await Promise.all([...new Set([...P.clips, ...P.audios].map(x => x.src))].map(s => probe(s).catch(() => miss.push(s))));
      renderAll(); seek(0);
      say(miss.length ? `원본 파일을 찾을 수 없습니다: ${miss.map(nameOf).join(', ')}` : `열었습니다: ${P.name}`, !!miss.length);
    } catch (e) { say(e.message, true); }
  }
  async function exportNow() {
    if (!P.clips.length) { say('타임라인에 영상이 없습니다.', true); return; }
    pause();
    try { const r = await api('/api/edit/export', P); say(`내보내는 중… 완료되면 "${r.output}" 로 저장됩니다. (아래 진행 표시줄 참고)`); pollJobs(); }
    catch (e) { say(e.message, true); }
  }

  return {
    async show() { if (!built) build(); await loadLib(); renderAll(); fitStage(); },
    hide() { if (built) pause(); },
    async addFromLibrary(name) { if (!built) build(); await loadLib(); await addClip(name); },
    refreshLib: loadLib,
    _state: () => ({P, T, sel, info}),  // 테스트용
  };
})();
