import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.CHORUS_SECURITY_PLAYWRIGHT_MODULE || 'playwright');
const [base, output, credentials]=process.argv.slice(2);
if(!base || !output || !credentials) throw new Error('Usage: node browser-check.mjs BASE_URL SCREENSHOT_DIR CREDENTIALS_JSON');
const state=JSON.parse(await fs.readFile(credentials,'utf8'));
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const result={browser:await browser.version(),base,errors};
try {
 await page.goto(base+'/login',{waitUntil:'domcontentloaded',timeout:45000});
 await page.locator('input[type="email"]').waitFor({state:'visible',timeout:30000});
 await page.evaluate(()=>localStorage.setItem('chorus-theme','light'));
 await page.reload({waitUntil:'domcontentloaded'});
 const submit=page.locator('button[type="submit"]');
 await submit.waitFor({state:'visible'});
 await page.waitForFunction(()=>document.styleSheets.length>0);
 result.light=await submit.evaluate(el=>({background:getComputedStyle(el).backgroundColor,padding:getComputedStyle(el).padding,bodyBackground:getComputedStyle(document.body).backgroundColor,stylesheets:document.styleSheets.length,width:el.getBoundingClientRect().width}));
 if(result.light.width===0 || result.light.stylesheets===0 || result.light.padding==='0px') throw new Error('Login CSS was not applied');
 await page.screenshot({path:path.join(output,'login-light.png'),fullPage:true,animations:'disabled'});
 await page.evaluate(()=>localStorage.setItem('chorus-theme','dark'));
 await page.reload({waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));
 result.dark=await page.locator('button[type="submit"]').evaluate(el=>({background:getComputedStyle(el).backgroundColor,bodyBackground:getComputedStyle(document.body).backgroundColor}));
 if(result.light.bodyBackground===result.dark.bodyBackground) throw new Error('Theme CSS did not change the page background');
 await page.screenshot({path:path.join(output,'login-dark.png'),fullPage:true,animations:'disabled'});
 await page.locator('input[type="email"]').fill(state.default_user);
 await page.locator('input[type="password"]').fill(state.default_password);
 await Promise.all([page.waitForURL(url=>url.pathname.startsWith('/projects') || url.pathname==='/onboarding',{timeout:45000,waitUntil:'domcontentloaded'}),page.locator('button[type="submit"]').click()]);
 if(new URL(page.url()).pathname==='/onboarding') {
  result.onboardingObserved=true;
  await page.getByRole('button',{name:'Skip for now',exact:true}).click();
  await page.waitForURL(url=>url.pathname.startsWith('/projects'),{timeout:45000,waitUntil:'domcontentloaded'});
 }
 await page.waitForLoadState('domcontentloaded');
 await page.getByRole('heading',{name:'Projects',exact:true}).first().waitFor({state:'visible',timeout:30000});
 result.authenticatedPath=new URL(page.url()).pathname;
 await page.getByText('Ungrouped',{exact:true}).waitFor({state:'visible'});
 const group=page.getByRole('button',{name:/Ungrouped/}).first();
 if(await group.getAttribute('data-state')==='closed') await group.click();
 await page.getByText('Security baseline project',{exact:true}).first().waitFor({state:'visible'});
 await page.waitForFunction(() => {
  const project = [...document.querySelectorAll('a')].find(el => el.textContent.includes('Security baseline project'));
  if (!project) return false;
  const box = project.getBoundingClientRect();
  if (box.height < 20 || box.width === 0) return false;
  for (let el = project; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (Number(style.opacity) < 0.99) return false;
    if (['hidden', 'clip'].includes(style.overflowY) && el.getBoundingClientRect().bottom < box.bottom - 1) return false;
  }
  return true;
 });
 result.baselineProjectVisible=true;
 result.projectAnimationsSettled=true;
 await page.screenshot({path:path.join(output,'projects-dark.png'),fullPage:true,animations:'disabled'});
 result.projectsText=(await page.locator('body').innerText()).slice(0,3000);
 if(errors.length) throw new Error('Browser page errors: '+errors.join('; '));
 result.passed=true;
} finally {
 await fs.writeFile(path.join(output,'browser-result.json'),JSON.stringify(result,null,2));
 await browser.close();
}
process.stdout.write(JSON.stringify({browser:result.browser,passed:result.passed,path:result.authenticatedPath,light:result.light,dark:result.dark})+"\n");
