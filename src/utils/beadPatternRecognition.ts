import { createWorker, Worker } from 'tesseract.js';
import { MappedPixel } from './pixelation';
import { convertColorKeyToHex, ColorSystem } from './colorSystemUtils';

/** Minimum cell dimension (in pixels) for reliable OCR. Source image is upscaled if below this. */
const MIN_CELL_SIZE = 40;

let cachedWorker: Worker | null = null;

async function getWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  cachedWorker = await createWorker('eng');
  await cachedWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  });
  return cachedWorker;
}

/**
 * Upscale the source image so each cell is at least MIN_CELL_SIZE pixels.
 * Returns a canvas and its context, plus the scale factor applied.
 */
function prepareSourceCanvas(
  img: HTMLImageElement,
  gridDims: { N: number; M: number }
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; scale: number } {
  const rawCellW = img.width / gridDims.N;
  const rawCellH = img.height / gridDims.M;
  const minCellDim = Math.min(rawCellW, rawCellH);

  let scale = 1;
  if (minCellDim < MIN_CELL_SIZE) {
    scale = Math.ceil(MIN_CELL_SIZE / minCellDim);
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false; // nearest-neighbor for pixel art
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  return { canvas, ctx, scale };
}

/**
 * Otsu's method: compute optimal binary threshold for grayscale values.
 * Returns the threshold value.
 */
function otsuThreshold(gray: number[]): number {
  const histogram = new Array(256).fill(0);
  for (const g of gray) {
    histogram[Math.round(g)]++;
  }

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);

    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

/**
 * Determine if text is darker or lighter than the cell background.
 * Samples a ring around the cell center vs the center itself.
 */
function detectTextPolarity(
  gray: number[],
  cellW: number,
  cellH: number
): 'dark' | 'light' {
  const sample = (x: number, y: number) => {
    const sx = Math.round(x * (cellW - 1));
    const sy = Math.round(y * (cellH - 1));
    return gray[sy * cellW + sx];
  };

  // Sample center region
  let centerSum = 0;
  let centerCount = 0;
  for (let dy = 0.35; dy <= 0.65; dy += 0.1) {
    for (let dx = 0.35; dx <= 0.65; dx += 0.1) {
      centerSum += sample(dx, dy);
      centerCount++;
    }
  }
  const centerAvg = centerSum / centerCount;

  // Sample edge region (15% inset from border, to avoid pure grid lines)
  let edgeSum = 0;
  let edgeCount = 0;
  const inset = 0.15;
  const pts = [
    [inset, inset], [0.5, inset], [1 - inset, inset],
    [inset, 0.5], [1 - inset, 0.5],
    [inset, 1 - inset], [0.5, 1 - inset], [1 - inset, 1 - inset],
  ];
  for (const [ex, ey] of pts) {
    edgeSum += sample(ex, ey);
    edgeCount++;
  }
  const edgeAvg = edgeSum / edgeCount;

  // If edges are brighter than center, text is dark
  return edgeAvg > centerAvg ? 'dark' : 'light';
}

/**
 * Preprocess a cell for OCR.
 * Extracts center region (trimming grid lines), binarizes with Otsu threshold,
 * upscales, and crops to text bounding box.
 */
function preprocessCellForOCR(
  sourceCtx: CanvasRenderingContext2D,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number
): HTMLCanvasElement {
  // Trim grid line edges: focus on center 60-70% of the cell where text lives
  const trimRatio = 0.18;
  const trimX = Math.round(cellW * trimRatio);
  const trimY = Math.round(cellH * trimRatio);
  const innerW = cellW - trimX * 2;
  const innerH = cellH - trimY * 2;

  if (innerW < 3 || innerH < 3) {
    // Cell too small even for trimming, use full cell
    return buildOcrCanvas(sourceCtx, cellX, cellY, cellW, cellH);
  }

  return buildOcrCanvas(sourceCtx, cellX + trimX, cellY + trimY, innerW, innerH);
}

function buildOcrCanvas(
  sourceCtx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number
): HTMLCanvasElement {
  const cellData = sourceCtx.getImageData(x, y, w, h);
  const pixels = cellData.data;

  // Grayscale
  const gray: number[] = new Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    gray[i] = Math.round(0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2]);
  }

  const polarity = detectTextPolarity(gray, w, h);
  const threshold = otsuThreshold(gray);

  // Scale output so text height is at least 24px
  const outScale = Math.max(3, Math.ceil(24 / Math.min(w, h)));

  const outW = w * outScale;
  const outH = h * outScale;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d')!;

  // White background
  outCtx.fillStyle = '#FFFFFF';
  outCtx.fillRect(0, 0, outW, outH);

  const outImageData = outCtx.getImageData(0, 0, outW, outH);
  const outPixels = outImageData.data;

  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const g = gray[cy * w + cx];
      let isText: boolean;
      if (polarity === 'dark') {
        isText = g < threshold;
      } else {
        isText = g > threshold;
      }

      if (isText) {
        for (let dy = 0; dy < outScale; dy++) {
          for (let dx = 0; dx < outScale; dx++) {
            const outIdx = ((cy * outScale + dy) * outW + (cx * outScale + dx)) * 4;
            outPixels[outIdx] = 0;
            outPixels[outIdx + 1] = 0;
            outPixels[outIdx + 2] = 0;
            outPixels[outIdx + 3] = 255;
          }
        }
      }
    }
  }
  outCtx.putImageData(outImageData, 0, 0);

  // Crop to text bounding box (with padding)
  let minX = outW, minY = outH, maxX = 0, maxY = 0;
  for (let cy = 0; cy < outH; cy++) {
    for (let cx = 0; cx < outW; cx++) {
      const idx = (cy * outW + cx) * 4;
      if (outPixels[idx] === 0) {
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
      }
    }
  }

  if (minX > maxX || minY > maxY) {
    return outCanvas; // no text found
  }

  const pad = Math.max(4, Math.round(Math.min(outW, outH) * 0.1));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(outW - 1, maxX + pad);
  maxY = Math.min(outH - 1, maxY + pad);

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = maxX - minX + 1;
  cropCanvas.height = maxY - minY + 1;
  const cropCtx = cropCanvas.getContext('2d')!;
  cropCtx.fillStyle = '#FFFFFF';
  cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(outCanvas, minX, minY, cropCanvas.width, cropCanvas.height, 0, 0, cropCanvas.width, cropCanvas.height);

  return cropCanvas;
}

/**
 * Clean recognized text: extract uppercase letter prefix + digit suffix.
 */
function cleanRecognizedText(text: string): string {
  // Remove all non-alphanumeric, uppercase
  const cleaned = text.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!cleaned) return '';

  // Color codes are like A2, B5, H7, A01, ZG8 — letter prefix + digits
  const match = cleaned.match(/([A-Z]+)(\d+)/);
  if (match) return match[1] + match[2];

  // Fallback: if we have digits but no letters, or letters but no digits
  const digitsMatch = cleaned.match(/\d+/);
  const lettersMatch = cleaned.match(/[A-Z]+/);
  if (lettersMatch && digitsMatch) {
    return lettersMatch[0] + digitsMatch[0];
  }
  if (lettersMatch) return lettersMatch[0];
  if (digitsMatch) return digitsMatch[0];

  return cleaned.substring(0, 5);
}

/**
 * Try OCR on a preprocessed cell canvas. Returns cleaned text or empty string.
 */
async function ocrCell(
  worker: Worker,
  cellCanvas: HTMLCanvasElement
): Promise<string> {
  try {
    const { data } = await worker.recognize(cellCanvas);
    const text = cleanRecognizedText(data.text);
    if (text) return text;
  } catch {
    // Fall through to retry
  }

  // Retry with inverted canvas
  try {
    const invCanvas = document.createElement('canvas');
    invCanvas.width = cellCanvas.width;
    invCanvas.height = cellCanvas.height;
    const invCtx = invCanvas.getContext('2d')!;
    invCtx.fillStyle = '#000000';
    invCtx.fillRect(0, 0, invCanvas.width, invCanvas.height);
    invCtx.globalCompositeOperation = 'difference';
    invCtx.drawImage(cellCanvas, 0, 0);

    const { data } = await worker.recognize(invCanvas);
    const text = cleanRecognizedText(data.text);
    if (text) return text;
  } catch {
    // Give up
  }

  return '';
}

/**
 * Auto-detect grid dimensions from a perler bead pattern image.
 * Analyzes row/column pixel projections to find regularly spaced grid lines.
 * Returns {N, M} or null if detection fails.
 */
export async function autoDetectGrid(
  imageSrc: string
): Promise<{ N: number; M: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const w = Math.min(img.width, 800);
      const scale = w / img.width;
      const h = Math.round(img.height * scale);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }

      ctx.drawImage(img, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const pixels = imageData.data;

      const toGray = (idx: number) =>
        0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];

      // Row projection: for each row, measure variance (low variance = likely grid line)
      const rowScores: number[] = [];
      for (let y = 0; y < h; y++) {
        let sum = 0, sumSq = 0;
        for (let x = 0; x < w; x++) {
          const g = toGray((y * w + x) * 4);
          sum += g;
          sumSq += g * g;
        }
        const mean = sum / w;
        const variance = sumSq / w - mean * mean;
        // Low variance + bright = grid line candidate
        rowScores.push(variance < 100 && mean > 180 ? 1 : 0);
      }

      // Column projection
      const colScores: number[] = [];
      for (let x = 0; x < w; x++) {
        let sum = 0, sumSq = 0;
        for (let y = 0; y < h; y++) {
          const g = toGray((y * w + x) * 4);
          sum += g;
          sumSq += g * g;
        }
        const mean = sum / h;
        const variance = sumSq / h - mean * mean;
        colScores.push(variance < 100 && mean > 180 ? 1 : 0);
      }

      const findLinePositions = (scores: number[]): number[] => {
        const positions: number[] = [];
        let inLine = false;
        for (let i = 0; i < scores.length; i++) {
          if (scores[i] === 1 && !inLine) {
            positions.push(i);
            inLine = true;
          } else if (scores[i] === 0) {
            inLine = false;
          }
        }
        return positions;
      };

      const rowLines = findLinePositions(rowScores);
      const colLines = findLinePositions(colScores);

      const avgSpacing = (lines: number[]): number => {
        if (lines.length < 2) return 0;
        const gaps: number[] = [];
        for (let i = 1; i < lines.length; i++) {
          gaps.push(lines[i] - lines[i - 1]);
        }
        gaps.sort((a, b) => a - b);
        // Filter outliers: only use gaps within 50% of median
        const median = gaps[Math.floor(gaps.length / 2)];
        const filtered = gaps.filter(g => g > median * 0.5 && g < median * 1.5);
        if (filtered.length > 0) {
          return Math.round(filtered.reduce((a, b) => a + b, 0) / filtered.length);
        }
        return median;
      };

      const rowSpacing = avgSpacing(rowLines);
      const colSpacing = avgSpacing(colLines);

      if (rowSpacing < 3 || colSpacing < 3) {
        resolve(null);
        return;
      }

      const M = Math.max(1, Math.round(h / rowSpacing) - 1);
      const N = Math.max(1, Math.round(w / colSpacing) - 1);

      if (N < 2 || M < 2 || N > 300 || M > 300) {
        resolve(null);
        return;
      }

      resolve({ N, M });
    };
    img.onerror = () => resolve(null);
    img.src = imageSrc;
  });
}

/**
 * Recognize a perler bead pattern image.
 * Divides the image into N × M grid cells, OCRs the color code in each cell,
 * and maps recognized codes to hex colors using the selected color system.
 *
 * Images with small cells are automatically upscaled for better OCR accuracy.
 *
 * @param imageSrc - Source image data URL
 * @param gridDims - Grid dimensions {N columns, M rows}
 * @param colorSystem - Which bead brand's color code system to use
 * @param onProgress - Optional callback (currentCell, totalCells)
 * @returns MappedPixel[][] ready for display/editing
 */
export async function recognizeBeadPattern(
  imageSrc: string,
  gridDims: { N: number; M: number },
  colorSystem: ColorSystem,
  onProgress?: (current: number, total: number) => void
): Promise<MappedPixel[][]> {
  const { N, M } = gridDims;
  const totalCells = N * M;

  // Load image
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image'));
    image.src = imageSrc;
  });

  // Upscale source if cells are too small
  const { canvas: sourceCanvas, ctx: sourceCtx } = prepareSourceCanvas(img, gridDims);

  // Calculate cell dimensions on the (possibly upscaled) source
  const cellW = sourceCanvas.width / N;
  const cellH = sourceCanvas.height / M;

  // Initialize Tesseract worker
  const worker = await getWorker();

  // Process cells row by row
  const result: MappedPixel[][] = [];

  for (let row = 0; row < M; row++) {
    const resultRow: MappedPixel[] = [];
    for (let col = 0; col < N; col++) {
      const cellX = Math.round(col * cellW);
      const cellY = Math.round(row * cellH);
      const cW = Math.round((col + 1) * cellW) - cellX;
      const cH = Math.round((row + 1) * cellH) - cellY;

      let recognizedCode = '';
      if (cW >= 3 && cH >= 3) {
        const preprocessed = preprocessCellForOCR(
          sourceCtx, cellX, cellY, cW, cH
        );
        recognizedCode = await ocrCell(worker, preprocessed);
      }

      const hex = recognizedCode
        ? convertColorKeyToHex(recognizedCode, colorSystem)
        : '';

      resultRow.push({
        key: hex || recognizedCode || '?',
        color: hex || '#CCCCCC',
        isExternal: false,
      });
    }
    result.push(resultRow);

    if (onProgress) {
      onProgress((row + 1) * N, totalCells);
    }
  }

  return result;
}
