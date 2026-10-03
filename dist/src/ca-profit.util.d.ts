type GroupKind = 'that' | 'ao';
export declare function upsertCaProfitToday(group: GroupKind, caIndex: number, amount: number): void;
export declare function getCaProfitsToday(group: GroupKind): Record<number, number>;
export declare function getTotalsForMonth(group: GroupKind): {
    today: number;
    month: number;
};
export {};
