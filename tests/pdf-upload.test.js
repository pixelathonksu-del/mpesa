import test from 'node:test';
import assert from 'node:assert/strict';
import { isPdfFile } from '../pdf.js';

test('accepts PDFs when browser reports octet-stream but filename is .pdf', () => {
  const file = {
    originalname: 'customers.pdf',
    mimetype: 'application/octet-stream',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF')
  };

  assert.equal(isPdfFile(file), true);
});

test('rejects non-PDF files', () => {
  const file = {
    originalname: 'notes.txt',
    mimetype: 'text/plain',
    buffer: Buffer.from('hello world')
  };

  assert.equal(isPdfFile(file), false);
});
