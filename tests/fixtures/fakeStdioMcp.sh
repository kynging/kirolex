#!/bin/bash
# 假的 stdio MCP（remoteMcpPlace.test.ts 的远端就绪检查用，只用 bash）：按行读 JSON-RPC，回 initialize / tools/list。
# $1：ok（正常）/ silent（不回话）/ error（initialize 回错）/ exit（一起来就退出，stderr 写一句）。
# ok 模式还核对参数和 env 原样到了（$2 = "a b"、KX_T = a'b），不对就退出。
mode=${1:-ok}
[ "$mode" = exit ] && { echo 'boom: missing credentials' >&2; exit 1; }
if [ "$mode" = ok ] && { [ "$2" != "a b" ] || [ "$KX_T" != "a'b" ]; }; then echo "bad argv/env: [$2] [$KX_T]" >&2; exit 3; fi
while IFS= read -r l; do
  [ "$mode" = silent ] && continue
  case "$l" in
    *'"id":1'*)
      if [ "$mode" = error ]; then echo '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}'
      else
        echo '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}'
        echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}}}}'
      fi;;
    *'"id":2'*) echo '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"web-search-tool___WebSearch","inputSchema":{"type":"object"}},{"name":"b","inputSchema":{}}]}}';;
  esac
done
