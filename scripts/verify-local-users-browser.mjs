#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = process.env.LOCAL_USERS_PLAYWRIGHT_MODULE
  ? require(process.env.LOCAL_USERS_PLAYWRIGHT_MODULE) : await import("playwright");
const base = process.env.LOCAL_USERS_TEST_URL;
assert(process.env.LOCAL_USERS_TEST_ISOLATED === "1" && base, "Explicit disposable stack required");
const url = new URL(base);
assert(["localhost", "127.0.0.1"].includes(url.hostname) && url.port !== "8637", "Refusing normal/nonlocal app");
assert(process.env.LOCAL_USERS_TEST_ADMIN_EMAIL && process.env.LOCAL_USERS_TEST_ADMIN_PASSWORD, "Test admin credentials required");
await mkdir(".playwright-mcp", { recursive: true });
const browser = await chromium.launch({ headless: true });
const password = "browser-local-password-123";
let checks = 0;
async function submit(page, path, button) {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith(path) && response.request().method() === "POST");
  const [response] = await Promise.all([responsePromise, button.click()]);
  if (response.status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, (Number(response.headers()["retry-after"]) || 60) * 1000 + 100));
    return submit(page, path, button);
  }
  return response;
}
async function screenshot(page, name, mask = []) {
  await page.screenshot({ path: `.playwright-mcp/local-users-${name}.png`, fullPage: true, mask });
}
try {
  for (const language of ["en", "zh"]) for (const theme of ["light", "dark"]) {
    const messages = JSON.parse(await readFile(`messages/${language}.json`, "utf8"));
    const t = (key) => key.split(".").reduce((node, part) => node[part], messages);
    const id = `browser-${language}-${theme}-${Date.now().toString(36)}`;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.addCookies([{ name: "chorus-locale", value: language, url: base }]);
    await context.addInitScript(({ theme, language }) => {
      localStorage.setItem("chorus-theme", theme);
      localStorage.setItem("chorus-locale", language);
      localStorage.setItem("chorus_onboarding_completed", "true");
    }, { theme, language });
    const page = await context.newPage();
    await page.goto(`${base}/login/admin`, { waitUntil: "networkidle" });
    await page.locator("#email").fill(process.env.LOCAL_USERS_TEST_ADMIN_EMAIL);
    await page.locator("#password").fill(process.env.LOCAL_USERS_TEST_ADMIN_PASSWORD);
    assert.deepEqual(await page.locator("form input").evaluateAll((inputs) => inputs.filter((input) => !input.checkValidity()).map((input) => input.id)), [], "admin native validation");
    await screenshot(page, `${language}-${theme}-admin-login`, [page.locator("#password")]);
    assert.equal((await submit(page, "/api/admin/login", page.getByRole("button", { name: t("admin.signInAsAdmin"), exact: true }))).status(), 200);
    await page.waitForURL("**/admin");
    await page.goto(`${base}/admin/companies/new`, { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: t("admin.localBootstrap.localMode"), exact: true }).click();
    await page.locator("#name").fill(`local-user-${id}`);
    await page.locator("#adminUsername").fill(id);
    await page.locator("#adminEmail").fill(`${id}@integration.local`);
    await page.locator("#adminName").fill(`Administrator ${id}`);
    await page.getByRole("button", { name: t("admin.createCompany"), exact: true }).waitFor();
    const invalidInputs = await page.locator("form input").evaluateAll((inputs) => inputs.filter((input) => !input.checkValidity()).map((input) => ({ id: input.id, reason: input.validationMessage })));
    assert.deepEqual(invalidInputs, [], "bootstrap native field validation");
    await screenshot(page, `${language}-${theme}-bootstrap-form`);
    assert.equal((await submit(page, "/api/admin/companies/local", page.getByRole("button", { name: t("admin.createCompany"), exact: true }))).status(), 200);
    const linkInput = page.getByLabel(t("admin.localBootstrap.invitationLink"));
    await linkInput.waitFor();
    const link = await linkInput.inputValue();
    await page.getByRole("button", { name: t("admin.localBootstrap.copyLink"), exact: true }).click();
    await page.getByRole("status").filter({ hasText: t("admin.localBootstrap.copied") }).waitFor();
    await screenshot(page, `${language}-${theme}-bootstrap`, [linkInput]);
    checks++;
    const secondWorkspace = await context.request.post(`${base}/api/admin/companies/local`, { data: {
      name: `local-user-${id}-second`, initialAdmin: { username: id, email: `${id}@integration.local`, name: `Administrator ${id}` },
    } });
    assert.equal(secondWorkspace.status(), 200);
    // Superadmin and workspace user sessions are intentionally separate contexts.
    const userContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await userContext.addCookies([{ name: "chorus-locale", value: language, url: base }]);
    await userContext.addInitScript(({ theme, language }) => { localStorage.setItem("chorus-theme", theme); localStorage.setItem("chorus-locale", language); localStorage.setItem("chorus_onboarding_completed", "true"); }, { theme, language });
    const userPage = await userContext.newPage();
    await userPage.goto(link, { waitUntil: "networkidle" });
    await userPage.locator("#password").fill(password);
    await userPage.locator("#confirmation").fill(password);
    assert.equal(new URL(userPage.url()).search, "");
    assert.equal(await userPage.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
    await screenshot(userPage, `${language}-${theme}-accept`);
    assert.equal((await submit(userPage, "/api/auth/local/accept", userPage.getByRole("button", { name: t("login.local.acceptSubmit"), exact: true }))).status(), 200);
    await userPage.waitForURL("**/login");
    await userPage.getByLabel(t("login.email"), { exact: true }).fill(id);
    assert.equal((await submit(userPage, "/api/auth/identify", userPage.getByRole("button", { name: t("login.continue"), exact: true }))).status(), 200);
    await userPage.getByRole("button", { name: t("login.local.workspace").replace("{company}", `local-user-${id}-second`), exact: true }).waitFor();
    await screenshot(userPage, `${language}-${theme}-workspace-choice`);
    await userPage.getByRole("button", { name: t("login.local.workspace").replace("{company}", `local-user-${id}`), exact: true }).click();
    await userPage.locator("#local-password").fill(password);
    await screenshot(userPage, `${language}-${theme}-login`);
    assert.equal((await submit(userPage, "/api/auth/local/login", userPage.getByRole("button", { name: t("login.defaultAuth.submit"), exact: true }))).status(), 200);
    await userPage.waitForURL("**/projects");
    await userPage.goto(`${base}/settings/users`, { waitUntil: "networkidle" });
    await userPage.getByRole("heading", { name: t("workspaceUsers.title"), exact: true }).waitFor();
    await userPage.getByRole("cell", { name: id, exact: true }).waitFor();
    assert.equal(await userPage.locator("html").evaluate((node) => node.classList.contains("dark")), theme === "dark");
    await screenshot(userPage, `${language}-${theme}-settings`);
    // Last administrator protection is visible as localized mutation feedback.
    await userPage.getByRole("button", { name: t("workspaceUsers.actionsFor").replace("{username}", id), exact: true }).click();
    await userPage.getByRole("menuitem", { name: t("workspaceUsers.actions.disable"), exact: true }).click();
    await userPage.getByRole("button", { name: t("workspaceUsers.confirm"), exact: true }).click();
    await userPage.getByRole("alert").filter({ hasText: t("workspaceUsers.errors.lastAdmin") }).waitFor();
    await screenshot(userPage, `${language}-${theme}-last-admin`);
    await userPage.getByRole("button", { name: t("workspaceUsers.cancel"), exact: true }).click();
    // Invite a member, then demonstrate a real duplicate rejection.
    await userPage.getByRole("button", { name: t("workspaceUsers.actions.invite"), exact: true }).click();
    await userPage.locator("#local-username").fill(`member-${id}`);
    await userPage.locator("#local-email").fill(`member-${id}@integration.local`);
    assert.equal((await submit(userPage, "/api/workspace/users", userPage.getByRole("button", { name: t("workspaceUsers.save"), exact: true }))).status(), 200);
    const credential = userPage.getByLabel(t("workspaceUsers.issuedLink"), { exact: true });
    await credential.waitFor();
    await screenshot(userPage, `${language}-${theme}-invite`, [credential]);
    await userPage.getByRole("dialog").locator('[data-slot="dialog-footer"]').getByRole("button", { name: t("workspaceUsers.close"), exact: true }).click();
    await userPage.getByRole("button", { name: t("workspaceUsers.actions.invite"), exact: true }).click();
    await userPage.locator("#local-username").fill(`member-${id}`);
    await userPage.locator("#local-email").fill(`other-${id}@integration.local`);
    assert.equal((await submit(userPage, "/api/workspace/users", userPage.getByRole("button", { name: t("workspaceUsers.save"), exact: true }))).status(), 409);
    await userPage.getByRole("alert").filter({ hasText: t("workspaceUsers.errors.duplicate") }).waitFor();
    await screenshot(userPage, `${language}-${theme}-duplicate`);
    checks += 5;
    console.log(`PASS Chromium ${language}/${theme}: bootstrap copy, accept/no-referrer, local login, settings theme, last-admin and duplicate errors`);
    await userContext.close(); await context.close();
  }
  console.log(`Browser verification complete: ${checks} grouped checks; screenshots .playwright-mcp/local-users-*.png (credential fields masked).`);
} finally { await browser.close(); }
