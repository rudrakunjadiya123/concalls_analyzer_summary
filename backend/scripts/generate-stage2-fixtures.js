import { mkdir, writeFile } from "node:fs/promises";

const output = new URL("../fixtures/pdf/", import.meta.url);
const examples = {
  transcript: [
    "SYNTHETIC TEST DATA - NO REAL COMPANY OR EARNINGS",
    "Moderator: Welcome to this fictional test call.",
    "Management: This statement exists to test document handling.",
    "Analyst: Is this a real earnings call?",
    "Management: This is a generated software fixture.",
  ],
  "cover-letter": [
    "SYNTHETIC COVER LETTER - SOFTWARE TEST FIXTURE",
    "This notice refers to a fictional transcript hosted elsewhere.",
    "The letter contains no transcript dialogue or financial statements.",
  ],
};

// Generate a one-page ASCII PDF with byte-exact cross-reference offsets, without external assets.
function pdf(lines) {
  const content = [
    "BT /F1 12 Tf 48 740 Td",
    ...lines.map((line, index) => `${index ? "0 -20 Td " : ""}(${line}) Tj`),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((value, index) => {
    const offset = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  return `${body}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

await mkdir(output, { recursive: true });
await Promise.all(
  Object.entries(examples).map(([name, content]) =>
    writeFile(new URL(`synthetic-${name}.pdf`, output), pdf(content)),
  ),
);
