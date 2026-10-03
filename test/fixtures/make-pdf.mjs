// Gera o PDF de teste do sandbox (duas páginas, texto simples, sem dependências).
//   node test/fixtures/make-pdf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox', 'media', 'documento.pdf');

const page = (text, n) => `BT /F1 26 Tf 72 740 Td (${text}) Tj ET\nBT /F1 14 Tf 72 700 Td (Pagina ${n} de 2 - gerado por test/fixtures/make-pdf.mjs) Tj ET\n`;
const streams = [page('Documento de teste do Claude Deck', 1), page('Segunda pagina do PDF de teste', 2)];

const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  `<< /Length ${Buffer.byteLength(streams[0], 'latin1')} >>\nstream\n${streams[0]}endstream`,
  `<< /Length ${Buffer.byteLength(streams[1], 'latin1')} >>\nstream\n${streams[1]}endstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(Buffer.byteLength(pdf, 'latin1'));
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, pdf, 'latin1');
console.log(`${out} (${Buffer.byteLength(pdf, 'latin1')} bytes)`);
