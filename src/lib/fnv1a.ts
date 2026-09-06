/**
 * lib/fnv1a.ts — FNV-1a 32 位字符串哈希
 *
 * 项目里有两处需要「把一个字符串压成一个短而稳定的标识」：
 * 能力探测的口径指纹（`render/capabilities.ts`）与素材缓存的文件名前缀
 * （`lib/mediaCache.ts`）。**两处各写一份是漂移源**——4.2/4.3 刚清掉两处
 * 「各抄一遍」的规则，不该在 4.5 又造一个。
 *
 * 不需要抗碰撞：一处只用来判断"清单变没变"，另一处只用来区分同名不同源的
 * 素材（真撞上的后果是复用了错的缓存，而 32 位对单个项目的几百个素材而言，
 * 碰撞概率在 1e-5 量级以下，且素材名本身也参与文件名）。
 */
export function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
