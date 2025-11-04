// ========== SETTINGS ==========
const DEFAULT_SETTINGS = { autoToast: true, warnEnabled: true, warnThreshold: 25 };
let SETTINGS = { ...DEFAULT_SETTINGS };
async function loadSettings(){
  const s = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  SETTINGS = { ...DEFAULT_SETTINGS, ...s };
}
loadSettings();
chrome.storage.onChanged.addListener((chg, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(chg)) SETTINGS[k] = chg[k].newValue;
});

// ========== UTILS ==========
const lc = s => (s||"").toLowerCase();
const host = (u)=>{ try { return new URL(u).hostname; } catch { return ""; } };
const rootHost = (h)=> h.replace(/^www\./i,"").split(".").slice(-2).join(".");
const is3p = (req, main)=> rootHost(host(req)) !== rootHost(host(main));
const badgeColor = (n)=> n>=80?"#1a7f37":n>=60?"#b7791f":"#c53030";

// ========== PER-TAB DOMAIN GUARD (run once per root) ==========
/** last root scored per tab, so reddit post paths don’t rescore */
const lastRootByTab = new Map();   // tabId -> root
/** short memory per root (avoid spamming toast if you bounce around) */
const recentlyScored = new Map();  // root -> timestamp

// ========== SIGNAL STORAGE ==========
/** transient capture by tab during load */
const tabState = new Map();

// ========== HEURISTICS ==========
const TRACKER_DOMAINS = [
  "doubleclick.net","googletagmanager.com","google-analytics.com","analytics.google.com","g.doubleclick.net",
  "facebook.net","connect.facebook.net","clarity.ms","bat.bing.com","hotjar.com","segment.com","segment.io",
  "mixpanel.com","optimizely.com","scorecardresearch.com","quantserve.com","taboola.com","criteo.com",
  "branch.io","cdn.branch.io","appsflyer.com","amplitude.com","newrelic.com","intercom.io"
];
const SUSPICIOUS_SNIPPETS = ["coinhive","cryptominer","adsterra","propellerads","pushsdk","bestcontent"];

// Danger list & checks that won’t hit mainstream sites
const SUS_TLDS = ["zip","mov","tk","gq","work","xyz"]; // common scammy tlds
const PUNYCODE = /^xn--/i;
const MANY_HYPHENS = /-.*-.*-/;
const IP_HOST = /^(?:\d{1,3}\.){3}\d{1,3}$/;

const DANGER_WORDS = [
  // URL or policy “vibes”
  "free crypto","get rich quick","casino bonus","no verification","win money","bet now","unlock download",
  "download crack","serial key","loan instantly","adult cams", "xxx live"
];

// ===== PRIVACY PAGE LEXICON (kept high-level) =====
const KW = {
  sell: /(sell|monetiz(e|ation)|data broker|share for money)/i,
  ads: /(advertis|adtech|targeted|behavio(u)?ral|personaliz)/i,
  combine: /(combine|link|match).{0,20}(data|information)/i,
  sensitive: /(biometric|genetic|racial|religion|sexual|health|precise location|contacts|messages|camera|microphone)/i,
  retention: /(retain|retention|store).{0,40}\b(\d+\s*(years?|months?))\b/i,
  rights: /\b(ccpa|cpra|gdpr|your rights|access|delete|erasure|portability)\b/i,
  opt: /\b(opt[- ]out|unsubscribe|do not track|limit use|object)\b/i,
  dns: /\b(do not sell|don’t sell|do not share)\b/i
};

// ========== NAVIGATION START ==========
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "loading" || !tab.url) return;

  const r = rootHost(host(tab.url));
  // if same root as last time in this tab: skip capture; we'll still let onUpdated "complete" decide
  // but we want to avoid recompute if root unchanged.
  // Prepare state anyway (so if root changed later we have a clean slate).
  tabState.set(tabId, {
    url: tab.url,
    root: r,
    protocol: (()=>{try{return new URL(tab.url).protocol;}catch{return "";}})(),
    req: { first:0, third:0, trackers:new Set(), suspicious:new Set() },
    cookies: [],
    hsts:false,
    sec:{ csp:null, referrer:null, perm:null, coop:null, coep:null },
    policy:{ has:false, rights:false, opt:false, dns:false, raw:"" },
    dom:{ iframes:0, pixels:0, login:false, metaTrackers:false, urlParams:false }
  });
  chrome.action.setBadgeText({ tabId, text: "" });
});

// ========== NETWORK HEADERS ==========
chrome.webRequest.onHeadersReceived.addListener((d)=>{
  const st = tabState.get(d.tabId); if(!st) return;

  if (d.type !== "image" && d.type !== "stylesheet") {
    if (is3p(d.url, st.url)) st.req.third++; else st.req.first++;
    const h = host(d.url);
    if (TRACKER_DOMAINS.some(t => h.endsWith(t) || h===t)) st.req.trackers.add(h);
    if (SUSPICIOUS_SNIPPETS.some(s => h.includes(s))) st.req.suspicious.add(h);
  }
  if (d.type === "main_frame") {
    for (const H of (d.responseHeaders||[])) {
      const n = H.name.toLowerCase();
      if (n==="content-security-policy") st.sec.csp = H.value;
      if (n==="referrer-policy") st.sec.referrer = H.value;
      if (n==="permissions-policy"||n==="feature-policy") st.sec.perm = H.value;
      if (n==="cross-origin-opener-policy") st.sec.coop = H.value;
      if (n==="cross-origin-embedder-policy") st.sec.coep = H.value;
      if (n==="strict-transport-security") st.hsts = true;
    }
  }
  (d.responseHeaders||[]).forEach(H=>{
    if (H.name.toLowerCase()==="set-cookie") st.cookies.push(H.value);
  });
},{urls:["<all_urls>"]},["responseHeaders"]);

// ========== DOM SIGNALS FROM CONTENT ==========
chrome.runtime.onMessage.addListener((msg, sender)=>{
  if (msg?.type==="DOM_SIGNALS" && sender.tab?.id!=null) {
    const st = tabState.get(sender.tab.id); if(!st) return;
    st.dom = { ...st.dom, ...msg.payload };
  }
});

// ========== PRIVACY PAGE ==========
async function guessPrivacyUrl(mainUrl){
  let u; try{u=new URL(mainUrl);}catch{return null;}
  if (u.protocol!=="http:" && u.protocol!=="https:") return null;
  const c=[`${u.origin}/privacy`,`${u.origin}/privacy-policy`,`${u.origin}/legal/privacy`,`${u.origin}/policies/privacy`];
  for (const x of c){ try{ const r=await fetch(x); if(r.ok) return x; }catch{} }
  return null;
}
async function fetchTxt(url){ const r=await fetch(url); return await r.text(); }
function analyzePolicy(low){
  if(!low) return { has:false, rights:false, opt:false, dns:false, flags:{} };
  return {
    has:true,
    rights:!!low.match(KW.rights),
    opt:!!low.match(KW.opt),
    dns:!!low.match(KW.dns),
    flags:{
      sell:!!low.match(KW.sell),
      ads:!!low.match(KW.ads),
      combine:!!low.match(KW.combine),
      sensitive:!!low.match(KW.sensitive),
      retention:!!low.match(KW.retention)
    }
  };
}

// ========== SCORING ==========
function summarizeCookies(items){
  const r={total:items.length,secure:0,httpOnly:0,sameSite:0};
  items.forEach(v=>{ const L=lc(v); if(L.includes("secure"))r.secure++; if(L.includes("httponly"))r.httpOnly++; if(L.includes("samesite"))r.sameSite++; });
  return r;
}

function scoreAndExplain(st){
  const reasons=[]; let pts=0;

  // A) transport & headers
  if (st.protocol==="https:"){ pts+=7; reasons.push("Uses a secure connection."); }
  if (st.hsts){ pts+=3; reasons.push("Forces secure connections by default."); }

  const csp=lc(st.sec.csp||""), ref=lc(st.sec.referrer||""), perm=lc(st.sec.perm||""),
        coop=lc(st.sec.coop||""), coep=lc(st.sec.coep||"");

  let cspPts=0;
  if (csp){
    cspPts+=5;
    if (csp.includes("script-src 'self'") && !csp.includes("*")) cspPts+=3;
    if (csp.includes("object-src 'none'")) cspPts+=2;
    if (csp.includes("upgrade-insecure-requests")) cspPts+=1;
    if (csp.includes("frame-ancestors 'none'") || csp.includes("frame-ancestors 'self'")) cspPts+=1;
    reasons.push("Has protections against unsafe content.");
  } else reasons.push("Missing some protection headers.");
  pts += Math.min(12, cspPts);

  if (ref){ pts+=4; reasons.push("Limits what other sites can learn via the address bar."); }
  if (perm){ pts+=2; reasons.push("Restricts access to powerful browser features."); }
  if (coop){ pts+=2; reasons.push("Isolates the page from other tabs."); }
  if (coep){ pts+=2; reasons.push("Prevents risky cross-origin embedding."); }

  // B) network behavior
  const total = st.req.first + st.req.third || 1;
  const share3p = st.req.third / total;
  const inv3p = 1 - Math.min(1, share3p);
  const thirdPts = Math.round(25 * inv3p);
  pts += thirdPts;
  reasons.push(inv3p>0.75?"Mostly keeps data to itself.":inv3p>0.4?"Shares some data with outside services.":"Relies heavily on outside services.");

  const trackers = st.req.trackers.size;
  const suspicious = st.req.suspicious.size;
  pts += (12 - Math.min(12, trackers*3));
  pts += (15 - Math.min(15, suspicious*8));
  if (trackers===0) reasons.push("No common trackers seen.");
  else reasons.push("Uses common tracking services.");
  if (suspicious>0) reasons.push("Some network calls looked sketchy.");

  // C) cookies & DOM
  const ck = summarizeCookies(st.cookies);
  pts += Math.round(6*(ck.secure/(ck.total||1)) + 4*(ck.httpOnly/(ck.total||1)) + 2*(ck.sameSite/(ck.total||1)));
  reasons.push("Cookie settings lean more/less on the safe side.");
  if (st.dom.pixels>0) { pts -= Math.min(4, st.dom.pixels); reasons.push("Tiny tracking pixels found."); }
  if (st.dom.iframes>4) { pts -= Math.min(4, st.dom.iframes-4); reasons.push("Many embedded iframes."); }
  if (st.dom.metaTrackers) { pts -= 3; reasons.push("Advertising tags detected in the page."); }
  if (st.dom.urlParams) { pts -= 2; reasons.push("Tracking codes present in the URL."); }

  // D) policy tone
  let pol=0;
  if (st.policy.has){
    reasons.push("Has a privacy page you can read.");
    if (st.policy.rights) { pol+=6; reasons.push("Mentions your privacy rights."); }
    if (st.policy.opt) { pol+=5; reasons.push("Offers ways to opt out."); }
    if (st.policy.dns) { pol+=3; reasons.push("Mentions “Do Not Sell/Share”."); }
    if (st.policy.flags.sell) { pol-=6; reasons.push("Talks about selling or monetizing data."); }
    if (st.policy.flags.ads) { pol-=4; reasons.push("Mentions targeted advertising."); }
    if (st.policy.flags.combine) { pol-=3; reasons.push("Combines data with other sources."); }
    if (st.policy.flags.sensitive) { pol-=5; reasons.push("May handle sensitive data."); }
    if (st.policy.flags.retention) { pol-=2; reasons.push("Keeps data for a long time."); }
  } else reasons.push("Couldn’t find a clear privacy page.");
  pts += Math.max(-12, Math.min(20, pol));

  // E) overall posture bonus
  const strongCSP = !!(csp && csp.includes("object-src 'none'") && csp.includes("script-src 'self'") && !csp.includes("*"));
  const strictRef = !!(ref && (ref.includes("no-referrer") || ref.includes("strict-origin-when-cross-origin")));
  const hardenedCookies = (ck.total>0) && (ck.secure/(ck.total||1) >= 0.85) && (ck.httpOnly/(ck.total||1) >= 0.6);
  const isolated = !!(coop && coep);
  const veryLow3p = (1 - Math.min(1, share3p)) >= 0.85 && trackers===0 && suspicious===0;

  let bonus=0;
  if (st.protocol==="https:" && st.hsts) bonus+=2;
  if (strongCSP) bonus+=4;
  if (strictRef) bonus+=3;
  if (isolated) bonus+=3;
  if (hardenedCookies) bonus+=1;
  if (veryLow3p) bonus+=10;
  if (bonus>=8) reasons.push("Strong overall privacy posture.");
  pts += Math.min(12, bonus);

  // clamp + gentle top lift
  let score = Math.max(0, Math.min(100, Math.round(pts)));
  if (score>=60 && veryLow3p && strongCSP) score = Math.min(100, score+7);

  return { score, reasons, cookies:ck, share3p, trackers, suspicious };
}

// ========== DANGER DETECTION ==========
function looksDangerous(u, st){
  const h = host(u); const r = rootHost(h).toLowerCase();

  // weird domains/tlds/punycode/ip/too-many-hyphens
  const parts = h.split(".");
  const tld = parts[parts.length-1]?.toLowerCase()||"";
  if (SUS_TLDS.includes(tld)) return "Uncommon, high-risk domain ending.";
  if (PUNYCODE.test(h)) return "Suspicious encoded domain.";
  if (MANY_HYPHENS.test(h)) return "Odd, hyphen-heavy domain.";
  if (IP_HOST.test(h)) return "Bare IP address domain.";

  // URL “vibes”
  const urlLow = lc(u);
  if (DANGER_WORDS.some(w=>urlLow.includes(w))) return "Risky wording in the URL.";

  // No HTTPS + heavy 3P + suspicious endpoints
  const total = st.req.first + st.req.third || 1;
  const share3p = st.req.third / total;
  if (st.protocol!=="https:" && share3p>0.5) return "No HTTPS and heavy third-party calls.";

  if (st.req.suspicious.size>0) return "Connections to shady endpoints detected.";

  // Privacy page language (super red flags)
  const txt = lc(st.policy.raw || "");
  if (txt && (/malware|phishing|keylogger|spreader|backdoor/i).test(txt)) return "Danger terms found in the policy page.";

  return null; // looks normal enough
}

// ========== FINALIZE ON COMPLETE (once per root) ==========
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url) return;

  const st = tabState.get(tabId); if(!st) return;
  const rh = st.root;

  // run once per root in this tab
  const last = lastRootByTab.get(tabId);
  if (last === rh) return; // same root → do nothing
  lastRootByTab.set(tabId, rh);

  // rate-limit per root (don’t toast every few seconds if user bounces)
  const now = Date.now();
  const lastWhen = recentlyScored.get(rh) || 0;
  if (now - lastWhen < 8000) return; // 8s guard
  recentlyScored.set(rh, now);

  // try privacy page
  try{
    const cand = await guessPrivacyUrl(st.url);
    if (cand) {
      st.policy.has = true;
      const txt = await fetchTxt(cand);
      st.policy.raw = txt;
      const a = analyzePolicy(lc(txt));
      st.policy.rights=a.rights; st.policy.opt=a.opt; st.policy.dns=a.dns; st.policy.flags=a.flags;
    }
  }catch{}

  const result = scoreAndExplain(st);

  // store by root (so popup/learn are stable and path changes won’t break)
  const rootKey = "score_root_" + rh;
  await chrome.storage.local.set({
    [rootKey]: { score: result.score, state: {
      url: st.url, root: rh, protocol: st.protocol, hsts: st.hsts,
      req: { first: st.req.first, third: st.req.third, trackers: [...st.req.trackers], suspicious: [...st.req.suspicious] },
      cookies: result.cookies, sec: st.sec, policy: st.policy, reasons: result.reasons, dom: st.dom
    }},
    lastWrite: Date.now()
  });

  // badge (one per root)
  chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor(result.score) });
  chrome.action.setBadgeText({ tabId, text: String(result.score) });

  // danger check (special case)
  const danger = looksDangerous(st.url, st);
  if (danger) {
    chrome.tabs.sendMessage(tabId, { type:"SITE_SCORE_DANGER", reason: danger, score: result.score });
  } else {
    if (SETTINGS.autoToast) chrome.tabs.sendMessage(tabId, { type:"SITE_SCORE_TOAST", score: result.score });
    if (SETTINGS.warnEnabled && result.score < SETTINGS.warnThreshold)
      chrome.tabs.sendMessage(tabId, { type:"SITE_SCORE_WARN", score: result.score });
  }
});

// ========== RPC FOR POPUP/LEARN (by root) ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if (msg?.type==="GET_BY_ROOT") {
    const r = rootHost(host(msg.url||""));
    chrome.storage.local.get("score_root_" + r).then(res => sendResponse(res["score_root_" + r] || null));
    return true;
  }
});
