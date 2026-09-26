import { useState, type JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Copy01Icon, Tick02Icon } from "../ui/icons";
import * as Clipboard from "expo-clipboard";
import Markdown from "react-native-markdown-display";
import type { Palette } from "../ui/theme";
import { useT } from "../i18n";

/** RN MarkdownView matching desktop chat-markdown.css rather than a generic article. */
export function MarkdownView({ text, palette }: { text: string; palette: Palette }): JSX.Element {
  return (
    <Markdown
      style={{
        body: { ...styles.body, color: palette.text },
        text: { color: palette.text },
        paragraph: { ...styles.paragraph, color: palette.text },
        heading1: { ...styles.heading, color: palette.text, fontSize: 18 },
        heading2: { ...styles.heading, color: palette.text, fontSize: 17 },
        heading3: { ...styles.heading, color: palette.text, fontSize: 16 },
        heading4: { ...styles.heading, color: palette.text, fontSize: 15 },
        heading5: { ...styles.heading, color: palette.text, fontSize: 15 },
        heading6: { ...styles.heading, color: palette.text, fontSize: 14 },
        strong: { color: palette.text, fontWeight: "600" },
        em: { color: palette.text, fontStyle: "italic" },
        s: { color: palette.muted, textDecorationLine: "line-through" },
        blockquote: { ...styles.blockquote, borderLeftColor: palette.accent },
        hr: { ...styles.hr, backgroundColor: palette.border },
        code_inline: { ...styles.inlineCode, backgroundColor: palette.field, color: palette.text },
        code_block: { ...styles.codeBlockText, color: palette.text },
        fence: { ...styles.codeBlockText, color: palette.text },
        pre: { marginVertical: 0 },
        bullet_list: styles.list,
        ordered_list: styles.list,
        list_item: { ...styles.listItem, color: palette.text },
        bullet_list_icon: { color: palette.muted, marginRight: 8 },
        ordered_list_icon: { color: palette.muted, marginRight: 8 },
        bullet_list_content: { flex: 1 },
        ordered_list_content: { flex: 1 },
        link: { color: palette.accent, textDecorationLine: "underline", textDecorationColor: palette.accent },
        blocklink: { color: palette.accent },
        image: styles.image,
        table: { ...styles.table, borderColor: palette.border },
        tbody: { borderColor: palette.border },
        thead: { ...styles.thead, borderBottomColor: palette.border },
        th: { ...styles.td, ...styles.th, color: palette.text, borderBottomColor: palette.border, backgroundColor: palette.field },
        td: { ...styles.td, color: palette.text, borderBottomColor: palette.border },
        tr: { flexDirection: "row", borderBottomColor: palette.border },
      }}
      rules={{
        fence(node) {
          // The fence's info string (```ts) arrives as `sourceInfo`; markdown-it sets no class.
          const info = (node as { sourceInfo?: unknown }).sourceInfo;
          const language = (typeof info === "string" ? info.trim().split(/\s+/)[0] : "") || "code";
          return <CodeFence key={node.key} code={node.content ?? ""} language={language} palette={palette} />;
        },
        code_block(node) {
          return <CodeFence key={node.key} code={node.content ?? ""} language="code" palette={palette} />;
        },
      }}
    >
      {text}
    </Markdown>
  );
}

function CodeFence({ code, language, palette }: { code: string; language: string; palette: Palette }): JSX.Element {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <View style={[styles.codeFrame, { backgroundColor: palette.field, borderColor: palette.border }]}>
      <View style={[styles.codeHeader, { borderBottomColor: palette.border }]}>
        <Text style={[styles.codeLanguage, { color: palette.muted }]}>{language}</Text>
        <Pressable onPress={() => void copy()} style={styles.copyButton} hitSlop={6}>
          <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} color={palette.muted} strokeWidth={2} />
          <Text style={[styles.copyText, { color: palette.muted }]}>{copied ? t("common.copied") : t("common.copy")}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text selectable style={[styles.codeBlockText, { color: palette.text }]}>{code.replace(/\n$/, "")}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // Desktop: text-sm body with leading-6; RN uses 15/24 to match the visual density.
  body: { fontSize: 15, lineHeight: 24 },
  paragraph: { marginTop: 2, marginBottom: 4, fontSize: 15, lineHeight: 24 },
  heading: { lineHeight: 22, fontWeight: "600", marginTop: 8, marginBottom: 3 },
  blockquote: { borderLeftWidth: 3, paddingLeft: 12, paddingVertical: 2, marginVertical: 6, borderRadius: 4 },
  hr: { height: StyleSheet.hairlineWidth, opacity: 0.7, marginVertical: 8 },
  inlineCode: { fontFamily: "monospace", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, fontSize: 13 },
  codeFrame: { marginVertical: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  codeHeader: { height: 32, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10 },
  codeLanguage: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  copyButton: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 5 },
  copyText: { fontSize: 12 },
  codeScroll: { paddingHorizontal: 12, paddingVertical: 10, minWidth: "100%" },
  codeBlockText: { fontFamily: "monospace", fontSize: 13, lineHeight: 20 },
  list: { marginVertical: 3, marginHorizontal: 2 },
  listItem: { marginVertical: 0, fontSize: 15, lineHeight: 22 },
  image: { borderRadius: 8, maxWidth: 320, minHeight: 40 },
  table: { borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, marginVertical: 5 },
  thead: { borderBottomWidth: 1 },
  th: { fontWeight: "600", paddingHorizontal: 8, paddingVertical: 7 },
  td: { paddingHorizontal: 8, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth },
});
