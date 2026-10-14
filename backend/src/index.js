import './config.js'; // must be first: applies defaults and validates the environment
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q, initDb } from './db.js';
import { interpretWithLLM, pickInterpretation, narrate, generateQuestions, llmConfigured } from './agent.js';
import { runGeneration } from './jobs.js';
import { createNonce, verifyLogin, readToken } from './auth.js';
import { resultHash, paymentConfig, verifyPayment, onChainRecord } from './chain.js';
import { ethers } from 'ethers';

const UNPAID_DAYS = Number(process.env.UNPAID_EXPIRY_DAYS || 5);

await initDb(); // wait for Postgres and create the schema on a fresh database

const app = express();
app.set('trust proxy', 1); // behind Render/other proxies, so rate limits see the real client address
app.use(express.json({ limit: '60mb' }));
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(PUBLIC_DIR));
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.code === '23505') return res.status(409).json({ error: 'That already exists (duplicate title or entry).' }); // unique violation
  if (!e.status || e.status >= 500) console.error(e); // expected 4xx errors aren't worth a stack trace
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Internal error' }); // don't leak DB internals
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const GRACE_MS = 1500; // network slack on the server-side deadline

// ---------- rate limit (public endpoints) ----------
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const k = req.ip + req.path, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max ? res.status(429).json({ error: 'Too many requests' }) : next();
};

// ---------- admin ----------
// Only the single wallet in ADMIN_WALLET gets role "admin"; every other wallet is rejected here.
const admin = (req, res, next) => (readToken(req)?.role === 'admin' ? next() : res.status(401).json({ error: 'Admin wallet login required' }));

app.post('/api/auth/nonce', limit(30, 60_000), wrap(async (req, res) => res.json(createNonce(req.body.address))));
app.post('/api/auth/verify', limit(30, 60_000), wrap(async (req, res) => res.json(verifyLogin(req.body.address, req.body.signature))));

app.get('/api/admin/courses', admin, wrap(async (_req, res) => {
  const { rows } = await q(`SELECT c.id,c.title,c.num_questions,c.exam_seconds,c.seconds_per_question,c.max_repeats,c.auto_publish,
    (SELECT count(*) FROM course_materials m WHERE m.course_id=c.id)::int AS modules, count(*) FILTER (WHERE s.status='approved')::int AS approved,
    count(*) FILTER (WHERE s.status='draft')::int AS drafts
    FROM courses c LEFT JOIN questions s ON s.course_id=c.id GROUP BY c.id ORDER BY c.id`);
  res.json(rows);
}));

// Whole-number rule check; undefined means "not provided".
const intIn = (v, min, max, label) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
};
const courseRules = (body) => ({
  title: typeof body.title === 'string' ? body.title.trim().slice(0, 200) : undefined,
  numQuestions: intIn(body.numQuestions, 1, 500, 'Questions per exam'),
  examSeconds: intIn(body.examSeconds, 30, 4 * 3600, 'Exam time'),
  secondsPerQuestion: intIn(body.secondsPerQuestion, 3, 300, 'Seconds per question'),
  maxRepeats: intIn(body.maxRepeats, 0, 5, 'Repeats allowed'),
});

// The answering time alone (questions x seconds each) must fit inside the exam time, or the exam can never be finished.
const checkFits = (numQuestions, examSeconds, secondsPerQuestion) => {
  const need = numQuestions * secondsPerQuestion;
  if (examSeconds < need) throw fail(400, `Exam time is too short: ${numQuestions} questions at ${secondsPerQuestion} s each need at least ${Math.ceil(need / 60)} minutes (reading time is not counted).`);
};

app.post('/api/admin/courses', admin, wrap(async (req, res) => {
  const r = courseRules(req.body);
  if (!r.title) throw fail(400, 'Course title is required');
  checkFits(r.numQuestions ?? 10, r.examSeconds ?? 600, r.secondsPerQuestion ?? 10);
  const { rows } = await q(
    `INSERT INTO courses(title,num_questions,exam_seconds,seconds_per_question,max_repeats) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [r.title, r.numQuestions ?? 10, r.examSeconds ?? 600, r.secondsPerQuestion ?? 10, r.maxRepeats ?? 1]);
  res.status(201).json(rows[0]);
}));

app.put('/api/admin/courses/:id', admin, wrap(async (req, res) => {
  const r = courseRules(req.body);
  if (r.title === '') throw fail(400, 'Course title cannot be empty');
  const { rows: [cur] } = await q(`SELECT num_questions, exam_seconds, seconds_per_question FROM courses WHERE id=$1`, [req.params.id]);
  if (!cur) throw fail(404, 'course not found');
  checkFits(r.numQuestions ?? cur.num_questions, r.examSeconds ?? cur.exam_seconds, r.secondsPerQuestion ?? cur.seconds_per_question);
  const { rows } = await q(
    `UPDATE courses SET title=COALESCE($2,title), num_questions=COALESCE($3,num_questions), exam_seconds=COALESCE($4,exam_seconds),
     seconds_per_question=COALESCE($5,seconds_per_question), max_repeats=COALESCE($6,max_repeats) WHERE id=$1 RETURNING *`,
    [req.params.id, r.title, r.numQuestions, r.examSeconds, r.secondsPerQuestion, r.maxRepeats]);
  if (!rows[0]) throw fail(404, 'course not found');
  res.json(rows[0]);
}));

const validQ = (x) => x.question && Array.isArray(x.options) && x.options.length >= 2 && x.options.length <= 4 &&
  /^[A-D]$/.test(x.correct) && 'ABCD'.indexOf(x.correct) < x.options.length;

async function insertQuestions(courseId, list, status) {
  const ok = list.filter(validQ);
  for (const x of ok) {
    await q(`INSERT INTO questions(course_id,question_text,options,correct_option,status) VALUES($1,$2,$3,$4,$5)`,
      [courseId, x.question, JSON.stringify(x.options), x.correct, status]);
  }
  return ok.length;
}

app.post('/api/admin/courses/:id/questions', admin, wrap(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body.questions;
  const added = await insertQuestions(req.params.id, list || [], 'approved');
  res.status(201).json({ added, rejected: (list || []).length - added });
}));

app.get('/api/admin/courses/:id/questions', admin, wrap(async (req, res) => {
  const { rows } = await q(`SELECT qu.id, qu.question_text, qu.options, qu.correct_option, qu.status, m.filename AS module FROM questions qu LEFT JOIN course_materials m ON m.id=qu.material_id WHERE qu.course_id=$1 ORDER BY qu.id`, [req.params.id]);
  res.json(rows);
}));

app.post('/api/admin/questions/approve', admin, wrap(async (req, res) => {
  const { rowCount } = await q(`UPDATE questions SET status='approved' WHERE id = ANY($1::int[])`, [req.body.ids || []]);
  res.json({ approved: rowCount });
}));

app.delete('/api/admin/questions/:id', admin, wrap(async (req, res) => {
  await q(`DELETE FROM questions WHERE id=$1`, [req.params.id]);
  res.status(204).end();
}));

// Recent voice activity, newest first, for troubleshooting "it does not hear me" reports.
app.get('/api/admin/voice-log', admin, wrap(async (req, res) => {
  const { rows } = await q(`SELECT l.created_at, st.full_name, c.title AS course, l.position, l.heard, l.alternatives, l.action, l.letter
    FROM utterance_log l JOIN exam_sessions es ON es.id=l.session_id JOIN students st ON st.id=es.student_id JOIN courses c ON c.id=es.course_id
    ORDER BY l.id DESC LIMIT $1`, [Math.min(Number(req.query.limit) || 100, 500)]);
  res.json(rows);
}));

// ---------- course modules: each uploaded file is one module ----------
// PDF text extraction (with OCR for image-only pages) is CPU heavy, so files are processed one at a time in the background.
let extractQueue = Promise.resolve();
const queueExtraction = (fn) => (extractQueue = extractQueue.then(fn, fn));
const MIN_MODULE_CHARS = 200;

async function processMaterial(id, filename, buf) {
  try {
    const { extractFile } = await import('./extract.js');
    let last = 0;
    let text = await extractFile(filename, buf, (done, total) => {
      const now = Date.now();
      if (now - last > 1000 || done === total) {
        last = now;
        q(`UPDATE course_materials SET progress_done=$2, progress_total=$3 WHERE id=$1`, [id, done, total]).catch(() => {});
      }
    });
    text = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
    if (text.length < MIN_MODULE_CHARS) throw new Error('Not enough readable text found in this file.');
    await q(`UPDATE course_materials SET text=$2, status='ready', error=NULL WHERE id=$1`, [id, text]);
  } catch (e) {
    console.error('material processing failed:', e.message);
    await q(`UPDATE course_materials SET status='failed', error=$2 WHERE id=$1`, [id, String(e.message).slice(0, 300)]).catch(() => {});
  }
}

// Anything left "processing"/"running" by a restart can never finish, so mark it failed instead of spinning forever.
q(`UPDATE course_materials SET status='failed', error='Interrupted by a restart. Upload the file again.' WHERE status='processing'`).catch(() => {});
q(`UPDATE generation_jobs SET status='failed', error='Interrupted by a restart. Start it again.' WHERE status='running'`).catch(() => {});

app.post('/api/admin/courses/:id/materials', admin, wrap(async (req, res) => {
  const { filename = 'untitled', data = '' } = req.body;
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw fail(400, 'empty file');
  const { rows: [course] } = await q(`SELECT id FROM courses WHERE id=$1`, [req.params.id]);
  if (!course) throw fail(404, 'course not found');
  const { rows: [m] } = await q(`INSERT INTO course_materials(course_id,filename) VALUES($1,$2) RETURNING id, filename, status`, [course.id, String(filename).slice(0, 200)]);
  queueExtraction(() => processMaterial(m.id, filename, buf));
  res.status(202).json(m);
}));

app.get('/api/admin/courses/:id/materials', admin, wrap(async (req, res) => {
  const { rows } = await q(`SELECT m.id, m.filename, m.status, m.error, m.progress_done, m.progress_total, length(m.text) AS chars,
      (SELECT count(*) FROM questions WHERE material_id=m.id)::int AS questions FROM course_materials m WHERE m.course_id=$1 ORDER BY m.id`, [req.params.id]);
  res.json(rows);
}));

// Deleting a module keeps the questions already created from it.
app.delete('/api/admin/courses/:id/materials/:mid', admin, wrap(async (req, res) => {
  await q(`DELETE FROM course_materials WHERE id=$1 AND course_id=$2`, [req.params.mid, req.params.id]);
  res.status(204).end();
}));
app.delete('/api/admin/courses/:id/materials', admin, wrap(async (req, res) => {
  await q(`DELETE FROM course_materials WHERE course_id=$1`, [req.params.id]);
  res.status(204).end();
}));

app.put('/api/admin/courses/:id/auto-publish', admin, wrap(async (req, res) => {
  await q(`UPDATE courses SET auto_publish=$2 WHERE id=$1`, [req.params.id, Boolean(req.body.autoPublish)]);
  res.json({ ok: true });
}));

// Start background generation from one module (materialId) or from every ready module.
app.post('/api/admin/courses/:id/generate', admin, wrap(async (req, res) => {
  if (!llmConfigured()) throw fail(503, 'GEMINI_API_KEY is not set in .env');
  const { rows: [course] } = await q(`SELECT * FROM courses WHERE id=$1`, [req.params.id]);
  if (!course) throw fail(404, 'course not found');
  const materialId = req.body.materialId ? parseInt(req.body.materialId) : null;
  const { rows: mats } = await q(`SELECT id, filename, text FROM course_materials WHERE course_id=$1 AND status='ready' AND ($2::int IS NULL OR id=$2) ORDER BY id`, [course.id, materialId]);
  if (!mats.length) throw fail(409, 'Upload course material first, and wait until it finishes processing.');
  const { rows: [busy] } = await q(`SELECT id FROM generation_jobs WHERE course_id=$1 AND status='running'`, [course.id]);
  if (busy) throw fail(409, 'A generation job is already running for this course');
  const target = Math.min(Math.max(parseInt(req.body.target) || 50, 1), 500);
  // Split the target across modules in proportion to how much material each has.
  const totalChars = mats.reduce((n, m) => n + m.text.length, 0);
  let left = target;
  const plan = mats.map((m, i) => {
    const share = i === mats.length - 1 ? left : Math.min(left, Math.max(1, Math.round((target * m.text.length) / totalChars)));
    left -= share;
    return { id: m.id, filename: m.filename, text: m.text, target: share };
  }).filter((p) => p.target > 0);
  const { rows: [job] } = await q(`INSERT INTO generation_jobs(course_id,target) VALUES($1,$2) RETURNING *`, [course.id, target]);
  runGeneration(job.id, course, plan, req.body.optionCount || 3); // not awaited: runs in the background
  res.status(202).json(job);
}));

app.get('/api/admin/courses/:id/generation', admin, wrap(async (req, res) => {
  const { rows } = await q(`SELECT * FROM generation_jobs WHERE course_id=$1 ORDER BY id DESC LIMIT 1`, [req.params.id]);
  res.json(rows[0] || null);
}));

// AI agent: draft questions from a topic/notes. Saved as drafts until approved.
app.post('/api/admin/generate', admin, wrap(async (req, res) => {
  const { courseId, topic, notes, count = 10, optionCount = 3 } = req.body;
  const list = await generateQuestions(topic, notes, count, optionCount);
  const added = await insertQuestions(courseId, list, 'draft');
  res.status(201).json({ drafted: added });
}));

// ---------- public: courses & results ----------
app.get('/api/courses', wrap(async (_req, res) => {
  const { rows } = await q(`SELECT c.id,c.title,c.num_questions,c.seconds_per_question,c.exam_seconds FROM courses c
    WHERE EXISTS (SELECT 1 FROM questions WHERE course_id=c.id AND status='approved') ORDER BY c.title`);
  res.json(rows);
}));

const RESULT_COLS = `r.session_id, r.wallet, s.full_name, c.title AS course, r.score, r.total_possible, r.percentage, r.completed_at, r.tx_hash, r.chain`;
const explorer = () => process.env.EXPLORER_TX_URL || null;

// Only paid (revealed) results are public.
app.get('/api/results', wrap(async (req, res) => {
  const { rows } = await q(`SELECT ${RESULT_COLS} FROM exam_results r JOIN students s ON s.id=r.student_id JOIN courses c ON c.id=r.course_id
      WHERE r.paid_at IS NOT NULL AND ($1::text IS NULL OR s.full_name ILIKE '%'||$1||'%' OR r.session_id::text=$1 OR lower(r.wallet)=lower($1))
      ORDER BY r.completed_at DESC LIMIT 200`, [req.query.q || null]);
  res.json({ explorerTxUrl: explorer(), results: rows });
}));

// Public page data for site/<wallet address>.
app.get('/api/wallets/:address/results', wrap(async (req, res) => {
  if (!ethers.isAddress(req.params.address)) throw fail(400, 'invalid address');
  const { rows } = await q(`SELECT ${RESULT_COLS} FROM exam_results r JOIN students s ON s.id=r.student_id JOIN courses c ON c.id=r.course_id
      WHERE r.paid_at IS NOT NULL AND lower(r.wallet)=lower($1) ORDER BY r.completed_at DESC`, [req.params.address]);
  res.json({ address: ethers.getAddress(req.params.address), explorerTxUrl: explorer(), results: rows });
}));

// Anyone can verify: recompute the hash from the DB record and compare with the chain.
app.get('/api/results/:sessionId/verify', wrap(async (req, res) => {
  const { rows } = await q(`SELECT * FROM exam_results WHERE session_id=$1 AND paid_at IS NOT NULL`, [req.params.sessionId]);
  const r = rows[0];
  if (!r) throw fail(404, 'result not found');
  const hash = resultHash({ sessionId: r.session_id, courseId: r.course_id, wallet: r.wallet, score: r.score, total: r.total_possible, completedAt: r.completed_at });
  const rec = await onChainRecord(hash).catch(() => null);
  res.json({ hash, hashMatchesStored: hash === r.result_hash,
    onChain: rec === null ? 'chain-not-configured' : rec.anchoredAt > 0 && rec.payer.toLowerCase() === r.wallet.toLowerCase(),
    anchoredAt: rec?.anchoredAt || null, payer: rec?.payer || null, txHash: r.tx_hash, chain: r.chain });
}));

// ---------- exam flow ----------
app.post('/api/register', limit(20, 60_000), wrap(async (req, res) => {
  const wallet = readToken(req)?.addr;
  if (!wallet) throw fail(401, 'Connect your wallet and sign in before starting an exam');
  const name = String(req.body.fullName || '').trim().slice(0, 255);
  if (!name) throw fail(400, 'fullName required');
  const { rows: [course] } = await q(`SELECT * FROM courses WHERE id=$1`, [req.body.courseId]);
  if (!course) throw fail(404, 'course not found');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Random draw: each question appears at most once per attempt.
    const { rows: pick } = await client.query(
      `SELECT id FROM questions WHERE course_id=$1 AND status='approved' ORDER BY random() LIMIT $2`, [course.id, course.num_questions]);
    if (!pick.length) throw fail(409, 'no approved questions for this course');
    const { rows: [st] } = await client.query(`INSERT INTO students(full_name,wallet) VALUES($1,$2) RETURNING id`, [name, wallet]);
    const { rows: [s] } = await client.query(
      `INSERT INTO exam_sessions(student_id,course_id,ends_at,total) VALUES($1,$2, now() + make_interval(secs => $3), $4) RETURNING id, ends_at`,
      [st.id, course.id, course.exam_seconds, pick.length]);
    for (const [i, p] of pick.entries()) {
      await client.query(`INSERT INTO session_questions(session_id,question_id,position) VALUES($1,$2,$3)`, [s.id, p.id, i + 1]);
    }
    await client.query('COMMIT');
    res.status(201).json({ sessionId: s.id, total: pick.length, endsAt: s.ends_at, secondsPerQuestion: course.seconds_per_question,
      say: `Welcome ${name}. This is the ${course.title} exam with ${pick.length} questions. You will have ${course.seconds_per_question} seconds to answer each one after I finish reading it. Say repeat if you need to hear a question again. To answer, say the option letter, like option B, or say alpha, bravo or charlie, or say the answer itself.` });
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}));

async function loadSession(req) {
  const { rows: [s] } = await q(`SELECT s.*, st.wallet, c.seconds_per_question, c.max_repeats, c.title FROM exam_sessions s
    JOIN courses c ON c.id=s.course_id JOIN students st ON st.id=s.student_id WHERE s.id=$1`, [req.params.id]);
  if (!s) throw fail(404, 'session not found');
  const me = readToken(req)?.addr;
  if (!me || me.toLowerCase() !== String(s.wallet).toLowerCase()) throw fail(403, 'This exam session belongs to a different wallet');
  return s;
}

async function finish(sessionId) {
  const { rows: [existing] } = await q(`SELECT * FROM exam_results WHERE session_id=$1`, [sessionId]);
  if (existing) return existing;
  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const { rows: [s] } = await client.query(`SELECT es.*, st.wallet FROM exam_sessions es JOIN students st ON st.id=es.student_id WHERE es.id=$1 FOR UPDATE OF es`, [sessionId]);
    const again = await client.query(`SELECT * FROM exam_results WHERE session_id=$1`, [sessionId]);
    if (again.rows[0]) { await client.query('COMMIT'); return again.rows[0]; }
    await client.query(`UPDATE session_questions SET state='timeout', is_correct=false WHERE session_id=$1 AND state='pending'`, [sessionId]);
    const { rows: [{ score }] } = await client.query(`SELECT count(*) FILTER (WHERE is_correct)::int AS score FROM session_questions WHERE session_id=$1`, [sessionId]);
    // Postgres stores microseconds but the hash uses whole seconds, so truncate to keep verify stable.
    const completedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const hash = resultHash({ sessionId, courseId: s.course_id, wallet: s.wallet, score, total: s.total, completedAt });
    await client.query(`UPDATE exam_sessions SET status='finished', score=$2 WHERE id=$1`, [sessionId, score]);
    const ins = await client.query(
      `INSERT INTO exam_results(session_id,student_id,course_id,wallet,score,total_possible,percentage,completed_at,result_hash,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9, $8::timestamptz + make_interval(days => $10)) RETURNING *`,
      [sessionId, s.student_id, s.course_id, s.wallet, score, s.total, ((score / s.total) * 100).toFixed(2), completedAt, hash, UNPAID_DAYS]);
    await client.query('COMMIT');
    result = ins.rows[0];
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return result;
}

const revealed = (r) => ({ score: r.score, total: r.total_possible, percentage: Number(r.percentage), completedAt: r.completed_at, sessionId: r.session_id, wallet: r.wallet });
const SCORE_LOCKED_SAY = 'The exam is finished. Pay the small fee with your wallet to record your result on the blockchain and reveal your score.';
const doneResponse = (r) => r.paid_at
  ? { done: true, locked: false, say: `The exam is finished. You scored ${r.score} out of ${r.total_possible}.`, result: revealed(r) }
  : { done: true, locked: true, say: SCORE_LOCKED_SAY, sessionId: r.session_id, expiresAt: r.expires_at };

// Time out expired questions; finish if the exam clock ran out.
async function sweep(s) {
  await q(`UPDATE session_questions SET state='timeout', is_correct=false WHERE session_id=$1 AND state='pending' AND deadline < now()`, [s.id]);
  if (s.status === 'finished' || new Date(s.ends_at) <= new Date()) return finish(s.id);
  return null;
}

async function currentQuestion(sessionId) {
  const { rows } = await q(`SELECT sq.*, qu.question_text, qu.options, qu.correct_option FROM session_questions sq JOIN questions qu ON qu.id=sq.question_id
    WHERE sq.session_id=$1 AND sq.state='pending' ORDER BY sq.position LIMIT 1`, [sessionId]);
  return rows[0];
}

// Step 1: get the next question to read aloud. The countdown has NOT started yet.
app.post('/api/sessions/:id/next', wrap(async (req, res) => {
  const s = await loadSession(req);
  const done = await sweep(s);
  if (done) return res.json(doneResponse(done));
  const cur = await currentQuestion(s.id);
  if (!cur) {
    const r = await finish(s.id);
    return res.json(doneResponse(r));
  }
  if (!cur.served_at) await q(`UPDATE session_questions SET served_at=now() WHERE id=$1`, [cur.id]);
  res.json({ done: false, position: cur.position, total: s.total, question: cur.question_text, options: cur.options,
    repeatsLeft: Math.max(0, s.max_repeats - cur.repeats_used), secondsPerQuestion: s.seconds_per_question, examEndsAt: s.ends_at,
    say: narrate(cur.position, s.total, cur.question_text, cur.options) });
}));

// How long reading a question aloud may reasonably take (a very slow voice is ~6 characters a second), capped at 90 s.
const narrationAllowanceSec = (text) => Math.min(90, Math.ceil(text.length / 6) + 8);

// Step 2: narration finished -> start the server-side countdown.
// The countdown starts when the student's browser reports the reading is done, but never later than the allowance after the question
// was served. The time spent reading is added back to the exam clock, so long questions do not eat the student's answering time.
app.post('/api/sessions/:id/ready', wrap(async (req, res) => {
  const s = await loadSession(req);
  const cur = await currentQuestion(s.id);
  if (!cur) throw fail(409, 'no pending question');
  const allowance = narrationAllowanceSec(narrate(cur.position, s.total, cur.question_text, cur.options));
  const client = await pool.connect();
  let deadline;
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(`SELECT served_at, deadline FROM session_questions WHERE id=$1 FOR UPDATE`, [cur.id]);
    if (row.deadline) { deadline = row.deadline; }
    else {
      const { rows: [t] } = await client.query(
        `WITH st AS (SELECT LEAST(now(), $2::timestamptz + make_interval(secs => $3)) AS start_at)
         UPDATE exam_sessions es SET ends_at = es.ends_at + (st.start_at - $2::timestamptz) FROM st WHERE es.id=$1
         RETURNING es.ends_at, st.start_at`, [s.id, row.served_at, allowance]);
      const { rows: [d] } = await client.query(
        `UPDATE session_questions SET deadline = LEAST($2::timestamptz + make_interval(secs => $3), $4::timestamptz) WHERE id=$1 RETURNING deadline`,
        [cur.id, t.start_at, s.seconds_per_question, t.ends_at]);
      deadline = d.deadline;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ deadline, msLeft: Math.max(0, new Date(deadline) - Date.now()) });
}));

// Student's browser reports a speech problem (blocked microphone, no speech, network...) so it can be diagnosed later.
app.post('/api/sessions/:id/voice-event', limit(60, 60_000), wrap(async (req, res) => {
  const s = await loadSession(req);
  const kind = String(req.body.kind || 'unknown').slice(0, 60);
  q(`INSERT INTO utterance_log(session_id, heard, action) VALUES($1,$2,$3)`, [s.id, String(req.body.detail || '').slice(0, 200), 'client:' + kind]).catch(() => {});
  res.status(204).end();
}));

// Step 3: student speech (or typed fallback) as text.
app.post('/api/sessions/:id/utterance', wrap(async (req, res) => {
  const s = await loadSession(req);
  if (s.status === 'finished' || new Date(s.ends_at) <= new Date()) {
    await finish(s.id);
    return res.json({ action: 'timeout', done: true });
  }
  const cur = await currentQuestion(s.id);
  if (!cur) throw fail(409, 'no pending question');
  if (!cur.deadline) throw fail(409, 'countdown not started');
  if (Date.now() > new Date(cur.deadline).getTime() + GRACE_MS) {
    await q(`UPDATE session_questions SET state='timeout', is_correct=false WHERE id=$1`, [cur.id]);
    return res.json({ action: 'timeout', done: false });
  }

  const text = String(req.body.text || '').slice(0, 300);
  const alternatives = (Array.isArray(req.body.alternatives) ? req.body.alternatives : []).slice(0, 5).map((x) => String(x).slice(0, 300));
  const candidates = [text, ...alternatives];
  let r = pickInterpretation(candidates, cur.options);
  if (r.intent === 'unknown' && text.trim()) {
    const heard = [...new Set(candidates.filter(Boolean))].join(' / ');
    r = await interpretWithLLM(heard, cur.question_text, cur.options).catch(() => r);
  }

  q(`INSERT INTO utterance_log(session_id, position, heard, alternatives, action, letter) VALUES($1,$2,$3,$4,$5,$6)`,
    [s.id, cur.position, text, JSON.stringify(alternatives), r.intent, r.letter || null]).catch(() => {});
  if (r.intent === 'repeat') {
    if (cur.repeats_used >= s.max_repeats) return res.json({ action: 'no_repeats', say: 'Sorry, no more repeats for this question.' });
    await q(`UPDATE session_questions SET repeats_used=repeats_used+1, deadline=NULL, served_at=now() WHERE id=$1`, [cur.id]); // reading restarts; countdown starts after re-reading
    return res.json({ action: 'repeat', say: narrate(cur.position, s.total, cur.question_text, cur.options, { isRepeat: true }) });
  }
  if (r.intent === 'answer') {
    const correct = r.letter === cur.correct_option;
    await q(`UPDATE session_questions SET answer=$2, is_correct=$3, state='answered' WHERE id=$1`, [cur.id, r.letter, correct]);
    return res.json({ action: 'answered', letter: r.letter, say: `Answer ${r.letter} recorded.` });
  }
  res.json({ action: 'unclear', say: 'Sorry, I did not catch that.' });
}));

// The signed-in student's own results: paid ones with scores, unpaid (not yet expired) ones without.
app.get('/api/me/results', wrap(async (req, res) => {
  const me = readToken(req)?.addr;
  if (!me) throw fail(401, 'Sign in with your wallet first');
  const { rows } = await q(`SELECT r.session_id, r.wallet, c.title AS course, r.completed_at, r.paid_at, r.expires_at, r.tx_hash,
      CASE WHEN r.paid_at IS NOT NULL THEN r.score END AS score,
      CASE WHEN r.paid_at IS NOT NULL THEN r.total_possible END AS total,
      CASE WHEN r.paid_at IS NOT NULL THEN r.percentage END AS percentage
    FROM exam_results r JOIN courses c ON c.id=r.course_id
    WHERE lower(r.wallet)=lower($1) AND (r.paid_at IS NOT NULL OR r.expires_at > now())
    ORDER BY r.completed_at DESC LIMIT 50`, [me]);
  res.json({
    explorerTxUrl: explorer(),
    results: rows.map((r) => ({
      sessionId: r.session_id, wallet: r.wallet, course: r.course, completedAt: r.completed_at, paid: Boolean(r.paid_at),
      expiresAt: r.expires_at, txHash: r.tx_hash, score: r.score, total: r.total, percentage: r.percentage === null ? null : Number(r.percentage),
    })),
  });
}));

// Payment details for the finished exam (browser builds approve + payAndAnchor from this).
app.get('/api/sessions/:id/payment', wrap(async (req, res) => {
  const s = await loadSession(req);
  const { rows: [r] } = await q(`SELECT * FROM exam_results WHERE session_id=$1`, [s.id]);
  if (!r) throw fail(409, 'exam not finished');
  if (r.paid_at) return res.json({ paid: true });
  if (new Date(r.expires_at) < new Date()) throw fail(410, 'This result has expired and can no longer be paid for');
  const cfg = await paymentConfig();
  if (!cfg) throw fail(503, 'blockchain payment is not configured');
  res.json({ paid: false, hash: r.result_hash, expiresAt: r.expires_at, ...cfg });
}));

// After the student's payAndAnchor tx: verify it on-chain, then reveal the score.
app.post('/api/sessions/:id/confirm', wrap(async (req, res) => {
  const s = await loadSession(req);
  const { rows: [r] } = await q(`SELECT * FROM exam_results WHERE session_id=$1`, [s.id]);
  if (!r) throw fail(409, 'exam not finished');
  if (r.paid_at) return res.json(revealed(r));
  const txHash = String(req.body.txHash || '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw fail(400, 'txHash required');
  const v = await verifyPayment(txHash, r.result_hash, s.wallet);
  if (!v.ok) throw fail(402, v.reason);
  const { rows: [paid] } = await q(`UPDATE exam_results SET paid_at=now(), tx_hash=$2, chain=$3 WHERE session_id=$1 RETURNING *`,
    [s.id, txHash, process.env.CHAIN_NAME || 'base']);
  res.json(revealed(paid));
}));

// Unpaid results expire after UNPAID_DAYS.
setInterval(() => q(`DELETE FROM exam_results WHERE paid_at IS NULL AND expires_at < now()`).catch((e) => console.error('expiry sweep', e.message)), 3600_000);

// Public result pages live at /<wallet address>.
app.get(/^\/0x[0-9a-fA-F]{40}$/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wallet.html')));

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log('Voice exam backend on :' + PORT));
