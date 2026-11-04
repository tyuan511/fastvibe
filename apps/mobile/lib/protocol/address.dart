/// A FastVibe remote address, whether it came from a tunnel QR code or the LAN
/// line in 设置 → 远程访问.
///
/// The settings pane copies a LAN address as `192.168.x.x:7777` — no scheme.
/// A tunnel QR is a full `https://` URL. Both have to become one origin.
///
/// Address normalization retains the existing protocol behavior: the RFC 6874 IPv6 zone form is carried through to the socket untouched, and
/// a bare IP literal is always plain http (a global IPv6 LAN address has no certificate
/// to offer, and reading it as public made every connection try TLS against the plain
/// listener).
library;

enum AddressKind {
  lan,
  public,
  loopback,

  /// A computer on the signed-in FastVibe account, reached through the account rather than
  /// by address (`fastvibe-official://<device id>`). Never produced by parsing an address.
  official,
}

class ServerAddress {
  const ServerAddress({
    required this.origin,
    required this.wsUrl,
    required this.host,
    required this.kind,
  });

  /// `http(s)://host[:port]`, no path, no trailing slash.
  final String origin;
  final String wsUrl;

  /// What the list shows: `192.168.31.45:7777` or `foo.trycloudflare.com`.
  final String host;
  final AddressKind kind;

  @override
  bool operator ==(Object other) =>
      other is ServerAddress && other.origin == origin;

  @override
  int get hashCode => origin.hashCode;
}

/// QR metadata is a suggested label, never part of the connection origin or login.
class ScannedServerAddress {
  const ScannedServerAddress({required this.address, this.name});

  final ServerAddress address;
  final String? name;
}

/// New QR codes carry `?name=…`; older codes remain plain addresses.
ScannedServerAddress? parseServerQr(String raw) {
  final address = parseServerAddress(raw);
  if (address == null) return null;
  String? name;
  // Parse only the query, leaving encoded IPv6 interface zones to the address parser.
  final base = raw
      .trim()
      .replaceAll(RegExp(r'''^['"]+|['"]+$'''), '')
      .split('#')
      .first;
  final query = base.indexOf('?');
  if (query >= 0) {
    try {
      final label = Uri.splitQueryString(
        base.substring(query + 1),
      )['name']?.trim();
      if (label != null &&
          label.isNotEmpty &&
          !RegExp(r'[\x00-\x1f\x7f]').hasMatch(label)) {
        name = label;
      }
    } on FormatException {
      // A malformed optional label must not make an otherwise usable address fail.
    } on ArgumentError {
      // Uri's percent-decoder uses ArgumentError for malformed % escapes.
    }
  }
  return ScannedServerAddress(address: address, name: name);
}

const int defaultLanPort = 7777;

final RegExp _whitespace = RegExp(r'\s');
final RegExp _hasScheme = RegExp(
  r'^[a-z][a-z0-9+.-]*://',
  caseSensitive: false,
);
final RegExp _httpScheme = RegExp(r'^https?://', caseSensitive: false);
final RegExp _zoneForm = RegExp(
  r'^(https?)://\[([0-9a-f:.]+%25[a-z0-9_.-]+)\](?::(\d+))?(?:[/?#].*)?$',
  caseSensitive: false,
);
final RegExp _zoneSuffix = RegExp(r'%25[a-z0-9_.-]+$', caseSensitive: false);
final RegExp _hostChars = RegExp(r'^[a-z0-9.:_%_-]+$', caseSensitive: false);
final RegExp _ipv4 = RegExp(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$');
final RegExp _private10 = RegExp(r'^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$');
final RegExp _private192 = RegExp(r'^192\.168\.\d{1,3}\.\d{1,3}$');
final RegExp _private172 = RegExp(
  r'^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$',
);
final RegExp _private169 = RegExp(r'^169\.254\.\d{1,3}\.\d{1,3}$');
final RegExp _private100 = RegExp(
  r'^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$',
);

/// Returns null for anything that is not a host FastVibe could be listening on.
ServerAddress? parseServerAddress(String raw) {
  var input = raw.trim();
  input = input.replaceAll(RegExp(r'''^['"]+|['"]+$'''), '');
  if (input.isEmpty || _whitespace.hasMatch(input)) return null;

  final explicit =
      _httpScheme.hasMatch(input) ||
      input.startsWith('ws://') ||
      input.startsWith('wss://');
  var withScheme = input;
  if (input.startsWith('wss://')) {
    withScheme = 'https://${input.substring('wss://'.length)}';
  } else if (input.startsWith('ws://')) {
    withScheme = 'http://${input.substring('ws://'.length)}';
  } else if (_hasScheme.hasMatch(input)) {
    if (!_httpScheme.hasMatch(input)) return null;
  } else {
    withScheme = 'http://$input';
  }

  String protocol;
  String rawHostname;
  String rawPort;
  String userInfo = '';
  var parsed = false;
  try {
    final uri = Uri.parse(withScheme);
    protocol = '${uri.scheme}:';
    rawHostname = uri.host;
    rawPort = uri.hasPort ? '${uri.port}' : '';
    userInfo = uri.userInfo;
    parsed = true;
  } on FormatException {
    parsed = false;
    protocol = '';
    rawHostname = '';
    rawPort = '';
  }
  if (!parsed) {
    // Dart's URI parser rejects RFC 6874 link-local zones the same way WHATWG URL does
    // in some runtimes. The scanner still needs to carry the encoded `%25interface`
    // through to the socket, so accept that one bracketed IPv6 form explicitly.
    final zone = _zoneForm.firstMatch(withScheme);
    if (zone == null) return null;
    protocol = '${zone.group(1)!.toLowerCase()}:';
    rawHostname = zone.group(2)!;
    rawPort = zone.group(3) ?? '';
  }
  if (userInfo.isNotEmpty) return null;
  final hostname = rawHostname.replaceAll(RegExp(r'^\[|\]$'), '');
  if (hostname.isEmpty || !_isHost(hostname)) return null;

  final kind = _classify(hostname);
  final protocolForAddress = _inferProtocol(explicit, protocol, hostname, kind);
  final port = _resolvePort(rawPort, protocolForAddress, hostname, kind);
  if (port == null) return null;

  final host = _formatHost(hostname, port, protocolForAddress);
  final origin = '$protocolForAddress//$host';
  final wsUrl = '${protocolForAddress == 'https:' ? 'wss:' : 'ws:'}//$host/ws';
  return ServerAddress(origin: origin, wsUrl: wsUrl, host: host, kind: kind);
}

String _inferProtocol(
  bool explicit,
  String parsed,
  String hostname,
  AddressKind kind,
) {
  if (explicit) return parsed == 'https:' ? 'https:' : 'http:';
  // An IP literal has no certificate to offer, so a bare one is FastVibe's plain LAN
  // listener — including a global IPv6 address, which is what the LAN row shows (and
  // copies, with no scheme) when the machine is set to IPv6. Reading that as public
  // and trying TLS against the plain listener failed every connection. Tunnels hand
  // out hostnames, always with https:// in front.
  if (kind != AddressKind.public || _isIpLiteral(hostname)) return 'http:';
  return 'https:';
}

String? _resolvePort(
  String raw,
  String protocol,
  String hostname,
  AddressKind kind,
) {
  if (raw.isNotEmpty) {
    final port = int.tryParse(raw);
    if (port == null || port < 1 || port > 65535) return null;
    return '$port';
  }
  if (_isIpLiteral(hostname) || kind != AddressKind.public) {
    return protocol == 'https:' ? '443' : '$defaultLanPort';
  }
  return protocol == 'https:' ? '443' : '80';
}

String _formatHost(String hostname, String port, String protocol) {
  final bare = hostname.contains(':') ? '[$hostname]' : hostname;
  final omitted = protocol == 'https:' ? '443' : '80';
  if (port == omitted) return bare;
  return '$bare:$port';
}

AddressKind _classify(String hostname) {
  final host = hostname.toLowerCase().replaceAll(_zoneSuffix, '');
  if (host == 'localhost' || host == '::1' || host.startsWith('127.')) {
    return AddressKind.loopback;
  }
  if (host.endsWith('.local') ||
      host.endsWith('.lan') ||
      _isPrivateV4(host) ||
      _isPrivateV6(host)) {
    return AddressKind.lan;
  }
  return AddressKind.public;
}

bool _isPrivateV4(String host) =>
    _private10.hasMatch(host) ||
    _private192.hasMatch(host) ||
    _private172.hasMatch(host) ||
    _private169.hasMatch(host) ||
    _private100.hasMatch(host);

bool _isIpv4(String host) => _ipv4.hasMatch(host);

bool _isIpLiteral(String host) => _isIpv4(host) || host.contains(':');

bool _isHost(String hostname) {
  if (hostname.length > 253) return false;
  if (hostname.contains('%') && !_zoneSuffix.hasMatch(hostname)) return false;
  return _hostChars.hasMatch(hostname) || hostname.contains(':');
}

bool _isPrivateV6(String host) =>
    host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
