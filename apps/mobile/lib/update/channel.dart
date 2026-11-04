/// Where update checks and APK downloads come from.
///
/// The official channel talks to github.com directly, which mainland networks often
/// throttle or block. The mirrors are prefix proxies: the same github.com and
/// raw.githubusercontent.com paths, fetched through a mirror that reaches GitHub from
/// inside. They only carry data, so the release page opened in a browser stays on
/// github.com, and a tampered APK still cannot install — the installer rejects a
/// package not signed like the installed app.
class UpdateChannel {
  const UpdateChannel({required this.id, this.prefix});

  /// Stable id, persisted in preferences; an unknown stored id reads as official.
  final String id;

  /// Prepended to github.com and raw.githubusercontent.com URLs; null talks to GitHub
  /// directly.
  final String? prefix;

  /// The mirror URL for a GitHub URL. Official URLs pass unchanged, an already
  /// rewritten URL is not prefixed twice, and anything that is not a GitHub host is
  /// none of the channel's business.
  String rewrite(String url) {
    if (prefix == null) return url;
    if (url.startsWith(prefix!)) return url;
    if (!url.startsWith('https://github.com/') &&
        !url.startsWith('https://raw.githubusercontent.com/')) {
      return url;
    }
    return '$prefix$url';
  }

  /// The row label in 设置 → 更新通道; the key set lives with the channel list below.
  String get nameKey => 'update.channel${_keySuffix(id)}';

  /// One line under that label in the picker.
  String get descriptionKey => 'update.channel${_keySuffix(id)}Desc';

  static String _keySuffix(String id) => switch (id) {
    'github' => 'Github',
    'gh-proxy' => 'GhProxy',
    'ghfast' => 'Ghfast',
    _ => 'Github',
  };
}

const UpdateChannel channelGithub = UpdateChannel(id: 'github');

/// Benchmark result as of the mirror selection (see the release docs): every endpoint
/// the updater uses answered, with the fastest APK throughput of the candidates.
const UpdateChannel channelGhProxy = UpdateChannel(
  id: 'gh-proxy',
  prefix: 'https://gh-proxy.com/',
);

/// Also answered everything but the atom feed (403); release notes fall back to the
/// raw `docs/release/*.md` file, which it serves.
const UpdateChannel channelGhfast = UpdateChannel(
  id: 'ghfast',
  prefix: 'https://ghfast.top/',
);

/// Official first: it is the default and the picker's first row.
const List<UpdateChannel> updateChannels = <UpdateChannel>[
  channelGithub,
  channelGhProxy,
  channelGhfast,
];

UpdateChannel channelFromId(String? id) => updateChannels.firstWhere(
  (channel) => channel.id == id,
  orElse: () => channelGithub,
);
