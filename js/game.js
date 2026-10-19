// 『通知に異常なし』本体
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const TS = Math.max(0.1, Number(params.get('ts')) || 1); // 検証用の時間倍率

  // ───────── 乱数（?seed= で固定可） ─────────
  let rand = Math.random;
  if (params.has('seed')) {
    let s = Number(params.get('seed')) >>> 0 || 1;
    rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];

  // ───────── 保存（失敗しても動く） ─────────
  const store = {
    get(k, d) { try { const v = localStorage.getItem('tsuuchi:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('tsuuchi:' + k, JSON.stringify(v)); } catch {} },
  };

  // ───────── 通知に ID を振る（本文から算出。並べ替えても変わらない） ─────────
  const hash = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  NOTIFS.forEach((n) => { n.id = hash(n.app + '|' + (n.from || '') + '|' + n.text); });

  // ───────── 音 ─────────
  let actx = null;
  const settings = { sound: store.get('sound', true), speed: store.get('speed', 'normal') };
  function beep(notes, type = 'sine', vol = 0.05) {
    if (!settings.sound || !actx) return;
    const t0 = actx.currentTime;
    notes.forEach(([f, at, dur]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(vol, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0 + at); o.stop(t0 + at + dur + 0.05);
    });
  }
  const sfx = {
    arrive: () => beep([[1318, 0, 0.16], [1760, 0.07, 0.22]], 'sine', 0.035),
    hit: () => beep([[1046, 0, 0.18], [1568, 0.08, 0.3]], 'sine', 0.06),
    miss: () => beep([[196, 0, 0.16], [185, 0.09, 0.16]], 'triangle', 0.07),
  };

  // ───────── 画面要素 ─────────
  const el = {
    screen: $('#screen'), list: $('#list'), clock: $('#clock'), date: $('#date'),
    focus: $('#focus'), focusText: $('#focus-text'),
    batPct: $('#battery-pct'), batFill: $('#battery-fill'),
    title: $('#title'), result: $('#result'), final: $('#final'),
  };

  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  const now = new Date();
  el.date.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}曜日`;

  function setClock(sec) {
    const total = CONFIG.startClock[0] * 60 + CONFIG.startClock[1] + Math.floor(sec / 60);
    el.clock.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function setBattery(p) {
    el.batPct.textContent = p + '%';
    el.batFill.style.width = p + '%';
  }

  // ───────── 通知カード ─────────
  function iconSvg(app) {
    const a = APPS[app];
    return `<span class="icon" style="background-color:${a.color}"><svg viewBox="0 0 24 24">${ICONS[a.icon] || ''}</svg></span>`;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function cardHTML(n, timeLabel = '今') {
    const a = APPS[n.app];
    return `${iconSvg(n.app)}<div class="main"><div class="head"><span class="app">${esc(a.name)}</span><span class="time">${timeLabel}</span></div>`
      + (n.from ? `<div class="from">${esc(n.from)}</div>` : '')
      + `<div class="body">${esc(n.body)}</div></div>`;
  }
  function makeCard(n, timeLabel) {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = cardHTML(n, timeLabel);
    return d;
  }

  // 位置の変化をなめらかに（FLIP）
  function flip(mutate) {
    const els = [...el.list.children];
    const first = new Map(els.map((e) => [e, e.getBoundingClientRect().top]));
    mutate();
    for (const e of els) {
      if (!e.isConnected) continue;
      const dy = first.get(e) - e.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) e.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  // ───────── ゲーム状態 ─────────
  let S = null;
  let rafId = 0;

  function newState() {
    return {
      t: 0, running: false, ended: false,
      nextSpawn: 1.6, spawned: [], cards: [], used: new Set(),
      found: [], wrong: [], missed: [], recentKinds: [],
      specialsDone: new Set(), score: 0, lastRelTick: 0,
      seen: new Set(store.get('seen', [])),
    };
  }

  function phaseAt(t) { return CONFIG.phases.find((p) => t < p.until) || CONFIG.phases[CONFIG.phases.length - 1]; }

  function weighted(w) {
    const entries = Object.entries(w); let r = rand() * entries.reduce((s, [, v]) => s + v, 0);
    for (const [k, v] of entries) { r -= v; if (r <= 0) return Number(k); }
    return Number(entries[entries.length - 1][0]);
  }

  // 未使用（今回）→ 未見（過去プレイ）を優先して選ぶ
  function choose(list) {
    const fresh = list.filter((n) => !S.used.has(n.id));
    if (!fresh.length) return null;
    const unseen = fresh.filter((n) => !S.seen.has(n.id));
    return pickOne(unseen.length ? unseen : fresh);
  }

  function pickNotification(ph) {
    const recent = S.recentKinds.slice(-6);
    let wantAnomaly = rand() < ph.anomaly;
    if (recent.slice(-2).every((k) => k === 'a') && recent.length >= 2) wantAnomaly = false;
    if (recent.length >= 6 && !recent.includes('a')) wantAnomaly = true;
    let n = null;
    if (wantAnomaly) {
      const tier = weighted(ph.tiers);
      const order = [tier, tier - 1, tier + 1, tier - 2, tier + 2].filter((x) => x >= 1 && x <= 3);
      for (const tr of order) { n = choose(NOTIFS.filter((x) => x.k === 'a' && x.t === tr)); if (n) break; }
    }
    if (!n) {
      const wantQuirky = rand() < ph.quirky;
      n = choose(NOTIFS.filter((x) => x.k === (wantQuirky ? 'q' : 'n'))) || choose(NOTIFS.filter((x) => x.k !== 'a'));
    }
    // 同じアプリが3連続しないように
    const last2 = S.spawned.slice(-2).map((s) => s.app);
    if (n && last2.length === 2 && last2.every((a) => a === n.app)) {
      const alt = choose(NOTIFS.filter((x) => x.k === n.k && x.app !== n.app && (x.k !== 'a' || x.t === n.t)));
      if (alt) n = alt;
    }
    return n;
  }

  function ctx() {
    return { found: S.found.length, onScreenAnomalies: S.cards.filter((c) => c.state === 'live' && c.n.k === 'a').length };
  }

  function spawn(n) {
    S.used.add(n.id);
    const inst = { ...n, body: typeof n.text === 'function' ? n.text(ctx()) : n.text };
    const c = { n: inst, born: S.t, state: 'live', el: makeCard(inst) };
    c.el.classList.add('enter');
    c.el.addEventListener('animationend', (e) => { if (e.animationName === 'enter') c.el.classList.remove('enter'); });
    bindTap(c);
    flip(() => el.list.prepend(c.el));
    S.cards.unshift(c);
    S.spawned.push(inst);
    S.recentKinds.push(inst.k);
    sfx.arrive();
    requestAnimationFrame(trimOverflow);
  }

  // 画面からあふれた通知は古いものから消える
  function trimOverflow() {
    if (!S) return;
    const limit = el.list.clientHeight - 30;
    for (const c of [...S.cards].reverse()) {
      if (c.state === 'gone') continue;
      if (c.el.offsetTop > limit) expire(c, false);
    }
  }

  function expire(c, animate) {
    if (c.state === 'live' && c.n.k === 'a') S.missed.push(c.n);
    const wasLive = c.state === 'live' || c.state === 'wrong';
    c.state = 'gone';
    S.cards = S.cards.filter((x) => x !== c);
    if (!wasLive) return;
    if (animate) {
      c.el.classList.add('fade');
      setTimeout(() => flip(() => c.el.remove()), 480);
    } else c.el.remove();
  }

  // ───────── タップ（スクロールとの競合を避けるため、動いたら無効） ─────────
  function bindTap(c) {
    let sx = 0, sy = 0, st = 0, down = false;
    c.el.addEventListener('pointerdown', (e) => { down = true; sx = e.clientX; sy = e.clientY; st = performance.now(); });
    c.el.addEventListener('pointercancel', () => { down = false; });
    c.el.addEventListener('pointerup', (e) => {
      if (!down) return; down = false;
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12 || performance.now() - st > 900) return;
      tap(c);
    });
  }

  function floatText(c, text, cls) {
    const f = document.createElement('div');
    f.className = 'float ' + cls; f.textContent = text;
    c.el.appendChild(f);
    setTimeout(() => f.remove(), 950);
  }

  function tap(c) {
    if (!S.running || c.state !== 'live') return;
    if (c.n.k === 'a') {
      const rt = S.t - c.born;
      const bonus = Math.round(CONFIG.score.speedBonus * Math.max(0, 1 - rt / CONFIG.score.speedWindow));
      const pts = CONFIG.score.found + bonus;
      c.state = 'found';
      S.found.push({ ...c.n, rt, pts });
      S.score += pts;
      c.el.classList.add('hit');
      floatText(c, '+' + pts, 'plus');
      sfx.hit();
      updateFocus(true);
      setTimeout(() => {
        c.el.classList.add('leave');
        setTimeout(() => { S.cards = S.cards.filter((x) => x !== c); c.state = 'gone'; flip(() => c.el.remove()); }, 360);
      }, 650);
    } else {
      c.state = 'wrong';
      S.wrong.push(c.n);
      S.score += CONFIG.score.wrong;
      c.el.classList.remove('miss'); void c.el.offsetWidth; c.el.classList.add('miss');
      floatText(c, String(CONFIG.score.wrong).replace('-', '−'), 'minus');
      sfx.miss();
      updateFocus(false);
    }
  }

  function updateFocus(pulse) {
    el.focusText.textContent = `通知確認モード・発見 ${S.found.length}`;
    if (pulse) { el.focus.classList.remove('pulse'); void el.focus.offsetWidth; el.focus.classList.add('pulse'); }
  }

  // ───────── 進行 ─────────
  let lastTs = 0;
  function loop(ts) {
    const dt = Math.min(0.1, (ts - lastTs) / 1000) * TS;
    lastTs = ts;
    if (S && S.running) step(dt);
    rafId = requestAnimationFrame(loop);
  }

  function step(dt) {
    S.t += dt;
    const t = S.t;
    setClock(t);
    setBattery(34 - Math.floor(t / 30));
    if (t >= CONFIG.duration) { finish(); return; }

    // 特殊な通知
    for (const sp of SPECIALS) {
      if (!S.specialsDone.has(sp) && t >= sp.at) {
        S.specialsDone.add(sp);
        spawn({ ...sp, id: 'sp' + sp.at });
        S.nextSpawn = Math.max(S.nextSpawn, t + 2.2);
      }
    }
    // 通常の通知
    const ph = phaseAt(t);
    if (t >= S.nextSpawn && t < CONFIG.duration - 3) {
      const n = pickNotification(ph);
      if (n) spawn(n);
      const k = CONFIG.speeds[settings.speed] || 1;
      S.nextSpawn = t + ph.interval * k * (0.75 + rand() * 0.5);
    }
    // 古い通知は消える／時刻表示の更新
    if (t - S.lastRelTick >= 1) {
      S.lastRelTick = t;
      for (const c of [...S.cards]) {
        const age = t - c.born;
        if (c.state !== 'found' && age > phaseAt(c.born).life) expire(c, true);
        else {
          const tl = c.el.querySelector('.time');
          if (tl) tl.textContent = age < 60 ? '今' : `${Math.floor(age / 60)}分前`;
        }
      }
    }
  }

  function start() {
    if (!actx && settings.sound) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
    if (actx && actx.state === 'suspended') actx.resume();
    S = newState();
    el.list.innerHTML = '';
    el.title.hidden = true; el.result.hidden = true; el.final.hidden = true;
    el.screen.classList.remove('dim');
    el.screen.classList.add('playing');
    el.focus.classList.add('on');
    updateFocus(false);
    setClock(0); setBattery(34);
    S.running = true;
  }

  function finish() {
    S.running = false; S.ended = true;
    setClock(CONFIG.duration);
    for (const c of [...S.cards]) {
      if (c.state === 'live' && c.n.k === 'a') S.missed.push(c.n);
      c.state = 'gone';
    }
    // まとめて消去
    [...el.list.children].forEach((e, i) => { setTimeout(() => e.classList.add('leave'), i * 50); });
    S.cards = [];
    const ids = new Set(NOTIFS.map((n) => n.id));
    const seen = new Set([...S.seen, ...S.spawned.map((n) => n.id).filter((id) => ids.has(id))]);
    // 全部見たらリセット
    store.set('seen', seen.size >= NOTIFS.length - 20 ? [] : [...seen]);
    setTimeout(() => {
      el.list.innerHTML = '';
      el.focus.classList.remove('on');
      el.screen.classList.remove('playing');
      showResult();
    }, 1300);
  }

  // ───────── スコアと認定 ─────────
  function evaluate() {
    const found = S.found.length, wrong = S.wrong.length, missed = S.missed.length;
    const total = found + missed;
    const acc = found + wrong ? found / (found + wrong) : 0;
    const sc = CONFIG.score;
    const raw = S.found.reduce((s, f) => s + f.pts, 0) + wrong * sc.wrong + missed * sc.missed;
    const score = Math.max(0, Math.round(raw * (0.6 + 0.4 * acc)));
    const max = Math.max(1, total * (sc.found + sc.speedBonus));
    const ratio = score / max;
    const avg = found ? S.found.reduce((s, f) => s + f.rt, 0) / found : 0;

    let rank;
    if (found + wrong === 0) rank = { name: '通知を眺めていた人', c: '昼休みの過ごし方としては、最も正しいと考えられます。' };
    else if (wrong >= 8 && wrong > found) rank = { name: 'すべてを疑う人', c: 'この評価も疑ってください。' };
    else if (ratio >= 0.8) rank = { name: '特級通知確認士', c: '通知より先に異常に気づいています。通知のほうが気をつけてください。' };
    else if (ratio >= 0.62) rank = { name: '一級通知確認士', c: '業務に支障のない範囲で、すべてを疑っています。' };
    else if (ratio >= 0.45) rank = { name: '二級通知確認士', c: '概ね確認できています。「概ね」の範囲については現在確認中です。' };
    else if (ratio >= 0.3) rank = { name: '通知確認士補（見習い）', c: '読んではいます。' };
    else if (ratio >= 0.15) rank = { name: '既読をつける係', c: '通知は届いています。' };
    else rank = { name: '通知をすべて許可する人', c: '利用規約にも同意していると思われます。' };

    return { found, wrong, missed, total, acc, score, avg, rank, received: S.spawned.length };
  }

  function reviewItem(n, why) {
    const wrap = document.createElement('div'); wrap.className = 'item';
    const c = makeCard(n, ''); wrap.appendChild(c);
    const w = document.createElement('div'); w.className = 'why'; w.textContent = why; wrap.appendChild(w);
    return wrap;
  }

  function countUp(node, to) {
    const t0 = performance.now(), dur = 900;
    const f = (ts) => {
      const p = Math.min(1, (ts - t0) / dur);
      node.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  }

  function showResult() {
    const r = evaluate();
    countUp($('#r-score'), r.score);
    $('#r-rank').textContent = r.rank.name;
    $('#r-comment').innerHTML = `<b>所見</b>${esc(r.rank.c)}`;
    const stat = (k, v, u = '') => `<div><dt>${k}</dt><dd>${v}<small>${u}</small></dd></div>`;
    $('#r-stats').innerHTML =
      stat('届いた通知', r.received, '件') +
      stat('発見した異常', `${r.found} / ${r.total}`, '件') +
      stat('正解率', Math.round(r.acc * 100), '%') +
      stat('平均発見時間', r.found ? r.avg.toFixed(1) : '—', r.found ? '秒' : '') +
      stat('見逃し', r.missed, '件') +
      stat('誤タップ', r.wrong, '件');

    const fill = (sel, items, whyOf) => {
      const box = $(sel); box.innerHTML = '';
      items.forEach((n) => box.appendChild(reviewItem(n, whyOf(n))));
      box.closest('section').hidden = items.length === 0;
    };
    fill('#r-missed', S.missed, (n) => n.why);
    fill('#r-wrong', S.wrong, (n) => n.why || pickOne(PLAIN_NOTES));
    fill('#r-found', S.found, (n) => n.why);
    $('#r-found-n').textContent = S.found.length;
    el.result.scrollTop = 0;
    el.result.hidden = false;
  }

  // ───────── エンディング ─────────
  function ending() {
    el.result.hidden = true;
    el.list.innerHTML = '';
    el.screen.classList.add('dim');
    let i = 0;
    const next = () => {
      if (i >= ENDING.length) { setTimeout(() => { el.final.hidden = false; }, 1400); return; }
      const e = ENDING[i++];
      const c = makeCard({ ...e, body: e.text });
      c.style.cursor = 'default';
      c.classList.add('enter');
      flip(() => el.list.prepend(c));
      sfx.arrive();
      setTimeout(next, e.wait);
    };
    setTimeout(next, 1500);
  }

  function toTitle() {
    S = null;
    el.final.hidden = true; el.result.hidden = true;
    el.list.innerHTML = '';
    el.screen.classList.remove('dim');
    el.focus.classList.remove('on');
    setClock(0); setBattery(34);
    el.title.hidden = false; el.title.scrollTop = 0;
  }

  // ───────── タイトル画面 ─────────
  const SAMPLES = [
    { app: 'hakobi', body: 'お荷物を発送しました。お届け予定：明日 午前中' },
    { app: 'hakobi', body: 'お荷物の配達が完了しました。お届け先：配達員の自宅' },
  ];
  document.querySelectorAll('[data-sample]').forEach((d) => { d.innerHTML = cardHTML(SAMPLES[d.dataset.sample]); });

  const SPEED_LABEL = { slow: 'ゆっくり', normal: 'ふつう', fast: 'せっかち' };
  const optSound = $('#opt-sound'), optSpeed = $('#opt-speed');
  const renderOpts = () => {
    optSound.textContent = '通知音：' + (settings.sound ? 'オン' : 'オフ');
    optSpeed.textContent = '通知の速さ：' + SPEED_LABEL[settings.speed];
  };
  renderOpts();
  optSound.addEventListener('click', () => { settings.sound = !settings.sound; store.set('sound', settings.sound); renderOpts(); });
  optSpeed.addEventListener('click', () => {
    const keys = Object.keys(SPEED_LABEL);
    settings.speed = keys[(keys.indexOf(settings.speed) + 1) % keys.length];
    store.set('speed', settings.speed); renderOpts();
  });
  $('#start').addEventListener('click', start);
  $('#close-report').addEventListener('click', ending);
  $('#again').addEventListener('click', start);
  $('#to-title').addEventListener('click', toTitle);

  // ページ全体のスクロール・ピンチを抑止（結果画面のスクロールは許可）
  document.addEventListener('touchmove', (e) => { if (!e.target.closest('.scroll')) e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturestart', (e) => e.preventDefault());

  setClock(0); setBattery(34);
  rafId = requestAnimationFrame(loop);

  // 検証用
  window.__game = {
    get S() { return S; }, start, finish, ending, toTitle, tap, evaluate,
    advance(sec) { for (let i = 0; i < sec * 20 && S && S.running; i++) { step(0.05); trimOverflow(); } },
    tapAnomalies() { S && S.cards.filter((c) => c.state === 'live' && c.n.k === 'a').forEach(tap); },
    stats() {
      const k = (x) => NOTIFS.filter((n) => n.k === x).length;
      return { anomaly: k('a'), normal: k('n'), quirky: k('q'), t1: NOTIFS.filter((n) => n.t === 1).length, t2: NOTIFS.filter((n) => n.t === 2).length, t3: NOTIFS.filter((n) => n.t === 3).length };
    },
  };
  if (params.has('autostart')) start();
})();
