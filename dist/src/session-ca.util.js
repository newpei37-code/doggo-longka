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
exports.getSessionCa = getSessionCa;
exports.resetSessionCaOverrideInConfig = resetSessionCaOverrideInConfig;
exports.readSessionCaOverrideFromConfigFile = readSessionCaOverrideFromConfigFile;
const fs = __importStar(require("fs"));
const telegram_config_1 = require("../config/telegram.config");
const CONFIG_JSON = telegram_config_1.configPath;
const FIRST_RUN_MINUTE_VN = 11 * 60 + 58;
const CA_INTERVAL_MINUTES = 30;
function getSessionCa(soCa, now = new Date()) {
    const vn = new Date(now.getTime() + 7 * 3600 * 1000);
    const minuteOfDay = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    const ca = Math.floor((minuteOfDay - FIRST_RUN_MINUTE_VN) / CA_INTERVAL_MINUTES) + 1;
    return Math.min(Math.max(1, ca), Math.max(1, Math.floor(soCa)));
}
function resetSessionCaOverrideInConfig() {
    try {
        telegram_config_1.telegramConfig.session_ca_override = 0;
        const raw = fs.readFileSync(CONFIG_JSON, 'utf8');
        const j = JSON.parse(raw);
        j.session_ca_override = 0;
        fs.writeFileSync(CONFIG_JSON, JSON.stringify(j, null, 2), 'utf8');
    }
    catch (e) {
        console.warn('[session-ca] Không thể đặt session_ca_override về 0 trong config.json:', e);
    }
}
function readSessionCaOverrideFromConfigFile() {
    try {
        const raw = fs.readFileSync(CONFIG_JSON, 'utf8');
        const j = JSON.parse(raw);
        const v = j.session_ca_override;
        const n = typeof v === 'number' ? v : Number(String(v ?? ''));
        if (!Number.isFinite(n) || n <= 0)
            return 0;
        return Math.floor(n);
    }
    catch {
        return 0;
    }
}
