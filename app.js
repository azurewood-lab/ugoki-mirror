import { FrameBuffer, capturePlan } from './frame-buffer.mjs';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['app','source','display','empty','empty-text','view-state','status','start','pause','watch','again','switch','fullscreen','end','review-controls','seek','clip-time','quality','metrics','seconds','viewer','speed','speed-setting','mirror','mode-hint','screen-note'].map(id => [id, $(id)]));
const profiles = { standard:{width:480,height:270,fps:10}, light:{width:320,height:180,fps:8} };
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const REVIEW_MS = 60000, SESSION_MS = 15 * 60 * 1000;
const ctx = ui.display.getContext('2d', {alpha:false});
let mode = 'delay', phase = 'idle', generation = 0, session = null, review = null;
let rate = 0.5, selectedDevice = '', devices = [], retainedTimer = 0, reviewRaf = 0;

function message(text, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
}
function overlay(text = '') {
  ui.empty.hidden = !text;
  if (text) ui['empty-text'].textContent = text;
}
function badge(text = '') {
  ui['view-state'].textContent = text && ui.mirror.checked ? `${text}／左右反転` : text;
  ui['view-state'].hidden = !text;
}
function seconds() { return Number(ui.seconds.value); }
function paint(image) {
  ctx.save();
  if (ui.mirror.checked) { ctx.translate(ui.display.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(image, 0, 0, ui.display.width, ui.display.height);
  ctx.restore();
}
function blank() {
  ui.display.width = 480; ui.display.height = 270;
  if (!ctx) return;
  ctx.fillStyle = '#303438'; ctx.fillRect(0,0,480,270);
}
function modeDescription() {
  return mode === 'delay' ? `${seconds()}秒あとに、自動で映るよ。` : `動いたあとに「直前${seconds()}秒を見る」を押そう。`;
}
function renderControls() {
  const live = phase === 'live', viewing = phase === 'review';
  ui.app.dataset.phase = phase; ui.app.dataset.mode = mode; ui.viewer.dataset.phase = phase;
  ui['mode-hint'].textContent = modeDescription();
  ui.start.hidden = live;
  ui.start.disabled = phase === 'starting';
  ui.start.textContent = viewing ? 'つぎへ' : phase === 'paused' ? '再開する' : phase === 'starting' ? 'カメラ確認中…' : 'はじめる';
  ui.watch.hidden = !(live && mode === 'slow');
  ui.watch.disabled = !session?.ready;
  ui.watch.textContent = `直前${seconds()}秒を見る`;
  ui.again.hidden = !viewing;
  ui.pause.hidden = !((live && mode === 'delay') || viewing);
  ui.pause.disabled = live && !session?.ready;
  ui.pause.textContent = viewing ? (review.playing ? 'とめる' : review.position >= review.sequence.duration ? 'はじめから' : 'つづける') : 'とめる';
  ui.end.disabled = phase === 'idle';
  ui['review-controls'].hidden = !viewing;
  ui.switch.disabled = !live || devices.length < 2;
  ui.switch.title = devices.length < 2 ? 'カメラが2台以上あるときに使えます' : '次のカメラへ切り替えます。前の映像は消えます';
  for (const control of [ui.quality,ui.seconds,ui.mirror]) control.disabled = phase === 'starting';
  ui['speed-setting'].hidden = mode !== 'slow';
  document.querySelectorAll('button[data-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.mode === mode)));
  ui.speed.value = String(rate);
  if (viewing) badge(`見返し ${rate}倍・カメラ停止`);
}
function clearReview() {
  clearTimeout(retainedTimer); retainedTimer = 0;
  cancelAnimationFrame(reviewRaf); reviewRaf = 0;
  review?.sequence.clear(); review = null;
  ui.seek.value = '0'; ui['clip-time'].textContent = '';
}
function disposeSession() {
  const old = session; session = null;
  if (!old) return;
  old.disposed = true;
  cancelAnimationFrame(old.captureRaf); cancelAnimationFrame(old.renderRaf);
  if (old.videoCallback && ui.source.cancelVideoFrameCallback) ui.source.cancelVideoFrameCallback(old.videoCallback);
  clearInterval(old.watchdog); clearTimeout(old.limitTimer); clearTimeout(old.permissionTimer);
  old.stream?.getTracks().forEach(track => track.stop());
  old.buffer.clear(); old.scratch.width = old.scratch.height = 1;
  ui.source.pause(); ui.source.srcObject = null;
}
function stop(text = 'カメラを止めて、映像を消したよ。', error = false) {
  generation++; disposeSession(); clearReview(); blank();
  phase = 'idle'; badge(); overlay('「はじめる」を押そう');
  ui['screen-note'].textContent = 'カメラ停止中';
  ui.metrics.textContent = 'カメラ停止中・一時映像なし';
  message(text,error); renderControls();
}
function fail(error) {
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') selectedDevice = '';
  const help = {
    NotAllowedError:'カメラを使えません。先生とサイトのカメラ許可を確認してください。学校の制限は管理担当者へ確認し、回避しないでください。',
    NotFoundError:'カメラが見つかりません。カメラ付き端末か、接続・カバーを先生と確認して、もう一度はじめてください。',
    NotReadableError:'カメラを起動できません。ほかのカメラアプリを閉じ、接続を先生と確認してください。',
    OverconstrainedError:'このカメラでは撮影条件を満たせません。別のカメラ・端末を先生と確認してください。',
    SecurityError:'カメラが制限されています。先生・管理担当者にURLとカメラの許可を確認してください。',
    NotSupportedError:'必要な映像機能がありません。先生とブラウザーの対応状況を確認してください。',
  };
  stop(help[error?.name] || error?.userMessage || '映像の処理を続けられないため終了しました。ほかのタブを閉じ、画質を「低め」にして、もう一度はじめよう。',true);
}
async function startCamera(deviceId = '') {
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    stop('カメラにはHTTPSのページ（開発時はlocalhost）が必要です。先生にURLを確認してください。',true); return;
  }
  if (!window.createImageBitmap || !ctx) { fail({name:'NotSupportedError'}); return; }
  stop(); const ticket = generation, config = capturePlan(profiles[ui.quality.value], seconds(), MAX_IMAGE_BYTES);
  const scratch = document.createElement('canvas'); scratch.width = config.width; scratch.height = config.height;
  const s = {
    config, scratch, ctx:scratch.getContext('2d',{alpha:false}), stream:null, disposed:false,
    buffer:new FrameBuffer({maxFrames:config.maxFrames,maxBytes:MAX_IMAGE_BYTES,maxAgeMs:config.maxAgeMs}),
    pending:false, nextCapture:0, lastMedia:-1, lastVideo:performance.now(), sampleTime:performance.now(),
    sampleFrames:0, fps:0, shownTime:0, ready:false, performanceWarned:false,lastImage:performance.now(),
  };
  session = s; phase = 'starting';
  overlay('カメラの許可を待っています'); message('カメラの「許可」を選んでね。音は録らないよ。');
  renderControls();
  s.permissionTimer = setTimeout(() => {
    if (session === s) stop('開始を中断しました。許可画面を閉じ、先生とカメラの許可を確認してから、もう一度はじめてください。',true);
  },20000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:640,max:640},height:{ideal:360,max:480},frameRate:{ideal:15,max:15},...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:'environment'})}});
    if (ticket !== generation || s.disposed) { stream.getTracks().forEach(track=>track.stop()); return; }
    s.stream = stream; ui.source.srcObject = stream; await ui.source.play();
    if (ticket !== generation || s.disposed) return;
    clearTimeout(s.permissionTimer);
    if (!ui.source.videoWidth) throw {userMessage:'カメラから映像が届きません。カバーや接続を先生と確認してください。'};
    selectedDevice = stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
    stream.getVideoTracks().forEach(track=>track.addEventListener('ended',()=>{
      if (session === s) stop('カメラの接続が切れました。接続を先生と確認してから、もう一度はじめてください。',true);
    }));
    ui.display.width = config.width; ui.display.height = config.height;
    s.sampleTime = s.lastVideo = s.lastImage = performance.now(); phase = 'live';
    badge(mode === 'delay' ? `${seconds()}秒あと` : '今の映像・見返す準備中');
    message(mode === 'delay' ? `映像を準備中。${seconds()}秒待ってね。` : `準備中。${seconds()}秒待ってね。`);
    s.limitTimer = setTimeout(()=>{if(session===s) stop('15分たったので終了しました。端末の熱さを先生と確かめてから再開してください。');},SESSION_MS);
    s.watchdog = setInterval(()=>{
      if (session !== s) return;
      if (performance.now()-s.lastVideo > 5000) { stop('カメラの映像が止まりました。接続・端末の状態を先生と確認して再開してください。',true); return; }
      if (performance.now()-s.lastImage > 5000) { stop('映像の処理が進まないため終了しました。画質を「低め」にして、もう一度はじめよう。',true); return; }
      updateMetrics(s);
    },1000);
    captureLoop(s); renderLoop(s); renderControls();
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      if (session===s) {devices=list.filter(device=>device.kind==='videoinput');renderControls();}
    } catch { /* Device enumeration is optional. */ }
  } catch (error) { if (ticket===generation && !s.disposed) fail(error); }
}
function captureLoop(s) {
  const next = () => {
    if (s.disposed) return;
    if (ui.source.requestVideoFrameCallback) s.videoCallback=ui.source.requestVideoFrameCallback(step);
    else s.captureRaf=requestAnimationFrame(step);
  };
  const step = now => {
    if (s.disposed) return;
    next();
    const mediaTime=ui.source.currentTime;
    if(mediaTime===s.lastMedia || !ui.source.videoWidth) return;
    s.lastMedia=mediaTime;s.lastVideo=now;
    if(s.pending || now+3<s.nextCapture) return;
    s.nextCapture=Math.max(s.nextCapture+1000/s.config.fps,now);s.pending=true;
    try {
      const scale=Math.min(s.config.width/ui.source.videoWidth,s.config.height/ui.source.videoHeight);
      const w=ui.source.videoWidth*scale,h=ui.source.videoHeight*scale;
      s.ctx.fillStyle='#303438';s.ctx.fillRect(0,0,s.config.width,s.config.height);
      s.ctx.drawImage(ui.source,(s.config.width-w)/2,(s.config.height-h)/2,w,h);
      createImageBitmap(s.scratch).then(image=>{
        if(s.disposed || session!==s || phase!=='live'){image.close();return;}
        s.buffer.push(image,now);s.sampleFrames++;s.lastImage=performance.now();
      }).catch(error=>{if(!s.disposed)fail(error);}).finally(()=>{s.pending=false;});
    } catch(error){s.pending=false;fail(error);}
  };
  next();
}
function renderLoop(s) {
  if (s.disposed) return;
  s.renderRaf=requestAnimationFrame(()=>renderLoop(s));
  const now=performance.now();s.buffer.prune(now);
  const frame=mode==='delay'?s.buffer.atOrBefore(now-seconds()*1000):s.buffer.frames.at(-1);
  if(frame){
    if(now-frame.time>(mode==='delay'?seconds()*1000:0)+1000){stop('映像の遅れが大きくなったため終了しました。画質を「低め」にして、もう一度はじめよう。',true);return;}
    paint(frame.image);s.shownTime=frame.time;overlay();
  }
  const span=s.buffer.frames.length>1?s.buffer.frames.at(-1).time-s.buffer.frames[0].time:0;
  const ready=mode==='delay'?!!frame:span>=seconds()*1000-150;
  if(ready && !s.ready){
    s.ready=true;badge(mode==='delay'?`${seconds()}秒あと`:'今の映像・直前を見返せます');
    if(!s.performanceWarned)message(mode==='delay'?'動いたあとに、画面を見よう。':`準備できたよ。動いたあとに「直前${seconds()}秒を見る」を押そう。`);
    renderControls();
  }
  ui['screen-note'].textContent=mode==='delay'?(frame?`${seconds()}秒あとに表示中`:'遅延表示の準備中'):(s.ready?'今の映像を表示中':`今の映像・準備中（あと約${Math.max(1,Math.ceil(seconds()-span/1000))}秒）`);
}
function updateMetrics(s) {
  const now=performance.now();
  if(now-s.sampleTime>=4000){
    s.fps=s.sampleFrames*1000/(now-s.sampleTime);s.sampleFrames=0;s.sampleTime=now;
    if(s.fps<s.config.fps*0.65 && !s.performanceWarned){s.performanceWarned=true;message('映像のコマ数が少なくなっています。画質を「低め」にして、もう一度はじめよう。',true);}
  }
  ui.metrics.textContent=`${s.config.width}×${s.config.height} / 取得 ${s.fps?s.fps.toFixed(1):'計測中'} コマ/秒 / 画像の経過 ${s.shownTime?((now-s.shownTime)/1000).toFixed(2)+'秒（処理内）':'準備中'} / ${s.buffer.frames.length}枚 / ${(s.buffer.bytes/1024/1024).toFixed(1)} MiB（画像計算値）`;
}
function pauseLive() {
  generation++;disposeSession();phase='paused';badge('静止画・カメラ停止');
  ui['screen-note'].textContent='静止画・カメラ停止中';
  message('カメラを止めました。「再開する」で、もう一度はじめるよ。映像は60秒で消えるよ。');
  ui.metrics.textContent='カメラ停止中・静止画1枚だけ（最長60秒）';
  retainedTimer=setTimeout(()=>stop('一時停止から60秒たったので、映像を消しました。'),REVIEW_MS);
  renderControls();
}
function watchRecent() {
  const s=session;
  if(phase!=='live' || mode!=='slow' || !s?.ready)return;
  if(performance.now()-s.buffer.frames.at(-1).time>1000){stop('新しい映像が届いていません。カメラの接続を先生と確認してください。',true);return;}
  const sequence=s.buffer.takeRecent(seconds()*1000);
  if(sequence.duration<300){sequence.clear();fail({userMessage:'見返す映像が短すぎます。もう一度カメラをはじめてください。'});return;}
  generation++;disposeSession();clearReview();
  review={sequence,position:0,playing:true,lastNow:performance.now()};phase='review';
  badge('見返し・カメラ停止');ui['screen-note'].textContent='見返し中・カメラ停止中';overlay();
  message('同じ動きは「もう一度」。次の動きは「つぎへ」。映像は60秒で消えるよ。');
  ui.metrics.textContent=`カメラ停止中 / ${sequence.frames.length}枚 / ${(sequence.bytes/1024/1024).toFixed(1)} MiB（画像計算値） / ${(sequence.duration/1000).toFixed(1)}秒分`;
  retainedTimer=setTimeout(()=>stop('見返しから60秒たったので、映像を消しました。'),REVIEW_MS);
  drawReview();renderControls();reviewLoop();
}
function advanceReview(now) {
  if(!review)return;
  if(review.playing)review.position=Math.min(review.sequence.duration,review.position+Math.max(0,now-review.lastNow)*rate);
  review.lastNow=now;
  if(review.position>=review.sequence.duration)review.playing=false;
}
function drawReview() {
  if(!review)return;
  const frame=review.sequence.at(review.position);if(frame)paint(frame.image);
  ui.seek.value=String(review.position/review.sequence.duration*1000);
  ui['clip-time'].textContent=`${(review.position/1000).toFixed(1)} / ${(review.sequence.duration/1000).toFixed(1)}秒`;
}
function reviewLoop() {
  if(!review || phase!=='review')return;
  const playing=review.playing;advanceReview(performance.now());drawReview();
  if(playing!==review.playing)renderControls();
  reviewRaf=requestAnimationFrame(reviewLoop);
}
ui.start.addEventListener('click',()=>startCamera(selectedDevice));
ui.end.addEventListener('click',()=>stop());
ui.watch.addEventListener('click',watchRecent);
ui.again.addEventListener('click',()=>{if(review){review.position=0;review.playing=true;review.lastNow=performance.now();drawReview();renderControls();}});
ui.pause.addEventListener('click',()=>{
  if(phase==='live')pauseLive();
  else if(review){advanceReview(performance.now());if(review.position>=review.sequence.duration)review.position=0;review.playing=!review.playing;review.lastNow=performance.now();drawReview();renderControls();}
});
ui.seek.addEventListener('input',()=>{if(review){review.position=Number(ui.seek.value)/1000*review.sequence.duration;review.playing=false;review.lastNow=performance.now();drawReview();renderControls();}});
ui.switch.addEventListener('click',()=>{if(devices.length>1)startCamera(devices[(devices.findIndex(device=>device.deviceId===selectedDevice)+1)%devices.length].deviceId);});
for(const button of document.querySelectorAll('button[data-mode]'))button.addEventListener('click',()=>{
  if(button.dataset.mode===mode)return;
  mode=button.dataset.mode;stop('見る方法を変えたよ。「はじめる」を押そう。');
});
ui.speed.addEventListener('change',()=>{advanceReview(performance.now());rate=Number(ui.speed.value);drawReview();renderControls();});
for(const control of [ui.seconds,ui.quality])control.addEventListener('change',()=>{
  if(phase==='live')startCamera(selectedDevice);
  else stop('設定を変えたよ。「はじめる」を押そう。');
});
ui.mirror.addEventListener('change',()=>{
  if(review)drawReview();
  else if(phase==='paused'){
    const copy=document.createElement('canvas');copy.width=ui.display.width;copy.height=ui.display.height;
    copy.getContext('2d').drawImage(ui.display,0,0);
    ctx.save();ctx.translate(ui.display.width,0);ctx.scale(-1,1);ctx.drawImage(copy,0,0);ctx.restore();
    copy.width=copy.height=1;badge('静止画・カメラ停止');
  }else if(phase==='live')badge(mode==='delay'?`${seconds()}秒あと`:'今の映像');
});
function expanded(){return document.fullscreenElement===ui.viewer || ui.viewer.classList.contains('expanded');}
function syncExpanded(){
  const active=expanded();ui.fullscreen.textContent=active?'もとの大きさ':'映像を大きく';
  ui.fullscreen.setAttribute('aria-pressed',String(active));
  document.body.classList.toggle('view-expanded',active);
  document.querySelector('header').inert=active;
  for(const element of ui.app.children)if(element!==ui.viewer)element.inert=active;
}
ui.fullscreen.addEventListener('click',async()=>{
  if(document.fullscreenElement===ui.viewer){await document.exitFullscreen();}
  else if(ui.viewer.classList.contains('expanded'))ui.viewer.classList.remove('expanded');
  else{
    try{if(!ui.viewer.requestFullscreen)throw new Error('unavailable');await ui.viewer.requestFullscreen();}
    catch{ui.viewer.classList.add('expanded');}
  }
  syncExpanded();
});
document.addEventListener('fullscreenchange',syncExpanded);
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && ui.viewer.classList.contains('expanded')){ui.viewer.classList.remove('expanded');syncExpanded();ui.fullscreen.focus();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden && phase!=='idle')stop('タブを離れたので、カメラを止めて映像を消しました。');});
window.addEventListener('pagehide',()=>stop());document.addEventListener('freeze',()=>stop());
document.querySelector('header a').addEventListener('click',()=>{$('guide').open=true;});
blank();renderControls();
