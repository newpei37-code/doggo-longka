export declare const TELEGRAM_SENDS_TEMP_DISABLED = false;
export declare class TelegramService {
    private readonly logger;
    private client;
    private isCommandHandlerStarted;
    private readonly perChatTail;
    private readonly lastOutgoingAt;
    private getMinGapMs;
    private buildEditedPayloadFromLink;
    private normalizeChatKey;
    private runWithMinGap;
    constructor();
    connect(): Promise<void>;
    private getEntitySafe;
    sendMessage(chatId: string | number, message: string): Promise<void>;
    fetchMessageTextFromLink(messageLink: string): Promise<{
        text: string;
        gramEntities: any[];
    } | null>;
    sendPhoto(chatId: string | number, photoPath: string, caption?: string): Promise<void>;
    sendPhotoWithEntities(chatId: string | number, photoPath: string, caption: string, formattingEntities: any[]): Promise<void>;
    sendVideo(chatId: string | number, videoPath: string, caption?: string): Promise<void>;
    forwardMessage(fromPeerStr: string | number, toPeerStr: string | number, messageId: number): Promise<void>;
    forwardMessageFromLink(messageLink: string, toChatId: string | number): Promise<void>;
    sendEditedMessageFromLink(messageLink: string, toChatId: string | number, editFn: (text: string) => string): Promise<void>;
    sendEditedPhotoCaptionFromLink(messageLink: string, toChatId: string | number, photoPath: string, editFn: (text: string) => string): Promise<void>;
    startCommandHandler(): Promise<void>;
    stopCommandHandler(): void;
    disconnect(): Promise<void>;
}
