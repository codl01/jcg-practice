// Compiles and runs every C/Java/Python code question and compares stdout with the stored answer.
// Needs gcc, javac/java and python on PATH. Usage: node verify-code.mjs [examId-prefix]
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as cheerio from 'cheerio';

const only = process.argv[2] || '';
const WORK = new URL('./.verify/', import.meta.url);
const exams = JSON.parse(await readFile(new URL('../data/exams.json', import.meta.url), 'utf8'));
const squash = (s) => s.normalize('NFKC').replace(/\s+/g, '');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 8000, input: '', shell: false });
  return { code: r.status, out: (r.stdout || '').replace(/\r/g, ''), err: (r.stderr || '') + (r.error ? String(r.error) : '') };
}

// Name of the class that declares main (nested classes become Outer$Inner).
function javaMainClass(src) {
  const stack = [];
  let pending = null;
  let depth = 0;
  const re = /\b(class|interface|enum|record)\s+(\w+)|static\s+void\s+main\s*\(|[{}]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  for (const m of src.matchAll(re)) {
    const t = m[0];
    if (m[1]) pending = m[2];
    else if (t === '{') { depth++; if (pending) { stack.push({ name: pending, depth }); pending = null; } }
    else if (t === '}') { if (stack.length && stack.at(-1).depth === depth) stack.pop(); depth--; }
    else if (t.startsWith('static')) return stack.map((s) => s.name).join('$');
  }
  return null;
}

const results = [];
for (const exam of exams) {
  if (!exam.id.startsWith(only)) continue;
  for (const q of exam.questions) {
    if (!['C', 'Java', 'Python'].includes(q.category)) continue;
    const $ = cheerio.load(q.html);
    const codes = $('pre').map((_, p) => $(p).text()).get();
    if (!codes.length) { results.push({ q, status: 'NO_CODE' }); continue; }
    const src = codes.sort((a, b) => b.length - a.length)[0];
    const dir = new URL(`${q.id}/`, WORK);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const cwd = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
    let r;
    if (q.category === 'C') {
      await writeFile(new URL('main.c', dir), src.includes('#include') ? src : `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n${src}`);
      r = run('gcc', ['-w', '-fpermissive', '-std=gnu11', '-o', 'main.exe', 'main.c'], cwd);
      if (r.code === 0) r = run(`${cwd}main.exe`, [], cwd); else r.compile = true;
    } else if (q.category === 'Java') {
      const pub = src.match(/public\s+(?:final\s+|abstract\s+)*class\s+(\w+)/);
      await writeFile(new URL(`${pub ? pub[1] : 'Main'}.java`, dir), src);
      r = run('javac', ['-nowarn', '-encoding', 'UTF-8', '-d', '.', `${pub ? pub[1] : 'Main'}.java`], cwd);
      const main = javaMainClass(src);
      if (r.code === 0 && main) r = run('java', ['-Dstdout.encoding=UTF-8', '-cp', '.', main], cwd);
      else r.compile = true;
    } else {
      await writeFile(new URL('main.py', dir), src);
      r = run('python', ['-X', 'utf8', 'main.py'], cwd);
    }
    const status = r.compile ? 'COMPILE_ERR' : r.code !== 0 && !r.out ? 'RUNTIME_ERR' : squash(r.out) === squash(q.answerText) ? 'MATCH' : 'DIFF';
    results.push({ q, status, out: r.out, err: r.err });
  }
}

const by = (s) => results.filter((r) => r.status === s);
for (const r of results.filter((x) => x.status !== 'MATCH')) {
  console.log(`\n[${r.status}] ${r.q.id} (${r.q.category})`);
  console.log(`  answer: ${JSON.stringify(r.q.answerText)}`);
  if (r.out !== undefined) console.log(`  stdout: ${JSON.stringify(r.out.slice(0, 300))}`);
  if (r.status !== 'DIFF' && r.err) console.log(`  stderr: ${r.err.split('\n').filter(Boolean).slice(0, 3).join(' | ').slice(0, 300)}`);
}
console.log(`\nMATCH ${by('MATCH').length} · DIFF ${by('DIFF').length} · COMPILE_ERR ${by('COMPILE_ERR').length} · RUNTIME_ERR ${by('RUNTIME_ERR').length} · NO_CODE ${by('NO_CODE').length}`);
await writeFile(new URL('report.json', WORK), JSON.stringify(results.map(({ q, ...r }) => ({ id: q.id, ...r })), null, 1));
