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
};
