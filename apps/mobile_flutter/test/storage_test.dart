import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:fastvibe_mobile/chat/draft_storage.dart';
import 'package:fastvibe_mobile/notifications/target.dart';
import 'package:fastvibe_mobile/protocol/address.dart';
import 'package:fastvibe_mobile/storage/servers.dart';
import 'package:fastvibe_mobile/ui/preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    FlutterSecureStorage.setMockInitialValues({});
  });
  SavedServer device(String id) => SavedServer(
    id: id,
    alias: id,
    origin: 'https://$id.test',
    host: '$id.test',
    kind: AddressKind.public,
    createdAt: 1000,
  );

  test(
    'concurrent favorites, rename and connection timestamp writes all survive',
    () async {
      await ServerStore.instance.upsert(device('one'));
      await Future.wait([
        ServerStore.instance.patch('one', favorite: true),
        ServerStore.instance.patch('one', alias: 'Studio'),
        ServerStore.instance.patch('one', lastConnectedAt: 2000),
      ]);
      final saved = (await ServerStore.instance.load()).single;
      expect(saved.favorite, isTrue);
      expect(saved.alias, 'Studio');
      expect(saved.lastConnectedAt, 2000);
    },
  );

  test(
    'readding an origin preserves identity, favorites and its credential',
    () async {
      final first = await ServerStore.instance.upsert(device('one'));
      await writeToken(first.id, 'local-test-token');
      await ServerStore.instance.patch(first.id, favorite: true);
      final saved = await ServerStore.instance.upsert(device('one'));
      expect(saved.id, first.id);
      expect(saved.favorite, isTrue);
      expect(await readToken(saved.id), 'local-test-token');
      await ServerStore.instance.remove(saved.id);
      expect(await ServerStore.instance.load(), isEmpty);
      expect(await readToken(saved.id), isNull);
    },
  );

  test('favorites precede more recently connected devices', () async {
    await ServerStore.instance.upsert(device('one'));
    await ServerStore.instance.upsert(device('two'));
    await ServerStore.instance.patch('one', favorite: true);
    await ServerStore.instance.patch('two', lastConnectedAt: 9999);
    expect((await ServerStore.instance.load()).map((s) => s.id), [
      'one',
      'two',
    ]);
  });

  test(
    'drafts are scoped to both device and conversation and last write wins',
    () async {
      await Future.wait([
        writeDraft('a', 'c', 'old'),
        writeDraft('a', 'c', 'new'),
        writeDraft('b', 'c', 'elsewhere'),
      ]);
      expect((await readDraft('a', 'c'))?.text, 'new');
      expect((await readDraft('b', 'c'))?.text, 'elsewhere');
      await writeDraft('a', 'c', '');
      expect(await readDraft('a', 'c'), isNull);
      expect((await listDrafts('b')).single.text, 'elsewhere');
    },
  );

  test('reduced glass preference survives a reload', () async {
    await Preferences.instance.setReduceGlass(true);
    await Preferences.instance.load();
    expect(Preferences.instance.reduceGlass, isTrue);
    await Preferences.instance.setReduceGlass(false);
  });

  test('notification target supports routed ids, legacy payloads and invalid input', () {
    const target = NotificationTarget('server|1', 'remote:host:chat/2');
    expect(
      NotificationTarget.parse(target.encode())?.conversationId,
      target.conversationId,
    );
    expect(NotificationTarget.parse('a|b')?.serverId, 'a');
    for (final value in [null, '', '{}', 'null', '[]', '|b', 'a|']) {
      expect(NotificationTarget.parse(value), isNull);
    }
  });
}
