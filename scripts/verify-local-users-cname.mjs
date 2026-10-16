#!/usr/bin/env node
// Chromium's resolver maps this test-only public alias to the disposable app.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { request } from "node:http";
const require = createRequire(import.meta.url);
const { chromium } = process.env.LOCAL_USERS_PLAYWRIGHT_MODULE
  ? require(process.env.LOCAL_USERS_PLAYWRIGHT_MODULE) : await import("playwright");
const target = new URL(process.env.LOCAL_USERS_TEST_URL || "http://invalid");
assert(process.env.LOCAL_USERS_TEST_ISOLATED === "1" && ["localhost", "127.0.0.1"].includes(target.hostname) && target.port === "8640", "Explicit disposable stack on 8640 required");
assert(process.env.LOCAL_USERS_TEST_ADMIN_EMAIL && process.env.LOCAL_USERS_TEST_ADMIN_PASSWORD, "Test admin credentials required");
// Clipboard access needs a genuine secure context on a non-localhost alias.
let origin;
const certificateDirectory = await mkdtemp(join(tmpdir(), "chorus-cname-"));
let proxy, browser;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=chorus-cname.test", "-keyout", join(certificateDirectory, "key.pem"), "-out", join(certificateDirectory, "cert.pem")], { stdio: "ignore" });
  proxy = createServer({ key: await readFile(join(certificateDirectory, "key.pem")), cert: await readFile(join(certificateDirectory, "cert.pem")) }, (incoming, outgoing) => {
    const upstream = request(new URL(incoming.url, target), { method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", error => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  origin = `https://chorus-cname.test:${proxy.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP chorus-cname.test 127.0.0.1", "--no-proxy-server"] });
  for (const [language, theme] of [["en", "light"], ["zh", "dark"]]) {
    const messages = JSON.parse(await readFile(`messages/${language}.json`, "utf8"));
    const t = key => key.split(".").reduce((node, part) => node[part], messages);
    const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["clipboard-read", "clipboard-write"] });
    try {
      await context.addCookies([{ name: "chorus-locale", value: language, url: origin }]);
      await context.addInitScript(({ language, theme }) => { localStorage.setItem("chorus-locale", language); localStorage.setItem("chorus-theme", theme); localStorage.setItem("chorus_onboarding_completed", "true"); }, { language, theme });
      const page = await context.newPage();
      await page.goto(`${origin}/login/admin`, { waitUntil: "networkidle" });
      await page.locator("#email").fill(process.env.LOCAL_USERS_TEST_ADMIN_EMAIL);
      await page.locator("#password").fill(process.env.LOCAL_USERS_TEST_ADMIN_PASSWORD);
      await page.getByRole("button", { name: t("admin.signInAsAdmin"), exact: true }).click();
      await page.waitForURL("**/admin");
      await page.getByRole("link", { name: t("admin.companies"), exact: true }).waitFor();
      await page.goto(`${origin}/admin/companies/new`, { waitUntil: "networkidle" });
      await page.getByRole("radio", { name: t("admin.localBootstrap.localMode"), exact: true }).click();
      const id = `cname-${language}-${Date.now().toString(36)}`;
      await page.locator("#name").fill(`local-user-${id}`);
      await page.locator("#adminUsername").fill(id);
      await page.locator("#adminEmail").fill(`${id}@integration.local`);
      await page.getByRole("button", { name: t("admin.createCompany"), exact: true }).click();
      const issued = page.locator("#credentialLink");
      await issued.waitFor();
      const link = await issued.inputValue();
      assert(new URL(link).origin === origin, "bootstrap copy field uses actual browser alias");
      await page.getByRole("button", { name: t("admin.localBootstrap.copyLink"), exact: true }).click();
      assert((await page.evaluate(() => navigator.clipboard.readText())) === link, "bootstrap clipboard uses browser alias");
      await page.getByRole("button", { name: t("admin.localBootstrap.continue"), exact: true }).click();
      await page.getByRole("button", { name: t("admin.initialAdminInvitation.reinvite"), exact: true }).click();
      await page.getByRole("button", { name: t("workspaceUsers.confirm"), exact: true }).click();
      const reissued = page.locator("#initial-admin-link");
      await reissued.waitFor();
      const fresh = await reissued.inputValue();
      assert(new URL(fresh).origin === origin, "reissue field uses actual browser alias");
      assert(new URL(fresh).search !== new URL(link).search, "reissue creates a fresh credential");
      await page.getByRole("button", { name: t("workspaceUsers.copyLink"), exact: true }).click();
      assert((await page.evaluate(() => navigator.clipboard.readText())) === fresh, "reissue clipboard uses browser alias");
      await page.goto(fresh, { waitUntil: "networkidle" });
      await page.locator("#password").fill("aaaaaaaa");
      await page.locator("#confirmation").fill("aaaaaaaa");
      const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/auth/local/accept") && response.request().method() === "POST");
      await page.getByRole("button", { name: t("login.local.acceptSubmit"), exact: true }).click();
      assert((await responsePromise).status() === 200, "current-alias link reaches actual credential acceptance");
      await page.waitForURL("**/login");
      assert(new URL(page.url()).origin === origin, "acceptance retains alias");
      assert((await page.locator("html").evaluate(node => node.classList.contains("dark"))) === (theme === "dark"), "actual theme");
      console.log(`PASS CNAME ${language}/${theme}: actual browser alias bootstrap/reissue fields and clipboard, optional name, new token, real acceptance`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  if (proxy?.listening) {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
  }
  await rm(certificateDirectory, { recursive: true, force: true });
}
