import type { ClarifyOutput, GenerateOutput, SpecOutput } from "../schemas";

export interface CannedScenario {
  id: string;
  title: string;
  input: string;
  clarify: ClarifyOutput;
  spec: SpecOutput;
  generate: GenerateOutput;
}

const TODO_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>待办清单</title>
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}
h1{font-size:22px}
.row{display:flex;gap:8px;margin-bottom:12px}
input{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px}
button{padding:8px 12px;border:0;border-radius:6px;background:#171717;color:#fff;cursor:pointer}
li{display:flex;align-items:center;gap:8px;padding:6px 0;list-style:none}
ul{padding:0}
.done span{text-decoration:line-through;color:#999}
.del{background:#eee;color:#333}
</style>
</head>
<body>
<h1>待办清单</h1>
<div class="row"><input id="inp" placeholder="要做点什么？"><button id="add">添加</button></div>
<ul id="list"></ul>
<script>
var items=[];
var inp=document.getElementById('inp');
var list=document.getElementById('list');
function render(){
  list.innerHTML='';
  items.forEach(function(it,i){
    var li=document.createElement('li');
    if(it.done)li.className='done';
    var cb=document.createElement('input');
    cb.type='checkbox';cb.checked=it.done;
    cb.onchange=function(){items[i].done=!items[i].done;render();};
    var sp=document.createElement('span');
    sp.textContent=it.text;sp.style.flex='1';
    var del=document.createElement('button');
    del.textContent='删除';del.className='del';
    del.onclick=function(){items.splice(i,1);render();};
    li.appendChild(cb);li.appendChild(sp);li.appendChild(del);
    list.appendChild(li);
  });
}
function add(){
  var t=inp.value.trim();
  if(!t)return;
  items.push({text:t,done:false});
  inp.value='';render();
}
document.getElementById('add').onclick=add;
inp.onkeydown=function(e){if(e.key==='Enter')add();};
render();
</script>
</body>
</html>`;

const SNAKE_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>贪吃蛇</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;margin-top:24px}
canvas{border:2px solid #171717;background:#fff}
p{color:#555}
</style>
</head>
<body>
<h1>贪吃蛇</h1>
<canvas id="c" width="300" height="300"></canvas>
<p>方向键控制 · 得分: <span id="s">0</span> · <button id="r">重开</button></p>
<script>
var N=15,CELL=20,c=document.getElementById('c').getContext('2d');
var snake,dir,food,score,alive,timer;
function reset(){
  snake=[{x:7,y:7}];dir={x:1,y:0};score=0;alive=true;
  place();document.getElementById('s').textContent='0';
  clearInterval(timer);timer=setInterval(tick,150);
}
function place(){
  do{food={x:Math.floor(Math.random()*N),y:Math.floor(Math.random()*N)};}
  while(snake.some(function(s){return s.x===food.x&&s.y===food.y;}));
}
function tick(){
  if(!alive)return;
  var h={x:snake[0].x+dir.x,y:snake[0].y+dir.y};
  if(h.x<0||h.y<0||h.x>=N||h.y>=N||snake.some(function(s){return s.x===h.x&&s.y===h.y;})){
    alive=false;clearInterval(timer);
    c.fillStyle='rgba(0,0,0,.6)';c.fillRect(0,0,300,300);
    c.fillStyle='#fff';c.font='20px sans-serif';c.fillText('游戏结束',105,155);
    return;
  }
  snake.unshift(h);
  if(h.x===food.x&&h.y===food.y){
    score++;document.getElementById('s').textContent=String(score);place();
  }else{snake.pop();}
  c.fillStyle='#fff';c.fillRect(0,0,300,300);
  c.fillStyle='#e11d48';c.fillRect(food.x*CELL,food.y*CELL,CELL-1,CELL-1);
  c.fillStyle='#171717';
  snake.forEach(function(s){c.fillRect(s.x*CELL,s.y*CELL,CELL-1,CELL-1);});
}
document.onkeydown=function(e){
  var k=e.key;
  if(k==='ArrowUp'&&dir.y!==1)dir={x:0,y:-1};
  else if(k==='ArrowDown'&&dir.y!==-1)dir={x:0,y:1};
  else if(k==='ArrowLeft'&&dir.x!==1)dir={x:-1,y:0};
  else if(k==='ArrowRight'&&dir.x!==-1)dir={x:1,y:0};
  else return;
  e.preventDefault();
};
document.getElementById('r').onclick=reset;
reset();
</script>
</body>
</html>`;

const TIMER_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>计时器</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;margin-top:40px}
#t{font-size:56px;font-variant-numeric:tabular-nums;margin:16px 0}
button{padding:8px 16px;margin:0 4px;border:0;border-radius:6px;background:#171717;color:#fff;cursor:pointer}
button:disabled{background:#ccc;cursor:default}
</style>
</head>
<body>
<h1>计时器</h1>
<div id="t">00:00.0</div>
<div>
<button id="start">开始</button>
<button id="lap" disabled>计次</button>
<button id="reset">重置</button>
</div>
<ul id="laps"></ul>
<script>
var t0=0,elapsed=0,raf=null,running=false;
var disp=document.getElementById('t');
var startBtn=document.getElementById('start');
var lapBtn=document.getElementById('lap');
function fmt(ms){
  var m=Math.floor(ms/60000),s=Math.floor(ms%60000/1000),d=Math.floor(ms%1000/100);
  return (m<10?'0':'')+m+':'+(s<10?'0':'')+s+'.'+d;
}
function draw(){disp.textContent=fmt(elapsed+(running?Date.now()-t0:0));
  if(running)raf=requestAnimationFrame(draw);}
startBtn.onclick=function(){
  if(running){elapsed+=Date.now()-t0;running=false;startBtn.textContent='继续';lapBtn.disabled=true;cancelAnimationFrame(raf);}
  else{t0=Date.now();running=true;startBtn.textContent='暂停';lapBtn.disabled=false;raf=requestAnimationFrame(draw);}
};
lapBtn.onclick=function(){
  var li=document.createElement('li');
  li.textContent=disp.textContent;
  document.getElementById('laps').appendChild(li);
};
document.getElementById('reset').onclick=function(){
  running=false;elapsed=0;cancelAnimationFrame(raf);
  disp.textContent='00:00.0';startBtn.textContent='开始';lapBtn.disabled=true;
  document.getElementById('laps').innerHTML='';
};
</script>
</body>
</html>`;

export const cannedScenarios: CannedScenario[] = [
  {
    id: "todo",
    title: "待办清单",
    input: "我想要一个待办清单应用",
    clarify: {
      status: "ready",
      questions: [],
      summary: "单页待办清单：添加、勾选完成、删除任务，无需持久化。",
    },
    spec: {
      requirements: ["添加任务", "勾选标记完成", "删除任务", "回车快捷添加"],
      constraints: ["单文件 HTML", "内联样式与脚本", "无外部依赖"],
      userStories: ["作为用户，我可以添加待办并勾选完成，以便跟踪日常任务"],
    },
    generate: {
      code: TODO_HTML,
      notes: "原生 JS 实现增删勾选，无持久化（刷新清空）。",
    },
  },
  {
    id: "snake",
    title: "贪吃蛇",
    input: "做一个贪吃蛇小游戏",
    clarify: {
      status: "ready",
      questions: [],
      summary:
        "Canvas 贪吃蛇：方向键控制、吃食物得分、撞墙/撞自身结束、可重开。",
    },
    spec: {
      requirements: [
        "方向键控制移动",
        "吃食物加分并变长",
        "碰撞检测结束游戏",
        "重开按钮",
      ],
      constraints: ["单文件 HTML", "Canvas 渲染", "无外部依赖"],
      userStories: ["作为用户，我可以用方向键玩贪吃蛇并在结束后重开一局"],
    },
    generate: {
      code: SNAKE_HTML,
      notes: "15x15 网格，150ms  tick，setInterval 驱动。",
    },
  },
  {
    id: "timer",
    title: "计时器",
    input: "做一个计时器",
    clarify: {
      status: "ready",
      questions: [],
      summary: "秒表计时器：开始/暂停/继续、计次、重置，精度 0.1 秒。",
    },
    spec: {
      requirements: ["开始/暂停/继续", "计次记录", "重置", "0.1 秒精度显示"],
      constraints: ["单文件 HTML", "requestAnimationFrame 驱动", "无外部依赖"],
      userStories: ["作为用户，我可以计时并记录多个计次点"],
    },
    generate: {
      code: TIMER_HTML,
      notes: "rAF 驱动显示，暂停累计 elapsed，避免计时漂移。",
    },
  },
];

export function getCannedScenario(id: string): CannedScenario | undefined {
  return cannedScenarios.find((s) => s.id === id);
}
