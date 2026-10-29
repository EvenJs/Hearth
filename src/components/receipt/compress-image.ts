// 小票照片在浏览器里压缩成 JPEG（tech-stack 11.3）：长边 ≤ 1600px、≤ 1MB，不加库
// HEIC：iPhone 的 Safari 选图时会转成 JPEG；电脑上的 Chrome 解不了，提示换成 JPG
// 只在浏览器里用（canvas）。图片不上传原图，只上传压缩后的

export const MAX_LONG_SIDE = 1600;
export const MAX_BYTES = 1024 * 1024;

export class UnreadableImageError extends Error {
  constructor() {
    super('这张图打不开，换成 JPG 再传');
    this.name = 'UnreadableImageError';
  }
}

// 等比缩放到长边不超过 maxLongSide，小图不放大。返回整数像素
export function fitWithin(
  width: number,
  height: number,
  maxLongSide: number,
): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= maxLongSide) return { width, height };
  const scale = maxLongSide / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// 先按质量从高到低试，还是太大就再缩小一圈
const QUALITIES = [0.85, 0.75, 0.65, 0.5];

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new UnreadableImageError())),
      'image/jpeg',
      quality,
    ),
  );
}

export async function compressReceiptImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // 按照片的 EXIF 方向转正（手机竖着拍的）
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UnreadableImageError();
  }

  try {
    let longSide = MAX_LONG_SIDE;
    for (let round = 0; round < 3; round++) {
      const size = fitWithin(bitmap.width, bitmap.height, longSide);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const g = canvas.getContext('2d');
      if (!g) throw new UnreadableImageError();
      // JPEG 没有透明：PNG 截图的透明部分涂白
      g.fillStyle = '#fff';
      g.fillRect(0, 0, size.width, size.height);
      g.drawImage(bitmap, 0, 0, size.width, size.height);

      for (const quality of QUALITIES) {
        const blob = await toJpeg(canvas, quality);
        if (blob.size <= MAX_BYTES) return blob;
      }
      longSide = Math.round(longSide * 0.75);
    }
    throw new UnreadableImageError();
  } finally {
    bitmap.close();
  }
}
