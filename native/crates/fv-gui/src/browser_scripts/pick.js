(() => {

  if (window.__fvPick) return { listening: true };
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #1a73e8;background:rgba(26,115,232,.12);border-radius:2px;display:none;";
  const label = document.createElement("div");
  label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#1a73e8;color:#fff;font:12px/1.4 -apple-system,sans-serif;padding:2px 6px;border-radius:4px;display:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  document.documentElement.append(box, label);
  const describe = (node) => {
    const tag = node.tagName.toLowerCase();
    const id = node.id ? "#" + node.id : "";
    const cls = typeof node.className === "string" && node.className.trim()
      ? "." + node.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
    return tag + id + cls;
  };
  const onMove = (event) => {
    const node = event.target;
    if (!(node instanceof Element) || node === box || node === label) return;
    const rect = node.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    label.style.display = "block";
    label.textContent = describe(node);
    label.style.left = Math.max(4, rect.left) + "px";
    label.style.top = Math.max(4, rect.top - 22) + "px";
  };
  const onClick = (event) => {
    const node = event.target;
    if (!(node instanceof Element)) return;
    event.preventDefault();
    event.stopPropagation();
    const text = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 8000);
    const html = (node.outerHTML || "").slice(0, 8000);
    window.__fvPicked = { selector: describe(node), tag: node.tagName.toLowerCase(), text, html, url: location.href };
  };
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  window.__fvPick = { box, label, onMove, onClick };
  return { listening: true };

})()
