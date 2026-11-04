# iroh relay node lists

Control's `POST /api/relay/iroh/token` returns every configured relay in `relays`:

```json
{
  "relays": [
    {"relay_id": "hk1", "url": "https://relay-hk1.fastvibe.dev:8444", "quic_port": 7842, "token": "<hk1 credential>"},
    {"relay_id": "us01", "url": "https://relay-us01.fastvibe.dev:8444", "quic_port": 7842, "token": "<us01 credential>"},
    {"relay_id": "us02", "url": "https://relay-us02.fastvibe.dev:8444", "quic_port": 7842, "token": "<us02 credential>"}
  ],
  "relay_id": "hk1",
  "url": "https://relay-hk1.fastvibe.dev:8444",
  "quic_port": 7842,
  "token": "<hk1 credential>",
  "expires_at": "<shared expiry>",
  "usage": "<shared account allowance>"
}
```

The sample abbreviates `usage`; its existing object shape is unchanged. Every node has its own credential bound to the same account, device and endpoint, with the node's relay ID. Expiry and account usage are shared. The top-level node fields mirror the first entry only for older clients; they do not define a preferred node for clients that support `relays`.

`src/shared/iroh-relay.ts` validates the complete list. A response without `relays` is an older single-node response; an explicitly empty or malformed list is an error. `IrohSidecar` forwards all entries on start, refresh and connect. The native sidecar and mobile Rust core configure all nodes in `RelayMap`, including each QUIC discovery port, and add every relay URL to the peer's `EndpointAddr`. Iroh selects its home relay and races initial packets over the known peer paths. Passing only one peer URL would reintroduce the single-node dependency even with a full local map.

Refreshing the sidecar adds the current list and removes withdrawn node configurations. Node IDs are not hardcoded as a blacklist: operators change the catalog in the services repository. Its `services/cloud/deploy/prod/iroh.example.yaml` is copied to production by `deploy.yml`; update that versioned catalog when changing the live node list, so a subsequent deployment preserves the intended configuration.

Verification:

- `test/iroh-relay-config.test.ts` covers old/new Control responses, malformed lists and the actual sidecar command pipe.
- Native Rust unit tests cover credentials, ports and every peer candidate.
- `test/mobile-protocol.integration.test.ts` exercises both legacy single-node mode and an unavailable first relay with a healthy second relay, through the real C ABI, native sidecar and desktop AppServer.
- The mobile relay-only test can additionally run with `FASTVIBE_TEST_RELAY_BIN` pointing to the local relay fixture built by `scripts/test-mobile-protocol.mjs`.

The Go implementation and its protocol tests live in the separate `fastvibe-services` repository. Deploying Control does not update installed desktop or mobile binaries; older clients continue using the compatibility fields until upgraded.
