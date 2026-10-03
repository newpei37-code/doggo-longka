"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramService = exports.TELEGRAM_SENDS_TEMP_DISABLED = void 0;
const telegram_1 = require("telegram");
const sessions_1 = require("telegram/sessions");
const events_1 = require("telegram/events");
const telegram_config_1 = require("../../config/telegram.config");
const retry_util_1 = require("../utils/retry.util");
exports.TELEGRAM_SENDS_TEMP_DISABLED = false;
function utf16Len(str) {
    let len = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0) ?? 0;
        len += cp > 0xffff ? 2 : 1;
    }
    return len;
}
function shiftEntities(originalText, newText, entities) {
    if (!entities || entities.length === 0)
        return [];
    const origLines = originalText.split('\n');
    const newLines = newText.split('\n');
    const origOffsets = [];
    const newOffsets = [];
    const lineShiftStart = [];
    const lineDelta = [];
    let o = 0;
    let n = 0;
    for (let i = 0; i < origLines.length; i++) {
        const oldLine = origLines[i] ?? '';
        const nextLine = newLines[i] ?? '';
        origOffsets.push(o);
        newOffsets.push(n);
        const oldChars = Array.from(oldLine);
        const newChars = Array.from(nextLine);
        let p = 0;
        while (p < oldChars.length &&
            p < newChars.length &&
            oldChars[p] === newChars[p]) {
            p += 1;
        }
        let s = 0;
        while (s < oldChars.length - p &&
            s < newChars.length - p &&
            oldChars[oldChars.length - 1 - s] === newChars[newChars.length - 1 - s]) {
            s += 1;
        }
        const prefixUtf16 = utf16Len(oldChars.slice(0, p).join(''));
        const delta = utf16Len(nextLine) - utf16Len(oldLine);
        lineShiftStart.push(prefixUtf16);
        lineDelta.push(delta);
        o += utf16Len(oldLine) + 1;
        n += utf16Len(nextLine) + 1;
    }
    return entities.map((e) => {
        const offset = e.offset ?? 0;
        let lineIdx = -1;
        for (let i = 0; i < origOffsets.length; i++) {
            if (origOffsets[i] <= offset)
                lineIdx = i;
            else
                break;
        }
        if (lineIdx === -1)
            return e;
        const offsetInLine = offset - origOffsets[lineIdx];
        const shiftAt = lineShiftStart[lineIdx] ?? 0;
        const delta = lineDelta[lineIdx] ?? 0;
        const adjustedOffsetInLine = offsetInLine >= shiftAt ? offsetInLine + delta : offsetInLine;
        const newOffset = newOffsets[lineIdx] + adjustedOffsetInLine;
        return { ...e, offset: newOffset };
    });
}
function sanitizeEntitiesForText(newText, entities) {
    const total = utf16Len(newText);
    return entities.filter((e) => {
        const offset = Number(e?.offset ?? -1);
        const length = Number(e?.length ?? -1);
        if (!Number.isFinite(offset) || !Number.isFinite(length))
            return false;
        if (offset < 0 || length <= 0)
            return false;
        if (offset + length > total)
            return false;
        return true;
    });
}
function ensureDangKyLinkEntity(originalText, originalEntities, newText, entities) {
    const keyword = 'ẤN VÀO ĐÂY';
    const idx = newText.indexOf(keyword);
    if (idx < 0)
        return entities;
    const sourceTextUrl = originalEntities.find((e) => {
        const type = e?.className || e?.constructor?.name || '';
        if (type !== 'MessageEntityTextUrl' || !e?.url)
            return false;
        const start = Number(e.offset ?? 0);
        const len = Number(e.length ?? 0);
        if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) {
            return false;
        }
        const piece = originalText.slice(start, start + len).toUpperCase();
        return piece.includes('ẤN VÀO ĐÂY') || piece.includes('ĐĂNG KÝ');
    });
    const cfgFixed = String(telegram_config_1.telegramConfig.dang_ky_link ?? '').trim();
    let finalUrl = cfgFixed || sourceTextUrl?.url || null;
    if (!finalUrl) {
        const userMatch = newText.match(/@([a-zA-Z0-9_]{4,})/) ||
            originalText.match(/@([a-zA-Z0-9_]{4,})/);
        if (userMatch?.[1]) {
            finalUrl = `https://t.me/${userMatch[1]}`;
        }
    }
    if (!finalUrl)
        return entities;
    const start = idx;
    const end = idx + keyword.length;
    const next = entities.filter((e) => {
        const type = e?.className || e?.constructor?.name || '';
        if (type !== 'MessageEntityTextUrl')
            return true;
        const s = Number(e.offset ?? 0);
        const l = Number(e.length ?? 0);
        if (!Number.isFinite(s) || !Number.isFinite(l))
            return true;
        const t = s + l;
        return t <= start || s >= end;
    });
    next.push({
        className: 'MessageEntityTextUrl',
        offset: start,
        length: keyword.length,
        url: finalUrl,
    });
    return next;
}
function buildGramEntities(entities) {
    if (!entities)
        return [];
    return entities.map((e) => {
        const type = e.className || e.constructor?.name || '';
        if (type === 'MessageEntityCustomEmoji' || e.documentId) {
            return new telegram_1.Api.MessageEntityCustomEmoji({
                offset: e.offset,
                length: e.length,
                documentId: e.documentId,
            });
        }
        if (type === 'MessageEntityBold') {
            return new telegram_1.Api.MessageEntityBold({ offset: e.offset, length: e.length });
        }
        if (type === 'MessageEntityItalic') {
            return new telegram_1.Api.MessageEntityItalic({
                offset: e.offset,
                length: e.length,
            });
        }
        if (type === 'MessageEntityCode') {
            return new telegram_1.Api.MessageEntityCode({ offset: e.offset, length: e.length });
        }
        if (type === 'MessageEntityUrl') {
            return new telegram_1.Api.MessageEntityUrl({ offset: e.offset, length: e.length });
        }
        if (type === 'MessageEntityTextUrl') {
            return new telegram_1.Api.MessageEntityTextUrl({
                offset: e.offset,
                length: e.length,
                url: e.url,
            });
        }
        if (type === 'MessageEntityMention') {
            return new telegram_1.Api.MessageEntityMention({
                offset: e.offset,
                length: e.length,
            });
        }
        return e;
    });
}
class TelegramService {
    logger = {
        log: (message) => console.log(`[TelegramService] ${message}`),
        error: (message, error) => {
            if (error !== undefined) {
                console.error(`[TelegramService] ${message}`, error);
            }
            else {
                console.error(`[TelegramService] ${message}`);
            }
        },
    };
    client;
    isCommandHandlerStarted = false;
    perChatTail = new Map();
    lastOutgoingAt = new Map();
    getMinGapMs() {
        const s = Number(telegram_config_1.telegramConfig.min_message_gap_seconds);
        if (Number.isFinite(s) && s >= 0) {
            return Math.round(s * 1000);
        }
        return 25_000;
    }
    async buildEditedPayloadFromLink(messageLink, editFn) {
        const match = messageLink.match(/t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/);
        if (!match) {
            this.logger.error(`❌ buildEditedPayloadFromLink: Link không hợp lệ: ${messageLink}`);
            return null;
        }
        let fromPeer = match[1];
        const messageId = parseInt(match[2]);
        if (messageLink.includes('/c/')) {
            fromPeer = `-100${fromPeer}`;
        }
        if (!this.client.connected) {
            await this.connect();
        }
        const entity = await this.getEntitySafe(fromPeer);
        const messages = await this.client.getMessages(entity, {
            ids: [messageId],
        });
        const msg = messages[0];
        const originalText = msg?.message ?? '';
        const originalEntities = msg?.entities ?? [];
        this.logger.log(`📝 sendEditedMessageFromLink: originalText=\n${originalText}\n---- END ORIGINAL TEXT ----`);
        if (!originalText || originalText.trim() === '') {
            this.logger.log('⚠️ sendEditedMessageFromLink: message không có text, bỏ qua');
            return null;
        }
        const newText = editFn(originalText);
        this.logger.log(`📝 sendEditedMessageFromLink: newText=\n${newText}\n---- END NEW TEXT ----`);
        const shifted = shiftEntities(originalText, newText, originalEntities);
        const sanitized = sanitizeEntitiesForText(newText, shifted);
        const ensured = ensureDangKyLinkEntity(originalText, originalEntities, newText, sanitized);
        const gramEntities = buildGramEntities(ensured);
        return { newText, gramEntities };
    }
    normalizeChatKey(chatId) {
        return String(chatId).trim();
    }
    runWithMinGap(chatId, fn) {
        const key = this.normalizeChatKey(chatId);
        const minGap = this.getMinGapMs();
        const prev = this.perChatTail.get(key) ?? Promise.resolve(undefined);
        const next = prev.then(async () => {
            const last = this.lastOutgoingAt.get(key) ?? 0;
            const need = minGap - (Date.now() - last);
            if (need > 0) {
                this.logger.log(`⏳ Giữ khoảng cách nhóm ${key}: đợi thêm ${Math.ceil(need / 1000)}s`);
                await new Promise((r) => setTimeout(r, need));
            }
            const result = await fn();
            this.lastOutgoingAt.set(key, Date.now());
            return result;
        });
        this.perChatTail.set(key, next.then(() => undefined).catch(() => undefined));
        return next;
    }
    constructor() {
        this.client = new telegram_1.TelegramClient(new sessions_1.StringSession(telegram_config_1.telegramConfig.sessionString || ''), Number(telegram_config_1.telegramConfig.apiId), telegram_config_1.telegramConfig.apiHash, { connectionRetries: 5 });
    }
    async connect() {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED) {
            this.logger.log('⏭️ [TẠM TẮT] Không kết nối Telegram (TELEGRAM_SENDS_TEMP_DISABLED)');
            return;
        }
        try {
            if (telegram_config_1.telegramConfig.sessionString &&
                telegram_config_1.telegramConfig.sessionString.trim() !== '') {
                this.logger.log('🔑 Sử dụng session string đã lưu...');
                await this.client.connect();
            }
            else {
                this.logger.log('📱 Chưa có session, cần đăng nhập lần đầu...');
                const readline = await import('readline');
                await this.client.start({
                    phoneNumber: telegram_config_1.telegramConfig.phoneNumber,
                    password: async () => telegram_config_1.telegramConfig.password,
                    phoneCode: async () => {
                        return new Promise((resolve) => {
                            const rl = readline.createInterface({
                                input: process.stdin,
                                output: process.stdout,
                            });
                            console.log('📱 Vui lòng nhập mã xác thực SMS:');
                            rl.question('Mã SMS: ', (code) => {
                                rl.close();
                                resolve(code.trim());
                            });
                        });
                    },
                    onError: (err) => this.logger.error('Telegram connection error:', err),
                });
                if (this.client.session instanceof sessions_1.StringSession) {
                    const sessionString = this.client.session.save();
                    this.logger.log('✅ Đăng nhập thành công lần đầu! Session string (LƯU LẠI để tái sử dụng cho lần sau):\n' +
                        `\n${sessionString}\n`);
                }
            }
            await this.client.connect();
        }
        catch (error) {
            this.logger.error('❌ Lỗi kết nối Telegram:', error);
            throw error;
        }
    }
    async getEntitySafe(idOrUsername) {
        try {
            return await this.client.getEntity(idOrUsername);
        }
        catch (error) {
            this.logger.log(`⚠️ Không tìm thấy entity ${idOrUsername}, đang reload dialogs...`);
            await this.client.getDialogs({ limit: 200 });
            try {
                return await this.client.getEntity(idOrUsername);
            }
            catch (secondError) {
                this.logger.error(`❌ Vẫn không lấy được entity sau reload: ${secondError.message}`);
                throw secondError;
            }
        }
    }
    async sendMessage(chatId, message) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        return this.runWithMinGap(chatId, async () => {
            if (!this.client.connected)
                await this.connect();
            await this.client.sendMessage(chatId, { message, parseMode: 'html' });
        });
    }
    async fetchMessageTextFromLink(messageLink) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return null;
        const linkMatch = messageLink.match(/t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/);
        if (!linkMatch) {
            this.logger.error(`❌ fetchMessageTextFromLink: Link không hợp lệ: ${messageLink}`);
            return null;
        }
        let fromPeer = linkMatch[1];
        const messageId = parseInt(linkMatch[2], 10);
        if (messageLink.includes('/c/')) {
            fromPeer = `-100${fromPeer}`;
        }
        try {
            if (!this.client.connected)
                await this.connect();
            const entity = await this.getEntitySafe(fromPeer);
            const messages = await this.client.getMessages(entity, {
                ids: [messageId],
            });
            const msg = messages[0];
            const text = msg?.message ?? '';
            if (!text || String(text).trim() === '') {
                this.logger.log('⚠️ fetchMessageTextFromLink: tin không có text, bỏ qua');
                return null;
            }
            const gramEntities = buildGramEntities(msg?.entities ?? []);
            return { text, gramEntities };
        }
        catch (e) {
            this.logger.error(`❌ fetchMessageTextFromLink: ${e?.message || e}`);
            return null;
        }
    }
    async sendPhoto(chatId, photoPath, caption) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        return this.runWithMinGap(chatId, () => (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            if (!this.client.connected)
                await this.connect();
            await this.client.sendFile(chatId, {
                file: photoPath,
                caption,
                parseMode: 'html',
            });
        }, {
            maxRetries: 5,
            initialDelay: 1000,
            maxDelay: 10000,
            retryableErrors: ['connection', 'timeout', 'flood', 'network', 'file'],
        }));
    }
    async sendPhotoWithEntities(chatId, photoPath, caption, formattingEntities) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        return this.runWithMinGap(chatId, () => (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            if (!this.client.connected)
                await this.connect();
            await this.client.sendFile(chatId, {
                file: photoPath,
                caption,
                formattingEntities,
            });
        }, {
            maxRetries: 5,
            initialDelay: 1000,
            maxDelay: 10000,
            retryableErrors: ['connection', 'timeout', 'flood', 'network', 'file'],
        }));
    }
    async sendVideo(chatId, videoPath, caption) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        return this.runWithMinGap(chatId, () => (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            if (!this.client.connected)
                await this.connect();
            await this.client.sendFile(chatId, {
                file: videoPath,
                caption,
                parseMode: 'html',
            });
        }, {
            maxRetries: 5,
            initialDelay: 1000,
            maxDelay: 10000,
            retryableErrors: ['connection', 'timeout', 'flood', 'network', 'file'],
        }));
    }
    async forwardMessage(fromPeerStr, toPeerStr, messageId) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        return this.runWithMinGap(toPeerStr, () => (0, retry_util_1.retryWithBackoffAndJitter)(async () => {
            if (!this.client.connected)
                await this.connect();
            const fromPeer = await this.getEntitySafe(fromPeerStr);
            const toPeer = await this.getEntitySafe(toPeerStr);
            await this.client.forwardMessages(toPeer, {
                fromPeer: fromPeer,
                messages: [messageId],
                dropAuthor: true,
            });
            this.logger.log(`✅ Forward thành công tin nhắn ${messageId} từ ${fromPeerStr} → ${toPeerStr}`);
        }, {
            maxRetries: 5,
            initialDelay: 2000,
            maxDelay: 15000,
            retryableErrors: [
                'connection',
                'timeout',
                'flood',
                'PEER_ID_INVALID',
                'CHANNEL_PRIVATE',
            ],
        }));
    }
    async forwardMessageFromLink(messageLink, toChatId) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        try {
            const linkMatch = messageLink.match(/t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/);
            if (!linkMatch) {
                throw new Error(`Link không đúng định dạng Telegram: ${messageLink}`);
            }
            let fromPeer = linkMatch[1];
            const messageId = parseInt(linkMatch[2]);
            if (messageLink.includes('/c/')) {
                fromPeer = `-100${fromPeer}`;
            }
            this.logger.log(`🔗 Đang forward từ ${fromPeer} (msg ${messageId}) → ${toChatId}`);
            await this.forwardMessage(fromPeer, toChatId, messageId);
        }
        catch (error) {
            this.logger.error(`❌ Lỗi khi forward từ link: ${error.message || error}`);
            throw error;
        }
    }
    async sendEditedMessageFromLink(messageLink, toChatId, editFn) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        try {
            const payload = await this.buildEditedPayloadFromLink(messageLink, editFn);
            if (!payload)
                return;
            const { newText, gramEntities } = payload;
            await this.runWithMinGap(toChatId, async () => {
                if (!this.client.connected)
                    await this.connect();
                await this.client.sendMessage(toChatId, {
                    message: newText,
                    formattingEntities: gramEntities,
                });
            });
        }
        catch (error) {
            this.logger.error(`❌ Lỗi sendEditedMessageFromLink: ${error.message || error}`);
        }
    }
    async sendEditedPhotoCaptionFromLink(messageLink, toChatId, photoPath, editFn) {
        if (exports.TELEGRAM_SENDS_TEMP_DISABLED)
            return;
        try {
            const payload = await this.buildEditedPayloadFromLink(messageLink, editFn);
            if (!payload)
                return;
            const { newText, gramEntities } = payload;
            await this.runWithMinGap(toChatId, async () => {
                if (!this.client.connected)
                    await this.connect();
                await this.client.sendFile(toChatId, {
                    file: photoPath,
                    caption: newText,
                    formattingEntities: gramEntities,
                });
            });
        }
        catch (error) {
            this.logger.error(`❌ Lỗi sendEditedPhotoCaptionFromLink: ${error.message || error}`);
        }
    }
    async startCommandHandler() {
        if (this.isCommandHandlerStarted) {
            this.logger.log('⚠️ Command handler đã được khởi động rồi');
            return;
        }
        try {
            this.client.addEventHandler(async (event) => {
                try {
                    const message = event.message;
                    if (!message || !message.message)
                        return;
                    const text = message.message.trim();
                    const chatId = message.peerId?.toJS?.() ||
                        message.chatId?.toString() ||
                        message.peerId?.toString();
                    if (text.startsWith('/start')) {
                        await this.sendMessage(chatId, `
                🤖 <b>Chào mừng đến với Bot Baccarat!</b>

                📋 <b>Các lệnh có sẵn:</b>
                • /start - Thông tin bot
                • /status - Trạng thái bot
                • /help - Hướng dẫn sử dụng

                ✅ Bot đang hoạt động bình thường!
                            `.trim());
                    }
                    else if (text.startsWith('/help')) {
                        await this.sendMessage(chatId, `
                📖 <b>Hướng dẫn sử dụng Bot Baccarat</b>

                🔹 /start - Khởi động lại bot
                🔹 /status - Kiểm tra trạng thái kết nối
                🔹 /help - Xem hướng dẫn này

                💡 Bot sẽ tự động theo dõi và xử lý tín hiệu Baccarat từ các kênh nguồn.
                            `.trim());
                    }
                    else if (text.startsWith('/status')) {
                        await this.sendMessage(chatId, `
                📊 <b>Trạng thái Bot Baccarat</b>

                🟢 <b>Trạng thái:</b> Đang hoạt động
                🔗 <b>Kết nối Telegram:</b> ${this.client.connected ? '✅ Đã kết nối' : '❌ Mất kết nối'}
                ⏰ <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}

                ✅ Bot sẵn sàng nhận lệnh!
            `.trim());
                    }
                }
                catch (err) {
                    this.logger.error('❌ Lỗi xử lý command:', err);
                }
            }, new events_1.NewMessage({}));
            this.isCommandHandlerStarted = true;
            this.logger.log('✅ Command handler đã được khởi động');
        }
        catch (error) {
            this.logger.error('❌ Lỗi khởi động command handler:', error);
            throw error;
        }
    }
    stopCommandHandler() {
        if (!this.isCommandHandlerStarted) {
            this.logger.log('⚠️ Command handler chưa được khởi động');
            return;
        }
        this.isCommandHandlerStarted = false;
        this.logger.log('⚠️ Command handler đã được đánh dấu dừng (sẽ không xử lý tin nhắn mới)');
    }
    async disconnect() {
        try {
            this.stopCommandHandler();
            await this.client.disconnect();
            this.logger.log('✅ Đã ngắt kết nối Telegram thành công');
        }
        catch (error) {
            this.logger.error('❌ Lỗi khi ngắt kết nối:', error);
        }
    }
}
exports.TelegramService = TelegramService;
