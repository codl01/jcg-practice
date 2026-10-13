(() => {
  'use strict';

  // ---------- storage (every access guarded: private mode / blocked storage must not break the app) ----------
  // Records carry a timestamp `t` so devices can merge per question (last write wins).
  // Deletions are kept as tombstones ({ del: true, t }) so they propagate through sync.
  const PROGRESS_KEY = 'jcg.progress.v1'; // { [qid]: { s: 'correct'|'wrong', a: myAnswer, t } | { del: true, t } }
  const NOTE_KEY = 'jcg.note.v1';         // 오답노트 — { [qid]: { t } | { del: true, t } }, added/removed only by the user
  const PREFS_KEY = 'jcg.prefs.v1';       // { theme?, cat?, mode?: 'mc'|'text', last?: { id, query } } — per device, not synced
  const SYNC_KEY = 'jcg.sync.v1';         // { token, gistId, login, at } — per device

  const store = {
    read(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
    },
  };

  let progress = store.read(PROGRESS_KEY, {});
  let note = store.read(NOTE_KEY, null);
  if (!note) {
    // One-time migration: before v2, every question graded X was in the 오답노트 automatically.
    note = {};
    for (const [id, r] of Object.entries(progress)) if (r.s === 'wrong') note[id] = { t: r.t || Date.now() };
    store.write(NOTE_KEY, note);
  }
  const prefs = store.read(PREFS_KEY, {});
  const drafts = {}; // unsent answers, kept for this session only

  const live = (r) => r && !r.del;

  function persist() {
    store.write(PROGRESS_KEY, progress);
    store.write(NOTE_KEY, note);
    updateNoteCount();
    sync.schedule();
  }
  const savePrefs = () => store.write(PREFS_KEY, prefs);

  // ---------- data ----------
  const CATS = ['전체', 'C', 'Java', 'Python', 'SQL', '이론'];
  let exams = [];
  const allQuestions = [];
  const questionById = new Map();
  const examById = new Map();

  const examLabel = (e) => `${e.year}년 ${e.round}회`;
  const statusOf = (q) => (live(progress[q.id]) ? progress[q.id].s : null);
  const inNote = (q) => live(note[q.id]);

  function select({ exam, cat, wrong, note: onlyNote }) {
    let qs = exam ? (examById.get(exam) || { questions: [] }).questions : allQuestions;
    if (cat && cat !== '전체') qs = qs.filter((q) => q.category === cat);
    if (wrong) qs = qs.filter((q) => statusOf(q) === 'wrong');
    if (onlyNote) qs = qs.filter(inNote);
    return qs;
  }

  function tally(qs) {
    let correct = 0, wrong = 0;
    for (const q of qs) {
      const s = statusOf(q);
      if (s === 'correct') correct++;
      else if (s === 'wrong') wrong++;
    }
    return { total: qs.length, correct, wrong, solved: correct + wrong };
  }

  function setNote(ids, on) {
    const t = Date.now();
    for (const id of ids) note[id] = on ? { t } : { del: true, t };
    persist();
  }

  // ---------- helpers ----------
  const $app = document.getElementById('app');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plain = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    d.querySelectorAll('pre').forEach((p) => p.replaceWith(' [코드] '));
    d.querySelectorAll('img').forEach((p) => p.replaceWith(' [그림] '));
    return d.textContent.replace(/\s+/g, ' ').trim();
  };
  const timeStr = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  function queryString(params) {
    const sp = new URLSearchParams();
    if (params.exam) sp.set('exam', params.exam);
    if (params.cat && params.cat !== '전체') sp.set('cat', params.cat);
    if (params.wrong) sp.set('wrong', '1');
    if (params.note) sp.set('note', '1');
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs = ''] = raw.split('?');
    const sp = new URLSearchParams(qs);
    return {
      path: path.split('/').filter(Boolean),
      params: { exam: sp.get('exam') || '', cat: sp.get('cat') || '', wrong: sp.get('wrong') === '1', note: sp.get('note') === '1' },
    };
  }

  function bar(t) {
    if (!t.total) return '<div class="bar"></div>';
    return `<div class="bar" role="img" aria-label="정답 ${t.correct}, 오답 ${t.wrong}, 전체 ${t.total}">` +
      `<i class="ok" style="width:${(t.correct / t.total) * 100}%"></i>` +
      `<i class="bad" style="width:${(t.wrong / t.total) * 100}%"></i></div>`;
  }

  function chips(active, counts, attr = 'data-cat') {
    return `<div class="chips" role="group" aria-label="유형 필터">${CATS.map((c) =>
      `<button type="button" class="chip" ${attr}="${c}" aria-pressed="${c === active}">${c}<span class="n">${counts[c] || 0}</span></button>`
    ).join('')}</div>`;
  }

  function catCounts(qs) {
    const m = { 전체: qs.length };
    for (const q of qs) m[q.category] = (m[q.category] || 0) + 1;
    return m;
  }

  function updateNoteCount() {
    const n = allQuestions.filter(inNote).length;
    const el = document.getElementById('note-count');
    el.textContent = n;
    if (n) el.removeAttribute('data-zero'); else el.setAttribute('data-zero', '');
  }

  // ---------- answer matching ----------
  // Normalize so spacing, case, quotes and punctuation don't matter.
  const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[\s'"`‘’“”.,·:;~\-_]/g, '');
  const stripEnum = (line) => line.replace(/^\s*(\(?\d+\)|\d+\s*[.번]|[①-⑳]|[ㄱ-ㅎ]\s*[.)])\s*/, '');
  const noParens = (line) => line.replace(/\([^)]*\)/g, '');
  const onlyParens = (line) => (line.match(/\(([^)]*)\)/) || [null, ''])[1];
  const symbolOf = (line) => (line.match(/^\s*([ㄱ-ㅎ]|[①-⑳])\s*[.)]?/) || [null, ''])[1];

  function variants(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const forms = [(l) => l, stripEnum, (l) => noParens(stripEnum(l)), (l) => onlyParens(stripEnum(l)), symbolOf];
    const out = new Set();
    for (const f of forms) {
      const v = norm(lines.map(f).join(''));
      if (v) out.add(v);
    }
    return out;
  }

  function judge(input, q) {
    const mine = norm(input.split('\n').map(stripEnum).join(''));
    const mineRaw = norm(input);
    if (!mineRaw) return null;
    const ok = variants(q.answerText);
    for (const a of q.accept || []) for (const v of variants(a)) ok.add(v); // extra accepted forms from data/solutions
    return ok.has(mine) || ok.has(mineRaw) ? true : null; // null = can't tell, let the user grade
  }

  // ---------- sync (private GitHub Gist) ----------
  const GIST_FILE = 'jcg-practice-progress.json';
  const sync = {
    cfg: store.read(SYNC_KEY, null),
    timer: null,
    running: null,
    status: '',
    error: '',

    async api(path, opts = {}) {
      const res = await fetch(`https://api.github.com${path}`, {
        ...opts,
        headers: {
          Authorization: `Bearer ${opts.token || this.cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      if (!res.ok) {
        const err = new Error(`GitHub ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.status === 204 ? null : res.json();
    },

    snapshot() {
      return { v: 1, progress, note };
    },

    async connect(token) {
      const user = await this.api('/user', { token });
      let gistId = null;
      for (let page = 1; page <= 5 && !gistId; page++) {
        const list = await this.api(`/gists?per_page=100&page=${page}`, { token });
        const hit = list.find((g) => g.files && g.files[GIST_FILE]);
        if (hit) gistId = hit.id;
        if (list.length < 100) break;
      }
      if (!gistId) {
        const g = await this.api('/gists', {
          token, method: 'POST',
          body: JSON.stringify({
            description: '정보처리기사 실기 풀이 기록 (jcg-practice sync)',
            public: false,
            files: { [GIST_FILE]: { content: JSON.stringify(this.snapshot()) } },
          }),
        });
        gistId = g.id;
      }
      this.cfg = { token, gistId, login: user.login, at: 0 };
      store.write(SYNC_KEY, this.cfg);
      await this.run();
    },

    disconnect() {
      this.cfg = null;
      store.remove(SYNC_KEY);
      this.status = '';
      this.error = '';
      renderSyncState();
    },

    schedule() {
      if (!this.cfg) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), 1500);
    },

    run() {
      if (!this.cfg) return Promise.resolve();
      if (this.running) { this.again = true; return this.running; }
      this.running = this._run().finally(() => {
        this.running = null;
        if (this.again) { this.again = false; this.run(); }
      });
      return this.running;
    },

    async _run() {
      this.status = 'syncing';
      renderSyncState();
      try {
        const g = await this.api(`/gists/${this.cfg.gistId}`);
        const file = g.files[GIST_FILE];
        let remoteText = file ? file.content : '';
        if (file && file.truncated) remoteText = await (await fetch(file.raw_url)).text();
        let remote = { progress: {}, note: {} };
        try { if (remoteText) remote = JSON.parse(remoteText); } catch { /* corrupt gist → overwrite with local */ }

        const merged = { v: 1, progress: merge(progress, remote.progress || {}), note: merge(note, remote.note || {}) };
        const localChanged = JSON.stringify(merged.progress) !== JSON.stringify(progress) || JSON.stringify(merged.note) !== JSON.stringify(note);
        progress = merged.progress;
        note = merged.note;
        store.write(PROGRESS_KEY, progress);
        store.write(NOTE_KEY, note);

        const text = JSON.stringify(merged);
        if (text !== remoteText) {
          await this.api(`/gists/${this.cfg.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: text } } }) });
        }
        this.cfg.at = Date.now();
        store.write(SYNC_KEY, this.cfg);
        this.status = 'ok';
        this.error = '';
        if (localChanged) { updateNoteCount(); rerenderIfIdle(); }
      } catch (e) {
        this.status = 'error';
        this.error = e.status === 401 ? '토큰이 만료되었거나 잘못되었습니다. 다시 연결해 주세요.'
          : e.status === 404 ? '동기화용 Gist를 찾을 수 없습니다. 다시 연결해 주세요.'
          : '동기화에 실패했습니다. 네트워크를 확인해 주세요.';
      }
      renderSyncState();
    },
  };

  function merge(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (!out[k] || (v.t || 0) > (out[k].t || 0)) out[k] = v;
    return out;
  }

  function renderSyncState() {
    const dot = document.getElementById('sync-dot');
    if (dot) {
      dot.dataset.state = sync.cfg ? sync.status || 'ok' : 'off';
      dot.title = !sync.cfg ? '동기화 꺼짐' : sync.status === 'error' ? sync.error : sync.status === 'syncing' ? '동기화 중…' : `동기화됨 ${sync.cfg.at ? timeStr(sync.cfg.at) : ''}`;
    }
    const box = document.getElementById('sync-box');
    if (box) box.innerHTML = syncBoxHtml();
  }

  // After a pull brings in remote changes, refresh list-style views (never the question view mid-answer).
  function rerenderIfIdle() {
    const { path } = parseHash();
    if (path[0] !== 'q') route(true);
  }

  // ---------- views ----------
  function syncBoxHtml() {
    if (!sync.cfg) {
      return `
        <p><strong>모바일·PC 기록 합치기</strong><br>
        GitHub 비공개 Gist에 풀이 기록과 오답노트를 저장해 기기 간에 자동으로 동기화합니다.</p>
        <ol class="steps">
          <li><a href="https://github.com/settings/tokens/new?scopes=gist&description=jcg-practice%20sync" target="_blank" rel="noopener">토큰 만들기 ↗</a> (권한은 <b>gist</b>만, 만료일 원하는 대로)</li>
          <li>생성된 토큰을 아래에 붙여넣고 연결 — 기기마다 한 번만 하면 됩니다.</li>
        </ol>
        <form id="sync-form" class="sync-form">
          <input id="sync-token" type="password" placeholder="ghp_… 토큰 붙여넣기" autocomplete="off" spellcheck="false" required>
          <button class="btn btn-primary btn-sm" type="submit">연결</button>
        </form>
        ${sync.error ? `<p class="sync-err">${esc(sync.error)}</p>` : ''}`;
    }
    const state = sync.status === 'syncing' ? '동기화 중…'
      : sync.status === 'error' ? `<span class="sync-err">${esc(sync.error)}</span>`
      : `동기화됨${sync.cfg.at ? ` · ${timeStr(sync.cfg.at)}` : ''}`;
    return `
      <p><strong>기기 간 동기화 켜짐</strong> · GitHub <b>${esc(sync.cfg.login || '')}</b><br><span class="sub">${state}</span></p>
      <div class="row">
        <button type="button" class="btn btn-sm" id="sync-now">지금 동기화</button>
        <button type="button" class="btn btn-sm btn-ghost" id="sync-off">연결 해제</button>
      </div>`;
  }

  function bindSyncBox() {
    const box = document.getElementById('sync-box');
    if (!box) return;
    box.addEventListener('submit', async (e) => {
      if (e.target.id !== 'sync-form') return;
      e.preventDefault();
      const token = document.getElementById('sync-token').value.trim();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.textContent = '연결 중…';
      try {
        await sync.connect(token);
      } catch (err) {
        sync.error = err.status === 401 ? '토큰이 올바르지 않습니다.' : err.status === 403 || err.status === 404 ? '토큰에 gist 권한이 없습니다.' : '연결에 실패했습니다.';
        renderSyncState();
      }
    });
    box.addEventListener('click', (e) => {
      if (e.target.id === 'sync-now') sync.run();
      if (e.target.id === 'sync-off' && confirm('이 기기의 동기화 연결을 해제할까요? (기록은 이 기기에 그대로 남습니다)')) sync.disconnect();
    });
  }

  function viewHome() {
    const cat = CATS.includes(prefs.cat) ? prefs.cat : '전체';
    const pool = select({ cat });
    const all = tally(allQuestions);
    const rate = all.solved ? Math.round((all.correct / all.solved) * 100) : 0;
    const last = prefs.last && questionById.get(prefs.last.id);
    const noteN = allQuestions.filter(inNote).length;

    const years = [...new Set(exams.map((e) => e.year))].sort((a, b) => b - a);
    const yearHtml = years.map((y) => `
      <section class="year">
        <h2>${y}년</h2>
        <div class="exam-grid">
          ${exams.filter((e) => e.year === y).map((e) => {
            const t = tally(select({ exam: e.id, cat }));
            const done = t.total && t.solved === t.total;
            return `<a class="card exam-card" href="#/list${queryString({ exam: e.id, cat })}">
              ${done ? '<span class="done-badge">완료</span>' : ''}
              <div class="t">${e.round}회</div>
              <div class="m">${t.solved} / ${t.total} 풀이 · 정답 ${t.correct}</div>
              ${bar(t)}
            </a>`;
          }).join('')}
        </div>
      </section>`).join('');

    $app.innerHTML = `
      <div class="hero">
        <div>
          <h1>실기 기출문제</h1>
          <p class="sub">2020 ~ 2026 · ${exams.length}회차 · ${allQuestions.length}문제 · 전 문항 풀이 수록</p>
        </div>
        <div class="stats">
          <div class="card stat"><div class="stat-label">푼 문제</div><div class="stat-value">${all.solved}<small> / ${all.total}</small></div></div>
          <div class="card stat"><div class="stat-label">정답률</div><div class="stat-value">${rate}<small>%</small></div></div>
          <a class="card stat" href="#/list?note=1"><div class="stat-label">오답노트</div><div class="stat-value">${noteN}</div></a>
        </div>
        ${last ? `<a class="card cat-cta" href="#/q/${last.id}${prefs.last.query || ''}">
          <span><strong>이어서 풀기</strong><span class="sub">${esc(examLabel(examById.get(last.examId)))} ${last.no}번 · ${esc(plain(last.html)).slice(0, 40)}</span></span>
          <span class="btn btn-primary btn-sm" aria-hidden="true">계속 →</span></a>` : ''}
      </div>

      <h2>유형별로 보기</h2>
      ${chips(cat, catCounts(allQuestions))}
      ${cat !== '전체' ? `<a class="card cat-cta" href="#/list${queryString({ cat })}">
        <span><strong>${esc(cat)} 문제 모아 풀기</strong><span class="sub">전 회차 ${pool.length}문제 · 정답 ${tally(pool).correct}</span></span>
        <span class="btn btn-primary btn-sm" aria-hidden="true">보기 →</span></a>` : ''}

      ${yearHtml}

      <div class="card settings" id="sync-box">${syncBoxHtml()}</div>

      <div class="card settings">
        <p>풀이 기록은 이 브라우저에 저장되고, 동기화를 켜면 GitHub Gist에도 저장됩니다.</p>
        <button type="button" class="btn btn-sm btn-ghost" id="reset">진행 초기화</button>
      </div>`;

    $app.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      prefs.cat = b.dataset.cat;
      savePrefs();
      viewHome();
    }));
    bindSyncBox();
    document.getElementById('reset').addEventListener('click', () => {
      if (!confirm('모든 풀이 기록과 오답노트를 삭제할까요? 동기화된 다른 기기에서도 삭제됩니다.')) return;
      const t = Date.now();
      for (const id of Object.keys(progress)) progress[id] = { del: true, t };
      for (const id of Object.keys(note)) note[id] = { del: true, t };
      delete prefs.last;
      savePrefs();
      persist();
      viewHome();
    });
  }

  function listTitle(params) {
    if (params.note && !params.exam) return '오답노트';
    const parts = [];
    if (params.exam) parts.push(examLabel(examById.get(params.exam)));
    if (params.cat && params.cat !== '전체') parts.push(params.cat);
    if (params.wrong) parts.push('틀린 문제');
    if (params.note) parts.push('오답노트');
    return parts.join(' · ') || '전체 문제';
  }

  function viewList(params) {
    if (params.exam && !examById.has(params.exam)) return notFound();
    const qs = select(params);
    const t = tally(qs);
    const q0 = params.note ? qs[0] : qs.find((q) => !statusOf(q)) || qs[0];
    const qsBase = queryString(params);
    const basePool = select({ exam: params.exam, note: params.note });
    const isNote = params.note;

    $app.innerHTML = `
      <a class="back" href="#/">← 홈</a>
      <div class="list-head">
        <div>
          <h1>${esc(listTitle(params))}</h1>
          <p class="sub">${t.total}문제 · 정답 ${t.correct} · 오답 ${t.wrong}</p>
        </div>
        <div class="row">
          ${!isNote && t.solved ? `<a class="btn" href="#/result${qsBase}">결과 보기</a>` : ''}
          ${q0 ? `<a class="btn btn-primary" href="#/q/${q0.id}${qsBase}">${isNote ? '다시 풀기' : t.solved && t.solved < t.total ? '이어 풀기' : '풀기 시작'}</a>` : ''}
        </div>
      </div>
      ${chips(params.cat || '전체', catCounts(basePool), 'data-filter')}
      ${isNote && qs.length ? '<p class="sub" style="margin:4px 0 10px">오른쪽 × 버튼으로 오답노트에서 뺄 수 있습니다.</p>' : ''}
      ${qs.length ? `<ul class="card qlist">${qs.map((q) => {
        const s = statusOf(q);
        return `<li data-id="${q.id}"><a href="#/q/${q.id}${qsBase}">
          <span class="qno ${s || ''}">${q.no}</span>
          <span class="qtext">
            <span class="p">${esc(plain(q.html))}</span>
            <span class="meta">${params.exam ? '' : esc(examLabel(examById.get(q.examId))) + ' · '}<span class="tag">${esc(q.category)}</span>${!isNote && inNote(q) ? ' <span class="tag tag-note">오답노트</span>' : ''}</span>
          </span></a>
          ${isNote ? `<button type="button" class="icon-btn del" data-del="${q.id}" aria-label="오답노트에서 삭제" title="오답노트에서 삭제">×</button>` : ''}
        </li>`;
      }).join('')}</ul>
      ${isNote ? '<div class="row" style="justify-content:flex-end;margin-top:10px"><button type="button" class="btn btn-sm btn-ghost" id="note-clear">이 목록 모두 삭제</button></div>' : ''}`
      : `<p class="empty">${isNote ? '오답노트가 비어 있습니다.<br>문제를 푼 뒤 결과 화면이나 문제 화면에서 추가할 수 있어요.' : '해당하는 문제가 없습니다.'}</p>`}`;

    $app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      location.hash = `#/list${queryString({ ...params, cat: b.dataset.filter })}`;
    }));
    $app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      setNote([b.dataset.del], false);
      viewList(params);
    }));
    const clear = document.getElementById('note-clear');
    if (clear) clear.addEventListener('click', () => {
      if (!confirm(`오답노트에서 ${qs.length}문제를 모두 삭제할까요?`)) return;
      setNote(qs.map((q) => q.id), false);
      viewList(params);
    });
  }

  function viewResult(params) {
    const qs = select({ ...params, wrong: false, note: false });
    const t = tally(qs);
    const wrongs = qs.filter((q) => statusOf(q) === 'wrong');
    const rate = t.solved ? Math.round((t.correct / t.solved) * 100) : 0;
    const qsBase = queryString({ exam: params.exam, cat: params.cat });

    $app.innerHTML = `
      <a class="back" href="#/list${qsBase}">← ${esc(listTitle({ exam: params.exam, cat: params.cat }))}</a>
      <h1>풀이 결과</h1>
      <p class="sub">${esc(listTitle({ exam: params.exam, cat: params.cat }))}</p>
      <div class="stats" style="margin-top:14px">
        <div class="card stat"><div class="stat-label">맞힘</div><div class="stat-value" style="color:var(--ok)">${t.correct}</div></div>
        <div class="card stat"><div class="stat-label">틀림</div><div class="stat-value" style="color:var(--bad)">${t.wrong}</div></div>
        <div class="card stat"><div class="stat-label">정답률</div><div class="stat-value">${rate}<small>%</small></div></div>
      </div>
      ${t.total - t.solved ? `<p class="sub" style="margin-top:10px">아직 안 푼 문제 ${t.total - t.solved}개</p>` : ''}

      <h2>오답노트에 넣을 문제 고르기</h2>
      ${wrongs.length ? `
        <form id="pick">
          <ul class="card qlist">${wrongs.map((q) => `
            <li><label class="pick">
              <input type="checkbox" name="q" value="${q.id}" ${inNote(q) ? 'checked disabled' : 'checked'}>
              <span class="qno wrong">${q.no}</span>
              <span class="qtext"><span class="p">${esc(plain(q.html))}</span>
                <span class="meta"><span class="tag">${esc(q.category)}</span>${inNote(q) ? ' <span class="tag tag-note">이미 추가됨</span>' : ''}</span></span>
            </label></li>`).join('')}
          </ul>
          <div class="row" style="margin-top:12px">
            <button type="submit" class="btn btn-primary">선택한 문제 오답노트에 추가</button>
            <a class="btn" href="#/list?note=1">오답노트 보기</a>
          </div>
        </form>`
      : `<p class="empty">${t.solved ? '틀린 문제가 없습니다.' : '아직 채점한 문제가 없습니다.'}</p>`}
      <p class="sub" style="margin-top:14px">맞힌 문제도 각 문제 화면에서 오답노트에 추가할 수 있습니다.</p>`;

    const form = document.getElementById('pick');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ids = [...form.querySelectorAll('input[name=q]:checked:not(:disabled)')].map((i) => i.value);
      if (!ids.length) return;
      setNote(ids, true);
      viewResult(params);
    });
  }

  function viewQuestion(id, params) {
    const q = questionById.get(id);
    if (!q) return notFound();
    const exam = examById.get(q.examId);
    const seq = select(params);
    const pos = seq.indexOf(q);
    // Navigate by global order so it still works after a question leaves the filtered list.
    const prev = [...seq].reverse().find((x) => x.idx < q.idx);
    const next = seq.find((x) => x.idx > q.idx);
    const qs = queryString(params);
    const rec = live(progress[q.id]) ? progress[q.id] : null;
    // 객관식: choices[0] is the correct one; shown in a fresh random order on every visit.
    const hasMc = Array.isArray(q.choices) && q.choices.length > 1;
    let mode = hasMc && prefs.mode !== 'text' ? 'mc' : 'text';
    const order = hasMc ? shuffle(q.choices.map((_, i) => i)) : [];
    let picked = hasMc && rec ? q.choices.indexOf(rec.a) : -1;
    let mcGraded = false;
    const HINTS = {
      text: '띄어쓰기·대소문자는 무시하고 자동 채점하며, 판정이 어려우면 직접 O/X를 고르면 됩니다.',
      mc: '보기를 고르고 정답 확인을 누르면 자동 채점합니다. 숫자 키 1~4로도 고를 수 있어요.',
    };
    const KBD = {
      text: 'Ctrl+Enter 정답 확인 · ← → 이전/다음 문제',
      mc: '1~4 보기 선택 · Enter 정답 확인 · ← → 이전/다음 문제',
    };

    prefs.last = { id: q.id, query: qs };
    savePrefs();

    $app.innerHTML = `
      <div class="q-head">
        <a class="back" href="#/list${qs}" style="margin:0">← ${esc(listTitle(params))}</a>
        <span class="q-pos">${pos >= 0 ? `${pos + 1} / ${seq.length}` : ''}</span>
      </div>
      <div class="q-title">
        <h1>${esc(examLabel(exam))} ${q.no}번</h1>
        <span class="tag">${esc(q.category)}</span>
        <span id="status">${statusBadge(rec)}</span>
      </div>

      <article class="card qbody rich">${q.html}</article>

      <div class="card answer-box">
        <div class="answer-head">
          <label for="my-answer" id="answer-label">내 답</label>
          ${hasMc ? `<div class="seg" role="group" aria-label="풀이 방식">
            <button type="button" data-mode="text" aria-pressed="${mode === 'text'}">주관식</button>
            <button type="button" data-mode="mc" aria-pressed="${mode === 'mc'}">객관식</button>
          </div>` : ''}
        </div>
        <div id="text-pane" ${mode === 'mc' ? 'hidden' : ''}>
          <textarea id="my-answer" placeholder="답을 입력하세요" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(drafts[q.id] ?? (rec ? rec.a : ''))}</textarea>
        </div>
        ${hasMc ? `<div id="mc-pane" class="choices" role="radiogroup" aria-labelledby="answer-label" ${mode === 'text' ? 'hidden' : ''}>
          ${order.map((i, k) => `<button type="button" class="choice" role="radio" data-i="${i}" aria-checked="${i === picked}">
            <span class="num">${'①②③④⑤⑥'[k]}</span><span>${esc(q.choices[i])}</span></button>`).join('')}
        </div>` : ''}
        <div class="grade" style="margin-top:10px">
          <button type="button" class="btn btn-primary" id="check">정답 확인</button>
        </div>
        <p class="hint" id="hint">${HINTS[mode]}</p>
      </div>

      <section class="card reveal" id="reveal" hidden>
        <div id="verdict"></div>
        <p class="ans-label">정답</p>
        <div class="ans rich">${q.answerHtml || esc(q.answerText)}</div>
        ${q.answerFix ? `<p class="fix">원문 정답 정정: ${esc(q.answerFix)}</p>` : ''}
        <p class="my" id="my-echo"></p>
        <div class="grade">
          <button type="button" class="btn btn-ok" data-grade="correct" aria-pressed="${!!rec && rec.s === 'correct'}">O 맞음</button>
          <button type="button" class="btn btn-bad" data-grade="wrong" aria-pressed="${!!rec && rec.s === 'wrong'}">X 틀림</button>
        </div>
        <button type="button" class="btn btn-sm note-toggle" id="note-toggle"></button>
        ${q.solutionHtml ? `<details class="explain" open><summary>풀이</summary><div class="rich">${q.solutionHtml}</div></details>` : ''}
        ${q.explainHtml ? `<details class="explain"><summary>원문 해설</summary><div class="rich">${q.explainHtml}</div></details>` : ''}
        <a class="src" href="${esc(exam.source)}" target="_blank" rel="noopener">원문 보기 ↗</a>
      </section>

      <nav class="qnav" aria-label="문제 이동">
        <a class="btn" ${prev ? `href="#/q/${prev.id}${qs}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>← 이전</a>
        <a class="btn" href="#/list${qs}" aria-label="목록">목록</a>
        ${next ? `<a class="btn" href="#/q/${next.id}${qs}">다음 →</a>`
          : params.note ? '<a class="btn btn-primary" href="#/list?note=1">완료</a>'
          : `<a class="btn btn-primary" href="#/result${queryString({ exam: params.exam, cat: params.cat })}">결과 보기</a>`}
      </nav>
      <p class="kbd-hint" id="kbd-hint">${KBD[mode]}</p>`;

    const ta = document.getElementById('my-answer');
    const reveal = document.getElementById('reveal');
    const verdict = document.getElementById('verdict');
    const gradeBtns = reveal.querySelectorAll('[data-grade]');
    const noteBtn = document.getElementById('note-toggle');

    const paintNote = () => {
      const on = inNote(q);
      noteBtn.textContent = on ? '★ 오답노트에 있음 · 빼기' : '☆ 오답노트에 추가';
      noteBtn.setAttribute('aria-pressed', String(on));
    };
    paintNote();
    noteBtn.addEventListener('click', () => { setNote([q.id], !inNote(q)); paintNote(); });

    ta.addEventListener('input', () => { drafts[q.id] = ta.value; });

    const hint = document.getElementById('hint');
    const mcPane = document.getElementById('mc-pane');
    const choiceBtns = mcPane ? [...mcPane.querySelectorAll('.choice')] : [];

    function setMode(m) {
      mode = m;
      prefs.mode = m;
      savePrefs();
      document.getElementById('text-pane').hidden = m !== 'text';
      mcPane.hidden = m !== 'mc';
      $app.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
      hint.textContent = HINTS[m];
      hint.classList.remove('warn');
      document.getElementById('kbd-hint').textContent = KBD[m];
    }
    $app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    function pick(i) {
      if (mcGraded) return;
      picked = i;
      choiceBtns.forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.i === i)));
      hint.textContent = HINTS.mc;
      hint.classList.remove('warn');
    }
    choiceBtns.forEach((b) => b.addEventListener('click', () => pick(+b.dataset.i)));

    function setGrade(s, answer = mode === 'mc' && picked >= 0 ? q.choices[picked] : ta.value) {
      progress[q.id] = { s, a: answer, t: Date.now() };
      persist();
      gradeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.grade === s)));
      document.getElementById('status').innerHTML = statusBadge(progress[q.id]);
    }

    function checkMc() {
      if (picked < 0) {
        hint.textContent = '보기를 먼저 골라 주세요.';
        hint.classList.add('warn');
        return;
      }
      const ok = picked === 0;
      mcGraded = true;
      mcPane.classList.add('graded');
      choiceBtns.forEach((b) => {
        const i = +b.dataset.i;
        b.classList.toggle('is-correct', i === 0);
        b.classList.toggle('is-wrong', i === picked && !ok);
      });
      document.getElementById('my-echo').textContent = `내 답: ${q.choices[picked]}`;
      verdict.innerHTML = ok
        ? '<div class="verdict correct">정답입니다! 자동으로 채점했어요.</div>'
        : '<div class="verdict wrong">틀렸습니다. 초록색 보기가 정답이에요. 필요하면 아래에서 오답노트에 추가하세요.</div>';
      setGrade(ok ? 'correct' : 'wrong', q.choices[picked]);
      reveal.hidden = false;
      reveal.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function check() {
      if (mode === 'mc') return checkMc();
      const mine = ta.value.trim();
      const auto = judge(mine, q);
      document.getElementById('my-echo').textContent = mine ? `내 답: ${mine}` : '';
      if (auto === true) {
        verdict.innerHTML = '<div class="verdict correct">정답입니다! 자동으로 채점했어요.</div>';
        setGrade('correct');
      } else if (!mine) {
        verdict.innerHTML = '<div class="verdict unknown">답을 입력하지 않았어요. 정답을 보고 직접 O/X를 골라 주세요.</div>';
      } else {
        verdict.innerHTML = '<div class="verdict unknown">정답과 비교해서 직접 O/X를 골라 주세요.</div>';
      }
      reveal.hidden = false;
      reveal.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    document.getElementById('check').addEventListener('click', check);
    gradeBtns.forEach((b) => b.addEventListener('click', () => {
      setGrade(b.dataset.grade);
      verdict.innerHTML = `<div class="verdict ${b.dataset.grade}">${b.dataset.grade === 'correct' ? '맞음으로 기록했어요.' : '틀림으로 기록했어요. 필요하면 아래에서 오답노트에 추가하세요.'}</div>`;
    }));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
    });

    keyNav = (e) => {
      if (e.target.closest('textarea, input') || e.altKey || e.ctrlKey || e.metaKey) return;
      if (mode === 'mc') {
        const k = Number(e.key);
        if (k >= 1 && k <= order.length) { e.preventDefault(); pick(order[k - 1]); return; }
        if (e.key === 'Enter' && !e.target.closest('button, a')) { e.preventDefault(); check(); return; }
      }
      if (e.key === 'ArrowLeft' && prev) location.hash = `#/q/${prev.id}${qs}`;
      if (e.key === 'ArrowRight' && next) location.hash = `#/q/${next.id}${qs}`;
    };
  }

  function statusBadge(rec) {
    if (!rec) return '';
    return rec.s === 'correct' ? '<span class="status correct">맞힘</span>' : '<span class="status wrong">틀림</span>';
  }

  function notFound() {
    $app.innerHTML = '<p class="empty">페이지를 찾을 수 없습니다. <a href="#/">홈으로</a></p>';
  }

  // ---------- router ----------
  let keyNav = null;
  document.addEventListener('keydown', (e) => { if (keyNav) keyNav(e); });

  function route(keepScroll) {
    keyNav = null;
    const { path, params } = parseHash();
    const isQuestion = path[0] === 'q' && path[1];
    document.body.classList.toggle('has-actionbar', !!isQuestion);
    if (!path.length) viewHome();
    else if (path[0] === 'list') viewList(params);
    else if (path[0] === 'result') viewResult(params);
    else if (isQuestion) viewQuestion(path[1], params);
    else notFound();
    if (keepScroll !== true) window.scrollTo(0, 0);
  }

  // ---------- theme ----------
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.dataset.theme = current === 'dark' ? 'light' : 'dark';
    prefs.theme = root.dataset.theme;
    savePrefs();
  });

  // ---------- boot ----------
  fetch('data/exams.json')
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      exams = data;
      let idx = 0;
      for (const e of exams) {
        examById.set(e.id, e);
        for (const q of e.questions) {
          q.examId = e.id;
          q.idx = idx++;
          questionById.set(q.id, q);
          allQuestions.push(q);
        }
      }
      updateNoteCount();
      renderSyncState();
      window.addEventListener('hashchange', () => route());
      route();
      sync.run();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.run(); });
    })
    .catch(() => {
      $app.innerHTML = '<p class="empty">문제 데이터를 불러오지 못했습니다. 새로고침해 주세요.</p>';
    });
})();
