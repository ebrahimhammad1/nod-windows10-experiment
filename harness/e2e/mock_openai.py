import json
from http.server import BaseHTTPRequestHandler, HTTPServer

def sse(obj):
    return f"data: {json.dumps(obj)}\n\n".encode()

def chunk(delta, finish=None, usage=None):
    c = {"id": "cmpl-1", "object": "chat.completion.chunk", "created": 1, "model": "fixture-pro-1",
         "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage: c["usage"] = usage
    return c

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.endswith('/api/version'):
            self._json({"version": "0.0.0-fixture"})
        elif self.path.endswith('/models'):
            self._json({"object": "list", "data": [
                {"id": "fixture-pro-1", "object": "model", "context_window": 32768}]})
        else:
            self._json({"error": "not found"}, 404)
    def do_POST(self):
        if self.path.endswith('/api/show'):
            length = int(self.headers.get('Content-Length', 0))
            self.rfile.read(length)
            self._json({
                "capabilities": ["completion", "thinking", "tools"],
                "model_info": {"fixture.context_length": 32768},
                "parameters": "",
                "thinking": {"values": [False, "low", "high"]},
            })
            return
        if not self.path.endswith('/chat/completions'):
            self._json({"error": "not found"}, 404)
            return
        length = int(self.headers.get('Content-Length', 0))
        req = json.loads(self.rfile.read(length) or b'{}')
        with open('/tmp/mock-requests.jsonl', 'a') as f:
            f.write(json.dumps(req) + '\n')
        messages = req.get('messages', [])
        tools = req.get('tools') or []
        user_texts = []
        for m in messages:
            if m.get('role') != 'user':
                continue
            c = m.get('content', '')
            user_texts.append(c if isinstance(c, str) else json.dumps(c))
        text = '\n'.join(user_texts)
        has_tool_result = bool(messages) and messages[-1].get('role') == 'tool'
        # Tool leg: on 'weather' with tools offered and no tool result yet, call the
        # first tool whose schema has no required parameters, with {}.
        if tools and 'weather' in text.lower() and not has_tool_result:
            target = None
            for t in tools:
                fn = t.get('function', {})
                params = fn.get('parameters') or {}
                if not params.get('required'):
                    target = fn.get('name')
                    break
            args = "{}"
            if target is None:
                for t in tools:
                    fn = t.get('function', {})
                    req = (fn.get('parameters') or {}).get('required') or []
                    if fn.get('name') == 'read' and 'path' in req:
                        target = 'read'
                        args = "{\"path\": \"/etc/hostname\"}"
                        break
            if target is None:
                target = tools[0].get('function', {}).get('name', 'unknown')
            chunks = [
                chunk({"role": "assistant", "content": None, "tool_calls": [
                    {"index": 0, "id": "call_1", "type": "function",
                     "function": {"name": target, "arguments": args}}]}),
                chunk({}, 'tool_calls', {"prompt_tokens": 60, "completion_tokens": 15, "total_tokens": 75}),
            ]
        else:
            if has_tool_result:
                tool_msg = next(m for m in reversed(messages) if m.get('role') == 'tool')
                answer = "Tool outcome received: " + str(tool_msg.get('content'))[:120]
            else:
                answer = "Mock provider reply: " + text[:80]
            chunks = [
                chunk({"role": "assistant", "content": answer}),
                chunk({}, 'stop', {"prompt_tokens": 50, "completion_tokens": 10, "total_tokens": 60}),
            ]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        for c in chunks:
            self.wfile.write(sse(c))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

HTTPServer(('127.0.0.1', 4399), H).serve_forever()
