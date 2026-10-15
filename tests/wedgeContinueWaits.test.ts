import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

test('超时中断时记下时间点，自动续写据此等 cancel 收尾（ONTAP 会话续写被 busy 拒掉）', () => {
  assert.ok(M.includes('e.wedgedAt = Date.now();'));
  const wait = M.indexOf('if (entry.busy && entry.wedgedAt && Date.now() - entry.wedgedAt < 30000)');
  const reject = M.indexOf("throw new Error(tr('Wait for the active turn (including context compaction) to finish before sending the queued message.'))");
  assert.ok(wait > 0 && reject > wait, '先等被判卡死的那一轮放开 busy，再做"还忙着"的拒绝');
});

test('窗口 reload 后，最后一条是半截助手回复也要先 peek：还在跑就认领，不当成答完了', () => {
  const U = fs.readFileSync(path.join(process.cwd(), 'src/renderer/hooks/useAcp.ts'), 'utf8');
  const branch = U.indexOf("if (found.kind === 'answered') {");
  const adopt = U.indexOf('if (peek?.live && !streamingIdsRef.current.has(sid)) { adoptTurn(sid, peek); return; }', branch);
  const clear = U.indexOf("void window.kiroApi.setAutoResent?.(sid, '');", branch);
  assert.ok(branch > 0 && adopt > branch && clear > adopt, '先认领还在跑的那一轮，再清重发台账');
});
