import 'package:hugeicons/hugeicons.dart';

/// Every icon the app draws.
///
/// The same Hugeicons set the Expo client uses, under the same names, so a screen that
/// lists 读取 / 编辑 / 搜索 keeps the identical glyph. Only the icons actually used are
/// referenced, which is what lets the package tree-shake the other ~6,000 away.
abstract final class AppIcons {
  static const star = HugeIcons.strokeRoundedStar;
  static const aiBrain = HugeIcons.strokeRoundedAiBrain01;
  static const alert = HugeIcons.strokeRoundedAlert02;
  static const archive = HugeIcons.strokeRoundedArchive02;
  static const archiveRestore = HugeIcons.strokeRoundedArchiveArrowUp;
  static const arrowDown = HugeIcons.strokeRoundedArrowDown01;

  /// SF Symbols' `chevron.up.chevron.down`: the mark of an iOS pop-up button.
  static const chevronUpDown = HugeIcons.strokeRoundedUnfoldMore;
  static const arrowDownLong = HugeIcons.strokeRoundedArrowDown02;
  static const arrowLeft = HugeIcons.strokeRoundedArrowLeft01;
  static const arrowRight = HugeIcons.strokeRoundedArrowRight01;
  static const arrowUp = HugeIcons.strokeRoundedArrowUp02;
  static const bot = HugeIcons.strokeRoundedBot;
  static const bubbleChat = HugeIcons.strokeRoundedBubbleChat;
  static const bug = HugeIcons.strokeRoundedBug01;
  static const cancel = HugeIcons.strokeRoundedCancel01;
  static const chatAdd = HugeIcons.strokeRoundedChatAdd01;
  static const plus = HugeIcons.strokeRoundedAdd01;
  static const checkCircle = HugeIcons.strokeRoundedCheckmarkCircle02;
  static const chrome = HugeIcons.strokeRoundedChrome;
  static const clock = HugeIcons.strokeRoundedClock01;
  static const code = HugeIcons.strokeRoundedCode;
  static const clipboardPaste = HugeIcons.strokeRoundedClipboardPaste;
  static const computer = HugeIcons.strokeRoundedComputer;
  static const copy = HugeIcons.strokeRoundedCopy01;
  static const delete = HugeIcons.strokeRoundedDelete02;
  static const fileEdit = HugeIcons.strokeRoundedFileEdit;
  static const fileMinus = HugeIcons.strokeRoundedFileMinus;
  static const filePlus = HugeIcons.strokeRoundedFilePlus;
  static const fileText = HugeIcons.strokeRoundedFileText;
  static const imageAdd = HugeIcons.strokeRoundedImageAdd01;
  static const folder = HugeIcons.strokeRoundedFolder01;
  static const folderTree = HugeIcons.strokeRoundedFolderTree;
  static const globe = HugeIcons.strokeRoundedGlobe02;
  static const hand = HugeIcons.strokeRoundedHand;
  static const idea = HugeIcons.strokeRoundedIdea01;
  static const information = HugeIcons.strokeRoundedInformationCircle;
  static const link = HugeIcons.strokeRoundedLink01;
  static const login = HugeIcons.strokeRoundedLogin01;
  static const logout = HugeIcons.strokeRoundedLogout01;
  static const user = HugeIcons.strokeRoundedUser;
  static const listChecks = HugeIcons.strokeRoundedListChecks;
  static const loading = HugeIcons.strokeRoundedLoading03;
  static const lockPassword = HugeIcons.strokeRoundedLockPassword;
  static const messageQuestion = HugeIcons.strokeRoundedMessageQuestion;
  static const notification = HugeIcons.strokeRoundedNotification01;
  static const moreHorizontal = HugeIcons.strokeRoundedMoreHorizontal;
  static const pencilEdit = HugeIcons.strokeRoundedPencilEdit02;
  static const play = HugeIcons.strokeRoundedPlay;
  static const plug = HugeIcons.strokeRoundedPlug01;
  static const qrCode = HugeIcons.strokeRoundedQrCode01;
  static const refresh = HugeIcons.strokeRoundedRefresh01;
  static const scissor = HugeIcons.strokeRoundedScissor;
  static const search = HugeIcons.strokeRoundedSearch01;
  static const settings = HugeIcons.strokeRoundedSettings02;
  static const sparkles = HugeIcons.strokeRoundedSparkles;
  static const square = HugeIcons.strokeRoundedSquare;
  static const terminal = HugeIcons.strokeRoundedSquareTerminal;
  static const sun = HugeIcons.strokeRoundedSun03;
  static const testTube = HugeIcons.strokeRoundedTestTube01;
  static const tick = HugeIcons.strokeRoundedTick02;
  static const touchInteraction = HugeIcons.strokeRoundedTouchInteraction01;
  static const wifiDisconnected = HugeIcons.strokeRoundedWifiDisconnected02;
  static const wrench = HugeIcons.strokeRoundedWrench01;
}
