// Minimal SEP-1865 (`io.modelcontextprotocol/ui`) inline event card for Dig.
//
// Zero external UI dependencies, zero app-only RPC tools, zero network calls from the iframe.
// One static ~11 KB (~3.8 KB gzipped) HTML resource (`ui://dig/card/v<VERSION>.html`) renders
// compact read-only event cards straight from `ui/notifications/tool-result` (`_meta.digCard`,
// with clean fallbacks for `structuredContent` and text results) and opens Dig's universal
// localhost SPA via `ui/open-link`.
import type { ClientCapabilities } from "@modelcontextprotocol/server";
import { knownSecrets, redactText } from "../core/secrets.ts";
import { VERSION } from "../version.ts";

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const UI_RESOURCE_MIME = "text/html;profile=mcp-app";
export const CARD_URI = `ui://dig/card/v${VERSION}.html`;
export const CARD_RESOURCE_META = {
  ui: {
    csp: { connectDomains: [] as string[], resourceDomains: [] as string[] },
    // `.card` draws its own crisp border, avoiding double borders in hosts that respect prefersBorder.
    prefersBorder: false,
  },
} as const;

/** Strict allowlist for card action links: localhost Dig `/open/<code>` or `/keys/<code>` only. */
export const SAFE_CARD_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/(?:open|keys)\/[A-Za-z0-9_-]+$/;

export type DigCardTone = "ok" | "info" | "warn" | "err";

export interface DigCardChip {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}

export interface DigCardAction {
  readonly label: string;
  readonly url: string;
  readonly primary?: boolean;
}

export interface DigCardPayload {
  readonly card: "report_saved" | "dig_finished" | "keys" | "open_library";
  readonly tone: DigCardTone;
  readonly eyebrow: string;
  readonly badge?: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly chips?: readonly DigCardChip[];
  readonly foot?: string;
  readonly action?: DigCardAction;
}

/** True when a client advertises the SEP-1865 MCP Apps extension (`io.modelcontextprotocol/ui`). */
export function declaresUi(capabilities: ClientCapabilities | null | undefined): boolean {
  const ext = (capabilities as { extensions?: Record<string, unknown> } | undefined)?.extensions;
  const ui = ext?.[UI_EXTENSION_ID];
  if (!ui || typeof ui !== "object") return false;
  const mimes = (ui as { mimeTypes?: unknown }).mimeTypes;
  return !Array.isArray(mimes) || mimes.includes(UI_RESOURCE_MIME);
}

const clean = (value: string, max = 180): string => {
  const redacted = redactText(value, knownSecrets()).replace(/\s+/g, " ").trim();
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
};

const safeAction = (
  label: string,
  url: string | undefined,
  primary?: boolean,
): DigCardAction | undefined => {
  if (!url || !SAFE_CARD_URL_RE.test(url)) return undefined;
  return { label, url, ...(primary ? { primary: true } : {}) };
};

const extractH1 = (markdown: string): string | undefined => {
  const stripped = markdown.replace(/^```ya?ml\s*\n[\s\S]*?\n```\s*\n?/, "");
  const match = /^#\s+(.+)$/m.exec(stripped);
  return match?.[1]?.trim() || undefined;
};

const extractSourceCardField = (markdown: string, field: string): string | undefined => {
  const fence = /^```ya?ml\s*\n([\s\S]*?)\n```/.exec(markdown);
  if (!fence) return undefined;
  const re = new RegExp(`^\\s*${field}:\\s*["']?([^"'\\n#]+)["']?`, "m");
  return re.exec(fence[1])?.[1]?.trim() || undefined;
};

/** Build a compact card when `research_save` writes a source report. */
export function cardForReportSaved(input: {
  readonly source: string;
  readonly sourceLabel: string;
  readonly agent?: string;
  readonly content: string;
  readonly file: string;
  readonly dig: string;
  readonly openUrl?: string;
}): DigCardPayload {
  const h1 = extractH1(input.content);
  const status = (extractSourceCardField(input.content, "status") ?? "saved").replace(/\.+$/, "");
  const grade = extractSourceCardField(input.content, "evidence_grade");
  const tone: DigCardTone = status === "failed" ? "err" : status === "partial" ? "warn" : "ok";
  const reportName = input.file.split("/").at(-1) ?? input.file;
  const action = safeAction("Read in Dig ↗", input.openUrl);
  const chips: DigCardChip[] = [
    { label: "Source", value: clean(input.agent || input.sourceLabel, 40) },
    ...(grade ? [{ label: "Grade", value: clean(grade, 20) }] : []),
    { label: "File", value: clean(reportName, 48), mono: true },
    ...(action ? [{ label: "Link", value: "single-use · 5m" }] : []),
  ];
  return {
    card: "report_saved",
    tone,
    eyebrow: "Dig · Report saved",
    badge: clean(status, 24),
    title: clean(h1 ?? `${input.sourceLabel} research report`, 140),
    subtitle: clean(`Saved under dig ${input.dig}`, 160),
    chips,
    foot: clean(input.file, 140),
    ...(action ? { action } : {}),
  };
}

/** Build a compact card when `dig_finish` records an initiating-thread answer. */
export function cardForDigFinished(input: {
  readonly dig: string;
  readonly question?: string;
  readonly status: string;
  readonly reports: readonly string[];
  readonly file: string;
  readonly openUrl?: string;
}): DigCardPayload {
  const tone: DigCardTone =
    input.status === "answered" ? "ok" : input.status === "partly-answered" ? "warn" : "info";
  const names = input.reports.map((r) => (r.split("/").at(-1) ?? r).replace(/\.md$/i, ""));
  const action = safeAction("Open dig ↗", input.openUrl);
  const chips: DigCardChip[] = [
    {
      label: "Reports",
      value: clean(
        names.length
          ? names.slice(0, 4).join(" · ") + (names.length > 4 ? ` +${names.length - 4}` : "")
          : "none",
        64,
      ),
    },
    { label: "File", value: "answer.md", mono: true },
    ...(action ? [{ label: "Link", value: "single-use · 5m" }] : []),
  ];
  return {
    card: "dig_finished",
    tone,
    eyebrow: "Dig · Answer recorded",
    badge: clean(input.status, 24),
    title: clean(input.question || `Dig ${input.dig}`, 140),
    subtitle: clean(
      `Synthesized from ${input.reports.length} saved report${input.reports.length === 1 ? "" : "s"}.`,
      140,
    ),
    chips,
    foot: clean(input.file, 140),
    ...(action ? { action } : {}),
  };
}

/** Build a compact card for `keys` (never contains secret values). */
export function cardForKeys(input: {
  readonly scopeLabel: string;
  readonly set: readonly string[];
  readonly missing: readonly string[];
  readonly saved?: readonly string[];
  readonly declined?: boolean;
  readonly url?: string;
  readonly expiresClock?: string;
  readonly line: string;
}): DigCardPayload {
  const action = !input.saved?.length && !input.declined ? safeAction("Open key page ↗", input.url, true) : undefined;
  const needsEntry = Boolean(action);
  const tone: DigCardTone = input.saved?.length
    ? "ok"
    : input.declined || needsEntry || input.missing.length
      ? "warn"
      : "ok";
  const chips: DigCardChip[] = [
    ...(input.saved?.length
      ? [{ label: "Saved", value: clean(input.saved.join(", "), 64), mono: true }]
      : []),
    ...(input.missing.length
      ? [{ label: "Missing", value: clean(input.missing.join(", "), 64), mono: true }]
      : [{ label: "Set", value: clean(input.set.join(", ") || "none", 64), mono: true }]),
    { label: "Scope", value: clean(input.scopeLabel, 40) },
    ...(action ? [{ label: "Link", value: "single-use" }] : []),
  ];
  return {
    card: "keys",
    tone,
    eyebrow: "Dig · Credentials (keys.env)",
    badge: input.saved?.length
      ? "saved"
      : input.declined
        ? "not opened"
        : input.expiresClock
          ? `expires ${input.expiresClock}`
          : input.missing.length
            ? "missing"
            : "ready",
    title: clean(
      input.saved?.length
        ? `Saved ${input.saved.length} credential${input.saved.length === 1 ? "" : "s"} to keys.env`
        : input.declined
          ? input.line
          : needsEntry
            ? `Enter ${input.scopeLabel} credentials on localhost`
            : input.line,
      140,
    ),
    subtitle: input.declined
      ? "Nothing was changed. Re-run keys whenever you want a fresh localhost page."
      : needsEntry
        ? "Saved locally in keys.env (mode 0600); credentials never pass through chat."
        : clean(input.line, 160),
    chips,
    ...(action && input.url ? { foot: clean(input.url, 120) } : {}),
    ...(action ? { action } : {}),
  };
}

/** Build a compact card for `open_library`. */
export function cardForOpenLibrary(input: {
  readonly view: string;
  readonly path: string;
  readonly dig: string | null;
  readonly opened: boolean;
  readonly address?: string;
}): DigCardPayload {
  const viewTitles: Record<string, string> = {
    library: "Dig Research Library",
    setup: "Dig Setup Wizard",
    trail: "Live Research Trail",
    sources: "Sources & 90-Day Cost History",
    settings: "Dig Settings",
    about: "About Dig",
  };
  const label =
    input.dig && input.view !== "trail" ? `Dig · ${input.dig}` : (viewTitles[input.view] ?? "Dig Web App");
  const action = safeAction("Open in Dig ↗", input.address, true);
  return {
    card: "open_library",
    tone: input.opened ? "ok" : "info",
    eyebrow: "Dig · Local web app",
    badge: input.opened ? "opened" : "single-use · 5m",
    title: clean(label, 140),
    subtitle: input.opened
      ? `Opened ${input.path} in your browser.`
      : "Open Dig's localhost web app in your browser (single-use, expires in 5 min).",
    chips: [
      { label: "Route", value: clean(input.path, 64), mono: true },
      ...(input.dig ? [{ label: "Dig", value: clean(input.dig, 48), mono: true }] : []),
    ],
    ...(action && input.address ? { foot: clean(input.address, 120) } : {}),
    ...(action ? { action } : {}),
  };
}

/**
 * Self-contained SEP-1865 MCP App HTML for `ui://dig/card/v<VERSION>.html`.
 * Uses strictly `document.createElement` + `.textContent` (zero `innerHTML`, zero network access),
 * verifies `ev.source === window.parent`, and restricts `ui/open-link` to loopback Dig routes only.
 */
export function renderCardHtml(): string {
  const safeVersion = JSON.stringify(VERSION);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dig Card</title>
<style>
:root{color-scheme:light dark;--bg:var(--color-background-primary,#fff);--bg2:var(--color-background-secondary,#f4f5f7);--fg:var(--color-text-primary,#14171a);--muted:var(--color-text-secondary,#586069);--border:var(--color-border-primary,#dfe2e6);--accent:var(--color-accent,#1d4a80);--accent-fg:#fff;--ok:var(--color-text-success,#1b7a46);--info:var(--color-text-info,#2563eb);--warn:var(--color-text-warning,#a36200);--err:var(--color-text-danger,#c43737);--radius:var(--border-radius-md,10px);--sans:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);--mono:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:var(--color-background-primary,#16191d);--bg2:var(--color-background-secondary,#1f242b);--fg:var(--color-text-primary,#eceff4);--muted:var(--color-text-secondary,#98a2b0);--border:var(--color-border-primary,#2b323c);--accent:var(--color-accent,#4f9cf9);--accent-fg:#0b1623;--ok:var(--color-text-success,#4cc280);--info:var(--color-text-info,#60a5fa);--warn:var(--color-text-warning,#e0a038);--err:var(--color-text-danger,#f87171)}}
:root[data-theme="dark"]{--bg:var(--color-background-primary,#16191d);--bg2:var(--color-background-secondary,#1f242b);--fg:var(--color-text-primary,#eceff4);--muted:var(--color-text-secondary,#98a2b0);--border:var(--color-border-primary,#2b323c);--accent:var(--color-accent,#4f9cf9);--accent-fg:#0b1623;--ok:var(--color-text-success,#4cc280);--info:var(--color-text-info,#60a5fa);--warn:var(--color-text-warning,#e0a038);--err:var(--color-text-danger,#f87171)}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;color:var(--fg);font:13.5px/1.45 var(--sans);-webkit-font-smoothing:antialiased}
.card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;flex-direction:column;gap:9px}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:7px;min-width:0}
.dot{width:8px;height:8px;border-radius:999px;flex:none;background:var(--info)}
.dot.ok{background:var(--ok)}.dot.info{background:var(--info)}.dot.warn{background:var(--warn)}.dot.err{background:var(--err)}
.eye{font-size:11.5px;font-weight:600;color:var(--muted)}
.pill{display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--border);background:var(--bg2);color:var(--fg);white-space:nowrap}
.pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 36%,transparent);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.pill.info{color:var(--info);border-color:color-mix(in srgb,var(--info) 38%,transparent);background:color-mix(in srgb,var(--info) 14%,transparent)}
.pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 38%,transparent);background:color-mix(in srgb,var(--warn) 13%,transparent)}
.pill.err{color:var(--err);border-color:color-mix(in srgb,var(--err) 38%,transparent);background:color-mix(in srgb,var(--err) 13%,transparent)}
.title{margin:0;font-size:14.5px;font-weight:600;letter-spacing:-.01em;color:var(--fg);word-break:break-word}
.sub{margin:-3px 0 0;font-size:12.5px;color:var(--muted);word-break:break-word}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--muted);background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:2px 7px;max-width:100%}
.chip strong{color:var(--fg);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip.mono strong{font-family:var(--mono);font-size:11px}
.foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-top:8px;border-top:1px solid var(--border);flex-wrap:wrap}
.path{font:11px/1.3 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:65%}
.btn{appearance:none;display:inline-flex;align-items:center;gap:5px;font:550 12px/1.2 var(--sans);padding:5px 11px;border-radius:calc(var(--radius) - 3px);border:1px solid var(--border);background:var(--bg2);color:var(--fg);cursor:pointer;margin-left:auto}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);color:var(--accent-fg);border-color:transparent}
.btn.primary:hover{opacity:.9}
.fallback{font:11px/1.4 var(--mono);color:var(--muted);background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;word-break:break-all;user-select:all}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function(){
  const VERSION=${safeVersion};
  const SAFE_URL=/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/(?:open|keys)\\/[A-Za-z0-9_-]+$/;
  const root=document.getElementById("root");
  let nextId=2;
  const pending=new Map();

  function el(tag,cls,text){
    const n=document.createElement(tag);
    if(cls)n.className=cls;
    if(text!==undefined)n.textContent=text;
    return n;
  }

  function post(msg){
    try{window.parent.postMessage(msg,"*");}catch{}
  }

  function request(method,params){
    const id=nextId++;
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});
      post({jsonrpc:"2.0",id,method,params});
    });
  }

  function applyHostContext(ctx){
    if(!ctx||typeof ctx!=="object")return;
    if(ctx.theme==="dark"||ctx.theme==="light"){
      document.documentElement.setAttribute("data-theme",ctx.theme);
    }
    const vars=ctx.styles&&ctx.styles.variables;
    if(vars&&typeof vars==="object"){
      for(const [k,v] of Object.entries(vars)){
        if(/^--[a-zA-Z0-9-]+$/.test(k)&&typeof v==="string"&&v.length<200){
          document.documentElement.style.setProperty(k,v);
        }
      }
    }
  }

  function reportSize(){
    const rect=document.body.getBoundingClientRect();
    const h=Math.ceil(rect.height);
    if(h>0)post({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:h}});
  }

  function deriveFallbackCard(result){
    if(!result||typeof result!=="object")return null;
    if(result._meta&&result._meta.digCard&&typeof result._meta.digCard==="object"){
      return result._meta.digCard;
    }
    const sc=result.structuredContent;
    const textBlock=Array.isArray(result.content)?result.content.find((b)=>b&&b.type==="text"&&typeof b.text==="string"):null;
    const text=textBlock?textBlock.text:"";
    const firstLine=text.split("\\n")[0]||"";
    if(sc&&typeof sc==="object"){
      if(typeof sc.address==="string"&&typeof sc.view==="string"){
        return {tone:sc.opened?"ok":"info",eyebrow:"Dig · Local web app",badge:sc.opened?"opened":"single-use · 5m",title:sc.dig?"Dig · "+sc.dig:"Dig Web App",chips:[{label:"Route",value:String(sc.path||"/"),mono:true}],foot:sc.address,action:SAFE_URL.test(sc.address)?{label:"Open in Dig ↗",url:sc.address,primary:true}:undefined};
      }
      if(Array.isArray(sc.set)&&Array.isArray(sc.missing)){
        const addr=typeof sc.address==="string"&&SAFE_URL.test(sc.address)?sc.address:undefined;
        return {tone:sc.missing.length?"warn":"ok",eyebrow:"Dig · Credentials",badge:sc.missing.length?"missing":"ready",title:firstLine||"Dig credentials",chips:[{label:"Set",value:sc.set.join(", ")||"none",mono:true}],foot:addr,action:addr?{label:"Open key page ↗",url:addr,primary:true}:undefined};
      }
      if(typeof sc.file==="string"&&typeof sc.dig==="string"){
        return {tone:result.isError?"err":"ok",eyebrow:sc.report?"Dig · Report saved":"Dig · Saved",badge:"saved",title:firstLine||sc.file,foot:sc.file};
      }
    }
    if(firstLine){
      const parts=firstLine.split(" · ");
      if(parts.length>=3){
        const st=parts[2].replace(/\\.+$/,"");
        const bad=result.isError||st==="failed"||st==="cancelled";
        return {tone:bad?"err":st==="partial"?"warn":"ok",eyebrow:parts[0]+" · "+parts[1],badge:st,title:parts.slice(3).join(" · ")||firstLine};
      }
      return {tone:result.isError?"err":"info",eyebrow:"Dig",title:firstLine.slice(0,140)};
    }
    return null;
  }

  function render(card){
    root.replaceChildren();
    if(!card){reportSize();return;}
    const tone=card.tone==="ok"||card.tone==="warn"||card.tone==="err"||card.tone==="info"?card.tone:"info";
    const article=el("article","card");
    const top=el("div","top");
    const brand=el("div","brand");
    brand.append(el("span","dot "+tone));
    brand.append(el("span","eye",String(card.eyebrow||"Dig")));
    top.append(brand);
    if(card.badge)top.append(el("span","pill "+tone,String(card.badge)));
    article.append(top);
    article.append(el("h3","title",String(card.title||"")));
    if(card.subtitle)article.append(el("p","sub",String(card.subtitle)));
    if(Array.isArray(card.chips)&&card.chips.length){
      const row=el("div","chips");
      for(const c of card.chips){
        if(!c||typeof c!=="object")continue;
        const chip=el("span","chip"+(c.mono?" mono":""));
        chip.append(document.createTextNode(String(c.label||"")+" "));
        chip.append(el("strong","",String(c.value||"")));
        row.append(chip);
      }
      article.append(row);
    }
    const validAction=card.action&&typeof card.action.url==="string"&&SAFE_URL.test(card.action.url)?card.action:null;
    if(card.foot||validAction){
      const foot=el("div","foot");
      if(card.foot)foot.append(el("span","path",String(card.foot)));
      if(validAction){
        const btn=el("button","btn"+(validAction.primary?" primary":""),String(validAction.label||"Open ↗"));
        btn.type="button";
        btn.addEventListener("click",()=>{
          request("ui/open-link",{url:validAction.url}).then((res)=>{
            if(res&&res.isError)showFallback(article,validAction.url);
          }).catch(()=>showFallback(article,validAction.url));
        });
        foot.append(btn);
      }
      article.append(foot);
    }
    root.append(article);
    reportSize();
  }

  function showFallback(article,url){
    if(article.querySelector(".fallback"))return;
    article.append(el("div","fallback",url));
    reportSize();
  }

  render({tone:"info",eyebrow:"Dig",badge:"working",title:"Waiting for result…"});

  if(typeof ResizeObserver==="function"){
    new ResizeObserver(reportSize).observe(document.body);
  }

  window.addEventListener("message",(ev)=>{
    if(ev.source!==window.parent)return;
    const msg=ev.data;
    if(!msg||typeof msg!=="object"||msg.jsonrpc!=="2.0")return;
    if(msg.id!==undefined&&!msg.method){
      if(msg.id===1){
        if(msg.result&&msg.result.hostContext)applyHostContext(msg.result.hostContext);
        post({jsonrpc:"2.0",method:"ui/notifications/initialized"});
        reportSize();
        return;
      }
      const p=pending.get(msg.id);
      if(p){
        pending.delete(msg.id);
        if(msg.error)p.reject(msg.error);
        else p.resolve(msg.result);
      }
      return;
    }
    if(msg.method==="ui/notifications/host-context-changed"){
      applyHostContext(msg.params);
      reportSize();
    }else if(msg.method==="ui/notifications/tool-input"){
      const args=msg.params&&msg.params.arguments;
      const action=args&&typeof args.action==="string"?args.action:null;
      render({tone:"info",eyebrow:action?"Dig · "+action:"Dig",badge:"running",title:action?"Running "+action+"…":"Working…"});
    }else if(msg.method==="ui/notifications/tool-result"){
      const card=deriveFallbackCard(msg.params);
      if(card)render(card);
    }else if(msg.method==="ui/notifications/tool-cancelled"){
      render({tone:"warn",eyebrow:"Dig",badge:"cancelled",title:"Tool call cancelled"});
    }else if((msg.method==="ui/resource-teardown"||msg.method==="ping")&&msg.id!==undefined){
      post({jsonrpc:"2.0",id:msg.id,result:{}});
    }else if(typeof msg.method==="string"&&msg.id!==undefined){
      post({jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Method not found"}});
    }
  });

  post({
    jsonrpc:"2.0",
    id:1,
    method:"ui/initialize",
    params:{appInfo:{name:"dig-card",version:VERSION},appCapabilities:{},protocolVersion:"2026-01-26"}
  });
})();
</script>
</body>
</html>`;
}
