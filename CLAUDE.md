# CLAUDE.md

**先读 [AGENTS.md](./AGENTS.md)。** 项目说明、模块地图、不能破坏的规则、测试约定和改动纪律都在那里，本文件只补 Claude Code 专有的几条。

## Claude Code 专有提示

- `src/main/index.ts`（≈11500 行）、`src/renderer/App.tsx`、`src/renderer/hooks/useAcp.ts`、`src/renderer/components/ChatArea.tsx` 都很大：
  不要整份 Read。先用 Grep 按函数名 / IPC 通道名 / 存储键定位（AGENTS.md §3 给的都是真名），再用 Read 的 `offset` / `limit` 读那一段。
- 跨很多文件的摸底（例如"排队消息在哪些地方被读写"）交给 Explore 子代理，自己只拿结论；拿到结论后对关键处再亲自核对一遍。
- 用 Edit 做小而精确的替换，不要用 Write 整份重写大文件。
- 本机是 Windows 时，Bash 工具跑的是 Git Bash：用 `/` 路径和 POSIX 语法；需要 Windows 原生行为（进程列表等）时显式调 `powershell.exe -NoProfile -Command …`。
- 验证用 `npm run build` + `npm test`（单个文件：`node --test tests/<名字>.test.ts`）；改了 renderer 再跑 `npx tsc -p tsconfig.json`。不要用 `npm run dev:hot` 验证。
