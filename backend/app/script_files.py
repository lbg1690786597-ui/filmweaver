"""剧本文件解析（多格式支持，移植主平台 stages/file_upload.py 的容错策略）。

支持 .txt/.md（编码探测）/ .docx（段落+表格，跳过图片等非文本）/ .pdf（逐页容错）。
.doc 老格式无纯 Python 可靠解析，提示用户先转 .docx（与主平台口径一致）。
"""
from __future__ import annotations

import io


def _decode_text(content: bytes) -> str:
    """文本解码：BOM/UTF-8 优先，其余交给 charset_normalizer 按可能性打分。

    ⚠️ 不能用"按固定顺序逐个 try decode、谁先不报错就用谁"的写法。
    gb18030 是**超集**，几乎任何字节序列都能解码成功而不抛异常 ——
    Big5（繁体，港台剧本常见）的字节喂给它照样"成功"，
    产出的是一堆乱码，而 big5 那一档永远轮不到。

    实测：'台北市長 選舉結果 已經公布'.encode('big5') 用 gb18030 解码
    不报错，得到 '\\ue67e\\ue665カ\\ue057 匡羭挡狦 \\ue61d竒そガ'。
    用户看到的是乱码剧本，却没有任何报错提示。

    所以：
      · UTF-8 系（含 BOM）先试 —— 它是自校验的，非 UTF-8 数据几乎必然报错，
        不存在"误判成功"的问题，且现实中占绝大多数。
      · 其余中文编码交给 charset_normalizer 按语言模型打分选最像的那个，
        而不是靠声明顺序。
    """
    # UTF-8 自校验，误判概率极低，优先且可信
    for enc in ("utf-8-sig", "utf-8"):
        try:
            return content.decode(enc)
        except (UnicodeDecodeError, LookupError):
            pass

    # gb18030 与 big5 各解一遍，按"中日韩汉字占比"择优。
    #
    # 不用 charset_normalizer 的跨语种打分：把 shift_jis/euc_kr 一起放进候选时，
    # 它会把 GB18030 的简体中文判成 euc_kr（实测输出整段韩文谚文）。
    # 本项目的现实候选就是简繁两种，用确定性的字形占比判别更稳，
    # 也不依赖第三方库是否装上。
    best_text, best_score = None, -1.0
    for enc in ("gb18030", "big5"):
        try:
            cand = content.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        score = _cjk_ratio(cand)
        if score > best_score:
            best_text, best_score = cand, score
    if best_text is not None:
        return best_text

    return content.decode("utf-8", errors="ignore")


def _cjk_ratio(s: str) -> float:
    """常用汉字占比（0..1）。解码错误的结果会大量落在非汉字区。

    只统计 CJK 基本区 U+4E00..U+9FFF 与常用中文标点；
    谚文/假名/私用区（乱码的典型落点）都不计分。
    """
    if not s:
        return 0.0
    sample = s[:4000]          # 长文本取前段够用，避免整本书扫一遍
    good = sum(1 for ch in sample
               if "一" <= ch <= "鿿"
               or ch in "，。！？：；、「」『』（）《》—…·\n\r\t "
               or ch.isascii())
    return good / len(sample)


def _parse_docx(content: bytes) -> str:
    """docx：段落+表格文字，跳过图片/形状/嵌入对象，异常元素容错。"""
    from docx import Document
    doc = Document(io.BytesIO(content))
    texts: list[str] = []
    for p in doc.paragraphs:
        try:
            if p.text and p.text.strip():
                texts.append(p.text)
        except Exception:  # noqa: BLE001
            continue
    for table in doc.tables:
        try:
            for row in table.rows:
                for cell in row.cells:
                    try:
                        t = cell.text.strip()
                        if t:
                            texts.append(t)
                    except Exception:  # noqa: BLE001
                        continue
        except Exception:  # noqa: BLE001
            continue
    return "\n".join(texts)


def _parse_pdf(content: bytes) -> str:
    """pdf：逐页提取文字，单页失败跳过。"""
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(content))
    texts: list[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
            if t.strip():
                texts.append(t)
        except Exception:  # noqa: BLE001
            continue
    return "\n".join(texts)


def parse_script_file(filename: str, content: bytes) -> str:
    """按扩展名解析剧本文件为纯文本。不支持/解析失败抛 ValueError（含用户可读提示）。"""
    ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    if ext in ("txt", "md"):
        return _decode_text(content)
    if ext == "docx":
        try:
            return _parse_docx(content)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"docx 解析失败（文件可能损坏）: {e!r}")
    if ext == "pdf":
        try:
            text = _parse_pdf(content)
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"pdf 解析失败: {e!r}")
        if not text.strip():
            raise ValueError("该 PDF 未提取到文字（可能是扫描图片版），请转为文字版或 docx")
        return text
    if ext == "doc":
        raise ValueError("暂不支持 .doc 老格式，请用 Word 另存为 .docx 后重新上传")
    raise ValueError(f"不支持的剧本格式 .{ext}（支持 txt/md/docx/pdf）")
