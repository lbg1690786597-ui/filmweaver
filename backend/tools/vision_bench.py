"""视觉反推造型描述 —— 候选模型实测台（一次性评测脚本，非生产链路）。

用途：给「用户直接上传了一张没有描述的资产图」这一场景选模型。
被测模型必须是**本平台网关上真实存在**的（zx1 / api4me / ark 的 /v1/models 里查得到）。

跑法（backend 目录内）：python3 tools/vision_bench.py
只做纯推理调用，不生成任何图片。
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.config import get_settings  # noqa: E402

S = get_settings()
MEDIA = "/root/filmweaver-data/generated"

SYS = (
    "你是影视剧组的造型记录员。看图，用一段中文写清画面中人物的**造型**：\n"
    "1) 只写服装（外套/上衣/下装/鞋）、发型、妆容、配饰，每件都要有颜色+款式"
    "（有明显材质就写材质）；\n"
    "2) 严禁描述背景、场景、光线、动作、表情、情绪、构图、画质，也不要猜品牌与价格；\n"
    "3) 图里看不清或没出现的部位（如被裁掉的鞋）就不写，不要编；\n"
    "4) 输出一段不超过 80 字的中文，不要分点、不要 markdown、不要前后缀说明。"
)
USER = "请写出这张人物定妆图的造型描述。"

IMAGES = [
    ("白薇·丝绸睡裙", "img_c7ac62826e71.png"),
    ("林晨·浅米色风衣", "img_4a53e7199240.png"),
    ("顾耀东·深色商务西装", "img_de13ec34dde4.png"),
]

# (标签, 渠道, model_id)：渠道决定 base_url 与 key
CANDIDATES = [
    ("gemini-3.6-flash（现默认文本模型）", "zx1", "gemini-3.6-flash"),
    ("gemini-3.5-flash", "zx1", "gemini-3.5-flash"),
    ("gemini-3-pro-preview", "zx1", "gemini-3-pro-preview"),
    ("gpt-5.6-terra", "zx1", "gpt-5.6-terra"),
    ("gpt-5.4-mini", "zx1", "gpt-5.4-mini"),
    ("grok-4.6", "zx1", "grok-4.6"),
    ("doubao-seed-2-1-pro", "ark", "doubao-seed-2-1-pro-260628"),
    ("doubao-seed-2-0-lite", "ark", "doubao-seed-2-0-lite-260428"),
    ("doubao-seed-1-6-vision", "ark", "doubao-seed-1-6-vision-250815"),
]


def channel(name: str) -> tuple[str, str]:
    if name == "ark":
        return S.ark_base_url.rstrip("/"), S.ark_api_key
    if name == "api4me":
        return S.api4me_base_url.rstrip("/") + "/v1", S.api4me_api_key
    return S.gateway_base_url.rstrip("/"), S.gateway_api_key


def data_uri(fn: str) -> str:
    with open(os.path.join(MEDIA, fn), "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


async def one(client: httpx.AsyncClient, ch: str, model: str, uri: str) -> dict:
    base, key = channel(ch)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": [
                {"type": "text", "text": USER},
                {"type": "image_url", "image_url": {"url": uri}},
            ]},
        ],
        "temperature": 0.2,
    }
    t0 = time.monotonic()
    try:
        r = await client.post(f"{base}/chat/completions", json=body,
                              headers={"Authorization": f"Bearer {key}"}, timeout=180)
        dt = time.monotonic() - t0
        if r.status_code != 200:
            return {"ok": False, "sec": dt, "err": f"HTTP {r.status_code}: {r.text[:160]}"}
        d = r.json()
        txt = (d["choices"][0]["message"].get("content") or "").strip()
        u = d.get("usage") or {}
        return {"ok": bool(txt), "sec": dt, "text": txt,
                "in": u.get("prompt_tokens"), "out": u.get("completion_tokens"),
                "err": "" if txt else "空回复"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "sec": time.monotonic() - t0, "err": repr(e)[:160]}


async def main() -> None:
    uris = {fn: data_uri(fn) for _, fn in IMAGES}
    out: dict[str, list] = {}
    async with httpx.AsyncClient() as client:
        async def run(label: str, ch: str, model: str) -> None:
            rows = []
            for name, fn in IMAGES:          # 同模型串行，避免单渠道被自己打限流
                rows.append((name, await one(client, ch, model, uris[fn])))
            out[label] = rows
        await asyncio.gather(*(run(*c) for c in CANDIDATES))
    for label, _, model in CANDIDATES:
        rows = out.get(label, [])
        ok = sum(1 for _, r in rows if r["ok"])
        avg = sum(r["sec"] for _, r in rows) / max(1, len(rows))
        print(f"\n{'=' * 78}\n## {label}  [{model}]  成功 {ok}/{len(rows)}  平均 {avg:.1f}s")
        for name, r in rows:
            if r["ok"]:
                print(f"  · {name}  {r['sec']:.1f}s  in={r['in']} out={r['out']}\n    {r['text']}")
            else:
                print(f"  · {name}  {r['sec']:.1f}s  ❌ {r['err']}")
    with open("/tmp/vision_bench.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)


asyncio.run(main())
