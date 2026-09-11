"""数据层：SQLite 持久化（dev MVP）。

选 SQLite 原因：零外部依赖、单文件、适合 MVP；SQLAlchemy 写法与 postgres 一致，
后续切 postgres 只需换 DATABASE_URL，模型/查询零改动。
"""
from __future__ import annotations

import json
import os

from sqlalchemy import String, Text, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

# dev 默认落在 backend 目录下的本地文件；可用环境变量覆盖为 postgres
DATABASE_URL = os.environ.get(
    "FW_DATABASE_URL", "sqlite:////root/filmweaver-dev/backend/filmweaver_dev.db"
)

_IS_SQLITE = DATABASE_URL.startswith("sqlite")

# 连接池：图像侧取消并发上限后，写入频率大幅上升，而 FastAPI 的 33 个同步路由
# 跑在线程池里、与 job 的 async 写**真并发**。默认 pool_size=5 会成为新瓶颈。
# ⚠️ 这是连接池容量，不是"生成并发数"——不受并发铁律约束，也不影响任何生成并发。
_ENGINE_KW: dict = {"echo": False}
if _IS_SQLITE:
    _ENGINE_KW.update(
        pool_size=20, max_overflow=30, pool_pre_ping=True,
        # 锁等待超时 30s（默认 5s）：高并发写下宁可多等也别抛 database is locked
        connect_args={"timeout": 30.0, "check_same_thread": False},
    )

engine = create_engine(DATABASE_URL, **_ENGINE_KW)


if _IS_SQLITE:
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _record) -> None:  # noqa: ANN001
        """每条新连接建立时设好并发相关 PRAGMA。

        journal_mode=WAL：默认的 delete 模式下，写事务持有 EXCLUSIVE 锁会把**整库**
          的读和写全部挡住；WAL 允许"多读 + 单写"并行，是高并发下最关键的一项。
          WAL 是持久属性（写进库文件头），设一次即长期生效，此处仍每连接执行以便
          换库/新建库时自动带上。
        synchronous=NORMAL：commit 不再每次 fsync（原 FULL 每次都 fsync，是写入
          延迟的大头）。代价：**掉电/内核崩溃可能丢最后几秒已提交的事务**
          （WAL 模式下不会损坏数据库，只是丢尾部）。dev 可接受；若将来上 prod
          需重新评估，或届时直接切 postgres（DATABASE_URL 一换即可，模型零改动）。
        busy_timeout=30000：与 connect_args timeout 对齐，双保险。
        """
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    base_aspect: Mapped[str] = mapped_column(String(16), default="9:16")
    default_profile: Mapped[str | None] = mapped_column(String(64), nullable=True)
    schema_version: Mapped[str] = mapped_column(String(16), default="1.0.0")
    # 剧本文本（原始/优化后），MVP 直接挂在项目上
    raw_script: Mapped[str | None] = mapped_column(Text, nullable=True)
    optimized_script: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 分集（JSON: [{order,title,word_count}]）与生产模式（drama|narration）
    episodes: Mapped[str | None] = mapped_column(Text, nullable=True)
    production_mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 解说剧的解说音色（参考音频 URL）。整片共用一个声音，
    #: 所以挂在项目上而不是角色上——解说员不是剧中人物。
    #: TTS 克隆只取前 15s（RunningHub IndexTTS 工作流的 AudioCrop 写死）。
    narration_voice_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 全片**影调档案**（Look）JSON，见 `look_profile`。
    #: 决定色温/反差/饱和/黑位/颗粒/镜头质感这套"洗印厂配方"，
    #: 拼进所有资产图与首帧提示词——它是"不同图色调不统一"的主要修法。
    #: ⚠️ 它**不**决定日/夜明暗（那是各场景各镜头的光线情境），理由见 look_profile 模块头。
    look_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **画风预设** key（`style_preset.STYLES` 的键：urban/period/anime_3d/…）。
    #: 与 `production_mode` 是两件事：模式决定台词怎么配音，画风决定画面长什么样，
    #: 一个模式可对应多档画风（见 `style_preset.MODES`）。
    #:
    #: None = 老项目/没选 → `style_preset.resolve()` 给都市档 = 改动前行为。
    #: ⚠️ 这里**允许存尚未启用的档**（如古风）：那是用户的意图记录，
    #: 等它放开就自动生效；"现在实际用哪档"一律由 `resolve()` 决定，不看这一列的脸色。
    art_style: Mapped[str | None] = mapped_column(String(24), nullable=True)
    #: 建项目时刻（ISO8601 UTC，与 Job.created_at 同格式，可直接字典序比较）。
    #:
    #: 为什么必须显式存一列：`id` 是 `uuid.uuid4().hex[:12]`，**纯随机、不含时间**。
    #: 项目列表页曾按 id 倒序排并注释"id 是 hex 时间戳前缀，字典序即时序"——
    #: 那句话是错的，实际排出来是随机顺序，而用户完全看不出来（一屏项目名，
    #: 谁也不知道"最新的"应该是哪个）。要按时间排就必须有真正的时间。
    #:
    #: 老项目由 migrations 从 `MIN(jobs.created_at)` 回填；从没跑过任何任务的
    #: 空项目留 None（不编造时间），排序时统一沉底。
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    #: **回收站墓碑**：用户删除这个项目的时刻（ISO8601）。None = 在用。
    #:
    #: 与 `Asset.deleted_at` / `AssetStage.deleted_at` 同款做法，但理由更硬：
    #: 项目是所有数据的根，一次硬删要连带十来张表 + 磁盘文件，**没有任何撤销余地**。
    #: 所以删除做成两段——先打墓碑进回收站（数据与文件全留，可一键恢复），
    #: 用户在回收站里再确认一次才真正清盘（见 `project_purge.purge`）。
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Shot(Base):
    """镜头：拆解结果落库，切页/重启不丢。"""

    __tablename__ = "shots"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    order: Mapped[int] = mapped_column()
    script_ref: Mapped[str] = mapped_column(Text)
    link_to_prev: Mapped[str] = mapped_column(String(16), default="continuous")
    characters: Mapped[str] = mapped_column(Text, default="[]")  # JSON 数组文本
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    video_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # 当前采用版本的视频
    # ---- R0 状态机（契约 C1）----
    episode: Mapped[int] = mapped_column(default=1)  # 所属集
    status: Mapped[str] = mapped_column(String(16), default="pending")
    # pending | prompting | generating | review | adopted | failed
    #: 最近一次生成失败的原因（人读的摘要）+ 分类。
    #: 此前失败原因只存在 job 的 error JSON 里，镜头本身只有 status="failed"——
    #: 用户在镜头列表/时间轴上看到一个红角标，却完全不知道为什么失败，
    #: 更分不清"重试有用"（渠道故障）还是"重试必然再失败"（内容审核拒绝）。
    fail_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: moderation=内容审核拒绝 | channel=渠道/网络故障 | other
    fail_kind: Mapped[str | None] = mapped_column(String(16), nullable=True)
    profile_override: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON 局部覆盖
    is_special: Mapped[int] = mapped_column(default=0)
    adopted_version: Mapped[int | None] = mapped_column(nullable=True)
    gen_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)  # 拆解后预生成的提示词
    stale: Mapped[int] = mapped_column(default=0)  # 已过期，需重做；原因见 stale_reason
    #: 过期的**原因**，取值按"补救动作"命名：rebreak(需重拆本集) /
    #: reprompt(需按新拆解重出提示词) / regen(只需重出片)。NULL = 本列上线前的老数据，
    #: 一律按最保守的 rebreak 处理。语义与全部判定规则见 app/stale.py（单一真源）。
    stale_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_sec: Mapped[float | None] = mapped_column(nullable=True)  # AI 拆镜判定时长（可覆盖）
    # 时间轴归一（P0-3）：镜头轨是唯一真源，导出按 order 消费本表。
    disabled: Mapped[int] = mapped_column(default=0)  # 1=停用，保留镜头但不参与导出
    # 外部素材（片头/片尾/转场/实拍）作为 is_special=1 的镜头入轨，与 AI 镜头同轨同导出逻辑；
    # special_name 仅用于轨道/列表展示（AI 镜头展示 #order + script_ref）。
    special_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # P1-1 缩略图体系：轨道/列表只挂 <img thumb>，<video> 仅预览器用（837 镜同屏的性能前置）。
    # 值为当前采用版本的首帧图（/fw/media/generated/thumb_*.jpg），抽帧失败留 None，前端退回占位。
    thumb_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: ⛔ **已停用字段（2026-09-11）**，只存历史数据，不再写入、不再读取。
    #:
    #: 原用途是"尾帧接力"：本镜出片后抽最后一帧，给下一个
    #: `link_to_prev="continuous"` 的镜头当参考图之一。该设计经实测确认是**净负面**
    #: （挤掉一张定妆图、模型只当它风格参考、且必被 Seedance 人脸审核拦下），
    #: 完整证据与停用决策见 `docs/DECISION-2026-09-11-尾帧接力停用.md`。
    #:
    #: 保留列而不 DROP：存量 277 条指向 `generated/tail_*.jpg`，`media_refs` 仍按
    #: 引用列登记着它们，删列会让这些文件变成无主孤儿被清缓存悄悄删掉。
    #: **不要**基于这一列新建功能，也不要重新开启注入。
    tail_frame_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # P1-2 注入覆写（L3，PLAN §4.3）：人工在资产轨拖出来的增删，与 AI 判定（L1=characters）
    # 分离存储，可一键重置。JSON: {"add":[角色],"remove":[角色],"add_loc":[场景],"remove_loc":[场景]}；
    # None/空 = 完全跟随 L1。最终注入集合 = (characters ∪ add) − remove，见 effective_characters()。
    ref_overrides: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 3.9 在场推导（L1.5）：JSON 字符串数组。
    #:
    #: 同一场连续戏里，上一镜出现过、且此后没有任何离场描写的角色，视为**仍在场**。
    #: 存在的理由是实测的一类穿帮：验证片镜 1「林母压低身子凑近林语警告」，
    #: 镜 2-4 剧本里一个字的离场描写都没有，`characters` 却只剩陆沉与林语 ——
    #: 于是她的定妆图不注入、提示词不提她，画面里人就凭空没了。
    #:
    #: 与 `characters`（拆解真值 L1）分列存放：混进去用户就分不清哪些是 AI 拆的、
    #: 哪些是我们推的，也没法单独否决推导。人工 remove 仍然压得住它，
    #: 见 effective_characters()。
    present_characters: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 3.9 走位台账：本镜**结束时刻**各在场角色的位置状态（JSON 对象）
    #: `{"角色名": {"pos": "...", "posture": "...", "facing": "..."}}`。
    #:
    #: 下一个连续镜头把它当作"开场必须与之一致"的硬事实注入提示词。
    #: 这是"人物位置在相邻镜之间跳变"的正解 —— 位置必须是**可传递的显式状态**：
    #: 尾帧图只是众多参考图之一（权重被定妆图稀释），而 `_scene_run_ctx` 里
    #: 那句"座次延续上一镜结尾"没有任何事实支撑，优化器只能自己重新编一套走位。
    #: None = 没有台账（老数据 / 抽取失败），此时退回原来的通用约束，不阻断出片。
    blocking_out: Mapped[str | None] = mapped_column(Text, nullable=True)
    # P1-2：已出片镜头的注入集合被人工改动 → 置 1 提示「参考图已变，可重新生成」；
    # 重新生成成功后清 0。不自动重生成（避免烧钱）。
    refs_stale: Mapped[int] = mapped_column(default=0)
    # 首帧流水线（i2va）：本镜当前首帧图（/fw/media/generated/img_*.png）。
    # 视频由该帧生长而来；用户可先审首帧再出视频（首帧几毛/视频几块），
    # 也是排查场景偏移的抓手。None = 未走首帧路线或尚未生成。
    first_frame_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: gen_prompt 这一稿是怎么来的（镜头卡据此显示状态标识，避免用户误以为
    #: 卡片上那段文字就是最终下发稿）：
    #:   draft    拆解时预生成——那时资产还没生成，服装/人称都是凭剧本猜的
    #:   aligned  已按当前资产（参考图造型 + 人物档案）重新对齐过
    #:   sent     出片时实际下发给视频模型的最终稿（生成成功后写回）
    #:   manual   用户在高级设置里手填了 prompt，一切自动改写都让位于它
    #: None 视同 draft（老库历史数据）。
    prompt_state: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: TB-01 镜头分割：本行在 video_url 里的取片窗口（秒）。
    #: 分割不重新转码——那要几十秒到几分钟，塞进同步接口会把请求挂死。
    #: 前后两段共用同一个 video_url，各自记住自己的 [in, in+dur) 窗口，
    #: 导出（media.py 的 -ss/-t）与预览据此取片段。
    #: None = 整段使用（绝大多数镜头，未被分割过）。
    #:
    #: 3.1 起还有第二个来源：用户在时间轴上**拖左边缘修剪入点**。
    #: 于是窗口不再只由 split 产生，而是"这一镜要用素材的哪一段"的通用表达。
    #: ⚠️ 不变式 `duration_sec == clip_dur_sec`（窗口存在时）由三处共同维持：
    #: split_shot / unsplit_shot / patch_shot_timeline。破了它的后果是
    #: 「轨道上显示 2.4s、成片里却是 5s」——导出读窗口，布局读 duration_sec。
    #: ⚠️ 窗口是**绑在当前 video_url 上**的坐标；素材一换（重新生成 / 采纳其它
    #: 版本 / 手动出片）窗口就失去意义，必须清掉，见 reset_clip_window()。
    clip_in_sec: Mapped[float | None] = mapped_column(nullable=True)
    clip_dur_sec: Mapped[float | None] = mapped_column(nullable=True)
    #: TB-03 / TB-10 画面与音频调整（JSON，导出时翻译成 ffmpeg filter 链）：
    #:   {"scale":120,"rotate":0,"x":0,"y":0,"opacity":100,
    #:    "mirrorH":false,"mirrorV":false,
    #:    "speed":1.0,               # TB-10 变速（同时改视频 setpts 与音频 atempo）
    #:    "volume":100,"muted":false,"fadeIn":0,"fadeOut":0}
    #: None/缺键 = 该项不处理（绝大多数镜头不做调整，不该为此多跑一遍滤镜）。
    #: 存 JSON 而非拆十几个列：这些参数是整体套用的一组，拆列意味着加一个
    #: 属性就要迁移一次，而它们从来只被整体读写。
    transform_meta: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Render V2 多视频轨：0 = 主轨（默认，参与顺序时间累加）；
    #: 1+ = Overlay 叠加层，数字越大越靠上。叠加层不参与主轨时间累加，
    #: 位置由 overlay_start_sec 显式给出——否则"叠加"就变成"插队"了。
    track_index: Mapped[int] = mapped_column(default=0)
    #: 叠加层在成片时间轴上的起点（秒）。track_index=0 时忽略。
    overlay_start_sec: Mapped[float | None] = mapped_column(nullable=True)


def reset_clip_window(shot: "Shot") -> bool:
    """把镜头的取片窗口清回"整段使用"。**换素材时必须调用。**

    取片窗口 `[clip_in_sec, +clip_dur_sec)` 是**相对某一个具体 video_url 的
    时间坐标**。素材一换，这组坐标就指向了另一段内容：

        用户把一个 8s 镜头修剪成"第 2.4s 起的 3s"（in=2.4, dur=3），
        然后重新生成 → 新素材只有 2.6s → 导出时 `-ss 2.4 -t 3`
        取到的是一段空白/最后 0.2s。时间轴上却仍显示 3s。

    这是**静默损坏**：用户看不出哪里错了，直到成片里出现黑帧。
    所以宁可清掉（用户看得见"入点没了"、可以重新拖），也不留着错的。

    调用点（三处 video_url 的安装位置，缺一处就会漏）：
      · jobs.py            生成成功写回 video_url
      · routes_v2.py       adopt_shot_version（采纳历史版本）
      · routes_v2.py       dev 手动出片写回

    ⚠️ 只清窗口，**不动 duration_sec**：后端不知道新素材多长，
    duration_sec 至少还是用户期望的长度（也正是刚才下发的生成时长）。

    :returns: 是否真的清掉了东西（调用方据此决定要不要提示用户）
    """
    had = shot.clip_in_sec is not None or shot.clip_dur_sec is not None
    shot.clip_in_sec = None
    shot.clip_dur_sec = None
    return had


class ShotVersion(Base):
    """镜头版本历史：每次生成落一条，可回退/复现（seed 等参数在 meta）。"""

    __tablename__ = "shot_versions"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    shot_id: Mapped[str] = mapped_column(String(16), index=True)
    version_no: Mapped[int] = mapped_column()
    video_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    thumb_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # P1-1 该版本首帧图
    model_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)  # 优化后最终喂模型的稿
    meta: Mapped[str | None] = mapped_column(Text, nullable=True)    # JSON: seed/分辨率/帧数
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AssetStage(Base):
    """人物资产阶段（R1 资产时间轴用，R0 仅建表）：集×镜头双层轴。"""

    __tablename__ = "asset_stages"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    character_name: Mapped[str] = mapped_column(String(255))
    stage_name: Mapped[str] = mapped_column(String(255))
    ep_from: Mapped[int] = mapped_column()
    ep_to: Mapped[int] = mapped_column()
    shot_from: Mapped[int | None] = mapped_column(nullable=True)  # 可选集内精修
    shot_to: Mapped[int | None] = mapped_column(nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 该造型绑定的**归一场景名**（canonical，见 SceneAlias）。None = 不绑场景。
    #: 与 scene_bound 一起实现"剧本没写服装时，同一场景下同一人物服装相同"。
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    #: 1 = 场景决定型服装（睡衣@卧室 / 浴袍@浴室 / 泳装@泳池）：只要人物再次进入
    #:     这个归一场景、且剧本没另写衣着，就沿用本造型的**同一张图**，跨多少集都行。
    #: 0 = 事件型服装（婚纱@教堂 / 晚礼服@宴会厅）：只在自己的镜号区间内生效，
    #:     不因为"又到了这个场景"而重新穿上。
    #: 判定由 AI 给出，用户可在资产页改（改后 status 视为人工确认，不被重识别推翻）。
    scene_bound: Mapped[int] = mapped_column(default=0)
    #: 指针行：本阶段与 `source_stage_id` 指向的阶段是**同一件衣服**，共用它那张图。
    #:
    #: 为什么需要：同一件衣服可能在相隔很远的镜头段里各出现一次（婚纱在第 3 集
    #: 婚礼、第 9 集回忆），而 shot_from/shot_to 是**全局镜号**的单一闭区间，一行
    #: 表达不了两段。若各建一行各自出图，同一件婚纱就会长成两个样子——这正是要
    #: 消灭的不一致。所以后出现的那段建成指针行：不参与生图（readiness 会跳过），
    #: 注入时解析到源阶段的图。None = 本行自己就是源。
    source_stage_id: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | confirmed
    #: 火山私域虚拟人像库的资产 ID（入库后用 asset://<id> 引用，可绕过人脸审核）。
    #: 存在这里而不是单开一张表：当前只有定妆图需要入库，一对一映射最直接，
    #: 查询不用 join；将来若用户上传的参考图也要入库，再抽独立表不迟。
    volc_asset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: Active=可用 | Processing=还在异步处理（下次可继续轮询）| Failed=审核不过（别重试）
    volc_asset_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: 墓碑：用户删掉这个造型阶段的时刻（ISO8601）。None = 在用。
    #: 与 `Asset.deleted_at` 同款理由——真删没法撤销，而"服装识别"重跑时会按
    #: 剧本重新规划阶段，用户删掉的造型会以新行的形式回来。详见 `stage_gate.py`。
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Asset(Base):
    """资产：角色定妆/场景参考图。

    voice_url：角色参考音色（用户上传音频/视频）；TTS 旁白合成时作为
    该角色的音色候选（语音克隆参考，取前 15s 人声）。

    profile_json：角色**形象档案**（结构化五官/骨相/气质），仅 kind='character' 用。
    见 `character_profile`：它是"这个人长什么样"的唯一事实来源，全剧一份，
    与逐造型变化的 `AssetStage.description`（服装/发型）分工明确。
    """

    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # character | location | custom
    name: Mapped[str] = mapped_column(String(255))
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    profile_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 场景设定板（多视角/景别/材质/色彩拼版图）的 URL，仅 kind='location' 用。
    #: ⚠️ **只给人看，永不作为参考图注入镜头**——拼版图一进参考位，模型会把
    #: 格子线和中文标注一起抄进画面。注入用的是 `scene_views` 里的单幅图。
    board_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: **墓碑**：用户手动删除这条资产的时刻（ISO 字符串）。None = 正常在用。
    #:
    #: 为什么不真删行（用户 2026-09-09 需求 4「删掉的资产不该再在后面的生成过程中
    #: 可见、被调用」）：真删完全达不到这个效果——有**三处**会把它原地建回来，
    #: 每一处都不知道"用户是故意删的"：
    #:   ① `routes_v2` 拆解完成后的资产增量合并（剧本里还有这个角色 → 补一行）
    #:   ② `scenes.ensure_location_asset`（镜头还挂着这个场景名 → 补一行）
    #:   ③ 资产 upsert（任何写入路径按 name 找不到就新建）
    #: 还有第四处更隐蔽的坑：`readiness.locations_no_image` 是从 `Shot.location`
    #: 算的、**根本不看资产表**，所以真删之后依然报"缺图"，用户点一次"补齐"
    #: 就又花钱把它画回来了。
    #:
    #: 墓碑让这四处都能认出"这是用户删掉的"，从而跳过。
    #: 语义边界（用户决策「只断资产链，不动剧本」）：镜头里该角色/场景照旧存在、
    #: 已生成的图与磁盘文件全部保留、可随时恢复；断掉的只是"当资产用"这条链。
    deleted_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class SceneView(Base):
    """场景资产的一张**单视角参考图**（多视角 4 + 景别 4 = 8 行 / 场景）。

    为什么不复用 `AssetStage`：那张表的主键语义是"角色 × 造型 × 集/镜区间"
    （`character_name` / `ep_from` / `scene_bound` / `source_stage_id`），
    场景视图一个都用不上，塞进去等于让每一列都名不副实、且 readiness/注入
    那些按 `character_name` 过滤的查询会莫名把场景行捞进来。

    视图的**定义**（有哪 8 个、各自什么机位句）在 `scene_view.VIEWS`，
    本表只存"这个场景的这个视角，图在哪"。label/sort 是定义的冗余副本，
    每次 `ensure_views` 按代码回写——标签由代码定，不由老数据定。
    """

    __tablename__ = "scene_views"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: → `assets.id`（kind='location'）
    asset_id: Mapped[str] = mapped_column(String(16), index=True)
    #: `scene_view.VIEWS` 里的 key（angle_n / frame_wide / …）
    view_key: Mapped[str] = mapped_column(String(32))
    kind: Mapped[str] = mapped_column(String(16))     # angle | framing
    label: Mapped[str] = mapped_column(String(64))
    sort: Mapped[int] = mapped_column(default=0)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 生成这张图时实际下发的提示词（排查"为什么这张不对"的唯一依据）
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 视觉体检结论 JSON（见 asset_qc）：这张图里有没有人、有没有多余文字。
    qc_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class SceneAnchor(Base):
    """场景锚定图：首帧流水线的防偏移核心。

    每个**归一场景**（canonical）一张"场景基准帧"，由该场景首个镜头生成后落库；
    同场景后续镜头把它当作额外参考图去生成各自首帧，从而共享同一套陈设/光线/
    机位基调——这是"同场景多镜头各自生图会漂"的解法。

    ⚠️ 曾按 (project_id, episode, location) 建键，于是同一个房间在第 1 集和第 10 集
    各有一张互不相干的基准帧，跨集必漂（拆解出的 location 每集写法还不一样，
    见 SceneAlias 的注释）。现在按 canonical 共享，episode/location 只留作
    首次建立锚点时的来源记录与旧库兼容。

    唯一性由 migrations._INDEXES 的唯一索引 + jobs 层每场景锁双重保证。
    """

    __tablename__ = "scene_anchors"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    episode: Mapped[int] = mapped_column(default=1)
    location: Mapped[str] = mapped_column(String(255))
    #: 归一场景名。旧库遗留行为 None，此时退回 (episode, location) 精确匹配。
    canonical: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    prompt: Mapped[str | None] = mapped_column(Text, nullable=True)


class SceneAlias(Base):
    """场景归一字典：Shot.location 原值 → 归一场景名。

    ## 为什么必须有这张表

    拆解落库的 `Shot.location` 是**每集各写一遍**的自由文本。实测项目
    36c691b20387（测试813）的 22 个场景名**跨集复用率为 0**：

        「金诚律所 密室会客室」ep2   ←→  「夜 内 沈修杰律所办公室」ep5
        「顾氏集团 总裁办走廊」ep3   ←→  「日 内 鼎盛集团 总裁办走廊」ep4
        「高端酒店大堂/电梯间」ep1  ←→  「酒店走廊/电梯间」ep1

    很多名字还把 slug 行里的「日 内」「夜 内」原样带了进来。所以：

    - "同一场景下同一人物服装相同"用字符串相等**根本判不出来**；
    - 场景锚定图会让同一个房间在每一集长成不同样子。

    归一分两步：`scenes.normalize_location` 先做确定性清洗（剥时间/内外前缀、
    统一分隔符），再由一次 LLM 合并把剩下的别名归组。归组保守是安全的
    ——少归一只是少一次继承，绝不会产出错误画面；错归一才会让人穿错衣服。

    source='manual'：用户在资产页手动改过的映射，AI 重跑归一时**不覆盖**。
    """

    __tablename__ = "scene_aliases"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    raw_name: Mapped[str] = mapped_column(String(255))
    canonical: Mapped[str] = mapped_column(String(255))
    time_of_day: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 日|夜|晨|黄昏
    int_ext: Mapped[str | None] = mapped_column(String(8), nullable=True)       # 内|外
    source: Mapped[str] = mapped_column(String(16), default="ai")               # ai | manual


class CharacterAlias(Base):
    """角色归一字典：Shot.characters 里的原始写法 → 归一角色名（N2）。

    ## 为什么必须有这张表

    场景侧有 `SceneAlias`，角色侧此前**没有对应机制**——结构性不对称。
    而剧本本身就会给同一个人多种写法，拆解如实记录（这是对的），于是：

        '陆明' 208 镜  ←→  '少年陆明' 3 镜      （同一人的少年时期）
        '江卫东的秘书' 1 镜 ←→ '江卫东秘书' 1 镜  （同一人的两种写法）

    不归一的后果：`AssetStage` 里「陆明」43 个阶段 + 「少年陆明」3 个阶段，
    被当成两个人各画各的定妆图，同一个角色在少年戏与成年戏里长得毫不相干。

    ## ⚠️ 为什么不能用字面子串判断

    实测这些名字对**字面高度相似但绝非同一人**：

        '陆明父亲'   ⊃ '陆明'     ← 父子是两个人！
        '江卫东的秘书' ⊃ '江卫东'   ← 秘书是另一个角色！
        '审查组长'   ⊃ '审查组'    ← 组长是人，审查组是机构

    按子串合并会把父子、上下级合并成一个人，属**数据损坏**。所以判定必须走
    LLM 语义（同 `canonicalize_scenes` 的做法），且归组要保守：
    少归一只是少合并一次，错归一会让两个角色共用一张脸。

    `age_stage`：该写法对应的人生阶段（少年/青年/中年/老年）。归一到同一
    `canonical` 后，不同 `age_stage` 仍各自出图——「少年陆明」与「陆明」是同一人
    但长相不同，这正是 Q1 人物档案里年龄段的用武之地。

    source='manual'：用户手动改过的映射，AI 重跑归一时**不覆盖**。
    """

    __tablename__ = "character_aliases"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    raw_name: Mapped[str] = mapped_column(String(255))
    canonical: Mapped[str] = mapped_column(String(255))
    #: 少年 | 青年 | 中年 | 老年 | None（未区分）
    age_stage: Mapped[str | None] = mapped_column(String(16), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="ai")               # ai | manual


class Job(Base):
    """异步任务：批量生图/视频生成等长任务。桌面端提交后轮询状态。"""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))  # asset_batch | shot_video | ...
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|running|done|failed
    # 输入/输出/错误均存 JSON 文本，避免每种任务各建表；MVP 够用
    payload: Mapped[str] = mapped_column(Text, default="{}")
    result: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    progress: Mapped[int] = mapped_column(default=0)  # 0-100
    # 任务面板要按时间倒序列历史任务，没有时间戳就只能按 id 排——
    # id 是随机 hex，排出来的顺序毫无意义
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    updated_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 归属项目：从 payload["project_id"] 冗余出来的**索引列**（B30）。
    # payload 是 JSON 文本，按项目筛 job 原先只能全表载入 + 逐行 json.loads，
    # 而 jobs 表只增不删（实测 173 行已含 547 KiB 的 payload/result，
    # 其中 result 这个接口根本用不到，最大单条 34 KiB）。
    # 冗余一列 + 索引后，查询在 DB 层就收敛到本项目的几十行。
    # 仍以 payload 为准（写入时由 create_job 同步），本列纯为查询加速。
    project_id: Mapped[str | None] = mapped_column(String(16), nullable=True,
                                                   index=True)


class MediaClip(Base):
    """P1-3 素材池落库（修 E4）：上传素材原先只存前端内存，刷新/换设备即丢。

    文件本体仍在 /root/filmweaver-data/uploads（上传走 /v2/media/upload），
    本表只登记项目维度的元数据；插入镜头轨仍走 is_special 特殊镜头（P0-3 归一）。
    """

    __tablename__ = "media_clips"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(255))
    url: Mapped[str] = mapped_column(Text)          # /fw/media/uploads/xxx
    size: Mapped[int] = mapped_column(default=0)
    kind: Mapped[str] = mapped_column(String(16))   # video | audio | image | other
    duration: Mapped[float] = mapped_column(default=0.0)  # 秒；图片/未知为 0
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AudioClip(Base):
    """P2-4 音频轨（修 D5）：TTS 旁白 / 配乐段落，落库供时间轴渲染与导出混音。

    时间定位锚定镜头：start_shot_order + start_offset_sec（镜头内偏移），
    镜头增删/改序时音频跟随所锚镜头移动，比存绝对秒稳健（时长常变）。
    """

    __tablename__ = "audio_clips"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(16), default="tts")  # tts | music | shot | narration
    text: Mapped[str | None] = mapped_column(Text, nullable=True)  # TTS 旁白文本
    url: Mapped[str | None] = mapped_column(Text, nullable=True)   # 合成产物；None=生成中/失败
    #: 音源文件的**实测总长**（ffprobe），不是它在时间轴上占多久。
    #:
    #: ⚠️ 6.9 起这两件事分开了，**修剪绝不能改这一列**：它是"这个文件到底有多长"
    #: 的唯一记录，被改掉之后用户就只能越剪越短、再也拉不回来（把 3 分钟 BGM
    #: 剪到 10 秒之后，那 3 分钟从此在库里不存在）。
    #: 修剪写的是下面的 clip_in_sec / clip_dur_sec。
    duration: Mapped[float] = mapped_column(default=0.0)           # 秒（ffprobe 实测）
    start_shot_order: Mapped[int] = mapped_column(default=1)       # 锚定镜头 order
    start_offset_sec: Mapped[float] = mapped_column(default=0.0)   # 镜头内偏移
    #: 6.9 修剪窗口：在 url 这个音源里取 [clip_in_sec, +clip_dur_sec)。
    #: NULL = 整段使用（从没被修剪过），**播放时长 = clip_dur_sec ?? duration**。
    #:
    #: 与 Shot 的同名两列同构，但**没有** Shot 那条 `duration_sec == clip_dur_sec`
    #: 不变式要维持 —— 因为音频只有一个时长列可写。Shot 之所以要维持，是它同时
    #: 存着"排版用的时长"和"取片用的窗口"两份；音频这边"排版用的时长"是**算出来的**
    #: （`clip_dur_sec ?? duration`），算出来的东西不会和自己不同步。
    clip_in_sec: Mapped[float | None] = mapped_column(nullable=True)
    clip_dur_sec: Mapped[float | None] = mapped_column(nullable=True)
    voice_ref_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # 参考音色素材
    #: kind="shot" 专用：这条音频是从哪个镜头的视频里剥出来的。
    #:
    #: 它同时是**导出时静音源视频的唯一依据** —— 只要某镜头存在
    #: source_shot_id 指向它的音频段，渲染计划就把该镜头视频的音轨静音，
    #: 否则同一段声音会响两遍（视频自带一遍 + 音频轨一遍）。
    #: 反过来，删掉这条音频段，静音随之解除，声音自动回到视频上。
    #: 用"存在性"驱动而不是给 Shot 加 muted 标记，是为了不出现
    #: "音频段删了但视频还是哑的"这种两处状态不同步的坑。
    source_shot_id: Mapped[str | None] = mapped_column(String(16), nullable=True,
                                                       index=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    # pending | generating | done | failed
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class SubtitleClip(Base):
    """TB-02 字幕轨：文本 / 字幕段落，落库供时间轴渲染与导出烧录。

    时间定位与 AudioClip 同构（锚定镜头 order + 镜内偏移），理由也一样：
    镜头增删/改序时字幕跟着所锚镜头走，比存绝对秒稳健——镜头时长天天在变，
    存绝对秒的话改一个镜头时长，后面所有字幕全部错位。

    style 存 JSON（字号/颜色/描边/底框/位置/加粗），与前端 SubtitleStyle 同构。
    不拆成十几个列：字幕样式是整体套用的预设，拆列只会让加一个属性就要迁移一次。
    """

    __tablename__ = "subtitle_clips"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    text: Mapped[str] = mapped_column(Text, default="")
    #: normal(普通文本) | subtitle(剧情字幕) | title(标题)
    kind: Mapped[str] = mapped_column(String(16), default="subtitle")
    start_shot_order: Mapped[int] = mapped_column(default=1)
    start_offset_sec: Mapped[float] = mapped_column(default=0.0)
    duration: Mapped[float] = mapped_column(default=3.0)
    #: 样式 JSON；None = 用项目默认预设
    style: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


class Transition(Base):
    """转场：两个相邻镜头接缝处的过渡效果（Render V2）。

    ## 为什么锚在「接缝」而不是「时间点」

    转场是**两个 clip 之间**的关系，不是时间轴上的一个独立对象。存
    from_shot_id/to_shot_id 而非绝对秒：镜头改时长、换顺序时，转场自动跟着
    那条接缝走；存绝对秒的话，改一个镜头时长就要重算后面所有转场位置。

    ## duration 的约束

    转场会"吃掉"两侧各半个时长（xfade 的重叠区），所以它不能超过任一侧镜头
    时长的一半——否则会把整个镜头吃没。落库时钳制，前端也做同样校验。

    ## renderable

    UI 里有 15 种转场，但 Render V2.1 只真正实现了 fade/fadeblack/fadewhite。
    其余落库时照存（用户的编排不该因为引擎没跟上就丢失），由编译器按
    capabilities 决定能否渲染，不能渲染的降级为硬切并在导出前提示。
    """

    __tablename__ = "transitions"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(16), index=True)
    #: ffmpeg xfade 的 transition 名（fade / fadeblack / wipeleft / ...）
    type: Mapped[str] = mapped_column(String(32), default="fade")
    duration: Mapped[float] = mapped_column(default=0.5)
    #: 接缝两端的镜头
    from_shot_id: Mapped[str] = mapped_column(String(16), index=True)
    to_shot_id: Mapped[str] = mapped_column(String(16), index=True)
    #: 额外参数 JSON（方向/缓动等，按转场类型不同）
    params: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[str | None] = mapped_column(String(32), nullable=True)


def effective_characters(shot: "Shot") -> list[str]:
    """镜头最终注入的角色集合：((L1 拆解真值 ∪ L1.5 在场推导) ∪ 人工 add) − 人工 remove。

    放在数据层：jobs._auto_inject_refs（生成时注入）与 routes_v2.list_stages（轨道渲染）
    必须走同一函数，保证「轨道显示的覆盖 = 实际注入行为」，不再各算各的。
    顺序稳定：先 L1 出场顺序，再 L1.5 推导补的，人工补充的追加在最后
    （注入截断时优先保 AI 判定，其次保推导，最后才是人工加的）。

    ## L1.5 是 3.9 加的，为什么要有它

    拆解提示词只让 LLM 列"本镜有戏份的角色"，于是坐在桌边不说话的人不会进
    `characters`。实测「真人剧-验证片」镜 1 有林母，镜 2-4 没有（剧本里毫无
    离场描写），镜 5 又有 —— 她的定妆图因此时有时无，画面上人就一会儿在
    一会儿不在。`present_characters` 就是把"她没走，还在那儿"这件事补回来。

    ⚠️ 人工 remove **压得住** L1.5：推导错了（比如剧本用了我们没识别的离场写法）
    用户在资产轨上把人拿掉，就必须真的拿掉。所以 remove 在最外层生效。
    """
    try:
        chars = [c for c in json.loads(shot.characters or "[]")
                 if isinstance(c, str) and c]
    except (ValueError, TypeError):
        chars = []
    try:
        present = [c for c in json.loads(getattr(shot, "present_characters", None) or "[]")
                   if isinstance(c, str) and c]
    except (ValueError, TypeError):
        present = []
    try:
        ov = json.loads(shot.ref_overrides) if shot.ref_overrides else {}
    except (ValueError, TypeError):
        ov = {}
    add = [c for c in ov.get("add", []) if isinstance(c, str) and c]
    remove = {c for c in ov.get("remove", []) if isinstance(c, str) and c}
    out = [c for c in chars if c not in remove]
    for c in present:
        if c not in out and c not in remove:
            out.append(c)
    for c in add:
        if c not in out and c not in remove:
            out.append(c)
    return out


def effective_locations(shot: "Shot") -> list[str]:
    """镜头最终注入的场景集合（P1-3，与 effective_characters 同契约）：
    (L1 拆解真值 Shot.location ∪ 人工 add_loc) − 人工 remove_loc。
    L1 是单值（每镜一个所属场景），人工可加多个（如同框双景参考）。
    """
    l1 = [shot.location] if shot.location else []
    try:
        ov = json.loads(shot.ref_overrides) if shot.ref_overrides else {}
    except (ValueError, TypeError):
        ov = {}
    add = [c for c in ov.get("add_loc", []) if isinstance(c, str) and c]
    remove = {c for c in ov.get("remove_loc", []) if isinstance(c, str) and c}
    out = [c for c in l1 if c not in remove]
    for c in add:
        if c not in out and c not in remove:
            out.append(c)
    return out


def init_db() -> None:
    Base.metadata.create_all(engine)


def get_session() -> Session:
    return Session(engine)