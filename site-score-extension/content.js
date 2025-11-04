function colorForScore(n){ if(n>=80)return"#1a7f37"; if(n>=60)return"#b7791f"; return"#c53030"; }

// Toast
function showToast(score){
  const last=Number(sessionStorage.getItem("siteScoreToastClosedAt")||0);
  if(Date.now()-last<20*60*1000) return;
  let el=document.getElementById("siteScoreToast");
  if(!el){
    el=document.createElement("div"); el.id="siteScoreToast";
    el.innerHTML=`<div class="dot"></div><div><b>${score}/100</b> Site score</div><button title="Hide">✕</button>`;
    document.documentElement.appendChild(el);
    el.querySelector("button").onclick=()=>{el.remove(); sessionStorage.setItem("siteScoreToastClosedAt", String(Date.now()));};
  } else el.querySelector("div b").textContent=`${score}/100`;
  el.querySelector(".dot").style.background=colorForScore(score);
  requestAnimationFrame(()=>el.classList.add("show"));
  setTimeout(()=>el && el.remove(), 5000);
}

// Low-score warn
function showWarn(score){
  if(document.getElementById("siteScoreWarn"))return;
  const w=document.createElement("div"); w.id="siteScoreWarn";
  w.innerHTML=`<div class="modal-card"><h3>Heads up: this site may track a lot</h3>
  <div class="muted">We detected weak privacy signals. You can dismiss this and continue.</div>
  <div class="row"><div class="score">${score}</div><div>Consider limiting personal data on this site.</div></div>
  <div class="btns"><button id="warn-dismiss">Dismiss</button></div></div>`;
  document.documentElement.appendChild(w);
  document.getElementById("warn-dismiss").onclick=()=>w.remove();
}

// Danger modal (special case that won’t show on mainstream sites)
function showDanger(reason, score){
  if(document.getElementById("siteScoreDanger"))return;
  const d=document.createElement("div"); d.id="siteScoreDanger";
  d.innerHTML=`<div class="modal-card"><h3>⚠️ Potentially unsafe site</h3>
  <div class="muted">This site triggered multiple red flags that are unusual for legitimate sites.</div>
  <div class="row"><div class="score">${score}</div><div>${reason}</div></div>
  <div class="btns"><button id="danger-dismiss">I understand</button></div></div>`;
  document.documentElement.appendChild(d);
  document.getElementById("danger-dismiss").onclick=()=>d.remove();
}

chrome.runtime.onMessage.addListener((m)=>{
  if(m?.type==="SITE_SCORE_TOAST") showToast(m.score);
  if(m?.type==="SITE_SCORE_WARN") showWarn(m.score);
  if(m?.type==="SITE_SCORE_DANGER") showDanger(m.reason, m.score);
});

// ===== DOM signals sent to background =====
(function collectDomSignals(){
  try{
    const iframes=document.querySelectorAll("iframe").length;
    const pixels=[...document.images].filter(i=>(i.width<=1 && i.height<=1)).length;
    const login = !!(document.querySelector('input[type="password"]') || document.querySelector('form[action*="login"]'));
    const metaTrackers = !!document.querySelector('meta[name*="facebook"],meta[name*="pixel"],meta[content*="fb"]');
    const urlParams = /[?&](utm_|gclid=|fbclid=)/i.test(location.search);
    chrome.runtime.sendMessage({ type:"DOM_SIGNALS", payload:{ iframes, pixels, login, metaTrackers, urlParams }});
  }catch{}
})();
