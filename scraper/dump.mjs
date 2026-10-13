// Prints an exam's questions as plain text for review. Usage: node dump.mjs <examId> [--explain]
import { readFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

const [id, flag] = process.argv.slice(2);
const exams = JSON.parse(await readFile(new URL('../data/exams.json', import.meta.url), 'utf8'));
const exam = exams.find((e) => e.id === id);

const text = (html) => {
  const $ = cheerio.load(`<div id="r">${html}</div>`);
  $('pre').each((_, p) => { $(p).replaceWith(`\n\`\`\`\n${$(p).text()}\n\`\`\`\n`); });
  $('img').each((_, i) => { $(i).replaceWith(`[IMG ${$(i).attr('src')}]`); });
  $('br').replaceWith('\n');
  $('p, div, tr, li, h4').append('\n');
  $('td, th').append(' | ');
  return $('#r').text().replace(/\n{3,}/g, '\n\n').trim();
};

for (const q of exam.questions) {
  console.log(`\n### ${q.id} [${q.category}]`);
  console.log(text(q.html));
  console.log(`>>> ANSWER: ${q.answerText.replace(/\n/g, ' / ')}`);
  if (flag === '--explain' && q.explainHtml) console.log(`>>> BLOG: ${text(q.explainHtml).slice(0, 400)}`);
}
