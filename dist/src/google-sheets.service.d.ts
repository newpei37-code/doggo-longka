export type GroupKind = 'that' | 'ao';
export declare function isGoogleSheetConfigured(): boolean;
export declare function appendCaProfitToGoogleSheet(group: GroupKind, amount: number, caIndex?: number): Promise<void>;
