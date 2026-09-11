"""
volcano_assets.py — 火山方舟私域虚拟人像库客户端（AI 生成角色定妆图入库）

## 为什么需要

Seedance 2.0/2.5 会拦截"疑似真人"的参考图（报
InputImageSensitiveContentDetected.PrivacyInformation）。实测一个项目
40 个失败镜头里 39 个是这个原因——我们的定妆图是 AI 生成的虚构角色，
但分类器无法判断来源，对所有写实人脸一视同仁。

官方解法：把图入库成"私域虚拟人像"可信资产，拿 asset://<id> 引用。
虚拟人像（GroupType=AIGC）**不需要活体认证**，与真人人像库是两套流程。

## 鉴权与调用约定（均已实测确认）

- 端点   https://open.volcengineapi.com
- 签名   火山原生 v4，service=ark，region=cn-beijing
- Version 2024-01-01
- 方法   POST + JSON body（GET+query 也能过签名，但文档以 POST 为准）
- 权限   IAM 自定义策略 Action=["ark:*Asset*"]，Resource=["*"]

⚠️ ProjectName 必须显式传 "juying"：不传则落到 default 项目，而
**素材与推理接入点必须同项目**，否则生成时取不到素材（官方 FAQ 明载）。
"""
from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import logging
import os
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

HOST = "open.volcengineapi.com"
REGION = "cn-beijing"
SERVICE = "ark"
VERSION = "2024-01-01"

#: 本项目的火山资源项目名。不用 default——素材与推理接入点必须同项目。
PROJECT_NAME = "juying"

#: 虚拟人像素材组类型。真人人像是 LivenessFace（需活体认证），我们不用那条路。
GROUP_TYPE_AIGC = "AIGC"


class VolcAssetError(RuntimeError):
    """带火山错误码的异常，便于上层区分'没权限'与'素材不合规'。"""

    def __init__(self, code: str, message: str, request_id: str = ""):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.request_id = request_id


def _sign_and_call(action: str, body: dict, *, ak: str, sk: str,
                   timeout: float = 30.0) -> dict:
    """火山原生 v4 签名 + POST 调用，返回 Result 段。"""
    t = datetime.datetime.now(datetime.timezone.utc)
    xdate = t.strftime("%Y%m%dT%H%M%SZ")
    ds = xdate[:8]
    qs = urllib.parse.urlencode(sorted({"Action": action, "Version": VERSION}.items()))
    payload = json.dumps(body, ensure_ascii=False).encode()
    ph = hashlib.sha256(payload).hexdigest()
    ct = "application/json; charset=utf-8"
    signed = "content-type;host;x-content-sha256;x-date"
    canon = (f"POST\n/\n{qs}\ncontent-type:{ct}\nhost:{HOST}\n"
             f"x-content-sha256:{ph}\nx-date:{xdate}\n\n{signed}\n{ph}")
    cred = f"{ds}/{REGION}/{SERVICE}/request"
    sts = f"HMAC-SHA256\n{xdate}\n{cred}\n" + hashlib.sha256(canon.encode()).hexdigest()
    key = sk.encode()
    for part in (ds, REGION, SERVICE, "request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, sts.encode(), hashlib.sha256).hexdigest()

    req = urllib.request.Request(
        f"https://{HOST}/?{qs}", data=payload, method="POST",
        headers={
            "Host": HOST, "X-Date": xdate, "X-Content-Sha256": ph,
            "Content-Type": ct,
            "Authorization": (f"HMAC-SHA256 Credential={ak}/{cred}, "
                              f"SignedHeaders={signed}, Signature={sig}"),
        })
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        data = json.loads(resp.read() or b"{}")
    except Exception as e:  # noqa: BLE001
        raw = b""
        try:
            raw = e.read()  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
        try:
            data = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            raise VolcAssetError("NetworkError", repr(e)) from e

    meta = data.get("ResponseMetadata") or {}
    err = meta.get("Error") or {}
    if err:
        raise VolcAssetError(err.get("Code", "Unknown"),
                             err.get("Message", ""), meta.get("RequestId", ""))
    return data.get("Result") or {}


def _creds() -> tuple[str, str]:
    """取 AK/SK。走统一配置（config.Settings），不直接读 os.environ——
    与项目其余密钥同一套注入方式，便于集中管理。"""
    try:
        from ..config import get_settings
        s = get_settings()
        ak, sk = s.volc_access_key.strip(), s.volc_secret_key.strip()
    except ImportError:
        # 允许脱离 app 包单独跑（调试脚本）
        ak = os.environ.get("VOLC_ACCESS_KEY", "").strip()
        sk = os.environ.get("VOLC_SECRET_KEY", "").strip()
    if not ak or not sk:
        raise VolcAssetError(
            "NoCredentials",
            "缺少 VOLC_ACCESS_KEY / VOLC_SECRET_KEY（配在 backend/.env）")
    return ak, sk


def _project() -> str:
    """资源项目名。默认 juying——素材与推理接入点必须同项目。"""
    try:
        from ..config import get_settings
        return get_settings().volc_project_name or PROJECT_NAME
    except ImportError:
        return os.environ.get("VOLC_PROJECT_NAME", PROJECT_NAME)


# ---------- 素材组 ----------

def create_asset_group(name: str, description: str = "") -> str:
    """建虚拟人像素材组，返回 GroupId。一个角色一组，同角色多套造型进同一组。"""
    ak, sk = _creds()
    r = _sign_and_call("CreateAssetGroup", {
        "Name": name,
        "Description": description or name,
        "GroupType": GROUP_TYPE_AIGC,
        "ProjectName": _project(),
    }, ak=ak, sk=sk)
    gid = r.get("Id", "")
    log.info("[VolcAsset] 建组 name=%s group_id=%s", name, gid)
    return gid


def list_asset_groups(name: str = "") -> list[dict]:
    """按名称模糊查素材组。用于复用已有组，避免同一角色重复建组。"""
    ak, sk = _creds()
    flt: dict = {"GroupType": GROUP_TYPE_AIGC}
    if name:
        flt["Name"] = name
    r = _sign_and_call("ListAssetGroups", {
        "Filter": flt, "PageNumber": 1, "PageSize": 50,
        "ProjectName": _project(),
    }, ak=ak, sk=sk)
    return r.get("Items") or []


def get_or_create_group(name: str, description: str = "") -> str:
    """按名字取组，没有就建。名字用「项目id:角色名」保证跨项目不撞车。"""
    for it in list_asset_groups(name):
        if it.get("Name") == name:
            return it.get("Id", "")
    return create_asset_group(name, description)


# ---------- 素材 ----------

def create_asset(group_id: str, url: str, name: str = "",
                 asset_type: str = "Image") -> str:
    """上传一个素材，返回 AssetId。

    ⚠️ 异步接口：返回时素材还在 Processing，必须轮询 get_asset 等到 Active
    才能用于生成。官方明确不承诺上传时间 SLA。
    """
    ak, sk = _creds()
    body = {"GroupId": group_id, "URL": url, "AssetType": asset_type,
            "ProjectName": _project()}
    if name:
        body["Name"] = name
    r = _sign_and_call("CreateAsset", body, ak=ak, sk=sk)
    aid = r.get("Id", "")
    log.info("[VolcAsset] 上传素材 group=%s asset_id=%s name=%s", group_id, aid, name)
    return aid


def get_asset(asset_id: str) -> dict:
    """查素材详情。Status: Processing | Active | Failed。"""
    ak, sk = _creds()
    return _sign_and_call("GetAsset",
                          {"Id": asset_id, "ProjectName": _project()},
                          ak=ak, sk=sk)


def wait_active(asset_id: str, *, timeout_sec: float = 300.0,
                interval_sec: float = 5.0) -> tuple[bool, str]:
    """轮询到 Active。返回 (是否可用, 状态或错误说明)。

    有上限：不能无限等——CreateAsset 排队时可能很久，卡死会拖垮整条生成链路。
    超时按"暂不可用"处理，调用方回退到原始 URL（虽然可能被审核拒，
    但比整个任务挂起好）。
    """
    import time
    deadline = time.time() + timeout_sec
    last = "Unknown"
    while time.time() < deadline:
        info = get_asset(asset_id)
        last = info.get("Status", "Unknown")
        if last == "Active":
            return True, "Active"
        if last == "Failed":
            # 审核不通过多半是素材本身不合规（含真人雷同/违规内容）
            return False, f"Failed: {info.get('Moderation') or ''}"
        time.sleep(interval_sec)
    return False, f"Timeout（最后状态 {last}）"


def asset_uri(asset_id: str) -> str:
    """拼成视频生成 API 认的引用格式。"""
    return f"asset://{asset_id}"


# ---------- 按需入库（生成视频时调用）----------

#: 首次入库的等待上限。CreateAsset 是异步的、官方不承诺 SLA，
#: 等太久会拖垮整条生成链路——超时就先回退原图，状态留 Processing，下次接着轮。
_FIRST_WAIT_SEC = 180.0
#: 续轮的等待上限。上次已经排过队了，这次给短一点即可。
_RESUME_WAIT_SEC = 45.0


def resolve_reference_url(stage, public_url: str, project_id: str) -> str:
    """把定妆图解析成 Seedance 能用的引用，就地更新 stage 的入库状态。

    调用方是 jobs.py 的参考图注入（生成视频那一刻），不是资产生成时——
    "要用的时候再入库"避免给根本不出片的角色白花配额。

    返回 `asset://<id>`（已入库可用）或原始 `public_url`（回退）。
    **不抛异常**：入库只是优化项，失败了退回原图让生成照常走，
    大不了被审核拒——那是原本就有的行为，不能因为入库失败把整个任务打死。

    ⚠️ 调用方需在同一个 session 里 commit——本函数只改对象不提交，
    避免在批量注入的循环里逐条落库。
    """
    aid = (getattr(stage, "volc_asset_id", None) or "").strip()
    st = (getattr(stage, "volc_asset_status", None) or "").strip()

    # 已入库可用：直接复用，这是最常见的路径（同一角色几十个镜头共用一张图）
    if aid and st == "Active":
        return asset_uri(aid)

    # 审核不通过：重试也是同样结果，别浪费配额，直接回退
    if aid and st == "Failed":
        log.info("[VolcAsset] 素材审核未过，回退原图 stage=%s asset=%s",
                 getattr(stage, "id", "?"), aid)
        return public_url

    # 上次超时留下的 Processing：**继续轮询已有 asset_id**，不重新 CreateAsset
    # （重新创建会在库里堆同一张图的多份副本，还多花一次配额）
    if aid:
        ok, msg = wait_active(aid, timeout_sec=_RESUME_WAIT_SEC, interval_sec=5.0)
        stage.volc_asset_status = "Active" if ok else (
            "Failed" if msg.startswith("Failed") else "Processing")
        if ok:
            log.info("[VolcAsset] 续轮转 Active stage=%s asset=%s",
                     getattr(stage, "id", "?"), aid)
            return asset_uri(aid)
        return public_url

    # 首次入库
    try:
        char = getattr(stage, "character_name", "") or "unknown"
        gid = get_or_create_group(f"{project_id}:{char}",
                                  f"FilmWeaver 角色 {char}")
        new_id = create_asset(
            gid, public_url,
            name=f"{char}-{getattr(stage, 'stage_name', '') or ''}")
        ok, msg = wait_active(new_id, timeout_sec=_FIRST_WAIT_SEC, interval_sec=5.0)
        stage.volc_asset_id = new_id
        stage.volc_asset_status = "Active" if ok else (
            "Failed" if msg.startswith("Failed") else "Processing")
        if ok:
            return asset_uri(new_id)
        log.warning("[VolcAsset] 入库未就绪(%s)，本次回退原图 stage=%s asset=%s",
                    msg, getattr(stage, "id", "?"), new_id)
        return public_url
    except VolcAssetError as e:
        # 没配凭据 / 没权限 / 网络问题：静默回退，不影响生成
        log.warning("[VolcAsset] 入库失败(%s: %s)，回退原图 stage=%s",
                    e.code, e.message[:120], getattr(stage, "id", "?"))
        return public_url
