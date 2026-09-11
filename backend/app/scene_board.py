"""场景**设定板**——把 8 张单视角参考图拼成用户给的那种美术设定板。

## 为什么它必须是独立产物，而不是"把场景资产图做成拼版"

用户 2026-09-09 给的参考图是一张拼版设定板（多视角/景别/材质/色彩分格 +
中文标注 + 场景设定信息框）。直觉上最省事的做法是让生图模型直接画这么一张，
把它存成 `Asset.image_url`。**这条路是错的**，因为：

`jobs._auto_inject_refs_detailed` 会把场景资产图**原样注入每一个镜头**
当参考图。一张带格子线和中文标签的拼版图进了参考位，模型会把格子线、
分割线、中文标注一起抄进镜头画面——每个镜头都变成一张拼版画。

所以职责这样切：
- **参考图集**（`scene_view`）：8 张各自独立、画面干净的单幅图 → 喂模型
- **设定板**（本模块）：服务端用 PIL 把这 8 张拼起来 → **只给人看**

设定板是**派生产物**，不花生图钱、不进任何模型输入、删了随时能重拼。

## 板面构成（对齐用户给的参考图）

    ┌─────────────────────────────────────────────┐
    │  《剧名》  场景名                            │  标题条
    ├─────────────────────────────────────────────┤
    │  多视角参考   [主视角][反打][右侧][左侧]      │  4 格
    │  景别参考     [远景][中景][近景][特写·材质]   │  4 格
    │  色彩参考     ■■■■■■  （从图里取的主色）      │  色卡
    │  材质参考     木纹 / 大理石 / 布艺 …          │  文字
    │  场景设定信息  空间描述全文                    │  文字框
    └─────────────────────────────────────────────┘

参考图里的「材质参考」不需要第 9 张生成图——`frame_detail`（特写）就是它，
所以它在景别一行里同时挂着「特写·材质」的标签。
「色彩参考」是**从这 8 张图里取色**得出的，不是生成的：取色比让模型"画一排色块"
准确得多，而且它反映的是**实际出图的颜色**，正好能拿来核对影调是否统一。

## 缺图时怎么办

不报错、不留空洞。缺的格子画一个灰底 + 「未生成」字样——设定板的用途是
"让人一眼看出这个场景齐不齐"，缺格子本身就是有用的信息。
"""
from __future__ import annotations

import logging
from pathlib import Path

log = logging.getLogger(__name__)

#: 板面尺寸（够印 A3，也够在客户端里放大看细节）
_W = 2400
_PAD = 48
_GAP = 24
#: 一行 4 格
_COLS = 4

_BG = (24, 24, 27)
_FG = (240, 240, 245)
_MUTED = (150, 150, 160)
_LINE = (60, 60, 68)
_EMPTY_BG = (44, 44, 50)

_FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
_FONT_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"


def _font(size: int, *, bold: bool = False):
    """取中文字体。字体缺失时退回 PIL 默认字体（英文能显示、中文会变方块，
    但**不能因此让拼板整个失败**——设定板是辅助产物）。"""
    from PIL import ImageFont
    path = _FONT_BOLD if bold else _FONT_REG
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        log.warning("[board] 中文字体缺失（%s），退回默认字体", path)
        return ImageFont.load_default()


def _open_local(url: str | None):
    """`/fw/media/...` → PIL Image。取不到返回 None（画"未生成"占位）。"""
    if not (url or "").strip():
        return None
    from PIL import Image

    from .media import _resolve_local
    p = _resolve_local(url)
    if p is None or not Path(p).is_file():
        return None
    try:
        return Image.open(p).convert("RGB")
    except Exception as e:                  # noqa: BLE001
        log.warning("[board] 打不开图片 %s：%s", url, e)
        return None


def _fit(img, box_w: int, box_h: int):
    """等比缩放并居中裁切到格子尺寸（不拉伸变形——变形的设定板没法当美术参考）。"""
    from PIL import Image
    iw, ih = img.size
    scale = max(box_w / iw, box_h / ih)
    nw, nh = max(1, int(iw * scale)), max(1, int(ih * scale))
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - box_w) // 2, (nh - box_h) // 2
    return img.crop((left, top, left + box_w, top + box_h))


def _dominant_colors(images: list, n: int = 8) -> list[tuple[int, int, int]]:
    """从若干张图里取 n 个主色，作为「色彩参考」色卡。

    做法：每张图缩到 64×64（去掉噪点与细节），合并后用 PIL 的中位切分量化。
    比"平均色"有用得多——平均色永远是一团灰泥。
    """
    from PIL import Image
    if not images:
        return []
    tiles = [im.resize((64, 64), Image.LANCZOS) for im in images]
    sheet = Image.new("RGB", (64 * len(tiles), 64))
    for i, t in enumerate(tiles):
        sheet.paste(t, (i * 64, 0))
    try:
        q = sheet.quantize(colors=n, method=Image.Quantize.MEDIANCUT)
        pal = q.getpalette() or []
        counts = sorted(q.getcolors() or [], key=lambda c: -c[0])
        out: list[tuple[int, int, int]] = []
        for _, idx in counts[:n]:
            r, g, b = pal[idx * 3:idx * 3 + 3]
            out.append((r, g, b))
        return out
    except Exception as e:                  # noqa: BLE001
        log.warning("[board] 取色失败：%s", e)
        return []


def _wrap(draw, text: str, font, max_w: int) -> list[str]:
    """按像素宽度折行。中文没有空格，只能逐字量宽——
    按字符数折行在中英混排时会一行长一行短。"""
    lines: list[str] = []
    cur = ""
    for ch in (text or ""):
        if ch == "\n":
            lines.append(cur)
            cur = ""
            continue
        if draw.textlength(cur + ch, font=font) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def _section_title(draw, y: int, text: str, font) -> int:
    draw.text((_PAD, y), text, font=font, fill=_FG)
    y += 46
    draw.line([(_PAD, y), (_W - _PAD, y)], fill=_LINE, width=2)
    return y + _GAP


def build(project_title: str, scene_name: str, views: list[dict],
          *, description: str | None = None,
          look_text: str | None = None) -> str | None:
    """拼一张设定板，落盘并返回 `/fw/media/generated/...` URL；失败返回 None。

    `views`：`[{"label","kind","image_url"}, ...]`，顺序即板面顺序
    （调用方按 `scene_view.VIEWS` 的 sort 传）。

    失败一律吞掉记 warning：设定板是**美术交付辅助**，拼不出来不该影响出片。
    """
    from PIL import Image, ImageDraw

    angles = [v for v in views if v.get("kind") == "angle"]
    frames = [v for v in views if v.get("kind") == "framing"]
    # 格子尺寸：一行 4 格，16:9 比例（设定板是给人看的横版）
    cell_w = (_W - _PAD * 2 - _GAP * (_COLS - 1)) // _COLS
    cell_h = int(cell_w * 9 / 16)
    label_h = 40

    f_title = _font(56, bold=True)
    f_sec = _font(34, bold=True)
    f_label = _font(26)
    f_body = _font(26)
    f_small = _font(22)

    # ---- 先算总高（PIL 不能事后扩画布，必须先量） ----
    probe = Image.new("RGB", (10, 10))
    pd = ImageDraw.Draw(probe)
    desc_lines = _wrap(pd, (description or "").strip() or "（本场景暂无文字描述）",
                       f_body, _W - _PAD * 2 - 32)
    look_lines = _wrap(pd, (look_text or "").strip(), f_small,
                       _W - _PAD * 2 - 32) if (look_text or "").strip() else []

    h = _PAD + 80                                    # 标题条
    for group in (angles, frames):
        if group:
            h += 46 + _GAP + cell_h + label_h + _GAP * 2
    h += 46 + _GAP + 90 + _GAP                       # 色彩参考
    h += 46 + _GAP + len(desc_lines) * 38 + 32 + _GAP  # 场景设定信息
    if look_lines:
        h += 46 + _GAP + len(look_lines) * 32 + 32 + _GAP
    h += _PAD

    canvas = Image.new("RGB", (_W, h), _BG)
    draw = ImageDraw.Draw(canvas)

    # ---- 标题条 ----
    y = _PAD
    head = f"《{project_title}》　{scene_name}" if project_title else scene_name
    draw.text((_PAD, y), head, font=f_title, fill=_FG)
    draw.text((_W - _PAD - 300, y + 20), "场景设定板 / SET DESIGN", font=f_small,
              fill=_MUTED)
    y += 80

    opened: list = []                                # 供取色

    def _row(title: str, group: list[dict], yy: int) -> int:
        yy = _section_title(draw, yy, title, f_sec)
        for i, v in enumerate(group[:_COLS]):
            x = _PAD + i * (cell_w + _GAP)
            im = _open_local(v.get("image_url"))
            if im is None:
                draw.rectangle([x, yy, x + cell_w, yy + cell_h], fill=_EMPTY_BG)
                tw = draw.textlength("未生成", font=f_label)
                draw.text((x + (cell_w - tw) / 2, yy + cell_h / 2 - 16),
                          "未生成", font=f_label, fill=_MUTED)
            else:
                opened.append(im)
                canvas.paste(_fit(im, cell_w, cell_h), (x, yy))
            draw.text((x, yy + cell_h + 8), v.get("label") or "-",
                      font=f_label, fill=_FG)
        return yy + cell_h + label_h + _GAP * 2

    if angles:
        y = _row("多视角参考　MULTI-ANGLE", angles, y)
    if frames:
        y = _row("景别参考 / 材质参考　SHOT SIZE & MATERIAL", frames, y)

    # ---- 色彩参考（从实际出图取色，不是让模型画色块） ----
    y = _section_title(draw, y, "色彩参考　PALETTE", f_sec)
    cols = _dominant_colors(opened, n=8)
    if cols:
        sw = (_W - _PAD * 2 - _GAP * 7) // 8
        for i, c in enumerate(cols):
            x = _PAD + i * (sw + _GAP)
            draw.rectangle([x, y, x + sw, y + 60], fill=c)
            draw.text((x, y + 66), "#%02X%02X%02X" % c, font=f_small, fill=_MUTED)
    else:
        draw.text((_PAD, y), "（无可取色的参考图）", font=f_body, fill=_MUTED)
    y += 90 + _GAP

    # ---- 场景设定信息 ----
    y = _section_title(draw, y, "场景设定信息　SET NOTES", f_sec)
    box_h = len(desc_lines) * 38 + 32
    draw.rectangle([_PAD, y, _W - _PAD, y + box_h], fill=(34, 34, 39))
    ty = y + 16
    for ln in desc_lines:
        draw.text((_PAD + 16, ty), ln, font=f_body, fill=_FG)
        ty += 38
    y += box_h + _GAP

    # ---- 影调档案（有就写上：核对"这个场景是不是按全片影调出的"） ----
    if look_lines:
        y = _section_title(draw, y, "全片影调　LOOK", f_sec)
        box_h = len(look_lines) * 32 + 32
        draw.rectangle([_PAD, y, _W - _PAD, y + box_h], fill=(34, 34, 39))
        ty = y + 16
        for ln in look_lines:
            draw.text((_PAD + 16, ty), ln, font=f_small, fill=_MUTED)
            ty += 32

    # ---- 落盘。复用 GENERATED_DIR（读 settings.data_dir）：
    #      绝不能在这里另写死 /root/filmweaver-data，否则 prod 会写进 dev 数据目录
    #      （providers/image.py:51 记过这个坑）。
    import uuid

    from .media import GENERATED_DIR
    name = f"board_{uuid.uuid4().hex[:12]}.jpg"
    try:
        canvas.save(GENERATED_DIR / name, "JPEG", quality=88)
    except Exception as e:                  # noqa: BLE001
        log.warning("[board] 设定板落盘失败：%s", e)
        return None
    return f"/fw/media/generated/{name}"
