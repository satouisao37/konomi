"""Python stdlib だけで headless Chrome を CDP 駆動する UI 検証ハーネス(共通ノウハウ 2026-07-29 の再利用)。
使い方: python3 tools/cdp.py <URL> <出力dir> <ステップJSON>
ステップ: {"wait": 秒} / {"eval": "式"} / {"shot": "ファイル名.png"} / {"cdp": ["メソッド", {パラメータ}]}
"""
import base64, json, os, secrets, signal, socket, struct, subprocess, sys, tempfile, time, urllib.request

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT = 9333


class WS:
    def __init__(self, url):
        rest = url.split("://", 1)[1]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.sock = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        self.sock.sendall((f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("handshake 切断")
            response += chunk
        if b" 101 " not in response.split(b"\r\n", 1)[0]:
            raise RuntimeError("handshake 失敗")
        self.buffer = response.split(b"\r\n\r\n", 1)[1]
        self.msg_id = 0

    def _recv_exact(self, n):
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("切断")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def send_text(self, payload):
        data = payload.encode()
        mask = secrets.token_bytes(4)
        length = len(data)
        header = b"\x81"
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", length)
        self.sock.sendall(header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv_message(self):
        parts = []
        while True:
            b1, b2 = self._recv_exact(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            payload = self._recv_exact(length)
            if opcode == 0x9:  # ping → pong
                mask = secrets.token_bytes(4)
                self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask +
                                  bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
                continue
            if opcode == 0x8:
                raise RuntimeError("close 受信")
            parts.append(payload)
            if fin:
                return b"".join(parts).decode("utf-8", errors="replace")

    def call(self, method, params=None, timeout=30, events=None):
        self.msg_id += 1
        want = self.msg_id
        self.send_text(json.dumps({"id": want, "method": method, "params": params or {}}))
        deadline = time.monotonic() + timeout
        self.sock.settimeout(timeout)
        while time.monotonic() < deadline:
            message = json.loads(self.recv_message())
            if message.get("id") == want:
                if "error" in message:
                    raise RuntimeError(f"CDP エラー {method}: {message['error']}")
                return message.get("result", {})
            if events is not None and "method" in message:
                events.append(message)
        raise RuntimeError(f"応答待ちタイムアウト: {method}")


def main():
    url, outdir, steps_path = sys.argv[1], sys.argv[2], sys.argv[3]
    steps = json.loads(open(steps_path, encoding="utf-8").read())
    os.makedirs(outdir, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="cdp-profile-")
    chrome = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
                               f"--user-data-dir={profile}", "--no-first-run", "--window-size=500,950",
                               "--hide-scrollbars", "about:blank"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    events = []
    try:
        target = None
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json", timeout=2) as res:
                    targets = json.loads(res.read())
                target = next((t for t in targets if t.get("type") == "page"), None)
                if target:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        if not target:
            raise RuntimeError("CDP ターゲットなし")
        ws = WS(target["webSocketDebuggerUrl"])
        ws.call("Runtime.enable", events=events)
        ws.call("Log.enable", events=events)
        ws.call("Page.enable", events=events)
        ws.call("Page.navigate", {"url": url}, events=events)
        for step in steps:
            if "wait" in step:
                until = time.monotonic() + step["wait"]
                while time.monotonic() < until:
                    time.sleep(min(0.5, max(0.05, until - time.monotonic())))
                    ws.call("Runtime.evaluate", {"expression": "0"}, events=events)  # イベント回収を兼ねる
            elif "cdp" in step:
                ws.call(step["cdp"][0], step["cdp"][1], events=events)
            elif "eval" in step:
                result = ws.call("Runtime.evaluate", {"expression": step["eval"], "returnByValue": True}, events=events)
                if result.get("exceptionDetails"):
                    print("eval例外:", json.dumps(result["exceptionDetails"], ensure_ascii=False)[:400])
                else:
                    print("eval:", json.dumps(result.get("result", {}).get("value"), ensure_ascii=False)[:500])
            elif "shot" in step:
                shot = ws.call("Page.captureScreenshot", {"format": "png"}, timeout=60, events=events)
                with open(os.path.join(outdir, step["shot"]), "wb") as file:
                    file.write(base64.b64decode(shot["data"]))
                print("shot:", step["shot"])
        with open(os.path.join(outdir, "console.jsonl"), "w", encoding="utf-8") as file:
            for event in events:
                if event.get("method") in ("Runtime.exceptionThrown", "Log.entryAdded", "Runtime.consoleAPICalled"):
                    file.write(json.dumps(event, ensure_ascii=False) + "\n")
    finally:
        chrome.send_signal(signal.SIGTERM)
        try:
            chrome.wait(timeout=5)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    main()
