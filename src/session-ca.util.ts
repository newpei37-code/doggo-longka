import * as fs from 'fs';
import { telegramConfig, configPath } from '../config/telegram.config';

const CONFIG_JSON = configPath;

const FIRST_RUN_MINUTE_VN = 11 * 60 + 58;
const CA_INTERVAL_MINUTES = 30;

/**
 * Ca theo giờ VN (UTC+7, không DST): lần chạy 11:58 → ca 1 (12h00), 12:28 → ca 2 (12h30), …
 */
export function getSessionCa(soCa: number, now: Date = new Date()): number {
  const vn = new Date(now.getTime() + 7 * 3600 * 1000);
  const minuteOfDay = vn.getUTCHours() * 60 + vn.getUTCMinutes();
  const ca =
    Math.floor((minuteOfDay - FIRST_RUN_MINUTE_VN) / CA_INTERVAL_MINUTES) + 1;
  return Math.min(Math.max(1, ca), Math.max(1, Math.floor(soCa)));
}

/**
 * Ghi `session_ca_override: 0` vào config.json và object đang chạy (sau khi chạy thủ công đúng ca).
 */
export function resetSessionCaOverrideInConfig(): void {
  try {
    (telegramConfig as Record<string, unknown>).session_ca_override = 0;
    const raw = fs.readFileSync(CONFIG_JSON, 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    j.session_ca_override = 0;
    fs.writeFileSync(CONFIG_JSON, JSON.stringify(j, null, 2), 'utf8');
  } catch (e) {
    console.warn(
      '[session-ca] Không thể đặt session_ca_override về 0 trong config.json:',
      e,
    );
  }
}

/**
 * Đọc session_ca_override trực tiếp từ config.json mỗi lần gọi — process chạy lâu (cron)
 * vẫn thấy giá trị mới sau khi bạn sửa tay; không dùng telegramConfig cache lúc import.
 */
export function readSessionCaOverrideFromConfigFile(): number {
  try {
    const raw = fs.readFileSync(CONFIG_JSON, 'utf8');
    const j = JSON.parse(raw) as Record<string, unknown>;
    const v = j.session_ca_override;
    const n = typeof v === 'number' ? v : Number(String(v ?? ''));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  } catch {
    return 0;
  }
}
