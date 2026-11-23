const financialValue =
  /^(?:[−–+(-]?\s*(?:₹|[$€]|INR\s+)?\s*\d[\d,.]*(?:\s*[%)]|\s*(?:lakh|crore|bps|million|billion))?)$/iu;

function visualRows(items) {
  const rows = [];
  const sorted = items
    .filter(({ str }) => str.trim())
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of sorted) {
    const previous = rows.at(-1);
    // Baseline jitter increases with font size, but a small cap protects closely set rows.
    const tolerance = Math.min(4, Math.max(1.5, item.height * 0.24));
    if (previous && item.y - previous.y <= tolerance) previous.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  return rows;
}

function segments(items, pageWidth) {
  const cells = [];
  let right = -Infinity;
  let height = 0;
  let spaceAfter = false;
  for (const item of items.sort((a, b) => a.x - b.x)) {
    const gap = item.x - right;
    if (gap > Math.max(22, pageWidth * 0.045, item.height * 2.5)) {
      cells.push({
        text: item.str.trim(),
        x: item.x,
        right: item.x + item.width,
      });
    } else {
      const cell = cells.at(-1);
      const space =
        spaceAfter ||
        /^\s/u.test(item.str) ||
        gap > Math.max(1, Math.min(height, item.height) * 0.15);
      cell.text += (space ? " " : "") + item.str.trim();
      cell.right = Math.max(cell.right, item.x + item.width);
    }
    right = Math.max(right, item.x + item.width);
    height = item.height;
    spaceAfter = /\s$/u.test(item.str);
  }
  return cells;
}

const asLine = (row, text, x, kind = "line") => ({ text, x, y: row.y, kind });

function staggeredColumns(rows, width) {
  const prose = rows.filter(
    ({ cells }) =>
      cells.length === 1 &&
      /(?:\p{L}+\s+){3,}/u.test(cells[0].text) &&
      cells[0].right - cells[0].x >= width * 0.12,
  );
  const right = prose.filter(
    ({ cells: [cell] }) => cell.x > width * 0.39 && cell.x < width * 0.75,
  );
  const left = prose.filter(({ cells: [cell] }) => cell.x < width * 0.3);
  const examined = new Set();
  for (const {
    cells: [anchor],
  } of right) {
    const bin = Math.floor(anchor.x / (width * 0.025));
    if (examined.has(bin)) continue;
    examined.add(bin);
    const sameRight = right.filter(
      ({ cells: [cell] }) => Math.abs(cell.x - anchor.x) <= width * 0.035,
    );
    const sameLeft = left.filter(
      ({ cells: [cell] }) => cell.right < anchor.x - width * 0.055,
    );
    if (sameRight.length < 3 || sameLeft.length < 3) continue;
    const leftStart = sameLeft[0].y;
    const rightStart = sameRight[0].y;
    const leftEnd = sameLeft.at(-1).y;
    const rightEnd = sameRight.at(-1).y;
    const overlap =
      Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart);
    if (
      overlap >=
      Math.max(20, Math.min(leftEnd - leftStart, rightEnd - rightStart) * 0.55)
    )
      return {
        x: anchor.x,
        first: Math.min(leftStart, rightStart),
        last: Math.max(leftEnd, rightEnd),
      };
  }
  return null;
}

/** Detect a recurring prose gutter; otherwise keep physical rows, including numeric tables. */
export function orderPage(items, width, height) {
  const rows = visualRows(items).map((row) => ({
    ...row,
    cells: segments(row.items, width),
  }));
  const marginal = (row) => row.y <= height * 0.09 || row.y >= height * 0.91;
  const pairs = rows
    .filter((row) => !marginal(row))
    .filter(
      ({ cells }) =>
        cells.length === 2 &&
        cells[0].x < width * 0.35 &&
        cells[1].x > width * 0.39 &&
        cells[1].x < width * 0.75 &&
        cells[1].x - cells[0].right > width * 0.055 &&
        cells.every(
          ({ text }) => !financialValue.test(text) && /\p{L}{3}/u.test(text),
        ),
    );
  const rotated = items.some(
    ({ rotated, dir }) => rotated || dir === "rtl" || dir === "ttb",
  );
  const examined = new Set();
  const chosen = pairs.find(({ cells }) => {
    const bin = Math.floor(cells[1].x / (width * 0.025));
    if (examined.has(bin)) return false;
    examined.add(bin);
    return (
      pairs.filter(
        (row) => Math.abs(row.cells[1].x - cells[1].x) <= width * 0.035,
      ).length >= 3
    );
  });
  const staggered = !chosen
    ? staggeredColumns(
        rows.filter((row) => !marginal(row)),
        width,
      )
    : null;
  const confidence =
    rotated || (!chosen && !staggered && pairs.length > 0) ? "low" : "high";
  const lines = [];
  if ((!chosen && !staggered) || rotated) {
    for (const row of rows) {
      if (marginal(row) && row.cells.length > 1) {
        lines.push(...row.cells.map((cell) => asLine(row, cell.text, cell.x)));
        continue;
      }
      const table =
        row.cells.length > 1 &&
        (row.cells.length > 2 ||
          row.cells.slice(1).some(({ text }) => financialValue.test(text)));
      lines.push(
        asLine(
          row,
          row.cells.map(({ text }) => text).join(table ? "    " : " "),
          row.cells[0].x,
          table ? "table" : "line",
        ),
      );
    }
    return { lines, confidence, columns: 1 };
  }
  const rightStart = chosen?.cells[1].x ?? staggered.x;
  const matching = pairs.filter(
    ({ cells }) => Math.abs(cells[1].x - rightStart) <= width * 0.035,
  );
  const first = staggered?.first ?? matching[0].y;
  const last = staggered?.last ?? matching.at(-1).y;
  let left = [];
  let right = [];
  const flush = () => {
    lines.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const row of rows) {
    if (marginal(row) && row.cells.length > 1) {
      flush();
      lines.push(...row.cells.map((cell) => asLine(row, cell.text, cell.x)));
      continue;
    }
    const spansGutter = row.cells.some(
      (cell) =>
        cell.x < rightStart - width * 0.05 &&
        cell.right > rightStart - width * 0.025,
    );
    const table =
      row.cells.length > 1 &&
      (row.cells.length > 2 ||
        row.cells.slice(1).some(({ text }) => financialValue.test(text)));
    const inBand = row.y >= first - 20 && row.y <= last + 20;
    // A spanning heading or table ends the current column band.
    if (spansGutter || table || !inBand) {
      flush();
      lines.push(
        asLine(
          row,
          row.cells.map(({ text }) => text).join(table ? "    " : " "),
          row.cells[0].x,
          table ? "table" : "line",
        ),
      );
    } else {
      for (const cell of row.cells) {
        (cell.x >= rightStart - width * 0.035 ? right : left).push(
          asLine(row, cell.text, cell.x),
        );
      }
    }
  }
  flush();
  return { lines, confidence, columns: 2 };
}
