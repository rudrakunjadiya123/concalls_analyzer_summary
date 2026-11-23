import { mkdir, writeFile } from "node:fs/promises";
import { makeFixturePdf } from "./stage3-pdf-fixtures.js";

const output = new URL("../fixtures/pdf/stage5/", import.meta.url);
await mkdir(output, { recursive: true });
// The two local versions contain explicitly fictional figures and the same verified call identity.
for (const [file, amount] of [
  ["replay-call", "₹430 crore"],
  ["replay-correction", "₹440 crore"],
]) {
  await writeFile(
    new URL(`${file}.pdf`, output),
    makeFixturePdf(
      [
        [
          [40, 745, "SYNTHETIC DEMO ONLY - NO REAL COMPANY RESULTS"],
          [40, 716, "Synthetic Industrial Earnings Conference Call Q3 FY27"],
          [40, 685, "Call held on 17 November 2026"],
          [40, 650, "Moderator: Welcome to this fictional earnings call."],
          [
            40,
            620,
            `Management: Consolidated revenue was ${amount} in Q3 FY27.`,
          ],
          [
            40,
            594,
            "Management: Standalone operating margin was 11.0% in Q3 FY27.",
          ],
          [
            40,
            568,
            "Management: The Industrial segment shipped its fictional backlog.",
          ],
          [
            40,
            542,
            "Management: Supplier interruption remains a material risk.",
          ],
          [40, 511, "Question and Answer Session"],
          [
            40,
            483,
            "Analyst: How did management measure the fictional operating margin?",
          ],
          [
            40,
            455,
            "Management: The measure uses the standalone reporting basis.",
          ],
        ],
      ],
      { wrapper: file },
    ),
  );
}
