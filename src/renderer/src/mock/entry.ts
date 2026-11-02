// The bridge must exist before evaluating any module that reads it at module scope.
async function startPreview(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("mascot") === "1") {
    await import("./mascot-preview");
    return;
  }
  await import("./preview");
  if (params.get("providersOnly") === "1") await import("./providers-preview");
  else if (params.get("scm") === "1") await import("./source-control-preview");
  else await import("../main");
}
void startPreview().catch((error: unknown) => {
  console.error("Preview could not start", error);
  const root = document.getElementById("root");
  if (root) root.textContent = error instanceof Error ? error.message : String(error);
});
