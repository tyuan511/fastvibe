import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = process.env.WEBSITE_URL ?? "http://localhost:9088";
const output = process.env.CHECK_SCREENSHOTS_DIR;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
});
const errors = [];
async function assertTheme(page, theme, checkMeta = true) {
  await page.waitForFunction((value) => getComputedStyle(document.documentElement).colorScheme === value, theme);
  const expected = theme === "dark" ? "#0c0c11" : "#ffffff";
  if (!checkMeta) return;
  const activeColors = await page.locator('meta[name="theme-color"]').evaluateAll((tags) =>
    tags.filter((tag) => matchMedia(tag.media).matches).map((tag) => tag.content));
  assert.deepEqual(activeColors, [expected]);
}
try {
  if (output) await mkdir(output, { recursive: true });
  for (const locale of ["en", "zh"]) {
    for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ locale, colorScheme, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(`${origin}/${locale}`, { waitUntil: "networkidle" });
      assert.equal(response.status(), 200);
      await assertTheme(page, colorScheme);
      assert.equal(await page.locator("html").getAttribute("lang"), locale === "zh" ? "zh-CN" : "en");
      assert.match(await page.locator("h1").innerText(), locale === "zh" ? /为 Agent 打造的工作区/ : /workspace for your agents/);
      assert.equal(await page.locator("link[rel=canonical]").getAttribute("href"), "https://fastvibe.dev/");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale}/${width}: horizontal overflow`);
      for (const id of ["tasks", "practices", "access"]) {
        assert.equal(await page.locator(`main section#${id}`).count(), 1, `missing #${id}`);
      }
      assert.equal(await page.locator('.site-nav a[href="#access"]').count(), 1, "nav must link to the platforms section");
      assert.equal(await page.locator(".download-menu-group a").count(), 5);
      assert.equal(await page.locator('#access a[href="https://testflight.apple.com/join/esBzVH3v"]').count(), 1, "iOS must link to TestFlight");
      assert.equal(await page.locator("#access .action-button").count(), 5);
      assert.doesNotMatch(await page.locator("main").innerText(), /benchmark|49\.8%|Terminal-Bench|install\.sh/i);
      assert.equal(await page.locator("img[src*='/screenshots/']").count(), 0, "below-the-fold screenshots must be illustrations");
      assert.equal(await page.locator(".illu, .phone-shot, .mock-browser").count() >= 6, true);
      for (const link of await page.locator(".download-menu-group a").all()) {
        assert.match(await link.getAttribute("href"), /^https:\/\/github\.com\/tyuan511\/fastvibe\/releases\//);
      }
      if (output && [375, 1440].includes(width)) {
        await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } scrollTo(0, 0); });
        await page.screenshot({ path: path.join(output, `${locale}-${colorScheme}-${width}.png`), fullPage: true });
      }
      console.log(`PASS ${locale}/${colorScheme} @ ${width}px: SSR, theme, locale images, downloads, layout`);
    }

    // These contexts ask for reduced motion, so nothing may wait on a scroll animation.
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("reveal")), false);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".module-heading, .practice-copy, .access-card, .footer-inner")].every((el) => getComputedStyle(el).opacity === "1")), true, "reduced motion must not hide content");

    // The hero menu, and the task tabs are the page's interactive parts.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".download-more > summary").click();
    assert.equal(await page.locator(".download-more").evaluate((el) => el.open), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".download-more").evaluate((el) => el.open), false);
    await page.locator(".task-tab").nth(1).click();
    assert.equal(await page.locator('.task-tab[aria-selected="true"]').count(), 1);
    assert.equal(await page.locator('#tasks [role="tabpanel"]:not([hidden])').count(), 1);

    // The real client UI is embedded and told which theme the site is showing.
    const frame = page.locator(".preview-window iframe");
    await frame.waitFor({ state: "attached" });
    assert.match(await frame.getAttribute("src"), new RegExp(`theme=${colorScheme}&?`));
    assert.match(await frame.getAttribute("src"), new RegExp(`lang=${locale}`));
    await page.locator(".preview-window[data-ready]").waitFor();
    const appTheme = () => page.frameLocator(".preview-window iframe").locator("html").evaluate((el) => el.classList.contains("dark"));
    await page.waitForFunction(() => document.querySelector(".preview-window iframe")?.contentDocument?.querySelector("#root > *"));
    assert.equal(await appTheme(), colorScheme === "dark", "preview must match the page theme on load");

    // The switch flips the page and the embedded app together, and the choice survives a reload.
    const flipped = colorScheme === "dark" ? "light" : "dark";
    await page.locator(".theme-switch").click();
    await assertTheme(page, flipped, false);
    await page.waitForFunction((dark) => document.querySelector(".preview-window iframe").contentDocument.documentElement.classList.contains("dark") === dark, flipped === "dark");
    await page.reload({ waitUntil: "networkidle" });
    await assertTheme(page, flipped, false);
    assert.match(await page.locator(".preview-window iframe").getAttribute("src"), new RegExp(`theme=${flipped}`));
    await page.locator(".theme-switch").click();
    await assertTheme(page, colorScheme, false);
    await page.evaluate((key) => localStorage.removeItem(key), "fastvibe-website-theme");
    await page.reload({ waitUntil: "networkidle" });
    console.log(`PASS ${locale}/${colorScheme}: embedded client UI follows the theme switch`);

    const other = locale === "en" ? "zh" : "en";
    const here = new URL(page.url()).pathname;
    await page.locator(`.language-switch a[hreflang="${other}"]`).click();
    await page.waitForURL((url) => url.pathname === here);
    await page.waitForLoadState("networkidle");
    assert.equal(new URL(page.url()).pathname, here);
    assert.equal(await page.locator("html").getAttribute("lang"), other === "zh" ? "zh-CN" : "en");
    assert.equal((await context.cookies()).find((cookie) => cookie.name === "FASTVIBE_LOCALE")?.value, other);
    await page.goto(origin);
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(await page.locator("html").getAttribute("lang"), other === "zh" ? "zh-CN" : "en");
    console.log(`PASS ${locale}/${colorScheme}: download menu, tabs, modal, language switch & persistence`);

    const opposite = colorScheme === "light" ? "dark" : "light";
    await page.emulateMedia({ colorScheme: opposite });
    await assertTheme(page, opposite);
    await page.reload({ waitUntil: "networkidle" });
    await assertTheme(page, opposite);
    const stayed = new URL(page.url()).pathname;
    await page.locator(`.language-switch a[hreflang="${locale}"]`).click();
    await page.waitForURL((url) => url.pathname === stayed);
    await assertTheme(page, opposite);
    await page.emulateMedia({ colorScheme });
    await assertTheme(page, colorScheme);
    console.log(`PASS ${locale}/${colorScheme}: live system theme, reload, language switch, ignoring legacy preference`);
    await context.close();
    }
  }

  // Scroll reveal, with motion allowed: pieces start hidden and appear as the page is scrolled through.
  {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/en`, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("reveal")), true);
    assert.equal(await page.locator(".access-card").first().evaluate((el) => getComputedStyle(el).opacity), "0", "below-the-fold content should wait for its scroll");
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 300) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } });
    await page.waitForFunction(() => [...document.querySelectorAll(".module-heading, .task-content, .practice-copy, .practice-media, .access-card, .footer-inner")].every((el) => el.hasAttribute("data-in")));
    await page.waitForFunction(() => [...document.querySelectorAll(".access-card")].every((el) => getComputedStyle(el).opacity === "1"));
    await context.close();
    console.log("PASS scroll reveal: hidden until scrolled to, then shown");
  }

  // The language and download content must work before client JavaScript runs.
  for (const locale of ["zh-CN", "en-US"]) {
    const colorScheme = locale === "zh-CN" ? "light" : "dark";
    const context = await browser.newContext({ locale, colorScheme, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(origin);
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(await page.locator("html").getAttribute("lang"), locale.startsWith("zh") ? "zh-CN" : "en");
    assert.equal(await page.locator(".download-menu-group a").count(), 5);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), colorScheme);
    assert.ok((await page.locator("h1").innerText()).length > 0);
    const missing = await page.goto(`${origin}/de`);
    assert.equal(missing.status(), 404);
    await context.close();
  }
  assert.deepEqual(errors, [], "Browser errors were reported");
  console.log("PASS language negotiation, no-JS SSR, unsupported locale, no browser errors");
} finally {
  await browser.close();
}
