/**
 * Runs before first paint. The scroll-reveal styles only apply under `html.reveal`, so a
 * visitor without JavaScript, without IntersectionObserver, or who asked for reduced motion
 * never has content hidden waiting for an animation that will not come.
 */
export const revealInitScript = `try{if(!matchMedia("(prefers-reduced-motion: reduce)").matches&&"IntersectionObserver"in window)document.documentElement.classList.add("reveal")}catch(e){}`;

/** What fades in as it scrolls into view. Kept in one place: the CSS selects the same list. */
export const REVEAL_SELECTOR = ".module-heading, .task-content, .practice-copy, .practice-media, .access-card, .footer-inner";
