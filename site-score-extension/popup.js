function colorForScore(n){ if(n>=80)return"#1a7f37"; if(n>=60)return"#b7791f"; return"#c53030"; }
function setGauge(score){
  const c=2*Math.PI*52, fg=document.getElementById("fg");
  fg.style.strokeDasharray=String(c);
  fg.style.strokeDashoffset=String(c*(1-(score/100)));
  fg.style.stroke=colorForScore(score);
  document.getElementById("num").textContent=score;
}
function bullets(state){
  const out=[];
  out.push(state.protocol==="https:" ? "Your connection is encrypted." : "Connection isn’t encrypted.");
  out.push(state.hsts ? "The site forces secure connections." : "The site may allow unencrypted fallback.");
  const total=(state.req.first+state.req.third)||1;
  const share=Math.round(100*state.req.third/total);
  out.push(share<=25?"Keeps most data on its own servers.":share<=60?"Shares some data with outside services.":"Relies heavily on outside services.");
  out.push(state.req.trackers.length===0?"No common trackers detected.":"Uses common tracking services.");
  out.push(state.sec?.csp?"Has protections against unsafe content.":"Missing some protection headers.");
  if (state.policy?.has){
    const bits=[]; if(state.policy.rights)bits.push("mentions your rights"); if(state.policy.opt)bits.push("offers opt-out");
    out.push(bits.length?`Privacy page ${bits.join(", ")}.`:"Has a privacy page.");
  } else out.push("Couldn’t find a clear privacy page.");
  return out;
}

document.addEventListener("DOMContentLoaded", async ()=>{
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  const url = tab.url;

  // Open explainer page (no numbers, high-level)
  document.getElementById("knowMore").addEventListener("click", ()=>{
    chrome.tabs.create({ url: chrome.runtime.getURL("learn.html") });
  });

  // Ask background for the latest result by root domain (stable across paths)
  chrome.runtime.sendMessage({ type:"GET_BY_ROOT", url }, (data)=>{
    if(!data){ document.getElementById("num").textContent="--"; return; }
    setGauge(data.score);
    const ul=document.getElementById("facts"); ul.innerHTML="";
    bullets(data.state).forEach(t=>{ const li=document.createElement("li"); li.textContent=t; ul.appendChild(li); });
  });
});
