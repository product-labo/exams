import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { extractFile, htmlToText } from './extract.js';

async function makeDocx(paragraphs) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makePptx(slides, notes = []) {
  const zip = new JSZip();
  slides.forEach((lines, i) => zip.file(`ppt/slides/slide${i + 1}.xml`,
    `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${lines.map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`));
  notes.forEach((n, i) => zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, `<p:notes xmlns:a="a" xmlns:p="p"><a:p><a:r><a:t>${n}</a:t></a:r></a:p></p:notes>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('docx text is extracted in order', async () => {
  const text = await extractFile('Lesson 1.DOCX', await makeDocx(['Chapter one: cells', 'Mitochondria produce energy.']));
  assert.match(text, /Chapter one: cells/);
  assert.ok(text.indexOf('Chapter one') < text.indexOf('Mitochondria'));
});

test('pptx slides are read in numeric order, with speaker notes and entities decoded', async () => {
  const buf = await makePptx([['Slide A title'], ['Slide B &amp; more']], ['These speaker notes explain slide B in some detail.']);
  const text = await extractFile('deck.pptx', buf);
  assert.ok(text.indexOf('Slide A title') < text.indexOf('Slide B & more'));
  assert.match(text, /speaker notes explain/);
});

test('pptx with 10+ slides sorts numerically, not alphabetically', async () => {
  const buf = await makePptx(Array.from({ length: 11 }, (_, i) => [`slide number ${i + 1}`]));
  const text = await extractFile('big.pptx', buf);
  assert.ok(text.indexOf('slide number 2') < text.indexOf('slide number 10'));
});

test('html: tags, scripts and styles are dropped, entities decoded', async () => {
  const t = htmlToText('<style>p{color:red}</style><h1>Title</h1><p>Fish &amp; chips</p><script>alert(1)</script><ul><li>one</li><li>two</li></ul>');
  assert.match(t, /Title/); assert.match(t, /Fish & chips/);
  assert.doesNotMatch(t, /alert|color:red|<p>/);
  assert.match(t, /one\s+two/);
});

test('txt, md and csv pass through', async () => {
  assert.equal(await extractFile('a.txt', Buffer.from('hello  world')), 'hello world');
  assert.match(await extractFile('a.csv', Buffer.from('term,definition\nrecall,true positives')), /recall,true positives/);
});

test('unsupported and extension-less files give a clear error', async () => {
  await assert.rejects(() => extractFile('old.doc', Buffer.from('x')), /not supported.*\.docx/s);
  await assert.rejects(() => extractFile('noext', Buffer.from('x')), /not supported/);
  await assert.rejects(() => extractFile('virus.exe', Buffer.from('x')), /not supported/);
});

test('corrupt docx fails instead of hanging', async () => {
  await assert.rejects(() => extractFile('broken.docx', Buffer.from('this is not a zip file')));
});
