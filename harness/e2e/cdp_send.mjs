// node cdp_send.mjs <message> <out.png> <waitMs>
import { writeFileSync } from 'node:fs';
const [message, out, waitMs = '15000'] = process.argv.slice(2);
const list = await fetch('http://127.0.0.1:9222/json/list').then((r) => r.json());
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');
const typed = await send('Runtime.evaluate', { expression: `
(() => {
  const el = document.querySelector('[contenteditable=true]') || document.querySelector('textarea');
  if (!el) return 'no-composer';
  el.focus();
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(message)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('insertText', false, ${JSON.stringify(message)});
  }
  return 'typed:' + (el.tagName === 'TEXTAREA' ? el.value : el.textContent);
})()` });
console.log(JSON.stringify(typed.result));
await new Promise((r) => setTimeout(r, 800));
const clicked = await send('Runtime.evaluate', { expression: `
(() => {
  const btn = document.querySelector('.send-button, [aria-label*=Send i], button[type=submit]');
  if (!btn) return 'no-send-button';
  btn.click();
  return 'sent';
})()` });
console.log(JSON.stringify(clicked.result));
await new Promise((r) => setTimeout(r, Number(waitMs)));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
process.exit(0);
