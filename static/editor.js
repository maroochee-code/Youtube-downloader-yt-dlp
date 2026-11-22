/* 편집 탭 (v1.1): 편집 목록(P)만 고치고, 내보내기 때 서버(ffmpeg)가 목록대로 영상을 만든다.
   - 영상/오디오 줄이 여러 개, 모든 클립은 (줄 번호 track, 시작 시간 start) 를 가진다.
   - 같은 줄에서 클립이 겹치고 trans 가 있으면 겹친 구간이 장면 전환이 된다. */
const Editor = (() => {
  const uid = () => 'x' + Math.random().toString(36).slice(2, 8);
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const num = (v, d = 0) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);
  const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60); return `${String(m).padStart(2, '0')}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; };
  const srcUrl = s => '/api/edit/media?src=' + encodeURIComponent(s);
  const OFF = 96, MAXTR = 8, AUTOKEY = 'ytdl_edit_autosave';
  const FX0 = () => ({angle: 0, fit: null, brightness: 0, contrast: 1, saturation: 1, gray: false, blur: 0, flip_h: false, flip_v: false, rotate: 0, reverse: false, kf: []});
  const track0 = () => ({mute: false, lock: false, hide: false});
  const FX0S = () => ({in: 'none', in_dur: 0.5, out: 'none', out_dur: 0.4, loop: 'none', kara: false, kara_color: '#ffd24d', box: false, box_color: '#000000', box_opacity: 0.6});
  const FX_IN = [['none', '없음'], ['fade', '페이드'], ['typing', '타이핑'], ['pop', '팝업(통통)'], ['slide-l', '왼쪽에서 슬라이드'], ['slide-r', '오른쪽에서 슬라이드'], ['slide-u', '위에서 슬라이드'], ['slide-d', '아래에서 슬라이드'], ['blur', '흐림에서 또렷하게'], ['zoom', '줌인']];
  const FX_LOOP = [['none', '없음'], ['shake', '흔들림'], ['float', '둥둥'], ['marquee-l', '흐르는 자막 ← (오른쪽에서 왼쪽)'], ['marquee-r', '흐르는 자막 → (왼쪽에서 오른쪽)']];
  const blank = () => ({version: 2, name: '편집본', tracks: {v: [track0(), track0()], a: [track0(), track0()]},
    clips: [], audios: [], subs: [], texts: [], markers: [], range: {in: null, out: null},
    sub_style: {size: 48, color: '#ffffff', outline: '#000000', pos: 'bottom', fx: FX0S()}, output: {aspect: 'original', loudnorm: false}});
  const TRANS = [['', '없음'], ['fade', '디졸브(서서히 겹침)'], ['slide-l', '오른쪽에서 밀려 들어옴'], ['slide-r', '왼쪽에서 밀려 들어옴'], ['slide-u', '아래에서 밀려 들어옴'], ['slide-d', '위에서 밀려 들어옴']];

  let P = blank(), sel = null, multi = new Set(), T = 0, playing = false, pps = 40, tab = 'video', snapOn = true;
  let lib = [], assets = [], built = false, undo = [], redo = [], lastKey = '', lastAt = 0, clip = null, saveTimer = 0;
  let playMs = 0, playT0 = 0, loopOn = false, rec = null, propClip = null, shapeColor = '#ffd24d';
  const info = {}, auds = {}, vels = new Map(), waves = {};
  const R = {};  // 자주 쓰는 DOM

  /* ---------- 계산 ---------- */
  const cdur = c => (c.freeze ? c.hold : (c.out - c.in) / c.speed);
  const cend = c => c.start + cdur(c);
  const adur = a => Math.max(0.05, (a.out || (info[a.src]?.duration ?? 0)) - a.in) / (a.speed || 1);
  const total = () => P.clips.reduce((m, c) => Math.max(m, cend(c)), 0);
  const nameOf = s => s.replace(/^asset:/, '').replace(/\.[^.]+$/, '');
  const LISTS = () => ({clip: P.clips, audio: P.audios, sub: P.subs, text: P.texts});
  const find = (type, id) => (LISTS()[type] || []).find(x => x.id === id);
  const typeOf = id => ['clip', 'audio', 'sub', 'text'].find(t => LISTS()[t].some(x => x.id === id));
  const dur = (type, o) => (type === 'clip' ? cdur(o) : type === 'audio' ? adur(o) : o.end - o.start);
  const endOf = (type, o) => (type === 'sub' || type === 'text' ? o.end : o.start + dur(type, o));
  const kindOf = type => (type === 'clip' ? 'v' : type === 'audio' ? 'a' : '');
  const trk = (type, o) => (kindOf(type) ? P.tracks[kindOf(type)][o.track] : null);
  const locked = (type, o) => !!trk(type, o)?.lock;
  const selObj = () => (sel ? find(sel.type, sel.id) : null);
  const selItems = () => [...multi].map(id => { const t = typeOf(id); return t ? {type: t, o: find(t, id)} : null; }).filter(Boolean);
  const say = (t, err) => { if (R.msg) { R.msg.textContent = t || ''; R.msg.className = 'ed-msg' + (err ? ' err' : ''); } };
  const setSel = (items, primary) => { multi = new Set(items.map(i => i.o.id)); const p = primary || items[items.length - 1]; sel = p ? {type: p.type, id: p.o.id} : null; };
  const clearSel = () => { sel = null; multi = new Set(); };
  const KFKEYS = ['x', 'y', 'scale', 'opacity'];
  const kfEval = (c, t) => {   // t 시점의 위치/크기/투명도 (키프레임이 없으면 클립 값 그대로)
    const base = {x: c.x, y: c.y, scale: c.scale, opacity: c.opacity};
    const kf = c.kf || []; if (!kf.length) return base;
    const rt = t - c.start;
    if (rt <= kf[0].t) return {...kf[0]};
    if (rt >= kf[kf.length - 1].t) return {...kf[kf.length - 1]};
    for (let i = 0; i < kf.length - 1; i++) if (rt < kf[i + 1].t) {
      const a = kf[i], b = kf[i + 1], u = (rt - a.t) / Math.max(b.t - a.t, 1e-3), out = {};
      for (const k of KFKEYS) out[k] = a[k] + (b[k] - a[k]) * u;
      return out;
    }
    return base;
  };
  function upsertKf(c, vals) {
    const t = +clamp(T - c.start, 0, cdur(c)).toFixed(2);
    c.kf = (c.kf || []).filter(k => Math.abs(k.t - t) > 0.005); c.kf.push({t, x: vals.x, y: vals.y, scale: vals.scale, opacity: vals.opacity}); c.kf.sort((a, b) => a.t - b.t);
  }
  function addKf() {
    const c = sel?.type === 'clip' ? selObj() : null; if (!c) { say('키프레임을 넣을 클립을 먼저 선택하세요.', true); return; }
    if (T < c.start || T > cend(c)) { say('재생선을 이 클립 위에 놓아 주세요.', true); return; }
    mutate(() => { const cur = kfEval(c, T); if (!(c.kf || []).length) upsertKf(c, {...cur}); upsertKf(c, cur); });
    renderProps(); say('현재 위치에 키프레임을 넣었습니다. 다른 위치로 옮기고 위치/크기/투명도를 바꾸면 자동으로 키프레임이 생기고 사이가 부드럽게 움직입니다.');
  }
  const overlapIn = c => {  // c 가 같은 줄 앞 클립과 겹친 길이 (전환이 지정된 때만)
    if (!c.trans) return 0; let best = 0;
    for (const o of P.clips) if (o !== c && o.track === c.track && o.start < c.start && c.start < cend(o)) best = Math.max(best, Math.min(cend(o), cend(c)) - c.start);
    return best;
  };
  const overlapOut = c => {
    let best = 0;
    for (const d of P.clips) if (d !== c && d.track === c.track && d.trans && c.start < d.start && d.start < cend(c)) best = Math.max(best, Math.min(cend(c), cend(d)) - d.start);
    return best;
  };

  function fixProject(d) {  // 저장본/자동저장본의 빠진 값 채우기
    const b = blank(), o = Object.assign(b, d);
    o.sub_style = {...blank().sub_style, ...(d.sub_style || {}), fx: {...FX0S(), ...(d.sub_style?.fx || {})}};
    o.subs = (d.subs || []).map(x => ({...x, fx: x.fx ? {...FX0S(), ...x.fx} : null}));
    o.texts = (d.texts || []).map(x => ({...x, fx: {...FX0S(), ...(x.fx || {})}}));
    o.version = 2; o.markers = Array.isArray(d.markers) ? d.markers : []; o.range = {in: null, out: null, ...(d.range || {})}; o.output = {aspect: 'original', loudnorm: false, ...(d.output || {})};
    const tr = (arr, n) => { arr = Array.isArray(arr) ? arr.map(t => ({...track0(), ...t})) : []; while (arr.length < n) arr.push(track0()); return arr; };
    o.clips = (o.clips || []).map((c, i) => ({track: 0, start: 0, speed: 1, volume: 1, mute: false, x: .5, y: .5, scale: 1, opacity: 1, fade_in: 0, fade_out: 0, trans: null, freeze: false, image: false, solid: null, hold: 2, link: null, group: null, ...FX0(), id: uid(), ...c}));
    o.audios = (o.audios || []).map(a => ({track: 0, speed: 1, volume: 1, in: 0, out: 0, fade_in: 0, fade_out: 0, duck: false, duck_level: .25, link: null, group: null, id: uid(), ...a, start: a.start ?? a.at ?? 0}));
    o.tracks = {v: tr(d.tracks?.v, Math.max(2, ...o.clips.map(c => c.track + 1))), a: tr(d.tracks?.a, Math.max(2, ...o.audios.map(a => a.track + 1)))};
    return o;
  }

  async function probe(src) {
    if (!info[src]) {
      try { info[src] = await api('/api/edit/probe?src=' + encodeURIComponent(src)); }
      catch (e) { info[src] = {missing: true, duration: 0, has_video: false, has_audio: false, width: 0, height: 0}; throw e; }
    }
    return info[src];
  }
  async function ensureWave(src) {
    if (waves[src] !== undefined) return;
    waves[src] = null;
    try { const r = await api('/api/edit/wave?src=' + encodeURIComponent(src)); waves[src] = {peaks: r.peaks, rate: r.rate, max: Math.max(5, ...r.peaks)}; drawWaves(); } catch { waves[src] = {peaks: [], rate: 20, max: 1}; }
  }

  /* ---------- 되돌리기 / 자동 저장 ---------- */
  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { if (P.clips.length || P.audios.length) localStorage.setItem(AUTOKEY, JSON.stringify(P)); } catch { /* 저장 공간 부족 등은 무시 */ } }, 1200);
  }
  function mutate(fn, structural = true, ck = '') {
    const now = Date.now();
    if (!(ck && ck === lastKey && now - lastAt < 800)) { undo.push(JSON.stringify(P)); if (undo.length > 100) undo.shift(); redo = []; }
    lastKey = ck; lastAt = now;
    fn(); queueSave();
    structural ? renderAll() : renderLight();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(P));
    P = JSON.parse(from.pop());
    multi = new Set([...multi].filter(id => typeOf(id))); if (sel && !selObj()) sel = null;
    lastKey = ''; queueSave(); renderAll();
  }

  /* ---------- 편집 동작 ---------- */
  const firstFree = kind => { const i = P.tracks[kind].findIndex(t => !t.lock); return i < 0 ? 0 : i; };
  const trackEnd = (type, track) => (type === 'clip' ? P.clips : P.audios).filter(o => o.track === track).reduce((m, o) => Math.max(m, endOf(type, o)), 0);
  async function addClip(src, at, track) {
    try {
      const i = await probe(src);
      if (!i.has_video) { say('영상 파일만 영상 줄에 넣을 수 있습니다.', true); return; }
      const tk = track ?? 0, id = uid();
      if (P.tracks.v[tk]?.lock) { say('잠긴 줄입니다.', true); return; }
      const im = !!i.is_image;
      mutate(() => P.clips.push({id, src, track: tk, start: at ?? trackEnd('clip', tk), in: 0, out: im ? 0.1 : i.duration, speed: 1, volume: 1, mute: im, x: .5, y: .5, scale: 1, opacity: 1, fade_in: 0, fade_out: 0, trans: null, freeze: im, image: im, solid: null, hold: 3, link: null, group: null, ...FX0()}));
      setSel([{type: 'clip', o: find('clip', id)}]); renderAll(); say('');
      if (P.clips.length === 1) seek(0); else syncPreview(true);
    } catch (e) { say(e.message, true); }
  }
  async function addAudio(src, at, track) {
    try {
      const i = await probe(src);
      if (!i.has_audio) { say('오디오가 없는 파일입니다.', true); return; }
      const tk = track ?? firstFree('a'), id = uid();
      if (P.tracks.a[tk]?.lock) { say('잠긴 줄입니다.', true); return; }
      mutate(() => P.audios.push({id, src, track: tk, start: at ?? T, in: 0, out: 0, speed: 1, volume: 1, fade_in: 0, fade_out: 0, link: null}));
      setSel([{type: 'audio', o: find('audio', id)}]); renderAll(); say(''); ensureWave(src);
    } catch (e) { say(e.message, true); }
  }
  function addSub() {
    const id = uid();
    mutate(() => P.subs.push({id, start: +T.toFixed(2), end: +(T + 2).toFixed(2), text: '새 자막', fx: null}));
    setSel([{type: 'sub', o: find('sub', id)}]); renderAll();
  }
  function addText() {
    const id = uid();
    mutate(() => P.texts.push({id, start: +T.toFixed(2), end: +(T + 3).toFixed(2), text: '글자', x: 0.5, y: 0.15, size: 64, color: '#ffffff', fx: FX0S()}));
    setSel([{type: 'text', o: find('text', id)}]); renderAll();
  }
  function addSolid(shape) {
    let tk = 0;
    if (shape !== 'bg') for (let i = P.tracks.v.length - 1; i >= 0; i--) if (!P.tracks.v[i].lock) { tk = i; break; }
    const id = uid();
    mutate(() => P.clips.push({id, src: '', track: tk, start: +T.toFixed(2), in: 0, out: 0.1, speed: 1, volume: 1, mute: true, x: .5, y: .5, scale: 1, opacity: 1, fade_in: 0, fade_out: 0, trans: null, freeze: true, image: false,
      solid: {shape: shape === 'ellipse' ? 'ellipse' : 'rect', color: shapeColor, w: shape === 'bg' ? 1 : .3, h: shape === 'bg' ? 1 : .3}, hold: 3, link: null, group: null, ...FX0()}));
    setSel([{type: 'clip', o: find('clip', id)}]); renderAll(); syncPreview(true);
  }
  const parseTime = txt => { const m = String(txt).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (m[1] ? +m[1] * 60 : 0) + +m[2] : null; };
  function setRange(which) {
    mutate(() => { P.range = {in: P.range?.in ?? null, out: P.range?.out ?? null}; P.range[which] = +T.toFixed(2); if (P.range.in !== null && P.range.out !== null && P.range.out <= P.range.in) { if (which === 'in') P.range.out = null; else P.range.in = null; } }, false);
    renderTimeline(); say(`구간 ${which === 'in' ? '시작' : '끝'}: ${fmt(T)} (🔁 버튼/L 키로 반복 재생)`);
  }
  function clearRange() { mutate(() => { P.range = {in: null, out: null}; }, false); renderTimeline(); say('반복 구간을 해제했습니다.'); }
  function addMarker() { mutate(() => { P.markers.push({id: uid(), t: +T.toFixed(2), label: '마커'}); P.markers.sort((a, b) => a.t - b.t); }, false); renderTimeline(); renderProps(); }
  function delMarker(id) { mutate(() => { P.markers = P.markers.filter(m => m.id !== id); }, false); renderTimeline(); renderProps(); }
  function expandGroup(items) {
    const gs = new Set(items.map(i => i.o.group).filter(Boolean)); if (!gs.size) return items;
    const ids = new Set(items.map(i => i.o.id)), out = [...items];
    for (const t of ['clip', 'audio', 'sub', 'text']) for (const o of LISTS()[t]) if (o.group && gs.has(o.group) && !ids.has(o.id)) { ids.add(o.id); out.push({type: t, o}); }
    return out;
  }
  function groupSel() {
    const items = selItems(); if (items.length < 2) { say('묶으려면 2개 이상 선택하세요.', true); return; }
    const gid = uid(); mutate(() => items.forEach(i => { i.o.group = gid; })); say(`${items.length}개를 묶었습니다. 하나를 누르면 같이 선택되고 같이 움직입니다.`);
  }
  function ungroupSel() { const items = selItems(); if (!items.some(i => i.o.group)) return; mutate(() => items.forEach(i => { i.o.group = null; })); say('묶음을 풀었습니다.'); }
  function copyProps() {
    const c = sel?.type === 'clip' ? selObj() : null; if (!c) { say('속성을 복사할 클립을 먼저 선택하세요.', true); return; }
    propClip = {x: c.x, y: c.y, scale: c.scale, opacity: c.opacity, volume: c.volume, fade_in: c.fade_in, fade_out: c.fade_out}; say('위치/크기/투명도/볼륨/페이드를 복사했습니다.');
  }
  function pasteProps() {
    const cs = selItems().filter(i => i.type === 'clip' && !locked('clip', i.o)); if (!propClip || !cs.length) { say('복사한 속성이 없거나 선택한 클립이 없습니다.', true); return; }
    mutate(() => cs.forEach(i => Object.assign(i.o, propClip))); say(`${cs.length}개 클립에 속성을 붙여넣었습니다.`);
  }
  async function toggleRec() {
    if (rec) { rec.mr.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true}), chunks = [], mr = new MediaRecorder(stream), startT = T;
      mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); rec = null; pause(); renderLeft();
        try {
          const blob = new Blob(chunks, {type: mr.mimeType || 'audio/webm'}), ext = /ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm';
          const name = `녹음_${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${ext}`;
          const r = await fetch('/api/edit/asset?name=' + encodeURIComponent(name), {method: 'POST', body: blob}), j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.detail || '녹음을 저장하지 못했습니다.');
          info[j.src] = j; assets.push(j); await addAudio(j.src, startT); say('녹음을 오디오 줄에 추가했습니다.');
        } catch (x) { say(x.message, true); }
      };
      mr.start(); rec = {mr}; renderLeft(); say('녹음 중… (영상이 있으면 같이 재생됩니다) 다시 누르면 끝납니다.');
      if (P.clips.length) play();
    } catch (x) { say('마이크를 쓸 수 없습니다: ' + (x.message || x.name) + ' (마이크 사용을 허용해 주세요)', true); }
  }
  function addTrack(kind) {
    if (P.tracks[kind].length >= MAXTR) { say(`줄은 최대 ${MAXTR}개까지입니다.`, true); return; }
    mutate(() => P.tracks[kind].push(track0()));
  }

  /* 연결된(link) 소리/영상 파트너까지 포함해서 같은 만큼 옮긴다 */
  function shiftWithLinks(objs, d) {
    const set = new Set(objs);
    for (const o of objs) if (o.link) for (const x of [...P.clips, ...P.audios]) if (x.link === o.link) set.add(x);
    for (const x of set) x.start = Math.max(0, x.start + d);
  }

  /* 나누기: 선택한 클립(없으면 재생선 위의 잠기지 않은 모든 클립/오디오). 연결된 소리도 함께. */
  function splitObjs(list, at) {
    const lk = {};
    const rights = [];
    for (const {type, o} of list) {
      const s = o.start, e = endOf(type, o);
      if (!(at > s + 0.05 && at < e - 0.05)) continue;
      let b;
      if (type === 'clip' && o.freeze) { b = {...o, id: uid(), start: at, hold: e - at}; o.hold = at - s; }
      else if (type === 'clip') { const cut = o.in + (at - s) * o.speed; b = {...o, id: uid(), start: at, in: cut, fade_in: 0, trans: null}; o.out = cut; b.fade_out = o.fade_out; o.fade_out = 0; }
      else { const cut = o.in + (at - s) * (o.speed || 1); const oldOut = o.out; b = {...o, id: uid(), start: at, in: cut, fade_in: 0}; o.out = cut; b.out = oldOut; b.fade_out = o.fade_out; o.fade_out = 0; }
      if (o.link) { lk[o.link] = lk[o.link] || uid(); b.link = lk[o.link]; }
      (type === 'clip' ? P.clips : P.audios).push(b); rights.push({type, o: b});
    }
    return rights;
  }
  function split() {
    let list = selItems().filter(i => kindOf(i.type) && !locked(i.type, i.o));
    if (!list.length) list = [...P.clips.map(o => ({type: 'clip', o})), ...P.audios.map(o => ({type: 'audio', o}))].filter(i => !locked(i.type, i.o) && T > i.o.start + 0.05 && T < endOf(i.type, i.o) - 0.05);
    // 연결된 파트너도 같이 나눈다
    const ids = new Set(list.map(i => i.o.id));
    for (const i of [...list]) if (i.o.link) for (const t of ['clip', 'audio']) for (const o of LISTS()[t]) if (o.link === i.o.link && !ids.has(o.id) && !locked(t, o)) { ids.add(o.id); list.push({type: t, o}); }
    if (!list.some(i => T > i.o.start + 0.05 && T < endOf(i.type, i.o) - 0.05)) { say('나눌 클립 위에 재생선을 놓으세요.', true); return; }
    let rights = [];
    mutate(() => { rights = splitObjs(list, T); });
    if (rights.length) { setSel(rights.filter(r => r.type === 'clip').length ? rights.filter(r => r.type === 'clip') : rights); renderAll(); say(''); }
  }
  function removeSelected(ripple) {
    let items = selItems().filter(i => !locked(i.type, i.o));
    if (!items.length) { if (multi.size) say('잠긴 줄의 항목은 지울 수 없습니다.', true); return; }
    const ids = new Set(items.map(i => i.o.id));   // 연결된 파트너도 함께 지운다
    for (const i of [...items]) if (i.o.link) for (const t of ['clip', 'audio']) for (const x of LISTS()[t]) if (x.link === i.o.link && !ids.has(x.id) && !locked(t, x)) { ids.add(x.id); items.push({type: t, o: x}); }
    mutate(() => {
      for (const {type, o} of [...items].sort((a, b) => b.o.start - a.o.start)) {
        const arr = LISTS()[type]; arr.splice(arr.indexOf(o), 1);
        if (ripple && kindOf(type)) { const d = dur(type, o), e = o.start + d; shiftWithLinks(arr.filter(x => x.track === o.track && x.start >= e - 0.001 && !ids.has(x.id)), -d); }
      }
    });
    clearSel(); renderAll(); seek(Math.min(T, total()));
  }
  function copySel() {
    const items = selItems(); if (!items.length) return;
    clip = {items: JSON.parse(JSON.stringify(items.map(i => ({type: i.type, o: i.o})))), min: Math.min(...items.map(i => i.o.start)), max: Math.max(...items.map(i => endOf(i.type, i.o)))};
    say(`${items.length}개를 복사했습니다. Ctrl+V 로 붙여넣기`);
  }
  function pasteAt(at) {
    if (!clip) { say('복사한 항목이 없습니다.', true); return; }
    const shift = at - clip.min, lk = {}, made = [];
    mutate(() => {
      for (const {type, o} of clip.items) {
        const n = {...JSON.parse(JSON.stringify(o)), id: uid()};
        if (kindOf(type) && P.tracks[kindOf(type)][n.track]?.lock) n.track = firstFree(kindOf(type));
        if (n.link) { lk[n.link] = lk[n.link] || uid(); n.link = lk[n.link]; }
        if (type === 'sub' || type === 'text') { n.start = Math.max(0, n.start + shift); n.end = n.end + shift; } else n.start = Math.max(0, n.start + shift);
        LISTS()[type].push(n); made.push({type, o: n});
      }
      for (const m of made) if (m.o.link && made.filter(x => x.o.link === m.o.link).length < 2) m.o.link = null;
    });
    setSel(made); renderAll(); say(`${made.length}개를 붙여넣었습니다.`);
  }
  function duplicateSel() { copySel(); if (clip) pasteAt(clip.max); }

  function detachAudio() {
    const c = sel?.type === 'clip' ? selObj() : null;
    if (!c) { say('소리를 분리할 영상 클립을 먼저 선택하세요.', true); return; }
    if (c.freeze || c.mute || !info[c.src]?.has_audio) { say('분리할 소리가 없는 클립입니다.', true); return; }
    const id = uid();
    mutate(() => {
      P.audios.push({id, src: c.src, track: firstFree('a'), start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, fade_in: c.fade_in, fade_out: c.fade_out, duck: false, duck_level: .25, link: null, group: null});
      c.mute = true;
    });
    setSel([{type: 'audio', o: find('audio', id)}]); renderAll(); ensureWave(c.src); say('소리를 오디오 줄로 분리했습니다. 영상은 소리가 꺼졌고, 소리는 따로 움직입니다. (같이 움직이게 하려면 🔗 연결)');
  }
  function linkSel() {
    const items = selItems(), by = (a, b) => Math.abs(a.start - b.start);
    let c = items.find(i => i.type === 'clip' && !i.o.solid)?.o, a = items.find(i => i.type === 'audio')?.o;
    if (!c && a) c = P.clips.filter(x => !x.solid && x.src === a.src).sort((x, y) => by(x, a) - by(y, a))[0];
    if (!a && c) a = P.audios.filter(x => x.src === c.src).sort((x, y) => by(x, c) - by(y, c))[0];
    if (!c || !a) { say('연결할 영상 클립과 오디오를 Shift 로 함께 선택한 뒤 눌러 주세요. (같은 파일이면 하나만 선택해도 자동으로 찾습니다)', true); return; }
    const lid = c.link || a.link || uid();
    mutate(() => { c.link = lid; a.link = lid; });
    say('연결했습니다. 🔗 둘은 같이 움직이고, 지우거나 나눌 때도 같이 처리됩니다.');
  }
  function unlinkSel() {
    const ids = new Set(selItems().map(i => i.o.link).filter(Boolean));
    if (!ids.size) { say('선택한 항목에 연결이 없습니다.', true); return; }
    mutate(() => { for (const x of [...P.clips, ...P.audios]) if (ids.has(x.link)) x.link = null; });
    say('연결을 해제했습니다. 이제 따로 움직입니다.');
  }
  function freezeFrame() {
    const cands = sel?.type === 'clip' ? [selObj()] : P.clips.filter(c => !locked('clip', c) && T > c.start + 0.05 && T < cend(c) - 0.05);
    const c = cands.filter(Boolean).sort((a, b) => b.track - a.track)[0];
    if (!c || c.freeze || !(T > c.start + 0.05 && T < cend(c) - 0.05)) { say('정지 화면을 만들 영상 클립 위에 재생선을 놓으세요.', true); return; }
    const hold = 2, at = T, fid = uid();
    mutate(() => {
      const rights = splitObjs([{type: 'clip', o: c}, ...P.audios.filter(a => c.link && a.link === c.link).map(o => ({type: 'audio', o}))], at);
      const cutIn = rights.find(r => r.type === 'clip').o.in;
      shiftWithLinks(P.clips.filter(x => x.track === c.track && x.start >= at - 0.001), hold);
      P.clips.push({...c, id: fid, start: at, in: cutIn, out: cutIn + 0.1, freeze: true, hold, speed: 1, mute: true, fade_in: 0, fade_out: 0, trans: null, link: null, reverse: false, kf: []});
    });
    setSel([{type: 'clip', o: find('clip', fid)}]); renderAll(); say('재생선 위치의 화면을 2초 동안 멈췄습니다. (오른쪽 패널에서 길이 조절)');
  }
  /* 전환: 앞 클립과 겹친 구간이 전환 길이가 된다. 길이를 바꾸면 뒤에 오는 클립들이 같이 당겨지거나 밀린다. */
  function prevClip(c) { return P.clips.filter(o => o !== c && o.track === c.track && o.start < c.start).sort((a, b) => b.start - a.start)[0]; }
  function setTransition(c, type, d) {
    const p = prevClip(c);
    if (type && !p) { say('같은 줄의 앞쪽에 이어 붙을 영상이 없습니다.', true); return; }
    const cur = p ? Math.max(0, cend(p) - c.start) : 0;
    let want = 0;
    if (type) want = clamp(d ?? (cur > 0.05 ? cur : 0.5), 0.1, Math.max(0.1, Math.min(cdur(c), cdur(p)) - 0.05));
    let delta = want - cur;                       // 양수면 더 겹치게 = 앞으로 당김
    if (c.start - delta < 0) delta = c.start;
    mutate(() => {
      c.trans = type ? {type} : null;
      shiftWithLinks(P.clips.filter(x => x.track === c.track && x.start >= c.start - 0.001), -delta);
    });
  }

  /* ---------- 재생 / 미리보기 ---------- */
  const layers = () => [...P.clips].sort((a, b) => a.track - b.track || a.start - b.start);
  function ensureVel(c) {
    const kind = c.solid ? 'solid' : c.image ? 'img' : 'video';
    let v = vels.get(c.id);
    if (!v || v.src !== c.src || v.kind !== kind) {
      if (v) disposeVel(c.id);
      const el = document.createElement(kind === 'video' ? 'video' : kind === 'img' ? 'img' : 'div');
      el.className = 'lyr' + (kind === 'solid' ? ' solid' : ''); el.style.display = 'none';
      if (kind === 'video') { el.preload = 'auto'; el.playsInline = true; el.src = srcUrl(c.src); el.addEventListener('loadedmetadata', () => { renderStage(); if (!playing) syncPreview(true); }); }
      else if (kind === 'img') { el.src = srcUrl(c.src); el.draggable = false; }
      R.stage.insertBefore(el, R.ov);
      v = {el, src: c.src, kind, last: 0}; vels.set(c.id, v);
    }
    return v;
  }
  function disposeVel(id) { const v = vels.get(id); if (!v) return; if (v.kind === 'video') { v.el.pause(); v.el.removeAttribute('src'); v.el.load(); } v.el.remove(); vels.delete(id); }
  function getAud(a) {
    if (!auds[a.id] || auds[a.id].dataset.src !== a.src) { const el = new Audio(srcUrl(a.src)); el.dataset.src = a.src; el.preload = 'auto'; auds[a.id] = el; }
    return auds[a.id];
  }
  const ramp = (rel, d, left, fi, fo) => { let f = 1; if (fi > 0 && rel < fi) f *= rel / fi; if (fo > 0 && left < fo) f *= left / fo; return clamp(f, 0, 1); };
  function voiceSpans() {
    let sp = [];
    for (const c of P.clips) if (!(c.freeze || c.mute || c.solid || P.tracks.v[c.track]?.mute) && info[c.src]?.has_audio) sp.push([c.start, cend(c)]);
    for (const a of P.audios) if (!a.duck && !P.tracks.a[a.track]?.mute) sp.push([a.start, a.start + adur(a)]);
    sp.sort((x, y) => x[0] - y[0]); const out = [];
    for (const [s0, e0] of sp) { if (out.length && s0 - out[out.length - 1][1] < 0.5) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e0); else out.push([s0, e0]); }
    return out;
  }
  const duckGain = (spans, level, t) => { let m = 0; for (const [s0, e0] of spans) m = Math.max(m, clamp(Math.min((t - (s0 - .25)) / .25, (e0 + .25 - t) / .25), 0, 1)); return 1 - (1 - level) * m; };
  function syncPreview(force) {
    const ls = layers(), now = T, spans = P.audios.some(a => a.duck) ? voiceSpans() : [];
    const alive = new Set(P.clips.map(c => c.id));
    for (const id of [...vels.keys()]) if (!alive.has(id)) disposeVel(id);
    ls.forEach((c, z) => {
      const d = cdur(c), rel = now - c.start, active = rel >= -0.0001 && rel < d - 0.0001;
      const soon = !active && playing && c.start - now > 0 && c.start - now < 1.5;
      if (!active && !soon) { const v = vels.get(c.id); if (v) { if (v.kind === 'video') v.el.pause(); v.el.style.display = 'none'; } return; }
      const v = ensureVel(c), el = v.el; v.last = Date.now();
      const vid = v.kind === 'video';
      if (soon) { el.style.display = 'none'; if (vid) { el.pause(); if (Math.abs(el.currentTime - c.in) > 0.2 && el.readyState >= 1) el.currentTime = c.in; } return; }
      const want = c.freeze ? c.in : c.in + rel * c.speed;
      const tk = P.tracks.v[c.track] || track0();
      el.style.display = ''; el.style.zIndex = z + 1; el.style.visibility = tk.hide ? 'hidden' : 'visible';
      // 위치/크기/투명도/전환
      const kv = kfEval(c, now);
      let op = kv.opacity, tx = (kv.x - .5) * 100, ty = (kv.y - .5) * 100;
      const ovIn = overlapIn(c);
      if (c.trans && ovIn > 0 && rel < ovIn) {
        const pr = clamp(rel / ovIn, 0, 1), k = c.trans.type;
        if (k === 'fade') op *= pr; else if (k === 'slide-l') tx += (1 - pr) * 100; else if (k === 'slide-r') tx -= (1 - pr) * 100; else if (k === 'slide-u') ty += (1 - pr) * 100; else if (k === 'slide-d') ty -= (1 - pr) * 100;
      }
      op *= ramp(rel, d, d - rel, c.trans?.type === 'fade' && ovIn > 0 ? 0 : c.fade_in, c.fade_out);
      const swp = R.stage.clientWidth, shp = R.stage.clientHeight, kk = parseFloat(R.stage.style.getPropertyValue('--k')) || .4, rot = c.rotate || 0;
      const rs = rot % 180 ? Math.min(swp / shp, shp / swp) : 1;
      el.style.opacity = op;
      el.style.transform = `translate(${tx * swp / 100}px,${ty * shp / 100}px) scale(${kv.scale * rs}) rotate(${rot + (c.angle || 0)}deg) scale(${c.flip_h ? -1 : 1},${c.flip_v ? -1 : 1})`;
      const fl = [];
      if (c.brightness) fl.push(`brightness(${Math.max(0, 1 + c.brightness)})`);
      if ((c.contrast ?? 1) !== 1) fl.push(`contrast(${c.contrast})`);
      if ((c.saturation ?? 1) !== 1) fl.push(`saturate(${c.saturation})`);
      if (c.gray) fl.push('grayscale(1)');
      if (c.blur > 0.05) fl.push(`blur(${c.blur * kk}px)`);
      el.style.filter = fl.join(' ');
      el.style.objectFit = (c.fit || (P.output.fill && !c.image ? 'cover' : 'contain'));
      if (c.solid) { const sd = c.solid; Object.assign(el.style, {background: sd.color, left: (1 - sd.w) / 2 * 100 + '%', top: (1 - sd.h) / 2 * 100 + '%', width: sd.w * 100 + '%', height: sd.h * 100 + '%', borderRadius: sd.shape === 'ellipse' ? '50%' : '0'}); }
      if (!vid) return;
      // 소리
      const fin = Math.max(c.fade_in, ovIn), fout = Math.max(c.fade_out, overlapOut(c));
      el.muted = c.mute || c.freeze || tk.mute; el.volume = clamp(c.volume * ramp(rel, d, d - rel, fin, fout), 0, 1);
      el.playbackRate = c.speed;
      if (c.freeze || !playing) { el.pause(); if (el.readyState >= 1 && (force || Math.abs(el.currentTime - want) > 0.04)) el.currentTime = want; }
      else if (el.paused) { if (el.readyState >= 1) el.currentTime = want; el.play().catch(() => {}); }
      else if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
    });
    if (vels.size > 6) for (const [id, v] of [...vels].sort((a, b) => a[1].last - b[1].last)) { if (vels.size <= 6) break; if (v.el.style.display === 'none') disposeVel(id); }
    for (const a of P.audios) {
      const el = getAud(a), d = adur(a), rel = now - a.start, tk = P.tracks.a[a.track] || track0();
      if (playing && rel >= 0 && rel < d && !tk.mute) {
        const want = a.in + rel * a.speed;
        el.playbackRate = a.speed;
        if (el.paused || force || Math.abs(el.currentTime - want) > 0.35) el.currentTime = want;
        el.volume = clamp(a.volume * ramp(rel, d, d - rel, a.fade_in, a.fade_out) * (a.duck ? duckGain(spans, a.duck_level, now) : 1), 0, 1);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
  }
  function seek(t) {
    T = clamp(t, 0, Math.max(total(), 0));
    if (playing) { playMs = performance.now(); playT0 = T; }
    syncPreview(true); movePh(); renderOv(); renderTime();
    if (!playing && sel?.type === 'clip' && selObj()?.kf?.length && R.props && !R.props.contains(document.activeElement)) renderProps();
  }
  function play() {
    if (!P.clips.length) return;
    if (T >= total() - 0.05) T = 0;
    playing = true; R.play.textContent = '⏸'; playMs = performance.now(); playT0 = T;
    syncPreview(true); requestAnimationFrame(tick);
  }
  function stopAll() { for (const v of vels.values()) if (v.kind === 'video') v.el.pause(); for (const a of Object.values(auds)) a.pause(); }
  function pause() { playing = false; R.play.textContent = '▶'; stopAll(); }
  function tick() {
    if (!playing) return;
    T = playT0 + (performance.now() - playMs) / 1000;
    const rg = P.range;
    if (loopOn && rg && rg.in != null && rg.out != null && rg.out > rg.in && T >= rg.out) { seek(rg.in); requestAnimationFrame(tick); return; }
    if (T >= total()) { T = total(); pause(); syncPreview(true); movePh(); renderOv(); renderTime(); return; }
    syncPreview(false); movePh(); renderOv(); renderTime();
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
          <div class="ed-wrap" id="edWrap"><div id="edStage"><div id="edOv"></div><div class="guide gv" id="edGv" hidden></div><div class="guide gh" id="edGh" hidden></div><div id="edBox" hidden><i class="rot" data-h="rot"></i><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i><i class="edge" data-h="n"></i><i class="edge" data-h="s"></i><i class="edge" data-h="e"></i><i class="edge" data-h="w"></i></div><div class="empty" id="edEmpty">왼쪽 목록에서 영상을 눌러 추가하세요<br>(타임라인으로 끌어다 놓아도 됩니다)</div></div></div>
          <div class="ed-ctl"><button id="edToStart" title="처음으로">⏮</button><button id="edPlay" title="재생/정지 (Space)">▶</button><span id="edTime">00:00.0 / 00:00.0</span>
            <span class="sep"></span><button id="edIn" title="구간 시작 (I)">I</button><button id="edOut" title="구간 끝 (O)">O</button><button id="edLoop" class="tg" title="구간 반복 재생 (L). 구간은 I/O 로 지정, X 로 해제">🔁</button><button id="edMark" title="재생선에 마커 (M)">⚑</button>
            <input id="edGo" type="text" placeholder="이동 1:23.5" size="9" title="시간을 입력하고 Enter"><button id="edFull" title="미리보기 전체 화면">⛶</button></div>
        </div>
        <div class="ed-right" id="edProps"></div>
      </div>
      <div class="ed-tools">
        <button id="edSplit" title="나누기 (S)">✂ 나누기</button><button id="edDel" title="삭제 (Delete)">🗑 삭제</button><button id="edRip" title="삭제하고 뒤를 당기기 (Shift+Delete)">⇤ 당겨서 삭제</button>
        <span class="sep"></span><button id="edCopy" title="복사 (Ctrl+C)">복사</button><button id="edPaste" title="재생선 위치에 붙여넣기 (Ctrl+V)">붙여넣기</button><button id="edDup" title="복제 (Ctrl+D)">복제</button>
        <span class="sep"></span><button id="edGroup" title="선택한 항목 묶기 (Ctrl+G)">묶기</button><button id="edUngroup" title="묶음 풀기 (Ctrl+Shift+G)">풀기</button>
        <span class="sep"></span><button id="edDetach" title="영상 클립의 소리를 오디오 줄로 분리">🔊 소리 분리</button><button id="edLink" title="영상과 오디오를 연결(같이 움직임)">🔗 연결</button><button id="edUnlink" title="연결 해제">연결 해제</button><button id="edFreeze" title="재생선 위치를 멈춘 화면으로">❄ 정지 화면</button>
        <span class="sep"></span><button id="edUndo" title="되돌리기 (Ctrl+Z)">↶</button><button id="edRedo" title="다시 실행 (Ctrl+Y)">↷</button>
        <span class="sep"></span><button id="edShot" title="재생선 위치 화면을 PNG 로 저장">📷 화면 저장</button><button id="edCover" title="재생선 위치를 mp4 표지로 지정">🖼 표지 지정</button>
        <span class="sep"></span><button id="edSnap" class="tg on" title="클립 가장자리에 자석처럼 붙기">🧲 자석</button><button id="edAddV" title="영상 줄 추가">＋영상 줄</button><button id="edAddA" title="오디오 줄 추가">＋오디오 줄</button>
        <span style="flex:1"></span><span style="font-size:12px;color:var(--mute)">확대</span><button id="edFit" title="타임라인 전체가 한 화면에 보이게">전체 보기</button><input type="range" id="edZoom" min="1" max="200" value="${pps}" title="확대/축소 (Ctrl+마우스 휠도 됩니다)">
      </div>
      <div class="ed-tl"><div class="ed-scroll" id="edScroll"><div id="edInner"></div></div></div>`;
    Object.assign(R, {play: $('#edPlay'), msg: $('#edMsg'), stage: $('#edStage'), wrap: $('#edWrap'), ov: $('#edOv'),
      inner: $('#edInner'), scroll: $('#edScroll'), props: $('#edProps'), lbody: $('#edLbody'), time: $('#edTime'), name: $('#edName')});
    new ResizeObserver(fitStage).observe(R.wrap);
    $('#edBox').addEventListener('pointerdown', e => boxDown(e, e.target.dataset.h || 'move'));
    R.stage.addEventListener('pointerdown', stageDown);
    $('#edPlay').onclick = () => (playing ? pause() : play());
    $('#edToStart').onclick = () => { pause(); seek(0); };
    $('#edSplit').onclick = split; $('#edDel').onclick = () => removeSelected(false); $('#edRip').onclick = () => removeSelected(true);
    $('#edCopy').onclick = copySel; $('#edPaste').onclick = () => pasteAt(T); $('#edDup').onclick = duplicateSel;
    $('#edDetach').onclick = detachAudio; $('#edLink').onclick = linkSel; $('#edUnlink').onclick = unlinkSel; $('#edFreeze').onclick = freezeFrame;
    $('#edShot').onclick = saveShot; $('#edCover').onclick = () => { mutate(() => { P.output.cover_t = +T.toFixed(2); }, false); renderProps(); say(`표지로 지정: ${fmt(T)} 화면 (mp4 내보내기에 들어갑니다)`); };
    $('#edGroup').onclick = groupSel; $('#edUngroup').onclick = ungroupSel;
    $('#edIn').onclick = () => setRange('in'); $('#edOut').onclick = () => setRange('out'); $('#edMark').onclick = addMarker;
    $('#edLoop').onclick = e => { loopOn = !loopOn; e.currentTarget.classList.toggle('on', loopOn); };
    $('#edFull').onclick = () => { (R.wrap.requestFullscreen || R.wrap.webkitRequestFullscreen)?.call(R.wrap); };
    $('#edGo').onkeydown = e => { if (e.key !== 'Enter') return; const t = parseTime(e.target.value); if (t === null) { say('시간을 1:23.5 또는 83.5 처럼 입력하세요.', true); return; } pause(); seek(t); e.target.blur(); };
    $('#edUndo').onclick = () => restore(undo, redo); $('#edRedo').onclick = () => restore(redo, undo);
    $('#edSnap').onclick = e => { snapOn = !snapOn; e.currentTarget.classList.toggle('on', snapOn); };
    $('#edAddV').onclick = () => addTrack('v'); $('#edAddA').onclick = () => addTrack('a');
    $('#edZoom').oninput = e => setZoom(+e.target.value);
    $('#edFit').onclick = () => { const w = R.scroll.clientWidth - OFF - 30, tot = Math.max(total(), 1); setZoom(clamp(w / tot, 1, 200)); R.scroll.scrollLeft = 0; };
    R.scroll.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); setZoom(clamp(pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 200), e.clientX); }, {passive: false});
    R.name.oninput = () => { P.name = R.name.value; queueSave(); };
    $('#edNew').onclick = () => { if ((P.clips.length || P.audios.length) && !confirm('지금 편집 중인 내용이 사라집니다. 새로 만들까요?')) return; pause(); P = blank(); clearSel(); undo = []; redo = []; try { localStorage.removeItem(AUTOKEY); } catch { /* 무시 */ } renderAll(); seek(0); };
    $('#edSave').onclick = saveProject; $('#edOpen').onclick = openDialog; $('#edExport').onclick = exportNow;
    $('#edLtabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderLeft(); } };
    R.lbody.addEventListener('click', onLeftClick);
    R.lbody.addEventListener('input', onStyleInput);
    R.lbody.addEventListener('dragstart', e => { const r = e.target.closest('[data-add]'); if (r) e.dataTransfer.setData('text/plain', JSON.stringify({kind: r.dataset.add, src: r.dataset.src})); });
    R.props.addEventListener('input', onPropInput);
    R.props.addEventListener('change', onPropInput);
    R.props.addEventListener('click', onPropClick);
    R.inner.addEventListener('pointerdown', onTlDown);
    R.inner.addEventListener('click', onTlClick);
    R.inner.addEventListener('contextmenu', e => { const m = e.target.closest('[data-mk]'); if (m) { e.preventDefault(); delMarker(m.dataset.mk); } });
    R.inner.addEventListener('dragover', e => { if (e.target.closest('.lane[data-kind]')) e.preventDefault(); });
    R.inner.addEventListener('drop', onTlDrop);
    document.addEventListener('keydown', onKey);
    built = true;
    try {
      const saved = JSON.parse(localStorage.getItem(AUTOKEY) || 'null');
      if (saved && (saved.clips?.length || saved.audios?.length)) setTimeout(() => { if (!P.clips.length && confirm('이전에 편집하던 작업이 남아 있습니다. 복구할까요?')) restoreProject(saved); }, 300);
    } catch { /* 자동 저장본이 깨졌으면 무시 */ }
  }
  async function restoreProject(d) {
    pause(); P = fixProject(d); clearSel(); undo = []; redo = [];
    const miss = [];
    await Promise.all([...new Set([...P.clips, ...P.audios].map(x => x.src).filter(Boolean))].map(s => probe(s).catch(() => miss.push(s))));
    renderAll(); seek(0); P.audios.forEach(a => ensureWave(a.src));
    say(miss.length ? `원본 파일을 찾을 수 없습니다: ${miss.map(nameOf).join(', ')}` : `열었습니다: ${P.name}`, !!miss.length);
  }

  /* 확대/축소: 재생선(또는 마우스 위치)이 화면에서 움직이지 않게 기준점을 잡는다 */
  function setZoom(np, anchorX) {
    const sc = R.scroll, sr = sc.getBoundingClientRect(), old = pps;
    let ax = anchorX ?? sr.left + OFF + (T * old - sc.scrollLeft);
    if (anchorX === undefined && (ax < sr.left + OFF || ax > sr.right)) ax = sr.left + OFF + (sr.width - OFF) / 2;   // 재생선이 화면 밖이면 가운데 기준
    const t = (ax - sr.left + sc.scrollLeft - OFF) / old;
    pps = Math.round(np * 100) / 100;
    const z = $('#edZoom'); if (z && +z.value !== Math.round(pps)) z.value = Math.round(pps);
    renderTimeline();
    sc.scrollLeft = Math.max(0, OFF + t * pps - (ax - sr.left));
  }
  function renderAll() { renderBar(); renderLeft(); renderTimeline(); renderProps(); renderStage(); renderOv(); renderTime(); }
  function renderLight() { renderTimeline(); renderStage(); renderOv(); renderTime(); }
  function renderBar() { if (document.activeElement !== R.name) R.name.value = P.name; }

  const LTABS = [['video', '영상'], ['audio', '오디오'], ['shape', '도형'], ['sub', '자막'], ['text', '글자']];
  async function loadLib() { try { lib = (await api('/api/library')).items; } catch (e) { say(e.message, true); } renderLeft(); }
  function libRows(items, kind) {
    return items.map(it => `<div class="row" draggable="true" data-add="${kind}" data-src="${esc(it.src ?? it.name)}">
      ${it.thumb ? `<img loading="lazy" draggable="false" src="/api/file?name=${encodeURIComponent(it.thumb)}">` : `<div class="ph">${kind === 'video' ? '영상' : '음원'}</div>`}
      <div style="min-width:0"><div class="t">${esc(it.title ?? nameOf(it.name))}</div></div><button class="add" tabindex="-1">＋</button></div>`).join('')
      || '<div class="hint">저장된 파일이 없습니다. 다운로드 탭에서 먼저 받아 주세요.</div>';
  }
  function renderLeft() {
    $('#edLtabs').innerHTML = LTABS.map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('');
    const b = R.lbody;
    if (tab === 'video') b.innerHTML = `<div class="btns"><button id="edImg">🖼 이미지 불러오기</button><input type="file" id="edImgFile" accept="image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif" hidden></div>
      <div class="hint" style="padding-top:0">누르면 맨 아래 영상 줄 끝에 붙고, 타임라인으로 끌어다 놓으면 그 위치/줄에 들어갑니다. 이미지는 3초짜리 정지 화면으로 들어가며, 투명 PNG는 로고/스티커로 쓸 수 있습니다.</div>
      ${assets.filter(a => a.is_image).length ? '<div class="hint">불러온 이미지</div>' + libRows(assets.filter(a => a.is_image).map(a => ({src: a.src, title: a.name})), 'video') : ''}
      <div class="hint">저장한 영상</div>` + libRows(lib.filter(i => !i.audio), 'video');
    else if (tab === 'shape') b.innerHTML = `<div class="btns"><button data-act="shapeRect">▭ 사각형</button><button data-act="shapeEllipse">⬭ 원</button><button data-act="shapeBg">■ 배경색 (전체 화면)</button></div>
      <div class="sty"><span>색</span><input type="color" data-shapecolor value="${shapeColor}"></div>
      <div class="hint">현재 위치에 3초짜리로 들어갑니다. 크기, 위치, 투명도, 모양은 오른쪽에서 바꿉니다. 사각형을 얇게 만들면 선이 됩니다.</div>`;
    else if (tab === 'audio') {
      b.innerHTML = `<div class="btns"><button id="edUp">📁 내 PC에서 불러오기</button><button id="edRec" class="${rec ? 'rec' : ''}">${rec ? '⏹ 녹음 끝내기' : '🎙 녹음'}</button><input type="file" id="edUpFile" accept="audio/*,video/*,.mp3,.m4a,.wav,.flac,.ogg,.opus" hidden></div>
        <div class="hint" style="padding-top:0">누르면 재생선 위치에 들어갑니다. 끌어다 놓아도 됩니다.</div>
        ${assets.length ? '<div class="hint">불러온 파일</div>' + libRows(assets.map(a => ({src: a.src, title: a.name})), 'audio') : ''}
        <div class="hint">저장한 파일 (영상에서 소리만 쓸 수도 있습니다)</div>${libRows(lib, 'audio')}`;
    } else if (tab === 'sub') {
      const st = P.sub_style;
      b.innerHTML = `<div class="btns"><button data-act="addSub">＋ 현재 위치에 자막</button><button data-act="srtIn">SRT 불러오기</button><button data-act="srtOut">SRT 내보내기</button><input type="file" id="edSrtFile" accept=".srt,.txt" hidden></div>
        ${[...P.subs].sort((x, y) => x.start - y.start).map(s => `<div class="row srow ${multi.has(s.id) ? 'on' : ''}" data-sel="sub" data-id="${s.id}"><div style="min-width:0"><div class="t">${esc(s.text)}</div><div class="m">${fmt(s.start)} → ${fmt(s.end)}</div></div></div>`).join('') || '<div class="hint">자막이 없습니다.</div>'}
        <div class="sty"><span>크기</span><div class="sl"><input type="range" data-sty="size" value="${st.size}" min="10" max="200"><input type="number" data-sty="size" value="${st.size}" min="10" max="200"></div>
        <span>글자색</span><input type="color" data-sty="color" value="${st.color}"><span>테두리색</span><input type="color" data-sty="outline" value="${st.outline}">
        <span>위치</span><select data-sty="pos">${[['bottom', '아래'], ['middle', '가운데'], ['top', '위']].map(([k, n]) => `<option value="${k}" ${st.pos === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="hint" style="padding-bottom:0"><b>자막 공통 연출</b> (자막마다 따로 바꾸려면 자막을 선택하세요)</div>${fxHtml(st.fx, 'data-sfx')}`;
    } else {
      b.innerHTML = `<div class="btns"><button data-act="addText">＋ 현재 위치에 글자</button></div><div class="hint" style="padding-top:0">글자를 선택하면 오른쪽에서 연출을 고르고, 미리보기에서 끌어 위치/크기를 바꿀 수 있습니다.</div>
        ${P.texts.map(s => `<div class="row srow ${multi.has(s.id) ? 'on' : ''}" data-sel="text" data-id="${s.id}"><div style="min-width:0"><div class="t">${esc(s.text)}</div><div class="m">${fmt(s.start)} → ${fmt(s.end)}</div></div></div>`).join('') || '<div class="hint">글자가 없습니다.</div>'}`;
    }
  }
  async function onLeftClick(e) {
    const row = e.target.closest('[data-add]');
    if (row) { row.dataset.add === 'video' ? addClip(row.dataset.src) : addAudio(row.dataset.src); return; }
    const s = e.target.closest('[data-sel]');
    if (s) { const o = find(s.dataset.sel, s.dataset.id); if (o) { setSel([{type: s.dataset.sel, o}]); seek(o.start); } renderAll(); return; }
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'addSub') addSub();
    else if (a === 'addText') addText();
    else if (a === 'srtIn') $('#edSrtFile').click();
    else if (a === 'srtOut') exportSrt();
    else if (a === 'shapeRect') addSolid('rect');
    else if (a === 'shapeEllipse') addSolid('ellipse');
    else if (a === 'shapeBg') addSolid('bg');
    else if (e.target.id === 'edUp') $('#edUpFile').click();
    else if (e.target.id === 'edImg') $('#edImgFile').click();
    else if (e.target.id === 'edRec') toggleRec();
  }
  document.addEventListener('change', async e => {
    if (e.target.id === 'edImgFile' && e.target.files[0]) {
      try { say('불러오는 중…'); const f = e.target.files[0]; const r = await fetch('/api/edit/asset?name=' + encodeURIComponent(f.name), {method: 'POST', body: f}); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.detail || '불러오지 못했습니다.'); if (!j.is_image) throw new Error('이미지 파일이 아닙니다.'); info[j.src] = j; assets.push(j); renderLeft(); await addClip(j.src); }
      catch (x) { say(x.message, true); }
      e.target.value = '';
    } else if (e.target.id === 'edUpFile' && e.target.files[0]) {
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
  const fxSel = (key, opts, cur, attr) => `<select ${attr}="${key}">${opts.map(([v, n]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  function fxHtml(fx, attr) {   // attr: 'data-fx' (선택한 항목) / 'data-sfx' (자막 공통)
    const sl = (key, lo, hi, st, val, pct) => `<div class="sl"><input type="range" ${attr}="${key}" data-fxt="${pct ? 'p' : 'n'}" min="${lo}" max="${hi}" step="${st}" value="${pct ? Math.round(val * 100) : val}"><input type="number" ${attr}="${key}" data-fxt="${pct ? 'p' : 'n'}" step="${st}" value="${pct ? Math.round(val * 100) : val}"></div>`;
    return `<div class="f fxf"><label>등장</label>${fxSel('in', FX_IN, fx.in, attr)}
      <label>등장 시간(초)</label>${sl('in_dur', 0.1, 3, 0.1, fx.in_dur)}
      <label>퇴장</label>${fxSel('out', [['none', '없음'], ['fade', '페이드']], fx.out, attr)}
      <label>퇴장 시간(초)</label>${sl('out_dur', 0.1, 3, 0.1, fx.out_dur)}
      <label>움직임</label>${fxSel('loop', FX_LOOP, fx.loop, attr)}
      <label>노래방 채우기</label><span><input type="checkbox" ${attr}="kara" ${fx.kara ? 'checked' : ''}> <input type="color" ${attr}="kara_color" value="${fx.kara_color}"></span>
      <label>배경 박스</label><span><input type="checkbox" ${attr}="box" ${fx.box ? 'checked' : ''}> <input type="color" ${attr}="box_color" value="${fx.box_color}"></span>
      <label>박스 진하기(%)</label>${sl('box_opacity', 0, 100, 5, fx.box_opacity, true)}</div>
      <div class="note" style="margin-top:4px">흐르는 자막은 길이가 길수록 천천히 흐릅니다. 타이핑은 등장 시간 동안 글자가 차례로 나타납니다.</div>`;
  }
  function fxValue(el) {
    return el.type === 'checkbox' ? el.checked : el.dataset.fxt === 'p' ? num(el.value) / 100 : el.dataset.fxt === 'n' ? num(el.value) : el.value;
  }
  function fxInput(el, scope, e) {
    const key = el.dataset.fx || el.dataset.sfx, val = fxValue(el);
    if (scope === 'item') {
      const o = selObj(); if (!o) return;
      mutate(() => { if (!o.fx) o.fx = {...FX0S(), ...P.sub_style.fx}; o.fx[key] = val; }, e.type === 'change' || el.tagName === 'SELECT', 'fx' + key);
      if (e.type === 'change') renderProps();
    } else {
      mutate(() => { P.sub_style.fx[key] = val; }, false, 'sfx' + key);
    }
  }
  function onStyleInput(e) {
    if (e.target.dataset.shapecolor !== undefined) { shapeColor = e.target.value; return; }
    const sw = e.target.closest('.sl'); if (sw) for (const o2 of sw.querySelectorAll('input')) if (o2 !== e.target) o2.value = e.target.value;
    if (e.target.dataset.sfx) { fxInput(e.target, 'style', e); return; }
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
  const LAYER = [['x', '가로 위치(%)', 'p'], ['y', '세로 위치(%)', 'p'], ['scale', '크기(%)', 'p'], ['opacity', '투명도(%)', 'p'], ['angle', '회전(°)', 'n']];
  const EFFECTS = [['fit', '화면 맞춤', 's'], ['rotate', '회전', 's'], ['flip_h', '좌우 반전', 'b'], ['flip_v', '상하 반전', 'b'], ['brightness', '밝기(%)', 'p'], ['contrast', '대비(%)', 'p'], ['saturation', '채도(%)', 'p'], ['gray', '흑백', 'b'], ['blur', '흐림(0~30)', 'n']];
  const OPTS = {
    'solid.shape': [['rect', '사각형'], ['ellipse', '원/타원']],
    fit: [['', '프로젝트 설정 따름'], ['contain', '화면 안에 맞춤 (검은 띠)'], ['cover', '화면 가득 채움 (넘치는 곳 잘림)']],
    rotate: [['0', '없음'], ['90', '90° 시계방향'], ['180', '180°'], ['270', '270°']],
  };
  const FIELDS = {
    clip: [['start', '시작 위치(초)', 'n'], ['in', '원본 시작(초)', 'n'], ['out', '원본 끝(초)', 'n'], ['speed', '속도(배)', 'n'], ['volume', '볼륨(%)', 'p'], ['mute', '소리 끄기', 'b'], ...LAYER, ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n'], ...EFFECTS, ['reverse', '역재생 (120초 이하, 미리보기는 정방향)', 'b']],
    freeze: [['start', '시작 위치(초)', 'n'], ['hold', '멈춘 시간(초)', 'n'], ...LAYER, ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n'], ...EFFECTS],
    image: [['start', '시작 위치(초)', 'n'], ['hold', '표시 시간(초)', 'n'], ...LAYER, ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n'], ...EFFECTS],
    solid: [['start', '시작 위치(초)', 'n'], ['hold', '표시 시간(초)', 'n'], ['solid.color', '색', 'c'], ['solid.shape', '모양', 's'], ['solid.w', '가로 크기(%)', 'p'], ['solid.h', '세로 크기(%)', 'p'], ...LAYER, ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n']],
    audio: [['start', '시작 위치(초)', 'n'], ['in', '원본 시작(초)', 'n'], ['out', '원본 끝(초, 0=끝까지)', 'n'], ['speed', '속도(배)', 'n'], ['volume', '볼륨(%)', 'p'], ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n'], ['duck', '더킹(다른 소리가 나올 때 자동으로 작게)', 'b'], ['duck_level', '더킹 중 음량(%)', 'p']],
    sub: [['start', '시작(초)', 'n'], ['end', '끝(초)', 'n'], ['text', '내용', 't']],
    text: [['start', '시작(초)', 'n'], ['end', '끝(초)', 'n'], ['text', '내용', 't'], ['size', '크기', 'n'], ['color', '색', 'c'], ['x', '가로 위치(%)', 'p'], ['y', '세로 위치(%)', 'p']],
  };
  const TITLES = {clip: '영상 클립', freeze: '정지 화면', image: '이미지', solid: '도형', audio: '오디오', sub: '자막', text: '글자'};
  const getv = (o, k) => (k.includes('.') ? k.split('.').reduce((a, b) => a?.[b], o) : o[k]);
  const setv = (o, k, v) => { if (k.includes('.')) { const [a, b] = k.split('.'); o[a][b] = v; } else o[k] = v; };
  const RANGES = {volume: [0, 200, 5], opacity: [0, 100, 1], scale: [5, 300, 1], x: [-50, 150, 1], y: [-50, 150, 1], brightness: [-100, 100, 1], contrast: [0, 300, 5], saturation: [0, 300, 5], blur: [0, 30, 0.5],
    fade_in: [0, 5, 0.1], fade_out: [0, 5, 0.1], speed: [0.25, 4, 0.25], duck_level: [0, 100, 5], 'solid.w': [1, 100, 1], 'solid.h': [1, 100, 1], angle: [-180, 180, 1], size: [10, 200, 1]};
  function fieldHtml(k, label, type, v) {
    let inp;
    const rg = RANGES[k];
    if (rg && (type === 'n' || type === 'p')) {
      const dv = type === 'p' ? Math.round(v * 100) : +(+v).toFixed(3), st = type === 'n' && k !== 'speed' ? 0.1 : 5;
      return `<label>${label}</label><div class="sl"><input type="range" min="${rg[0]}" max="${rg[1]}" step="${rg[2]}" data-k="${k}" data-t="${type}" value="${dv}"><input type="number" step="${rg[2] < 1 ? rg[2] : st}" data-k="${k}" data-t="${type}" value="${dv}"></div>`;
    }
    if (type === 'n') inp = `<input type="number" step="${k === 'speed' ? 0.25 : 0.1}" data-k="${k}" data-t="n" value="${+(+v).toFixed(3)}">`;
    else if (type === 'p') inp = `<input type="number" step="5" data-k="${k}" data-t="p" value="${Math.round(v * 100)}">`;
    else if (type === 'b') inp = `<input type="checkbox" data-k="${k}" data-t="b" ${v ? 'checked' : ''}>`;
    else if (type === 'c') inp = `<input type="color" data-k="${k}" data-t="c" value="${v}">`;
    else if (type === 's') inp = `<select data-k="${k}" data-t="s">${(OPTS[k] || []).map(([ov, on]) => `<option value="${ov}" ${String(v ?? '') === ov ? 'selected' : ''}>${on}</option>`).join('')}</select>`;
    else inp = `<textarea data-k="${k}" data-t="t">${esc(v)}</textarea>`;
    return type === 't' ? `<div style="margin:6px 0"><div style="font-size:12px;margin-bottom:3px">${label}</div>${inp}</div>` : `<label>${label}</label>${inp}`;
  }
  function renderProps() {
    const o = selObj();
    if (multi.size > 1) {
      R.props.innerHTML = `<h4>${multi.size}개 선택됨</h4><p class="note">끌면 함께 이동하고, 삭제/복사/복제도 한꺼번에 됩니다.<br>Shift나 Ctrl을 누르고 누르면 하나씩 추가/해제, 빈 곳을 끌면 상자로 선택합니다.</p>
        <div class="acts"><button data-do="del">삭제</button><button data-do="rip">당겨서 삭제</button><button data-do="copy">복사</button><button data-do="dup">복제</button><button data-do="group">묶기</button><button data-do="ungroup">풀기</button><button data-do="proppaste">속성 붙여넣기</button></div>`;
      return;
    }
    if (!o) {
      R.props.innerHTML = `<h4>프로젝트</h4><div class="f"><label>화면 비율</label><select data-proj="aspect">${[['original', '원본 그대로'], ['16:9', '16:9 가로'], ['9:16', '9:16 세로(쇼츠)'], ['1:1', '1:1 정사각']].map(([k, n]) => `<option value="${k}" ${P.output.aspect === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="f"><label>화면 가득 채우기</label><input type="checkbox" data-proj="fill" ${P.output.fill ? 'checked' : ''}></div>
        <div class="f"><label>음량 평준화</label><input type="checkbox" data-proj="loudnorm" ${P.output.loudnorm ? 'checked' : ''}></div>
        <p class="note">화면 가득 채우기: 비율을 바꿨을 때 검은 띠 없이 영상으로 꽉 채웁니다(넘치는 부분은 잘림, 클립의 위치로 조절).<br>총 길이 ${fmt(total())} · 영상 ${P.clips.length}개 · 오디오 ${P.audios.length}개 · 자막 ${P.subs.length}개<br>타임라인에서 항목을 누르면 세부 설정이 나옵니다.<br>비율이 원본과 다르면 남는 곳은 검은색으로 채웁니다. 위쪽 영상 줄이 아래쪽 줄 위에 겹쳐 보입니다.<br>음량 평준화: 내보낼 때 전체 소리 크기를 일정하게 맞춥니다.</p>
        <h4 style="margin-top:12px">표지 (mp4 대표 화면)</h4>
        <div class="note" style="margin-top:0">${P.output.cover_t != null ? fmt(P.output.cover_t) + ' 화면' : '지정 안 됨'} <button data-do="coverclear" style="padding:2px 8px;font-size:12px">해제</button></div>
        <h4 style="margin-top:12px">반복 구간 (I / O 키)</h4>
        <div class="note" style="margin-top:0">${P.range?.in != null || P.range?.out != null ? `${P.range.in != null ? fmt(P.range.in) : '—'} ~ ${P.range.out != null ? fmt(P.range.out) : '—'}` : '지정 안 됨'} <button data-do="clearrange" style="padding:2px 8px;font-size:12px">해제</button></div>
        <h4 style="margin-top:12px">마커 (M 키)</h4>
        ${(P.markers || []).map(m => `<div class="mkrow"><button data-mkgo="${m.id}" title="이동">${fmt(m.t)}</button><input type="text" data-mklabel="${m.id}" value="${esc(m.label)}"><button data-mkdel="${m.id}" title="삭제">✕</button></div>`).join('') || '<div class="note" style="margin-top:0">재생선 위치에서 M 을 누르면 표시됩니다.</div>'}`;
      return;
    }
    const kind = sel.type === 'clip' ? (o.solid ? 'solid' : o.image ? 'image' : o.freeze ? 'freeze' : 'clip') : sel.type;
    let extra = '';
    if (sel.type === 'clip') {
      const ov = overlapIn(o), p = prevClip(o);
      extra = `<h4 style="margin-top:12px">장면 전환</h4><div class="f"><label>종류</label><select data-trans="type">${TRANS.map(([k, n]) => `<option value="${k}" ${(o.trans?.type || '') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <label>길이(초)</label><input type="number" step="0.1" min="0.1" data-trans="dur" value="${(o.trans ? ov : 0.5).toFixed(2)}" ${o.trans ? '' : 'disabled'}></div>
        <div class="note" style="margin-top:4px">${p ? '앞 클립과 겹친 길이가 전환 길이입니다.' : '같은 줄 앞에 클립이 있어야 전환을 넣을 수 있습니다.'}</div>
        <div class="acts">${o.freeze ? '' : '<button data-do="setIn">현재 위치를 시작으로</button><button data-do="setOut">현재 위치를 끝으로</button><button data-do="detach">소리 분리</button>'}<button data-do="link">🔗 연결</button><button data-do="unlink">연결 해제</button><button data-do="propcopy">속성 복사</button><button data-do="proppaste">속성 붙여넣기</button></div>
        <div class="note">${o.freeze ? '' : `원본 길이 ${fmt(info[o.src]?.duration || 0)} · `}${esc(nameOf(o.src))}</div>`;
    }
    if (sel.type === 'sub') extra = `<h4 style="margin-top:12px">연출</h4>${o.fx ? fxHtml(o.fx, 'data-fx') + '<div class="acts"><button data-do="fxdefault">공통 연출 따르기</button></div>' : '<div class="note" style="margin-top:0">자막 탭의 공통 연출을 따릅니다. (현재: 등장 ' + esc(FX_IN.find(x => x[0] === P.sub_style.fx.in)?.[1] || '없음') + ')</div><div class="acts"><button data-do="fxown">이 자막만 따로 연출</button></div>'}`;
    if (sel.type === 'text') extra = `<h4 style="margin-top:12px">연출</h4>${fxHtml(o.fx || FX0S(), 'data-fx')}`;
    if (sel.type === 'audio') extra = `<div class="acts"><button data-do="link">🔗 영상과 연결</button><button data-do="unlink">연결 해제</button></div><div class="note">${esc(nameOf(o.src))} · 원본 길이 ${fmt(info[o.src]?.duration || 0)}${o.link ? '<br>🔗 영상 클립과 연결됨(같이 움직임)' : '<br>연결 안 됨 (따로 움직임)'}</div>`;
    const kvNow = sel.type === 'clip' ? kfEval(o, T) : null;
    const kfHtml = sel.type === 'clip' ? `<h4 style="margin-top:12px">키프레임 (움직임/크기/투명도 변화)</h4>
      <div class="acts" style="margin-top:0"><button data-do="kfadd">◆ 현재 위치에 키프레임</button><button data-do="kfclear">모두 지우기</button></div>
      ${(o.kf || []).map(k => `<div class="mkrow"><button data-kfgo="${k.t}">◆ ${k.t.toFixed(2)}초</button><span class="note" style="flex:1;margin:0">${Math.round(k.x * 100)},${Math.round(k.y * 100)} · ${Math.round(k.scale * 100)}% · ${Math.round(k.opacity * 100)}%</span><button data-kfdel="${k.t}">✕</button></div>`).join('') || '<div class="note" style="margin-top:4px">없음. 키프레임이 2개 이상이면 그 사이를 부드럽게 움직입니다. (투명도 키프레임은 내보내기가 느려질 수 있습니다)</div>'}` : '';
    R.props.innerHTML = `<h4>${TITLES[kind]}</h4><div class="f">${FIELDS[kind].map(([k, l, t]) => fieldHtml(k, l, t, kvNow && KFKEYS.includes(k) ? kvNow[k] : getv(o, k))).join('')}</div>${kfHtml}${extra}
      <div class="acts"><button data-do="del">삭제</button>${kindOf(sel.type) ? '<button data-do="rip">당겨서 삭제</button>' : ''}<button data-do="dup">복제</button></div>`;
  }
  function onPropInput(e) {
    const el = e.target;
    const slw = el.closest('.sl'); if (slw) for (const o2 of slw.querySelectorAll('input')) if (o2 !== el) o2.value = el.value;
    if (el.dataset.fx) { fxInput(el, 'item', e); return; }
    if (el.dataset.proj) { if (el.type === 'checkbox' && e.type === 'input') return; mutate(() => { P.output[el.dataset.proj] = el.type === 'checkbox' ? el.checked : el.value; }); return; }
    if (el.dataset.mklabel) { const m = P.markers.find(x => x.id === el.dataset.mklabel); if (m) mutate(() => { m.label = el.value; }, false, 'mk' + m.id); return; }
    const o = selObj();
    if (el.dataset.trans && o) {
      if (e.type !== 'change') return;
      const type = el.dataset.trans === 'type' ? el.value : (o.trans?.type || '');
      setTransition(o, type, el.dataset.trans === 'dur' ? num(el.value, 0.5) : undefined); renderProps(); return;
    }
    const k = el.dataset.k; if (!o || !k) return;
    if (e.type === 'input' && (el.dataset.t === 'b' || el.dataset.t === 's')) return;
    if (sel.type === 'clip' && o.kf?.length && KFKEYS.includes(k) && el.value !== '') {   // 키프레임이 있으면 현재 위치의 키프레임 값을 바꾼다
      const raw = num(el.value) / 100, cur = kfEval(o, T); cur[k] = k === 'scale' ? clamp(raw, 0.05, 5) : k === 'opacity' ? clamp(raw, 0, 1) : raw;
      mutate(() => upsertKf(o, cur), e.type === 'change', 'kf' + k); if (e.type === 'change') renderProps(); return;
    }
    let v = el.dataset.t === 'n' ? num(el.value) : el.dataset.t === 'p' ? num(el.value) / 100 : el.dataset.t === 'b' ? el.checked : el.value;
    if (k === 'rotate') v = +v; if (k === 'fit') v = v || null;
    if (el.dataset.t === 'n' && el.value === '') return;
    const oldStart = o.start;
    mutate(() => {
      setv(o, k, v);
      if (sel.type === 'clip' && o.solid) { o.solid.w = clamp(o.solid.w, 0.01, 1); o.solid.h = clamp(o.solid.h, 0.01, 1); }
      if (sel.type === 'clip') {
        o.blur = clamp(o.blur || 0, 0, 30); o.contrast = clamp(o.contrast ?? 1, 0, 3); o.saturation = clamp(o.saturation ?? 1, 0, 3); o.brightness = clamp(o.brightness || 0, -1, 1);
        const d = info[o.src]?.duration || o.out;
        o.speed = clamp(o.speed, 0.25, 4); o.out = clamp(o.out, 0.05, d); o.in = clamp(o.in, 0, o.out - 0.05); o.volume = clamp(o.volume, 0, 4);
        o.scale = clamp(o.scale, 0.05, 5); o.opacity = clamp(o.opacity, 0, 1); o.start = Math.max(0, o.start); o.hold = clamp(o.hold, 0.1, 600);
      } else if (sel.type === 'sub' || sel.type === 'text') { o.start = Math.max(0, o.start); if (o.end <= o.start) o.end = o.start + 0.1; }
      else if (sel.type === 'audio') { o.start = Math.max(0, o.start); o.in = Math.max(0, o.in); o.out = Math.max(0, o.out); o.volume = clamp(o.volume, 0, 4); o.speed = clamp(o.speed, 0.25, 4); o.duck_level = clamp(o.duck_level, 0, 1); }
      if (k === 'start' && o.link) for (const x of [...P.clips, ...P.audios]) if (x !== o && x.link === o.link) x.start = Math.max(0, x.start + (o.start - oldStart));
    }, e.type === 'change', 'p' + k);
    if (e.type === 'change') renderProps();
  }
  function onPropClick(e) {
    if (e.target.dataset.mkgo) { const m = P.markers.find(x => x.id === e.target.dataset.mkgo); if (m) { pause(); seek(m.t); } return; }
    if (e.target.dataset.kfgo !== undefined) { const c = selObj(); if (c) { pause(); seek(c.start + +e.target.dataset.kfgo); } return; }
    if (e.target.dataset.kfdel !== undefined) { const c = selObj(); if (c) { mutate(() => { c.kf = (c.kf || []).filter(k => Math.abs(k.t - +e.target.dataset.kfdel) > 0.001); }); renderProps(); } return; }
    if (e.target.dataset.mkdel) { delMarker(e.target.dataset.mkdel); return; }
    const d = e.target.dataset.do; if (!d) return;
    if (d === 'coverclear') { mutate(() => { P.output.cover_t = null; }); return; }
    if (d === 'kfadd') { addKf(); return; }
    if (d === 'kfclear') { const c = selObj(); if (c) { mutate(() => { c.kf = []; }); renderProps(); } return; }
    if (d === 'clearrange') { clearRange(); renderProps(); return; }
    if (d === 'propcopy') { copyProps(); return; }
    if (d === 'proppaste') { pasteProps(); return; }
    if (d === 'group') { groupSel(); return; }
    if (d === 'ungroup') { ungroupSel(); return; }
    if (d === 'del') { removeSelected(false); return; }
    if (d === 'rip') { removeSelected(true); return; }
    if (d === 'copy') { copySel(); return; }
    if (d === 'dup') { duplicateSel(); return; }
    if (d === 'detach') { detachAudio(); return; }
    if (d === 'fxown') { const o = selObj(); if (o) { mutate(() => { o.fx = {...FX0S(), ...P.sub_style.fx}; }); renderProps(); } return; }
    if (d === 'fxdefault') { const o = selObj(); if (o) { mutate(() => { o.fx = null; }); renderProps(); } return; }
    if (d === 'link') { linkSel(); return; }
    if (d === 'unlink') { unlinkSel(); return; }
    const o = selObj(); if (!o || sel.type !== 'clip' || o.freeze) return;
    if (T < o.start || T > cend(o)) { say('재생선을 이 클립 위에 놓아 주세요.', true); return; }
    const at = o.in + (T - o.start) * o.speed;
    if (d === 'setIn' && at < o.out - 0.05) mutate(() => { const ds = (at - o.in) / o.speed; o.in = at; o.start += ds; });
    else if (d === 'setOut' && at > o.in + 0.05) mutate(() => { o.out = at; });
  }

  /* 미리보기 */
  function aspectRatio() {
    const a = P.output.aspect;
    if (a === '16:9') return 16 / 9; if (a === '9:16') return 9 / 16; if (a === '1:1') return 1;
    const f = [...P.clips].filter(c => !c.solid && !c.image).sort((x, y) => x.start - y.start)[0], i = f && info[f.src]; return i?.width && i?.height ? i.width / i.height : 16 / 9;
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
  const ease = u => 1 + 2.70158 * Math.pow(u - 1, 3) + 1.70158 * Math.pow(u - 1, 2);   // easeOutBack
  const twEst = (text, size) => Math.max(...text.split('\n').map(l => [...l].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? size : size * 0.55), 0)), 0);
  function fxView(it, fx, k, SW, SH, size) {
    const d = Math.max(it.end - it.start, 0.05), rel = T - it.start, left = it.end - T;
    const inD = Math.min(fx.in_dur, d), pi = fx.in === 'none' ? 1 : clamp(rel / inD, 0, 1);
    const po = fx.out === 'fade' ? clamp(left / Math.min(fx.out_dur, d), 0, 1) : 1;
    let op = po, tr = '', blur = 0, text = it.text;
    const mq = fx.loop.startsWith('marquee');
    if (!mq) {
      if (fx.in === 'fade') op *= pi;
      else if (fx.in === 'pop') tr += ` scale(${0.45 + 0.55 * ease(pi) * 1.0})`;
      else if (fx.in === 'zoom') { op *= pi; tr += ` scale(${2.3 - 1.3 * pi})`; }
      else if (fx.in === 'blur') blur = (1 - pi) * 12 * k;
      else if (fx.in.startsWith('slide')) { const q = 1 - pi, dx = {l: -SW * 0.45, r: SW * 0.45, u: 0, d: 0}[fx.in.slice(6)], dy = {l: 0, r: 0, u: -SH * 0.3, d: SH * 0.3}[fx.in.slice(6)]; tr += ` translate(${dx * q}px,${dy * q}px)`; }
    }
    if (fx.loop === 'shake') tr += ` rotate(${Math.sin(T * 45) * 2.2}deg)`;
    if (fx.loop === 'float') tr += ` translateY(${Math.sin(T * 3) * 5 * k}px) rotate(${Math.sin(T * 3) * 1.4}deg)`;
    let html = esc(text);
    if (fx.in === 'typing' && !mq) {
      const chars = [...text], vis = chars.filter(ch => ch !== ' ' && ch !== '\n').length, n = Math.floor(vis * pi + 1e-6);
      let seen = 0, cut = 0; for (let i = 0; i < chars.length; i++) { if (chars[i] !== ' ' && chars[i] !== '\n') seen++; if (seen >= Math.max(n, 1)) { cut = i + 1; break; } }
      if (n === 0) cut = 0;
      html = esc(chars.slice(0, cut).join('')) + `<span style="opacity:0">${esc(chars.slice(cut).join(''))}</span>`;
    } else if (fx.kara) {
      const chars = [...text], vis = chars.filter(ch => ch !== '\n').length, fill = clamp(rel / (d * 0.85), 0, 1) * vis; let ci = 0;
      html = chars.map(ch => (ch === '\n' ? '\n' : `<span style="color:${ci++ < fill ? fx.kara_color : 'inherit'}">${esc(ch)}</span>`)).join('');
    }
    const box = fx.box ? `background:rgba(${parseInt(fx.box_color.slice(1, 3), 16)},${parseInt(fx.box_color.slice(3, 5), 16)},${parseInt(fx.box_color.slice(5, 7), 16)},${fx.box_opacity});padding:${6 * k}px ${14 * k}px;text-shadow:none;` : '';
    return {op, tr, blur, html, box, mq, mx: mq ? (fx.loop === 'marquee-l' ? SW + (-twEst(text, size) - SW) * clamp(rel / d, 0, 1) : -twEst(text, size) + (SW + twEst(text, size)) * clamp(rel / d, 0, 1)) : 0};
  }
  function renderOv() {
    const st = P.sub_style, k = parseFloat(R.stage.style.getPropertyValue('--k')) || .4, SW = R.stage.clientWidth, SH = R.stage.clientHeight;
    const subs = P.subs.filter(s => T >= s.start && T < s.end).map(s => {
      const fx = s.fx || st.fx, v = fxView(s, fx, k, SW, SH, st.size * k), pos = st.pos === 'top' ? 'top:6%' : st.pos === 'middle' ? 'top:50%' : 'bottom:6%';
      const base = st.pos === 'middle' ? ' translateY(-50%)' : '';
      const place = v.mq ? `left:0;right:auto;white-space:nowrap;transform:translateX(${v.mx}px)${base}` : `left:0;right:0;margin:0 auto;width:fit-content;max-width:90%;transform:${(base + v.tr).trim() || 'none'}`;
      const shadow = fx.box ? '' : `text-shadow:0 0 ${3 * k}px ${st.outline},0 0 ${3 * k}px ${st.outline},0 0 ${3 * k}px ${st.outline};`;
      return `<div class="sub" style="${pos};${place};opacity:${v.op};filter:blur(${v.blur}px);font-size:${st.size * k}px;color:${st.color};${shadow}${v.box}">${v.html}</div>`;
    });
    const txts = P.texts.filter(s => T >= s.start && T < s.end).map(s => {
      const fx = s.fx || FX0S(), v = fxView(s, fx, k, SW, SH, s.size * k);
      const place = v.mq ? `left:0;top:${s.y * 100}%;transform:translate(${v.mx}px,-50%)` : `left:${s.x * 100}%;top:${s.y * 100}%;transform:translate(-50%,-50%)${v.tr}`;
      return `<div class="txt" data-oid="${s.id}" data-otype="text" style="${place};opacity:${v.op};filter:blur(${v.blur}px);font-size:${s.size * k}px;color:${s.color};${v.box}">${v.html}</div>`;
    });
    R.ov.innerHTML = subs.join('') + txts.join('');
    renderBox();
  }
  /* ---- 미리보기 손잡이: 끌어서 이동, 모서리로 크기, 위쪽 동그라미로 회전 ---- */
  function boxOfClip(c) {
    const SW = R.stage.clientWidth, SH = R.stage.clientHeight, kv = kfEval(c, T);
    let bw, bh;
    if (c.solid) { bw = c.solid.w * SW * kv.scale; bh = c.solid.h * SH * kv.scale; }
    else {
      const i = info[c.src]; let w0 = i?.width || SW, h0 = i?.height || SH; if ((c.rotate || 0) % 180) [w0, h0] = [h0, w0];
      const sa = w0 / h0, fa = SW / SH, cover = (c.fit || (P.output.fill && !c.image ? 'cover' : 'contain')) === 'cover';
      let cw, ch; if ((sa > fa) !== cover) { cw = SW; ch = SW / sa; } else { ch = SH; cw = SH * sa; }
      bw = cw * kv.scale; bh = ch * kv.scale;
    }
    return {cx: kv.x * SW, cy: kv.y * SH, w: bw, h: bh, rot: c.angle || 0};
  }
  function boxTarget() {
    const o = multi.size === 1 ? selObj() : null; if (!o || !sel) return null;
    if (sel.type === 'clip') { if (T < o.start || T >= cend(o) || P.tracks.v[o.track]?.hide) return null; return {type: 'clip', o, ...boxOfClip(o)}; }
    if (sel.type === 'text') {
      if (T < o.start || T >= o.end) return null;
      const el = R.ov.querySelector(`[data-oid="${o.id}"]`); if (!el) return null;
      const r = el.getBoundingClientRect(), s0 = R.stage.getBoundingClientRect();
      return {type: 'text', o, cx: r.left - s0.left + r.width / 2, cy: r.top - s0.top + r.height / 2, w: r.width, h: r.height, rot: 0};
    }
    return null;
  }
  function renderBox() {
    const b = $('#edBox'); if (!b) return;
    const t = playing ? null : boxTarget();
    if (!t) { b.hidden = true; return; }
    b.hidden = false;
    Object.assign(b.style, {left: t.cx - t.w / 2 + 'px', top: t.cy - t.h / 2 + 'px', width: t.w + 'px', height: t.h + 'px', transform: `rotate(${t.rot}deg)`});
    b.dataset.kind = t.type === 'clip' && t.o.solid ? 'solid' : t.type;
  }
  function boxDown(e, mode) {
    e.preventDefault(); e.stopPropagation(); pause();
    const t = boxTarget(); if (!t) return;
    const o = t.o, sr = R.stage.getBoundingClientRect(), SW = sr.width, SH = sr.height, gv = $('#edGv'), gh = $('#edGh');
    const pt = ev => ({x: ev.clientX - sr.left, y: ev.clientY - sr.top}), p0 = pt(e), before = JSON.stringify(P);
    const kv0 = t.type === 'clip' ? kfEval(o, T) : null;
    const orig = t.type === 'clip' ? {x: kv0.x, y: kv0.y, scale: kv0.scale, opacity: kv0.opacity, sw: o.solid?.w, sh: o.solid?.h} : {x: o.x, y: o.y, size: o.size};
    const ang = t.rot * Math.PI / 180, loc = p => { const dx = p.x - t.cx, dy = p.y - t.cy; return {x: dx * Math.cos(-ang) - dy * Math.sin(-ang), y: dx * Math.sin(-ang) + dy * Math.cos(-ang)}; };
    const d0 = Math.hypot(loc(p0).x, loc(p0).y) || 1;
    const mv = ev => {
      const p = pt(ev), dx = p.x - p0.x, dy = p.y - p0.y, ratio = Math.hypot(loc(p).x, loc(p).y) / d0;
      let nx = t.cx + dx, ny = t.cy + dy; gv.hidden = gh.hidden = true;
      if (mode === 'move') {
        if (Math.abs(nx - SW / 2) < 7) { nx = SW / 2; gv.hidden = false; }
        if (Math.abs(ny - SH / 2) < 7) { ny = SH / 2; gh.hidden = false; }
      }
      if (t.type === 'clip') {
        const cur = {x: orig.x, y: orig.y, scale: orig.scale, opacity: orig.opacity};
        if (mode === 'move') { cur.x = nx / SW; cur.y = ny / SH; }
        else if (mode === 'rot') { let a = Math.atan2(p.y - t.cy, p.x - t.cx) * 180 / Math.PI + 90; if (ev.shiftKey) a = Math.round(a / 15) * 15; o.angle = +(((a + 540) % 360) - 180).toFixed(1); }
        else if (o.solid && mode.length === 1) { const l = loc(p); if (mode === 'e' || mode === 'w') o.solid.w = clamp(2 * Math.abs(l.x) / (SW * orig.scale), 0.01, 1); else o.solid.h = clamp(2 * Math.abs(l.y) / (SH * orig.scale), 0.01, 1); }
        else if (mode.length === 2) cur.scale = clamp(orig.scale * ratio, 0.05, 5);
        if (mode === 'move' || mode.length === 2) { if (o.kf?.length) upsertKf(o, cur); else { o.x = cur.x; o.y = cur.y; o.scale = cur.scale; } }
      } else if (mode === 'move') { o.x = clamp(nx / SW, 0, 1); o.y = clamp(ny / SH, 0, 1); }
      else if (mode.length === 2) o.size = clamp(Math.round(orig.size * ratio), 10, 300);
      syncPreview(true); renderOv();
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); gv.hidden = gh.hidden = true;
      if (JSON.stringify(P) !== before) { undo.push(before); if (undo.length > 100) undo.shift(); redo = []; lastKey = ''; queueSave(); }
      renderAll();
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }
  function stageDown(e) {
    if (e.button !== 0 || e.target.closest('#edBox')) return;
    const sr = R.stage.getBoundingClientRect();
    let hit = null;
    for (const el of [...R.ov.querySelectorAll('[data-oid]')].reverse()) {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { const o = find('text', el.dataset.oid); if (o && !locked('text', o)) { hit = {type: 'text', o}; break; } }
    }
    if (!hit) {
      for (const c of layers().reverse()) {
        if (T < c.start || T >= cend(c) || P.tracks.v[c.track]?.hide || locked('clip', c)) continue;
        const b = boxOfClip(c), a = -b.rot * Math.PI / 180, dx = e.clientX - sr.left - b.cx, dy = e.clientY - sr.top - b.cy;
        const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) { hit = {type: 'clip', o: c}; break; }
      }
    }
    if (!hit) { if (sel || multi.size) { clearSel(); renderAll(); } return; }
    if (!multi.has(hit.o.id) || multi.size !== 1) { setSel([hit]); renderAll(); }
    boxDown(e, 'move');
  }
  const renderTime = () => { R.time.textContent = `${fmt(T)} / ${fmt(total())}`; };

  /* 타임라인 */
  const LANE_H = {v: 56, a: 48, s: 34, x: 34};
  function laneList() {
    const rows = [];
    for (let i = P.tracks.v.length - 1; i >= 0; i--) rows.push({kind: 'v', idx: i, label: 'V' + (i + 1)});
    for (let i = 0; i < P.tracks.a.length; i++) rows.push({kind: 'a', idx: i, label: 'A' + (i + 1)});
    rows.push({kind: 's', idx: 0, label: '자막'}, {kind: 'x', idx: 0, label: '글자'});
    return rows;
  }
  function renderTimeline() {
    const end = Math.max(total(), ...P.audios.map(a => a.start + adur(a)), ...P.subs.map(s => s.end), ...P.texts.map(s => s.end), 0) + 8;
    R.inner.style.width = Math.max(OFF + end * pps, R.scroll.clientWidth) + 'px';
    const step = pps >= 100 ? 1 : pps >= 50 ? 2 : pps >= 25 ? 5 : pps >= 12 ? 10 : 30;
    let ruler = '';
    for (let t = 0; t < end; t += step) ruler += `<b style="left:${OFF + t * pps}px">${fmt(t).slice(0, 5)}</b>`;
    const blk = (type, o, label, extra = '') => {
      const left = OFF + o.start * pps, width = Math.max(dur(type, o) * pps, 14);
      let inner = '', cls = '';
      if (type === 'clip' && o.trans) { const ov = overlapIn(o); if (ov > 0) inner += `<u class="trn" style="width:${ov * pps}px" title="전환"></u>`; }
      if (type === 'audio') inner += `<canvas class="wv" data-id="${o.id}"></canvas>`;
      if (type === 'clip' && o.kf?.length) inner += o.kf.map(k => `<s class="kf" data-t="${k.t}" style="left:${k.t * pps}px" title="키프레임 ${k.t.toFixed(2)}초"></s>`).join('');
      if (type === 'clip' && o.freeze) cls = o.solid ? 'solid' : 'freeze';
      if (o.link) cls += ' linked';
      return `<div class="blk ${type} ${multi.has(o.id) ? 'on' : ''} ${sel?.id === o.id ? 'pri' : ''} ${cls} ${extra}" data-type="${type}" data-id="${o.id}" style="left:${left}px;width:${width}px" title="${esc(label)}">${inner}<i class="h l" data-h="l"></i><span>${esc(label)}</span><i class="h r" data-h="r"></i></div>`;
    };
    const lanes = laneList().map(r => {
      const tk = r.kind === 'v' || r.kind === 'a' ? P.tracks[r.kind][r.idx] : null;
      const btn = (p, on, icon, tip) => `<button class="tb ${on ? 'on' : ''}" data-tg="${p}" data-kind="${r.kind}" data-idx="${r.idx}" title="${tip}">${icon}</button>`;
      const gut = `<div class="gut"><span>${r.label}</span>${tk ? `<span class="tbs">${r.kind === 'v' ? btn('hide', tk.hide, '👁', '이 줄 숨기기(미리보기/내보내기에서 제외)') : ''}${btn('mute', tk.mute, '🔇', '이 줄 소리 끄기')}${btn('lock', tk.lock, '🔒', '이 줄 잠그기(실수로 건드리지 않게)')}</span>` : ''}</div>`;
      let items = '';
      if (r.kind === 'v') items = P.clips.filter(c => c.track === r.idx).map(c => blk('clip', c, c.solid ? `${c.solid.shape === 'ellipse' ? '원' : '도형'} · ${c.hold.toFixed(1)}초` : c.image ? `🖼 ${nameOf(c.src)} · ${c.hold.toFixed(1)}초` : c.freeze ? `정지 화면 · ${c.hold.toFixed(1)}초` : `${nameOf(c.src)} · ${cdur(c).toFixed(1)}초${c.speed !== 1 ? ' · ' + c.speed + 'x' : ''}`, info[c.src]?.missing ? 'missing' : '')).join('');
      else if (r.kind === 'a') items = P.audios.filter(a => a.track === r.idx).map(a => blk('audio', a, nameOf(a.src), info[a.src]?.missing ? 'missing' : '')).join('');
      else if (r.kind === 's') items = P.subs.map(s => blk('sub', s, s.text)).join('');
      else items = P.texts.map(s => blk('text', s, s.text)).join('');
      return `<div class="lane ${r.kind} ${tk?.lock ? 'locked' : ''} ${tk?.hide ? 'hidden' : ''}" data-kind="${r.kind}" data-idx="${r.idx}" style="height:${LANE_H[r.kind]}px">${gut}${items}</div>`;
    }).join('');
    const rg = P.range || {}, rgIn = rg.in ?? null, rgOut = rg.out ?? null;
    const rng = rgIn !== null || rgOut !== null ? `<div class="rng ${loopOn ? 'on' : ''}" style="left:${OFF + (rgIn ?? 0) * pps}px;width:${Math.max(2, ((rgOut ?? end) - (rgIn ?? 0)) * pps)}px"></div>` : '';
    const mks = (P.markers || []).map(m => `<i class="mk" data-mk="${m.id}" style="left:${OFF + m.t * pps}px" title="${esc(m.label)} (${fmt(m.t)}) · 누르면 이동, 오른쪽 클릭으로 삭제">⚑<em>${esc(m.label)}</em></i>`).join('');
    R.inner.innerHTML = `<div class="ruler" data-ruler><div class="gut"></div>${rng}${ruler}${mks}</div>${lanes}<div class="ph" id="edPh"></div><div class="snapline" id="edSnapLine" hidden></div><div class="rb" id="edRb" hidden></div>`;
    movePh(); drawWaves();
    P.audios.forEach(a => ensureWave(a.src));
  }
  function drawWaves() {
    if (!R.inner) return;
    R.inner.querySelectorAll('canvas.wv').forEach(cv => {
      const a = find('audio', cv.dataset.id), w = a && waves[a.src]; if (!w || !w.peaks.length) return;
      const W = Math.min(Math.ceil(cv.parentElement.clientWidth), 6000), H = 40; cv.width = W; cv.height = H;
      const g = cv.getContext('2d'); g.fillStyle = 'rgba(255,255,255,.55)';
      const d = adur(a);
      for (let x = 0; x < W; x++) {
        const t0 = a.in + (x / W) * d * a.speed, t1 = a.in + ((x + 1) / W) * d * a.speed;
        let m = 0; for (let i = Math.floor(t0 * w.rate); i <= Math.floor(t1 * w.rate) && i < w.peaks.length; i++) m = Math.max(m, w.peaks[i]);
        const h = Math.max(1, (m / w.max) * H); g.fillRect(x, (H - h) / 2, 1, h);
      }
    });
  }
  function movePh() {
    const ph = $('#edPh'); if (!ph) return;
    ph.style.left = OFF + T * pps + 'px';
    if (playing) { const x = OFF + T * pps, s = R.scroll; if (x < s.scrollLeft + OFF || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = Math.max(0, x - OFF - 80); }
  }
  const timeAt = clientX => (clientX - R.inner.getBoundingClientRect().left - OFF) / pps;
  function onTlClick(e) {
    const b = e.target.closest('[data-tg]'); if (!b) return;
    const tk = P.tracks[b.dataset.kind][+b.dataset.idx]; if (!tk) return;
    mutate(() => { tk[b.dataset.tg] = !tk[b.dataset.tg]; });
    syncPreview(true);
  }
  function laneAtY(y) { return [...R.inner.querySelectorAll('.lane[data-kind]')].find(l => { const r = l.getBoundingClientRect(); return y >= r.top && y < r.bottom; }); }
  function snapPts(exclude) {
    const pts = [0, T, ...(P.markers || []).map(m => m.t)];
    for (const t of ['clip', 'audio', 'sub', 'text']) for (const o of LISTS()[t]) if (!exclude.has(o.id)) { pts.push(o.start, endOf(t, o)); }
    return pts;
  }
  function snapTo(edges, pts) {  // edges 중 가장 가까운 자석 점과의 차이
    if (!snapOn) { showSnap(null); return 0; }
    const thr = 10 / pps; let best = null;
    for (const e of edges) for (const p of pts) { const d = p - e; if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best.d))) best = {d, at: p}; }
    showSnap(best ? best.at : null);
    return best ? best.d : 0;
  }
  function showSnap(t) { const el = $('#edSnapLine'); if (!el) return; el.hidden = t === null; if (t !== null) el.style.left = OFF + t * pps + 'px'; }

  function onTlDown(e) {
    if (e.button !== 0 || e.target.closest('.gut')) return;
    const b = e.target.closest('.blk');
    if (!b) {
      const mk = e.target.closest('[data-mk]');
      if (mk) { const m = P.markers.find(x => x.id === mk.dataset.mk); if (m) { pause(); seek(m.t); } return; }
      if (e.target.closest('[data-ruler]')) { const go = ev => { pause(); seek(timeAt(ev.clientX)); }; go(e); const mv = ev => go(ev), up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); return; }
      if (!e.target.closest('.lane')) return;
      // 빈 곳: 눌러서 선택 해제 + 재생선 이동, 끌면 상자로 선택
      const x0 = e.clientX, y0 = e.clientY, rect0 = R.inner.getBoundingClientRect(), additive = e.shiftKey || e.ctrlKey;
      if (!additive && (sel || multi.size)) { clearSel(); renderProps(); renderLeft(); renderTimeline(); }
      pause(); seek(timeAt(e.clientX));
      let boxing = false;
      const mv = ev => {
        if (!boxing && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 5) boxing = true;
        if (!boxing) return;
        const rb = $('#edRb'), l = Math.min(x0, ev.clientX) - rect0.left, t = Math.min(y0, ev.clientY) - rect0.top;
        Object.assign(rb.style, {left: l + 'px', top: t + 'px', width: Math.abs(ev.clientX - x0) + 'px', height: Math.abs(ev.clientY - y0) + 'px'}); rb.hidden = false;
      };
      const up = ev => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (boxing) {
          const x1 = Math.min(x0, ev.clientX), x2 = Math.max(x0, ev.clientX), y1 = Math.min(y0, ev.clientY), y2 = Math.max(y0, ev.clientY);
          const hit = [...R.inner.querySelectorAll('.blk')].filter(el => { const r = el.getBoundingClientRect(); return r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2; })
            .map(el => ({type: el.dataset.type, o: find(el.dataset.type, el.dataset.id)})).filter(i => i.o);
          const keep = additive ? selItems() : [];
          setSel([...keep, ...hit.filter(h => !keep.some(k => k.o.id === h.o.id))]); renderAll();
        } else if (additive) renderAll();
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up); return;
    }
    const type = b.dataset.type, id = b.dataset.id, o = find(type, id), mode = e.target.dataset.h || 'move';
    if (!o) return;
    const kfEl = e.target.closest('.kf');
    if (kfEl && type === 'clip') { setSel([{type, o}]); pause(); renderAll(); seek(o.start + +kfEl.dataset.t); return; }
    if (e.shiftKey || e.ctrlKey) {
      const items = selItems(), has = items.some(i => i.o.id === id);
      setSel(has ? items.filter(i => i.o.id !== id) : [...items, {type, o}], has ? undefined : {type, o}); renderAll(); return;
    }
    if (!multi.has(id)) setSel(expandGroup([{type, o}]), {type, o}); else sel = {type, id};
    const lockedItem = locked(type, o);
    renderProps(); renderLeft();
    if (lockedItem) { renderTimeline(); return; }
    const before = JSON.stringify(P), x0 = e.clientX, dMax = info[o.src]?.duration || 1e6;
    const orig = {...o};
    let group = [];
    if (mode === 'move') {
      const base = selItems().filter(i => !locked(i.type, i.o));
      const ids = new Set(base.map(i => i.o.id)); group = [...base];
      for (const i of base) if (i.o.link) for (const t of ['clip', 'audio']) for (const x of LISTS()[t]) if (x.link === i.o.link && !ids.has(x.id) && !locked(t, x)) { ids.add(x.id); group.push({type: t, o: x, partner: true}); }
      group.forEach(g => { g.s0 = g.o.start; g.t0 = g.o.track; g.e0 = g.o.start + (g.type === 'sub' || g.type === 'text' ? g.o.end - g.o.start : 0); g.len = g.type === 'sub' || g.type === 'text' ? g.o.end - g.o.start : 0; });
    }
    const exclude = new Set(group.map(g => g.o.id)); exclude.add(id);
    const pts = snapPts(exclude);
    let moved = false;
    const mv = ev => {
      moved = true;
      let dt = (ev.clientX - x0) / pps;
      if (mode === 'move') {
        const edges = group.filter(g => !g.partner).flatMap(g => [g.s0 + dt, g.s0 + dt + (g.len || dur(g.type, g.o))]);
        dt += snapTo(edges, pts);
        dt = Math.max(dt, -Math.min(...group.map(g => g.s0)));
        for (const g of group) { g.o.start = g.s0 + dt; if (g.type === 'sub' || g.type === 'text') g.o.end = g.o.start + g.len; }
        if (group.length === 1 || (group.length === 2 && group[1].partner)) {
          const ln = laneAtY(ev.clientY);
          if (ln && ln.dataset.kind === kindOf(type) && !P.tracks[ln.dataset.kind][+ln.dataset.idx]?.lock) o.track = +ln.dataset.idx;
        }
      } else if (mode === 'r') {
        const speed = o.speed || 1;
        if (type === 'clip' && o.freeze) { dt += snapTo([orig.start + orig.hold + dt], pts); o.hold = clamp(orig.hold + dt, 0.1, 600); }
        else if (type === 'clip') { dt += snapTo([cend(orig) + dt], pts); o.out = clamp(orig.out + dt * speed, orig.in + 0.1, dMax); }
        else if (type === 'audio') { dt += snapTo([orig.start + adur(orig) + dt], pts); o.out = clamp((orig.out || (info[o.src]?.duration || 0)) + dt * speed, orig.in + 0.1, dMax); }
        else { dt += snapTo([orig.end + dt], pts); o.end = Math.max(orig.start + 0.1, orig.end + dt); }
      } else {
        const speed = o.speed || 1;
        dt += snapTo([orig.start + dt], pts);
        if (type === 'clip' && o.freeze) { dt = clamp(dt, -orig.start, orig.hold - 0.1); o.start = orig.start + dt; o.hold = orig.hold - dt; }
        else if (type === 'clip' || type === 'audio') { const e0 = endOf(type, orig); dt = clamp(dt, Math.max(-orig.start, -orig.in / speed), (e0 - orig.start) - 0.1); o.start = orig.start + dt; o.in = orig.in + dt * speed; if (type === 'audio' && !orig.out) o.out = info[o.src]?.duration || 0; }
        else { o.start = clamp(orig.start + dt, 0, orig.end - 0.1); }
      }
      renderTimeline(); renderStage(); renderOv(); renderTime(); syncPreview(true);
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); showSnap(null);
      if (JSON.stringify(P) !== before) { undo.push(before); redo = []; lastKey = ''; queueSave(); }
      renderAll();
      if (!moved) seekIfClick(o);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
    renderTimeline();
  }
  function seekIfClick() { /* 클립을 눌러도 재생선은 움직이지 않는다 (재생선은 눈금자/빈 곳을 눌러 이동) */ }
  function onTlDrop(e) {
    const ln = e.target.closest('.lane[data-kind]'); if (!ln) return;
    e.preventDefault();
    let d; try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    if (!d?.src) return;
    const at = Math.max(0, timeAt(e.clientX)), kind = ln.dataset.kind;
    if (d.kind === 'video' && kind === 'v') addClip(d.src, at, +ln.dataset.idx);
    else if (d.kind === 'audio' && kind === 'a') addAudio(d.src, at, +ln.dataset.idx);
    else say(d.kind === 'video' ? '영상은 V 줄에 놓아 주세요.' : '오디오는 A 줄에 놓아 주세요.', true);
  }
  function onKey(e) {
    if (!$('#viewEdit') || $('#viewEdit').hidden || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z') { e.preventDefault(); restore(undo, redo); }
    else if (e.ctrlKey && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); restore(redo, undo); }
    else if (e.ctrlKey && k === 's') { e.preventDefault(); saveProject(); }
    else if (e.ctrlKey && k === 'c') { e.preventDefault(); copySel(); }
    else if (e.ctrlKey && k === 'v') { e.preventDefault(); pasteAt(T); }
    else if (e.ctrlKey && k === 'd') { e.preventDefault(); duplicateSel(); }
    else if (e.ctrlKey && k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); }
    else if (e.ctrlKey && k === 'a') { e.preventDefault(); setSel([...P.clips.map(o => ({type: 'clip', o})), ...P.audios.map(o => ({type: 'audio', o}))]); renderAll(); }
    else if (k === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (k === 's' && !e.ctrlKey) split();
    else if (k === 'i' && !e.ctrlKey) setRange('in');
    else if (k === 'o' && !e.ctrlKey) setRange('out');
    else if (k === 'x' && !e.ctrlKey) clearRange();
    else if (k === 'm' && !e.ctrlKey) addMarker();
    else if (k === 'l' && !e.ctrlKey) $('#edLoop').click();
    else if (k === 'delete' || k === 'backspace') removeSelected(e.shiftKey);
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
    try { await restoreProject(await api('/api/edit/project?name=' + encodeURIComponent(name))); }
    catch (e) { say(e.message, true); }
  }
  async function saveShot() {
    if (!P.clips.length) { say('타임라인에 영상이 없습니다.', true); return; }
    pause(); say('화면을 저장하는 중…');
    try { const r = await api('/api/edit/frame', {project: P, t: T}); say(`저장했습니다: ${r.output} (다운로드 폴더)`); }
    catch (e) { say(e.message, true); }
  }
  function exportNow() {
    if (!P.clips.length) { say('타임라인에 영상이 없습니다.', true); return; }
    pause();
    let dlg = $('#dlgExport');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dlgExport'; document.body.appendChild(dlg); }
    const o = P.output, sel_ = (k, opts, cur) => `<select data-ex="${k}">${opts.map(([v, n]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    dlg.innerHTML = `<div class="dh">내보내기 설정 <button class="ico" data-x>✕</button></div><div class="db">
      <div class="f" style="grid-template-columns:110px 1fr;display:grid;gap:8px;align-items:center;font-size:13px">
        <label>형식</label>${sel_('format', [['mp4', 'mp4 영상'], ['gif', 'GIF 움직이는 그림 (소리 없음, 폭 480)'], ['mp3', 'mp3 소리만']], o.format || 'mp4')}
        <label>화면 비율</label>${sel_('aspect', [['original', '원본 그대로'], ['16:9', '16:9 가로'], ['9:16', '9:16 세로(쇼츠)'], ['1:1', '1:1 정사각']], o.aspect)}
        <label>해상도</label>${sel_('size', [['auto', '기본 (1080 기준)'], [480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '1440p'], [2160, '4K (2160p)']], o.size || 'auto')}
        <label>화질</label>${sel_('quality', [['high', '높음 (용량 큼)'], ['normal', '보통'], ['small', '작게 (용량 작음)']], o.quality || 'normal')}
        <label>프레임 수</label>${sel_('fps', [['auto', '원본 따름'], [24, '24'], [30, '30'], [60, '60']], o.fps || 'auto')}
        <label>화면 가득 채우기</label><input type="checkbox" data-ex="fill" ${o.fill ? 'checked' : ''}>
        <label>음량 평준화</label><input type="checkbox" data-ex="loudnorm" ${o.loudnorm ? 'checked' : ''}>
      </div>
      <div style="margin-top:12px;font-size:13px"><b>일괄 내보내기</b> (체크한 비율마다 따로 만듭니다. 체크하면 위의 화면 비율은 무시)<br>
        <label><input type="checkbox" data-batch="16:9"> 16:9 가로</label> &nbsp; <label><input type="checkbox" data-batch="9:16"> 9:16 쇼츠</label> &nbsp; <label><input type="checkbox" data-batch="1:1"> 1:1</label></div>
      <div style="margin-top:14px;text-align:right"><button data-x>취소</button> <button class="primary" data-go>내보내기 시작</button></div></div>`;
    dlg.onchange = e => {
      const k = e.target.dataset.ex; if (!k) return;
      P.output[k] = e.target.type === 'checkbox' ? e.target.checked : (['size', 'fps'].includes(k) && e.target.value !== 'auto' ? +e.target.value : e.target.value); queueSave();
    };
    dlg.onclick = async e => {
      if (e.target.dataset.x !== undefined) { dlg.close(); return; }
      if (e.target.dataset.go === undefined) return;
      const batch = [...dlg.querySelectorAll('[data-batch]:checked')].map(x => x.dataset.batch);
      dlg.close(); renderProps();
      try { const r = await api('/api/edit/export', {...P, batch}); say(`내보내는 중… 완료되면 "${r.output}" 로 저장됩니다. (아래 진행 표시줄 참고)`); pollJobs(); }
      catch (x) { say(x.message, true); }
    };
    dlg.showModal();
  }

  return {
    async show() { if (!built) build(); await loadLib(); renderAll(); fitStage(); },
    hide() { if (built) pause(); },
    async addFromLibrary(name) { if (!built) build(); await loadLib(); await addClip(name); },
    refreshLib: loadLib,
    _state: () => ({P, T, sel, multi: [...multi], info, vels: vels.size}),  // 테스트용
    _do: {linkSel, unlinkSel, boxTarget, boxDown, stageDown, addKf, kfEval, saveShot, exportNow, addSolid, setRange, addMarker, groupSel, ungroupSel, copyProps, pasteProps, toggleRec, voiceSpans, duckGain, split, freezeFrame, detachAudio, copySel, pasteAt, duplicateSel, removeSelected, setTransition, seek, play, pause, addClip, addAudio, setSel, find, renderAll},  // 테스트용
  };
})();
