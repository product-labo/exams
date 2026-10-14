import * as mupdf from 'mupdf';

const CACHE = process.env.OCR_CACHE_DIR || './.ocr-cache';
const MIN_TEXT_PER_PAGE = 40; // fewer characters than this on a page means it is probably an image

const tidy = (t) => t.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

let workerPromise;
async function ocrWorker() {
  workerPromise ??= import('tesseract.js').then(({ createWorker }) => createWorker('eng', 1, { cachePath: CACHE }));
  return workerPromise;
}

/**
 * Extract text from a PDF. Uses the embedded text when a page has some, and OCRs the pages that are images.
 * onProgress(done, total) is called after each page.
 */
export async function extractPdf(buffer, onProgress = () => {}) {
  const doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  const pages = doc.countPages();
  const out = [];
  let ocrPages = 0;
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    let text = tidy(page.toStructuredText('preserve-whitespace').asText());
    if (text.length < MIN_TEXT_PER_PAGE) {
      const pix = page.toPixmap(mupdf.Matrix.scale(2.5, 2.5), mupdf.ColorSpace.DeviceRGB, false, true);
      const png = Buffer.from(pix.asPNG());
      const { data } = await (await ocrWorker()).recognize(png);
      text = tidy(data.text);
      ocrPages++;
    }
    if (text) out.push(text);
    onProgress(i + 1, pages);
  }
  return { text: out.join('\n\n'), pages, ocrPages };
}

export async function shutdownOcr() {
  if (workerPromise) { await (await workerPromise).terminate(); workerPromise = undefined; }
}

// ---------- other formats ----------
const decodeEntities = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

export function htmlToText(html) {
  return tidy(decodeEntities(html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')));
}

async function extractDocx(buffer) {
  const mammoth = (await import('mammoth')).default;
  return tidy((await mammoth.extractRawText({ buffer })).value);
}

async function extractPptx(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1]) - parseInt(b.match(/(\d+)\.xml/)[1]));
  const out = [];
  for (const name of slides) {
    const xml = await zip.files[name].async('string');
    const paras = [...xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)].map((p) => decodeEntities([...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => t[1]).join('')).trim()).filter(Boolean);
    if (paras.length) out.push(paras.join('\n'));
  }
  // Speaker notes often hold the real explanation.
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n))) {
    const xml = await zip.files[name].async('string');
    const t = decodeEntities([...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(' ')).trim();
    if (t.length > 20) out.push(t);
  }
  return tidy(out.join('\n\n'));
}

async function extractImage(buffer) {
  const { data } = await (await ocrWorker()).recognize(buffer);
  return tidy(data.text);
}

export const SUPPORTED = ['pdf', 'txt', 'md', 'docx', 'pptx', 'html', 'htm', 'csv', 'png', 'jpg', 'jpeg'];

/** Extract plain text from an uploaded file, chosen by its extension. */
export async function extractFile(filename, buffer, onProgress = () => {}) {
  const ext = (String(filename).match(/\.([A-Za-z0-9]+)$/)?.[1] || '').toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error(`.${ext || '?'} files are not supported. Use: ${SUPPORTED.join(', ')}. (Save old .doc files as .docx.)`);
  switch (ext) {
    case 'pdf': return (await extractPdf(buffer, onProgress)).text;
    case 'docx': return extractDocx(buffer);
    case 'pptx': return extractPptx(buffer);
    case 'png': case 'jpg': case 'jpeg': return extractImage(buffer);
    case 'html': case 'htm': return htmlToText(buffer.toString('utf8'));
    default: return tidy(buffer.toString('utf8')); // txt, md, csv
  }
}
