#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![export_copy_file, export_paths_exist])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
