import { render } from 'preact';
import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './hljs.css';
import { App } from './components/App';
import { init } from './lib/state';

render(<App />, document.getElementById('app')!);
init().catch((e) => {
  console.error(e);
  document.getElementById('app')!.innerHTML = `<div style="padding:40px;font:14px system-ui;color:#f85149">Falha ao iniciar: ${String(e?.message ?? e)}</div>`;
});

if ('serviceWorker' in navigator && location.protocol === 'http:' && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
