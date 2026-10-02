// Some CDNs only serve media when the request carries the embedding page's Referer/Origin. Requests made by the
// extension itself (service worker, downloader page) don't have those, so declarativeNetRequest session rules set them.
// Session rules vanish when the browser closes.
//
// Two kinds of rule:
//  * tab-scoped (the downloader page passes its own tab id): matches only requests from that tab, wins over shared rules,
//    and is removed when the tab closes. Two downloader tabs for different sites on the same CDN host never interfere.
//  * shared (the service worker, which has no tab): one rule per host, used for the quick playlist/probe fetches. The
//    number of them is capped so a page that mentions thousands of hosts can't exhaust the rule budget.
//
// This does NOT work for chrome.downloads: measured in Chrome 154, requests from the browser's download manager are
// invisible to both declarativeNetRequest and webRequest, and download({headers}) rejects Referer/Origin ("Unsafe request
// header name"). Files that need the page's Referer therefore go through the built-in downloader (see background.js),
// which fetches from an extension page where these rules do apply.

import { hashToRuleId, originOf } from './util.js';

const MAX_SHARED_RULES = 200;
const TRIM_TO = 150;
const applied = new Map(); // ruleId -> page origin, avoids rewriting an identical rule

const hostOfUrl = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/**
 * Applies Referer/Origin to requests that originate from this extension towards `mediaUrl`'s domain, as if they came
 * from the page at `pageOrigin`. Pass `tabId` (the downloader page's own tab) for a tab-scoped rule.
 */
export async function ensureExtensionHeaders(mediaUrl, pageOrigin, { tabId = null } = {}) {
  const origin = originOf(pageOrigin);
  const host = hostOfUrl(mediaUrl);
  if (!origin || !host) return;
  const scoped = Number.isInteger(tabId) && tabId >= 0;
  const id = hashToRuleId(`${scoped ? `tab${tabId}` : 'ext'}:${host}`);
  if (applied.get(id) === origin) return;
  if (!scoped) await trimSharedRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: scoped ? 2 : 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: `${origin}/` },
            { header: 'origin', operation: 'set', value: origin },
          ],
        },
        condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id], ...(scoped ? { tabIds: [tabId] } : {}) },
      },
    ],
  });
  applied.set(id, origin);
}

/** Removes the rules scoped to a tab (call when the tab closes). */
export async function removeRulesForTab(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter((r) => r.condition.tabIds?.includes(tabId)).map((r) => r.id);
  if (!ids.length) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  for (const id of ids) applied.delete(id);
}

async function trimSharedRules() {
  const shared = (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => !r.condition.tabIds);
  if (shared.length < MAX_SHARED_RULES) return;
  const drop = shared.slice(0, shared.length - TRIM_TO).map((r) => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: drop });
  for (const id of drop) applied.delete(id);
}
