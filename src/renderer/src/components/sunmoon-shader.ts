/**
 * 日月版型背景（uiSkin=sunmoon 時才啟動）：一張靜態 WebGL 畫布鋪在最底層。
 * 太陽＝午後陽光穿窗打在暖紙牆上（窗框投影＋樹葉篩光＋右上日暈）；
 * 月亮＝同一扇窗的月光＋右上月暈＋左下桌燈暖光。
 * 沒有動畫迴圈：只在主題切換、視窗改大小時各畫一次，平常 GPU 零負擔。
 * 終端（PTY）一律不透明，畫布只從側欄、頂欄與視窗間的縫隙露出來。
 *
 * 不常駐 WebGL：Chromium 一個頁面最多同時活 16 個 WebGL context，滿了就把
 * 「最舊的」殺掉——開機第一個建的就是這張背景，所以 PTY 一多它最先陣亡，
 * 側欄底色整片翻成另一個主題（2026-10-03 maintainer截圖）。現在每次只借一個
 * 臨時 context 畫完、拷到普通 2D 畫布、立刻歸還；GPU 不給就退回 2D 漸層。
 */
const VERT = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";
const FRAG = `precision highp float;
uniform vec2 R;uniform float T;uniform float D;
float h21(vec2 p){p=fract(p*vec2(233.34,851.73));p+=dot(p,p+23.45);return fract(p.x*p.y);}
float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(h21(i),h21(i+vec2(1.0,0.0)),f.x),mix(h21(i+vec2(0.0,1.0)),h21(i+vec2(1.0,1.0)),f.x),f.y);}
float fbm(vec2 p){float s=0.0,a=0.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);
  for(int i=0;i<6;i++){s+=a*vn(p);p=m*p+vec2(3.1,1.7);a*=0.5;}return s;}
float sbox(vec2 p,vec2 lo,vec2 hi,float f){vec2 a=smoothstep(lo-f,lo+f,p)*(1.0-smoothstep(hi-f,hi+f,p));return a.x*a.y;}
float windowLight(vec2 uv,vec2 o,float rot,float sh,vec2 cell,float soft){
  vec2 p=uv-o;float c=cos(rot),s=sin(rot);
  p=mat2(c,-s,s,c)*p;p.x+=p.y*sh;p/=cell;
  float depth=clamp(p.y/3.0,0.0,1.0);
  float f=soft*(0.6+2.4*depth);
  float L=0.0;
  for(int i=0;i<2;i++){for(int j=0;j<3;j++){
    vec2 lo=vec2(float(i),float(j))+vec2(0.07,0.055);
    vec2 hi=vec2(float(i)+1.0,float(j)+1.0)-vec2(0.07,0.055);
    L+=sbox(p,lo,hi,f);
  }}
  return L*(1.0-0.35*depth);
}
void main(){
  vec2 fc=vec2(gl_FragCoord.x,R.y-gl_FragCoord.y);
  vec2 uv=fc/R.y;float A=R.x/R.y;
  float g=h21(floor(gl_FragCoord.xy/D)+T*17.0)-0.5;
  vec3 col;
  if(T<0.5){
    vec3 top=vec3(0.965,0.937,0.894),bot=vec3(0.918,0.871,0.804);
    col=mix(top,bot,smoothstep(0.0,1.0,clamp(uv.y*0.75+(uv.x/A)*0.35,0.0,1.0)));
    col*=1.0+(fbm(uv*2.2+4.0)-0.5)*0.05;
    float L=windowLight(uv,vec2(0.20,-0.02),0.06,0.34,vec2(0.125,0.235),0.038);
    float leaf=smoothstep(0.34,0.70,fbm(uv*vec2(5.5,6.5)+vec2(2.0,9.0)));
    L=clamp(L*mix(1.0,leaf,0.3),0.0,1.0);
    col=mix(col*vec3(0.945,0.932,0.926),col*vec3(1.085,1.06,1.0)+vec3(0.024,0.013,0.0),L);
    float d=length(uv-vec2(A+0.02,-0.22));
    col+=vec3(1.0,0.60,0.30)*0.26*exp(-d*1.9);
    float d2=length(uv-vec2(A*0.62,1.28));
    col=mix(col,vec3(0.85,0.57,0.46),0.10*exp(-d2*2.0));
    col+=g*0.026;
  }else{
    vec3 top=vec3(0.100,0.116,0.225),bot=vec3(0.050,0.058,0.118);
    col=mix(top,bot,smoothstep(0.0,1.0,clamp(uv.y*0.85+(1.0-uv.x/A)*0.25,0.0,1.0)));
    col*=1.0+(fbm(uv*2.2+4.0)-0.5)*0.12;
    float L=windowLight(uv,vec2(0.17,0.0),0.10,0.40,vec2(0.13,0.25),0.06);
    float cloud=smoothstep(0.28,0.76,fbm(uv*vec2(2.4,3.6)+vec2(7.0,1.0)));
    L=clamp(L*mix(1.0,cloud,0.3),0.0,1.0);
    col+=vec3(0.45,0.56,1.0)*0.19*L;
    float d=length(uv-vec2(A-0.04,-0.16));
    col+=vec3(0.40,0.50,0.95)*0.26*exp(-d*2.6);
    col+=vec3(0.78,0.84,1.00)*0.07*exp(-d*9.0);
    float dl=length(uv-vec2(-0.06,1.10));
    col+=vec3(0.98,0.60,0.28)*0.16*exp(-dl*2.6);
    col+=g*0.034;
  }
  gl_FragColor=vec4(col,1.0);
}`;

type Painter = (gl: WebGLRenderingContext, w: number, h: number, theme: number, dpr: number) => void;

/** 借一個臨時 WebGL context 把 shader 畫進 offscreen canvas；畫完由呼叫端歸還。 */
function borrowPainter(cv: HTMLCanvasElement): { gl: WebGLRenderingContext; paint: Painter } | null {
  const gl = cv.getContext("webgl", { alpha: false, antialias: false, powerPreference: "low-power", preserveDrawingBuffer: true });
  if (!gl) return null;
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
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { gl, paint: () => undefined };
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(prog, "R");
  const uT = gl.getUniformLocation(prog, "T");
  const uD = gl.getUniformLocation(prog, "D");
  return {
    gl,
    paint: (g, w, h, theme, dpr) => {
      g.viewport(0, 0, w, h);
      g.uniform2f(uR, w, h);
      g.uniform1f(uT, theme);
      g.uniform1f(uD, dpr);
      g.drawArrays(g.TRIANGLES, 0, 3);
    },
  };
}

/** GPU 借不到時的退路：同色系的 2D 漸層，至少不會整片變成另一個主題的底色。 */
function paintFallback(ctx: CanvasRenderingContext2D, w: number, h: number, light: boolean): void {
  const grad = ctx.createLinearGradient(0, 0, w * 0.35, h);
  if (light) {
    grad.addColorStop(0, "#f6efe4");
    grad.addColorStop(1, "#eadecd");
  } else {
    grad.addColorStop(0, "#1a1e39");
    grad.addColorStop(1, "#0d0f1e");
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function startSunMoonShader(): { draw: () => void; stop: () => void } | null {
  const cv = document.createElement("canvas");
  cv.className = "sunmoon-canvas";
  cv.setAttribute("aria-hidden", "true");
  cv.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none";
  const ctx = cv.getContext("2d", { alpha: false });
  if (!ctx) return null;
  document.body.prepend(cv);

  const draw = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(window.innerWidth * dpr));
    const h = Math.max(2, Math.round(window.innerHeight * dpr));
    const light = document.documentElement.dataset.theme === "light";
    cv.width = w;
    cv.height = h;
    const scratch = document.createElement("canvas");
    scratch.width = w;
    scratch.height = h;
    const painter = borrowPainter(scratch);
    if (painter && !painter.gl.isContextLost()) {
      painter.paint(painter.gl, w, h, light ? 0 : 1, dpr);
      ctx.drawImage(scratch, 0, 0);
    } else {
      paintFallback(ctx, w, h, light);
    }
    // 歸還 context：不等 GC，馬上讓出名額給 PTY 的 WebGL。
    painter?.gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
  let timer = 0;
  const onResize = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(draw, 140);
  };
  window.addEventListener("resize", onResize);
  draw();
  return {
    draw,
    stop: () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      cv.remove();
    },
  };
}

/** 跟著 <html data-skin / data-theme> 開關與重畫。 */
export function watchSunMoonShader(): void {
  let shader: ReturnType<typeof startSunMoonShader> = null;
  const sync = (): void => {
    const on = document.documentElement.dataset.skin === "sunmoon";
    if (on && !shader) shader = startSunMoonShader();
    else if (on && shader) shader.draw();
    else if (!on && shader) { shader.stop(); shader = null; }
  };
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin", "data-theme"] });
  sync();
}
