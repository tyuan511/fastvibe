// The bridge must exist before evaluating any module that reads it at module scope.
async function startPreview(): Promise<void> {
  await import("./preview");
  const mobile = new URLSearchParams(window.location.search).get("mobile") === "1";
  if (mobile && !window.location.hash) window.location.hash = "#/c/conv-theme";
  await (mobile ? import("../mobile/main") : import("../main"));
}
void startPreview().catch((error: unknown) => {
  console.error("Preview could not start", error);
  const root = document.getElementById("root");
  if (root) root.textContent = error instanceof Error ? error.message : String(error);
});
