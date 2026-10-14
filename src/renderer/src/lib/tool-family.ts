/**
 * Which kind of tool a call is, from its name alone. Presentation (verb, icon,
 * one-line summary) lives next to the renderer; this split exists so the fold
 * rule can be tested without loading that module.
 */
export type ToolFamily =
  | "read"
  | "edit"
  | "write"
  | "delete"
  | "search"
  | "web"
  | "list"
  | "terminal"
  | "skill"
  | "agent"
  | "todo"
  | "question"
  | "mcp"
  | "codemode"
  | "browser"
  | "present"
  | "other";

/** Map an engine tool name onto a family. MCP tools keep their own family. */
export function familyOf(name: string): ToolFamily {
  const key = name.trim().toLowerCase();
  if (!key) return "other";
  if (key === "codemode") return "codemode";
  if (key === "present") return "present";
  if (key.startsWith("mcp") || key.includes("__")) return "mcp";
  if (key.startsWith("browser_")) return "browser";
  if (/^(read|read_file|readfile|view|cat)$/.test(key)) return "read";
  if (/^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$/.test(key)) return "edit";
  if (/^(write|write_file|writefile|create_file|createfile|create)$/.test(key)) return "write";
  if (/^(delete|delete_file|remove|remove_file|rm)$/.test(key)) return "delete";
  if (/^(web_search|websearch)$/.test(key)) return "web";
  if (/^(grep|search|search_files|searchfiles|ripgrep|rg|fetch|webfetch|conversation_search|tool_search)$/.test(key)) return "search";
  if (/^(find|glob|ls|list|list_dir|listdir|tree|list_files|listfiles)$/.test(key)) return "list";
  if (/^(bash|shell|shell_exec|shellexec|exec|execute|run_command|runcommand|command|terminal|run)$/.test(key)) return "terminal";
  if (key.includes("skill")) return "skill";
  if (/^(task|agent|subagent|dispatch|delegate)/.test(key)) return "agent";
  if (key.includes("todo")) return "todo";
  if (/^(question|ask_user|askuser|questionnaire)$/.test(key)) return "question";
  return "other";
}
