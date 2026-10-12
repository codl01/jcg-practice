(() => {
  'use strict';

  // ---------- storage (every access guarded: private mode / blocked storage must not break the app) ----------
  const PROGRESS_KEY = 'jcg.progress.v1'; // { [questionId]: { s: 'correct' | 'wrong', a: myAnswer, t: epochMs } }
  const PREFS_KEY = 'jcg.prefs.v1';       // { theme?: 'light'|'dark', cat?: string, last?: { id, query } }

  const store = {
    read(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  let progress = store.read(PROGRESS_KEY, {});
  const prefs = store.read(PREFS_KEY, {});
  const drafts = {}; // unsent answers, kept for this session only

  const saveProgress = () => { store.write(PROGRESS_KEY, progress); updateWrongCount(); };
  const savePrefs = () => store.write(PREFS_KEY, prefs);

  // ---------- data ----------
  const CATS = ['전체', 'C', 'Java', 'Python', 'SQL', '이론'];
  let exams = [];
  let allQuestions = [];
  const questionById = new Map();
  const examById = new Map();

  const examLabel = (e) => `${e.year}년 ${e.round}회`;
  const statusOf = (q) => (progress[q.id] ? progress[q.id].s : null);

  function select({ exam, cat, wrong }) {
    let qs = exam ? (examById.get(exam) || { questions: [] }).questions : allQuestions;
    if (cat && cat !== '전체') qs = qs.filter((q) => q.category === cat);
    if (wrong) qs = qs.filter((q) => statusOf(q) === 'wrong');
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

  // ---------- helpers ----------
  const $app = document.getElementById('app');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plain = (html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    d.querySelectorAll('pre').forEach((p) => p.replaceWith(' [코드] '));
    return d.textContent.replace(/\s+/g, ' ').trim();
  };

  function queryString(params) {
    const sp = new URLSearchParams();
    if (params.exam) sp.set('exam', params.exam);
    if (params.cat && params.cat !== '전체') sp.set('cat', params.cat);
    if (params.wrong) sp.set('wrong', '1');
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs = ''] = raw.split('?');
    const sp = new URLSearchParams(qs);
    return {
      path: path.split('/').filter(Boolean),
      params: { exam: sp.get('exam') || '', cat: sp.get('cat') || '', wrong: sp.get('wrong') === '1' },
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

  function updateWrongCount() {
    const n = allQuestions.filter((q) => statusOf(q) === 'wrong').length;
    const el = document.getElementById('wrong-count');
    el.textContent = n;
    if (n) el.removeAttribute('data-zero'); else el.setAttribute('data-zero', '');
  }

  // ---------- answer matching ----------
  // Normalize so spacing, case, quotes and punctuation don't matter.
  const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[\s'"`‘’“”.,·:;~\-_]/g, '');
  const stripEnum = (line) => line.replace(/^\s*(\(?\d+\)|\d+\s*[.번]|[①-⑳]|[ㄱ-ㅎ]\s*[.)])\s*/, '');
  const noParens = (line) => line.replace(/\([^)]*\)/g, '');
  const onlyParens = (line) => (line.match(/\(([^)]*)\)/) || [, ''])[1];
  const symbolOf = (line) => (line.match(/^\s*([ㄱ-ㅎ]|[①-⑳])\s*[.)]?/) || [, ''])[1];

  function variants(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const forms = [
      (l) => l,
      stripEnum,
      (l) => noParens(stripEnum(l)),
      (l) => onlyParens(stripEnum(l)),
      symbolOf,
    ];
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
    return ok.has(mine) || ok.has(mineRaw) ? true : null; // null = can't tell, let the user grade
  }

  // ---------- views ----------
  function viewHome() {
    const cat = CATS.includes(prefs.cat) ? prefs.cat : '전체';
    const pool = select({ cat });
    const all = tally(allQuestions);
    const rate = all.solved ? Math.round((all.correct / all.solved) * 100) : 0;
    const last = prefs.last && questionById.get(prefs.last.id);

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
          <p class="sub">2020 ~ 2026 · ${exams.length}회차 · ${allQuestions.length}문제</p>
        </div>
        <div class="stats">
          <div class="card stat"><div class="stat-label">푼 문제</div><div class="stat-value">${all.solved}<small> / ${all.total}</small></div></div>
          <div class="card stat"><div class="stat-label">정답률</div><div class="stat-value">${rate}<small>%</small></div></div>
          <div class="card stat"><div class="stat-label">오답</div><div class="stat-value">${all.wrong}</div></div>
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

      <div class="card settings">
        <p>풀이 기록은 이 브라우저(localStorage)에 저장됩니다.</p>
        <button type="button" class="btn btn-sm btn-ghost" id="reset">진행 초기화</button>
      </div>`;

    $app.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => {
      prefs.cat = b.dataset.cat;
      savePrefs();
      viewHome();
    }));
    document.getElementById('reset').addEventListener('click', () => {
      if (!confirm('모든 풀이 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
      progress = {};
      delete prefs.last;
      saveProgress();
      savePrefs();
      viewHome();
    });
  }

  function listTitle(params) {
    if (params.wrong && !params.exam) return '오답노트';
    const parts = [];
    if (params.exam) parts.push(examLabel(examById.get(params.exam)));
    if (params.cat && params.cat !== '전체') parts.push(params.cat);
    if (params.wrong) parts.push('오답');
    return parts.join(' · ') || '전체 문제';
  }

  function viewList(params) {
    if (params.exam && !examById.has(params.exam)) return notFound();
    const qs = select(params);
    const t = tally(qs);
    const q0 = qs.find((q) => !statusOf(q)) || qs[0];
    const qsBase = queryString(params);
    const examPool = params.exam ? select({ exam: params.exam }) : allQuestions;
    const wrongHere = !params.wrong && select({ ...params, wrong: true }).length;

    $app.innerHTML = `
      <a class="back" href="#/">← 홈</a>
      <div class="list-head">
        <div>
          <h1>${esc(listTitle(params))}</h1>
          <p class="sub">${t.total}문제 · 정답 ${t.correct} · 오답 ${t.wrong}</p>
        </div>
        ${q0 ? `<a class="btn btn-primary" href="#/q/${q0.id}${qsBase}">${t.solved && t.solved < t.total ? '이어 풀기' : '풀기 시작'}</a>` : ''}
      </div>
      ${params.wrong ? '' : chips(params.cat || '전체', catCounts(examPool), 'data-filter')}
      ${wrongHere ? `<p><a href="#/list${queryString({ ...params, wrong: true })}">오답 ${wrongHere}문제만 다시 풀기 →</a></p>` : ''}
      ${qs.length ? `<ul class="card qlist">${qs.map((q) => {
        const s = statusOf(q);
        return `<li><a href="#/q/${q.id}${qsBase}">
          <span class="qno ${s || ''}">${q.no}</span>
          <span class="qtext">
            <span class="p">${esc(plain(q.html))}</span>
            <span class="meta">${params.exam ? '' : esc(examLabel(examById.get(q.examId))) + ' · '}<span class="tag">${esc(q.category)}</span></span>
          </span></a></li>`;
      }).join('')}</ul>` : `<p class="empty">${params.wrong ? '오답노트가 비어 있습니다.' : '해당하는 문제가 없습니다.'}</p>`}`;

    $app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
      location.hash = `#/list${queryString({ ...params, cat: b.dataset.filter })}`;
    }));
  }

  function viewQuestion(id, params) {
    const q = questionById.get(id);
    if (!q) return notFound();
    const exam = examById.get(q.examId);
    const seq = select(params);
    const pos = seq.indexOf(q);
    // Navigate by global order so it still works after a question leaves the filtered list (e.g. 오답 → 정답).
    const prev = [...seq].reverse().find((x) => x.idx < q.idx);
    const next = seq.find((x) => x.idx > q.idx);
    const qs = queryString(params);
    const rec = progress[q.id];

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
        <label for="my-answer">내 답</label>
        <textarea id="my-answer" placeholder="답을 입력하세요" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(drafts[q.id] ?? (rec ? rec.a : ''))}</textarea>
        <div class="grade" style="margin-top:10px">
          <button type="button" class="btn btn-primary" id="check">정답 확인</button>
        </div>
        <p class="hint">띄어쓰기·대소문자는 무시하고 자동 채점하며, 판정이 어려우면 직접 O/X를 고르면 됩니다.</p>
      </div>

      <section class="card reveal" id="reveal" hidden>
        <div id="verdict"></div>
        <p class="ans-label">정답</p>
        <div class="ans rich">${q.answerHtml || esc(q.answerText)}</div>
        <p class="my" id="my-echo"></p>
        <div class="grade">
          <button type="button" class="btn btn-ok" data-grade="correct" aria-pressed="${rec && rec.s === 'correct'}">O 맞음</button>
          <button type="button" class="btn btn-bad" data-grade="wrong" aria-pressed="${rec && rec.s === 'wrong'}">X 틀림</button>
        </div>
        ${q.explainHtml ? `<details class="explain"><summary>해설 보기</summary><div class="rich">${q.explainHtml}</div></details>` : ''}
        <a class="src" href="${esc(exam.source)}" target="_blank" rel="noopener">원문 보기 ↗</a>
      </section>

      <nav class="qnav" aria-label="문제 이동">
        <a class="btn" ${prev ? `href="#/q/${prev.id}${qs}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>← 이전</a>
        <a class="btn" href="#/list${qs}" aria-label="목록">목록</a>
        <a class="btn" ${next ? `href="#/q/${next.id}${qs}"` : 'aria-disabled="true" style="opacity:.4;pointer-events:none"'}>다음 →</a>
      </nav>
      <p class="kbd-hint">Ctrl+Enter 정답 확인 · ← → 이전/다음 문제</p>`;

    const ta = document.getElementById('my-answer');
    const reveal = document.getElementById('reveal');
    const verdict = document.getElementById('verdict');
    const gradeBtns = reveal.querySelectorAll('[data-grade]');

    ta.addEventListener('input', () => { drafts[q.id] = ta.value; });

    function setGrade(s) {
      progress[q.id] = { s, a: ta.value, t: Date.now() };
      saveProgress();
      gradeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.grade === s)));
      document.getElementById('status').innerHTML = statusBadge(progress[q.id]);
    }

    function check() {
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
      verdict.innerHTML = `<div class="verdict ${b.dataset.grade}">${b.dataset.grade === 'correct' ? '맞음으로 기록했어요.' : '틀림으로 기록했어요. 오답노트에 추가됩니다.'}</div>`;
    }));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
    });

    keyNav = (e) => {
      if (e.target.closest('textarea, input') || e.altKey || e.ctrlKey || e.metaKey) return;
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

  function route() {
    keyNav = null;
    const { path, params } = parseHash();
    const isQuestion = path[0] === 'q' && path[1];
    document.body.classList.toggle('has-actionbar', !!isQuestion);
    if (!path.length) viewHome();
    else if (path[0] === 'list') viewList(params);
    else if (isQuestion) viewQuestion(path[1], params);
    else notFound();
    window.scrollTo(0, 0);
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
      // Drop progress for questions that no longer exist (e.g. after a re-scrape changed ids).
      for (const id of Object.keys(progress)) if (!questionById.has(id)) delete progress[id];
      updateWrongCount();
      window.addEventListener('hashchange', route);
      route();
    })
    .catch(() => {
      $app.innerHTML = '<p class="empty">문제 데이터를 불러오지 못했습니다. 새로고침해 주세요.</p>';
    });
})();
