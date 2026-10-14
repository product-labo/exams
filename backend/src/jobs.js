import { q } from './db.js';
import { generateQuestions, answerBlind } from './agent.js';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Randomise where the correct answer sits so letters don't cluster (LLMs favour A and B).
 * Left alone when an option refers to the others ("All of the above", "Both A and B"), since shuffling would break its meaning.
 */
export function shuffleOptions(x, rand = Math.random) {
  const refersToOthers = /\b(all|none|both|either|neither)\b.*\b(above|these|options?)\b|\b(options?|choices?)\s+[A-D]\b|\b[A-D]\s+(and|or|&)\s+[A-D]\b/i;
  if (x.options.some((o) => refersToOthers.test(o))) return x;
  const idx = x.options.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const k = Math.floor(rand() * (i + 1)); [idx[i], idx[k]] = [idx[k], idx[i]]; }
  const correctAt = idx.indexOf('ABCD'.indexOf(x.correct));
  return { ...x, options: idx.map((i) => x.options[i]), correct: 'ABCD'[correctAt] };
}

/** Split course material into ~3000-char chunks on paragraph boundaries. */
export function chunkText(text, size = 3000) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > size) { out.push(cur); cur = ''; }
    cur += (cur ? '\n\n' : '') + para;
    while (cur.length > size * 1.5) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const PER_CALL = 10;

const CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY || 3));

/**
 * Background job: generate verified, de-duplicated questions. `plan` is [{ id, filename, text, target }], one entry per module;
 * each module's target is spread evenly over its chunks so the whole material is covered, not just the start.
 * Several batches run at the same time; rate limits are handled by retries inside the LLM client.
 */
export async function runGeneration(jobId, course, plan, optionCount = 3) {
  try {
    const existing = await q(`SELECT question_text FROM questions WHERE course_id=$1`, [course.id]);
    const seen = new Set(existing.rows.map((r) => norm(r.question_text)));
    const status = course.auto_publish ? 'approved' : 'draft';
    let created = 0;

    // One batch: write questions from a chunk, drop duplicates, keep only those an independent answer agrees with, save them.
    const runBatch = async (item, chunk, want, topic) => {
      let batch = (await generateQuestions(topic, chunk, want, optionCount)).filter((x) => !seen.has(norm(x.question)));
      if (batch.length) {
        const blind = await answerBlind(batch).catch(() => null);
        if (blind) batch = batch.filter((x, i) => blind[i] === x.correct);
      }
      let added = 0;
      for (const x of batch) {
        if (seen.has(norm(x.question)) || item.got >= item.target) continue; // re-check: another batch may have just added it
        seen.add(norm(x.question));
        const s = shuffleOptions(x);
        await q(`INSERT INTO questions(course_id,question_text,options,correct_option,status,material_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [course.id, s.question, JSON.stringify(s.options), s.correct, status, item.id]);
        added++; item.got++; created++;
      }
      return added;
    };

    for (const item of plan) {
      item.got = 0;
      const chunks = chunkText(item.text);
      const quota = Math.min(PER_CALL, Math.max(1, Math.ceil(item.target / chunks.length)));
      const topic = `${course.title} - ${item.filename.replace(/\.[^.]+$/, '')}`;
      let next = 0, dryRounds = 0;

      while (item.got < item.target && dryRounds < 3) {
        const remaining = item.target - item.got;
        const n = Math.min(CONCURRENCY, Math.ceil(remaining / quota));
        const tasks = [];
        for (let i = 0; i < n; i++) {
          // ask for a little extra, since verification rejects some
          const want = Math.min(PER_CALL, Math.min(quota, Math.ceil(remaining / n)) + 1);
          tasks.push(runBatch(item, chunks[next++ % chunks.length], want, topic));
        }
        const results = await Promise.allSettled(tasks);
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length === results.length) throw failed[0].reason; // every batch failed: surface the real error
        const added = results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0);
        dryRounds = added ? 0 : dryRounds + 1;
        await q(`UPDATE generation_jobs SET created=$2 WHERE id=$1`, [jobId, created]);
      }
    }
    await q(`UPDATE generation_jobs SET status='done', created=$2 WHERE id=$1`, [jobId, created]);
  } catch (e) {
    console.error('generation failed', e.message);
    await q(`UPDATE generation_jobs SET status='failed', error=$2 WHERE id=$1`, [jobId, e.message]);
  }
}
