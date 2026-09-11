"""幂等 DB 迁移（IMPL 契约 C1）。

SQLite 无 alembic，用"检查列/表是否存在→缺则补"的幂等脚本，启动时自动执行，
可重复运行。新列同时也已声明在 db.py 模型上（create_all 只建新表不改旧表，
所以旧库靠本脚本补列）。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re

from sqlalchemy import inspect, text

from .db import engine

logger = logging.getLogger(__name__)

# 表 -> [(列名, DDL 片段)]
_COLUMNS: dict[str, list[tuple[str, str]]] = {
    # 从视频剥离出来的音频段（kind="shot"）要记住来源镜头：
    # 它同时是导出时"该静音哪个镜头的原音轨"的唯一依据，见 db.py AudioClip。
    "audio_clips": [
        ("source_shot_id", "source_shot_id VARCHAR(16)"),
        # 6.9 修剪窗口。与 shots 的同名两列同构，NULL = 整段使用。
        # 刻意**不**给 DEFAULT 0：0 和 NULL 在这里含义不同 ——
        # NULL 是"没剪过（播满 duration）"，0 是"从头开始剪了"，
        # 而 clip_dur_sec 为 0 更是"一帧都不播"。给了默认值，
        # 老数据会一夜之间全部变成"已修剪成 0 秒"，即全体静音。
        ("clip_in_sec", "clip_in_sec REAL"),
        ("clip_dur_sec", "clip_dur_sec REAL"),
    ],
    "jobs": [
        ("created_at", "created_at VARCHAR(32)"),
        ("updated_at", "updated_at VARCHAR(32)"),
        # B30：从 payload JSON 冗余出来的索引列，见 db.py Job.project_id
        ("project_id", "project_id VARCHAR(16)"),
    ],
    "projects": [
        ("episodes", "episodes TEXT"),                       # JSON: [{order,title,word_count}]
        ("production_mode", "production_mode VARCHAR(16)"),  # drama | narration
        # 解说剧的解说音色（整片共用，不挂角色）
        ("narration_voice_url", "narration_voice_url TEXT"),
        # 全片影调档案（Look）：色温/反差/饱和/黑位/颗粒/镜头质感，见 look_profile
        ("look_json", "look_json TEXT"),
        # 画风预设 key（urban/period/anime_3d/thick_paint/guoman，见 style_preset）。
        # 与 production_mode 分工：模式管配音，画风管画面。NULL = 都市档（改动前行为）。
        ("art_style", "art_style VARCHAR(24)"),
        # 建项目时刻（ISO8601）。id 是随机 uuid，不含时间，不加这列就没法按时间排序。
        # 老库由 _backfill_project_created_at 从 jobs 回填。
        ("created_at", "created_at VARCHAR(32)"),
        # 回收站墓碑（ISO8601）。NULL = 在用。见 db.Project.deleted_at
        ("deleted_at", "deleted_at VARCHAR(32)"),
    ],
    "shots": [
        ("fail_reason", "fail_reason TEXT"),
        ("fail_kind", "fail_kind VARCHAR(16)"),
        ("episode", "episode INTEGER DEFAULT 1"),
        ("status", "status VARCHAR(16) DEFAULT 'pending'"),
        # pending | prompting | generating | review | adopted | failed
        ("profile_override", "profile_override TEXT"),       # JSON 局部覆盖
        ("is_special", "is_special INTEGER DEFAULT 0"),
        ("adopted_version", "adopted_version INTEGER"),
        ("gen_prompt", "gen_prompt TEXT"),                   # 拆解后预生成的提示词
        ("stale", "stale INTEGER DEFAULT 0"),                # 所属集剧本已改→过期
        # P2-15 过期原因：rebreak(需重拆本集) | reprompt(需重出提示词) | regen(只需重出片)。
        # 老库回填 NULL——不猜原因，读的地方按最保守分支处理（见 app/stale.py）。
        ("stale_reason", "stale_reason TEXT"),
        ("duration_sec", "duration_sec REAL"),               # AI 拆镜判定的镜头时长
        ("disabled", "disabled INTEGER DEFAULT 0"),          # P0-3 停用（保留但不导出）
        ("special_name", "special_name VARCHAR(255)"),       # P0-3 外部素材镜头展示名
        ("thumb_url", "thumb_url TEXT"),                     # P1-1 当前采用版本首帧图
        ("ref_overrides", "ref_overrides TEXT"),             # P1-2 注入覆写 JSON（L3）
        ("refs_stale", "refs_stale INTEGER DEFAULT 0"),      # P1-2 参考图已变待重生成
        # 首帧流水线（i2va）：本镜当前采用的首帧图（图生图产出，视频由它生长）
        ("first_frame_url", "first_frame_url TEXT"),
        # ⛔ 已停用（2026-09-11）：原「尾帧接力」的存储列，现只保留历史数据。
        # 不再写入，也不要基于它新建功能 —— 见 db.Shot.tail_frame_url 与
        # docs/DECISION-2026-09-11-尾帧接力停用.md。列保留是为了不让存量文件变孤儿。
        ("tail_frame_url", "tail_frame_url TEXT"),
        # gen_prompt 的来源：draft(拆解初稿) | aligned(已按资产对齐) |
        # sent(出片实际下发稿) | manual(用户手填)。NULL 视同 draft。
        ("prompt_state", "prompt_state VARCHAR(16)"),
        # TB-01 镜头分割：在 video_url 中的取片窗口（秒）。分割不重新转码，
        # 前后两段共用同一个 video_url，各自记住自己的窗口，导出时 -ss/-t 取片段。
        # NULL = 整段使用（未被分割过的镜头）。
        ("clip_in_sec", "clip_in_sec REAL"),
        ("clip_dur_sec", "clip_dur_sec REAL"),
        # TB-03/TB-10 画面与音频调整（JSON）：缩放/旋转/位移/不透明度/镜像/
        # 变速/音量/淡入淡出。导出时翻译成 ffmpeg filter 链。NULL = 不做任何处理。
        ("transform_meta", "transform_meta TEXT"),
        # Render V2 多视频轨：0 = 主轨（默认），1+ = Overlay 层，数字越大越靠上。
        # 叠加轨的镜头不参与主轨时间累加，用 overlay_start_sec 定位。
        ("track_index", "track_index INTEGER DEFAULT 0"),
        ("overlay_start_sec", "overlay_start_sec REAL"),
        # ---- 3.9 镜头连贯性 ----
        # 在场推导（L1.5）：同一场连续戏里，**上一镜出现过且没有离场描写**的角色
        # 视为仍在场。JSON 字符串数组，由 continuity.derive_present_characters 写入。
        #
        # 为什么不直接改 characters：那一列是**拆解真值**（L1），人工 add/remove
        # 靠它对消（见 routes_v2 的 patch_shot_refs）。把推导结果混进去，
        # 用户就再也分不清"AI 拆出来的"和"我们猜的"，也没法单独否决推导。
        # 最终注入 = ((L1 ∪ L1.5) ∪ 人工add) − 人工remove，见 db.effective_characters。
        ("present_characters", "present_characters TEXT"),
        # 走位台账：本镜**结束时刻**各在场角色的位置/姿态/朝向（JSON 对象）。
        # 下一个连续镜头把它作为"开场必须与之一致"的硬事实注入提示词 ——
        # 这是"人物位置在相邻镜之间跳变"的正解：位置必须是可传递的显式状态，
        # 光靠尾帧图（只是众多参考图之一）和一句"延续上一镜"是钳不住的。
        # 见 jobs._blocking_ctx / prompt_opt.extract_blocking。
        ("blocking_out", "blocking_out TEXT"),
    ],
    # shot_versions 建表走 _TABLES（IF NOT EXISTS），旧库新增列必须在此补，否则老库读不到
    "shot_versions": [
        ("thumb_url", "thumb_url TEXT"),                     # P1-1 该版本首帧图
    ],
    # 角色参考音色（资产卡上传音频；TTS 合成时作该角色音色）
    # profile_json：角色形象档案（结构化五官/骨相/气质，见 character_profile）
    "assets": [
        ("voice_url", "voice_url TEXT"),
        ("profile_json", "profile_json TEXT"),
        # 场景设定板拼版图（只给人看，永不注入镜头，见 db.Asset.board_url）
        ("board_url", "board_url TEXT"),
        # 用户手动删除的墓碑（ISO 时刻）。NULL = 在用。见 db.Asset.deleted_at：
        # 真删会被三处自动流程原地建回来，故用墓碑而非 DELETE。
        ("deleted_at", "deleted_at VARCHAR(32)"),
    ],
    # 服装继承（"同一场景下同一人物服装相同"）：
    #   location    该造型绑定的**归一场景名**（canonical，见 scene_aliases）
    #   scene_bound 1=场景决定型服装（睡衣@卧室/浴袍@浴室/泳装@泳池），可跨集沿用；
    #               0=事件型服装（婚纱@教堂/晚礼服@宴会厅），只在自己的镜号区间生效
    "asset_stages": [
        ("location", "location VARCHAR(255)"),
        ("scene_bound", "scene_bound INTEGER DEFAULT 0"),
        ("source_stage_id", "source_stage_id VARCHAR(16)"),
        # 火山私域虚拟人像库：入库后用 asset:// 引用，绕过 Seedance 人脸审核
        ("volc_asset_id", "volc_asset_id VARCHAR(64)"),
        ("volc_asset_status", "volc_asset_status VARCHAR(16)"),
        # 造型阶段的软删墓碑（老库全是 NULL = 在用），见 stage_gate.py
        ("deleted_at", "deleted_at VARCHAR(32)"),
    ],
    # 场景锚定图改按**归一场景**共享：同一个房间跨集必须是同一张基准帧
    "scene_anchors": [
        ("canonical", "canonical VARCHAR(255)"),
    ],
    # 场景多视角参考图（建表走 _TABLES；将来加列写这里，否则老库读不到）
    "scene_views": [
        ("qc_json", "qc_json TEXT"),
    ],
}

_TABLES: dict[str, str] = {
    # 场景多视角参考图：一个场景资产 8 行（方位 4 + 景别 4），见 scene_view.VIEWS。
    # 单独建表而不是塞 asset_stages：那张表每一列都是"角色×造型×集区间"语义，
    # 场景视图一列都用不上，且按 character_name 过滤的既有查询会莫名捞到场景行。
    "scene_views": """
        CREATE TABLE IF NOT EXISTS scene_views (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          asset_id VARCHAR(16) NOT NULL,
          view_key VARCHAR(32) NOT NULL,
          kind VARCHAR(16) NOT NULL,
          label VARCHAR(64) NOT NULL,
          sort INTEGER DEFAULT 0,
          image_url TEXT,
          prompt TEXT,
          qc_json TEXT
        )""",
    "shot_versions": """
        CREATE TABLE IF NOT EXISTS shot_versions (
          id VARCHAR(16) PRIMARY KEY,
          shot_id VARCHAR(16) NOT NULL,
          version_no INTEGER NOT NULL,
          video_url TEXT,
          thumb_url TEXT,
          model_id VARCHAR(64),
          prompt TEXT,
          meta TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    "asset_stages": """
        CREATE TABLE IF NOT EXISTS asset_stages (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          character_name VARCHAR(255) NOT NULL,
          stage_name VARCHAR(255) NOT NULL,
          ep_from INTEGER NOT NULL,
          ep_to INTEGER NOT NULL,
          shot_from INTEGER,
          shot_to INTEGER,
          image_url TEXT,
          description TEXT,
          location VARCHAR(255),
          scene_bound INTEGER DEFAULT 0,
          source_stage_id VARCHAR(16),
          status VARCHAR(16) DEFAULT 'draft'
        )""",
    # P1-3 素材池落库（修 E4）：上传素材元数据入项目维度，刷新/换设备不丢
    "media_clips": """
        CREATE TABLE IF NOT EXISTS media_clips (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          name VARCHAR(255) NOT NULL,
          url TEXT NOT NULL,
          size INTEGER DEFAULT 0,
          kind VARCHAR(16) NOT NULL,
          duration REAL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # P2-4 音频轨（修 D5）：TTS 旁白/配乐段，锚定镜头 order+镜内偏移
    "audio_clips": """
        CREATE TABLE IF NOT EXISTS audio_clips (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          kind VARCHAR(16) DEFAULT 'tts',
          text TEXT,
          url TEXT,
          duration REAL DEFAULT 0,
          start_shot_order INTEGER DEFAULT 1,
          start_offset_sec REAL DEFAULT 0,
          voice_ref_url TEXT,
          source_shot_id VARCHAR(16),
          status VARCHAR(16) DEFAULT 'pending',
          error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # Render V2 转场：锚在两个镜头的接缝上，而非绝对时间点
    "transitions": """
        CREATE TABLE IF NOT EXISTS transitions (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          type VARCHAR(32) DEFAULT 'fade',
          duration REAL DEFAULT 0.5,
          from_shot_id VARCHAR(16) NOT NULL,
          to_shot_id VARCHAR(16) NOT NULL,
          params TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # TB-02 字幕轨：文本/字幕段，时间定位与 audio_clips 同构（锚定镜头 + 镜内偏移）
    "subtitle_clips": """
        CREATE TABLE IF NOT EXISTS subtitle_clips (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          text TEXT DEFAULT '',
          kind VARCHAR(16) DEFAULT 'subtitle',
          start_shot_order INTEGER DEFAULT 1,
          start_offset_sec REAL DEFAULT 0,
          duration REAL DEFAULT 3,
          style TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # 首帧流水线防偏移核心：每 (项目,集,场景) 一张"场景基准帧"。
    # 同场景所有镜头的首帧都以它为参考图 → 陈设/光线/机位基调统一，
    # 避免各镜各自生图导致同一场景在不同镜头间漂移。
    "scene_anchors": """
        CREATE TABLE IF NOT EXISTS scene_anchors (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          episode INTEGER NOT NULL DEFAULT 1,
          location VARCHAR(255) NOT NULL,
          canonical VARCHAR(255),
          image_url TEXT,
          prompt TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )""",
    # 场景归一字典：Shot.location 原值 → 归一场景名。
    #
    # 为什么必须有这张表：拆解出来的 location 是**每集各写一遍**的自由文本，
    # 同一个物理空间在不同集里叫法不同（实测项目 36c691b20387 的 22 个场景名
    # **跨集复用率为 0**）：
    #   「金诚律所 密室会客室」ep2 / 「夜 内 沈修杰律所办公室」ep5
    #   「顾氏集团 总裁办走廊」ep3 / 「日 内 鼎盛集团 总裁办走廊」ep4
    # 于是"同一场景下同一人物服装相同"这条规则用字符串相等根本判不出来，
    # 场景锚定图也会让同一个房间在每集长成不同样子。
    #
    # source='manual' 的行由用户在资产页手改过，AI 重跑归一时**不覆盖**。
    "scene_aliases": """
        CREATE TABLE IF NOT EXISTS scene_aliases (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          raw_name VARCHAR(255) NOT NULL,
          canonical VARCHAR(255) NOT NULL,
          time_of_day VARCHAR(16),
          int_ext VARCHAR(8),
          source VARCHAR(16) DEFAULT 'ai'
        )""",
    # 角色归一字典（N2）：与 scene_aliases 同构。见 db.py CharacterAlias 的说明——
    # 「陆明」与「少年陆明」是同一人（该合并），但「陆明父亲」不是（合了就是数据损坏），
    # 所以判定走 LLM 语义而非字面子串。
    "character_aliases": """
        CREATE TABLE IF NOT EXISTS character_aliases (
          id VARCHAR(16) PRIMARY KEY,
          project_id VARCHAR(16) NOT NULL,
          raw_name VARCHAR(255) NOT NULL,
          canonical VARCHAR(255) NOT NULL,
          age_stage VARCHAR(16),
          source VARCHAR(16) DEFAULT 'ai'
        )""",
}

#: 额外索引（IF NOT EXISTS 幂等）。场景锚点按 (项目,集,场景) 唯一，
#: 用唯一索引在 DB 层兜底并发重复插入（应用层另有每场景锁）。
_INDEXES: list[str] = [
    # 剥离原声的反查：导出前要按 source_shot_id 判断哪些镜头该静音。
    # 必须显式建——模型上的 index=True 只在 create_all 建新表时生效，
    # 老库走的是 ALTER TABLE ADD COLUMN，不会带出索引。
    "CREATE INDEX IF NOT EXISTS ix_audio_clips_source_shot "
    "ON audio_clips (source_shot_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_anchors_key "
    "ON scene_anchors (project_id, episode, location)",
    # 归一场景锚点：一个归一场景全剧只保一张基准帧（同一个房间跨集不再漂）。
    # canonical 为 NULL 的旧行不受约束（SQLite 唯一索引视多个 NULL 为互不相同）。
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_anchors_canon "
    "ON scene_anchors (project_id, canonical)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_aliases_raw "
    "ON scene_aliases (project_id, raw_name)",
    # 角色归一（N2）：同 scene_aliases，一个原始写法在一个项目里只有一条映射
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_character_aliases_raw "
    "ON character_aliases (project_id, raw_name)",
    # 服装继承的查询主路径：按 (项目,角色) 取候选阶段，再在应用层按特异性排序
    "CREATE INDEX IF NOT EXISTS ix_asset_stages_char "
    "ON asset_stages (project_id, character_name)",
    # 场景视图：注入时按 asset_id 取全部 8 行（scene_view.list_views 的唯一查询路径）
    "CREATE INDEX IF NOT EXISTS ix_scene_views_asset "
    "ON scene_views (asset_id, sort)",
    # 一个场景资产的一个视角只能有一行——重复行会让"补齐缺失视角"反复生成同一张
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_views_key "
    "ON scene_views (asset_id, view_key)",
    # B30 任务面板：按 (项目, 状态) 筛 job，避免全表载入后再逐行解析 payload
    "CREATE INDEX IF NOT EXISTS ix_jobs_project "
    "ON jobs (project_id, status)",
]


def _backfill_job_project_id(conn) -> int:
    """把历史 job 的 project_id 从 payload JSON 里回填出来（B30）。

    不回填的话，加了列也没用：老任务这一列全是 NULL，按项目筛就查不到它们，
    「AI 任务」面板的历史记录会**整片消失** —— 比不加这个列更糟。

    SQLite 3.38+ 才有 ->> 运算符，版本不定，所以在 Python 侧解析后逐条更新。
    只在存在 NULL 行时才跑，跑完即幂等（下次启动 0 行待回填）。
    """
    rows = conn.execute(text(
        "SELECT id, payload FROM jobs WHERE project_id IS NULL")).fetchall()
    if not rows:
        return 0
    done = 0
    for jid, payload in rows:
        try:
            data = json.loads(payload or "{}")
            pid = data.get("project_id") if isinstance(data, dict) else None
        except (ValueError, TypeError):
            pid = None
        if not pid:
            continue      # 无归属的 job（如 compose）保持 NULL，属正常
        conn.execute(text("UPDATE jobs SET project_id = :p WHERE id = :i"),
                     {"p": pid, "i": jid})
        done += 1
    return done


def _migrate_production_modes(conn) -> int:
    """2026-08：生产模式从「技术参数预设」改为「配音策略」。

    旧值 fast/consistent/premium/first_frame/custom 全部映射到 drama（真人剧）——
    它们描述的是画质/链路档位，与配音无关，而既有项目跑的都是"人物说人物的台词"，
    正是 drama 的语义。

    同时把旧预设隐含的技术参数**显式写进 default_profile**：
    改版后 resolver 优先读 default_profile，不写的话老项目会丢失
    模型/分辨率/生成方式设定，静默退回全局默认（换模型 = 换风格，用户看不出原因）。
    custom 项目本来就有 default_profile，不覆盖。
    """
    legacy = {
        "fast":        {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                        "generation_mode": "full_reference", "resolution": "720p"},
        "consistent":  {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                        "generation_mode": "full_reference", "resolution": "1080p"},
        "premium":     {"video_model": "seedance-2.0", "image_model": "gpt-image-2",
                        "generation_mode": "full_reference", "resolution": "1080p"},
        "first_frame": {"video_model": "seedance-2.0", "image_model": "nano-banana-pro",
                        "generation_mode": "i2va", "resolution": "1080p"},
    }
    rows = conn.execute(text(
        "SELECT id, production_mode, default_profile FROM projects "
        "WHERE production_mode IN ('fast','consistent','premium','first_frame','custom')"
    )).fetchall()
    done = 0
    for pid, mode, profile in rows:
        params = legacy.get(mode)
        # 老项目没写过 default_profile 才补；custom 的已有配置必须原样保留
        if params and not (profile or "").strip():
            conn.execute(
                text("UPDATE projects SET production_mode='drama', "
                     "default_profile=:p WHERE id=:i"),
                {"p": json.dumps(params, ensure_ascii=False), "i": pid})
        else:
            conn.execute(
                text("UPDATE projects SET production_mode='drama' WHERE id=:i"),
                {"i": pid})
        done += 1
    return done


def _backfill_project_created_at(conn) -> int:
    """给老项目回填 `projects.created_at`（项目列表按时间排序的前置）。

    为什么需要回填、而不是"新项目才有时间就行"：`created_at` 是 NULL 的项目
    在"按创建时间排序"里只能沉底，而现存项目**全部**是 NULL —— 排序功能
    上线当天就等于对老项目失效，用户看到的是"新建的一个在最上面，其余几十个
    仍是一团乱麻"。

    时间源取 `MIN(jobs.created_at)`：那是这个项目第一次跑任务的时刻，
    与真实建项目时间相差通常在分钟级，用于排序完全够。
    ⚠️ 只用 jobs 这一个源 —— 它是 `datetime.now(timezone.utc).isoformat()`
    格式，与新写入的值同构、可直接字典序比较。`shot_versions.created_at`
    走的是 SQLite `datetime('now')`（`YYYY-MM-DD HH:MM:SS`，无 T 无时区），
    混进来会排出一堆乱序，宁可不取。

    从没跑过任何任务的空项目回填不到，保持 NULL —— **不编造一个假时间**，
    排序时按"缺失值沉底"处理（见前端 projectSort）。
    """
    n = conn.execute(text(
        "UPDATE projects SET created_at = ("
        "  SELECT MIN(j.created_at) FROM jobs j"
        "  WHERE j.project_id = projects.id AND j.created_at IS NOT NULL)"
        " WHERE created_at IS NULL"
        "   AND EXISTS (SELECT 1 FROM jobs j2"
        "               WHERE j2.project_id = projects.id"
        "                 AND j2.created_at IS NOT NULL)"
    )).rowcount
    return int(n or 0)


#: sha256 十六进制摘要的形状。会话 token 原为 `token_urlsafe(32)`（43 字符、
#: 含 `-`/`_`），与它不可能混淆，所以"是不是已经哈希过"可以只看形状。
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def _migrate_hash_session_tokens(conn) -> int:
    """把 `auth_sessions.token` 从明文原地改成 sha256（S3 的无争议项）。

    为什么原地改而不是清表：**客户端手里的明文 token 不变**，哈希一遍存回去，
    `verify_session` 下次查的就是同一个摘要 —— 所有人的登录态照旧。清表的话
    每个已登录用户都会在这次重启后被踢回登录页，而这个改动本身对用户无感，
    不该拿"全员重新扫码"当代价。

    幂等：已是 64 位小写十六进制的行跳过，所以重复启动只在第一次有动作。

    ⚠️ 若本迁移失败（放在 savepoint 里、只告警），后果是库里仍是明文而校验
    已按摘要查 → 全员会话失效、需重新登录。不会崩服务，但日志要看得见。
    """
    rows = conn.execute(text("SELECT token FROM auth_sessions")).fetchall()
    done = 0
    for (tok,) in rows:
        if not tok or _HEX64.match(tok):
            continue
        conn.execute(
            text("UPDATE auth_sessions SET token=:d WHERE token=:t"),
            {"d": hashlib.sha256(tok.encode("utf-8")).hexdigest(), "t": tok})
        done += 1
    return done


def run_migrations() -> list[str]:
    """执行迁移，返回本次实际应用的变更清单（空=无需变更）。"""
    applied: list[str] = []
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, cols in _COLUMNS.items():
            if table not in insp.get_table_names():
                continue  # 新库由 create_all 直接建全，无需补列
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in cols:
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))
                    applied.append(f"{table}.{name}")
        for name, ddl in _TABLES.items():
            conn.execute(text(ddl))  # IF NOT EXISTS 自身幂等
            if name not in insp.get_table_names():
                applied.append(f"table:{name}")
        # 索引是**纯性能优化**，建不出来最多是慢，不该让服务起不来。
        # 原来任何一条 DDL 抛异常都会冒出 run_migrations() → lifespan，
        # 后端直接启动失败（配合 Restart=always 就是崩溃循环）。
        # 触发场景很现实：索引引用的列因上面某次 ALTER 失败而不存在、
        # 或历史数据违反唯一索引。
        # 与之相对，上面的 ALTER/CREATE TABLE 是结构性的，缺了会让运行时
        # 报更难懂的错，那些**应该**大声失败，故只放宽索引这一段。
        for ddl in _INDEXES:
            # 每条单独开 SAVEPOINT：失败只回滚这一条，不牵连外层事务里
            # 已经做完的 ALTER / CREATE TABLE。
            # （SQLite 上失败语句不会污染事务，但 PostgreSQL 会把整个事务
            #  标记为 aborted —— 用 savepoint 两种库都安全。）
            try:
                with conn.begin_nested():
                    conn.execute(text(ddl))  # IF NOT EXISTS 自身幂等
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] 索引创建失败(已跳过): %s | %s",
                               ddl.split("ON")[0].strip()[:80], exc)
        # 回填 jobs.project_id（B30）。与索引同理：失败只影响查询性能与历史
        # 可见性，不该让服务起不来，故也放在 savepoint 里、只告警。
        if "jobs" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _backfill_job_project_id(conn)
                if n:
                    applied.append(f"backfill:jobs.project_id×{n}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] jobs.project_id 回填失败(已跳过): %s", exc)
        # 生产模式改版（drama/narration）。同样放 savepoint：
        # 失败不该挡住服务启动——resolver 对旧值有 _LEGACY_DEFAULTS 兜底。
        if "projects" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _migrate_production_modes(conn)
                if n:
                    applied.append(f"production_mode→drama×{n}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] production_mode 迁移失败(已跳过): %s", exc)
            # 回填 projects.created_at。必须排在 jobs.project_id 回填**之后**——
            # 它正是靠 jobs.project_id 反查时间的，顺序反了老 job 那一列还是
            # NULL，回填会一条都匹配不上。同样放 savepoint：失败只是排序退化
            # 成"缺失值沉底"，不该挡住服务启动。
            if "jobs" in insp.get_table_names():
                try:
                    with conn.begin_nested():
                        n = _backfill_project_created_at(conn)
                    if n:
                        applied.append(f"backfill:projects.created_at×{n}")
                except Exception as exc:  # noqa: BLE001
                    logger.warning("[migrations] projects.created_at 回填失败(已跳过): %s", exc)
        # 会话 token 哈希化（S3）。同样 savepoint + 只告警：失败不该挡住服务
        # 启动，代价是全员需重新登录（见 `_migrate_hash_session_tokens`）。
        if "auth_sessions" in insp.get_table_names():
            try:
                with conn.begin_nested():
                    n = _migrate_hash_session_tokens(conn)
                if n:
                    applied.append(f"auth_sessions.token→sha256×{n}")
            except Exception as exc:  # noqa: BLE001
                logger.warning("[migrations] 会话 token 哈希化失败(已跳过): %s", exc)
    return applied
