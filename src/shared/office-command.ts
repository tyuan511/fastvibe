/**
 * Which files an `officecli` command is about to change.
 *
 * The changed-file chips and the retry checkpoint only see `write` and `edit`. An agent
 * that builds a deck does it with `officecli set` / `add` / `batch` inside bash, and those
 * files would otherwise be invisible: not on the card, and not rewound when the turn is
 * retried. This reads the command the tool is about to run — before it runs — and names
 * the Office files it will write.
 *
 * It is a scan, not a shell. A variable (`$FILE`) is not expanded, and a path that is not
 * an Office extension is not a target. That misses a command that hides the name in a
 * variable, and it does not invent a file out of `--prop text=notes.docx`.
 */

const WRITE_VERBS = new Set([
  "set",
  "add",
  "remove",
  "move",
  "swap",
  "raw-set",
  "add-part",
  "batch",
  "import",
  "create",
  "merge",
  "refresh",
]);

const OFFICE_EXT = new Set([".docx", ".xlsx", ".pptx"]);

function extensionOf(token: string): string {
  const name = token.split(/[\\/]/).pop() ?? token;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function isOfficecli(token: string): boolean {
  const name = (token.split(/[\\/]/).pop() ?? token).toLowerCase();
  return name === "officecli" || name === "officecli.exe";
}

function isOfficeFile(token: string): boolean {
  return OFFICE_EXT.has(extensionOf(token));
}

/** Statements split on `&&`, `||`, `;` and newlines, without cutting a quoted path in half. */
function statements(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (quote) {
      current += char;
      if (char === quote && command[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const doubled = char === "&" && command[index + 1] === "&" || char === "|" && command[index + 1] === "|";
    if (char === "\n" || char === ";" || doubled) {
      if (current.trim()) out.push(current.trim());
      current = "";
      if (doubled) index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function unquote(token: string): string {
  if (token.length >= 2 && (token.startsWith("'") && token.endsWith("'") || token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  return token;
}

function tokens(statement: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const push = (): void => {
    if (current) out.push(unquote(current));
    current = "";
  };
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index] ?? "";
    if (quote) {
      if (char === quote && statement[index - 1] !== "\\") quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      push();
      continue;
    }
    current += char;
  }
  push();
  return out;
}

function targetsOf(argv: string[]): string[] {
  const start = argv.findIndex(isOfficecli);
  if (start < 0) return [];
  const verb = (argv[start + 1] ?? "").toLowerCase();
  if (!WRITE_VERBS.has(verb)) return [];
  const positionals = argv.slice(start + 2).filter((token) => token && !token.startsWith("-") && !token.includes("$"));
  const files = positionals.filter(isOfficeFile);
  if (files.length === 0) return [];
  // `merge` writes the output, which is the last Office path. Everything else writes the first.
  return [verb === "merge" ? files[files.length - 1]! : files[0]!];
}

/** Office files a shell command will write, in the order the command names them, each once. */
export function officecliWriteTargets(command: string): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const statement of statements(command)) {
    for (const target of targetsOf(tokens(statement))) {
      if (seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
}

/** The bash tool's command, whether the arguments arrived as an object or a JSON string. */
export function bashCommand(args: unknown): string {
  const record = typeof args === "object" && args !== null && !Array.isArray(args)
    ? args as Record<string, unknown>
    : null;
  if (!record) {
    if (typeof args !== "string") return "";
    try {
      return bashCommand(JSON.parse(args) as unknown);
    } catch {
      return "";
    }
  }
  return typeof record.command === "string" ? record.command : "";
}
