import sharp, { type OverlayOptions } from "sharp";
import { escapeXml } from "./image.js";

export interface SheetCell {
  path: string;
  label: string;
}

/**
 * Lay several frames out in a grid with a small label under each, so the agent
 * can see many moments of the video in one image (far fewer tokens).
 */
export async function makeContactSheet(
  cells: SheetCell[],
  outPath: string,
  opts: { maxWidth?: number; columns?: number; aspect: number },
): Promise<{ path: string; width: number; height: number }> {
  const maxWidth = opts.maxWidth ?? 1200;
  const aspect = opts.aspect; // height / width of a frame
  const columns = opts.columns ?? (aspect > 1.2 ? Math.min(6, cells.length) : Math.min(3, cells.length));
  const rows = Math.ceil(cells.length / columns);
  const gap = 8;
  const labelH = 22;
  const cellW = Math.floor((maxWidth - gap * (columns + 1)) / columns);
  const cellH = Math.round(cellW * aspect);
  const width = gap + columns * (cellW + gap);
  const height = gap + rows * (cellH + labelH + gap);
  const composites: OverlayOptions[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const left = gap + col * (cellW + gap);
    const top = gap + row * (cellH + labelH + gap);
    const img = await sharp(c.path).resize({ width: cellW, height: cellH, fit: "contain", background: "#1b1b1f" }).toBuffer();
    composites.push({ input: img, left, top });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${labelH}"><text x="2" y="16" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#e8e8ea">${escapeXml(c.label)}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top + cellH + 2 });
  }
  await sharp({ create: { width, height, channels: 3, background: "#101013" } })
    .composite(composites)
    .jpeg({ quality: 78 })
    .toFile(outPath);
  return { path: outPath, width, height };
}
