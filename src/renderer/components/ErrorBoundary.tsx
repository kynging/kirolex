import React from 'react';

interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Renderer crash caught by ErrorBoundary:', error, info);
    /*
      热更新之后重试**一次还是同一个错**：多半不是代码没改好，而是热替换把新旧模块拼在了一起
      （实测一次：App 已经是新的、useAcp 还是旧的，`takeOrphanSteers is not a function`）。
      那种只有整页重载才对得上 —— 会话在主进程里照常跑，页面从磁盘重新水化，所以重载不丢东西。
      判据放在这里而不是下一次热更新：重试那一下立刻又崩的话，可能再也等不到下一次更新了。
    */
    if ((import.meta as any).hot && this.retriedFor !== null && this.retriedFor === String(error?.message || error)) {
      window.location.reload();
    }
  }

  /**
   * **改完代码自己恢复** ——「如果因为正在修改代码导致 UI 报错，会话能继续直到改完恢复吗」。
   *
   * 会话本身跑在主进程里，界面崩了它照样跑完、照样写盘；缺的是界面这一头：崩到这一页之后，
   * 就算代码已经改好、Vite 也已经热更新了，这里仍然停在报错上，等人点「Reload」。而在
   * KiroLex 里改 KiroLex 的时候，改坏它的正是一条会话 —— 没有人在旁边点。
   *
   * 所以 dev 下每次热更新落地都清掉错误、重新渲染一次：改好了就回来了（App 重新挂载，
   * 会话从磁盘重新水化），还没改好就再崩一次、继续停在这页等下一次更新。
   */
  private offHmr?: () => void;
  /** 上一次热更新重试时的那个错误；重试后又是它 = 模块拼错了，整页重载（见 componentDidCatch）。 */
  private retriedFor: string | null = null;

  componentDidMount() {
    const hot = (import.meta as any).hot;
    if (!hot) return;
    const retry = (): void => {
      if (!this.state.error) { this.retriedFor = null; return; }
      this.retriedFor = String(this.state.error.message || this.state.error);
      this.setState({ error: null });
    };
    hot.on('vite:afterUpdate', retry);
    this.offHmr = () => { try { hot.off?.('vite:afterUpdate', retry); } catch { /* 老版本 vite 没有 off */ } };
  }

  componentWillUnmount() { this.offHmr?.(); }

  render() {
    if (!this.state.error) return this.props.children;
    const { error } = this.state;
    return (
      <div className="error-boundary">
        <h2>Something broke in the UI</h2>
        <p>KiroLex caught a rendering error instead of leaving a blank window.</p>
        <pre>{error.message}{'\n'}{error.stack}</pre>
        <div className="error-boundary-actions">
          <button className="btn allow" onClick={() => window.location.reload()}>Reload</button>
          <button className="btn deny" onClick={() => this.setState({ error: null })}>Try to continue</button>
        </div>
      </div>
    );
  }
}
