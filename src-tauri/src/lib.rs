#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DroppedFiles::default())
        .invoke_handler(tauri::generate_handler![
            export_copy_file,
            export_paths_exist,
            read_dropped_file
        ])
        // 系统文件拖入的**接收方**（3.11 P0-a）。
        //
        // Tauri v2 的 `dragDropEnabled` 默认为 true，会在 WebView2 上挂一个
        // 系统级 IDropTarget：从资源管理器拖文件进来时，指针由那个宿主接管，
        // 页面**永远收不到** dragstart/dragover/drop。这正是"资产拖不到轨道上"
        // 的根因——页内自拖也被同一只手截走了（光标始终是禁止样式就是证据：
        // 那个光标来自宿主，不是页面给的 dropEffect）。
        //
        // 用户点名"从资源管理器拖入文件是必要的，不能舍弃"，所以**不能**
        // 关掉 dragDropEnabled 来给页内 HTML5 DnD 让路。正确做法是：
        //   · 宿主继续开着，我们在这里把它的 drop 接住（本函数）
        //   · 页内拖拽改走 Pointer Events（那条通道宿主不碰，见 pointerDrag.ts）
        // 在此之前，这个默认开启的能力**一个字节都没被用过**——宿主开着、
        // 两侧零接收方，纯属白担副作用。现在补上接收方。
        //
        // 注意 `DragDropEvent::Drop` 的 paths 是 `PathBuf`，不能直接 `to_string_lossy`
        // 给 JS：Windows 下那是 `\\?\C:\...` 的 verbatim 路径，直接用会导致
        // 后端 `open()`/`Path::new()` 判断异常。统一走 `normalize_path` 剥前缀。
        .on_window_event(|window, event| {
            use tauri::Emitter;
            if let tauri::WindowEvent::DragDrop(drag) = event {
                // `Over` / `Leave` 没有路径 —— 前端只拿它们驱动落点提示的开合，
                // 真正要用的路径在 `Enter` / `Drop` 里。
                let (kind, paths): (&str, &[std::path::PathBuf]) = match drag {
                    tauri::DragDropEvent::Enter { paths, .. } => ("enter", paths),
                    tauri::DragDropEvent::Over { .. } => ("over", &[]),
                    tauri::DragDropEvent::Drop { paths, .. } => ("drop", paths),
                    tauri::DragDropEvent::Leave => ("leave", &[]),
                    // `#[non_exhaustive]`：上游将来可能加变体（比如 2.x 补的
                    // 触摸拖放），加了我们不该 panic，忽略即可。
                    _ => return,
                };
                let payload = DragPayload {
                    kind: kind.to_string(),
                    paths: paths.iter().map(|p| normalize_path(p)).collect(),
                };
                // `enter` 时就把路径记进白名单：用户在拖入的**过程中**松手前，
                // 前端可能已经开始预读缩略图了。只记 `drop` 的话，预读会被拒。
                if !payload.paths.is_empty() {
                    window.state::<DroppedFiles>().allow(&payload.paths);
                }
                // emit 失败只可能是窗口已销毁，此时也没人需要这个事件了
                let _ = window.emit("fw://os-drop", payload);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(Clone, serde::Serialize)]
struct DragPayload {
    /// `enter` / `over` / `drop` / `leave` —— 前端据此决定是否显示落点提示
    kind: String,
    paths: Vec<String>,
}

/// 把 `PathBuf` 还原成前端与后端都能直接用的普通路径字符串。
///
/// Windows 上从系统拖放拿到的路径是 **verbatim** 形式（`\\?\C:\a\b.png`）。
/// 这个前缀存在的意义是让 Win32 跳过路径规范化（从而支持超长路径与保留名），
/// 但代价是：一旦带着它回到普通文件 API，`..` / `.` / 正斜杠不再被解释，
/// 后端 `Path::new` 拼出来的路径会与它自己的路径比对失败（"文件明明在却说不存在"）。
/// 所以剥掉是**必需**的，不是美化。
///
/// 两种形态：
/// - `\\?\C:\...`  → 剥成 `C:\...`
/// - `\\?\UNC\server\share\...` → 剥成 `\\server\share\...`（UNC 必须还回双反斜杠，
///   否则网络路径直接失效）
///
/// 非 Windows 平台与本来就没有前缀的路径原样返回。
fn normalize_path(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    strip_verbatim(&s)
}

fn strip_verbatim(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.to_string()
}

#[cfg(test)]
mod tests {
    use super::strip_verbatim;
    #[test]
    fn strips_drive_verbatim_prefix() {
        assert_eq!(strip_verbatim(r"\\?\C:\a\b.png"), r"C:\a\b.png");
    }

    #[test]
    fn restores_unc_double_backslash() {
        // UNC 剥完必须还回 `\\`，否则 `\\server\share` 变成 `server\share`，
        // 后端会把它当成当前盘符下的相对路径 —— 静默指错文件。
        assert_eq!(
            strip_verbatim(r"\\?\UNC\server\share\a.png"),
            r"\\server\share\a.png"
        );
    }

    #[test]
    fn leaves_plain_paths_alone() {
        assert_eq!(strip_verbatim(r"C:\a\b.png"), r"C:\a\b.png");
        assert_eq!(strip_verbatim("/home/u/a.png"), "/home/u/a.png");
        // 已是普通 UNC：原样保留
        assert_eq!(strip_verbatim(r"\\server\share\a.png"), r"\\server\share\a.png");
    }

    #[test]
    fn does_not_mangle_paths_that_merely_contain_question_marks() {
        // 只在**开头**剥；文件名里出现 `?` 是合法的（Windows 下不合法，Linux 下合法）
        assert_eq!(strip_verbatim("/tmp/a?b.png"), "/tmp/a?b.png");
    }
}

/// 读一个**刚从系统拖进来**的文件的字节（3.11 P0-b）。
///
/// ## 为什么需要它（而不是用 fs 插件的 readFile）
///
/// 与 `export_copy_file` 同一个理由：fs 插件受 capabilities 的 scope 约束，
/// 而用户拖进来的文件在任意盘符/网络路径上，事先无法枚举。加一条
/// `fs:allow-read-recursive` on `**` 等于把这个应用变成任意文件读取器 —— 不可接受。
///
/// ## 安全边界：只读「真的被拖进来过」的路径
///
/// 这个 command 不接受任意路径：它先查 `DroppedFiles` 白名单。白名单**只在
/// 收到系统 drop 事件时写入**（`on_window_event` 里，由操作系统给的路径填充），
/// 前端无法凭空往里塞。也就是说，能读的范围 == 用户亲手拖进来的那几个文件，
/// 这正好是用户本来的意图（"把这张图给织影"）。
///
/// 顺带挡住两个常见的翻车点：
/// - **目录**：拖一个文件夹进来会展开成它的路径，read 会失败并报"是目录"。
///   前端按扩展名分流，非媒体扩展名根本不会走到这里。
/// - **超大文件**：拖一部 4GB 的电影进来，一次性读进内存会 OOM。
///   超过 `MAX_READ_BYTES` 直接拒绝，报清楚原因。
///
/// 返回 base64：Tauri 的 IPC 走 JSON，`Vec<u8>` 会被序列化成数字数组
/// （4 字节的图变成 4 个 JSON 数字，体积翻十几倍）。base64 是标准做法，
/// 前端 `atob` 解回 `Uint8Array` 即可。
#[tauri::command]
fn read_dropped_file(
    state: tauri::State<'_, DroppedFiles>,
    path: String,
) -> Result<String, String> {
    use base64::Engine as _;
    const MAX_READ_BYTES: u64 = 512 * 1024 * 1024;

    if !state.is_allowed(&path) {
        return Err(format!("拒绝读取未经拖放授权的路径：{path}"));
    }
    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("读取文件信息失败 {path}：{e}"))?;
    if meta.is_dir() {
        return Err(format!("{path} 是文件夹 —— 请拖入文件"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "文件太大（{:.1} GB）—— 请拖入 512MB 以内的文件",
            meta.len() as f64 / 1024.0 / 1024.0 / 1024.0
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败 {path}：{e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 本次会话里「被系统拖放过」的路径集合。
///
/// 存在的唯一目的是给 `read_dropped_file` 划边界：没有它，那个 command 就是
/// 一个可以读任意文件的接口。集合只在 `on_window_event` 收到 `Drop` 时增长，
/// 且只增不减（拖过的文件在本进程生命周期内保持可读 —— 否则用户拖完再点一次
/// "上传"就会莫名被拒）。
#[derive(Default)]
struct DroppedFiles(std::sync::Mutex<std::collections::HashSet<String>>);

impl DroppedFiles {
    fn allow(&self, paths: &[String]) {
        // 锁中毒（另一个线程 panic）时不该把拖放整个废掉：那份集合只是白名单，
        // 重建一份空的顶多是这一次拖放要重拖，比 panic 好得多。
        let mut set = match self.0.lock() {
            Ok(s) => s,
            Err(poisoned) => poisoned.into_inner(),
        };
        for p in paths { set.insert(p.clone()); }
    }

    fn is_allowed(&self, path: &str) -> bool {
        match self.0.lock() {
            Ok(s) => s.contains(path),
            Err(poisoned) => poisoned.into_inner().contains(path),
        }
    }
}

/// 把渲染好的成片从工作目录拷到用户选定的位置。
///
/// 为什么不用 fs 插件的 copyFile：fs 插件受 capabilities 里的 scope 限制，
/// 只能读写预先声明的目录（$APPDATA 等）。而导出的目标路径来自系统保存对话框，
/// 用户可能选任意盘符（D 盘的视频目录、U 盘……），无法事先枚举。
/// 之前导出"闪一下就没反应"正是这个原因：保存框弹得出来（dialog 有权限），
/// 选完路径后 copyFile 被 scope 拦下。
///
/// 这里在 Rust 侧直接做文件拷贝，不经过 fs scope。安全性由来源约束保证：
/// `src` 是本应用自己产出的临时文件，`dst` 是用户在系统对话框里亲自选的。
///
/// 用同步实现（不引 tokio）：Tauri 会把同步 command 放到线程池执行，
/// 不会阻塞主线程；为一次文件拷贝新增一个异步运行时依赖不划算。
#[tauri::command]
fn export_copy_file(src: String, dst: String) -> Result<u64, String> {
    // 目标目录可能不存在（用户在对话框里新建了路径），先补齐
    if let Some(parent) = std::path::Path::new(&dst).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("拷贝失败 {src} → {dst}: {e}"))
}

/// 哪些目标路径已存在（批量）。
///
/// 为什么需要它：导出位置改到对话框里当场选之后，「开始导出」不再弹系统
/// 保存框，也就丢掉了保存框自带的「同名文件已存在，是否替换」确认。
/// 而按集导出一次产出几十个文件，逐个弹保存框更不现实。
/// 于是在**开跑之前**一次性把要写的路径问一遍，有冲突再让用户确认。
///
/// 同样绕开 fs 插件：目标路径来自用户在系统对话框里选的任意目录，
/// capabilities 的 scope 事先枚举不了（理由与 export_copy_file 相同）。
/// 只读元数据、不读内容，返回的也只是调用方自己传进来的那批路径。
#[tauri::command]
fn export_paths_exist(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists())
        .collect()
}
