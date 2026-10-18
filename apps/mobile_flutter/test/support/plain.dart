import 'package:flutter/widgets.dart';

/// Marks the root of a widget under test. The app has no wrapper above `MaterialApp`; this
/// keeps a test's tree shaped like the app's without repeating its setup.
Widget plain({required Widget child}) => child;
