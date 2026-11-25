/** 会话之间互相调用（sessionCalls.ts、index.ts 里的接线）。`{n} s` / `{n} min` 已在 indexB 里。 */
export const ZH_SESSION_CALLS: Record<string, string> = {
  '📨 From session "{title}"': '📨 来自会话「{title}」',
  '— it is waiting for your reply: answer in this turn and the reply goes back to it automatically.': '—— 它在等你回复：在这一轮里直接回答，回复会自动转回给它。',
  '— it is not waiting for a reply; if you need to answer, use session_send.': '—— 它没有在等回复；需要回话的话用 session_send。',
  '📨 Reply from session "{title}"': '📨 会话「{title}」的回复',
  '…[cut: the reply is {n} characters, only the first {max} are here — use session_read to see the rest]': '…[已截断：回复共 {n} 字，这里只有前 {max} 字 —— 用 session_read 看其余部分]',
  '{n} h': '{n} 小时',
  '⚠️ Session "{title}" was deleted before it replied.': '⚠️ 会话「{title}」还没回复就被删除了。',
  '(That turn ended without any reply text.)': '（那一轮结束了，但没有回复文字。）',
  '⏰ No reply from session "{title}" within {dur} (it may still be busy or the message may still be queued). Use session_read to check on it.': '⏰ 会话「{title}」在 {dur} 内没有回复（它可能还在忙，或者消息还在排队）。可以用 session_read 看它的进展。',
  '📤 Sent to session "{title}" ({route}): {text}': '📤 已发给会话「{title}」（{route}）：{text}',
  'sent right away': '对方空闲，直接发出',
  '⚠️ Could not add the message to the running turn of session "{title}" ({reason}); it is marked red there and waits for the user: {text}': '⚠️ 没能把消息追加进会话「{title}」正在进行的这一轮（{reason}），它在那边标红、等用户处理：{text}',
  'added to its running turn': '追加进了它正在进行的这一轮',
  'queued until its turn ends': '排队，等它这一轮结束后发',
  // ── 对方这一轮被断线打断 / 发起方没连着（sessionCalls.ts ReplyWatcher、index.ts 唤醒队列接线） ──
  '⚠️ The turn in session "{title}" was cut off because its connection dropped (or its executor exited); it did not finish. Output so far: {partial}':
    '⚠️ 会话「{title}」这一轮因连接断开（或执行器退出）中断，没有完成。已产出的部分：{partial}',
  '(nothing yet)': '没有',
  'KiroLex keeps waiting for its reply until the original deadline ({dur} after sending); if it finishes later, the reply will be sent here.':
    'KiroLex 会接着等它的回复，直到原来的期限（发出后 {dur}）；它之后处理完了，回复会发回这里。',
  // ── 对方的用户停止 / 切换模型中断 / 撤回排队 / 插话（sessionCalls.ts ReplyWatcher） ──
  '⏹️ The user of session "{title}" stopped this turn; it did not finish. Output so far: {partial}':
    '⏹️ 对方的用户停止了这一轮（会话「{title}」），没有做完。已产出的部分：{partial}',
  'KiroLex is no longer waiting for this reply.': 'KiroLex 不再等这条的回复。',
  '🔀 Session "{title}" interrupted this turn to switch model and is continuing it on the new model. Output so far: {partial}':
    '🔀 会话「{title}」因切换模型中断了这一轮，已在新模型上继续。已产出的部分：{partial}',
  'Its reply will be sent here once it finishes (KiroLex keeps waiting until the original deadline, {dur} after sending).':
    '之后的回复会再发给你（KiroLex 接着等到原来的期限：发出后 {dur}）。',
  '🗑️ The user of session "{title}" cancelled this message from its queue; it was not processed. KiroLex is no longer waiting for a reply.':
    '🗑️ 对方的用户取消了这条消息，没有处理（会话「{title}」，从排队里删掉了）。KiroLex 不再等回复。',
  '(During this turn the user of session "{title}" also added message(s) of their own; the reply may also answer those.)':
    '（这一轮对方的用户插入了消息（会话「{title}」），回复里可能也有对那些消息的回答。）',
  '(The user of session "{title}" sent another message after this turn; that next turn is not included here.)':
    '（会话「{title}」的用户在这一轮之后又发了消息，另起的那一轮没有算进来。）',
  'Stopped waiting for the reply from session "{title}"; if it replies later, the reply will not be sent here.': '不再等会话「{title}」的回复了；它之后回复也不会再发到这里。',
  '{label} has arrived; it will be sent to the model once this session is connected again.': '{label}已到，等这条会话连上后发给模型。',
  '⏳ A background result has arrived; it will be sent to the model once this session is connected again: {text}': '⏳ 后台结果已到，等这条会话连上后发给模型：{text}',
  '⚠️ This session stayed disconnected for 24 hours, so KiroLex gave up delivering this message to the model: {text}': '⚠️ 这条会话 24 小时都没连上，KiroLex 放弃了，这条没有发给模型：{text}',
};
