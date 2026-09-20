import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RemoteSyncProvider } from './hooks/useRemoteSync';
import './styles/global.css';

/*
  这里原来按 `?view=run` 分出第二个视图（运行画布的独立窗口，`RunWindow`）。
  flow 那一整套移到 feature/flow 之后这个分支没有去处了，所以只剩一个入口。
*/
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {/* 远程会话的同步状态（按 sessionId 索引，全局一份）—— 见 `useRemoteSync` */}
      <RemoteSyncProvider>
        <App />
      </RemoteSyncProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
