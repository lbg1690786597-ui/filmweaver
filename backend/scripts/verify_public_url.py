"""verify_public_url.py — 媒体「出网 URL」的环境前缀验收

## 为什么要有这个脚本

2026-09-02 现网事故：正式版用户点生成，报

    HTTP 400 InvalidParameter: The parameter content[1].image_url specified
    in the request is not valid: resource not found

日志里同时刷 `[VolcAsset] 入库失败(InvalidParameter.DownloadFailed:
Failed to download media from the provided URL)`。

根因不在火山，在我们给出去的 URL：库里存的相对地址前缀**恒为 `/fw`**
（`media.py` 写死，与环境无关），而 `to_public_url` 当时是
`public_base_url + url`，于是 prod 进程拼出

    http://118.196.33.51:9080/fw/media/generated/img_xxx.png
                             ^^^ 这条 nginx 路由指向 dev 后端 8002

文件在 prod 的数据目录里，dev 后端当然没有 → 远端拉取 404。

⚠️ 这个 bug 有很强的迷惑性：在 **dev 环境下拼出来完全正确**，本地怎么测都通过；
而且它在「生成的图误写进 dev 目录」那个 bug 存在期间是被**掩盖**的——那时
prod 的文件恰好也躺在 dev 目录里，`/fw` 这条链路歪打正着能拉到。修好写入
目录之后，这条一直错着的读取链路才暴露出来。

所以固化成断言，两个环境都要跑到：

    python3 scripts/verify_public_url.py

只读、不写任何文件、不发任何上游请求。
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FAIL: list[str] = []


def check(title: str, ok: bool, detail: str) -> None:
    print(f"  {'✓' if ok else '✗'} {title}  ({detail})")
    if not ok:
        FAIL.append(title)


def _fresh(env: str):
    """按指定 env 重新构造 Settings + to_public_url（get_settings 不带缓存）。"""
    os.environ["FW_ENV"] = env
    for m in [k for k in sys.modules if k.startswith("app.")]:
        del sys.modules[m]
    from app.providers.base import to_public_url
    from app.config import get_settings
    return get_settings(), to_public_url


STORED = "/fw/media/generated/img_deadbeef.png"


def main() -> None:
    # .env 里的 FW_ENV 会覆盖进程环境变量之外的默认值，这里显式指定两次。
    print("① dev 环境：出网前缀必须是 /fw（→ 后端 8002）")
    s, to_public_url = _fresh("dev")
    got = to_public_url(STORED)
    check("dev 拼出 /fw/media/...", got == "http://118.196.33.51:9080/fw/media/generated/img_deadbeef.png", got)
    check("dev media_base 带 /fw", s.media_base.endswith("/fw"), s.media_base)

    print("② prod 环境：出网前缀必须是 /fwp（→ 后端 8003）")
    s, to_public_url = _fresh("prod")
    got = to_public_url(STORED)
    check("prod 拼出 /fwp/media/...", got == "http://118.196.33.51:9080/fwp/media/generated/img_deadbeef.png", got)
    check("prod media_base 带 /fwp", s.media_base.endswith("/fwp"), s.media_base)

    print("③ 库里的 /fw 前缀必须被剥掉，不能叠成 /fwp/fw")
    check("无重复前缀", "/fw/" not in got.replace("/fwp/", "/"), got)

    print("④ 已是绝对地址 / data / asset 的原样透传（不得被加前缀）")
    for u in ("https://oss.example.com/a.png", "http://x/y.png",
              "data:image/png;base64,AAAA", "asset://volc/12345"):
        check(f"透传 {u[:28]}", to_public_url(u) == u, to_public_url(u)[:48])
    check("None 透传", to_public_url(None) is None, "None")
    check("空串透传", to_public_url("") == "", "''")

    print("⑤ 无前缀的 /media/... 也要能拼（历史数据里存在这种写法）")
    got2 = to_public_url("/media/uploads/a.mp4")
    check("拼成 /fwp/media/uploads/a.mp4",
          got2 == "http://118.196.33.51:9080/fwp/media/uploads/a.mp4", got2)

    print("⑥ media_public_base 显式配置时以它为准（可覆盖推导）")
    os.environ["FW_MEDIA_PUBLIC_BASE"] = "http://example.com/custom/"
    s, to_public_url = _fresh("prod")
    got3 = to_public_url(STORED)
    check("显式配置生效且去尾斜杠",
          got3 == "http://example.com/custom/media/generated/img_deadbeef.png", got3)
    del os.environ["FW_MEDIA_PUBLIC_BASE"]

    print()
    if FAIL:
        print(f"❌ {len(FAIL)} 项未通过: {FAIL}")
        sys.exit(1)
    print("全部通过 ✅")


if __name__ == "__main__":
    main()
