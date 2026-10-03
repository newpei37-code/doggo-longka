import * as fs from 'fs';
import * as os from 'os';
import { telegramConfig } from '../config/telegram.config';

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function systemChromeCandidates(): string[] {
  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter((v): v is string => Boolean(v));
    const suffix = 'Google\\Chrome\\Application\\chrome.exe';
    return [
      ...roots.map((r) => `${r}\\${suffix}`),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ];
  }

  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
}

/**
 * Chỉ dùng Chrome đã cài trên máy (config / env / đường dẫn mặc định hệ điều hành).
 * Không dùng bản Chrome tải qua Puppeteer cache.
 */
export function resolveChromeExecutablePath(): string {
  const fromConfig = String(
    (telegramConfig as { chrome_executable_path?: string })
      .chrome_executable_path ?? '',
  ).trim();
  if (fromConfig) {
    if (fileExists(fromConfig)) return fromConfig;
    throw new Error(
      `chrome_executable_path không tồn tại: ${fromConfig}`,
    );
  }

  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (fromEnv) {
    if (fileExists(fromEnv)) return fromEnv;
    throw new Error(
      `PUPPETEER_EXECUTABLE_PATH không tồn tại: ${fromEnv}`,
    );
  }

  for (const candidate of systemChromeCandidates()) {
    if (fileExists(candidate)) return candidate;
  }

  throw new Error(
    [
      'Không tìm thấy Google Chrome trên máy.',
      'Cài Chrome hoặc thêm vào config.json, ví dụ Windows:',
      '  "chrome_executable_path": "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"',
    ].join('\n'),
  );
}
