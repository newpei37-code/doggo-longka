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
const path = __importStar(require("path"));
const telegram_config_1 = require("../config/telegram.config");
function getProjectRoot() {
    const norm = __dirname.replace(/\\/g, '/');
    if (norm.includes('/dist/src')) {
        return path.resolve(__dirname, '..', '..');
    }
    return path.resolve(__dirname, '..');
}
function fileExists(p) {
    try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}
function resolveChromeExecutablePath() {
    const cfg = telegram_config_1.telegramConfig;
    const fromCfg = String(cfg.chrome_executable_path ?? cfg.puppeteer_executable_path ?? '').trim();
    const fromEnv = String(process.env.PUPPETEER_EXECUTABLE_PATH ??
        process.env.CHROME_PATH ??
        process.env.GOOGLE_CHROME_BIN ??
        '').trim();
    const candidates = [];
    for (const raw of [fromCfg, fromEnv]) {
        if (!raw)
            continue;
        candidates.push(path.isAbsolute(raw) ? raw : path.join(getProjectRoot(), raw));
    }
    if (process.platform === 'win32') {
        const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const local = process.env.LOCALAPPDATA || '';
        candidates.push(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        if (local) {
            candidates.push(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
        }
    }
    else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    }
    else {
        candidates.push('/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium');
    }
    const seen = new Set();
    for (const p of candidates) {
        const norm = path.normalize(p);
        if (seen.has(norm))
            continue;
        seen.add(norm);
        if (fileExists(norm))
            return norm;
    }
    return undefined;
}
