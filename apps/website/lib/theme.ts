export const THEME_KEY = "fastvibe-website-theme";

/** Runs before first paint so a stored choice never flashes the other theme. */
export const themeInitScript = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
