// Deliberately authored PDF streams exercise ordering and fonts independently of an HTML renderer.
function stream(text) {
  return `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`;
}

/** Generate fictional PDF pages with ordered content-stream commands and explicit glyph maps. */
export function makeFixturePdf(pages, { wrapper = "" } = {}) {
  const objects = ["", ""];
  const add = (value) => objects.push(value);
  const latinFont = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const rupee = add(
    stream(
      "600 0 0 0 600 800 d1\n65 w\n120 700 m 520 700 l S\n120 505 m 520 505 l S\n170 700 m 490 700 485 330 170 330 c 490 65 l S",
    ),
  );
  const minus = add(stream("600 0 0 0 600 800 d1\n75 w\n80 360 m 520 360 l S"));
  const toUnicode = add(
    stream(
      [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Synthetic) /Ordering (Glyphs) /Supplement 0 >> def",
        "/CMapName /SyntheticGlyphs def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<00> <FF>",
        "endcodespacerange",
        "2 beginbfchar",
        "<01> <20B9>",
        "<02> <2212>",
        "endbfchar",
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
      ].join("\n"),
    ),
  );
  const glyphFont = add(`<< /Type /Font /Subtype /Type3 /FontBBox [0 0 600 800]
    /FontMatrix [.001 0 0 .001 0 0] /CharProcs << /R ${rupee} 0 R /M ${minus} 0 R >>
    /Encoding << /Type /Encoding /Differences [1 /R /M] >> /FirstChar 1 /LastChar 2 /Widths [600 600]
    /Resources << >> /ToUnicode ${toUnicode} 0 R >>`);
  const image = add(
    "<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 129 >>\nstream\n" +
      "cccccccc".repeat(16) +
      ">\nendstream",
  );
  const kids = pages.map((rows) => {
    const content = rows
      .map((row) => {
        if (row === "IMAGE") return "q 460 0 0 500 76 150 cm /Scan Do Q";
        const [x, y, message, size = 11] = row;
        const pieces = message
          .split(/([₹−])/u)
          .filter(Boolean)
          .map((piece) => {
            const special = ["₹", "−"].includes(piece);
            const encoded = special
              ? piece === "₹"
                ? "01"
                : "02"
              : Buffer.from(
                  piece.replaceAll("’", "\x92").replaceAll("–", "\x96"),
                  "latin1",
                ).toString("hex");
            return `/${special ? "Glyph" : "F1"} ${size} Tf <${encoded}> Tj`;
          });
        return `BT 1 0 0 1 ${x} ${y} Tm ${pieces.join(" ")} ET`;
      })
      .join("\n");
    const contents = add(stream(content));
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <<
      /Font << /F1 ${latinFont} 0 R /Glyph ${glyphFont} 0 R >> /XObject << /Scan ${image} 0 R >>
      >> /Contents ${contents} 0 R >>`);
  });
  objects[0] = "<< /Type /Catalog /Pages 2 0 R /Lang (en-IN) >>";
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let pdf = `%PDF-1.4\n% Synthetic layout fixture ${wrapper}\n`;
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf, "latin1");
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  return Buffer.from(
    `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    "latin1",
  );
}

/** Two-page fictional transcript with a split turn, numeric table, and recurring page furniture. */
export function transcriptPages({
  title = "Synthetic Consumer Earnings Conference Call Q2 FY 2026-27",
  date = "Call held on 26 October 2026",
  figure = "₹1,200.00 crore",
  issuer = "",
} = {}) {
  const top = [44, 765, "SYNTHETIC LAYOUT FIXTURE", 9];
  const foot = [44, 26, "Fictional test document | sheet", 9];
  return [
    [
      top,
      [44, 724, title, 14],
      ...(issuer ? [[44, 702, issuer]] : []),
      ...(date ? [[44, 678, date]] : []),
      [44, 655, "Quarter ended September 30, 2026"],
      [44, 620, "Moderator: Welcome to this fictional earnings call."],
      [
        44,
        593,
        "Management: This update describes fictional quarterly results.",
      ],
      [44, 562, "Financial highlights"],
      [44, 536, "Metric"],
      [268, 536, "Quarter value"],
      [465, 536, "Change"],
      [44, 510, "Revenue"],
      [268, 510, figure],
      [465, 510, "−2.50%"],
      [44, 465, "Question and Answer Session", 13],
      [44, 436, "Ms. Zoë D’Souza"],
      [44, 413, "Could you explain the basis of the margin change,"],
      foot,
      [300, 26, "1", 9],
    ],
    [
      top,
      [44, 724, "including the movement in standalone operating profit?"],
      [44, 694, "Management: The two figures use different reporting bases."],
      [44, 665, "Analyst: Were the additional results forward-looking?"],
      [44, 641, "Management: The figures shown are historical."],
      foot,
      [300, 26, "2", 9],
    ],
  ];
}

/** Independent left and right flows are written in the opposite order from their intended reading order. */
export const columns = [
  [
    [321, 650, "Right opening line is read fourth."],
    [321, 628, "Right middle follows it."],
    [321, 606, "Right closing line follows it."],
    [44, 606, "Left closing line is read third."],
    [44, 650, "Left opening line is read first."],
    [44, 628, "Left middle follows it."],
    [
      44,
      717,
      "Synthetic layout heading spanning the page and both reading columns",
      15,
    ],
    [
      44,
      553,
      "Full-width footer paragraph after the columns spans past the central page gutter.",
    ],
  ],
];
