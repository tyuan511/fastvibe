// The bridge must exist before evaluating any module that reads it at module scope.
async function startPreview(): Promise<void> {
  await import("./preview");
  if (new URLSearchParams(window.location.search).get("providersOnly") === "1") await import("./providers-preview");
  else if (new URLSearchParams(window.location.search).get("scm") === "1") await import("./source-control-preview");
  else await import("../main");
}
void startPreview().catch((error: unknown) => {
  console.error("Preview could not start", error);
  const root = document.getElementById("root");
  if (root) root.textContent = error instanceof Error ? error.message : String(error);
});
