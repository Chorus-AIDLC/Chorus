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
const password = "aaaaaaaa";
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
  if (name.includes("initial-admin")) await page.getByRole("dialog").waitFor({ state: "hidden" });
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
    assert.equal(await page.locator("#adminName").getAttribute("required"), null, "first administrator display name is optional");
    await page.getByRole("button", { name: t("admin.createCompany"), exact: true }).waitFor();
    const invalidInputs = await page.locator("form input").evaluateAll((inputs) => inputs.filter((input) => !input.checkValidity()).map((input) => ({ id: input.id, reason: input.validationMessage })));
    assert.deepEqual(invalidInputs, [], "bootstrap native field validation");
    await screenshot(page, `${language}-${theme}-bootstrap-form`);
    const bootstrapResponse = await submit(page, "/api/admin/companies/local", page.getByRole("button", { name: t("admin.createCompany"), exact: true }));
    assert.equal(bootstrapResponse.status(), 200);
    const bootstrap = (await bootstrapResponse.json()).data;
    assert.equal(bootstrap.user.name, null);
    assert.match(bootstrap.credentialLink.url, /^\/login\/local\/accept\?token=/);
    const linkInput = page.getByLabel(t("admin.localBootstrap.invitationLink"));
    await linkInput.waitFor();
    let link = await linkInput.inputValue();
    assert.equal(new URL(link).origin, new URL(base).origin);
    await page.getByRole("button", { name: t("admin.localBootstrap.copyLink"), exact: true }).click();
    await page.getByRole("status").filter({ hasText: t("admin.localBootstrap.copied") }).waitFor();
    await screenshot(page, `${language}-${theme}-bootstrap`, [linkInput]);
    checks++;
    await page.getByRole("button", { name: t("admin.localBootstrap.continue"), exact: true }).click();
    await page.waitForURL(`**/admin/companies/${bootstrap.company.uuid}`);
    await page.getByText(t("admin.initialAdminInvitation.title"), { exact: true }).waitFor();
    const managementPath = `/api/admin/companies/${bootstrap.company.uuid}/initial-admin`;
    async function manage(action, expectedStatus = 200) {
      await page.getByRole("button", { name: t(`admin.initialAdminInvitation.${action}`), exact: true }).click();
      if (action === "replace") {
        await page.locator("#replacement-username").fill(id);
        await page.locator("#replacement-email").fill(`${id}@integration.local`);
        assert.equal(await page.locator("#replacement-name").getAttribute("required"), null);
      }
      const response = await submit(page, managementPath, page.getByRole("button", { name: t("workspaceUsers.confirm"), exact: true }));
      assert.equal(response.status(), expectedStatus);
      return (await response.json()).data;
    }
    async function invalidLink(previous) {
      const response = await context.request.post(`${base}/api/auth/local/accept`, { data: { token: new URL(previous).searchParams.get("token"), password } });
      assert.equal(response.status(), 400, "previous invitation is no longer usable");
    }
    const reissued = await manage("reinvite");
    assert.equal(reissued.user.uuid, bootstrap.user.uuid);
    await invalidLink(link);
    const managementLink = page.locator("#initial-admin-link");
    await managementLink.waitFor();
    link = await managementLink.inputValue();
    assert.equal(new URL(link).origin, new URL(base).origin);
    await page.getByRole("button", { name: t("workspaceUsers.copyLink"), exact: true }).click();
    assert((await page.evaluate(() => navigator.clipboard.readText())) === link, "clipboard contains the current-origin invitation");
    await screenshot(page, `${language}-${theme}-initial-admin-reinvite`, [managementLink]);
    const replaced = await manage("replace");
    assert.notEqual(replaced.user.uuid, reissued.user.uuid, "same identity replacement has a new UUID");
    assert.equal(replaced.user.name, null);
    await invalidLink(link);
    link = await managementLink.inputValue();
    await manage("revoke");
    await invalidLink(link);
    await page.getByText(t("admin.initialAdminInvitation.noInvitation"), { exact: true }).waitFor();
    await page.getByRole("button", { name: t("admin.initialAdminInvitation.invite"), exact: true }).click();
    await page.locator("#replacement-username").fill(id);
    await page.locator("#replacement-email").fill(`${id}@integration.local`);
    const restoredResponse = await submit(page, managementPath, page.getByRole("button", { name: t("workspaceUsers.confirm"), exact: true }));
    assert.equal(restoredResponse.status(), 200);
    const restored = (await restoredResponse.json()).data;
    assert.notEqual(restored.user.uuid, replaced.user.uuid);
    await managementLink.waitFor();
    link = await managementLink.inputValue();
    await screenshot(page, `${language}-${theme}-initial-admin-restored`, [managementLink]);
    checks += 4;
    const secondWorkspace = await context.request.post(`${base}/api/admin/companies/local`, { data: {
      name: `local-user-${id}-second`, initialAdmin: { username: id, email: `${id}@integration.local`, name: `Administrator ${id}` },
    } });
    assert.equal(secondWorkspace.status(), 200);
    const second = (await secondWorkspace.json()).data;
    const crossIdentity = await context.request.post(`${base}/api/admin/companies/${second.company.uuid}/initial-admin`, { data: { action: "revoke", expectedUserUuid: restored.user.uuid } });
    assert.equal(crossIdentity.status(), 409, "expected identity cannot target another tenant");
    // Superadmin and workspace user sessions are intentionally separate contexts.
    const userContext = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await userContext.addCookies([{ name: "chorus-locale", value: language, url: base }]);
    await userContext.addInitScript(({ theme, language }) => { localStorage.setItem("chorus-theme", theme); localStorage.setItem("chorus-locale", language); localStorage.setItem("chorus_onboarding_completed", "true"); }, { theme, language });
    const userPage = await userContext.newPage();
    assert.equal((await userContext.request.get(`${base}${managementPath}`)).status(), 401, "unauthenticated visitors cannot inspect the initial administrator");
    await userPage.goto(link, { waitUntil: "networkidle" });
    assert.equal(await userPage.getByRole("status").textContent(), t("login.local.requirementsMet").replace("{count}", "0").replace("{total}", "2"));
    await userPage.locator("#password").fill("aaaaaaa");
    assert.equal(await userPage.getByRole("status").textContent(), t("login.local.requirementsMet").replace("{count}", "1").replace("{total}", "2"));
    await userPage.locator("#password").fill(password);
    await userPage.locator("#confirmation").fill(password);
    assert.equal(await userPage.getByRole("status").textContent(), t("login.local.requirementsMet").replace("{count}", "2").replace("{total}", "2"));
    await userPage.getByRole("button", { name: t("login.local.showPassword"), exact: true }).click();
    assert.equal(await userPage.locator("#password").getAttribute("type"), "text");
    assert.equal(await userPage.locator("#confirmation").getAttribute("type"), "password");
    await userPage.getByRole("button", { name: t("login.local.showConfirmation"), exact: true }).click();
    assert.equal(await userPage.locator("#confirmation").getAttribute("type"), "text");
    await userPage.getByRole("button", { name: t("login.local.hidePassword"), exact: true }).click();
    await userPage.getByRole("button", { name: t("login.local.hideConfirmation"), exact: true }).click();
    assert.equal(new URL(userPage.url()).search, "");
    assert.equal(await userPage.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
    await screenshot(userPage, `${language}-${theme}-accept`);
    assert.equal((await submit(userPage, "/api/auth/local/accept", userPage.getByRole("button", { name: t("login.local.acceptSubmit"), exact: true }))).status(), 200);
    await userPage.waitForURL("**/login");
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(t("admin.initialAdminInvitation.activated"), { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: t("admin.initialAdminInvitation.reinvite"), exact: true }).count(), 0);
    const activatedMutation = await context.request.post(`${base}${managementPath}`, { data: { action: "reinvite", expectedUserUuid: restored.user.uuid } });
    assert.equal(activatedMutation.status(), 409, "Superadmin cannot mutate an activated bootstrap administrator");
    await screenshot(page, `${language}-${theme}-initial-admin-activated`);
    checks++;
    await userPage.getByLabel(t("login.email"), { exact: true }).fill(id);
    assert.equal((await submit(userPage, "/api/auth/identify", userPage.getByRole("button", { name: t("login.continue"), exact: true }))).status(), 200);
    await userPage.getByRole("button", { name: t("login.local.workspace").replace("{company}", `local-user-${id}-second`), exact: true }).waitFor();
    assert.equal(await userPage.getByRole("heading", { name: t("login.pickWorkspace.title"), exact: true }).count(), 1);
    assert.equal(await userPage.locator(".project-icon").count(), 2);
    assert.equal(await userPage.locator('[data-slot="card"]').first().evaluate(node => Math.round(node.getBoundingClientRect().width)), 440);
    assert.equal(await userPage.getByText(t("login.local.passwordSignIn"), { exact: true }).count(), 2);
    assert.equal(await userPage.locator('input[type="password"]').count(), 0);
    await screenshot(userPage, `${language}-${theme}-workspace-choice`);
    await userPage.getByRole("button", { name: t("login.local.workspace").replace("{company}", `local-user-${id}`), exact: true }).click();
    await userPage.locator("#local-password").fill(password);
    await userPage.getByRole("button", { name: t("login.local.showPassword"), exact: true }).click();
    assert.equal(await userPage.locator("#local-password").getAttribute("type"), "text");
    await userPage.getByRole("button", { name: t("login.local.hidePassword"), exact: true }).click();
    await screenshot(userPage, `${language}-${theme}-login`);
    assert.equal((await submit(userPage, "/api/auth/local/login", userPage.getByRole("button", { name: t("login.defaultAuth.submit"), exact: true }))).status(), 200);
    await userPage.waitForURL("**/projects");
    assert.equal((await userContext.request.get(`${base}${managementPath}`)).status(), 401, "Workspace Admin session does not grant Superadmin setup access");
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
    const usersResponse = await userContext.request.get(`${base}/api/workspace/users`);
    assert.equal(usersResponse.status(), 200);
    const users = (await usersResponse.json()).data;
    const self = users.find(user => user.username === id);
    assert(self, "find test administrator for reset");
    const resetResponse = await userContext.request.post(`${base}/api/workspace/users/${self.uuid}/credentials`, { data: { purpose: "reset" } });
    assert.equal(resetResponse.status(), 200);
    const resetLink = (await resetResponse.json()).data.credentialLink.url;
    await userPage.goto(new URL(resetLink, base).href, { waitUntil: "networkidle" });
    await userPage.locator("#password").fill(password);
    await userPage.locator("#confirmation").fill(password);
    assert.equal(await userPage.getByRole("status").textContent(), t("login.local.requirementsMet").replace("{count}", "2").replace("{total}", "2"));
    await screenshot(userPage, `${language}-${theme}-reset-eight-characters`);
    assert.equal((await submit(userPage, "/api/auth/local/accept", userPage.getByRole("button", { name: t("login.local.acceptSubmit"), exact: true }))).status(), 200);
    await userPage.waitForURL("**/login");
    checks += 6;
    console.log(`PASS Chromium ${language}/${theme}: bootstrap copy, eight-character accept/reset, live progress, independent visibility, restored picker, local login, settings theme, last-admin and duplicate errors`);
    await userContext.close(); await context.close();
  }
  console.log(`Browser verification complete: ${checks} grouped checks; screenshots .playwright-mcp/local-users-*.png (credential fields masked).`);
} finally { await browser.close(); }
