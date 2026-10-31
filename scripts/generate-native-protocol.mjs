#!/usr/bin/env node
/**
 * Generate the Flutter native protocol metadata and schema validator from the Rust snapshot.
 *
 * The Rust protocol owns the method list and JSON Schemas. This generator deliberately carries
 * that snapshot into Dart instead of maintaining a second hand-written method map.
 *
 *   node scripts/generate-native-protocol.mjs
 *   node scripts/generate-native-protocol.mjs --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaPath = join(root, "native", "schema", "protocol.json");
const outputPath = join(root, "apps", "mobile_flutter", "lib", "protocol", "native_schema.dart");
const check = process.argv.includes("--check");

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const methodSchemas = schema.methodSchemas;
if (!methodSchemas || typeof methodSchemas !== "object" || Array.isArray(methodSchemas)) {
  throw new Error("native/schema/protocol.json has no methodSchemas object");
}
const methods = Object.keys(methodSchemas);
if (methods.length === 0) throw new Error("methodSchemas is empty");
const notificationSchema = schema.clientNotification;
const notifications = (notificationSchema?.oneOf ?? [])
  .map((entry) => entry?.properties?.method?.const)
  .filter((method) => typeof method === "string");
if (notifications.length === 0) throw new Error("clientNotification schema has no methods");

function dartString(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n").replaceAll("\r", "\\r")}'`;
}

function dartList(values, indent) {
  if (values.length === 0) return "<String>[]";
  const pad = " ".repeat(indent);
  const child = " ".repeat(indent + 2);
  return `<String>[\n${values.map((value) => `${child}${dartString(value)},`).join("\n")}\n${pad}]`;
}

function dartIdentifier(method) {
  const words = method.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return words
    .map((word, index) => index === 0 ? word : word[0].toUpperCase() + word.slice(1))
    .join('') || 'unknown';
}

const embeddedJson = JSON.stringify(methodSchemas);
if (embeddedJson.includes("'''")) {
  throw new Error("method schema contains a Dart raw-string terminator");
}

const generated = `// GENERATED CODE - DO NOT MODIFY BY HAND.\n// Source: native/schema/protocol.json (methodSchemas).\n// Regenerate with: node scripts/generate-native-protocol.mjs\n\nimport 'dart:convert';\n\n/// Every client-callable native method, generated from the Rust RPC table.\nconst List<String> nativeProtocolMethods = ${dartList(methods, 0)};\n\n/// Client notifications accepted by the native protocol.\nconst List<String> nativeProtocolNotifications = ${dartList(notifications, 0)};\n\n/// Typed names for generated client notifications.\nabstract final class NativeProtocolNotifications {\n${notifications.map((method) => `  static const String ${dartIdentifier(method)} = ${dartString(method)};`).join("\n")}\n}\n\n/// Typed names for generated client methods.\nabstract final class NativeProtocolMethods {\n${methods.map((method) => `  static const String ${dartIdentifier(method)} = ${dartString(method)};`).join("\n")}\n}\n\n/// The complete method metadata, including params and response JSON Schemas.\nconst String nativeProtocolMethodSchemasJson = r'''${embeddedJson}''';\n\n/// A schema error raised before a native frame is sent or accepted.\nclass NativeProtocolSchemaError extends FormatException {\n  NativeProtocolSchemaError(this.method, this.direction, String message)\n      : super(message);\n\n  final String method;\n  final String direction;\n\n  @override\n  String toString() =>\n      'NativeProtocolSchemaError($method.$direction): $message';\n}\n\n/// Schema metadata and validation generated from the native protocol snapshot.\nabstract final class NativeProtocolSchema {\n  static Map<String, Object?>? _decoded;\n\n  static Map<String, Object?> get methods {\n    return _decoded ??=\n        (jsonDecode(nativeProtocolMethodSchemasJson) as Map).cast<String, Object?>();\n  }\n\n  static bool hasMethod(String method) => methods.containsKey(method);\n\n  static Map<String, Object?> method(String method) {\n    final value = methods[method];\n    if (value is! Map) {\n      throw ArgumentError.value(method, 'method', 'Unknown native method');\n    }\n    return value.cast<String, Object?>();\n  }\n\n  static void validateParams(String methodName, Object? value) =>\n      _validate(methodName, 'params', method(methodName)['params'], value);\n\n  static void validateResponse(String methodName, Object? value) =>\n      _validate(methodName, 'response', method(methodName)['response'], value);\n\n  static void _validate(\n    String methodName,\n    String direction,\n    Object? rawSchema,\n    Object? value,\n  ) {\n    try {\n      _check(rawSchema, value, methodName, direction, rawSchema);\n    } on _SchemaMismatch catch (error) {\n      throw NativeProtocolSchemaError(methodName, direction, error.message);\n    }\n  }\n\n  static void _check(\n    Object? rawSchema,\n    Object? value,\n    String methodName,\n    String direction,\n    Object? rawRoot,\n  ) {\n    if (rawSchema is! Map) {\n      throw _SchemaMismatch('schema is not an object');\n    }\n    final schema = rawSchema.cast<String, Object?>();\n    final reference = schema['\\$ref'];\n    if (reference is String) {\n      final root = rawRoot is Map ? rawRoot.cast<String, Object?>() : null;\n      final definitions = root?['\\$defs'];\n      final name = reference.split('/').last;\n      final resolved = definitions is Map ? definitions[name] : null;\n      if (resolved == null) throw _SchemaMismatch('unresolved reference $reference');\n      _check(resolved, value, methodName, direction, rawRoot);\n      return;\n    }\n\n    for (final key in const <String>['anyOf', 'oneOf']) {\n      final alternatives = schema[key];\n      if (alternatives is List) {\n        for (final alternative in alternatives) {\n          try {\n            _check(alternative, value, methodName, direction, rawRoot);\n            return;\n          } on _SchemaMismatch {\n            // Try the next branch.\n          }\n        }\n        throw _SchemaMismatch('does not match $key');\n      }\n    }\n\n    final constant = schema['const'];\n    if (constant != null && !_sameJson(constant, value)) {\n      throw _SchemaMismatch('must equal $constant');\n    }\n    final enumeration = schema['enum'];\n    if (enumeration is List && !enumeration.any((item) => _sameJson(item, value))) {\n      throw _SchemaMismatch('must be one of $enumeration');\n    }\n\n    final type = schema['type'];\n    if (type is List) {\n      if (!type.any((candidate) => _matchesType(candidate, value))) {\n        throw _SchemaMismatch('has type \${_typeName(value)}, expected $type');\n      }\n    } else if (type is String && !_matchesType(type, value)) {\n      throw _SchemaMismatch('has type \${_typeName(value)}, expected $type');\n    }\n\n    if (type == 'object' || schema['properties'] is Map || schema['required'] is List) {\n      if (value is! Map) throw _SchemaMismatch('must be an object');\n      final object = value.cast<Object?, Object?>();\n      final required = schema['required'];\n      if (required is List) {\n        for (final name in required.whereType<String>()) {\n          if (!object.containsKey(name)) throw _SchemaMismatch('missing required field $name');\n        }\n      }\n      final properties = schema['properties'];\n      if (properties is Map) {\n        for (final entry in properties.entries) {\n          if (object.containsKey(entry.key)) {\n            _check(entry.value, object[entry.key], methodName, direction, rawRoot);\n          }\n        }\n      }\n    }\n\n    if (type == 'array' || schema['items'] != null) {\n      if (value is! List) throw _SchemaMismatch('must be an array');\n      final itemSchema = schema['items'];\n      if (itemSchema != null) {\n        for (final item in value) {\n          _check(itemSchema, item, methodName, direction, rawRoot);\n        }\n      }\n    }\n  }\n\n  static bool _matchesType(Object? type, Object? value) {\n    switch (type) {\n      case 'object':\n        return value is Map;\n      case 'array':\n        return value is List;\n      case 'string':\n        return value is String;\n      case 'integer':\n        return value is int;\n      case 'number':\n        return value is num;\n      case 'boolean':\n        return value is bool;\n      case 'null':\n        return value == null;\n      default:\n        return true;\n    }\n  }\n\n  static String _typeName(Object? value) {\n    if (value == null) return 'null';\n    if (value is Map) return 'object';\n    if (value is List) return 'array';\n    if (value is String) return 'string';\n    if (value is bool) return 'boolean';\n    if (value is int) return 'integer';\n    if (value is num) return 'number';\n    return value.runtimeType.toString();\n  }\n\n  static bool _sameJson(Object? left, Object? right) {\n    if (left is Map && right is Map) {\n      if (left.length != right.length) return false;\n      for (final entry in left.entries) {\n        if (!right.containsKey(entry.key) || !_sameJson(entry.value, right[entry.key])) {\n          return false;\n        }\n      }\n      return true;\n    }\n    if (left is List && right is List) {\n      return left.length == right.length &&\n          List.generate(left.length, (index) => _sameJson(left[index], right[index]))\n              .every((same) => same);\n    }\n    return left == right;\n  }\n}\n\nclass _SchemaMismatch implements Exception {\n  const _SchemaMismatch(this.message);\n  final String message;\n}\n`;

if (check) {
  const existing = readFileSync(outputPath, "utf8");
  if (existing !== generated) {
    throw new Error(`Generated protocol file is stale: ${resolve(outputPath)}`);
  }
} else {
  writeFileSync(outputPath, generated);
}
