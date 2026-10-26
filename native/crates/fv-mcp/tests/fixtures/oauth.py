"""Local OAuth AS + protected MCP resource. No browser or external account."""
import base64
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

root = sys.argv[1]
lock = threading.Lock()
codes = {}
access = set()
refresh = set()
serial = 0
origin = None


def record(value):
    with lock:
        with open(os.path.join(root, "requests.jsonl"), "a") as f:
            f.write(json.dumps(value) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            # A canceled SDK request or a retired connection is expected to close early.
            pass

    def reply(self, status, value=None, headers=None):
        body = b"" if value is None else json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def challenge(self, path):
        self.reply(401, {"error": "unauthorized"}, {"WWW-Authenticate": 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource' + path + '", scope="tools"'})

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/.well-known") and os.path.exists(os.path.join(root, "metadata-delay")):
            open(os.path.join(root, "metadata-started"), "w").close()
            time.sleep(1)
        if parsed.path.startswith("/.well-known/oauth-protected-resource"):
            path = parsed.path[len("/.well-known/oauth-protected-resource"):]
            return self.reply(200, {"resource": origin + (path or "/mcp"), "authorization_servers": [origin], "scopes_supported": ["tools"]})
        if parsed.path == "/.well-known/oauth-authorization-server":
            return self.reply(200, {"issuer": origin, "authorization_endpoint": origin + "/authorize", "token_endpoint": origin + "/token", "registration_endpoint": origin + "/register", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["client_secret_post"], "scopes_supported": ["tools", "offline_access"], "authorization_response_iss_parameter_supported": True})
        if parsed.path == "/authorize":
            args = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            if args.get("code_challenge_method") != "S256" or args.get("resource") != origin + "/mcp":
                return self.reply(400, {"error": "bad_authorization_request"})
            code = "code-" + str(len(codes))
            codes[code] = args
            callback = args["redirect_uri"] + "?" + urlencode({"state": args["state"], "code": code, "iss": origin})
            record({"method": "authorize", "pkce": True, "scope": args.get("scope")})
            return self.reply(302, headers={"Location": callback})
        if parsed.path.endswith("mcp"):
            if self.headers.get("Authorization", "").removeprefix("Bearer ") in access:
                return self.reply(405)
            return self.challenge(parsed.path)
        self.reply(404)

    def do_POST(self):
        global serial
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        path = urlsplit(self.path).path
        if path == "/register":
            value = json.loads(body)
            record({"method": "register", "redirect_uris": value["redirect_uris"]})
            return self.reply(201, {"client_id": "fixture-client", "client_secret": "fixture-client-secret", "redirect_uris": value["redirect_uris"], "client_name": "FastVibe"})
        if path == "/token":
            args = {k: v[0] for k, v in parse_qs(body.decode()).items()}
            grant = args.get("grant_type")
            record({"method": "token", "grant": grant, "client_secret_ok": args.get("client_secret") == "fixture-client-secret", "resource": args.get("resource")})
            if args.get("client_id") != "fixture-client" or args.get("client_secret") != "fixture-client-secret":
                return self.reply(400, {"error": "invalid_client"})
            if grant == "authorization_code":
                if os.path.exists(os.path.join(root, "token-delay")):
                    open(os.path.join(root, "token-started"), "w").close()
                    time.sleep(0.4)
                source = codes.pop(args.get("code"), None)
                challenge = base64.urlsafe_b64encode(hashlib.sha256(args.get("code_verifier", "").encode()).digest()).decode().rstrip("=")
                if not source or challenge != source["code_challenge"] or args.get("redirect_uri") != source["redirect_uri"]:
                    return self.reply(400, {"error": "invalid_grant"})
            elif grant == "refresh_token":
                if os.path.exists(os.path.join(root, "refresh-delay")):
                    open(os.path.join(root, "refresh-started"), "w").close()
                    time.sleep(0.4)
                if os.path.exists(os.path.join(root, "reject-refresh")):
                    return self.reply(400, {"error": "invalid_grant"})
                if os.path.exists(os.path.join(root, "fail-refresh")):
                    return self.reply(503, {"error": "temporarily_unavailable"})
                if args.get("refresh_token") not in refresh:
                    return self.reply(400, {"error": "invalid_grant"})
            else:
                return self.reply(400, {"error": "unsupported_grant_type"})
            with lock:
                serial += 1
                token = "access-" + str(serial)
                refresh_token = "refresh-" + str(serial)
                access.add(token)
                refresh.add(refresh_token)
            return self.reply(200, {"access_token": token, "refresh_token": refresh_token, "token_type": "Bearer", "expires_in": 3600, "scope": "tools offline_access"})
        if path.endswith("mcp"):
            token = self.headers.get("Authorization", "")
            value = json.loads(body)
            record({"method": value.get("method"), "path": path, "token": token})
            if token.removeprefix("Bearer ") not in access or os.path.exists(os.path.join(root, "reject-access")):
                return self.challenge(path)
            method = value.get("method")
            if "id" not in value:
                return self.reply(202)
            result = None
            if method == "initialize":
                result = {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "oauth-fixture", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [{"name": "echo", "description": "authorized tool", "inputSchema": {"type": "object"}}]}
            elif method == "tools/call":
                result = {"content": [{"type": "text", "text": "authorized tool result"}]}
            elif method == "ping":
                result = {}
            if result is None:
                return self.reply(200, {"jsonrpc": "2.0", "id": value["id"], "error": {"code": -32601, "message": "unknown method"}})
            return self.reply(200, {"jsonrpc": "2.0", "id": value["id"], "result": result})
        self.reply(404)


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
origin = "http://127.0.0.1:" + str(server.server_address[1])
print(origin, flush=True)
server.serve_forever()
