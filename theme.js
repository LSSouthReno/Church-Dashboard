/* =====================================================================================
   THEME — "Soft" (default) or "Classic" (the original dark + gold).
   The dashboard's CSS was written dark. Rather than hand-editing ~800 KB of styles (and
   breaking every time someone adds a card), Soft translates colors at load:
     · every same-origin stylesheet rule that sets a color gets a soft-light twin
       (html[data-theme="soft"] <selector> { … }), generated once and cached;
     · inline style="" colors, SVG fill/stroke and Chart.js colors are translated as they appear.
   Surfaces keep their elevation (card brighter than page), text turns warm charcoal,
   gold becomes a quieter bronze. theme-soft polish on top is hand-tuned (see SOFT_POLISH).
   Office TV (?tv=1 / ≥2400px wide) always stays Classic. Load this FIRST in <head>.
   ===================================================================================== */
(function () {
  var KEY = 'lssr_theme', CACHE = 'lssr_soft_css_v10';
  var de = document.documentElement;
  function choose() {
    try {
      var q = new URLSearchParams(location.search), r = q.get('r');
      // Clean URLs arrive via 404.html as /?r=%2Fcalendar%3Ftv%3D1 — read the real query too.
      if (r && r.charAt(0) === '/') new URL(r, location.origin).searchParams.forEach(function (v, k) { if (!q.has(k)) q.set(k, v); });
      if (q.get('theme') === 'classic' || q.get('theme') === 'soft') localStorage.setItem(KEY, q.get('theme'));
      if (q.get('tv') === '1' || sessionStorage.getItem('cal6_tv') === '1') return 'classic';
      if (window.innerWidth >= 2400) return 'classic';
      return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'soft';
    } catch (e) { return 'soft'; }
  }
  var theme = choose();
  de.setAttribute('data-theme', theme);
  window.lssrTheme = {
    get: function () { return theme; },
    set: function (t) { try { localStorage.setItem(KEY, t === 'classic' ? 'classic' : 'soft'); } catch (e) {} location.reload(); },
    toggle: function () { window.lssrTheme.set(theme === 'soft' ? 'classic' : 'soft'); }
  };
  // Browser/app bar color: the pages ship the Soft one (#f5f3ee, same as the app manifests); Classic goes dark.
  if (theme !== 'soft') {
    document.addEventListener('DOMContentLoaded', function () {
      var m = document.querySelectorAll('meta[name="theme-color"]'); for (var i = 0; i < m.length; i++) m[i].setAttribute('content', '#141414');
    });
    return;
  }

  /* ── color math (OKLab) ─────────────────────────────────────────────────────────── */
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function delin(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); }
  function toOklch(r, g, b) {
    r = lin(r); g = lin(g); b = lin(b);
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    var L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    var A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    var B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return [L, Math.sqrt(A * A + B * B), Math.atan2(B, A)];
  }
  function fromOklch(L, C, h) {
    for (var k = 0; k < 12; k++) {   // shrink chroma until the color fits in sRGB
      var A = C * Math.cos(h), B = C * Math.sin(h);
      var l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
      var m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
      var s = Math.pow(L - 0.0894841775 * A - 1.2914855480 * B, 3);
      var r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      var g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      var b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
      if ((r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && b >= -0.001 && b <= 1.001) || C < 0.002) return [delin(r), delin(g), delin(b)];
      C *= 0.85;
    }
    return [delin(L), delin(L), delin(L)];
  }
  // Neutral lightness curve (in → out). V-shaped at the dark "card" level so surfaces keep
  // their elevation: page (.19) → linen, card (.24) → white, chips/borders darker again.
  var CURVE = [[0, .90], [.17, .955], [.19, .968], [.215, .985], [.24, 1], [.265, .958], [.29, .928], [.34, .89], [.42, .72], [.52, .53], [.62, .49], [.70, .46], [.85, .37], [.95, .29], [1, .26]]   // dim/muted text tuned to ≥4.5:1 on linen;
  function curve(L) {
    for (var i = 1; i < CURVE.length; i++) if (L <= CURVE[i][0]) {
      var a = CURVE[i - 1], b = CURVE[i]; return a[1] + (b[1] - a[1]) * (L - a[0]) / (b[0] - a[0]);
    }
    return CURVE[CURVE.length - 1][1];
  }
  var WARM = 1.25;   // ~72° hue: linen / warm charcoal
  // mode: '' · 's' shadow · 'h' SVG stroke (often a dark halo behind text) · 'c' chart ·
  //       'bg' background · 'fg' text color · 'bd' border. Light "paper" islands the dark theme drew on
  //       purpose (inputs, pills, print previews) keep their light backgrounds and dark text.
  function mapRGB(r, g, b, a, mode) {
    var o = toOklch(r, g, b), L = o[0], C = o[1], h = o[2], out, shadow = mode === 's';
    if (C >= .035 && (a < .6 || mode === 'c')) return null;   // tints & chart data colors read fine on light — keep them
    if (mode === 'h' && a < 1 && L < .3) return 'rgba(251,249,244,' + a + ')';
    if (shadow) {                                     // soft, warm, faint shadows
      if (L < .5) return 'rgba(74,58,30,' + +(a * .28).toFixed(3) + ')';
      out = fromOklch(Math.min(L, .7), C, h); return 'rgba(' + out + ',' + +(a * .45).toFixed(3) + ')';
    }
    if (a < 1 && L < .06) return a >= .35 ? 'rgba(34,28,18,' + +Math.min(.42, a * .7).toFixed(3) + ')' : 'rgba(40,30,15,' + +(a * .5).toFixed(3) + ')';
    if (a < 1 && L > .97 && C < .02) return 'rgba(52,40,22,' + +(a * .85).toFixed(3) + ')';
    if (mode === 'bg' && L > .6) return null;          // light/bright backgrounds already read on a light page
    if (mode === 'fg' && L < .3) return null;          // dark ink only ever sat on light or gold — keep it
    if (mode === 'bd' && L > .7) return null;
    if (mode === 'bd' && C < .035) return 'rgba(74,58,30,' + (a < 1 ? +(a * .5).toFixed(3) : .07) + ')';   // sleek: neutral outlines become a whisper; shadows and tints do the separating
    if (C < .035) {                                   // neutrals (incl. the warm greys)
      var L2 = curve(L), C2 = L2 > .85 ? .006 + (1 - L2) * .05 : .008, h2 = C > .012 ? h : WARM;
      if (L2 >= .999) return a < 1 ? 'rgba(255,255,255,' + a + ')' : '#ffffff';
      out = fromOklch(L2, C2, h2);
    } else if (L < .45) {                             // dark tinted panels → light tinted panels
      out = fromOklch(curve(L), Math.min(C * .35, .03), h);
    } else {                                          // accents: deepen so they read on white
      var L3 = L <= .55 ? L : .55 - (L - .55) * .3;   // ≥4.5:1 for accent text on white
      if (L > .55 && h > 1.2 && h < 1.95) h -= (h - 1.2) * .6;   // darkened gold/yellow turns olive — nudge it to warm bronze
      out = fromOklch(L3, C * (L > .8 ? 1.15 : 1.05), h);
    }
    return a < 1 ? 'rgba(' + out + ',' + a + ')' : '#' + out.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
  }
  var NAMED = { white: [255, 255, 255], black: [0, 0, 0] };
  var RE = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)|\b(white|black)\b/gi;
  var memo = {};
  function mapValue(v, shadow) {
    if (!v || v.indexOf('var(') === 0 && v.indexOf(',') < 0) return v;
    shadow = shadow || '';
    var key = shadow + '|' + v;
    if (memo[key] !== undefined) return memo[key];
    var res = v.replace(RE, function (m, hex, r, g, b, a, name) {
      var R, G, B, A = 1;
      if (hex) {
        if (hex.length <= 4) { R = parseInt(hex[0] + hex[0], 16); G = parseInt(hex[1] + hex[1], 16); B = parseInt(hex[2] + hex[2], 16); if (hex.length === 4) A = parseInt(hex[3] + hex[3], 16) / 255; }
        else { R = parseInt(hex.slice(0, 2), 16); G = parseInt(hex.slice(2, 4), 16); B = parseInt(hex.slice(4, 6), 16); if (hex.length === 8) A = parseInt(hex.slice(6, 8), 16) / 255; }
      } else if (name) { var n = NAMED[name.toLowerCase()]; R = n[0]; G = n[1]; B = n[2]; }
      else { R = +r; G = +g; B = +b; if (a != null) A = /%$/.test(a) ? parseFloat(a) / 100 : +a; }
      if (A === 0) return m;
      return mapRGB(R, G, B, A, shadow) || m;
    });
    memo[key] = res; return res;
  }
  window.lssrSoftColor = function (v) { return mapValue(String(v)); };

  var COLOR_PROP = /^(color|background|background-color|background-image|border|border-(top|right|bottom|left)(-color)?|border-color|border-(block|inline)(-start|-end)?(-color)?|outline|outline-color|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration|text-decoration-color|column-rule(-color)?|stop-color|--[\w-]+|-webkit-text-fill-color|-webkit-tap-highlight-color)$/;
  function isShadow(p) {
    return /shadow/.test(p) ? 's' : p === 'stroke' || /text-stroke/.test(p) ? 'h'
      : /^background/.test(p) ? 'bg' : /^(color|-webkit-text-fill-color|caret-color|text-decoration-color)$/.test(p) ? 'fg'
      : /^(border|outline|column-rule)/.test(p) ? 'bd' : '';
  }

  /* ── stylesheet rules → soft twins ─────────────────────────────────────────────────── */
  var P = 'html[data-theme="soft"]';
  function prefix(sel) {
    var parts = [], depth = 0, cur = '';
    for (var i = 0; i < sel.length; i++) {
      var ch = sel[i];
      if (ch === '(' || ch === '[') depth++; else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    return parts.map(function (s) {
      s = s.trim();
      if (/^:root\b/.test(s)) return P + s.slice(5);
      if (/^html\b/.test(s)) return P + s.slice(4);
      return P + ' ' + s;
    }).join(',');
  }
  function ruleCss(rule) {
    if (rule.type === 1) {                                     // style rule
      var st = rule.style, decl = '';
      for (var i = 0; i < st.length; i++) {
        var p = st[i]; if (!COLOR_PROP.test(p)) continue;
        var v = st.getPropertyValue(p); if (!v || !RE.test(v)) { RE.lastIndex = 0; continue; } RE.lastIndex = 0;
        var nv = mapValue(v, isShadow(p)); if (nv === v) continue;
        decl += p + ':' + nv + (st.getPropertyPriority(p) ? ' !important' : '') + ';';
      }
      if (!decl || !rule.selectorText) return '';
      if (rule.selectorText.indexOf('data-theme') >= 0) return '';   // hand-written Soft/Classic rules are already in their colors
      return prefix(rule.selectorText) + '{' + decl + '}';
    }
    if (rule.type === 4 || rule.type === 12) {                 // @media / @supports
      var inner = rulesCss(rule.cssRules); if (!inner) return '';
      return (rule.type === 4 ? '@media ' + rule.media.mediaText : '@supports ' + rule.conditionText) + '{' + inner + '}';
    }
    return '';
  }
  function rulesCss(rules) { var out = ''; for (var i = 0; i < rules.length; i++) out += ruleCss(rules[i]); return out; }
  function sheetsSig() {
    var n = 0, len = 0, s = document.querySelectorAll('style:not([data-soft]), link[rel="stylesheet"]');
    for (var i = 0; i < s.length; i++) { n++; len += (s[i].textContent || s[i].href || '').length; }
    return n + ':' + len;
  }
  var done = {};
  function generate() {
    var css = '';
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sh = document.styleSheets[i], node = sh.ownerNode;
      if (node && node.hasAttribute && node.hasAttribute('data-soft')) continue;
      try { css += rulesCss(sh.cssRules); } catch (e) { /* cross-origin (fonts) */ }
    }
    return css;
  }
  function inject(id, css) {
    var el = document.getElementById(id);
    if (!el) { el = document.createElement('style'); el.id = id; el.setAttribute('data-soft', '1'); }
    el.textContent = css;
    (document.head || de).appendChild(el);   // keep generated rules after the originals
    return el;
  }

  // Immediate: tokens + cached twins, so returning visitors never see a dark flash.
  var cached = null; try { cached = JSON.parse(localStorage.getItem(CACHE) || 'null'); } catch (e) {}
  try { for (var k = localStorage.length - 1; k >= 0; k--) { var lk = localStorage.key(k); if (/^lssr_soft_css_v/.test(lk) && lk !== CACHE) localStorage.removeItem(lk); } } catch (e) {}   // old versions
  if (cached && cached.css) inject('softGen', cached.css);
  else de.classList.add('soft-pending');
  inject('softBase', 'html.soft-pending body{opacity:0}html[data-theme="soft"]{color-scheme:light}html[data-theme="soft"],html[data-theme="soft"] body{background:#f5f3ee}');
  setTimeout(function () { de.classList.remove('soft-pending'); }, 2500);

  window.lssrTheme.timing = function () { var t0 = performance.now(), css = generate(); return { ms: Math.round(performance.now() - t0), kb: Math.round(css.length / 1024) }; };   // diagnostics
  function build() {
    var sig = sheetsSig();
    if (!cached || cached.sig !== sig) {
      var css = generate();
      inject('softGen', css);
      try { localStorage.setItem(CACHE, JSON.stringify({ sig: sig, css: css })); } catch (e) {}
      cached = { sig: sig, css: css };
    } else if (!document.getElementById('softGen')) inject('softGen', cached.css);   // already in place from the head: don't re-parse 60 KB of CSS
    if (!document.getElementById('softPolish')) inject('softPolish', window.SOFT_POLISH || '');
    de.classList.remove('soft-pending');
  }
  // Styles added later (modules that inject <style> on open) get their twins too.
  function softenSheet(node) {
    if (!node || node.hasAttribute('data-soft') || done[node.textContent.length + ':' + node.textContent.slice(0, 60)]) return;
    done[node.textContent.length + ':' + node.textContent.slice(0, 60)] = 1;
    try { var css = rulesCss(node.sheet.cssRules); if (css) { var s = document.createElement('style'); s.setAttribute('data-soft', '1'); s.textContent = css; document.head.appendChild(s); var pol = document.getElementById('softPolish'); if (pol) document.head.appendChild(pol); } } catch (e) {}
  }

  /* ── inline styles + SVG paint ─────────────────────────────────────────────────────── */
  var mapped = new WeakMap();
  function softenEl(el) {
    if (el.closest && el.closest('[data-keep-colors]')) return;
    var mine = mapped.get(el) || {};
    var st = el.style;
    if (st && st.length) {
      for (var i = 0; i < st.length; i++) {
        var p = st[i]; if (!COLOR_PROP.test(p)) continue;
        var v = st.getPropertyValue(p); if (!v || mine[p] === v) continue;
        RE.lastIndex = 0; if (!RE.test(v)) { RE.lastIndex = 0; continue; } RE.lastIndex = 0;
        var nv = mapValue(v, isShadow(p));
        if (nv !== v) st.setProperty(p, nv, st.getPropertyPriority(p));
        mine[p] = st.getPropertyValue(p);   // the browser re-serializes; remember ITS form so we never map twice
      }
    }
    if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
      ['fill', 'stroke', 'stop-color'].forEach(function (a) {
        var v = el.getAttribute(a); if (!v || mine['@' + a] === v) return;
        var nv = mapValue(v, a === 'stroke' ? 'h' : ''); if (nv !== v) el.setAttribute(a, nv); mine['@' + a] = el.getAttribute(a);
      });
    }
    mapped.set(el, mine);
  }
  function softenTree(root) {
    if (root.nodeType !== 1) return;
    if (root.hasAttribute('style') || root.namespaceURI === 'http://www.w3.org/2000/svg') softenEl(root);
    var list = root.querySelectorAll('[style],[fill],[stroke],[stop-color]');
    for (var i = 0; i < list.length; i++) softenEl(list[i]);
  }
  var mo = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'attributes') softenEl(m.target);
      else for (var j = 0; j < m.addedNodes.length; j++) {
        var n = m.addedNodes[j];
        if (n.nodeName === 'STYLE') softenSheet(n); else softenTree(n);
      }
    }
  });

  /* ── Chart.js: translate colors in every chart's config ──────────────────────────── */
  function softenCfg(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return;
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (typeof v === 'string' && /color$/i.test(k)) o[k] = mapValue(v, 'c');
      else if (Array.isArray(v) && /color$/i.test(k)) o[k] = v.map(function (x) { return typeof x === 'string' ? mapValue(x, 'c') : x; });
      else if (v && typeof v === 'object' && k !== 'data' && !(v instanceof Element)) softenCfg(v, depth + 1);
    }
  }
  function patchChart() {
    var C = window.Chart; if (!C || C.__soft) return;
    var Soft = function (ctx, cfg) {
      try { if (cfg) { softenCfg(cfg.options, 0); ((cfg.data || {}).datasets || []).forEach(function (d) { softenCfg(d, 0); }); } } catch (e) {}
      return Reflect.construct(C, [ctx, cfg], Soft);
    };
    Soft.prototype = C.prototype; Object.setPrototypeOf(Soft, C); Soft.__soft = true;
    try { C.defaults.color = '#6d675d'; C.defaults.borderColor = 'rgba(60,45,20,.08)'; } catch (e) {}
    window.Chart = Soft;
  }

  function start() {
    de.classList.remove('sp-light');   // Staff OS's own light switch: Soft already is the light look
    var t0 = performance.now(); build(); var t1 = performance.now(); patchChart(); softenTree(document.body);
    window.lssrTheme.t = { build: Math.round(t1 - t0), soften: Math.round(performance.now() - t1) };
    mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'fill', 'stroke', 'stop-color'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

/* Hand-tuned polish on top of the translated colors: calmer type, softer cards. */
window.SOFT_POLISH = `
html[data-theme="soft"] { --soft-ink:#2b2924; --soft-muted:#6d675d; --soft-line:#e8e3d9; --soft-bronze:#9c7a26; --soft-shadow:0 1px 2px rgba(74,58,30,.05), 0 6px 22px rgba(74,58,30,.06); }
html[data-theme="soft"] body { font-weight: 450; }
html[data-theme="soft"] img[src*="-white.png"]:not([data-keep-colors]) { filter: brightness(0); opacity: .82; }
html[data-theme="soft"] .card, html[data-theme="soft"] .ch-tile, html[data-theme="soft"] #engCare .card, html[data-theme="soft"] .tmod-tcard, html[data-theme="soft"] .sd-section, html[data-theme="soft"] .tmod-metric, html[data-theme="soft"] .sh-metric, html[data-theme="soft"] .sh-person { border-color: transparent !important; box-shadow: var(--soft-shadow); border-radius: 16px; }
html[data-theme="soft"] .ch-tile:hover, html[data-theme="soft"] .tmod-tcard:hover, html[data-theme="soft"] .sh-person:hover { box-shadow: 0 2px 4px rgba(74,58,30,.06), 0 10px 28px rgba(74,58,30,.09); }
/* sleek controls: a soft fill instead of an outline */
html[data-theme="soft"] .members-btn, html[data-theme="soft"] .nav-search, html[data-theme="soft"] .csv-btn, html[data-theme="soft"] .cal6-nbtn, html[data-theme="soft"] .cal6-vbtn, html[data-theme="soft"] .cal6-fbtn,
html[data-theme="soft"] .sd-week-nav, html[data-theme="soft"] .sd-week-select, html[data-theme="soft"] .sd-print-btn, html[data-theme="soft"] .eng-btn.g, html[data-theme="soft"] .sh-search, html[data-theme="soft"] .sh-sort,
html[data-theme="soft"] .eng-scope select, html[data-theme="soft"] .tmod-body input, html[data-theme="soft"] .tmod-body select, html[data-theme="soft"] #kpIn, html[data-theme="soft"] .me-prev-btn { border-color: transparent !important; background-color: rgba(74,58,30,.06); }
html[data-theme="soft"] .cal6-vbtn.on, html[data-theme="soft"] .cal6-fbtn.on { background-color: #f3ecdb; }
html[data-theme="soft"] .nav-signin { border-color: transparent !important; background: #f3ecdb; }
html[data-theme="soft"] .ch-subnav button.on, html[data-theme="soft"] .eng-btn { border-color: transparent !important; }
html[data-theme="soft"] .sh-metric, html[data-theme="soft"] .sh-person { border-left-width: 0 !important; }
html[data-theme="soft"] .eng-step, html[data-theme="soft"] .eng-opp, html[data-theme="soft"] .eng-pc, html[data-theme="soft"] .eng-ins, html[data-theme="soft"] .eng-funnel div, html[data-theme="soft"] .team-row, html[data-theme="soft"] .avg-box,
html[data-theme="soft"] .tmod-tstat, html[data-theme="soft"] .sd-team-card, html[data-theme="soft"] .sd-captain-card { border-color: transparent !important; background-color: #f8f6f1 !important; }
html[data-theme="soft"] .eng-opp, html[data-theme="soft"] .eng-pc { border-top: 3px solid var(--c, var(--gold)) !important; }
html[data-theme="soft"] .eng-ins { border-left: 3px solid var(--gold) !important; }
html[data-theme="soft"] .eng-strip { border-color: transparent !important; }
html[data-theme="soft"] .eng .eng-step { background-color: transparent !important; }
html[data-theme="soft"] #topNav { background: rgba(255,255,255,.92) !important; backdrop-filter: saturate(1.2) blur(10px); border-bottom: 1px solid var(--soft-line) !important; box-shadow: 0 1px 0 rgba(74,58,30,.03); }
html[data-theme="soft"] .ch-subnav button.on { background: #f3ecdb; color: #7a5e14; border-color: #e6d7b0; }
html[data-theme="soft"] h1, html[data-theme="soft"] .tmod-title, html[data-theme="soft"] .page-title { letter-spacing: .01em; }
html[data-theme="soft"] .eng-strip { background: linear-gradient(90deg, #f6efdc, #fbf8f1); border-color: #e6d7b0; }
html[data-theme="soft"] .eng-btn { background: #f6efdc; border-color: #e1cf9f; color: #7a5e14; }
html[data-theme="soft"] .eng-btn.g { background: #fff; border-color: var(--soft-line); color: var(--soft-muted); }
html[data-theme="soft"] ::selection { background: #f0e3bd; }
html[data-theme="soft"] #staffModal .sp-theme-btn { display: none !important; }
html[data-theme="soft"] .nav-me .av, html[data-theme="soft"] .cf-views button.on, html[data-theme="soft"] .sp-nav-tab.sp-nav-tool.sp-active, html[data-theme="soft"] .sp-copy-btn, html[data-theme="soft"] .sp-snap-rocks-tab-btn:hover, html[data-theme="soft"] .sp-l10-print-btn, html[data-theme="soft"] .sp-away-save-btn, html[data-theme="soft"] .sp-joy-bomb-btn, html[data-theme="soft"] .sp-joy-add-btn:hover, html[data-theme="soft"] #staffModal .sos-btn.hi, html[data-theme="soft"] #staffModal .oga-btn.hi, html[data-theme="soft"] .sp-prof-bamboo:hover, html[data-theme="soft"] .sp-prof-add-btn:hover, html[data-theme="soft"] .st-navn { color: #fff !important; }   /* dark ink on the soft bronze read at 3.6:1 */
html[data-theme="soft"] .sh-newfam-banner { background: #fbf0cc !important; color: #4d3b06 !important; }
html[data-theme="soft"] .sh-nf-who, html[data-theme="soft"] .sh-nf-who b { color: #4d3b06 !important; }
html[data-theme="soft"] .sh-nf-who { border-top-color: rgba(77,59,6,.15) !important; }
html[data-theme="soft"] .sh-person.sh-newfam { border-color: #e7c766 !important; background: #fffbef !important; box-shadow: var(--soft-shadow) !important; }
`;
