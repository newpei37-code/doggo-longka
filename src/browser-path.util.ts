import * as fs from 'fs';
import * as path from 'path';
import { telegramConfig } from '../config/telegram.config';

function getProjectRoot(): string {
  const norm = __dirname.replace(/\\/g, '/');
  if (norm.includes('/dist/src')) {
    return path.resolve(__dirname, '..', '..');
  }
  return path.resolve(__dirname, '..');
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Đường dẫn Chrome/Chromium để Puppeteer dùng (VPS đã cài Chrome nhưng chưa `puppeteer browsers install`). */
export function resolveChromeExecutablePath(): string | undefined {
  const cfg = telegramConfig as Record<string, unknown>;
  const fromCfg = String(
    cfg.chrome_executable_path ?? cfg.puppeteer_executable_path ?? '',
  ).trim();
  const fromEnv = String(
    process.env.PUPPETEER_EXECUTABLE_PATH ??
      process.env.CHROME_PATH ??
      process.env.GOOGLE_CHROME_BIN ??
      '',
  ).trim();

  const candidates: string[] = [];
  for (const raw of [fromCfg, fromEnv]) {
    if (!raw) continue;
    candidates.push(
      path.isAbsolute(raw) ? raw : path.join(getProjectRoot(), raw),
    );
  }

  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 =
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    );
    if (local) {
      candidates.push(
        path.join(
          local,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
      );
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    );
  }

  const seen = new Set<string>();
  for (const p of candidates) {
    const norm = path.normalize(p);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (fileExists(norm)) return norm;
  }
  return undefined;
}
