// The exam agent: decides what to say and interprets what the student said.
// Audio I/O stays in the browser; this module is the "brain" and runs in the backend.

// Speech engines are poor at single letters ("B" comes back as "be", "bee", "P"...), so real words are accepted too.
const LETTER_WORDS = {
  a: 'A', ay: 'A', eh: 'A', alpha: 'A', first: 'A',
  b: 'B', be: 'B', bee: 'B', bravo: 'B', second: 'B',
  c: 'C', see: 'C', sea: 'C', cee: 'C', charlie: 'C', third: 'C',
  d: 'D', dee: 'D', delta: 'D', fourth: 'D',
};
// Numbers only count after a lead-in word ("option two"): on their own they usually mean the answer text ("2").
const NUMBER_WORDS = { 1: 'A', one: 'A', 2: 'B', two: 'B', 3: 'C', three: 'C', 4: 'D', four: 'D' };
const HOMOPHONE_NUMBERS = { to: 'B', too: 'B', for: 'D' }; // only after a strong lead-in, so "it is for sure" is not an answer
const keys = (...objs) => objs.flatMap((o) => Object.keys(o)).join('|');
const STRONG_RE = new RegExp(/\b(?:option|answer|letter|choice|number)\s+(?:is\s+)?(WORDS)\b/.source.replace('WORDS', keys(LETTER_WORDS, NUMBER_WORDS, HOMOPHONE_NUMBERS)));
// Weaker lead-ins also occur in ordinary sentences, so a bare "a" ("it is a ...") never counts here.
const WEAK_LETTERS = Object.fromEntries(Object.entries(LETTER_WORDS).filter(([k]) => !["a", "ay", "eh"].includes(k)));
const WEAK_RE = new RegExp(/\b(?:select|pick|its|it is|i choose|i pick|i say)\s+(WORDS)\b/.source.replace('WORDS', keys(WEAK_LETTERS, NUMBER_WORDS)));
const REPEAT_RE = /\b(repeat|again|say that|read (it|that)|pardon|sorry|(dont|do not|didnt|did not) (understand|get|catch|hear))\b/;

const clean = (s) => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const SMALL_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
// "two" and "2" mean the same thing when the answer text is a number.
const digitize = (t) => t.split(' ').map((w) => (SMALL_NUMBERS.includes(w) ? String(SMALL_NUMBERS.indexOf(w)) : w)).join(' ');
const ORDINAL_RE = /\b(first|second|third|fourth)\b/;

/** Turn a transcript into { intent: 'repeat'|'answer'|'unknown', letter? } */
export function interpret(transcript, options) {
  const t = clean(transcript || '');
  if (!t) return { intent: 'unknown' };
  if (REPEAT_RE.test(t)) return { intent: 'repeat' };
  const letters = 'ABCD';
  const valid = (l) => l && letters.indexOf(l) < options.length;

  // 1. An explicit lead-in ("option b", "answer charlie", "option two") names a position and wins.
  const strong = t.match(STRONG_RE);
  if (strong) {
    const l = LETTER_WORDS[strong[1]] || NUMBER_WORDS[strong[1]] || HOMOPHONE_NUMBERS[strong[1]];
    if (valid(l)) return { intent: 'answer', letter: l };
  }

  // 2. Spoken option text ("paris", "2"), longest match wins.
  const spoken = [t, digitize(t)].map((s) => ` ${s} `);
  const hits = options
    .map((o, i) => ({ letter: letters[i], text: digitize(clean(o)) }))
    .filter((o) => o.text && spoken.some((s) => s.includes(` ${o.text} `)))
    .sort((x, y) => y.text.length - x.text.length);
  if (hits.length === 1 || (hits.length > 1 && hits[0].text.length > hits[1].text.length)) {
    return { intent: 'answer', letter: hits[0].letter };
  }

  // 3. Weaker lead-ins: "its bravo", "I pick c".
  const weak = t.match(WEAK_RE);
  if (weak) {
    const l = LETTER_WORDS[weak[1]] || NUMBER_WORDS[weak[1]];
    if (valid(l)) return { intent: 'answer', letter: l };
  }

  // 4. Short utterances: "b", "bee", "bravo", "second", "the first one" (kept short to avoid a stray "a" in a sentence).
  const words = t.split(' ');
  if (words.length <= 2) {
    for (const w of words) { const l = LETTER_WORDS[w]; if (valid(l)) return { intent: 'answer', letter: l }; }
  }
  const ord = words.length <= 4 && t.match(ORDINAL_RE);
  if (ord && valid(LETTER_WORDS[ord[1]])) return { intent: 'answer', letter: LETTER_WORDS[ord[1]] };
  return { intent: 'unknown' };
}

/** The browser returns several candidate transcripts; use the first one that makes sense as an answer or a repeat request. */
export function pickInterpretation(candidates, options) {
  const seen = new Set();
  for (const c of candidates) {
    const key = clean(String(c || ''));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const r = interpret(c, options);
    if (r.intent !== 'unknown') return { ...r, heard: c };
  }
  return { intent: 'unknown' };
}

/** Optional LLM fallback for messy transcripts. Returns same shape as interpret(). */
export async function interpretWithLLM(transcript, question, options) {
  if (!process.env.GEMINI_API_KEY) return { intent: 'unknown' };
  const prompt = `Exam question: ${question}\nOptions: ${options.map((o, i) => 'ABCD'[i] + ') ' + o).join(' | ')}\nStudent said: "${transcript}"\nReply with exactly one token: A, B, C, D, REPEAT (student wants it repeated or does not understand) or NONE.`;
  const out = (await gemini(prompt)).trim().toUpperCase();
  if (out === 'REPEAT') return { intent: 'repeat' };
  if (/^[A-D]$/.test(out) && 'ABCD'.indexOf(out) < options.length) return { intent: 'answer', letter: out };
  return { intent: 'unknown' };
}

/** Script the browser reads aloud. */
export function narrate(position, total, question, options, { isRepeat = false } = {}) {
  const head = isRepeat ? 'Repeating the question. ' : `Question ${position} of ${total}. `;
  const opts = options.map((o, i) => `Option ${'ABCD'[i]}: ${o}.`).join(' ');
  return `${head}${question} ${opts}`;
}

/** Ask the LLM for draft questions from notes or a topic. Admin must approve them. */
export async function generateQuestions(topic, notes, count = 10, optionCount = 3) {
  const prompt = `Write ${count} multiple-choice exam questions about "${topic}"${notes ? ' based ONLY on these notes:\n' + notes.slice(0, 12000) : ''}.
Each question has exactly ${optionCount} options and one correct option letter.
The questions are READ ALOUD to students, so keep them short and easy to follow by ear: the question at most 20 words, each option at most 7 words, never "all of the above", "none of the above" or "both A and B", and no options that are long lists or contain tables, code or symbols.
Return ONLY JSON: [{"question":"...","options":["..",".."],"correct":"A"}]`;
  const raw = await gemini(prompt, true);
  const list = JSON.parse(raw.replace(/^```json|```$/gm, '').trim());
  return list
    .filter((x) => x.question && Array.isArray(x.options) && /^[A-D]$/.test(x.correct))
    .map((x) => ({ question: x.question, options: x.options.slice(0, 4), correct: x.correct }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let thinkingSupported = true; // some models reject thinkingConfig; remember once we know

/**
 * Call Gemini. Extra "thinking" is switched off because question writing doesn't need it and it roughly doubles latency.
 * Rate limits (429) and brief outages (5xx) are retried with exponential back-off, so callers can run several requests at once.
 */
async function gemini(prompt, json = false) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  for (let attempt = 0; ; attempt++) {
    const generationConfig = { ...(json ? { responseMimeType: 'application/json' } : {}), ...(thinkingSupported ? { thinkingConfig: { thinkingBudget: 0 } } : {}) };
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }) });
    } catch (e) {
      if (attempt >= 4) throw new Error('LLM request failed: ' + e.message);
      await sleep(1500 * 2 ** attempt); continue;
    }
    if (res.ok) {
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    }
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 400 && thinkingSupported && /thinking/i.test(detail)) { thinkingSupported = false; continue; } // retry once without it
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      await sleep(Math.min(wait, 30_000) + Math.random() * 500);
      continue;
    }
    throw new Error(`LLM error ${res.status}${res.status === 429 ? ' (rate limit: try again in a few minutes)' : ''}`);
  }
}

/** Independent check: the LLM answers each question without seeing the key. Returns the letters it chose. */
export async function answerBlind(list) {
  const body = list.map((x, i) => `${i + 1}. ${x.question} ${x.options.map((o, j) => 'ABCD'[j] + ') ' + o).join(' | ')}`).join('\n');
  const raw = await gemini(`Answer each multiple-choice question using only your knowledge. Return ONLY a JSON array of letters, one per question, in order, e.g. ["A","C"].\n${body}`, true);
  const arr = JSON.parse(raw.replace(/^```json|```$/gm, '').trim());
  return Array.isArray(arr) ? arr.map((x) => String(x).toUpperCase()) : [];
}

export const llmConfigured = () => Boolean(process.env.GEMINI_API_KEY);
