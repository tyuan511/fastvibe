import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = process.env.WEBSITE_URL ?? "http://localhost:3000";
const output = process.env.CHECK_SCREENSHOTS_DIR;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined),
});
const errors = [];
async function assertTheme(page, theme) {
  await page.waitForFunction((value) => getComputedStyle(document.documentElement).colorScheme === value, theme);
  const expected = theme === "dark" ? "#101016" : "#faf9fc";
  const activeColors = await page.locator('meta[name="theme-color"]').evaluateAll((tags) =>
    tags.filter((tag) => matchMedia(tag.media).matches).map((tag) => tag.content));
  assert.deepEqual(activeColors, [expected]);
  assert.equal(await page.locator(".theme-switch, .theme-select").count(), 0);
}
try {
  if (output) await mkdir(output, { recursive: true });
  for (const locale of ["en", "zh"]) {
    for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ locale, colorScheme, reducedMotion: "reduce" });
    // Preferences from the removed manual switch must no longer override the OS.
    await context.addInitScript((scheme) => localStorage.setItem("fastvibe-website-theme", scheme === "light" ? "dark" : "light"), colorScheme);
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
      assert.match(await page.locator("h1").innerText(), locale === "zh" ? /为 Agent/ : /workspace for your agents/);
      assert.equal(await page.locator("link[rel=canonical]").getAttribute("href"), `https://fastvibe.dev/${locale}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale}/${width}: horizontal overflow`);
      assert.match(await page.locator(".hero-description").innerText(), /pi-coding-agent/);
      assert.equal(await page.locator(".hero-description strong").count(), 4);
      if (await page.locator(".header-github").isVisible()) {
        const github = await page.locator(".header-github").boundingBox();
        const language = await page.locator(".language-switch").boundingBox();
        assert.equal(github.height, language.height, "Header controls must have the same height");
      }
      assert.equal(await page.locator(".source-chain a").count(), 4);
      assert.equal(await page.locator('.pi-link[href="https://pi.dev"]').count(), 1);
      assert.doesNotMatch(await page.locator("main").innerText(), /benchmark|49\.8%|Terminal-Bench/i);
      for (const img of await page.locator(".product-screenshot:visible > img").all()) {
        await img.scrollIntoViewIfNeeded();
        await page.waitForFunction((image) => image.complete && image.naturalWidth > 0, await img.elementHandle(), { timeout: 15_000 });
        assert.match(decodeURIComponent(await img.getAttribute("src")), new RegExp(`/screenshots/${locale}/`));
      }
      for (const link of await page.locator(".download-link").all()) {
        assert.match(await link.getAttribute("href"), /^https:\/\/github\.com\/tyuan511\/fastvibe\/releases\//);
        const rect = await link.boundingBox();
        assert.ok(rect.height >= 44 && rect.height < 100, `${locale}/${width}: download button has incorrect height`);
      }
      if (output && [375, 1440].includes(width)) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(output, `${locale}-${colorScheme}-${width}.png`), fullPage: true });
      }
      console.log(`PASS ${locale}/${colorScheme} @ ${width}px: SSR, theme, locale images, downloads, layout`);
    }

    await page.locator(".platform-tabs button").filter({ hasText: /^Windows$/ }).click();
    assert.equal(await page.locator(".installer-link").count(), 1);
    assert.match(await page.locator(".installer-link").getAttribute("href"), /\.exe$|\/releases\/latest$/);
    await page.locator(".platform-tabs button").filter({ hasText: /^Linux$/ }).click();
    assert.equal(await page.locator(".installer-link").count(), 2);

    assert.equal(await page.locator(".showcase-section").count(), 0);
    assert.equal(await page.locator(".product-screenshot").count(), 4);
    const enlarge = page.locator(".feature-row .product-screenshot").first();
    await enlarge.click();
    assert.equal(await page.locator("dialog[open]").count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog[open]").count(), 0);
    assert.equal(await enlarge.evaluate((element) => document.activeElement === element), true);
    await enlarge.click();
    await page.locator("dialog[open] .close-screenshot").click();
    assert.equal(await page.locator("dialog[open]").count(), 0);

    const other = locale === "en" ? "zh" : "en";
    await page.locator(`.language-switch a[hreflang="${other}"]`).click();
    await page.waitForURL(`**/${other}`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("html").getAttribute("lang"), other === "zh" ? "zh-CN" : "en");
    assert.equal((await context.cookies()).find((cookie) => cookie.name === "FASTVIBE_LOCALE")?.value, other);
    await page.goto(origin);
    assert.equal(new URL(page.url()).pathname, `/${other}`);
    console.log(`PASS ${locale}/${colorScheme}: platform selector, modal, language switch & persistence`);

    const opposite = colorScheme === "light" ? "dark" : "light";
    await page.emulateMedia({ colorScheme: opposite });
    await assertTheme(page, opposite);
    await page.reload({ waitUntil: "networkidle" });
    await assertTheme(page, opposite);
    await page.locator(`.language-switch a[hreflang="${locale}"]`).click();
    await page.waitForURL(`**/${locale}`);
    await assertTheme(page, opposite);
    await page.emulateMedia({ colorScheme });
    await assertTheme(page, colorScheme);
    console.log(`PASS ${locale}/${colorScheme}: live system theme, reload, language switch, ignoring legacy preference`);
    await context.close();
    }
  }

  // The language and download content must work before client JavaScript runs.
  for (const locale of ["zh-CN", "en-US"]) {
    const colorScheme = locale === "zh-CN" ? "light" : "dark";
    const context = await browser.newContext({ locale, colorScheme, javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(origin);
    assert.equal(new URL(page.url()).pathname, `/${locale.startsWith("zh") ? "zh" : "en"}`);
    assert.equal(await page.locator(".download-link").count(), 5);
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
