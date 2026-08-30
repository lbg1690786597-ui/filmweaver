# 内置字幕字体

烧字幕时传给 ffmpeg 的 `subtitles=...:fontsdir=<这个目录>`，让随包分发的
思源黑/宋在**用户机器没装它们**时也能用——字形 100% 确定，换台电脑导出的
成片长得一模一样。

> ⚠️ fontsdir 是**追加**搜索路径，不是限定路径（ffmpeg 6.x + libass 实测：
> 传了 fontsdir 后 `FontName=DejaVu Sans` 仍能命中 `/usr/share/fonts/...`）。
> 所以它对系统字体既没帮助也没坏处，唯一的副作用是 libass 会挨个尝试打开
> 目录里的每个文件当字体、对 `README.md` / `LICENSE-*.txt` 打出
> `Error opening memory font`（无害，但吵）。故只在
> `fontSource === "bundled"` 时传，见 `src/render/renderer.ts`。

## 字体

| 文件 | fontconfig 家族名 | 许可 |
|---|---|---|
| `NotoSansCJK-Regular.ttc` | `Noto Sans CJK SC`（思源黑体） | SIL OFL 1.1 |
| `NotoSerifCJK-Regular.ttc` | `Noto Serif CJK SC`（思源宋体） | SIL OFL 1.1 |

两个都是 pan-CJK 集合（.ttc），同一文件里还含 TC/JP/KR 家族。
只放 Regular 不放 Bold：字幕的加粗走 ASS 的 `Bold=1`（合成粗体），
再塞两个 Bold 文件会让安装包再涨 47MB，不值。

许可原文见 `LICENSE-Noto-CJK.txt`（OFL 允许随软件分发，需保留许可文件）。

## 为什么仓库里看不到这两个文件

`.gitignore` 挡掉了：合计 46MB，而 `.git` 本身才 20MB，提交进去每个 clone
都要永久多背 46MB。用脚本取回：

```bash
bash scripts/fetch-fonts.sh
```

**缺失不会导致构建失败**，只是安装包里没有内置字体、
`resolveResource("resources/fonts")` 拿不到目录，字幕回落到系统字体。
正式出包前请先跑一遍这个脚本。
