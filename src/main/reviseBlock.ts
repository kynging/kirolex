/**
 * 侧栏文件预览里「✓ 确认」那一条意见 —— **在打开这份文件的那条会话里改**，PURE 判据。
 *
 * 「提交一条直接让 AI 改这一句或这一段，改完更新」+「你应该把修改放到执行会话中完成，而不是新开 cli，
 * 否则新的 session 缺少必要的上下文」。
 *
 * 这一份是从 feature/flow 那边（门上的逐段改写）搬过来的，**只搬了文件预览用得到的那一半**：
 *
 *   · `reviseInSessionPrompt`  发给那条会话的提示词（`block` 只回这一段 / `whole` 回整份）
 *   · `parseRevised`           回复 → 能直接拼回文件的正文，以及"改不了"的记号
 *
 * 门那侧另外两条（一次性 helper 子进程的 `revisePrompt`、「＋ 加一条」的 `insert` 档）和 PPT 那条
 * （按 run 地址改幻灯片文字）都没搬 —— 它们分别属于 flow 的门和 deck 预览，这边没有调用者。
 *
 * 发送、排队、等回复、写盘在 `index.ts`（`review:revise-in-session` / `review:write-file`），
 * 这里只放"说什么"和"收到的怎么认"，所以全部可测。
 */

export interface RevisedBlock {
  /** 改写后的正文；`cannot` 为真时它等于原文。 */
  text: string;
  /** 模型说这条意见改不了这一段 —— 调用方据此升级到整份，或者把原因摆给你看。 */
  cannot?: string;
}

/**
 * 模型的回复 → 能直接拼回文件的正文 —— PURE。
 *
 * 清掉三样实测会混进来的东西：外层围栏、`CANNOT-REVISE-LOCALLY` 那一行、以及首尾空白。
 * **不做别的清洗** —— 尤其不去掉开场白：那种句子没法可靠识别（"本周项目进展如下"可能就是正文），
 * 而误删正文比留一句废话糟得多。提示词负责不让它出现，这里只负责我们自己约定的那两个记号。
 */
export function parseRevised(stdout: string, original: string): RevisedBlock {
  let body = String(stdout ?? '').trim();
  let cannot: string | undefined;
  const m = /^\s*CANNOT-REVISE-LOCALLY:\s*(.*)$/m.exec(body);
  if (m) {
    cannot = m[1].trim() || '这条意见改不了单独一段';
    body = body.replace(m[0], '').trim();
  }
  /*
    去掉**最外层**围栏（模型即使被告知也常加一层）。只去最外层：原文里本来就可能有代码块，
    把里面的也剥掉会毁掉内容。
  */
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body);
  if (fence) body = fence[2].trim();
  if (cannot) return { text: String(original ?? ''), cannot };
  /* 空回复不能当成"改成空的" —— 那会静默删掉一段（整份那一档就是删掉整个文件） */
  if (!body) return { text: String(original ?? ''), cannot: '模型没有返回内容' };
  return { text: body };
}

/**
 * 发给**打开这份文件那条会话**的提示词 —— PURE。
 *
 * ## 为什么在会话里改，而不是一次性子进程
 *
 * 一次性子进程什么都不知道 —— 不知道这是一份周报、不知道字段约定、不知道上游材料里那个客户叫什么；
 * 而这份文件往往正是那条会话刚做出来的，这些全在它的上下文里。代价是这一轮进它的 transcript —— 接受。
 *
 * ## 两档
 *
 *   `block`  只回改完的这一段（默认）。绝大多数意见是"这句话口径不对"，让它把整份四千字重写一遍
 *            纯属白等 —— 实测一次改写 35 秒，其中生成那部分和回复长度直接相关。
 *   `whole`  整份正文。只在 `block` 那次回了 `CANNOT-REVISE-LOCALLY` 时才走 ——
 *            那说明这条意见要跨段（加一段、删一段、把一条挪到别的小节），只有整份才表达得出来。
 *
 * **落盘由 KiroLex 做**，提示词里明确禁止它自己动文件：两个写者对同一个文件要么改两遍要么互相覆盖。
 */
export function reviseInSessionPrompt(input: {
  /** 意见指的那一处（原文片段）—— 给它一个落点，别让它猜。 */
  where: string;
  /** 用户写的那条意见。 */
  note: string;
  /** 这份东西是什么（文件路径 / 文件名），可空。 */
  about?: string;
  scope?: 'block' | 'whole';
  /**
   * **现在的完整正文**（只有 `whole` 档用）——「有一些我删掉的内容怎么变成我增加的内容了？」
   *
   * 整份重改原来只把"意见指的那一段"发过去，然后叫它"输出完整正文" —— 于是它照**自己会话里记得的
   * 那一版**重写，而那一版可能是你（或别的意见）改过之前的：已经删掉的内容又原样回来了。
   * 所以要把盘上此刻那一份当基准发过去。
   */
  full?: string;
}): string {
  const about = String(input.about || '').trim();
  const whole = input.scope === 'whole';
  const head = whole
    ? `下面这条意见改不了单独一段，所以按它改**整份**${about ? `「${about}」` : '文件'}，然后只输出改完的完整正文。`
    : `下面这条意见是对${about ? `「${about}」` : '那份文件'}里某一处提的。按它改，然后**只输出改完的这一段**。`;
  const full = String(input.full ?? '').trim();
  return [
    head,
    '',
    ...(whole && full ? [
      '**现在的完整正文**（以这一份为基准 —— 它就是盘上此刻的样子；',
      '你自己记得的那一版可能是旧的，不要拿它当底稿）：',
      '---',
      full,
      '---',
      '',
    ] : []),
    whole && full ? '意见指的位置（上面那份里的一处）：' : '意见指的位置（原文片段）：',
    '---',
    String(input.where ?? '').trim(),
    '---',
    '',
    '意见：',
    String(input.note ?? '').trim(),
    '',
    '要求：',
    whole
      ? '· **输出完整正文**，从第一行到最后一行 —— 不要只给改动的片段；'
      : '· **只输出这一段改完的样子** —— 不要把整份重写一遍（那样我要多等好几十秒），'
        + '\n  也不要只给"改动说明"；',
    '· 不要用 ``` 围栏包起来，也不要写"好的""已修改如下"这类开场（那些话会被原样写进文件）；',
    '· 保持原来的标记形式（原文是 markdown 列表就还是列表，是标题就还是同级标题，段落之间的空行照留）；',
    whole
      ? '· **只改这条意见说的地方**，其余每一行原样保留 —— 我会按行比对，动了别处会被当成误改；'
        + (full
          ? '\n· **上面那份正文里没有的东西，就是已经删掉的 —— 不要写回来**。'
            + '你记得的那一版里有、这一份里没有的，一律当作已经删掉；'
          : '')
      : '· **意见没提到的地方一个字都不要动**；',
    whole
      ? '· 这条意见要求加一段、删一段、或者把某一条挪到别的位置时，**照做** —— 结构调整是允许的；'
      : '· 如果这条意见**没法只改这一段**（要和别处合并、要新增段落、要把它挪到别的小节），'
        + '\n  就原样返回这一段，并在最后单独一行写 `CANNOT-REVISE-LOCALLY: 需要改整份`；',
    '· **不要用工具去改文件**（`fs_write` 之类）—— 落盘由 KiroLex 统一做。',
    '  你也动一遍的话就是两个写者对同一个文件：要么改两遍，要么互相覆盖；',
    '· 如果这条意见需要你没有的信息（要查外部系统、要问人），不要编：照原样返回，',
    '  并在最后单独一行写 `CANNOT-REVISE-LOCALLY: <一句话说缺什么>`。',
  ].join('\n');
}

/**
 * 这一轮的回复**能不能当成改写结果** —— PURE。
 *
 * 写回文件是这条路上唯一不可逆的一步（有备份，但你不一定会去翻），所以只收**正常结束**的那一轮：
 *
 *   · `stopReason` 不是 `end_turn`（`max_tokens`、`refusal`…）—— 回复是被截断的。`whole` 那一档拿一份
 *     截断的正文去写盘，等于把文件后半截删掉；
 *   · 这一轮被看门狗判成卡死（`wedged`）—— 它的"回复"末尾挂着 KiroLex 自己的说明，不是模型写的正文。
 *
 * 取消 / 出错的那一轮根本不会走到这里（调用方只在一轮**成功收尾**时兑付等待者）。
 */
export function replyUsable(meta: { stopReason?: string | null; wedged?: boolean }): { ok: true } | { ok: false; why: string } {
  if (meta.wedged) return { ok: false, why: '这一轮卡住被中断了 —— 回复不完整，不写' };
  const r = String(meta.stopReason ?? '').trim();
  if (r && r !== 'end_turn' && r !== 'n/a') return { ok: false, why: `回复没有正常结束（${r}）—— 可能被截断，不写` };
  return { ok: true };
}
