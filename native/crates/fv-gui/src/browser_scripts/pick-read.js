(() => {

  const picked = window.__fvPicked || null;
  const stop = window.__fvPick;
  if (stop) {
    document.removeEventListener("mousemove", stop.onMove, true);
    document.removeEventListener("click", stop.onClick, true);
    stop.box.remove();
    stop.label.remove();
    delete window.__fvPick;
  }
  delete window.__fvPicked;
  return picked;

})()
