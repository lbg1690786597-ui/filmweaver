/**
 * lib/prefs.ts — 前端偏好读写
 *
 * 统一 key 前缀，便于「重置界面偏好」一次清空。
 * 原本这两个函数是 SettingsDialog 内的局部实现，timelineStore 也要用
 * （工具模式/吸附开关要持久化），所以提到这里共用——两份实现迟早会漂。
 */

const PREF = "fw_pref_";

export function readPref<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(PREF + key);
    return v == null ? def : (JSON.parse(v) as T);
  } catch {
    // 存的值被手改坏 / JSON 非法：退回默认而不是抛错，
    // 不能让一个坏掉的偏好把整个编辑器打不开
    return def;
  }
}

export function writePref(key: string, v: unknown): void {
  try {
    localStorage.setItem(PREF + key, JSON.stringify(v));
  } catch {
    // 隐私模式 / 配额满：偏好存不下不是致命错误，静默降级为「本次会话有效」
  }
}

/** 清空全部界面偏好（设置页「重置界面偏好」用） */
export function clearPrefs(): void {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(PREF)) localStorage.removeItem(k);
  }
}
