import pdf from 'pdf-parse';

const PDF_MAGIC = Buffer.from('%PDF-');

export function isPdfFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) return false;
  const mimeType = String(file.mimetype || '').toLowerCase();
  const fileName = String(file.originalname || file.name || '').toLowerCase();
  const hasPdfExtension = fileName.endsWith('.pdf');
  const hasPdfMime = mimeType === 'application/pdf' || mimeType === 'application/x-pdf';
  const startsWithPdf = file.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  return hasPdfExtension || hasPdfMime || startsWithPdf;
}

export async function extractPdfText(file) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw Object.assign(new Error('A PDF file is required'), { statusCode: 400 });
  if (file.buffer.length === 0 || file.buffer.length > Number(process.env.MAX_UPLOAD_BYTES || 10485760)) throw Object.assign(new Error('PDF exceeds the maximum upload size'), { statusCode: 400 });
  if (!isPdfFile(file) || !file.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) throw Object.assign(new Error('File does not have a valid PDF signature'), { statusCode: 400 });
  const result = await pdf(file.buffer, { max: 100 });
  return result.text;
}