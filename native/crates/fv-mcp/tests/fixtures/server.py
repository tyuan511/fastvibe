"""A real line-framed MCP peer for integration tests. stdout is protocol only."""
import base64
import json
import os
import sys
import threading
import time

lock = threading.Lock()
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ZkAAAAASUVORK5CYII="

def send(value):
    with lock:
        print(json.dumps(value), flush=True)

def record(name, text):
    path = os.environ.get(name)
    if path:
        with open(path, "a") as f:
            f.write(str(text) + "\n")

record("START_LOG", os.getpid())
print("fixture stderr ready", file=sys.stderr, flush=True)
if os.environ.get("DIAGNOSTIC_BURST"):
    print("洪" * 20000 + "\ncredential=" + os.environ.get("FIXTURE_CREDENTIAL", "") + "\nTAIL_MARKER", file=sys.stderr, flush=True)
catalog = ["echo", "image", "failure", "large", "slow", "exit", "environment"]
for line in sys.stdin:
    frame = json.loads(line)
    method = frame.get("method")
    params = frame.get("params") or {}
    request_id = frame.get("id")
    if request_id is None:
        if method == "notifications/cancelled":
            record("CANCEL_LOG", params.get("requestId"))
        continue
    result = None
    if method == "initialize":
        time.sleep(float(os.environ.get("INIT_DELAY", "0")))
        if os.environ.get("FAIL_INIT"):
            print("fixture cannot initialize", file=sys.stderr, flush=True)
            os._exit(1)
        result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {"listChanged": True}, "resources": {}}, "serverInfo": {"name": "fixture", "version": "1"}, "instructions": "Use the fixture tools for testing."}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [n if isinstance(n, dict) else {"name": n, "description": n + " fixture tool", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}} for n in catalog]}
    elif method == "tools/call":
        name = params["name"]
        arguments = params.get("arguments") or {}
        if arguments.get("text") == "refresh-tools":
            with open(os.environ["CATALOG_FILE"]) as f:
                catalog = json.load(f)
            for _ in range(10):
                send({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
        if name == "exit":
            print("fixture exiting", file=sys.stderr, flush=True)
            os._exit(0)
        if name == "slow":
            record("CALL_LOG", request_id)
            continue
        if name == "image":
            data = base64.b64encode(b"x" * (9 * 1024 * 1024)).decode() if arguments.get("text") == "large-image" else PNG
            count = 10 if arguments.get("text") == "many-images" else 1
            result = {"content": [{"type": "image", "data": data, "mimeType": "image/png"}] * count + [{"type": "text", "text": "one pixel"}]}
        elif name == "failure":
            result = {"isError": True, "content": [{"type": "text", "text": "fixture error"}]}
        elif name == "environment":
            result = {"content": [{"type": "text", "text": json.dumps(dict(os.environ))}]}
        else:
            text = "大" * 40000 + "THE_END" if name == "large" else arguments.get("text", "echo")
            result = {"content": [{"type": "text", "text": text}], "structuredContent": {"pid": os.getpid(), "echo": text}}
    elif method == "resources/list":
        if params.get("cursor"):
            result = {"resources": [{"uri": "fixture://second", "name": "second"}]}
        else:
            result = {"resources": [{"uri": "fixture://first", "name": "first"}], "nextCursor": "second"}
    elif method == "resources/templates/list":
        result = {"resourceTemplates": [{"uriTemplate": "fixture://{name}", "name": "fixture"}]}
    elif method == "resources/read":
        uri = params["uri"]
        if uri == "fixture://slow":
            record("READ_LOG", request_id)
            continue
        result = {"contents": [{"uri": uri, "text": "resource " + uri, "mimeType": "text/plain"}]}
    if result is None:
        send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "unknown method"}})
    else:
        send({"jsonrpc": "2.0", "id": request_id, "result": result})
