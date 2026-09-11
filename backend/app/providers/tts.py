"""TTS Provider：RunningHub IndexTTS-1.5 语音克隆工作流（与主平台共用账号/工作流）。

工作流 2065316868176564226（节点图与主平台 audio_studio/providers.py 同源实测）：
  - #4 LoadAudio  : 参考音色音频（fieldName=audio）
  - #7 JjkText    : 待合成文本（fieldName=text）
  - #3 SaveAudio  : 产出（outputs 按 taskId 取，无需指定）
该工作流非本账号私有，仅传 workflowId 会报 810 WORKFLOW_NOT_SAVED_OR_NOT_RUNNING，
必须随 create 传完整 workflowJson 以"临时运行"模式跑（实测 code:0）。

协议：upload(multipart) → create → status 轮询 → outputs → 下载产物落本地。
"""
from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import httpx

from ..config import get_settings

# 工作流节点 id（固定）
_REF_NODE = "4"    # LoadAudio: audio
_TEXT_NODE = "7"   # JjkText: text

_WORKFLOW_GRAPH: dict = {
    "3": {"inputs": {"filename_prefix": "audio/ComfyUI", "audioUI": "", "audio": ["6", 0]},
          "class_type": "SaveAudio", "_meta": {"title": "Save Audio (FLAC) (Deprecated)"}},
    "4": {"inputs": {"audio": "placeholder.flac", "audioUI": ""},
          "class_type": "LoadAudio", "_meta": {"title": "Load Audio"}},
    "5": {"inputs": {"start_time": "0:00", "end_time": "0:15", "audio": ["4", 0]},
          "class_type": "AudioCrop", "_meta": {"title": "AudioCrop"}},
    "6": {"inputs": {"text": ["7", 0], "model_version": "IndexTTS-1.5", "language": "auto",
                     "speed": 1, "seed": 1045055454, "temperature": 1, "top_p": 0.8,
                     "top_k": 30, "repetition_penalty": 10, "length_penalty": 0,
                     "num_beams": 3, "max_mel_tokens": 1500, "sentence_split": "auto",
                     "reference_audio": ["5", 0]},
          "class_type": "IndexTTSNode", "_meta": {"title": "Index TTS"}},
    "7": {"inputs": {"text": "placeholder"}, "class_type": "JjkText", "_meta": {"title": "Text"}},
}

_AUDIO_MIME = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac",
               ".m4a": "audio/mp4", ".aac": "audio/aac"}

_POLL_INTERVAL = 5.0
_POLL_MAX_SEC = 300.0  # 单段最长等 5 分钟（与主平台 frontcut/tts.py 一致）


class TTSProvider:
    """IndexTTS 语音克隆：给参考音色 + 文本，产出旁白音频（本地 /media/generated/）。"""

    def __init__(self) -> None:
        s = get_settings()
        self.base = s.runninghub_base_url.rstrip("/")
        self.key = s.runninghub_api_key
        self.workflow_id = s.runninghub_tts_workflow_id

    @property
    def available(self) -> bool:
        return bool(self.key and self.workflow_id)

    async def _post(self, path: str, payload: dict, timeout: float = 120.0) -> dict:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(f"{self.base}{path}", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"RH TTS {path} HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH TTS {path} error: {d.get('msg')}")
        return d

    async def upload_ref_voice(self, local_path: Path) -> str:
        """上传参考音色，返回远端 fileName（同一批合成复用，只传一次）。"""
        ext = local_path.suffix.lower()
        mime = _AUDIO_MIME.get(ext, "audio/wav")
        async with httpx.AsyncClient(timeout=180.0) as c:
            r = await c.post(
                f"{self.base}/task/openapi/upload",
                data={"apiKey": self.key, "fileType": "audio"},
                files={"file": (local_path.name, local_path.read_bytes(), mime)},
            )
        if r.status_code != 200:
            raise RuntimeError(f"RH TTS upload HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH TTS upload error: {d.get('msg')}")
        fn = (d.get("data") or {}).get("fileName")
        if not fn:
            raise RuntimeError(f"RH TTS upload no fileName: {str(d)[:200]}")
        return fn

    async def synth(self, ref_file_name: str, text: str) -> str:
        """合成一段旁白：创建任务 → 轮询 → 下载产物到 generated/，返回 /fw/media 相对 URL。"""
        text = (text or "").strip()
        if not text:
            raise ValueError("旁白文本为空")
        d = await self._post("/task/openapi/create", {
            "apiKey": self.key, "workflowId": self.workflow_id,
            "workflowJson": json.dumps(_WORKFLOW_GRAPH, ensure_ascii=False),
            "nodeInfoList": [
                {"nodeId": _REF_NODE, "fieldName": "audio", "fieldValue": ref_file_name},
                {"nodeId": _TEXT_NODE, "fieldName": "text", "fieldValue": text},
            ]}, timeout=60.0)
        tid = str((d.get("data") or {}).get("taskId") or "")
        if not tid:
            raise RuntimeError(f"RH TTS create no taskId: {str(d)[:200]}")

        waited = 0.0
        while waited < _POLL_MAX_SEC:
            d = await self._post("/task/openapi/status",
                                 {"apiKey": self.key, "taskId": tid}, timeout=30.0)
            st = str(d.get("data") or "").upper()
            if st in ("SUCCESS", "SUCCEEDED", "COMPLETED"):
                return await self._download_output(tid)
            if st in ("FAILED", "ERROR", "FAIL"):
                raise RuntimeError(f"RH TTS 任务失败: {st}")
            await asyncio.sleep(_POLL_INTERVAL)
            waited += _POLL_INTERVAL
        raise RuntimeError("RH TTS 任务超时（5 分钟）")

    async def _download_output(self, tid: str) -> str:
        from ..media import GENERATED_DIR
        d = await self._post("/task/openapi/outputs",
                             {"apiKey": self.key, "taskId": tid}, timeout=60.0)
        data = d.get("data") or []
        url = ""
        for it in data:
            u = (it.get("fileUrl") or it.get("url")) if isinstance(it, dict) else str(it)
            if u:
                url = u
                break
        if not url:
            raise RuntimeError(f"RH TTS outputs 无产物: {str(d)[:200]}")
        ext = "." + url.lower().split("?")[0].rsplit(".", 1)[-1]
        if ext not in _AUDIO_MIME:
            ext = ".flac"
        dest = GENERATED_DIR / f"tts_{uuid.uuid4().hex[:12]}{ext}"
        async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as c:
            r = await c.get(url)
            r.raise_for_status()
            dest.write_bytes(r.content)
        return f"/fw/media/generated/{dest.name}"
