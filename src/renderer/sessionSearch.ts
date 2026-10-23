/* 搬到 src/main/sessionSearch.ts 了 —— 主进程的 `sessions_list` 工具（sessionCalls.ts）也用它，而主进程的 tsconfig 只编 src/main。 */
export * from '../main/sessionSearch.ts';
