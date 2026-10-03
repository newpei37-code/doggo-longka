"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveChromeExecutablePath = resolveChromeExecutablePath;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const telegram_config_1 = require("../config/telegram.config");
function fileExists(filePath) {
    try {
        return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
function systemChromeCandidates() {
    if (process.platform === 'win32') {
        const roots = [
            process.env.PROGRAMFILES,
            process.env['PROGRAMFILES(X86)'],
            process.env.LOCALAPPDATA,
        ].filter((v) => Boolean(v));
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
function resolveChromeExecutablePath() {
    const fromConfig = String(telegram_config_1.telegramConfig
        .chrome_executable_path ?? '').trim();
    if (fromConfig) {
        if (fileExists(fromConfig))
            return fromConfig;
        throw new Error(`chrome_executable_path không tồn tại: ${fromConfig}`);
    }
    const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    if (fromEnv) {
        if (fileExists(fromEnv))
            return fromEnv;
        throw new Error(`PUPPETEER_EXECUTABLE_PATH không tồn tại: ${fromEnv}`);
    }
    for (const candidate of systemChromeCandidates()) {
        if (fileExists(candidate))
            return candidate;
    }
    throw new Error([
        'Không tìm thấy Google Chrome trên máy.',
        'Cài Chrome hoặc thêm vào config.json, ví dụ Windows:',
        '  "chrome_executable_path": "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"',
    ].join('\n'));
}
