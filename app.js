import { FrameBuffer } from './frame-buffer.mjs';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['app','source','display','empty','empty-text','view-state','status','start','pause','watch','again','switch','fullscreen','end','review-controls','seek','clip-time','quality','metrics','delay-seconds','clip-seconds','mirror','mode-hint','screen-note'].map(id => [id, $(id)]));
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
  ui['view-state'].textContent = text && ui.mirror.checked ? `${text}／鏡の向き` : text;
  ui['view-state'].hidden = !text;
}
function seconds() { return Number(mode === 'delay' ? ui['delay-seconds'].value : ui['clip-seconds'].value); }
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
  return mode === 'delay' ? `${seconds()}秒あとに自動で映ります。動いたあと、安全な場所で見よう。` : `動いたあとに「ゆっくり見る」。直前${seconds()}秒を見返せます。`;
}
function renderControls() {
  const live = phase === 'live', viewing = phase === 'review';
  ui.app.dataset.phase = phase; ui.app.dataset.mode = mode;
  ui['mode-hint'].textContent = modeDescription();
  ui.start.hidden = live;
  ui.start.disabled = phase === 'starting';
  ui.start.textContent = viewing ? 'つぎへ' : phase === 'paused' ? 'カメラを再開' : phase === 'starting' ? 'カメラの許可を確認中' : 'カメラをはじめる';
  ui.watch.hidden = !(live && mode === 'slow');
  ui.watch.disabled = !session?.ready;
  ui.again.hidden = !viewing;
  ui.pause.hidden = !((live && mode === 'delay') || viewing);
  ui.pause.disabled = live && !session?.ready;
  ui.pause.textContent = viewing ? (review.playing ? 'とめる' : review.position >= review.sequence.duration ? 'はじめから' : 'つづける') : 'とめる';
  ui.end.disabled = phase === 'idle';
  ui['review-controls'].hidden = !viewing;
  ui.switch.disabled = !live || devices.length < 2;
  ui.switch.title = devices.length < 2 ? 'カメラが2台以上あるときに使えます' : '次のカメラへ切り替えます。前の映像は消えます';
  for (const control of [ui.quality,ui['delay-seconds'],ui['clip-seconds'],ui.mirror]) control.disabled = phase !== 'idle';
  $('delay-setting').hidden = mode !== 'delay'; $('clip-setting').hidden = mode !== 'slow';
  document.querySelectorAll('button[data-mode]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.mode === mode)));
  document.querySelectorAll('[data-rate]').forEach(button => button.setAttribute('aria-pressed',String(Number(button.dataset.rate) === rate)));
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
function stop(text = 'おわりました。カメラを止めて、映像を消しました。', error = false) {
  generation++; disposeSession(); clearReview(); blank();
  phase = 'idle'; badge(); overlay('カメラをはじめよう');
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
    NotSupportedError:'必要な映像機能がありません。先生とChromeの対応状況を確認してください。',
  };
  stop(help[error?.name] || error?.userMessage || '映像の処理を続けられないため終了しました。ほかのタブを閉じ、先生の設定で「軽量」にして再開してください。',true);
}
async function startCamera(deviceId = '') {
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    stop('カメラにはHTTPSのページ（開発時はlocalhost）が必要です。先生にURLを確認してください。',true); return;
  }
  if (!window.createImageBitmap || !ctx) { fail({name:'NotSupportedError'}); return; }
  stop(); const ticket = generation, config = profiles[ui.quality.value];
  const scratch = document.createElement('canvas'); scratch.width = config.width; scratch.height = config.height;
  const s = {
    config, scratch, ctx:scratch.getContext('2d',{alpha:false}), stream:null, disposed:false,
    buffer:new FrameBuffer({maxFrames:Math.ceil(10.8*config.fps)+2,maxBytes:MAX_IMAGE_BYTES,maxAgeMs:10800}),
    pending:false, nextCapture:0, lastMedia:-1, lastVideo:performance.now(), sampleTime:performance.now(),
    sampleFrames:0, fps:0, shownTime:0, ready:false, performanceWarned:false,lastImage:performance.now(),
  };
  session = s; phase = 'starting';
  overlay('カメラの許可を待っています'); message('カメラの許可を確認してください。マイクは使いません。「おわる」で中断できます。');
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
    message(mode === 'delay' ? `${seconds()}秒ぶんの映像を準備しています。端末を固定して待ってください。` : '映像を準備しています。映る場所を確かめてください。');
    s.limitTimer = setTimeout(()=>{if(session===s) stop('15分たったので終了しました。端末の熱さを先生と確かめてから再開してください。');},SESSION_MS);
    s.watchdog = setInterval(()=>{
      if (session !== s) return;
      if (performance.now()-s.lastVideo > 5000) { stop('カメラの映像が止まりました。接続・端末の状態を先生と確認して再開してください。',true); return; }
      if (performance.now()-s.lastImage > 5000) { stop('映像の処理が進まないため終了しました。先生の設定で「軽量」にして再開してください。',true); return; }
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
    if(now-frame.time>(mode==='delay'?seconds()*1000:0)+1000){stop('映像の遅れが大きくなったため終了しました。先生の設定で「軽量」にして再開してください。',true);return;}
    paint(frame.image);s.shownTime=frame.time;overlay();
  }
  const span=s.buffer.frames.length>1?s.buffer.frames.at(-1).time-s.buffer.frames[0].time:0;
  const ready=mode==='delay'?!!frame:span>=seconds()*1000-150;
  if(ready && !s.ready){
    s.ready=true;badge(mode==='delay'?`${seconds()}秒あと`:'今の映像・直前を見返せます');
    if(!s.performanceWarned)message(mode==='delay'?'動いたあと、安全な場所で画面を見よう。':'動いたあと、安全な場所で「ゆっくり見る」を押そう。');
    renderControls();
  }
  ui['screen-note'].textContent=mode==='delay'?(frame?`${seconds()}秒あとに表示中`:'遅延表示の準備中'):(s.ready?'今の映像を表示中':`今の映像・準備中（あと約${Math.max(1,Math.ceil(seconds()-span/1000))}秒）`);
}
function updateMetrics(s) {
  const now=performance.now();
  if(now-s.sampleTime>=4000){
    s.fps=s.sampleFrames*1000/(now-s.sampleTime);s.sampleFrames=0;s.sampleTime=now;
    if(s.fps<s.config.fps*0.65 && !s.performanceWarned){s.performanceWarned=true;message('映像のコマ数が少なくなっています。「おわる」を押し、先生の設定で「軽量」にして再開してください。',true);}
  }
  ui.metrics.textContent=`${s.config.width}×${s.config.height} / 取得 ${s.fps?s.fps.toFixed(1):'計測中'} コマ/秒 / 画像の経過 ${s.shownTime?((now-s.shownTime)/1000).toFixed(2)+'秒（処理内）':'準備中'} / ${s.buffer.frames.length}枚 / ${(s.buffer.bytes/1024/1024).toFixed(1)} MiB（画像計算値）`;
}
function pauseLive() {
  generation++;disposeSession();phase='paused';badge('静止画・カメラ停止');
  ui['screen-note'].textContent='静止画・カメラ停止中';
  message('カメラを止めました。「カメラを再開」で、もう一度待ち時間が入ります。静止画は60秒で消えます。');
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
  message('同じ動きは「もう一度」。次に動くときは「つぎへ」。この映像は60秒で消えます。');
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
  mode=button.dataset.mode;stop('見る方法を切り替え、前の映像を消しました。先生と確かめてカメラをはじめてください。');
});
for(const button of document.querySelectorAll('[data-rate]'))button.addEventListener('click',()=>{advanceReview(performance.now());rate=Number(button.dataset.rate);drawReview();renderControls();});
for(const control of [ui['delay-seconds'],ui['clip-seconds'],ui.quality])control.addEventListener('change',renderControls);
ui.fullscreen.addEventListener('click',async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await ui.app.requestFullscreen();}
  catch{message('全画面を使えません。このまま使うか、先生と画面の設定を確認してください。',true);}
});
document.addEventListener('fullscreenchange',()=>{ui.fullscreen.textContent=document.fullscreenElement?'全画面をやめる':'全画面';});
document.addEventListener('visibilitychange',()=>{if(document.hidden && phase!=='idle')stop('タブを離れたので、カメラを止めて映像を消しました。');});
window.addEventListener('pagehide',()=>stop());document.addEventListener('freeze',()=>stop());
document.querySelector('header a').addEventListener('click',()=>{$('guide').open=true;});
blank();renderControls();
