// node cdp_click_text.mjs <url> <out.png> <settleMs> <buttonText> [postWaitMs]
import { writeFileSync } from 'node:fs';
const [url, out, settleMs = '5000', text, postWait = '2500'] = process.argv.slice(2);
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
await send('Page.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
if (url !== 'same') await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(settleMs)));
if (text !== 'none') {
  const clicked = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('button,[role=button]')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`,
  });
  console.log('clicked:', JSON.stringify(clicked.result));
  await new Promise((r) => setTimeout(r, Number(postWait)));
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
process.exit(0);
