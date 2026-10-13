// Builds ../data/exams.json (+ ../assets/img/) from the cached Tistory posts in .cache/.
// Run `node fetch-cache.mjs` first; this script never hits the blog pages themselves (only images).
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { EXAMS, UA } from './exams.mjs';

const ROOT = new URL('../', import.meta.url);
const CACHE = new URL('./.cache/', import.meta.url);
const IMG_DIR = new URL('assets/img/', ROOT);
const DATA = new URL('data/', ROOT);

const ALLOWED = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'ul', 'ol', 'li', 'pre', 'code', 'img', 'h4', 'blockquote', 'hr']);
// moreLess wrappers are dropped from question HTML; answers are rendered from their .moreless-content directly.
const DROP = 'script, style, ins, iframe, noscript, .revenue_unit_wrap, .btn-toggle-moreless, .another_category, figcaption:empty, [data-ke-type="moreLess"]';
const BLOCKS = new Set(['p', 'table', 'ul', 'ol', 'pre', 'h4', 'blockquote', 'hr', 'figure', 'div']);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clean = (s) => s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();

// Tistory pages pad everything with <p>&nbsp;</p>; a block is "empty" if it has no text and no media.
function isEmpty($, el) {
  const $el = $(el);
  if (el.type === 'text') return !clean(el.data || '');
  if ($el.is('img, pre, table, hr') || $el.find('img, pre, table').length) return false;
  return !clean($el.text());
}

function codeBlock(text) {
  const lines = text.replace(/\u00a0/g, ' ').replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  // Strip the common leading indentation (several posts prefix every line with a space).
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[ ]*/)[0].length));
  return `<pre><code>${esc(lines.map((l) => l.slice(indent)).join('\n'))}</code></pre>`;
}

// ColorScripter widgets are a table row: line numbers | <div> with one <div> per code line | "cs" link.
// Some posts keep the colorscripter-code class, others were pasted without it, so detect by shape.
function isColorScripter($, table) {
  const tds = $(table).find('tr').first().children('td');
  return tds.length >= 2 && /^[\d\s]+$/.test(tds.eq(0).text()) && /\d/.test(tds.eq(0).text());
}

function colorscripter($, table) {
  const td = $(table).find('tr').first().children('td').eq(1);
  const lines = td.children('div').first().children('div').map((_, d) => $(d).text()).get();
  return codeBlock(lines.join('\n'));
}

class Ctx {
  constructor(exam) { this.exam = exam; this.images = []; this.codes = []; }
}

function render($, node, ctx) {
  if (node.type === 'text') return esc(node.data.replace(/\u00a0/g, ' '));
  if (node.type !== 'tag') return '';
  const $n = $(node);
  if ($n.is(DROP)) return '';
  if (node.tagName === 'table' && isColorScripter($, node)) {
    const html = colorscripter($, node);
    ctx.codes.push(cheerio.load(html)('code').text());
    return html;
  }
  if (node.tagName === 'pre') {
    const html = codeBlock($n.text());
    ctx.codes.push(cheerio.load(html)('code').text());
    return html;
  }
  if (node.tagName === 'img') {
    const src = $n.attr('src');
    if (!src || src.includes('no-image')) return '';
    const local = ctx.images.length + 1;
    ctx.images.push({ src: src.startsWith('//') ? `https:${src}` : src, local });
    return `<img data-img="${local}" alt="">`;
  }
  const inner = $n.contents().map((_, c) => render($, c, ctx)).get().join('');
  if (/^h[1-6]$/.test(node.tagName)) return inner.trim() ? `<h4>${inner}</h4>` : '';
  if (!ALLOWED.has(node.tagName)) {
    // Unwrap unknown wrappers; keep block-level separation for div/figure.
    return BLOCKS.has(node.tagName) && inner.trim() ? `<div>${inner}</div>` : inner;
  }
  if (node.tagName === 'p' && !inner.replace(/<br>/g, '').trim()) return '';
  let attrs = '';
  for (const a of ['colspan', 'rowspan']) if ($n.attr(a)) attrs += ` ${a}="${$n.attr(a)}"`;
  if (node.tagName === 'br' || node.tagName === 'hr') return `<${node.tagName}>`;
  return `<${node.tagName}${attrs}>${inner}</${node.tagName}>`;
}

function tidy(html) {
  let prev;
  do {
    prev = html;
    html = html.replace(/<(b|strong|i|em|u|p|div)>\s*<\/\1>/g, '');
  } while (html !== prev);
  // Collapse blank lines between blocks, but never inside <pre> (code keeps its blank lines).
  return html.split(/(<pre>[\s\S]*?<\/pre>)/).map((part, i) => (i % 2 ? part : part.replace(/\n\s*\n+/g, '\n'))).join('').trim();
}

const renderAll = ($, nodes, ctx) => tidy(nodes.map((n) => render($, n, ctx)).join('\n'));

// Like .text() but keeps <br> / block boundaries as newlines.
function textOf($, node) {
  if (node.type === 'text') return node.data;
  const $c = $(node).clone();
  $c.find('br').replaceWith('\n');
  $c.find('p, div, li, tr').append('\n');
  return $c.text();
}

// Answer block = first run of non-empty children; the rest (after the first gap) is explanation.
function splitAnswer($, more, ctx) {
  const kids = $(more).contents().toArray().filter((n) => n.type === 'tag' || clean(n.data || ''));
  let i = 0;
  while (i < kids.length && isEmpty($, kids[i])) i++;
  const ans = [];
  while (i < kids.length && !isEmpty($, kids[i])) ans.push(kids[i++]);
  const rest = kids.slice(i);
  return {
    answerHtml: renderAll($, ans, ctx),
    answerText: ans.map((n) => textOf($, n)).join('\n').split('\n').map(clean).filter(Boolean).join('\n'),
    explainHtml: renderAll($, rest, ctx),
  };
}

function categorize(text, codes) {
  const code = codes.join('\n');
  const head = text.slice(0, 200);
  // The question prompt usually names the language ("다음은 Java 코드에 대한 문제이다"), so trust it first.
  if (/Java(?!\s*Script)|자바(?!\s*스크립트)/i.test(head)) return 'Java';
  if (/Python|파이썬/i.test(head)) return 'Python';
  if (/C\s?언어|C\s?코드|C\s?프로그램/.test(head)) return 'C';
  if (/#include|printf\s*\(|scanf\s*\(|malloc\(/.test(code)) return 'C';
  if (/System\.out|public\s+static|\bclass\s+\w+.*\{/.test(code)) return 'Java';
  if (code && /print\s*\(|\bdef\s+\w+|lambda/.test(code)) return 'Python';
  if (/\bSQL\b/i.test(head) || /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|VIEW|INDEX)|ALTER\s+TABLE|DROP\s+(TABLE|VIEW)|GRANT|REVOKE)\b/i.test(text + '\n' + code)) return 'SQL';
  return '이론';
}

async function downloadImages(exam, images) {
  const dir = new URL(`${exam.id}/`, IMG_DIR);
  await mkdir(dir, { recursive: true });
  const map = new Map();
  for (const img of images) {
    const base = `${img.local}`;
    for (const ext of ['png', 'jpg', 'gif', 'webp']) {
      try { await access(new URL(`${base}.${ext}`, dir)); map.set(img.local, `assets/img/${exam.id}/${base}.${ext}`); } catch { /* try next ext */ }
    }
    if (map.has(img.local)) continue;
    const res = await fetch(img.src, { headers: { 'User-Agent': UA, Referer: exam.source } });
    if (!res.ok) { console.warn(`  ! image ${img.local} HTTP ${res.status}`); continue; }
    const type = res.headers.get('content-type') || '';
    const ext = type.includes('jpeg') ? 'jpg' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : 'png';
    await writeFile(new URL(`${base}.${ext}`, dir), Buffer.from(await res.arrayBuffer()));
    map.set(img.local, `assets/img/${exam.id}/${base}.${ext}`);
  }
  return map;
}

async function scrapeExam(exam) {
  const $ = cheerio.load(await readFile(new URL(`${exam.post}.html`, CACHE), 'utf8'));
  const root = $('.contents_style').first();
  const top = root.children().toArray();
  // Top-level child index holding each answer (moreLess) block.
  const answerIdx = root.find('.moreless-content').toArray().map((m) => top.indexOf($(m).parentsUntil(root).last()[0]));
  const ctx = new Ctx(exam);
  const questions = [];
  const warnings = [];
  // Questions begin after the blog's index table ("클릭하면 해당 페이지로 이동됩니다").
  let from = top.findIndex((el) => $(el).text().includes('클릭하면 해당 페이지로')) + 1;

  answerIdx.forEach((ai, qi) => {
    const no = qi + 1;
    // Some posts nest the 더보기 block inside the code widget; then that element is still question content.
    const holder = top[ai];
    let seg = top.slice(from, $(holder).is('[data-ke-type="moreLess"]') ? ai : ai + 1);
    const startRe = new RegExp(`^\\s*${no}\\s*[.)번]`);
    const s = seg.findIndex((el) => startRe.test(clean($(el).text())));
    if (s >= 0) seg = seg.slice(s);
    else {
      warnings.push(`Q${no}: start marker not found`);
      seg = seg.slice(seg.findIndex((el) => !isEmpty($, el)));
    }
    const qctx = new Ctx(exam);
    // Drop the leading "N." — the app shows its own number. It may sit behind any opening tags / <br>.
    const html = tidy(renderAll($, seg, qctx).replace(new RegExp(`^((?:\\s*<[^>]+>)*\\s*)${no}\\s*[.)번]\\s*`), '$1').replace(/^(<p>)(?:<br>)+/, '$1'));
    const text = clean(seg.map((el) => $(el).text()).join(' ')).replace(startRe, '').trim();
    const ans = splitAnswer($, $(top[ai]).find('.moreless-content')[0], qctx);
    const offset = ctx.images.length;
    const fix = (h) => h.replace(/data-img="(\d+)"/g, (_, n) => `data-img="${+n + offset}"`);
    ctx.images.push(...qctx.images.map((im) => ({ ...im, local: im.local + offset })));
    questions.push({
      id: `${exam.id}-${String(no).padStart(2, '0')}`,
      no,
      category: categorize(text, qctx.codes),
      html: fix(html),
      answerHtml: fix(ans.answerHtml),
      answerText: ans.answerText,
      explainHtml: fix(ans.explainHtml),
    });
    if (!ans.answerText) warnings.push(`Q${no}: empty answer`);
    from = ai + 1;
  });

  const imgMap = await downloadImages(exam, ctx.images);
  const swap = (h) => h.replace(/<img data-img="(\d+)" alt="">/g, (_, n) => (imgMap.has(+n) ? `<img src="${imgMap.get(+n)}" alt="문제 이미지" loading="lazy">` : ''));
  for (const q of questions) for (const k of ['html', 'answerHtml', 'explainHtml']) q[k] = swap(q[k]);
  return { exam: { id: exam.id, year: exam.year, round: exam.round, source: exam.source, questions }, warnings, images: imgMap.size };
}

// Minimal markdown for hand-written solutions: ```code```, **bold**, `code`, "- " lists, blank line = paragraph.
function md(src) {
  const blocks = [];
  const text = src.replace(/\r/g, '').replace(/```\w*\n([\s\S]*?)```/g, (_, code) => `\u0000${blocks.push(code.replace(/\n$/, '')) - 1}\u0000`);
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return text.split(/\n{2,}/).map((para) => {
    // eslint-disable-next-line no-control-regex -- \u0000 is the code-block placeholder delimiter
    const m = para.trim().match(/^\u0000(\d+)\u0000$/);
    if (m) return `<pre><code>${esc(blocks[+m[1]])}</code></pre>`;
    const lines = para.trim().split('\n');
    if (lines.every((l) => /^\s*- /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*- /, ''))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).filter((p) => p !== '<p></p>').join('\n');
}

// data/solutions/<examId>.json: { "07": { solution, answer?, accept?, category? } } — written by hand, verified answers.
async function applySolutions(exam) {
  let sol = {};
  try { sol = JSON.parse(await readFile(new URL(`solutions/${exam.id}.json`, DATA), 'utf8')); } catch { return 0; }
  let n = 0;
  for (const q of exam.questions) {
    const s = sol[String(q.no).padStart(2, '0')];
    if (!s) continue;
    n++;
    if (s.solution) q.solutionHtml = md(s.solution);
    if (s.answer) {
      q.answerFix = q.answerText.replace(/\n/g, ' / ');
      q.answerText = s.answer;
      q.answerHtml = `<p>${s.answer.split('\n').map(esc).join('<br>')}</p>`;
    }
    if (s.accept) q.accept = s.accept;
    if (s.category) q.category = s.category;
  }
  return n;
}

// data/choices/<examId>.json: { "07": [correct, wrong, wrong, wrong] } — 4지선다 practice options, correct one first.
async function applyChoices(exam) {
  let ch = {};
  try { ch = JSON.parse(await readFile(new URL(`choices/${exam.id}.json`, DATA), 'utf8')); } catch { return 0; }
  let n = 0;
  for (const q of exam.questions) {
    const c = ch[String(q.no).padStart(2, '0')];
    if (c) { q.choices = c; n++; }
  }
  return n;
}

let overrides = {};
try { overrides = JSON.parse(await readFile(new URL('overrides.json', DATA), 'utf8')); } catch { /* no overrides */ }

const out = [];
for (const e of EXAMS) {
  const { exam, warnings, images } = await scrapeExam(e);
  const solved = await applySolutions(exam);
  if (solved < exam.questions.length) warnings.push(`solutions: ${solved}/${exam.questions.length}`);
  for (const q of exam.questions) if (overrides[q.id]) Object.assign(q, overrides[q.id]);
  const theory = exam.questions.filter((q) => q.category === '이론').length;
  const mc = await applyChoices(exam);
  if (mc < theory) warnings.push(`choices: ${mc}/${theory} theory`);
  const cats = Object.entries(exam.questions.reduce((m, q) => ((m[q.category] = (m[q.category] || 0) + 1), m), {}))
    .map(([k, v]) => `${k}${v}`).join(' ');
  console.log(`${e.id.padEnd(7)} q=${exam.questions.length} img=${images}  ${cats}${warnings.length ? '\n   ! ' + warnings.join('\n   ! ') : ''}`);
  out.push(exam);
}
await mkdir(DATA, { recursive: true });
await writeFile(new URL('exams.json', DATA), JSON.stringify(out));
console.log(`wrote data/exams.json (${out.reduce((n, e) => n + e.questions.length, 0)} questions)`);
