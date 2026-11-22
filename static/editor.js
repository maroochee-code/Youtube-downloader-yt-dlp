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
  const track0 = () => ({mute: false, lock: false, hide: false});
  const blank = () => ({version: 2, name: '편집본', tracks: {v: [track0(), track0()], a: [track0(), track0()]},
    clips: [], audios: [], subs: [], texts: [],
    sub_style: {size: 48, color: '#ffffff', outline: '#000000', pos: 'bottom'}, output: {aspect: 'original'}});
  const TRANS = [['', '없음'], ['fade', '디졸브(서서히 겹침)'], ['slide-l', '오른쪽에서 밀려 들어옴'], ['slide-r', '왼쪽에서 밀려 들어옴'], ['slide-u', '아래에서 밀려 들어옴'], ['slide-d', '위에서 밀려 들어옴']];

  let P = blank(), sel = null, multi = new Set(), T = 0, playing = false, pps = 40, tab = 'video', snapOn = true;
  let lib = [], assets = [], built = false, undo = [], redo = [], lastKey = '', lastAt = 0, clip = null, saveTimer = 0;
  let playMs = 0, playT0 = 0;
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
    o.version = 2;
    const tr = (arr, n) => { arr = Array.isArray(arr) ? arr.map(t => ({...track0(), ...t})) : []; while (arr.length < n) arr.push(track0()); return arr; };
    o.clips = (o.clips || []).map((c, i) => ({track: 0, start: 0, speed: 1, volume: 1, mute: false, x: .5, y: .5, scale: 1, opacity: 1, fade_in: 0, fade_out: 0, trans: null, freeze: false, hold: 2, link: null, id: uid(), ...c}));
    o.audios = (o.audios || []).map(a => ({track: 0, speed: 1, volume: 1, in: 0, out: 0, fade_in: 0, fade_out: 0, link: null, id: uid(), ...a, start: a.start ?? a.at ?? 0}));
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
      mutate(() => P.clips.push({id, src, track: tk, start: at ?? trackEnd('clip', tk), in: 0, out: i.duration, speed: 1, volume: 1, mute: false, x: .5, y: .5, scale: 1, opacity: 1, fade_in: 0, fade_out: 0, trans: null, freeze: false, hold: 2, link: null}));
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
    mutate(() => P.subs.push({id, start: +T.toFixed(2), end: +(T + 2).toFixed(2), text: '새 자막'}));
    setSel([{type: 'sub', o: find('sub', id)}]); renderAll();
  }
  function addText() {
    const id = uid();
    mutate(() => P.texts.push({id, start: +T.toFixed(2), end: +(T + 3).toFixed(2), text: '글자', x: 0.5, y: 0.15, size: 64, color: '#ffffff'}));
    setSel([{type: 'text', o: find('text', id)}]); renderAll();
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
    const lid = uid(), id = uid();
    mutate(() => {
      P.audios.push({id, src: c.src, track: firstFree('a'), start: c.start, in: c.in, out: c.out, speed: c.speed, volume: c.volume, fade_in: c.fade_in, fade_out: c.fade_out, link: lid});
      c.mute = true; c.link = lid;
    });
    setSel([{type: 'audio', o: find('audio', id)}]); renderAll(); ensureWave(c.src); say('소리를 오디오 줄로 분리했습니다. 영상 클립은 소리가 꺼졌고, 둘은 연결돼 같이 움직입니다.');
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
      P.clips.push({...c, id: fid, start: at, in: cutIn, out: cutIn + 0.1, freeze: true, hold, speed: 1, mute: true, fade_in: 0, fade_out: 0, trans: null, link: null});
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
    let v = vels.get(c.id);
    if (!v || v.src !== c.src) {
      if (v) disposeVel(c.id);
      const el = document.createElement('video');
      el.className = 'lyr'; el.preload = 'auto'; el.playsInline = true; el.src = srcUrl(c.src); el.style.display = 'none';
      R.stage.insertBefore(el, R.ov);
      el.addEventListener('loadedmetadata', () => { renderStage(); if (!playing) syncPreview(true); });
      v = {el, src: c.src, last: 0}; vels.set(c.id, v);
    }
    return v;
  }
  function disposeVel(id) { const v = vels.get(id); if (!v) return; v.el.pause(); v.el.removeAttribute('src'); v.el.load(); v.el.remove(); vels.delete(id); }
  function getAud(a) {
    if (!auds[a.id] || auds[a.id].dataset.src !== a.src) { const el = new Audio(srcUrl(a.src)); el.dataset.src = a.src; el.preload = 'auto'; auds[a.id] = el; }
    return auds[a.id];
  }
  const ramp = (rel, d, left, fi, fo) => { let f = 1; if (fi > 0 && rel < fi) f *= rel / fi; if (fo > 0 && left < fo) f *= left / fo; return clamp(f, 0, 1); };
  function syncPreview(force) {
    const ls = layers(), now = T;
    const alive = new Set(P.clips.map(c => c.id));
    for (const id of [...vels.keys()]) if (!alive.has(id)) disposeVel(id);
    ls.forEach((c, z) => {
      const d = cdur(c), rel = now - c.start, active = rel >= -0.0001 && rel < d - 0.0001;
      const soon = !active && playing && c.start - now > 0 && c.start - now < 1.5;
      if (!active && !soon) { const v = vels.get(c.id); if (v) { v.el.pause(); v.el.style.display = 'none'; } return; }
      const v = ensureVel(c), el = v.el; v.last = Date.now();
      if (soon) { el.style.display = 'none'; el.pause(); if (Math.abs(el.currentTime - c.in) > 0.2 && el.readyState >= 1) el.currentTime = c.in; return; }
      const want = c.freeze ? c.in : c.in + rel * c.speed;
      const tk = P.tracks.v[c.track] || track0();
      el.style.display = ''; el.style.zIndex = z + 1; el.style.visibility = tk.hide ? 'hidden' : 'visible';
      // 위치/크기/투명도/전환
      let op = c.opacity, tx = (c.x - .5) * 100, ty = (c.y - .5) * 100;
      const ovIn = overlapIn(c);
      if (c.trans && ovIn > 0 && rel < ovIn) {
        const pr = clamp(rel / ovIn, 0, 1), k = c.trans.type;
        if (k === 'fade') op *= pr; else if (k === 'slide-l') tx += (1 - pr) * 100; else if (k === 'slide-r') tx -= (1 - pr) * 100; else if (k === 'slide-u') ty += (1 - pr) * 100; else if (k === 'slide-d') ty -= (1 - pr) * 100;
      }
      op *= ramp(rel, d, d - rel, c.trans?.type === 'fade' && ovIn > 0 ? 0 : c.fade_in, c.fade_out);
      el.style.opacity = op; el.style.transform = `translate(${tx}%,${ty}%) scale(${c.scale})`;
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
        el.volume = clamp(a.volume * ramp(rel, d, d - rel, a.fade_in, a.fade_out), 0, 1);
        if (el.paused) el.play().catch(() => {});
      } else if (!el.paused) el.pause();
    }
  }
  function seek(t) {
    T = clamp(t, 0, Math.max(total(), 0));
    if (playing) { playMs = performance.now(); playT0 = T; }
    syncPreview(true); movePh(); renderOv(); renderTime();
  }
  function play() {
    if (!P.clips.length) return;
    if (T >= total() - 0.05) T = 0;
    playing = true; R.play.textContent = '⏸'; playMs = performance.now(); playT0 = T;
    syncPreview(true); requestAnimationFrame(tick);
  }
  function stopAll() { for (const v of vels.values()) v.el.pause(); for (const a of Object.values(auds)) a.pause(); }
  function pause() { playing = false; R.play.textContent = '▶'; stopAll(); }
  function tick() {
    if (!playing) return;
    T = playT0 + (performance.now() - playMs) / 1000;
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
          <div class="ed-wrap" id="edWrap"><div id="edStage"><div id="edOv"></div><div class="empty" id="edEmpty">왼쪽 목록에서 영상을 눌러 추가하세요<br>(타임라인으로 끌어다 놓아도 됩니다)</div></div></div>
          <div class="ed-ctl"><button id="edToStart" title="처음으로">⏮</button><button id="edPlay" title="재생/정지 (Space)">▶</button><span id="edTime">00:00.0 / 00:00.0</span></div>
        </div>
        <div class="ed-right" id="edProps"></div>
      </div>
      <div class="ed-tools">
        <button id="edSplit" title="나누기 (S)">✂ 나누기</button><button id="edDel" title="삭제 (Delete)">🗑 삭제</button><button id="edRip" title="삭제하고 뒤를 당기기 (Shift+Delete)">⇤ 당겨서 삭제</button>
        <span class="sep"></span><button id="edCopy" title="복사 (Ctrl+C)">복사</button><button id="edPaste" title="재생선 위치에 붙여넣기 (Ctrl+V)">붙여넣기</button><button id="edDup" title="복제 (Ctrl+D)">복제</button>
        <span class="sep"></span><button id="edDetach" title="영상 클립의 소리를 오디오 줄로 분리">🔊 소리 분리</button><button id="edFreeze" title="재생선 위치를 멈춘 화면으로">❄ 정지 화면</button>
        <span class="sep"></span><button id="edUndo" title="되돌리기 (Ctrl+Z)">↶</button><button id="edRedo" title="다시 실행 (Ctrl+Y)">↷</button>
        <span class="sep"></span><button id="edSnap" class="tg on" title="클립 가장자리에 자석처럼 붙기">🧲 자석</button><button id="edAddV" title="영상 줄 추가">＋영상 줄</button><button id="edAddA" title="오디오 줄 추가">＋오디오 줄</button>
        <span style="flex:1"></span><span style="font-size:12px;color:var(--mute)">확대</span><input type="range" id="edZoom" min="8" max="160" value="${pps}">
      </div>
      <div class="ed-tl"><div class="ed-scroll" id="edScroll"><div id="edInner"></div></div></div>`;
    Object.assign(R, {play: $('#edPlay'), msg: $('#edMsg'), stage: $('#edStage'), wrap: $('#edWrap'), ov: $('#edOv'),
      inner: $('#edInner'), scroll: $('#edScroll'), props: $('#edProps'), lbody: $('#edLbody'), time: $('#edTime'), name: $('#edName')});
    new ResizeObserver(fitStage).observe(R.wrap);
    $('#edPlay').onclick = () => (playing ? pause() : play());
    $('#edToStart').onclick = () => { pause(); seek(0); };
    $('#edSplit').onclick = split; $('#edDel').onclick = () => removeSelected(false); $('#edRip').onclick = () => removeSelected(true);
    $('#edCopy').onclick = copySel; $('#edPaste').onclick = () => pasteAt(T); $('#edDup').onclick = duplicateSel;
    $('#edDetach').onclick = detachAudio; $('#edFreeze').onclick = freezeFrame;
    $('#edUndo').onclick = () => restore(undo, redo); $('#edRedo').onclick = () => restore(redo, undo);
    $('#edSnap').onclick = e => { snapOn = !snapOn; e.currentTarget.classList.toggle('on', snapOn); };
    $('#edAddV').onclick = () => addTrack('v'); $('#edAddA').onclick = () => addTrack('a');
    $('#edZoom').oninput = e => { pps = +e.target.value; renderTimeline(); };
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
    await Promise.all([...new Set([...P.clips, ...P.audios].map(x => x.src))].map(s => probe(s).catch(() => miss.push(s))));
    renderAll(); seek(0); P.audios.forEach(a => ensureWave(a.src));
    say(miss.length ? `원본 파일을 찾을 수 없습니다: ${miss.map(nameOf).join(', ')}` : `열었습니다: ${P.name}`, !!miss.length);
  }

  function renderAll() { renderBar(); renderLeft(); renderTimeline(); renderProps(); renderStage(); renderOv(); renderTime(); }
  function renderLight() { renderTimeline(); renderStage(); renderOv(); renderTime(); }
  function renderBar() { if (document.activeElement !== R.name) R.name.value = P.name; }

  const LTABS = [['video', '영상'], ['audio', '오디오'], ['sub', '자막'], ['text', '글자']];
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
    if (tab === 'video') b.innerHTML = '<div class="hint" style="padding-top:0">누르면 맨 아래 영상 줄 끝에 붙고, 타임라인으로 끌어다 놓으면 그 위치/줄에 들어갑니다.</div>' + libRows(lib.filter(i => !i.audio), 'video');
    else if (tab === 'audio') {
      b.innerHTML = `<div class="btns"><button id="edUp">📁 내 PC에서 불러오기</button><input type="file" id="edUpFile" accept="audio/*,video/*,.mp3,.m4a,.wav,.flac,.ogg,.opus" hidden></div>
        <div class="hint" style="padding-top:0">누르면 재생선 위치에 들어갑니다. 끌어다 놓아도 됩니다.</div>
        ${assets.length ? '<div class="hint">불러온 파일</div>' + libRows(assets.map(a => ({src: a.src, title: a.name})), 'audio') : ''}
        <div class="hint">저장한 파일 (영상에서 소리만 쓸 수도 있습니다)</div>${libRows(lib, 'audio')}`;
    } else if (tab === 'sub') {
      const st = P.sub_style;
      b.innerHTML = `<div class="btns"><button data-act="addSub">＋ 현재 위치에 자막</button><button data-act="srtIn">SRT 불러오기</button><button data-act="srtOut">SRT 내보내기</button><input type="file" id="edSrtFile" accept=".srt,.txt" hidden></div>
        ${[...P.subs].sort((x, y) => x.start - y.start).map(s => `<div class="row srow ${multi.has(s.id) ? 'on' : ''}" data-sel="sub" data-id="${s.id}"><div style="min-width:0"><div class="t">${esc(s.text)}</div><div class="m">${fmt(s.start)} → ${fmt(s.end)}</div></div></div>`).join('') || '<div class="hint">자막이 없습니다.</div>'}
        <div class="sty"><span>크기</span><input type="number" data-sty="size" value="${st.size}" min="10" max="200">
        <span>글자색</span><input type="color" data-sty="color" value="${st.color}"><span>테두리색</span><input type="color" data-sty="outline" value="${st.outline}">
        <span>위치</span><select data-sty="pos">${[['bottom', '아래'], ['middle', '가운데'], ['top', '위']].map(([k, n]) => `<option value="${k}" ${st.pos === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    } else {
      b.innerHTML = `<div class="btns"><button data-act="addText">＋ 현재 위치에 글자</button></div>
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
  const LAYER = [['x', '가로 위치(%)', 'p'], ['y', '세로 위치(%)', 'p'], ['scale', '크기(%)', 'p'], ['opacity', '투명도(%)', 'p']];
  const FIELDS = {
    clip: [['start', '시작 위치(초)', 'n'], ['in', '원본 시작(초)', 'n'], ['out', '원본 끝(초)', 'n'], ['speed', '속도(배)', 'n'], ['volume', '볼륨(%)', 'p'], ['mute', '소리 끄기', 'b'], ...LAYER, ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n']],
    freeze: [['start', '시작 위치(초)', 'n'], ['hold', '멈춘 시간(초)', 'n'], ...LAYER, ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n']],
    audio: [['start', '시작 위치(초)', 'n'], ['in', '원본 시작(초)', 'n'], ['out', '원본 끝(초, 0=끝까지)', 'n'], ['speed', '속도(배)', 'n'], ['volume', '볼륨(%)', 'p'], ['fade_in', '페이드 인(초)', 'n'], ['fade_out', '페이드 아웃(초)', 'n']],
    sub: [['start', '시작(초)', 'n'], ['end', '끝(초)', 'n'], ['text', '내용', 't']],
    text: [['start', '시작(초)', 'n'], ['end', '끝(초)', 'n'], ['text', '내용', 't'], ['size', '크기', 'n'], ['color', '색', 'c'], ['x', '가로 위치(%)', 'p'], ['y', '세로 위치(%)', 'p']],
  };
  const TITLES = {clip: '영상 클립', freeze: '정지 화면', audio: '오디오', sub: '자막', text: '글자'};
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
    if (multi.size > 1) {
      R.props.innerHTML = `<h4>${multi.size}개 선택됨</h4><p class="note">끌면 함께 이동하고, 삭제/복사/복제도 한꺼번에 됩니다.<br>Shift나 Ctrl을 누르고 누르면 하나씩 추가/해제, 빈 곳을 끌면 상자로 선택합니다.</p>
        <div class="acts"><button data-do="del">삭제</button><button data-do="rip">당겨서 삭제</button><button data-do="copy">복사</button><button data-do="dup">복제</button></div>`;
      return;
    }
    if (!o) {
      R.props.innerHTML = `<h4>프로젝트</h4><div class="f"><label>화면 비율</label><select data-proj="aspect">${[['original', '원본 그대로'], ['16:9', '16:9 가로'], ['9:16', '9:16 세로(쇼츠)'], ['1:1', '1:1 정사각']].map(([k, n]) => `<option value="${k}" ${P.output.aspect === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <p class="note">총 길이 ${fmt(total())} · 영상 ${P.clips.length}개 · 오디오 ${P.audios.length}개 · 자막 ${P.subs.length}개<br>타임라인에서 항목을 누르면 세부 설정이 나옵니다.<br>비율이 원본과 다르면 남는 곳은 검은색으로 채웁니다.<br><br>위쪽 영상 줄이 아래쪽 줄 위에 겹쳐 보입니다.</p>`;
      return;
    }
    const kind = sel.type === 'clip' && o.freeze ? 'freeze' : sel.type;
    let extra = '';
    if (sel.type === 'clip') {
      const ov = overlapIn(o), p = prevClip(o);
      extra = `<h4 style="margin-top:12px">장면 전환</h4><div class="f"><label>종류</label><select data-trans="type">${TRANS.map(([k, n]) => `<option value="${k}" ${(o.trans?.type || '') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <label>길이(초)</label><input type="number" step="0.1" min="0.1" data-trans="dur" value="${(o.trans ? ov : 0.5).toFixed(2)}" ${o.trans ? '' : 'disabled'}></div>
        <div class="note" style="margin-top:4px">${p ? '앞 클립과 겹친 길이가 전환 길이입니다.' : '같은 줄 앞에 클립이 있어야 전환을 넣을 수 있습니다.'}</div>
        <div class="acts">${o.freeze ? '' : '<button data-do="setIn">현재 위치를 시작으로</button><button data-do="setOut">현재 위치를 끝으로</button><button data-do="detach">소리 분리</button>'}</div>
        <div class="note">${o.freeze ? '' : `원본 길이 ${fmt(info[o.src]?.duration || 0)} · `}${esc(nameOf(o.src))}</div>`;
    }
    if (sel.type === 'audio') extra = `<div class="note">${esc(nameOf(o.src))} · 원본 길이 ${fmt(info[o.src]?.duration || 0)}${o.link ? '<br>🔗 영상 클립과 연결됨(같이 움직임)' : ''}</div>`;
    R.props.innerHTML = `<h4>${TITLES[kind]}</h4><div class="f">${FIELDS[kind].map(([k, l, t]) => fieldHtml(k, l, t, o[k])).join('')}</div>${extra}
      <div class="acts"><button data-do="del">삭제</button>${kindOf(sel.type) ? '<button data-do="rip">당겨서 삭제</button>' : ''}<button data-do="dup">복제</button></div>`;
  }
  function onPropInput(e) {
    const el = e.target;
    if (el.dataset.proj) { mutate(() => { P.output.aspect = el.value; }); return; }
    const o = selObj();
    if (el.dataset.trans && o) {
      if (e.type !== 'change') return;
      const type = el.dataset.trans === 'type' ? el.value : (o.trans?.type || '');
      setTransition(o, type, el.dataset.trans === 'dur' ? num(el.value, 0.5) : undefined); renderProps(); return;
    }
    const k = el.dataset.k; if (!o || !k) return;
    if (e.type === 'input' && el.dataset.t === 'b') return;
    const v = el.dataset.t === 'n' ? num(el.value) : el.dataset.t === 'p' ? num(el.value) / 100 : el.dataset.t === 'b' ? el.checked : el.value;
    if (el.dataset.t === 'n' && el.value === '') return;
    const oldStart = o.start;
    mutate(() => {
      o[k] = v;
      if (sel.type === 'clip') {
        const d = info[o.src]?.duration || o.out;
        o.speed = clamp(o.speed, 0.25, 4); o.out = clamp(o.out, 0.05, d); o.in = clamp(o.in, 0, o.out - 0.05); o.volume = clamp(o.volume, 0, 4);
        o.scale = clamp(o.scale, 0.05, 5); o.opacity = clamp(o.opacity, 0, 1); o.start = Math.max(0, o.start); o.hold = clamp(o.hold, 0.1, 600);
      } else if (sel.type === 'sub' || sel.type === 'text') { o.start = Math.max(0, o.start); if (o.end <= o.start) o.end = o.start + 0.1; }
      else if (sel.type === 'audio') { o.start = Math.max(0, o.start); o.in = Math.max(0, o.in); o.out = Math.max(0, o.out); o.volume = clamp(o.volume, 0, 4); o.speed = clamp(o.speed, 0.25, 4); }
      if (k === 'start' && o.link) for (const x of [...P.clips, ...P.audios]) if (x !== o && x.link === o.link) x.start = Math.max(0, x.start + (o.start - oldStart));
    }, e.type === 'change', 'p' + k);
    if (e.type === 'change') renderProps();
  }
  function onPropClick(e) {
    const d = e.target.dataset.do; if (!d) return;
    if (d === 'del') { removeSelected(false); return; }
    if (d === 'rip') { removeSelected(true); return; }
    if (d === 'copy') { copySel(); return; }
    if (d === 'dup') { duplicateSel(); return; }
    if (d === 'detach') { detachAudio(); return; }
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
    const f = [...P.clips].sort((x, y) => x.start - y.start)[0], i = f && info[f.src]; return i?.width && i?.height ? i.width / i.height : 16 / 9;
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
      if (type === 'clip' && o.freeze) cls = 'freeze';
      if (o.link) cls += ' linked';
      return `<div class="blk ${type} ${multi.has(o.id) ? 'on' : ''} ${sel?.id === o.id ? 'pri' : ''} ${cls} ${extra}" data-type="${type}" data-id="${o.id}" style="left:${left}px;width:${width}px" title="${esc(label)}">${inner}<i class="h l" data-h="l"></i><span>${esc(label)}</span><i class="h r" data-h="r"></i></div>`;
    };
    const lanes = laneList().map(r => {
      const tk = r.kind === 'v' || r.kind === 'a' ? P.tracks[r.kind][r.idx] : null;
      const btn = (p, on, icon, tip) => `<button class="tb ${on ? 'on' : ''}" data-tg="${p}" data-kind="${r.kind}" data-idx="${r.idx}" title="${tip}">${icon}</button>`;
      const gut = `<div class="gut"><span>${r.label}</span>${tk ? `<span class="tbs">${r.kind === 'v' ? btn('hide', tk.hide, '👁', '이 줄 숨기기(미리보기/내보내기에서 제외)') : ''}${btn('mute', tk.mute, '🔇', '이 줄 소리 끄기')}${btn('lock', tk.lock, '🔒', '이 줄 잠그기(실수로 건드리지 않게)')}</span>` : ''}</div>`;
      let items = '';
      if (r.kind === 'v') items = P.clips.filter(c => c.track === r.idx).map(c => blk('clip', c, c.freeze ? `정지 화면 · ${c.hold.toFixed(1)}초` : `${nameOf(c.src)} · ${cdur(c).toFixed(1)}초${c.speed !== 1 ? ' · ' + c.speed + 'x' : ''}`, info[c.src]?.missing ? 'missing' : '')).join('');
      else if (r.kind === 'a') items = P.audios.filter(a => a.track === r.idx).map(a => blk('audio', a, nameOf(a.src), info[a.src]?.missing ? 'missing' : '')).join('');
      else if (r.kind === 's') items = P.subs.map(s => blk('sub', s, s.text)).join('');
      else items = P.texts.map(s => blk('text', s, s.text)).join('');
      return `<div class="lane ${r.kind} ${tk?.lock ? 'locked' : ''} ${tk?.hide ? 'hidden' : ''}" data-kind="${r.kind}" data-idx="${r.idx}" style="height:${LANE_H[r.kind]}px">${gut}${items}</div>`;
    }).join('');
    R.inner.innerHTML = `<div class="ruler" data-ruler><div class="gut"></div>${ruler}</div>${lanes}<div class="ph" id="edPh"></div><div class="snapline" id="edSnapLine" hidden></div><div class="rb" id="edRb" hidden></div>`;
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
    const pts = [0, T];
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
    if (e.shiftKey || e.ctrlKey) {
      const items = selItems(), has = items.some(i => i.o.id === id);
      setSel(has ? items.filter(i => i.o.id !== id) : [...items, {type, o}], has ? undefined : {type, o}); renderAll(); return;
    }
    if (!multi.has(id)) setSel([{type, o}]); else sel = {type, id};
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
    else if (e.ctrlKey && k === 'a') { e.preventDefault(); setSel([...P.clips.map(o => ({type: 'clip', o})), ...P.audios.map(o => ({type: 'audio', o}))]); renderAll(); }
    else if (k === ' ') { e.preventDefault(); playing ? pause() : play(); }
    else if (k === 's' && !e.ctrlKey) split();
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
    _state: () => ({P, T, sel, multi: [...multi], info, vels: vels.size}),  // 테스트용
    _do: {split, freezeFrame, detachAudio, copySel, pasteAt, duplicateSel, removeSelected, setTransition, seek, play, pause, addClip, addAudio, setSel, find, renderAll},  // 테스트용
  };
})();
