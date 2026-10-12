// Downloads each exam post once into .cache/<postId>.html (skips already-cached posts).
import { mkdir, writeFile, access } from 'node:fs/promises';
import { EXAMS, UA } from './exams.mjs';

const CACHE = new URL('./.cache/', import.meta.url);
await mkdir(CACHE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const e of EXAMS) {
  const file = new URL(`${e.post}.html`, CACHE);
  try { await access(file); continue; } catch {}
  const res = await fetch(`https://chobopark.tistory.com/${e.post}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) { console.error(`${e.id}: HTTP ${res.status}`); continue; }
  await writeFile(file, await res.text());
  console.log(`${e.id}: cached`);
  await sleep(1000);
}
