/**
 * 液態玻璃背景（opt-in）：主程序在 glass 模式設 <html data-glass="1"> 後才啟動。
 * 一張 WebGL 畫布鋪在最底層（z-index:-1），畫深灰流動的液體，並在側欄／頂欄／各 PTY 視窗
 * 的邊緣畫出折射與光暈。畫布不透明（視窗本身也不透明）。
 * 終端機內容層完全不受影響；50% 解析度、跟著螢幕更新率（約 60fps），失焦時降到每秒 4 格。
 */
const SELECTOR = ".sidebar, .topbar, .xterm-pane-frame";
const MAX_RECTS = 8;
const SCALE = 0.5;

const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FRAG = `precision highp float;
uniform vec2 r;uniform float t;uniform float S;uniform vec4 R[${MAX_RECTS}];uniform vec3 m;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*n(p);p*=2.;a*=.5;}return v;}
float sdb(vec2 p,vec4 b,float rad){vec2 c=b.xy+b.zw*.5;vec2 q=abs(p-c)-b.zw*.5+rad;return length(max(q,0.))+min(max(q.x,q.y),0.)-rad;}
vec3 field(vec2 p){
  vec2 u=p/r.y;float s=t*.06;
  vec2 q=vec2(fbm(u*2.+s),fbm(u*2.-s));
  float f=fbm(u*2.+q*2.);
  vec3 a=vec3(.030,.032,.040);
  vec3 b=vec3(.230,.240,.275);
  vec3 c=vec3(.110,.120,.150);
  vec3 col=mix(a,b,clamp(f*1.5,0.,1.));
  col=mix(col,c,clamp(length(q)*.8,0.,1.)*.7);
  float ridge=1.-abs(2.*fbm(u*3.+q*1.5+s)-1.);
  col+=pow(ridge,7.)*.20*vec3(.85,.92,1.);
  return col;
}
void main(){
  vec2 p=gl_FragCoord.xy;p.y=r.y-p.y;
  vec2 dv=p-m.xy;float d=length(dv);float age=t-m.z;
  // 一圈柔和的環形水波：環往外擴、慢慢淡出，不是一串細密的紋
  float rr=age*200.*S;float dd=d-rr;float w=70.*S;
  float env=exp(-dd*dd/(w*w))*exp(-age*.55)*step(0.,age)*smoothstep(0.,.4,age);
  float rip=sin(dd/(w*.45))*env;
  vec3 col=field(p+dv/max(d,1.)*rip*12.*S);
  col+=max(rip,0.)*.10*vec3(.8,.9,1.);
  float glow=0.;
  for(int i=0;i<${MAX_RECTS};i++){
    vec4 b=R[i];
    if(b.z<1.)continue;
    float rad=10.*S;float sd=sdb(p,b,rad);
    glow+=exp(-max(sd,0.)/(10.*S))*.06*step(0.,sd);
    if(sd<0.){
      vec2 e=vec2(1.,0.);
      vec2 g=normalize(vec2(sdb(p+e.xy,b,rad)-sd,sdb(p+e.yx,b,rad)-sd)+vec2(1e-4));
      float edge=smoothstep(-16.*S,0.,sd);
      vec3 rf=vec3(field(p-g*edge*34.*S).r,field(p-g*edge*28.*S).g,field(p-g*edge*22.*S).b);
      col=mix(rf*.85,rf*1.15,edge);
      col+=pow(edge,5.)*.22*vec3(.75,.92,1.);
      col+=smoothstep(-2.*S,0.,sd)*.14;
    }
  }
  col+=glow*vec3(.55,.75,.9);
  gl_FragColor=vec4(col,1.);
}`;

export function startGlassShader(): () => void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => undefined;
  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  cv.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none";
  const gl = cv.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power" });
  if (!gl) return () => undefined;
  const compile = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => undefined;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = {
    r: gl.getUniformLocation(prog, "r"), t: gl.getUniformLocation(prog, "t"), S: gl.getUniformLocation(prog, "S"),
    R: gl.getUniformLocation(prog, "R"), m: gl.getUniformLocation(prog, "m"),
  };
  gl.clearColor(0, 0, 0, 0);
  document.body.prepend(cv);

  const rects = new Float32Array(MAX_RECTS * 4);
  const click = { x: 0, y: 0, t: -10 };
  const resize = (): void => {
    cv.width = Math.max(2, Math.floor(window.innerWidth * SCALE));
    cv.height = Math.max(2, Math.floor(window.innerHeight * SCALE));
  };
  const measure = (): void => {
    rects.fill(0);
    const els = document.querySelectorAll(SELECTOR);
    for (let i = 0; i < els.length && i < MAX_RECTS; i++) {
      const el = els.item(i);
      const q = el.getBoundingClientRect();
      if (q.width < 4 || q.height < 4) continue;
      rects[i * 4] = q.left * SCALE; rects[i * 4 + 1] = q.top * SCALE;
      rects[i * 4 + 2] = q.width * SCALE; rects[i * 4 + 3] = q.height * SCALE;
    }
  };
  const onDown = (e: PointerEvent): void => {
    click.x = e.clientX * SCALE; click.y = e.clientY * SCALE; click.t = performance.now() / 1000;
  };
  resize(); measure();
  window.addEventListener("resize", resize);
  window.addEventListener("pointerdown", onDown, { passive: true });

  let raf = 0; let last = 0; let frameNo = 0;
  const draw = (ms: number): void => {
    if (frameNo++ % 30 === 0) measure();
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.r, cv.width, cv.height);
    gl.uniform1f(U.t, ms / 1000);
    gl.uniform1f(U.S, SCALE);
    gl.uniform4fv(U.R, rects);
    gl.uniform3f(U.m, click.x, click.y, click.t);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  const loop = (ms: number): void => {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    // 失焦時降到每秒 4 格（仍要畫出第一張，否則畫布是透明的）
    if (ms - last < (document.hasFocus() ? 14 : 250)) return;
    last = ms;
    // 每 6 秒在畫面上隨機盪出一圈水波（點擊也會）
    if (ms / 1000 - click.t > 6) { click.x = Math.random() * cv.width; click.y = Math.random() * cv.height; click.t = ms / 1000; }
    draw(ms);
  };
  raf = requestAnimationFrame(loop);
  (window as unknown as Record<string, unknown>).__glassDraw = draw; // 除錯：可手動畫一格

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("pointerdown", onDown);
    cv.remove();
  };
}

/** 等 main 把 data-glass 設上來（dom-ready 之後），再啟動；屬性被移除就關掉。 */
export function watchGlassShader(): void {
  let stop: (() => void) | null = null;
  const sync = (): void => {
    const on = document.documentElement.dataset.glass === "1";
    if (on && !stop) stop = startGlassShader();
    else if (!on && stop) { stop(); stop = null; }
  };
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-glass"] });
  sync();
}
