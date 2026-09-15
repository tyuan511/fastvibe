import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";

function historyIndex(): number {
  const idx = window.history.state?.idx;
  return typeof idx === "number" ? idx : 0;
}

/**
 * Back/forward against HashRouter's real history stack (the same `idx`
 * react-router writes into `history.state`). Mouse back/forward buttons
 * already POP that stack; these helpers drive the chrome buttons.
 */
export function useHistoryNav(): {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
} {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const maxIdx = useRef(historyIndex());
  const [canBack, setCanBack] = useState(() => historyIndex() > 0);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    const idx = historyIndex();
    if (navigationType === "PUSH") maxIdx.current = idx;
    else if (idx > maxIdx.current) maxIdx.current = idx;
    setCanBack(idx > 0);
    setCanForward(idx < maxIdx.current);
  }, [location.key, navigationType]);

  return {
    canBack,
    canForward,
    back: () => navigate(-1),
    forward: () => navigate(1),
  };
}
