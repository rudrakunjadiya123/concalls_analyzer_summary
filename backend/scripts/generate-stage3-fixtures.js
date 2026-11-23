import { mkdir, writeFile } from "node:fs/promises";
import {
  columns,
  makeFixturePdf,
  transcriptPages,
} from "./stage3-pdf-fixtures.js";

const output = new URL("../fixtures/pdf/stage3/", import.meta.url);
const fixtures = {
  "single-column": makeFixturePdf(transcriptPages()),
  "two-columns": makeFixturePdf(columns),
  "long-call": makeFixturePdf(
    Array.from({ length: 42 }, (_, index) => [
      [
        44,
        720,
        `Page-specific fictional text sample ${index + 1} about conference call handling.`,
      ],
      [
        44,
        690,
        "Management: These statements are used only for local text extraction tests.",
      ],
    ]),
  ),
  "scanned-image": makeFixturePdf([["IMAGE"]]),
  empty: makeFixturePdf([[]]),
  corrupt: Buffer.from("%PDF-1.4\nInvalid local test container\n%%EOF\n"),
  "audio-notice": makeFixturePdf([
    [[44, 724, "Synthetic audio recording of earnings call now available."]],
  ]),
};

await mkdir(output, { recursive: true });
await Promise.all(
  Object.entries(fixtures).map(([name, bytes]) =>
    writeFile(new URL(`${name}.pdf`, output), bytes),
  ),
);
