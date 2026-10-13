import './deny-network.mjs';
import { createRequire } from 'node:module';
const require=createRequire('/Users/admin/.codex/worktrees/panel-remaining-review-20261012/codeshell-panel-apps/package.json');
const {chromium}=require('playwright');
const launch=chromium.launch.bind(chromium);
chromium.launch=async options=>{
 const browser=await launch({...options,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:[...(options?.args??[]),'--disable-background-networking']});
 const newPage=browser.newPage.bind(browser);
 browser.newPage=async options=>{const page=await newPage(options);await page.route('**/*',route=>route.abort());return page;};
 return browser;
};
