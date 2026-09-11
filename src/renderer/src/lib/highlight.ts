const KEYWORDS = new Set([
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "class",
  "import",
  "export",
  "from",
  "async",
  "await",
  "try",
  "catch",
  "throw",
  "new",
  "this",
  "type",
  "interface",
  "enum",
  "def",
  "elif",
  "pass",
  "None",
  "True",
  "False",
  "and",
  "or",
  "not",
  "in",
  "fn",
  "impl",
  "struct",
  "pub",
  "mut",
  "package",
  "func",
  "nil",
]);

export function highlightCode(code: string): string {
  const escaped = code
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escaped.replace(
    /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b)/g,
    (token) => {
      if (token.startsWith("//") || token.startsWith("#") || token.startsWith("/*")) {
        return `<span class="tok-comment">${token}</span>`;
      }
      if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) {
        return `<span class="tok-string">${token}</span>`;
      }
      if (/^\d/.test(token)) return `<span class="tok-number">${token}</span>`;
      if (KEYWORDS.has(token)) return `<span class="tok-keyword">${token}</span>`;
      return token;
    },
  );
}
