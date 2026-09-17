/**
 * types/desub — 去字幕标记的契约
 *
 * ## 为什么不在 api.ts 里
 *
 * `api.ts` 是后端契约的手工镜像，架构守卫按「只许减」钉着它的行数
 * （P3 会换成生成的契约）。这一类新契约进独立模块，`api.ts` 那边只留
 * `TransformMeta.desub` 一个字段引用。
 *
 * ## 为什么住在 `transform_meta` 里
 *
 * 与 `blackout` / `mosaics` 同一先例：后端 `routes_v2.py` 收 `Optional[dict]`
 * **原样透传**，所以**零迁移**、不新增数据库列；而且天然受 `transform_rev`
 * 乐观锁保护 —— 去字幕按时长计费，两个窗口各标一半然后互相覆盖，
 * 是真实存在的坏结局。
 *
 * ⚠️ `api.ts` 里记着「传 `{}` 清除全部画面调整」。当前没有任何调用点真的传
 * `{}`（`CropZoomPanel` 的两个 reset 都是字段级合并），但**将来新增清空入口时
 * 必须保留 `desub`** —— 擦除是花过钱的、不可逆的标注，不该被一次「重置画面」抹掉。
 */

/**
 * 一块待擦除的烧录字幕：**一段时间 × 画面上的一块区域**。
 *
 * 时间维度不是可选优化：第三方 API 没有任何时间参数，遮罩必然作用于整段提交的
 * 视频，而计费按**处理的视频长度**算 —— 所以缩短区间是唯一能省钱的旋钮
 * （缩小遮罩面积既不省钱也不省时间，实测 315 倍面积差只多 7s）。
 */
export interface DesubRegion {
  /**
   * 稳定 id。**不能用数组下标**：合并/排序会重排，下标会让选中态跳到别的块上。
   */
  id: string;
  /**
   * 覆盖区间，单位**镜头输出秒**（与马赛克关键帧的 tSec 同一基准，
   * 即已经过 speed 换算）。造轨道块/回写拖拽时必须用 `lib/keyframeEdit` 的
   * `shotSecOf` / `outputSec` 转到时间轴用的源秒，别直接当秒数加。
   */
  t0: number; t1: number;
  /** 遮罩框，比例 0..1，与 `MosaicParams` 同坐标系（**不是像素**，
   *  理由见 api.ts 里 `TransformMeta.x` 的注释） */
  x: number; y: number; w: number; h: number;
  /** auto = 模型识别得到；manual = 用户用小工具自己框的 */
  src: "auto" | "manual";
  /** 识别时模型读到的文字。给用户核对用——"这是台词"还是"这是剧情"，人一眼能看出来 */
  text?: string;
  /**
   * 已擦除的留痕：结果落到了哪个 ShotVersion。
   * 有值 = 已应用，UI 画灰、不再计入预估费用、不再重复提交。
   */
  appliedVersion?: number;
}
