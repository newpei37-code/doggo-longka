import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { telegramConfig } from '../../config/telegram.config';
import { retryWithBackoffAndJitter } from '../utils/retry.util';
import { SendFileInterface } from 'telegram/client/uploads';

/**
 * Tạm tắt kết nối Telegram và mọi thao tác gửi tin (forward / ảnh / sửa tin…).
 * Đặt `true` khi debug để không gửi tin; mặc định `false` để chạy bình thường.
 */
export const TELEGRAM_SENDS_TEMP_DISABLED = false;

// ===== Helpers để xử lý entities (giữ custom emoji premium) =====
function utf16Len(str: string): number {
  let len = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    len += cp > 0xffff ? 2 : 1;
  }
  return len;
}

function shiftEntities(
  originalText: string,
  newText: string,
  entities: any[] | undefined,
): any[] {
  if (!entities || entities.length === 0) return [];

  const origLines = originalText.split('\n');
  const newLines = newText.split('\n');

  const origOffsets: number[] = [];
  const newOffsets: number[] = [];
  const lineShiftStart: number[] = [];
  const lineDelta: number[] = [];
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
    while (
      p < oldChars.length &&
      p < newChars.length &&
      oldChars[p] === newChars[p]
    ) {
      p += 1;
    }
    let s = 0;
    while (
      s < oldChars.length - p &&
      s < newChars.length - p &&
      oldChars[oldChars.length - 1 - s] === newChars[newChars.length - 1 - s]
    ) {
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
      if (origOffsets[i] <= offset) lineIdx = i;
      else break;
    }
    if (lineIdx === -1) return e;
    const offsetInLine = offset - origOffsets[lineIdx];
    const shiftAt = lineShiftStart[lineIdx] ?? 0;
    const delta = lineDelta[lineIdx] ?? 0;
    const adjustedOffsetInLine =
      offsetInLine >= shiftAt ? offsetInLine + delta : offsetInLine;
    const newOffset = newOffsets[lineIdx] + adjustedOffsetInLine;
    return { ...e, offset: newOffset };
  });
}

function sanitizeEntitiesForText(newText: string, entities: any[]): any[] {
  const total = utf16Len(newText);
  return entities.filter((e) => {
    const offset = Number(e?.offset ?? -1);
    const length = Number(e?.length ?? -1);
    if (!Number.isFinite(offset) || !Number.isFinite(length)) return false;
    if (offset < 0 || length <= 0) return false;
    if (offset + length > total) return false;
    return true;
  });
}

function ensureDangKyLinkEntity(
  originalText: string,
  originalEntities: any[],
  newText: string,
  entities: any[],
): any[] {
  const keyword = 'ẤN VÀO ĐÂY';
  const idx = newText.indexOf(keyword);
  if (idx < 0) return entities;

  const sourceTextUrl = originalEntities.find((e: any) => {
    const type = e?.className || e?.constructor?.name || '';
    if (type !== 'MessageEntityTextUrl' || !e?.url) return false;
    const start = Number(e.offset ?? 0);
    const len = Number(e.length ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0) {
      return false;
    }
    const piece = originalText.slice(start, start + len).toUpperCase();
    return piece.includes('ẤN VÀO ĐÂY') || piece.includes('ĐĂNG KÝ');
  }) as any;

  const cfgFixed = String((telegramConfig as any).dang_ky_link ?? '').trim();
  let finalUrl: string | null = cfgFixed || sourceTextUrl?.url || null;
  if (!finalUrl) {
    // Fallback: lấy @username trong block đăng ký để tạo link t.me
    const userMatch =
      newText.match(/@([a-zA-Z0-9_]{4,})/) ||
      originalText.match(/@([a-zA-Z0-9_]{4,})/);
    if (userMatch?.[1]) {
      finalUrl = `https://t.me/${userMatch[1]}`;
    }
  }
  if (!finalUrl) return entities;

  const start = idx;
  const end = idx + keyword.length;
  const next = entities.filter((e: any) => {
    const type = e?.className || e?.constructor?.name || '';
    if (type !== 'MessageEntityTextUrl') return true;
    const s = Number(e.offset ?? 0);
    const l = Number(e.length ?? 0);
    if (!Number.isFinite(s) || !Number.isFinite(l)) return true;
    const t = s + l;
    // bỏ entity text-url đang đè lên vùng "ẤN VÀO ĐÂY"
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

function buildGramEntities(entities: any[] | undefined): any[] {
  if (!entities) return [];
  return entities.map((e) => {
    const type = e.className || e.constructor?.name || '';
    if (type === 'MessageEntityCustomEmoji' || (e as any).documentId) {
      return new Api.MessageEntityCustomEmoji({
        offset: e.offset,
        length: e.length,
        documentId: (e as any).documentId,
      });
    }
    if (type === 'MessageEntityBold') {
      return new Api.MessageEntityBold({ offset: e.offset, length: e.length });
    }
    if (type === 'MessageEntityItalic') {
      return new Api.MessageEntityItalic({
        offset: e.offset,
        length: e.length,
      });
    }
    if (type === 'MessageEntityCode') {
      return new Api.MessageEntityCode({ offset: e.offset, length: e.length });
    }
    if (type === 'MessageEntityUrl') {
      return new Api.MessageEntityUrl({ offset: e.offset, length: e.length });
    }
    if (type === 'MessageEntityTextUrl') {
      return new Api.MessageEntityTextUrl({
        offset: e.offset,
        length: e.length,
        url: (e as any).url,
      });
    }
    if (type === 'MessageEntityMention') {
      return new Api.MessageEntityMention({
        offset: e.offset,
        length: e.length,
      });
    }
    return e;
  });
}

export class TelegramService {
  private readonly logger = {
    log: (message: string) => console.log(`[TelegramService] ${message}`),
    error: (message: string, error?: any) => {
      if (error !== undefined) {
        console.error(`[TelegramService] ${message}`, error);
      } else {
        console.error(`[TelegramService] ${message}`);
      }
    },
  };

  private client: TelegramClient;
  private isCommandHandlerStarted: boolean = false;

  /** Khoảng cách tối thiểu giữa 2 tin gửi vào cùng 1 nhóm (cùng chatId). */
  private readonly perChatTail = new Map<string, Promise<unknown>>();
  private readonly lastOutgoingAt = new Map<string, number>();

  private getMinGapMs(): number {
    const s = Number((telegramConfig as any).min_message_gap_seconds);
    if (Number.isFinite(s) && s >= 0) {
      return Math.round(s * 1000);
    }
    return 25_000;
  }

  private async buildEditedPayloadFromLink(
    messageLink: string,
    editFn: (text: string) => string,
  ): Promise<{ newText: string; gramEntities: any[] } | null> {
    const match = messageLink.match(
      /t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/,
    );
    if (!match) {
      this.logger.error(
        `❌ buildEditedPayloadFromLink: Link không hợp lệ: ${messageLink}`,
      );
      return null;
    }

    let fromPeer: string | number = match[1];
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
    const msg: any = messages[0];
    const originalText: string = msg?.message ?? '';
    const originalEntities: any[] = msg?.entities ?? [];
    this.logger.log(
      `📝 sendEditedMessageFromLink: originalText=\n${originalText}\n---- END ORIGINAL TEXT ----`,
    );
    if (!originalText || originalText.trim() === '') {
      this.logger.log(
        '⚠️ sendEditedMessageFromLink: message không có text, bỏ qua',
      );
      return null;
    }
    const newText = editFn(originalText);
    this.logger.log(
      `📝 sendEditedMessageFromLink: newText=\n${newText}\n---- END NEW TEXT ----`,
    );
    const shifted = shiftEntities(originalText, newText, originalEntities);
    const sanitized = sanitizeEntitiesForText(newText, shifted);
    const ensured = ensureDangKyLinkEntity(
      originalText,
      originalEntities,
      newText,
      sanitized,
    );
    const gramEntities = buildGramEntities(ensured);
    return { newText, gramEntities };
  }

  private normalizeChatKey(chatId: string | number): string {
    return String(chatId).trim();
  }

  /**
   * Xếp hàng theo từng chat: luôn đợi đủ min gap kể từ tin trước vào đúng chat đó (kể cả song song gọi từ nhiều chỗ).
   */
  private runWithMinGap<T>(
    chatId: string | number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.normalizeChatKey(chatId);
    const minGap = this.getMinGapMs();
    const prev = this.perChatTail.get(key) ?? Promise.resolve(undefined);
    const next: Promise<T> = prev.then(async () => {
      const last = this.lastOutgoingAt.get(key) ?? 0;
      const need = minGap - (Date.now() - last);
      if (need > 0) {
        this.logger.log(
          `⏳ Giữ khoảng cách nhóm ${key}: đợi thêm ${Math.ceil(need / 1000)}s`,
        );
        await new Promise((r) => setTimeout(r, need));
      }
      const result = await fn();
      this.lastOutgoingAt.set(key, Date.now());
      return result;
    }) as Promise<T>;
    this.perChatTail.set(
      key,
      next.then(() => undefined).catch(() => undefined),
    );
    return next;
  }

  constructor() {
    this.client = new TelegramClient(
      new StringSession(telegramConfig.sessionString || ''),
      Number(telegramConfig.apiId),
      telegramConfig.apiHash,
      { connectionRetries: 5 },
    );
  }

  /**
   * Kết nối tới Telegram. Nếu là lần đầu đăng nhập, sau khi đăng nhập thành công sẽ in ra session string để lưu dùng cho các lần tiếp theo.
   */
  async connect(): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) {
      this.logger.log(
        '⏭️ [TẠM TẮT] Không kết nối Telegram (TELEGRAM_SENDS_TEMP_DISABLED)',
      );
      return;
    }
    try {
      if (
        telegramConfig.sessionString &&
        telegramConfig.sessionString.trim() !== ''
      ) {
        this.logger.log('🔑 Sử dụng session string đã lưu...');
        await this.client.connect();
      } else {
        this.logger.log('📱 Chưa có session, cần đăng nhập lần đầu...');
        const readline = await import('readline');
        await this.client.start({
          phoneNumber: telegramConfig.phoneNumber,
          password: async () => telegramConfig.password,
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
          onError: (err) =>
            this.logger.error('Telegram connection error:', err),
        });

        // Sau khi đăng nhập lần đầu, xuất session string để lưu lại dùng sau này
        if (this.client.session instanceof StringSession) {
          const sessionString = this.client.session.save();
          this.logger.log(
            '✅ Đăng nhập thành công lần đầu! Session string (LƯU LẠI để tái sử dụng cho lần sau):\n' +
              `\n${sessionString}\n`,
          );
          // Optionally also save to file here if desired
        }
      }

      await this.client.connect();
    } catch (error) {
      this.logger.error('❌ Lỗi kết nối Telegram:', error);
      throw error;
    }
  }

  private async getEntitySafe(
    idOrUsername: string | number | any,
  ): Promise<any> {
    try {
      return await this.client.getEntity(idOrUsername);
    } catch (error: any) {
      this.logger.log(
        `⚠️ Không tìm thấy entity ${idOrUsername}, đang reload dialogs...`,
      );

      // Reload dialogs để lấy access_hash mới
      await this.client.getDialogs({ limit: 200 });

      try {
        return await this.client.getEntity(idOrUsername);
      } catch (secondError: any) {
        this.logger.error(
          `❌ Vẫn không lấy được entity sau reload: ${secondError.message}`,
        );
        throw secondError;
      }
    }
  }

  async sendMessage(chatId: string | number, message: string): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    return this.runWithMinGap(chatId, async () => {
      if (!this.client.connected) await this.connect();
      await this.client.sendMessage(chatId, { message, parseMode: 'html' });
    });
  }

  /**
   * Đọc text + entities từ tin Telegram theo link (giữ custom emoji premium).
   */
  async fetchMessageTextFromLink(
    messageLink: string,
  ): Promise<{ text: string; gramEntities: any[] } | null> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return null;
    const linkMatch = messageLink.match(
      /t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/,
    );
    if (!linkMatch) {
      this.logger.error(
        `❌ fetchMessageTextFromLink: Link không hợp lệ: ${messageLink}`,
      );
      return null;
    }
    let fromPeer: string | number = linkMatch[1];
    const messageId = parseInt(linkMatch[2], 10);
    if (messageLink.includes('/c/')) {
      fromPeer = `-100${fromPeer}`;
    }
    try {
      if (!this.client.connected) await this.connect();
      const entity = await this.getEntitySafe(fromPeer);
      const messages = await this.client.getMessages(entity, {
        ids: [messageId],
      });
      const msg: any = messages[0];
      const text: string = msg?.message ?? '';
      if (!text || String(text).trim() === '') {
        this.logger.log(
          '⚠️ fetchMessageTextFromLink: tin không có text, bỏ qua',
        );
        return null;
      }
      const gramEntities = buildGramEntities(msg?.entities ?? []);
      return { text, gramEntities };
    } catch (e: any) {
      this.logger.error(`❌ fetchMessageTextFromLink: ${e?.message || e}`);
      return null;
    }
  }

  async sendPhoto(
    chatId: string | number,
    photoPath: string,
    caption?: string,
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    return this.runWithMinGap(chatId, () =>
      retryWithBackoffAndJitter(
        async () => {
          if (!this.client.connected) await this.connect();
          await this.client.sendFile(chatId, {
            file: photoPath,
            caption,
            parseMode: 'html',
          });
        },
        {
          maxRetries: 5,
          initialDelay: 1000,
          maxDelay: 10000,
          retryableErrors: ['connection', 'timeout', 'flood', 'network', 'file'],
        },
      ),
    );
  }

  /** Gửi ảnh với caption + formattingEntities (custom emoji), không dùng parseMode HTML. */
  async sendPhotoWithEntities(
    chatId: string | number,
    photoPath: string,
    caption: string,
    formattingEntities: any[],
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    return this.runWithMinGap(chatId, () =>
      retryWithBackoffAndJitter(
        async () => {
          if (!this.client.connected) await this.connect();
          await this.client.sendFile(chatId, {
            file: photoPath,
            caption,
            formattingEntities,
          } as any);
        },
        {
          maxRetries: 5,
          initialDelay: 1000,
          maxDelay: 10000,
          retryableErrors: ['connection', 'timeout', 'flood', 'network', 'file'],
        },
      ),
    );
  }

  async sendVideo(
    chatId: string | number,
    videoPath: string,
    caption?: string,
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    return this.runWithMinGap(chatId, () =>
      retryWithBackoffAndJitter(
        async () => {
          if (!this.client.connected) await this.connect();
          await this.client.sendFile(chatId, {
            file: videoPath,
            caption,
            parseMode: 'html',
          });
        },
        {
          maxRetries: 5,
          initialDelay: 1000,
          maxDelay: 10000,
          retryableErrors: ['connection', 'timeout', 'flood', 'network', 'file'],
        },
      ),
    );
  }

  /**
   * Forward message sử dụng wrapper forwardMessages của GramJS
   * (tốt hơn invoke raw vì tự handle entity và access_hash)
   */
  async forwardMessage(
    fromPeerStr: string | number,
    toPeerStr: string | number,
    messageId: number,
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    return this.runWithMinGap(toPeerStr, () =>
      retryWithBackoffAndJitter(
        async () => {
          if (!this.client.connected) await this.connect();

          const fromPeer = await this.getEntitySafe(fromPeerStr);
          const toPeer = await this.getEntitySafe(toPeerStr);

          // Sử dụng wrapper thay vì invoke raw để tránh lỗi PEER_ID_INVALID
          await this.client.forwardMessages(toPeer, {
            fromPeer: fromPeer,
            messages: [messageId],
            dropAuthor: true,
          });

          this.logger.log(
            `✅ Forward thành công tin nhắn ${messageId} từ ${fromPeerStr} → ${toPeerStr}`,
          );
        },
        {
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
        },
      ),
    );
  }

  /**
   * Forward từ link Telegram (public hoặc private)
   * Hỗ trợ cả t.me/username/123 và t.me/c/123456789/123
   */
  async forwardMessageFromLink(
    messageLink: string,
    toChatId: string | number,
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    try {
      // Regex hỗ trợ cả public username và private channel (c/)
      const linkMatch = messageLink.match(
        /t\.me\/(?:c\/)?(\d+|[a-zA-Z0-9_]+)\/(\d+)/,
      );
      if (!linkMatch) {
        throw new Error(`Link không đúng định dạng Telegram: ${messageLink}`);
      }

      let fromPeer = linkMatch[1]; // username hoặc channelId
      const messageId = parseInt(linkMatch[2]);

      // Nếu là private channel (c/), chuyển thành -100 + channelId
      if (messageLink.includes('/c/')) {
        fromPeer = `-100${fromPeer}`;
      }

      this.logger.log(
        `🔗 Đang forward từ ${fromPeer} (msg ${messageId}) → ${toChatId}`,
      );

      await this.forwardMessage(fromPeer, toChatId, messageId);
    } catch (error: any) {
      this.logger.error(
        `❌ Lỗi khi forward từ link: ${error.message || error}`,
      );
      throw error;
    }
  }

  /**
   * Đọc message theo link, chỉnh sửa text (giữ entities custom emoji) và gửi lại
   * thành một tin nhắn mới tới toChatId.
   */
  async sendEditedMessageFromLink(
    messageLink: string,
    toChatId: string | number,
    editFn: (text: string) => string,
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    try {
      const payload = await this.buildEditedPayloadFromLink(messageLink, editFn);
      if (!payload) return;
      const { newText, gramEntities } = payload;

      await this.runWithMinGap(toChatId, async () => {
        if (!this.client.connected) await this.connect();
        await this.client.sendMessage(toChatId, {
          message: newText,
          formattingEntities: gramEntities,
        });
      });
    } catch (error: any) {
      this.logger.error(
        `❌ Lỗi sendEditedMessageFromLink: ${error.message || error}`,
      );
    }
  }

  async sendEditedPhotoCaptionFromLink(
    messageLink: string,
    toChatId: string | number,
    photoPath: string,
    editFn: (text: string) => string,
  ): Promise<void> {
    if (TELEGRAM_SENDS_TEMP_DISABLED) return;
    try {
      const payload = await this.buildEditedPayloadFromLink(messageLink, editFn);
      if (!payload) return;
      const { newText, gramEntities } = payload;

      await this.runWithMinGap(toChatId, async () => {
        if (!this.client.connected) await this.connect();
        await this.client.sendFile(toChatId, {
          file: photoPath,
          caption: newText,
          formattingEntities: gramEntities,
        } as any);
      });
    } catch (error: any) {
      this.logger.error(
        `❌ Lỗi sendEditedPhotoCaptionFromLink: ${error.message || error}`,
      );
    }
  }

  async startCommandHandler(): Promise<void> {
    if (this.isCommandHandlerStarted) {
      this.logger.log('⚠️ Command handler đã được khởi động rồi');
      return;
    }

    try {
      this.client.addEventHandler(async (event: any) => {
        try {
          const message = event.message;
          if (!message || !message.message) return;

          const text = message.message.trim();
          const chatId =
            message.peerId?.toJS?.() ||
            message.chatId?.toString() ||
            message.peerId?.toString();

          if (text.startsWith('/start')) {
            await this.sendMessage(
              chatId,
              `
                🤖 <b>Chào mừng đến với Bot Baccarat!</b>

                📋 <b>Các lệnh có sẵn:</b>
                • /start - Thông tin bot
                • /status - Trạng thái bot
                • /help - Hướng dẫn sử dụng

                ✅ Bot đang hoạt động bình thường!
                            `.trim(),
            );
          } else if (text.startsWith('/help')) {
            await this.sendMessage(
              chatId,
              `
                📖 <b>Hướng dẫn sử dụng Bot Baccarat</b>

                🔹 /start - Khởi động lại bot
                🔹 /status - Kiểm tra trạng thái kết nối
                🔹 /help - Xem hướng dẫn này

                💡 Bot sẽ tự động theo dõi và xử lý tín hiệu Baccarat từ các kênh nguồn.
                            `.trim(),
            );
          } else if (text.startsWith('/status')) {
            await this.sendMessage(
              chatId,
              `
                📊 <b>Trạng thái Bot Baccarat</b>

                🟢 <b>Trạng thái:</b> Đang hoạt động
                🔗 <b>Kết nối Telegram:</b> ${this.client.connected ? '✅ Đã kết nối' : '❌ Mất kết nối'}
                ⏰ <b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}

                ✅ Bot sẵn sàng nhận lệnh!
            `.trim(),
            );
          }
        } catch (err) {
          this.logger.error('❌ Lỗi xử lý command:', err);
        }
      }, new NewMessage({}));

      this.isCommandHandlerStarted = true;
      this.logger.log('✅ Command handler đã được khởi động');
    } catch (error) {
      this.logger.error('❌ Lỗi khởi động command handler:', error);
      throw error;
    }
  }

  stopCommandHandler(): void {
    if (!this.isCommandHandlerStarted) {
      this.logger.log('⚠️ Command handler chưa được khởi động');
      return;
    }
    this.isCommandHandlerStarted = false;
    this.logger.log(
      '⚠️ Command handler đã được đánh dấu dừng (sẽ không xử lý tin nhắn mới)',
    );
  }

  async disconnect(): Promise<void> {
    try {
      this.stopCommandHandler();
      await this.client.disconnect();
      this.logger.log('✅ Đã ngắt kết nối Telegram thành công');
    } catch (error) {
      this.logger.error('❌ Lỗi khi ngắt kết nối:', error);
    }
  }
}
