/**
 * dsh-gemini-kitten-widget —— client 半（浏览器端挂件）
 * ============================================================================
 * 铁律（踩过的坑，别重犯）：
 *   ① **绝不 require() 内置符号**（styles / host 是 seed word）—— 一旦 require，
 *      整个 web boot 会失败、应用弹「无法启动」。这里全部自建 <style> 并 appendChild。
 *   ② 初始化路径上**任何异常都会让挂件"活着但点不动"**，所以每一步都包 try/catch，
 *      所有早退分支都打 console.error（不静默）。
 *   ③ **不依赖赋值顺序 / 函数提升顺序** —— 所有函数声明在同一个 IIFE 里，
 *      但初始化时只调用已经定义好的东西；能自包含的就自包含。
 *   ④ 幂等：桌面端注入行与 web 形态 tapIndex 可能同时生效，用全局标记挡住第二次。
 * ============================================================================
 */
(function () {
  'use strict'

  var LOG = '[dsh-kitten]'

  // —— 幂等保护：被注入两次时只跑一次 ——
  try {
    if (window.__dshKittenLoaded) return
    window.__dshKittenLoaded = true
  } catch (err) {
    return
  }

  var API_STATE = '/dsh-kitten/state'
  var API_POS = '/dsh-kitten/pos'
  var ART_PATH = '/dsh-kitten/art.png'
  var REFRESH_MS = 30000
  var KEY_POS = 'dsh-kitten-widget:pos'
  var KEY_LINE = 'dsh-kitten-widget:line'
  // 阈值提醒的「这个配额日已经喊过哪几条」——跨刷新保持；键里带配额日，跨日自动作废。
  var KEY_ALERT = 'dsh-kitten-widget:alerts'

  // ==========================================================================
  // 台词库
  // ==========================================================================
  var LINES = {
    ok: [
      '喵？才用了 {used} 次，本喵还很有精神哦～',
      '哈基米在此！有事快说喵。',
      '哼，又来看本喵……也不是不行啦。',
      '写代码专心点喵，别老戳我。',
      '还有 {remaining} 次额度躺着睡觉呢，真浪费喵。',
      // ⚠️ 台词里**绝不要硬编码配额数字或重置时区**：配额从 250 改成 20、重置点从
      //    太平洋午夜改成 UTC 午夜时，写死的句子会当场变成错话。一律用 {used}/{remaining}/{limit}/{model} 占位符。
      '本喵是这些额度里最漂亮的一只喵！',
      '今天状态不错喵，随便用～',
      // —— 以下为本机私货（素材取自 SELF-NOTE.md）——
      // ⚠️ 视角纪律：这里是**哈基米（Gemini）**的嘴，只说她自己的事。
      //    「我是鲸鱼」「大肥鱼」这类话属于鲸鱼娘那一侧，写在这儿会串味（用户 2026-10-15 指出）。
      //    她的私货请写进 ~/.dsh/widget-lines.json 的 kitten 段，那里可以随时加、刷新即生效。
      '隔壁那只鲸鱼娘只会数钱，本喵会数次数喵。',
      'DeepSeek 打喷嚏的时候，本喵能顶上喵。',
      '隔壁刚拿了 43 块赠金，本喵这边只有次数喵。',
      '{model} 还剩 {remaining} 次，够本喵撒个欢喵。',
      '点本喵肚子上的牌子，能看别的型号喵。',
      '放心用喵，本喵的额度还够你折腾。',
      '别把「说过的」当成「验证过的」——他教的喵。'
    ],
    warn: [
      '喂喂，{used} 次了喵！悠着点用！',
      '本喵感觉……力气在流失喵……',
      '快到红线了喵，省着点花。',
      '再这么用下去，本喵要饿肚子了喵。',
      '还剩 {remaining} 次，别一口气造完喵。',
      '{model} 快见底了喵，换一位使唤？',
      '省着点喵，饭钱也不是大风刮来的。'
    ],
    danger: [
      '没了没了！额度快见底了喵！',
      '{remaining} 次……只够本喵眨个眼喵。',
      '要等重置才回血喵，忍一忍吧。',
      '别戳了！戳我也变不出额度喵！',
      '本喵要休息了喵……你自己想办法。',
      '这个型号躺平了喵——点牌子换个看看？',
      '北京早上八点才回血喵，先睡一觉？',
      '别急喵，等回血了本喵陪你继续。'
    ],
    unknown: [
      '账本读不到喵……挂件那边出问题了？',
      '本喵看不见自己的额度了喵，好慌。',
      '数据断了喵，跑一次 gemini-quota.cmd 看看？'
    ]
  }

  /** 模型短名：gemini-3.8-flash → 3.8-flash（徽章上一行放不下全名）。 */
  function shortModel(m) {
    try {
      var s = String(m || '')
      if (/^gemini-/i.test(s)) return s.replace(/^gemini-/i, '')
      if (/^gemma-/i.test(s)) return s.replace(/^gemma-/i, 'gemma ')
      return s
    } catch (err) {
      return String(m || '')
    }
  }

  // ==========================================================================
  // 样式（自建 <style>，绝不 require 内置符号）
  // ==========================================================================
  var CSS = [
    '.dshk-root{position:fixed;right:10px;bottom:158px;z-index:9990;',
    'display:flex;flex-direction:column;align-items:center;gap:6px;',
    'font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;',
    '-webkit-user-select:none;user-select:none;touch-action:none;',
    'filter:drop-shadow(0 6px 16px rgba(20,16,50,.38));',
    'transition:opacity .25s ease}',
    // !important：松手时的 inline transition 如果在 220ms 内被下一次拖动撞上，靠它压住（否则跟手会滞后）
    '.dshk-root.dshk-dragging{transition:none !important;cursor:grabbing}',

    '.dshk-art{position:relative;width:142px;height:98px;cursor:grab;pointer-events:auto;',
    'animation:dshk-float 4.2s ease-in-out infinite}',
    '.dshk-root.dshk-dragging .dshk-art{cursor:grabbing}',
    // 立绘（本地生成的透明 PNG）：contain 保证不变形，pointer-events 交给父层做拖拽
    '.dshk-img{width:100%;height:100%;display:block;object-fit:contain;',
    '-webkit-user-drag:none;user-select:none;pointer-events:none}',
    '.dshk-svg{width:100%;height:100%;display:block;overflow:visible}',
    // 立绘默认**脸朝左**（见 assets/kitten-art.png）：拖到视口左半边时镜像成朝右，
    // 让她始终"面向屏幕中央"—— 小鲸鱼那条翻转线是同一个思路，只是它是可调的。
    '.dshk-root.dshk-flip .dshk-img,.dshk-root.dshk-flip .dshk-svg{transform:scaleX(-1)}',
    '@keyframes dshk-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',

    '.dshk-eye{animation:dshk-blink 5.2s infinite;transform-box:fill-box;transform-origin:center}',
    '@keyframes dshk-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.08)}}',
    '.dshk-tail{animation:dshk-tail 2.6s ease-in-out infinite;transform-box:view-box;transform-origin:124px 201px}',
    '@keyframes dshk-tail{0%,100%{transform:rotate(-5deg)}50%{transform:rotate(7deg)}}',
    '.dshk-star{animation:dshk-pulse 2.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}',
    '@keyframes dshk-pulse{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.14);opacity:1}}',
    '.dshk-root.dshk-poke .dshk-art{animation:dshk-poke .42s ease}',
    '@keyframes dshk-poke{0%{transform:scale(1)}35%{transform:scale(1.1) rotate(-3deg)}70%{transform:scale(.97) rotate(2deg)}100%{transform:scale(1)}}',

    '.dshk-badge{box-sizing:border-box;min-width:126px;max-width:152px;padding:8px 11px 9px;',
    'border-radius:12px;background:rgba(26,24,48,.86);cursor:pointer;',
    'border:1px solid rgba(150,120,220,.42);backdrop-filter:blur(7px);',
    'color:#EDE9FF;font-size:12.5px;line-height:1.25;text-align:center;pointer-events:auto;',
    'box-shadow:0 3px 10px rgba(12,10,30,.35)}',
    '.dshk-row1{display:flex;align-items:baseline;justify-content:center;gap:4px}',
    '.dshk-mini{width:13px;height:13px;flex:0 0 auto;align-self:center;margin-right:1px}',
    '.dshk-used{font-size:21px;font-weight:700;letter-spacing:.2px;line-height:1}',
    '.dshk-limit{font-size:12.5px;opacity:.62}',
    '.dshk-track{margin:6px 0 5px;height:5px;border-radius:3px;background:rgba(255,255,255,.14);overflow:hidden}',
    '.dshk-fill{display:block;height:100%;width:0;border-radius:3px;',
    'background:linear-gradient(90deg,#4285F4,#9B72CB);transition:width .45s ease,background .3s ease}',
    '.dshk-row2{font-size:11.5px;opacity:.78;white-space:nowrap}',
    '.dshk-root[data-level="warn"] .dshk-badge{border-color:rgba(245,166,35,.68)}',
    '.dshk-root[data-level="warn"] .dshk-fill{background:linear-gradient(90deg,#F5A623,#F57C00)}',
    '.dshk-root[data-level="danger"] .dshk-badge{border-color:rgba(232,69,60,.78);',
    'background:rgba(48,20,26,.88)}',
    '.dshk-root[data-level="danger"] .dshk-fill{background:linear-gradient(90deg,#E8453C,#C62828)}',
    '.dshk-root[data-level="danger"] .dshk-used{color:#FF8A80}',
    '.dshk-root[data-level="unknown"] .dshk-badge{opacity:.72}',

    // 气泡以挂件为中心，但挂件常贴在屏幕边缘 —— 所以宽度用 min() 兜一层：
    // 手机上（375px 宽）只留 ~165px，避免气泡被推出视口看不见（2026-10-15 实测踩到）。
    '.dshk-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%) translateY(6px);',
    'box-sizing:border-box;width:max-content;max-width:min(248px,calc(100vw - 210px));padding:10px 14px;border-radius:13px;',
    'background:rgba(255,255,255,.97);color:#2A2450;font-size:14.5px;line-height:1.5;text-align:left;',
    'box-shadow:0 5px 16px rgba(20,16,50,.3);opacity:0;pointer-events:none;',
    'transition:opacity .22s ease,transform .22s ease;word-break:break-word}',
    '.dshk-bubble::after{content:"";position:absolute;top:100%;left:50%;margin-left:-6px;',
    'border:6px solid transparent;border-top-color:rgba(255,255,255,.97)}',
    '.dshk-bubble.dshk-show{opacity:1;transform:translateX(-50%) translateY(0)}',
    // 挂件贴在屏幕边缘时，"气泡居中于挂件"必然把它推出视口（跟气泡多宽无关）。
    // 所以 say() 会按挂件位置挂上下面两个类，改成贴住那一侧 —— 箭头也跟着挪。
    '.dshk-bubble.dshk-bubble-right{left:auto;right:0;transform:translateX(0) translateY(6px)}',
    '.dshk-bubble.dshk-bubble-right.dshk-show{transform:translateX(0) translateY(0)}',
    '.dshk-bubble.dshk-bubble-right::after{left:auto;right:56px;margin-left:0}',
    '.dshk-bubble.dshk-bubble-left{left:0;transform:translateX(0) translateY(6px)}',
    '.dshk-bubble.dshk-bubble-left.dshk-show{transform:translateX(0) translateY(0)}',
    '.dshk-bubble.dshk-bubble-left::after{left:56px;margin-left:0}'
  ].join('')

  // ==========================================================================
  // 形象：Q 版 Gemini 猫娘（手写 SVG）
  //   蓝紫长发 · 猫耳 · 异色瞳（左蓝 #4285F4 / 右紫 #A45CD6）· 坏笑 + 小虎牙
  //   灵感来源：ZipZipPipe 的「Gemini 娘」二创（B站 1233069202138464289），
  //   此处为参考风格的自绘原创矢量图，非复制角色。
  // ==========================================================================
  function buildSvg() {
    var STAR = 'M0,-13C1.4,-4.6 4.6,-1.4 13,0 4.6,1.4 1.4,4.6 0,13 -1.4,4.6 -4.6,1.4 -13,0 -4.6,-1.4 -1.4,-4.6 0,-13Z'
    return ''
      + '<svg class="dshk-svg" viewBox="0 0 200 232" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
      + '<defs>'
      + '<linearGradient id="dshkHair" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#7FA9F7"/><stop offset=".55" stop-color="#8B7BE8"/>'
      + '<stop offset="1" stop-color="#A96FE0"/></linearGradient>'
      + '<linearGradient id="dshkHairBack" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#6C90E8"/><stop offset="1" stop-color="#8155CC"/></linearGradient>'
      + '<linearGradient id="dshkBody" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#524A96"/><stop offset="1" stop-color="#332E63"/></linearGradient>'
      + '<linearGradient id="dshkEar" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#6E63C4"/><stop offset="1" stop-color="#463C82"/></linearGradient>'
      + '<radialGradient id="dshkEyeBlue" cx=".38" cy=".32" r=".8">'
      + '<stop offset="0" stop-color="#A8D0FF"/><stop offset=".55" stop-color="#4285F4"/>'
      + '<stop offset="1" stop-color="#1B49AE"/></radialGradient>'
      + '<radialGradient id="dshkEyePurple" cx=".38" cy=".32" r=".8">'
      + '<stop offset="0" stop-color="#EFC2FF"/><stop offset=".55" stop-color="#A45CD6"/>'
      + '<stop offset="1" stop-color="#63289E"/></radialGradient>'
      + '<filter id="dshkGlow" x="-70%" y="-70%" width="240%" height="240%">'
      + '<feGaussianBlur stdDeviation="2.2" result="b"/>'
      + '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '</defs>'

      // ── 尾巴（从身体右后方舒展开来、向上扬起，会摇）──────────────
      + '<g class="dshk-tail">'
      + '<path d="M124,201C154,212 187,203 191,175" fill="none" '
      + 'stroke="#6B5BB5" stroke-width="12.5" stroke-linecap="round"/>'
      + '<path d="M179,182C185,182 189,180 191,175" fill="none" '
      + 'stroke="#C9BCFF" stroke-width="8.5" stroke-linecap="round"/>'
      + '</g>'

      // ── 后发（垂到腰的长发，末端收细）──────────────────────────
      + '<path d="M63,88C46,116 40,158 47,200C48,207 58,207 60,200C53,160 57,118 72,93Z" fill="url(#dshkHairBack)"/>'
      + '<path d="M137,88C154,116 160,158 153,200C152,207 142,207 140,200C147,160 143,118 128,93Z" fill="url(#dshkHairBack)"/>'

      // ── 身体（小袍子）────────────────────────────────────────
      + '<path d="M70,144C70,133 130,133 130,144L138,190C138,199 62,199 62,190Z" fill="url(#dshkBody)"/>'
      + '<path d="M62,190C62,199 138,199 138,190L136,180C125,187 75,187 64,180Z" fill="#2A2554" opacity=".55"/>'
      // 小脚（从袍子下摆探出来）
      + '<ellipse cx="83" cy="203" rx="12" ry="7.5" fill="#FFE6DC"/>'
      + '<ellipse cx="117" cy="203" rx="12" ry="7.5" fill="#FFE6DC"/>'
      // 胸前的四角星（Gemini 标志）
      + '<g transform="translate(100,170)" filter="url(#dshkGlow)">'
      + '<path class="dshk-star" d="' + STAR + '" fill="#FFFFFF" opacity=".95"/></g>'

      // ── 头 ───────────────────────────────────────────────────
      + '<ellipse cx="100" cy="98" rx="47" ry="43" fill="#FFE6DC"/>'

      // ── 猫耳 ─────────────────────────────────────────────────
      + '<path d="M64,80C56,59 50,38 53,26C60,32 79,49 94,63Z" fill="url(#dshkEar)"/>'
      + '<path d="M136,80C144,59 150,38 147,26C140,32 121,49 106,63Z" fill="url(#dshkEar)"/>'
      + '<path d="M70,74C64,59 60,44 62,36C67,42 78,54 87,63Z" fill="#FFB0C8" opacity=".9"/>'
      + '<path d="M130,74C136,59 140,44 138,36C133,42 122,54 113,63Z" fill="#FFB0C8" opacity=".9"/>'

      // ── 呆毛 ─────────────────────────────────────────────────
      + '<path d="M101,58C103,41 113,27 126,24C117,33 110,44 108,59Z" fill="#5A4FA8"/>'

      // ── 刘海（锯齿下缘）───────────────────────────────────────
      + '<path d="M54,90C50,64 72,50 100,50C128,50 150,64 146,90'
      + 'C143,76 137,68 131,74C128,62 118,58 112,68'
      + 'C106,56 94,56 88,68C82,58 72,62 69,74C63,68 57,76 54,90Z" fill="url(#dshkHair)"/>'
      // 发夹（暖黄四角星，给蓝紫色调一个亮点）
      + '<g transform="translate(141,69) scale(.52)"><path class="dshk-star" d="' + STAR + '" fill="#FFD166"/></g>'

      // ── 眼睛（异色瞳）────────────────────────────────────────
      // 左眼：蓝
      + '<g class="dshk-eye">'
      + '<ellipse cx="80" cy="104" rx="13.5" ry="14.5" fill="#FFFFFF"/>'
      + '<ellipse cx="80" cy="105" rx="11" ry="12.6" fill="url(#dshkEyeBlue)"/>'
      + '<ellipse cx="80" cy="106" rx="5.2" ry="7.6" fill="#241844"/>'
      + '<circle cx="75.6" cy="99.5" r="3.9" fill="#FFFFFF"/>'
      + '<circle cx="84" cy="111" r="1.9" fill="#FFFFFF" opacity=".75"/>'
      + '</g>'
      + '<path d="M66,95C72,88 88,88 94,98" fill="none" stroke="#3A2E5A" stroke-width="4.4" stroke-linecap="round"/>'
      // 右眼：紫
      + '<g class="dshk-eye">'
      + '<ellipse cx="120" cy="104" rx="13.5" ry="14.5" fill="#FFFFFF"/>'
      + '<ellipse cx="120" cy="105" rx="11" ry="12.6" fill="url(#dshkEyePurple)"/>'
      + '<ellipse cx="120" cy="106" rx="5.2" ry="7.6" fill="#241844"/>'
      + '<circle cx="115.6" cy="99.5" r="3.9" fill="#FFFFFF"/>'
      + '<circle cx="124" cy="111" r="1.9" fill="#FFFFFF" opacity=".75"/>'
      + '</g>'
      + '<path d="M106,98C112,88 128,88 134,95" fill="none" stroke="#3A2E5A" stroke-width="4.4" stroke-linecap="round"/>'

      // ── 鼻子 / 嘴（坏笑 + 小虎牙）───────────────────────────
      + '<ellipse cx="100" cy="120" rx="2.2" ry="1.5" fill="#E8A79E"/>'
      + '<path d="M84,127C93,134 106,133 118,122" fill="none" '
      + 'stroke="#5B3A47" stroke-width="3.1" stroke-linecap="round"/>'
      + '<path d="M108,129L111,136L114,129.5Z" fill="#FFFFFF"/>'

      // ── 腮红 ─────────────────────────────────────────────────
      + '<ellipse cx="70" cy="117" rx="8.5" ry="5.2" fill="#FF9DB5" opacity=".52"/>'
      + '<ellipse cx="130" cy="117" rx="8.5" ry="5.2" fill="#FF9DB5" opacity=".52"/>'
      // 胡须（猫感）
      + '<g stroke="#FFD9E0" stroke-width="1.5" stroke-linecap="round" opacity=".75" fill="none">'
      + '<path d="M52,113L38,110"/><path d="M52,119L39,121"/>'
      + '<path d="M148,113L162,110"/><path d="M148,119L161,121"/>'
      + '</g>'

      + '</svg>'
  }

  function miniStarSvg() {
    return '<svg class="dshk-mini" viewBox="-14 -14 28 28" aria-hidden="true">'
      + '<path d="M0,-13C1.4,-4.6 4.6,-1.4 13,0 4.6,1.4 1.4,4.6 0,13 -1.4,4.6 -4.6,1.4 -13,0 -4.6,-1.4 -1.4,-4.6 0,-13Z" '
      + 'fill="url(#dshkMiniGrad)"/>'
      + '<defs><linearGradient id="dshkMiniGrad" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#7FA9F7"/><stop offset="1" stop-color="#C08BF0"/>'
      + '</linearGradient></defs></svg>'
  }

  // ==========================================================================
  // 小工具
  // ==========================================================================
  function injectStyle() {
    try {
      if (document.getElementById('dshk-style')) return
      var s = document.createElement('style')
      s.id = 'dshk-style'
      s.type = 'text/css'
      s.appendChild(document.createTextNode(CSS))
      var head = document.head || document.documentElement
      if (!head) throw new Error('no head')
      head.appendChild(s)
    } catch (err) {
      console.error(LOG + ' 样式注入失败', err)
    }
  }

  function readJson(key) {
    try {
      var raw = window.localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch (err) {
      return null
    }
  }

  function writeJson(key, val) {
    try {
      window.localStorage.setItem(key, JSON.stringify(val))
    } catch (err) {}
  }

  // ==========================================================================
  // 位置锚点（2026-10-19 加）
  // --------------------------------------------------------------------------
  // 存「离哪条边多远」，而不是绝对 left/top —— 否则从窗口化切到全屏时视口变大，
  // 挂件会钉在原来的像素位置上（用户反馈：「她不会跟着跑到全屏的左下角」）。
  // 格式照 dsh-whale-widget 的 v:2 来（那边已经验证过没这个问题）：
  //   { v:2, hAnchor:'left'|'right', hDist, vAnchor:'top'|'bottom', vDist }
  // ==========================================================================
  var POS_DEFAULT_W = 142
  var POS_DEFAULT_H = 98

  function posToAnchor(left, top, w, h) {
    var vw = window.innerWidth
    var vh = window.innerHeight
    var leftDist = Math.max(0, left)
    var rightDist = Math.max(0, vw - (left + w))
    var topDist = Math.max(0, top)
    var bottomDist = Math.max(0, vh - (top + h))
    return {
      v: 2,
      hAnchor: leftDist <= rightDist ? 'left' : 'right',
      hDist: Math.round(Math.min(leftDist, rightDist)),
      vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
      vDist: Math.round(Math.min(topDist, bottomDist))
    }
  }

  function anchorToPos(a, w, h) {
    var vw = window.innerWidth
    var vh = window.innerHeight
    var maxLeft = Math.max(0, vw - w)
    var maxTop = Math.max(0, vh - h)
    var hDist = Math.min(Math.max(0, a.hDist), maxLeft)
    var vDist = Math.min(Math.max(0, a.vDist), maxTop)
    return {
      left: a.hAnchor === 'left' ? hDist : maxLeft - hDist,
      top: a.vAnchor === 'top' ? vDist : maxTop - vDist
    }
  }

  function isAnchor(v) {
    return !!v && v.v === 2
      && (v.hAnchor === 'left' || v.hAnchor === 'right')
      && (v.vAnchor === 'top' || v.vAnchor === 'bottom')
      && typeof v.hDist === 'number' && isFinite(v.hDist) && v.hDist >= 0
      && typeof v.vDist === 'number' && isFinite(v.vDist) && v.vDist >= 0
  }

  /** 旧格式 {left,top} → 锚点；已是锚点则原样返回；都不认识返回 null。 */
  function normalizeAnchor(raw, w, h) {
    if (!raw) return null
    if (isAnchor(raw)) return raw
    if (typeof raw.left === 'number' && typeof raw.top === 'number'
      && isFinite(raw.left) && isFinite(raw.top)) {
      return posToAnchor(raw.left, raw.top, w || POS_DEFAULT_W, h || POS_DEFAULT_H)
    }
    return null
  }

  // ==========================================================================
  // 位置的服务端持久化（2026-10-19 加）
  // --------------------------------------------------------------------------
  // 背景：DSH 桌面版每次重启都换 Web GUI 端口 ⇒ 页面 origin 变 ⇒ localStorage
  // 被整个清空 ⇒ 挂件位置每次都丢。所以位置另存一份在服务端
  // （GET/POST /dsh-kitten/pos ⇄ ~/.dsh/gemini-kitten-widget/pos.json），
  // localStorage 只当「本次会话的快速缓存」。
  // 服务端不可用时这两个函数都安静失败，行为与改动前完全一致。
  // ==========================================================================
  function fetchServerPos() {
    try {
      return fetch(API_POS, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (j) {
          if (j && j.ok && j.pos && typeof j.pos.left === 'number' && typeof j.pos.top === 'number') {
            return j.pos
          }
          return null
        })
        .catch(function () { return null })
    } catch (err) {
      return Promise.resolve(null)
    }
  }

  function pushServerPos(p) {
    try {
      fetch(API_POS, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p === null ? null : { left: p.left, top: p.top }),
        keepalive: true
      }).catch(function () {})
    } catch (err) {}
  }

  // ==========================================================================
  // 主流程
  // ==========================================================================
  function init() {
    var state = { ok: false, level: 'unknown', used: null, limit: 20, remaining: null, resetAt: 0, perModel: [] }
    var lastLineIdx = -1
    // 上一次看到的"今日合计"调用数 —— 用来发现"别的会话又派了哈基米子代理"。
    // null = 还没拿到过基线（首次加载只记录、不播报）。
    var lastTotalUsed = null
    // 徽章视图：0 = 自动（盯"最紧的那个模型"）；1..N = 点徽章选中的第 N 个模型。
    // 配额是**按模型**算的，所以需要一个办法让用户看到"别的型号还剩多少"。
    var viewIdx = 0
    var sayTimer = null
    var refreshTimer = null

    // —— 建 DOM ——
    var root = null
    var art = null
    var bubble = null
    var usedEl = null
    var limitEl = null
    var fillEl = null
    var row2El = null

    try {
      root = document.createElement('div')
      root.className = 'dshk-root'
      root.setAttribute('data-level', 'unknown')
      root.innerHTML = ''
        + '<div class="dshk-bubble"></div>'
        + '<div class="dshk-art"></div>'
        + '<div class="dshk-badge">'
        + '<div class="dshk-row1">' + miniStarSvg()
        + '<span class="dshk-used">—</span><span class="dshk-limit">/…</span></div>'
        + '<div class="dshk-track"><i class="dshk-fill"></i></div>'
        + '<div class="dshk-row2">连接中…</div>'
        + '</div>'
      art = root.querySelector('.dshk-art')
      bubble = root.querySelector('.dshk-bubble')
      usedEl = root.querySelector('.dshk-used')
      limitEl = root.querySelector('.dshk-limit')
      fillEl = root.querySelector('.dshk-fill')
      row2El = root.querySelector('.dshk-row2')
      if (!art || !bubble || !usedEl || !fillEl || !row2El) throw new Error('DOM 结构不完整')
    } catch (err) {
      console.error(LOG + ' 构建 DOM 失败，挂件不显示', err)
      return
    }

    // —— 位置：默认坐在鲸鱼挂件头顶上方（right:10 / bottom:158），可拖走并记忆 ——
    function setPos(left, top) {
      root.style.left = left + 'px'
      root.style.top = top + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    }

    function clampAndApply(left, top) {
      var r = root.getBoundingClientRect()
      var w = window.innerWidth
      var h = window.innerHeight
      var maxLeft = Math.max(4, w - r.width - 4)
      var maxTop = Math.max(4, h - r.height - 4)
      var l = Math.min(Math.max(4, left), maxLeft)
      var t = Math.min(Math.max(4, top), maxTop)
      setPos(l, t)
      return { left: l, top: t }
    }

    /** 按锚点把挂件摆到位（启动恢复与 resize 共用）。返回夹紧后的 left/top。 */
    function applyAnchorNow(a) {
      var r = root.getBoundingClientRect()
      var w = r.width || POS_DEFAULT_W
      var h = r.height || POS_DEFAULT_H
      var p = anchorToPos(a, w, h)
      return clampAndApply(p.left, p.top)
    }

    /** 把当前实际位置反算成锚点（并夹成合法值）。 */
    function currentAnchor() {
      var r = root.getBoundingClientRect()
      return posToAnchor(r.left, r.top, r.width || POS_DEFAULT_W, r.height || POS_DEFAULT_H)
    }

    /**
     * 立绘默认**脸朝左**；拖到视口左半边就镜像成朝右，让她始终面向屏幕中央。
     * （小鲸鱼的「翻转线」是同一个思路，只是那边可调；这里固定在中线。）
     */
    function updateFlip() {
      try {
        var r = root.getBoundingClientRect()
        var inLeftHalf = (r.left + r.width / 2) < (window.innerWidth / 2)
        if (inLeftHalf) root.classList.add('dshk-flip')
        else root.classList.remove('dshk-flip')
      } catch (err) {}
    }

    try {
      // 位置一律按「锚点」恢复：锚点只认视口尺寸，不认绝对像素 ⇒ 窗口化/全屏切换时不会跑偏。
      var savedAnchor = normalizeAnchor(readJson(KEY_POS))
      if (savedAnchor) {
        // 首帧先用默认尺寸粗算摆上（不闪），挂载后再用真实尺寸精确重算
        var p0 = anchorToPos(savedAnchor, POS_DEFAULT_W, POS_DEFAULT_H)
        setPos(p0.left, p0.top)
        requestAnimationFrame(function () {
          try {
            var fixed = applyAnchorNow(savedAnchor)
            var a2 = currentAnchor()
            if (a2.hAnchor !== savedAnchor.hAnchor || a2.hDist !== savedAnchor.hDist
              || a2.vAnchor !== savedAnchor.vAnchor || a2.vDist !== savedAnchor.vDist) {
              writeJson(KEY_POS, a2)
            }
            updateFlip()
          } catch (err) {}
        })
      }
      // 服务端才是跨重启的真源：有值就以它为准；没有就把本地缓存推上去做种。
      fetchServerPos().then(function (serverPos) {
        // 等一帧再算：clampAndApply 依赖 root 已挂进 DOM（否则尺寸是 0，位置会跑偏）。
        requestAnimationFrame(function () {
          try {
            var localAnchor = normalizeAnchor(readJson(KEY_POS), root.offsetWidth, root.offsetHeight)
            var serverAnchor = normalizeAnchor(serverPos, root.offsetWidth, root.offsetHeight)
            if (!serverAnchor) {
              if (localAnchor) pushServerPos(localAnchor)
              return
            }
            if (localAnchor && localAnchor.hAnchor === serverAnchor.hAnchor
              && localAnchor.hDist === serverAnchor.hDist
              && localAnchor.vAnchor === serverAnchor.vAnchor
              && localAnchor.vDist === serverAnchor.vDist) return
            writeJson(KEY_POS, serverAnchor)
            applyAnchorNow(serverAnchor)
            pushServerPos(currentAnchor())
          } catch (err) {
            console.error(LOG + ' 服务端位置应用失败', err)
          }
        })
      })
    } catch (err) {
      console.error(LOG + ' 恢复位置失败（用默认位置）', err)
    }

    // —— 台词 ——
    /** 气泡定位：挂在挂件中心，但**超出视口就改成贴住那一侧**（箭头会跟着挪）。 */
    function placeBubble() {
      try {
        var r = root.getBoundingClientRect()
        var vw = window.innerWidth
        var w = Math.min(248, Math.max(120, vw - 210))
        var cx = r.left + r.width / 2
        var half = w / 2
        bubble.classList.remove('dshk-bubble-left', 'dshk-bubble-right')
        if (cx + half > vw - 8) bubble.classList.add('dshk-bubble-right')
        else if (cx - half < 8) bubble.classList.add('dshk-bubble-left')
      } catch (err) {}
    }

    function say(text) {
      try {
        bubble.textContent = text
        placeBubble()
        bubble.classList.add('dshk-show')
        if (sayTimer) clearTimeout(sayTimer)
        sayTimer = setTimeout(function () {
          bubble.classList.remove('dshk-show')
        }, 4600)
      } catch (err) {
        console.error(LOG + ' 台词显示失败', err)
      }
    }

    /**
     * 当前正在看的那个模型。
     * viewIdx 直接索引 perModel（服务端已按"最紧的排最前"排好），所以 0 就是最紧的那个。
     * ⚠️ 别再引入"自动档"：那会与 perModel[0] 指向同一个模型，第一次点击看起来像没反应。
     */
    function currentView() {
      try {
        var pm = (state && state.perModel) || []
        if (pm.length && viewIdx >= 0 && viewIdx < pm.length) return pm[viewIdx]
        if (state && state.bottleneck) {
          var ex = (state.exhaustedModels || []).indexOf(state.bottleneck) >= 0
          return { model: state.bottleneck, used: state.used, remaining: state.remaining, exhausted: ex }
        }
        return null
      } catch (err) {
        return null
      }
    }

    /** 台词里的 {model} 用的是"当前正在看的型号"短名，跟徽章所见一致。 */
    function currentModelShort() {
      var v = currentView()
      return v ? shortModel(v.model) : 'Gemini'
    }

    function pickLine() {
      try {
        var pool = LINES[state.level] || LINES.unknown
        var i = Math.floor(Math.random() * pool.length)
        if (pool.length > 1 && i === lastLineIdx) i = (i + 1) % pool.length
        lastLineIdx = i
        writeJson(KEY_LINE, i)
        var v = currentView()
        return String(pool[i])
          .replace(/\{used\}/g, v && v.used !== null && v.used !== undefined ? String(v.used) : (state.used === null ? '?' : String(state.used)))
          .replace(/\{remaining\}/g, v && v.remaining !== null && v.remaining !== undefined ? String(v.remaining) : (state.remaining === null ? '?' : String(state.remaining)))
          .replace(/\{limit\}/g, String(state.limit))
          .replace(/\{model\}/g, currentModelShort())
      } catch (err) {
        console.error(LOG + ' 选台词失败', err)
        return '喵？'
      }
    }

    function poke() {
      try {
        root.classList.remove('dshk-poke')
        // 强制重排，让动画能连续触发
        void root.offsetWidth
        root.classList.add('dshk-poke')
        setTimeout(function () {
          try { root.classList.remove('dshk-poke') } catch (e) {}
        }, 460)
        say(pickLine())
      } catch (err) {
        console.error(LOG + ' poke 失败', err)
      }
    }

    /**
     * 挂载形象：优先用 host 下发的透明 PNG 立绘；
     * 加载失败（路由注销 / 图被删 / CSP）时**回退到手写 SVG**，绝不留一块空白。
     */
    function mountArt() {
      try {
        if (!art) return
        var img = document.createElement('img')
        img.className = 'dshk-img'
        img.alt = ''
        img.setAttribute('draggable', 'false')
        img.addEventListener('error', function () {
          console.warn(LOG + ' 立绘 ' + ART_PATH + ' 加载失败，回退到手写 SVG')
          try {
            art.innerHTML = buildSvg()
          } catch (err) {
            console.error(LOG + ' SVG 回退也失败', err)
          }
        })
        img.src = ART_PATH
        while (art.firstChild) art.removeChild(art.firstChild)
        art.appendChild(img)
      } catch (err) {
        console.error(LOG + ' 立绘挂载失败，直接用 SVG', err)
        try { art.innerHTML = buildSvg() } catch (err2) {}
      }
    }

    // —— 渲染状态 ——
    function humanizeReset(resetAt) {
      try {
        var ms = Number(resetAt) - Date.now()
        if (!isFinite(ms) || ms <= 0) return '即将重置'
        var mins = Math.round(ms / 60000)
        if (mins < 60) return mins + ' 分钟后重置'
        var hours = Math.floor(mins / 60)
        var rem = mins % 60
        if (hours >= 10 || rem === 0) return hours + ' 小时后重置'
        return hours + ' 小时 ' + rem + ' 分后重置'
      } catch (err) {
        return ''
      }
    }

    /** 徽章副行位置有限：13 小时后重置 → 13h 后重置。 */
    function shortReset(resetAt) {
      try {
        var ms = Number(resetAt) - Date.now()
        if (!isFinite(ms) || ms <= 0) return '即将重置'
        var mins = Math.round(ms / 60000)
        if (mins < 60) return mins + ' 分后重置'
        return Math.floor(mins / 60) + 'h 后重置'
      } catch (err) {
        return ''
      }
    }

    /** 悬停详情：配额是按模型算的，所以要把"最紧的那个"和各模型明细都说清楚。 */
    function buildTooltip(s) {
      try {
        var lines = []
        lines.push('Gemini 免费层配额（每个模型 ' + s.limit + ' 次/天）')
        if (s.bottleneck) {
          lines.push('最紧：' + s.bottleneck + ' — 已用 ' + s.used + ' / ' + s.limit + '，剩 ' + s.remaining + ' 次')
        } else {
          lines.push('今天还没用过 Gemini')
        }
        var pm = s.perModel || []
        if (pm.length > 1) {
          lines.push('各模型：')
          for (var i = 0; i < pm.length; i++) {
            lines.push('  · ' + pm[i].model + '：用 ' + pm[i].used + '，剩 ' + pm[i].remaining)
          }
        }
        lines.push('重置：' + humanizeReset(s.resetAt) + '（UTC 午夜 / 北京 08:00）')
        lines.push('数据来源：' + (s.source === 'session-log' ? 'DSH 会话日志（逐次调用）' : '账本（按轮次聚合，偏低）'))
        if (s.degraded) lines.push('⚠️ 部分日志读不到，数字可能偏低')
        if (s.stale) lines.push('⚠️ 账本正在写入，数字可能略有延迟')
        return lines.join('\n')
      } catch (err) {
        return 'Gemini 免费层配额'
      }
    }

    function render(next) {
      state = next
      try {
        if (state.ok) {
          var v = currentView()
          var limit = state.limit || 20
          var vUsed = v && typeof v.used === 'number' ? v.used : (typeof state.used === 'number' ? state.used : 0)
          var vRemain = v && typeof v.remaining === 'number' ? v.remaining : (state.remaining || 0)
          var ratio = limit > 0 ? Math.max(0, Math.min(1, vUsed / limit)) : 0
          // 色级按"**正在看的这个型号**"算。从前永远按最紧的算 —— 于是 3.8 一用尽，
          // 连还剩 18 次的 3.6 也跟着飘红（用户 2026-10-15 反馈）。
          var lvl = (v && v.exhausted) ? 'danger' : (ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok')
          root.setAttribute('data-level', lvl)
          usedEl.textContent = String(vUsed)
          limitEl.textContent = '/' + limit
          fillEl.style.width = (ratio * 100).toFixed(1) + '%'
          // 副行：**型号 + 该型号剩余 + 今日合计**。
          // 为什么要"今日合计"：原先只显示"最紧的那个模型"，于是**别的会话派子代理消耗配额时，
          // 只要没顶到 80% 告警线，挂件就一声不响** —— 用户 2026-10-16 的原话是
          // 「本机今天跑了很多哈基米子代理调用，但我完全不知道」。合计放在这一行，一眼可见。
          // 重置时间挪进 tooltip（徽章宽度有限，一行放不下三样）。
          var parts = []
          if (v) parts.push(shortModel(v.model) + ' 剩' + vRemain)
          if (typeof state.totalUsed === 'number') parts.push('今日' + state.totalUsed + '次')
          row2El.textContent = parts.length ? parts.join(' · ') : shortReset(state.resetAt)
          root.title = buildTooltip(state) + '\n\n（点徽章切换型号）'
        } else {
          root.setAttribute('data-level', 'unknown')
          usedEl.textContent = '—'
          limitEl.textContent = '/' + String(state.limit || 20)
          fillEl.style.width = '0%'
          row2El.textContent = '额度读取失败'
          root.title = 'Gemini 额度挂件：读不到账本与会话日志'
        }
      } catch (err) {
        console.error(LOG + ' 渲染失败', err)
      }
    }

    /**
     * 阈值主动提醒 —— 用户 2026-10-16 的原话：「本机今天跑了很多哈基米子代理调用，
     * 但我完全不知道」。要的是**可见性**；但"用量又涨了"和"马上要撞 429 了"不是一回事：
     * 免费层每模型 20 次/天，撞 429 就等于白烧一轮子代理 ⇒ 快用光 / 已用光必须专门喊。
     *
     * 规则（每个配额日每条只喊一次 —— 否则 30 秒刷一次就喊一次，会烦死人）：
     *   ① 某型号**实测用尽**（host 用 429 原文确认过，比本地估算权威）
     *   ② 最紧的型号到 80%（还剩几次，该换型号了）
     * 优先级 ① > ② > 日常的「总量涨了」。返回 null = 这次不用喊。
     *
     * 判据只读本次 payload、不读 state —— 免得受 render 的时序影响。
     */
    function thresholdAlert(data) {
      try {
        // 配额日优先用 host 下发的 today（与它的重置口径严格一致）。
        // ⚠️ 万一它没给（老 host / 测试用的 mock），**退化成客户端自算的 UTC 日**，
        // 而不是直接放弃 —— 提醒宁可晚一天重置，也不能整个静默失效。
        // （2026-10-16 实测踩到：预览工具 shot.mjs 的 mock 没给 today，提醒就一声不响，
        //   看图以为"功能没生效"，其实是判据提前 return 了。）
        var day = String(data.today || '')
        if (!day) {
          var d2 = new Date()
          day = d2.getUTCFullYear() + '-' + ('0' + (d2.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d2.getUTCDate()).slice(-2)
        }
        var st = readJson(KEY_ALERT)
        if (!st || typeof st !== 'object' || st.day !== day) st = { day: day, fired: {} }
        var fired = st.fired && typeof st.fired === 'object' ? st.fired : {}
        var line = null
        var i

        // ① 实测用尽（429 原文确认过；本地估算偏低时也算数）
        var ex = Array.isArray(data.exhaustedModels) ? data.exhaustedModels : []
        for (i = 0; i < ex.length; i++) {
          var ke = 'exhausted:' + ex[i]
          if (fired[ke]) continue
          fired[ke] = 1
          if (!line) line = shortModel(ex[i]) + ' 今天的额度用光了喵 —— 再派它就要撞 429，白烧一轮。'
        }

        // ② 最紧的型号到 80%（已经用尽的不重复喊）
        var b = data.bottleneck
        var ratio = typeof data.ratio === 'number' ? data.ratio : 0
        if (b && ratio >= 0.8 && ex.indexOf(b) < 0 && !fired['tight:' + b]) {
          fired['tight:' + b] = 1
          if (!line) {
            var remain = null
            var pm = Array.isArray(data.perModel) ? data.perModel : []
            for (i = 0; i < pm.length; i++) {
              if (pm[i] && pm[i].model === b) { remain = pm[i].remaining; break }
            }
            if (remain === null && typeof data.remaining === 'number') remain = data.remaining
            line = '最紧的 ' + shortModel(b) + ' 只剩 ' + (remain === null ? '几' : remain) + ' 次喵，省着点用。'
          }
        }

        st.fired = fired
        writeJson(KEY_ALERT, st)
        return line
      } catch (err) {
        console.error(LOG + ' 阈值提醒失败', err)
        return null
      }
    }

    function refresh(firstTime) {
      try {
        fetch(API_STATE, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (data) {
            if (!data || typeof data !== 'object') throw new Error('bad payload')
            // 把梗库（~/.dsh/widget-lines.json 的 kitten 段）里的私货追加进台词池。
            // 内置台词永远保留；indexOf 去重是因为每 30 秒就会刷一次，不去重会长成一串。
            try {
              var cl = data.customLines
              if (cl && typeof cl === 'object') {
                for (var poolName in cl) {
                  if (!Object.prototype.hasOwnProperty.call(LINES, poolName)) continue
                  var extra = cl[poolName]
                  if (!Array.isArray(extra)) continue
                  for (var li = 0; li < extra.length; li++) {
                    var s = String(extra[li] || '').trim()
                    if (s && LINES[poolName].indexOf(s) < 0) LINES[poolName].push(s)
                  }
                }
              }
            } catch (err) {
              console.error(LOG + ' 合并自定义台词失败', err)
            }
            var level = data.level
            if (level !== 'ok' && level !== 'warn' && level !== 'danger') level = 'unknown'
            render({
              ok: !!data.ok,
              level: level,
              used: typeof data.used === 'number' ? data.used : null,
              limit: typeof data.limit === 'number' ? data.limit : 20,
              remaining: typeof data.remaining === 'number' ? data.remaining : null,
              ratio: typeof data.ratio === 'number' ? data.ratio : 0,
              resetAt: data.resetAt || 0,
              bottleneck: data.bottleneck || null,
              perModel: Array.isArray(data.perModel) ? data.perModel : [],
              // 2026-10-16 补：host 一直在下发这个字段，这里当初却漏了接 ⇒ currentView()
              // 里那句兜底判断（拿 exhaustedModels 查当前型号是否已用尽）恒为 false。
              exhaustedModels: Array.isArray(data.exhaustedModels) ? data.exhaustedModels : [],
              totalUsed: typeof data.totalUsed === 'number' ? data.totalUsed : null,
              source: data.source || '',
              degraded: !!data.degraded,
              stale: !!data.stale
            })
            // 阈值提醒优先于日常播报：「马上要撞 429 了」是必须知道的事，不是顺便说说。
            var alert = thresholdAlert(data)
            var tu = typeof state.totalUsed === 'number' ? state.totalUsed : null
            if (firstTime) {
              var hour = new Date().getHours()
              if (alert) say(alert)
              else say(hour >= 23 || hour < 6 ? '这么晚还不睡喵……本喵陪着你。' : '本喵上线了喵！今天还剩 ' + state.remaining + ' 次额度。')
              // ⚠️ 首次也要把基线记下来：原先这一支不赋值，于是 lastTotalUsed 一直是 null，
              // 第二次刷新仍然比不了 —— 上面注释说的"首次只记录不播报"其实没生效（要等到第三次）。
              if (tu !== null) lastTotalUsed = tu
            } else {
              // 用量涨了就吭一声 —— 这是"别的会话派了哈基米子代理"**唯一的可见信号**。
              // 用户 2026-10-16：「本机今天跑了很多哈基米子代理调用，但我完全不知道」。
              if (alert) {
                say(alert)
              } else if (tu !== null && lastTotalUsed !== null && tu > lastTotalUsed) {
                say('有人叫哈基米了喵 —— 今天累计 ' + tu + ' 次。')
              }
              if (tu !== null) lastTotalUsed = tu
            }
          })
          .catch(function (err) {
            console.error(LOG + ' 状态拉取失败', err)
            render({ ok: false, level: 'unknown', used: null, limit: 20, remaining: null, ratio: 0, resetAt: 0 })
          })
      } catch (err) {
        console.error(LOG + ' refresh 抛异常', err)
      }
    }

    // —— 挂载 ——
    try {
      injectStyle()
      var host = document.body || document.documentElement
      if (!host) throw new Error('no body')
      host.appendChild(root)
      mountArt()
    } catch (err) {
      console.error(LOG + ' 挂载失败，挂件不显示', err)
      return
    }

    // —— 拖拽 + 吸附 + 点击 ——
    try {
      var drag = null

      function onDown(e) {
        try {
          if (e.pointerType === 'mouse' && e.button !== 0) return
          var r = root.getBoundingClientRect()
          drag = {
            id: e.pointerId,
            sx: e.clientX,
            sy: e.clientY,
            ox: r.left,
            oy: r.top,
            moved: false,
            t: Date.now()
          }
          root.classList.add('dshk-dragging')
          try { root.setPointerCapture(e.pointerId) } catch (err) {}
          if (e.cancelable) e.preventDefault()
        } catch (err) {
          console.error(LOG + ' pointerdown 失败', err)
        }
      }

      function onMove(e) {
        if (!drag || e.pointerId !== drag.id) return
        try {
          var dx = e.clientX - drag.sx
          var dy = e.clientY - drag.sy
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true
          if (!drag.moved) return
          setPos(drag.ox + dx, drag.oy + dy)
        } catch (err) {
          console.error(LOG + ' pointermove 失败', err)
        }
      }

      function snap() {
        try {
          var w = window.innerWidth
          var h = window.innerHeight
          var r = root.getBoundingClientRect()
          var left = r.left
          var top = r.top
          // 吸附区按**视口比例**算（照 dsh-whale-widget 那套手感）：
          // 原先是写死的 74px，在 2560 宽的屏上不到 3% —— 等于没有吸附感。
          // 12% 并夹在 [60,220] / [50,200]：大屏够宽，小窗口也不会贪。
          var TH = Math.min(220, Math.max(60, Math.round(w * 0.12)))
          var THV = Math.min(200, Math.max(50, Math.round(h * 0.12)))
          // 贴边距离 4px（= clampAndApply 的下限）：原来 10px 在同一屏上看着"没吸到底"
          var EDGE = 4
          if (left < TH) left = EDGE
          else if (w - (left + r.width) < TH) left = w - r.width - EDGE
          if (top < THV) top = EDGE
          else if (h - (top + r.height) < THV) top = h - r.height - EDGE
          // 松手时给 0.16s 过渡，让「吸过去」看得见；拖动中由 .dshk-dragging 用 !important 关掉。
          try {
            root.style.transition = 'left .16s ease, top .16s ease'
            setTimeout(function () {
              try { root.style.transition = '' } catch (err) {}
            }, 220)
          } catch (err) {}
          return clampAndApply(left, top)
        } catch (err) {
          console.error(LOG + ' 吸附失败', err)
          return null
        }
      }

      function onUp(e) {
        if (!drag || e.pointerId !== drag.id) return
        var wasClick = !drag.moved && Date.now() - drag.t < 700
        drag = null
        try {
          root.classList.remove('dshk-dragging')
          try { root.releasePointerCapture(e.pointerId) } catch (err) {}
          if (wasClick) {
            poke()
          } else {
            var p = snap()
            if (p) {
              var a = posToAnchor(p.left, p.top, root.offsetWidth || POS_DEFAULT_W, root.offsetHeight || POS_DEFAULT_H)
              writeJson(KEY_POS, a)
              pushServerPos(a)
              updateFlip()
            }
          }
        } catch (err) {
          console.error(LOG + ' pointerup 失败', err)
        }
      }

      root.addEventListener('pointerdown', onDown)
      root.addEventListener('pointermove', onMove)
      root.addEventListener('pointerup', onUp)
      root.addEventListener('pointercancel', function (e) {
        if (!drag || e.pointerId !== drag.id) return
        drag = null
        try { root.classList.remove('dshk-dragging') } catch (err) {}
      })
      // —— 点徽章 = 换一个型号看（猫娘本体仍然是"点一下换台词"）——
      //   配额按模型独立，可徽章一次只放得下一行；从前永远显示"最紧的那个"，
      //   于是 3.8 一用尽就整片飘红，把还宽裕的型号全埋了（用户 2026-10-15 反馈）。
      try {
        var badgeEl = root.querySelector('.dshk-badge')
        if (badgeEl) {
          // 拦掉 pointerdown：否则会冒泡到 root 触发拖拽/单击逻辑（点徽章就变成换台词了）
          badgeEl.addEventListener('pointerdown', function (e) {
            try { e.stopPropagation() } catch (err) {}
          })
          badgeEl.addEventListener('click', function (e) {
            try {
              e.preventDefault()
              e.stopPropagation()
              var pm = (state && state.perModel) || []
              var n = pm.length
              if (!n) {
                say('本喵还没数到任何型号喵……')
                return
              }
              viewIdx = (viewIdx + 1) % n
              render(state)
              var m = pm[viewIdx]
              say(shortModel(m.model) + ' 还剩 ' + m.remaining + ' 次'
                + (m.exhausted ? '——已经躺平了喵' : '喵。'))
            } catch (err) {
              console.error(LOG + ' 切换型号失败', err)
            }
          })
        }
      } catch (err) {
        console.error(LOG + ' 徽章切换注册失败', err)
      }

      // 右键菜单里给一个「回到默认位置」
      // （不再单独监听 dblclick：pointerup 已经处理了单击，双击会连换三次台词，太吵）
      root.addEventListener('contextmenu', function (e) {
        try {
          e.preventDefault()
          writeJson(KEY_POS, null)
          pushServerPos(null)
          root.style.left = 'auto'
          root.style.top = 'auto'
          root.style.right = '10px'
          root.style.bottom = '158px'
          window.localStorage.removeItem(KEY_POS)
          say('好嘛，本喵回去蹲着了喵。')
        } catch (err) {
          console.error(LOG + ' 右键复位失败', err)
        }
      })
    } catch (err) {
      console.error(LOG + ' 交互注册失败（挂件会显示但点不动）', err)
    }

    // —— 窗口变化：按锚点重映射（2026-10-19 改）——
    // 旧逻辑只在「真的跑到视口外」时复位；窗口化 → 全屏时视口变大，挂件却还钉在原来的
    // 像素位置上，看起来"不跟窗口走"（用户反馈：拖到左下角，全屏后不在左下角）。
    // 现在按存的锚点重算：左锚点 + 下锚点 ⇒ 任何视口下都贴着左下角。
    // ⚠️ debounce + rAF：resize 期间布局往往还没更新，立刻读 rect 会拿到旧值
    //    （2026-10-18 那版"每次 resize 重算就一格一格地漂"的坑正是这么来的）。
    try {
      var resizeTimer = null
      window.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(function () {
          resizeTimer = null
          requestAnimationFrame(function () {
            try {
              var a = normalizeAnchor(readJson(KEY_POS), root.offsetWidth, root.offsetHeight)
              if (a) applyAnchorNow(a)
              updateFlip()
            } catch (err) {}
          })
        }, 120)
      })
      document.addEventListener('visibilitychange', function () {
        try {
          if (!document.hidden) refresh(false)
        } catch (err) {}
      })
    } catch (err) {
      console.error(LOG + ' 视口监听注册失败', err)
    }

    // —— 定时刷新 ——
    try {
      refresh(true)
      refreshTimer = setInterval(function () {
        try { refresh(false) } catch (err) {}
      }, REFRESH_MS)
    } catch (err) {
      console.error(LOG + ' 刷新定时器启动失败', err)
    }

    console.log(LOG + ' 挂件已上线（client ' + (window.__dshKittenVersion || 'dev') + '）')
  }

  // —— 启动（body 可能还没到，兜一层）——
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        try { init() } catch (err) { console.error(LOG + ' init 抛异常', err) }
      })
    } else {
      try {
        init()
      } catch (err) {
        console.error(LOG + ' init 抛异常', err)
      }
    }
  } catch (err) {
    console.error(LOG + ' 启动失败', err)
  }
})()
