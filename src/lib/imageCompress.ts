/**
 * 上传前的图片压缩（2026-09-10）。
 *
 * ## 为什么要有它
 *
 * 用户反馈"上传自己的资产图非常非常慢"。慢的其中一段就在这里：资产图多是
 * 手机拍的定妆照或单反出的图，**5~20MB、长边四五千像素**，原样直传要走公网。
 * 而这些图在织影里的用途只有两个——当参考图喂给生图/生视频模型，以及在
 * 资产卡里显示成一枚缩略图。**两者都用不到 4000px**：生图模型侧本来就要缩到
 * 一两千像素，多传的字节纯粹是等待时间。
 *
 * ## 阈值：超了才压（用户裁定）
 *
 * `> 2MB` **或** `长边 > 2048px` 才压；否则原文件直传。
 * 不无条件压的理由：本来就规规矩矩的 800px PNG 再走一遍 canvas 重编码，
 * 只会掉画质、不会变快，属于净亏。
 *
 * ## 三条必须守住的细节（错了都不报错，只是悄悄毁图）
 *
 * 1. **EXIF 朝向要显式带上**（`imageOrientation: "from-image"`）。手机竖拍的
 *    照片像素其实是横的，靠 EXIF 标记转正；canvas 重编码会把 EXIF 丢掉，
 *    不显式转正的话，用户传上去的定妆图会**躺倒 90°**——而且预览里还是正的
 *    （浏览器读原文件的 EXIF），要等出片才发现。
 * 2. **绘制前铺白底**。目标格式 JPEG 不支持透明，透明区域默认会被填成**黑色**，
 *    抠好背景的立绘会变成黑底。
 * 3. **压完更大就退回原图**。已经是高压缩率的 JPEG 再编码一次可能变大，
 *    那时候"压缩"就是纯粹的损失。
 *
 * 兜底原则：**压缩失败绝不能挡住上传**。任何一步抛错都退回原文件照常传——
 * 慢一点远好过传不上去。
 */

/** 长边上限。超过这个尺寸对生图/预览都没有额外信息量。 */
export const MAX_EDGE = 2048;

/** 体积阈值：2MB 以内的图不折腾。 */
export const SIZE_LIMIT = 2 * 1024 * 1024;

/** JPEG 质量。0.9 在这类真人图上肉眼无损，体积通常只有原 PNG 的十分之一。 */
export const JPEG_QUALITY = 0.9;

/**
 * 能被 canvas 安全重编码的输入类型。
 *
 * 刻意**不含** gif（会只剩第一帧）与 svg（矢量转位图不可逆，且 canvas 对
 * 外链 svg 有污染限制）。后端 `_IMAGE_EXT` 只认 png/jpg/jpeg/webp，
 * 这里保持一致。
 */
const COMPRESSIBLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isCompressibleType(type: string): boolean {
  return COMPRESSIBLE_TYPES.has((type || "").toLowerCase());
}

/**
 * 该不该压。**体积或尺寸任一超标即压**——两者都会各自造成问题：
 * 体积大是上传慢，尺寸大是后续每次读取/缩放都白烧一遍。
 */
export function needsCompress(bytes: number, width: number, height: number): boolean {
  return bytes > SIZE_LIMIT || Math.max(width, height) > MAX_EDGE;
}

/**
 * 等比缩到长边 `maxEdge`。**只缩不放**：小图放大既不增加信息又变模糊。
 * 结果至少 1px（极端细长图 round 后可能得到 0，canvas 会直接抛错）。
 */
export function targetSize(
  width: number, height: number, maxEdge = MAX_EDGE,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge || long <= 0) return { width, height };
  const k = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
  };
}

/**
 * 输出文件名：后缀换成 `.jpg`（内容已是 JPEG）。
 *
 * 必须换：后端按**扩展名**白名单收文件（`media.ALLOWED_EXT`），也按扩展名
 * 判 kind。留着 `.png` 的话，磁盘上会躺一个名为 png、内容是 jpeg 的文件——
 * 眼下能显示，但任何按后缀分派的处理（缩略图、导出打包）都会踩到。
 */
export function jpegName(name: string): string {
  const base = (name || "image").replace(/\.[^./\\]+$/, "");
  return `${base || "image"}.jpg`;
}

export interface CompressResult {
  /** 要真正上传的文件——压过的新文件，或原文件本身。 */
  file: File;
  originalBytes: number;
  /** 没压时等于 `originalBytes`。 */
  outputBytes: number;
  /** 是否真的换了文件（用于决定要不要给用户提示"已压缩"）。 */
  compressed: boolean;
  /** 没压的原因，便于排查"为什么这张还是很慢"。 */
  reason?: "under-threshold" | "unsupported-type" | "no-canvas" | "grew" | "failed";
}

/** 把 File 解码成可绘制对象。优先 createImageBitmap（能显式指定 EXIF 朝向）。 */
async function decode(file: File): Promise<{
  src: CanvasImageSource; width: number; height: number; close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    // imageOrientation 决定手机竖拍照片是否会躺倒，见文件头注释 ①。
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { src: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败"));
      el.src = url;
    });
    return {
      src: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
}

/**
 * 超阈值就压，否则原样返回。**永不抛错**——见文件头的兜底原则。
 */
export async function compressImage(file: File): Promise<CompressResult> {
  const originalBytes = file.size;
  const plain = (reason: CompressResult["reason"]): CompressResult => ({
    file, originalBytes, outputBytes: originalBytes, compressed: false, reason,
  });

  if (!isCompressibleType(file.type)) return plain("unsupported-type");
  if (typeof document === "undefined") return plain("no-canvas");

  // 注意：这里**不能**用"体积没超就直接返回"抄近路。体积小但像素极大的图
  // 是存在的（6000px 的纯色线稿 PNG 可能只有几百 KB），它上传很快、但之后
  // 每次读取与缩放都要按 6000px 走一遍。尺寸这一维必须解码后才知道。
  let img: Awaited<ReturnType<typeof decode>> | null = null;
  try {
    img = await decode(file);
    if (!needsCompress(originalBytes, img.width, img.height)) {
      return plain("under-threshold");
    }
    const { width, height } = targetSize(img.width, img.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return plain("no-canvas");
    // 白底：JPEG 无透明通道，不铺白的话透明区会变黑，见文件头注释 ②。
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img.src, 0, 0, width, height);

    const blob = await toBlob(canvas);
    if (!blob) return plain("failed");
    // 压完反而更大 → 这次压缩纯亏（画质掉了、体积没降），退回原图。
    if (blob.size >= originalBytes) return plain("grew");
    return {
      file: new File([blob], jpegName(file.name), { type: "image/jpeg" }),
      originalBytes,
      outputBytes: blob.size,
      compressed: true,
    };
  } catch {
    // 解码/编码失败一律退回原文件：慢一点远好过传不上去。
    return plain("failed");
  } finally {
    img?.close();
  }
}

/** "5.2 MB → 380 KB" 这种给用户看的一行字。 */
export function describeSaving(r: CompressResult): string {
  const fmt = (n: number) => (n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`);
  return `${fmt(r.originalBytes)} → ${fmt(r.outputBytes)}`;
}
