import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { settleInFlightAttach } from '../src/main/attachGate.ts';
import { firstWantedModel, remoteStartCandidates } from '../src/main/modelAvailability.ts';

/*
 * 「远程会话里冒出『本机 kiro-cli 的模型清单里没有 claude-opus…』，模型换成了 GPT」
 *
 * 证据情况（如实写）：出事那台机器的 ~/.kirolex 日志和会话记录不在这里 —— 能看到的只有这台构建机
 * 自己测试跑出来的日志，里面搜不到这句提示、也没有 'pickRemoteModel' / '切换目标' / '本机 kiro-cli 的清单里没有'。
 * 所以下面是**按代码推理**定下来的，逐个排除：
 *
 * - (c) 提示写错会话 id：`connectWithModelFallback` 的 `sessionNotice(sessionId, …)` 用的就是调用方那条会话的 id，排除。
 * - (d) 别的路线构造 profile 时漏了 remote：new-session（`findRemoteTarget(remoteId)`）、attach（`existing.profile.remote`）、
 *   switch-engine / switch-mcp-combo / switch-model（都是 `{ ...oldEntry.profile }`）、swapSessionModel（`entry.profile`）
 *   全都带着 remote，排除。
 * - (b) 当时确实是本地会话、后来切到远端：本身是正常情况。本地那条路只改 `model`、不动 `preferredModel`，
 *   切过去时 `firstWantedModel` 先拿偏好 → 回到 Claude（下面最后一个测试钉住）。
 * - (a) **证实存在的竞争**：一条没连着的会话正在 attach（启动时的 eager attach / 点开 / 发消息触发的按需连接），
 *   attach 一开头就读了记录（那时还没有 remote）→ 按本机起执行器（本机清单检查、提示、换 GPT 都在这段几秒到几十秒里）。
 *   这期间右键「运行位置 → 远端」：`applySessionTarget` 看 `sessionClients` 里还没有这条 → 走「没连着」分支，
 *   **只改记录、不等那次 attach**，然后发 `session:targets-changed`，渲染层按新记录重连 ——
 *   可主进程里 `attachInFlight` 把这次重连并进了那个本机的 attach。结果：徽标、记录都写着远端，
 *   执行器却是本机的、跑 GPT，会话里留着那句本机清单的提示。
 *
 * 修：`applySessionTarget` 先等正在进行的 attach 落定，再决定走哪条分支 —— attach 连上了就走「已连着」那条：
 * 换执行器、按远端清单 `pickRemoteModel`、偏好还在 → 回到用户选的 Claude。
 */
describe('切换运行位置时有 attach 在飞：先等它落定，不让本机执行器顶着远端徽标跑', () => {
  test('等到 attach 落定才返回；attach 失败也不往外抛', async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    let settled = false;
    inFlight.set('s_1', new Promise((r) => setTimeout(() => { settled = true; r(undefined); }, 30)));
    await settleInFlightAttach(inFlight, 's_1');
    assert.equal(settled, true);

    inFlight.set('s_2', Promise.reject(new Error('本机 kiro 没配')));
    await settleInFlightAttach(inFlight, 's_2');
    await settleInFlightAttach(inFlight, 's_none');
  });

  test('等完一个又来一个（渲染层重试），也一起等；但不无限等下去', async () => {
    const inFlight = new Map<string, Promise<unknown>>();
    let rounds = 0;
    const start = (): void => {
      rounds += 1;
      const p = new Promise((r) => setTimeout(r, 5)).then(() => {
        inFlight.delete('s_1');
        if (rounds < 10) start();        // 每次落定立刻又来一个（停在 10 轮，免得测试进程退不出去）
      });
      inFlight.set('s_1', p);
    };
    start();
    await settleInFlightAttach(inFlight, 's_1');
    assert.ok(rounds >= 2 && rounds <= 5, `等了 ${rounds} 轮`);
  });

  /*
   * 复现那条路线：attach 读记录 → 起执行器（本机按本机清单判断）→ 期间切换目标。
   * `retarget` 是 `applySessionTarget` 的骨架：先等 attach（修复）→ 有执行器就换执行器、按远端清单挑模型；没有就只改记录。
   */
  const ORDER = ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'];
  const LOCAL_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2'];          // 本机：出口 IP 地域过滤，Claude 全没了
  const REMOTE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'auto'];
  type Profile = { model: string; preferredModel?: string; modelEarnedOn?: string; remote?: { sshHost: string } };
  const scenario = (opts: { waitForAttach: boolean }) => {
    const record: { profile: Profile } = { profile: { model: 'claude-opus-5', preferredModel: 'claude-opus-5' } };
    const notices: string[] = [];
    const entries = new Map<string, { profile: Profile }>();
    const inFlight = new Map<string, Promise<unknown>>();
    const machine = (p: Profile) => p.remote?.sshHost || 'local';
    const attach = (id: string) => {
      const existing = inFlight.get(id);
      if (existing) return existing;
      const profile: Profile = { ...record.profile };                            // attach 一开头读记录
      const p = (async () => {
        await new Promise((r) => setTimeout(r, 20));                             // 起执行器要时间
        let model = firstWantedModel(profile, machine(profile), ORDER);
        if (!profile.remote?.sshHost && !LOCAL_MODELS.includes(model)) {
          notices.push(`⚠️ 本机 kiro-cli 的模型清单里没有「${model}」`);
          model = ORDER.find((m) => LOCAL_MODELS.includes(m))!;
        }
        if (profile.remote?.sshHost) model = remoteStartCandidates([model], REMOTE_MODELS, ORDER)[0];
        entries.set(id, { profile: { ...profile, model } });
        record.profile = { ...record.profile, model, modelEarnedOn: machine(profile) };
      })().finally(() => inFlight.delete(id));
      inFlight.set(id, p);
      return p;
    };
    const retarget = async (id: string, sshHost: string) => {
      if (opts.waitForAttach) await settleInFlightAttach(inFlight, id);
      const old = entries.get(id);
      if (!old) {
        record.profile = { ...record.profile, remote: { sshHost } };
        await attach(id);                                                         // reconnectAfterRetarget
        return;
      }
      const profile: Profile = { ...old.profile, remote: { sshHost } };
      const wanted = firstWantedModel(profile, machine(profile), ORDER);
      profile.model = REMOTE_MODELS.includes(wanted) ? wanted : ORDER.find((m) => REMOTE_MODELS.includes(m))!;
      entries.set(id, { profile });
      record.profile = profile;
    };
    return { record, notices, entries, attach, retarget };
  };

  test('不等 attach（修复前）：记录写着远端，执行器却在本机跑 GPT —— 正是用户看到的那个', async () => {
    const s = scenario({ waitForAttach: false });
    void s.attach('s_x');
    await s.retarget('s_x', 'tokyo');
    const live = s.entries.get('s_x')!.profile;
    assert.equal(s.record.profile.remote?.sshHost, 'tokyo');
    assert.equal(live.remote, undefined);
    assert.equal(live.model, 'gpt-5.6-sol');
  });

  test('先等 attach（修复后）：切过去之后执行器在远端、模型回到偏好的 Claude，偏好没被改', async () => {
    const s = scenario({ waitForAttach: true });
    void s.attach('s_x');
    await s.retarget('s_x', 'tokyo');
    const live = s.entries.get('s_x')!.profile;
    assert.equal(live.remote?.sshHost, 'tokyo');
    assert.equal(live.model, 'claude-opus-5');
    assert.equal(live.preferredModel, 'claude-opus-5');
    assert.equal(s.record.profile.model, 'claude-opus-5');
  });

  test('applySessionTarget 在看 sessionClients 之前先等 attach 落定（公共挂载锁）', () => {
    const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = MAIN.indexOf('const applySessionTarget = async (');
    assert.ok(at > 0);
    const head = MAIN.slice(at, MAIN.indexOf('const oldEntry = sessionClients.get(sessionId);', at));
    /* 等的是公共的挂载锁，attachInFlight 是它的来源之一（见 tests/mountLock.test.ts） */
    assert.match(head, /await mountLock\.settle\(sessionId\);/);
    assert.match(MAIN, /const mountLock = new SessionMountLock\(\[\s*\(sid\) => attachInFlight\.get\(sid\),/);
    assert.match(MAIN, /import \{ SessionMountLock[^}]*\} from '\.\/attachGate\.ts';/);
  });

  /*
   * 另一条走到 GPT 的路：本机那一轮报「claude-opus-5 is not available」→ swapSessionModel 换成 GPT。
   * 上一版这里把 preferredModel 清掉，于是切到有 Claude 的远端时 firstWantedModel 只能拿兜底链头上的 GPT。
   * 直接取 index.ts 里 swapSessionModel 算新 profile 的那个表达式来跑，不另抄一份。
   */
  test('本机一轮报模型不可用 → 降级成 GPT → 切到有 Claude 的远端：回到用户选的 Claude', () => {
    const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const at = MAIN.indexOf('async function swapSessionModel(');
    const m = /const profile: AgentProfile = (stillListed\n[\s\S]*?);\n/.exec(MAIN.slice(at));
    assert.ok(m, '找不到 swapSessionModel 里算新 profile 的那一句');
    const swapProfile = new Function('entry', 'model', 'stillListed', 'machineKeyOf', `return (${m[1]});`) as
      (entry: { profile: Profile }, model: string, stillListed: boolean, machineKeyOf: (p: Profile) => string) => Profile;
    const machineKeyOf = (p: Profile) => p.remote?.sshHost || 'local';
    const local: Profile = { model: 'claude-opus-5', preferredModel: 'claude-opus-5' };
    /* 本机清单里没有 Claude → stillListed = false（真跑不了） */
    const degraded = swapProfile({ profile: local }, 'gpt-5.6-sol', false, machineKeyOf);
    assert.equal(degraded.model, 'gpt-5.6-sol');
    assert.equal(degraded.modelEarnedOn, 'local');
    assert.equal(degraded.preferredModel, 'claude-opus-5', '偏好不能因为本机没有 Claude 就丢掉');
    /* 切到远端：applySessionTarget 的 `{ ...oldEntry.profile, remote }` → pickRemoteModel(firstWantedModel(...)) */
    const onRemote: Profile = { ...degraded, remote: { sshHost: 'tokyo' } };
    const wanted = firstWantedModel(onRemote, machineKeyOf(onRemote), ORDER);
    assert.equal(wanted, 'claude-opus-5');
    assert.ok(REMOTE_MODELS.includes(wanted));
  });

  test('(b) 在本机被降级成 GPT 的会话，换到远端时先拿偏好的 Claude，而不是记录里那个 GPT', () => {
    const degradedLocally = { model: 'gpt-5.6-sol', preferredModel: 'claude-opus-5', modelEarnedOn: 'local' };
    assert.equal(firstWantedModel(degradedLocally, 'tokyo', ORDER), 'claude-opus-5');
    assert.deepEqual(remoteStartCandidates(['claude-opus-5', 'gpt-5.6-sol'], REMOTE_MODELS, ORDER)[0], 'claude-opus-5');
  });
});
