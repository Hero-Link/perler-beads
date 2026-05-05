import { transparentColorData } from './pixelEditingUtils';

// 定义像素化模式
export enum PixelationMode {
  Dominant = 'dominant', // 卡通模式（主色）
  Average = 'average',   // 真实模式（平均色）
}

// 定义色号系统类型
export type ColorSystem = 'MARD' | 'COCO' | '漫漫' | '盼盼' | '咪小窝';

// --- 必要的类型定义 ---
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface LabColor {
  l: number;
  a: number;
  b: number;
}

export interface PaletteColor {
  key: string;
  hex: string;
  rgb: RgbColor;
}

export interface MappedPixel {
  key: string;
  color: string;
  isExternal?: boolean;
}

// --- 辅助函数 ---

// 转换 Hex 到 RGB
export function hexToRgb(hex: string): RgbColor | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function srgbChannelToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

// RGB → XYZ (D65) → CIELAB
function rgbToLab(rgb: RgbColor): LabColor {
  const r = srgbChannelToLinear(rgb.r);
  const g = srgbChannelToLinear(rgb.g);
  const b = srgbChannelToLinear(rgb.b);

  // Linear RGB → XYZ (D65)
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;

  // XYZ → CIELAB (D65 reference white)
  const xn = 0.95047, yn = 1.0, zn = 1.08883;
  const f = (t: number): number => {
    const delta = 6 / 29;
    return t > delta * delta * delta ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
  };
  const fy = f(y / yn);

  return {
    l: 116 * fy - 16,
    a: 500 * (f(x / xn) - fy),
    b: 200 * (fy - f(z / zn)),
  };
}

const labCache = new Map<string, LabColor>();

function getLabColor(rgb: RgbColor): LabColor {
  const cacheKey = `${rgb.r},${rgb.g},${rgb.b}`;
  const cached = labCache.get(cacheKey);
  if (cached) return cached;
  const lab = rgbToLab(rgb);
  labCache.set(cacheKey, lab);
  return lab;
}

/**
 * CMC(l:c) 色差公式 — 纺织印染行业标准，对拼豆配色场景比 Oklab 更准确。
 * 使用 CMC(2:1) 参数（商业可接受色差），亮度权重减半。
 */
export function colorDistance(rgb1: RgbColor, rgb2: RgbColor): number {
  const lab1 = getLabColor(rgb1);
  const lab2 = getLabColor(rgb2);

  const l = 2; // 亮度权重（2 = 亮度差异减半）
  const c = 1; // 彩度权重

  const dL = lab1.l - lab2.l;
  const C1 = Math.sqrt(lab1.a * lab1.a + lab1.b * lab1.b);
  const C2 = Math.sqrt(lab2.a * lab2.a + lab2.b * lab2.b);
  const dC = C1 - C2;
  const da = lab1.a - lab2.a;
  const db = lab1.b - lab2.b;
  const dH_sq = da * da + db * db - dC * dC;
  const dH = Math.sqrt(Math.max(0, dH_sq));

  if (C1 < 1e-9) return Math.sqrt((dL / l) ** 2 + (dC / c) ** 2);

  const h1 = (Math.atan2(lab1.b, lab1.a) * 180) / Math.PI;
  const h1Norm = h1 < 0 ? h1 + 360 : h1;

  const F = Math.sqrt(C1 ** 4 / (C1 ** 4 + 1900));
  const T = h1Norm >= 164 && h1Norm <= 345
    ? 0.56 + Math.abs(0.2 * Math.cos(((h1Norm + 168) * Math.PI) / 180))
    : 0.36 + Math.abs(0.4 * Math.cos(((h1Norm + 35) * Math.PI) / 180));

  const SL = lab1.l < 16
    ? 0.511
    : (0.040975 * lab1.l) / (1 + 0.01765 * lab1.l);
  const SC = (0.0638 * C1) / (1 + 0.0131 * C1) + 0.638;
  const SH = SC * (F * T + 1 - F);

  const termL = dL / (l * SL);
  const termC = dC / (c * SC);
  const termH = dH / SH;

  return Math.sqrt(termL * termL + termC * termC + termH * termH) * 20;
}

// 查找最接近的颜色
export function findClosestPaletteColor(
  targetRgb: RgbColor,
  palette: PaletteColor[]
): PaletteColor {
  if (!palette || palette.length === 0) {
      console.error("findClosestPaletteColor: Palette is empty or invalid!");
      // 提供一个健壮的回退
      return { key: 'ERR', hex: '#000000', rgb: { r: 0, g: 0, b: 0 } };
  }

  let minDistance = Infinity;
  let closestColor = palette[0];

  for (const paletteColor of palette) {
    const distance = colorDistance(targetRgb, paletteColor.rgb);
    if (distance < minDistance) {
      minDistance = distance;
      closestColor = paletteColor;
    }
    if (distance === 0) break; // 完全匹配，提前退出
  }
  return closestColor;
}


// --- 核心像素化计算逻辑 ---

/**
 * 计算图像指定区域的代表色（根据所选模式）
 * @param imageData 包含像素数据的 ImageData 对象
 * @param startX 区域起始 X 坐标
 * @param startY 区域起始 Y 坐标
 * @param width 区域宽度
 * @param height 区域高度
 * @param mode 计算模式 ('dominant' 或 'average')
 * @returns 代表色的 RGB 对象，或 null（如果区域无效或全透明）
 */
// 颜色量化：将 8-bit 通道值量化到 5-bit（32 级，步长 8），
// 把 JPEG 压缩伪影合并到同一个桶中，提升主导色统计的准确性。
const Q_BITS = 5;
const Q_STEP = 256 / (1 << Q_BITS); // = 8
function quantizeChannel(v: number): number {
  return Math.round(v / Q_STEP) * Q_STEP;
}

function calculateCellRepresentativeColor(
    imageData: ImageData,
    startX: number,
    startY: number,
    width: number,
    height: number,
    mode: PixelationMode
): RgbColor | null {
    const data = imageData.data;
    const imgWidth = imageData.width;
    let rSum = 0, gSum = 0, bSum = 0;
    let pixelCount = 0;
    // 量化后的桶: key → { count, rSum, gSum, bSum }
    const bucketMap: { [key: string]: { count: number; rSum: number; gSum: number; bSum: number } } = {};
    let maxCount = 0;
    let bestBucketKey = '';

    const endX = startX + width;
    const endY = startY + height;

    for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
            const index = (y * imgWidth + x) * 4;
            // 检查 alpha 通道，忽略完全透明的像素
            if (data[index + 3] < 128) continue;

            const r = data[index];
            const g = data[index + 1];
            const b = data[index + 2];

            pixelCount++;

            if (mode === PixelationMode.Average) {
                rSum += r;
                gSum += g;
                bSum += b;
            } else { // Dominant mode — 使用量化桶合并相似像素
                const qr = quantizeChannel(r);
                const qg = quantizeChannel(g);
                const qb = quantizeChannel(b);
                const bucketKey = `${qr},${qg},${qb}`;
                if (!bucketMap[bucketKey]) {
                    bucketMap[bucketKey] = { count: 0, rSum: 0, gSum: 0, bSum: 0 };
                }
                const bucket = bucketMap[bucketKey];
                bucket.count++;
                bucket.rSum += r;
                bucket.gSum += g;
                bucket.bSum += b;

                if (bucket.count > maxCount) {
                    maxCount = bucket.count;
                    bestBucketKey = bucketKey;
                }
            }
        }
    }

    if (pixelCount === 0) {
        return null; // 区域内没有不透明像素
    }

    if (mode === PixelationMode.Average) {
        return {
            r: Math.round(rSum / pixelCount),
            g: Math.round(gSum / pixelCount),
            b: Math.round(bSum / pixelCount),
        };
    } else { // Dominant mode — 返回最大桶的 RGB 平均值（比单点更准确）
        const best = bucketMap[bestBucketKey];
        if (!best) return null;
        return {
            r: Math.round(best.rSum / best.count),
            g: Math.round(best.gSum / best.count),
            b: Math.round(best.bSum / best.count),
        };
    }
}

/**
 * 根据原始图像数据、网格尺寸、调色板和模式计算像素化网格数据。
 * @param originalCtx 原始图像的 Canvas 2D Context
 * @param imgWidth 原始图像宽度
 * @param imgHeight 原始图像高度
 * @param N 网格横向数量
 * @param M 网格纵向数量
 * @param palette 当前使用的调色板
 * @param mode 像素化模式 (Dominant/Average)
 * @param t1FallbackColor T1 或其他备用颜色数据
 * @returns 计算后的 MappedPixel 网格数据
 */
export function calculatePixelGrid(
    originalCtx: CanvasRenderingContext2D,
    imgWidth: number,
    imgHeight: number,
    N: number,
    M: number,
    palette: PaletteColor[],
    mode: PixelationMode,
    t1FallbackColor: PaletteColor // 传入备用色
): MappedPixel[][] {
    console.log(`Calculating pixel grid with mode: ${mode}`);
    const mappedData: MappedPixel[][] = Array(M).fill(null).map(() => Array(N).fill({ key: t1FallbackColor.key, color: t1FallbackColor.hex }));
    const cellWidthOriginal = imgWidth / N;
    const cellHeightOriginal = imgHeight / M;

    let fullImageData: ImageData | null = null;
    try {
        fullImageData = originalCtx.getImageData(0, 0, imgWidth, imgHeight);
    } catch (e) {
        console.error("Failed to get full image data:", e);
        // 如果无法获取图像数据，返回一个空的或默认的网格
        return mappedData;
    }

    for (let j = 0; j < M; j++) {
        for (let i = 0; i < N; i++) {
            const startXOriginal = Math.floor(i * cellWidthOriginal);
            const startYOriginal = Math.floor(j * cellHeightOriginal);
            // 计算精确的单元格结束位置，避免超出图像边界
            const endXOriginal = Math.min(imgWidth, Math.ceil((i + 1) * cellWidthOriginal));
            const endYOriginal = Math.min(imgHeight, Math.ceil((j + 1) * cellHeightOriginal));
            // 计算实际的单元格宽高
            const currentCellWidth = Math.max(1, endXOriginal - startXOriginal);
            const currentCellHeight = Math.max(1, endYOriginal - startYOriginal);

            // 使用提取的函数计算代表色
            const representativeRgb = calculateCellRepresentativeColor(
                fullImageData,
                startXOriginal,
                startYOriginal,
                currentCellWidth,
                currentCellHeight,
                mode
            );

            let finalCellColorData: MappedPixel;
            if (representativeRgb) {
                const closestBead = findClosestPaletteColor(representativeRgb, palette);
                finalCellColorData = { key: closestBead.key, color: closestBead.hex };
            } else {
                // 如果单元格为空或全透明，标记为透明/外部
                finalCellColorData = { ...transparentColorData };
            }
            mappedData[j][i] = finalCellColorData;
        }
    }
    console.log(`Pixel grid calculation complete for mode: ${mode}`);
    return mappedData;
} 
