'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let filePath = req.url.split('?')[0];
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const safe = path.normalize(filePath).replace(/^([.][.][/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, safe);
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(abs).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}); res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

const suits = ['♠','♥','♦','♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const value = Object.fromEntries(ranks.map((r,i)=>[r,i+2]));

function code(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return rooms.has(s) ? code() : s;
}
function uid(){ return crypto.randomBytes(8).toString('hex'); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function makeDeck(){
  let deck=[]; let id=0;
  for(const s of suits) for(const r of ranks) deck.push({id:`${s}${r}-${id++}`,suit:s,rank:r,val:value[r],joker:false});
  deck.push({id:`JOKER-${id++}`,suit:null,rank:'JOKER',val:0,joker:true});
  return deck;
}
function cardText(c){ return c.joker ? '🃏ババブタ' : `${c.rank}${c.suit}`; }
function sortHand(h){
  h.sort((a,b)=>{
    if(a.joker) return 1; if(b.joker) return -1;
    const so = suits.indexOf(a.suit)-suits.indexOf(b.suit);
    if(so) return so;
    return b.val-a.val;
  });
}
function log(room, text){ room.log.unshift({time:new Date().toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'}), text}); room.log = room.log.slice(0,80); }
function say(room, pid, text){
  const p = room.players[pid]; if(!p) return;
  const item = {pid, name:p.name, text, expiresAt: Date.now()+8500};
  p.lastComment = item;
  room.commentary = room.commentary || [];
  room.commentary.unshift(item);
  room.commentary = room.commentary.slice(0,8);
  log(room, `💬 ${p.name}「${text}」`);
}
function sample(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function cpuPlayLine(room, pid, card){
  const p = room.players[pid];
  const hand = p.hand;
  const leadSuit = room.leadSuit;
  const jokerInHand = hand.some(c=>c.joker);
  if(!leadSuit){
    if(hand.length <= 3) return sample(['ここで上がりに近づくブヒ！','ごちそう山、いただきに行くブヒ！','ラストスパート、強めにいくブヒ！']);
    if(card.val >= 12) return sample(['最初から圧をかけるブヒ！','高めで様子を見るブヒ。','これで主導権を取りたいブヒ！']);
    return sample(['まずは様子見でいくブヒ。','小さく入って様子を見るブヒ。','ここは安全運転ブヒ。']);
  }
  const hasLeadBefore = [...hand, card].some(c=>!c.joker && c.suit===leadSuit);
  if(card.suit !== leadSuit){
    if(jokerInHand) return sample(['スートがない！ババブタを隠して逃げるブヒ…','ここは別スートでかわすブヒ。ババブタだけは出せない！','よし、フォロー不能。いらないカードで逃げるブヒ。']);
    return sample(['そのスート持ってないブヒ！','自由に出せるならこれでいくブヒ。','うわっ、きついな〜。別スートで逃げるブヒ。']);
  }
  const currentHigh = room.trick.filter(x=>x.card.suit===leadSuit).reduce((m,x)=>Math.max(m,x.card.val),0);
  if(card.val > currentHigh && card.val >= 10) return sample(['まさか、ここで勝ちに行くブヒ！','ここでそれを出すブヒ！ごちそう狙い！','勝てるなら勝つしかないブヒ！']);
  if(card.val <= 5) return sample(['低めで耐えるブヒ…','うわっ、弱いのしかないブヒ。','これで最弱にならないといいブヒ…']);
  return sample(['マストフォロー、了解ブヒ。','このカードでついていくブヒ。','まだ勝負は分からないブヒ。']);
}
function cpuPickLine(room, winnerPid, weakestPid){
  const wp=room.players[winnerPid], lp=room.players[weakestPid];
  if(wp.cpu) return sample([`さて、${lp.name}の袋をのぞくブヒ…`,`そこにババブタいないでほしいブヒ…`,`勝ったのに怖い時間ブヒ。どれにするブヒ？`]);
  const cpu = room.players.find((p,i)=>p.cpu && i!==winnerPid);
  if(cpu){ const idx = room.players.indexOf(cpu); say(room, idx, sample(['このピック、空気が重いブヒ…','そこ引くの！？いや、まだ分からないブヒ！','ババブタの気配がするブヒ…'])); }
  return null;
}
function resultLine(drawn, paired){
  if(drawn.joker) return sample(['うわー！ババブタ来たブヒ！！','最悪の1枚を引いたブヒ…！','これはきついブヒ、完全に事故ブヒ！']);
  if(paired) return sample(['おそろいペア！これはうまいブヒ！','ナイス浄化ブヒ！手札が軽くなった！','そのペアは気持ちいいブヒ〜！']);
  if(drawn.val >= 11) return sample(['強いカードを拾ったブヒ。これは得かも？','高いカード、あとで効きそうブヒ。']);
  return sample(['まあまあの1枚ブヒ。','とりあえず手札に入れておくブヒ。','微妙だけどババブタじゃないだけセーフブヒ。']);
}
function publicState(room, viewerId){
  const viewerIndex = room.players.findIndex(p=>p.id===viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    you: viewerId,
    yourIndex: viewerIndex,
    phase: room.phase,
    round: room.round,
    lead: room.lead,
    current: room.current,
    leadSuit: room.leadSuit,
    message: room.message,
    removedCard: room.removedCard ? (room.phase==='finished' ? room.removedCard : null) : null,
    trick: room.trick,
    pendingPick: room.pendingPick ? {
      winnerPid: room.pendingPick.winnerPid,
      weakestPid: room.pendingPick.weakestPid,
      readyAt: room.pendingPick.readyAt,
      result: room.pendingPick.result || null
    } : null,
    players: room.players.map((p,i)=>({
      id:p.id, name:p.name, seat:i, cpu: !!p.cpu, connected: p.cpu || (p.ws && p.ws.readyState===WebSocket.OPEN),
      handCount:p.hand.length,
      hand: p.id===viewerId || room.phase==='finished' ? p.hand : null,
      scorePileCount:p.scorePile.length,
      pairsCount:p.pairs.length,
      out:p.out || false,
      final:p.final || null,
      lastComment: p.lastComment && p.lastComment.expiresAt > Date.now() ? p.lastComment.text : null,
    })),
    commentary: (room.commentary || []).filter(x=>x.expiresAt > Date.now()).slice(0,4),
    lastTrick: room.lastTrick && room.lastTrick.expiresAt > Date.now() ? room.lastTrick : null,
    trickReview: room.trickReview && room.trickReview.until > Date.now() ? room.trickReview : null,
    log: room.log,
  };
}
function send(ws, type, payload){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type, ...payload})); }
function broadcast(room){
  for(const p of room.players) if(p.ws) send(p.ws,'state',{state: publicState(room,p.id)});
  scheduleCpu(room);
  ensureRoomProgress(room);
}
function roomByWs(ws){ return rooms.get(ws.roomCode); }
function createRoom(ws, name){
  const c = code();
  const id = uid();
  const room = {code:c, hostId:id, players:[], phase:'lobby', round:1, lead:0, current:0, leadSuit:null, trick:[], stock:[], log:[], message:'4人そろったら開始できます。人が足りない場合はCPUを追加できます。', pendingPick:null, commentary:[], lastTrick:null};
  const player = {id, name: cleanName(name), ws, cpu:false, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player); rooms.set(c, room); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が部屋を作りました。`); send(ws,'created',{code:c, playerId:id}); broadcast(room);
}
function cleanName(n){ return String(n || '').trim().slice(0,12) || '子ブタ'; }
function joinRoom(ws, c, name){
  c = String(c||'').toUpperCase().trim(); const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'部屋が見つかりません。'});
  if(room.phase !== 'lobby') return send(ws,'errorMsg',{message:'この部屋はすでに開始済みです。'});
  if(room.players.length >= 4) return send(ws,'errorMsg',{message:'この部屋は満員です。'});
  const id = uid(); const player = {id, name:cleanName(name), ws, cpu:false, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が参加しました。`); send(ws,'joined',{code:c, playerId:id}); broadcast(room);
}

function addCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  if(room.players.length >= 4) { room.message='この部屋は満員です。'; broadcast(room); return; }
  const cpuNames = ['CPUブタA','CPUブタB','CPUブタC','CPUブタD'];
  const used = new Set(room.players.map(p=>p.name));
  const name = cpuNames.find(n=>!used.has(n)) || `CPUブタ${room.players.length}`;
  const player = {id:`CPU-${uid()}`, name, ws:null, cpu:true, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player);
  log(room, `${player.name} を追加しました。`);
  room.message='CPUを追加しました。4人そろったら開始できます。';
  broadcast(room);
}
function removeCpu(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.phase !== 'lobby') return;
  const i = room.players.map(p=>p.cpu).lastIndexOf(true);
  if(i<0) { room.message='削除できるCPUがいません。'; broadcast(room); return; }
  const [p] = room.players.splice(i,1);
  log(room, `${p.name} を外しました。`);
  room.message='CPUを外しました。';
  broadcast(room);
}


function clearPickFinishTimer(room){
  if(room.pickFinishTimer){
    clearTimeout(room.pickFinishTimer);
    room.pickFinishTimer = null;
  }
  if(room.pickFinishFailSafeTimer){
    clearTimeout(room.pickFinishFailSafeTimer);
    room.pickFinishFailSafeTimer = null;
  }
}
function clearReviewTimer(room){
  if(room.reviewTimer){
    clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
  }
  if(room.reviewFailSafeTimer){
    clearTimeout(room.reviewFailSafeTimer);
    room.reviewFailSafeTimer = null;
  }
}
function clearAllProgressTimers(room){
  clearReviewTimer(room);
  clearPickFinishTimer(room);
  if(room.cpuTimer){ clearTimeout(room.cpuTimer); room.cpuTimer=null; }
  if(room.cpuPickTimer){ clearTimeout(room.cpuPickTimer); room.cpuPickTimer=null; }
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
}
function ensurePickFinish(room, pp, winnerPid, delay=2600){
  clearPickFinishTimer(room);
  const token = pp && pp.token ? pp.token : `${Date.now()}-${Math.random()}`;
  if(pp) pp.token = token;

  room.pickFinishTimer = setTimeout(()=>{
    room.pickFinishTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    finishAfterPick(room, winnerPid);
  }, delay);

  // 結果表示後に何らかのタイマー不発・状態ズレがあっても止まらないための保険。
  room.pickFinishFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.token !== token) return;
    log(room, '⚠️ ピック結果後の進行が遅延したため、自動復旧しました。');
    finishAfterPick(room, winnerPid);
  }, delay + 4500);
}
function ensureReviewToPick(room, reviewToken, winnerPid, weakestPid){
  clearReviewTimer(room);
  room.reviewTimer = setTimeout(()=>{
    room.reviewTimer = null;
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, 5000);

  // レビュー画面で止まる事故を防ぐ保険。
  room.reviewFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.trickReview || room.trickReview.until !== reviewToken) return;
    log(room, '⚠️ トリック結果確認からの進行が遅延したため、自動復旧しました。');
    advanceReviewToPick(room, reviewToken, winnerPid, weakestPid);
  }, 8000);
}
function advanceReviewToPick(room, reviewToken, winnerPid, weakestPid){
  if(room.phase !== 'playing') return;
  if(!room.trickReview || room.trickReview.until !== reviewToken) return;
  clearReviewTimer(room);
  room.trickReview = null;

  const wp = room.players[winnerPid];
  const lp = room.players[weakestPid];
  if(!wp || !lp) return;

  if(lp.hand.length>0){
    const readyAt = Date.now() + 1800;
    room.pendingPick = {
      winnerPid,
      weakestPid,
      readyAt,
      result:null,
      token:`pick-${Date.now()}-${Math.random()}`
    };
    room.message = `🐽 ババ抜きピック！ ${wp.name} が ${lp.name} の袋から1枚選びます。`;
    const line = cpuPickLine(room, winnerPid, weakestPid); if(line) say(room, winnerPid, line);
    ensureCpuPick(room);
    broadcast(room);
    setTimeout(()=>broadcast(room), 1850);
  } else {
    finishAfterPick(room, winnerPid);
  }
}
function ensureRoomProgress(room){
  if(!room || room.phase !== 'playing') return;

  // 通常進行中なのにcurrentがnullで、レビュー・ピック待ちでもない場合はリードへ復旧。
  if(room.current == null && !room.pendingPick && !room.trickReview){
    if(room.trick && room.trick.length>0 && room.trick.length<4){
      const lastPid = room.trick[room.trick.length-1].pid;
      room.current = (lastPid + 1) % room.players.length;
      log(room, '⚠️ 手番表示が停止したため、次プレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
    if(!room.trick || room.trick.length===0){
      room.current = room.lead ?? 0;
      log(room, '⚠️ 手番が未設定だったため、リードプレイヤーへ自動復旧しました。');
      broadcast(room);
      return;
    }
  }

  // ピック結果が出ているのにpendingPickが残り続けている場合は進める。
  if(room.pendingPick && room.pendingPick.result){
    const age = Date.now() - (room.pendingPick.resultAt || Date.now());
    if(age > 3800){
      log(room, '⚠️ ピック結果表示後に停止を検知したため、自動復旧しました。');
      finishAfterPick(room, room.pendingPick.winnerPid);
      return;
    }
  }

  // CPUピック待ちで止まっている場合は再予約。
  if(room.pendingPick && !room.pendingPick.result && room.players[room.pendingPick.winnerPid]?.cpu){
    ensureCpuPick(room);
    return;
  }

  // レビュー画面で止まっている場合は再予約。
  if(room.trickReview && room.trickReview.until <= Date.now()){
    advanceReviewToPick(room, room.trickReview.until, room.trickReview.winnerPid, room.trickReview.weakestPid);
  }
}

function clearCpuPickTimer(room){
  if(room.cpuPickTimer){
    clearTimeout(room.cpuPickTimer);
    room.cpuPickTimer = null;
  }
}
function ensureCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result) return;
  const winner = room.players[pp.winnerPid];
  const weakest = room.players[pp.weakestPid];
  if(!winner || !winner.cpu || !weakest || weakest.hand.length<=0) return;
  if(room.cpuPickTimer) return;

  // CPUがピック担当になったら、broadcast依存ではなく専用タイマーで必ず進行させる。
  const delay = Math.max(500, pp.readyAt - Date.now() + 450);
  const token = pp.readyAt;
  room.cpuPickTimer = setTimeout(()=>{
    room.cpuPickTimer = null;
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    if(room.pendingPick.readyAt !== token) return;
    const currentWinner = room.players[room.pendingPick.winnerPid];
    const currentWeakest = room.players[room.pendingPick.weakestPid];
    if(!currentWinner || !currentWinner.cpu || !currentWeakest || currentWeakest.hand.length<=0) return;
    doPick(room, currentWinner.id, Math.floor(Math.random() * currentWeakest.hand.length));
  }, delay);

  // 念のためのフェイルセーフ。何らかの理由で上のタイマーが外れても、数秒後に自動復旧。
  if(room.cpuPickFailSafeTimer) clearTimeout(room.cpuPickFailSafeTimer);
  room.cpuPickFailSafeTimer = setTimeout(()=>{
    if(room.phase !== 'playing') return;
    if(!room.pendingPick || room.pendingPick.result) return;
    const currentWinner = room.players[room.pendingPick.winnerPid];
    const currentWeakest = room.players[room.pendingPick.weakestPid];
    if(!currentWinner || !currentWinner.cpu || !currentWeakest || currentWeakest.hand.length<=0) return;
    log(room, '⚠️ CPUピックが遅延したため、自動復旧しました。');
    doPick(room, currentWinner.id, Math.floor(Math.random() * currentWeakest.hand.length));
  }, Math.max(3500, delay + 3500));
}

function isCpuTurn(room){ return room.phase==='playing' && room.current!=null && room.players[room.current]?.cpu && !room.pendingPick; }
function chooseCpuCard(room, pid){
  const allowed = [...playableIds(room, pid)];
  const hand = room.players[pid].hand;
  const cards = allowed.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
  if(!cards.length) return null;
  cards.sort((a,b)=>a.val-b.val || suits.indexOf(a.suit)-suits.indexOf(b.suit));
  if(!room.leadSuit){
    if(hand.filter(c=>!c.joker).length <= 3) return cards[cards.length-1];
    return cards[0];
  }
  const leadPlays = room.trick.filter(x=>x.card.suit===room.leadSuit);
  const high = leadPlays.reduce((m,x)=>Math.max(m,x.card.val),0);
  const follow = cards.filter(c=>c.suit===room.leadSuit);
  if(follow.length){
    const winners = follow.filter(c=>c.val > high).sort((a,b)=>a.val-b.val);
    // 手札が少ない時や安く勝てる時は取りにいく。そうでなければ低く逃げる。
    if(winners.length && (hand.length <= 5 || winners[0].val <= high+2 || Math.random()<0.35)) return winners[0];
    return follow.sort((a,b)=>a.val-b.val)[0];
  }
  // フォロー不能なら、低い通常カードを捨てる。ババブタは出せない。
  return cards[0];
}
function scheduleCpu(room){
  if(room.cpuTimer) return;
  if(room.phase !== 'playing') return;
  if(room.trickReview && room.trickReview.until > Date.now()) return;
  const pp = room.pendingPick;
  if(pp && room.players[pp.winnerPid]?.cpu && !pp.result){
    ensureCpuPick(room);
    return;
  }
  if(isCpuTurn(room)){
    room.cpuTimer = setTimeout(()=>{ room.cpuTimer=null; doCpuPlay(room); }, 900);
  }
}
function doCpuPlay(room){
  if(!isCpuTurn(room)) return;
  const pid = room.current;
  const card = chooseCpuCard(room, pid);
  if(card){ say(room, pid, cpuPlayLine(room, pid, card)); playCard(room, room.players[pid].id, card.id); }
}
function doCpuPick(room){
  const pp = room.pendingPick;
  if(!pp || pp.result || !room.players[pp.winnerPid]?.cpu) return;
  const weakest = room.players[pp.weakestPid];
  if(!weakest || weakest.hand.length<=0) return;
  doPick(room, room.players[pp.winnerPid].id, Math.floor(Math.random() * weakest.hand.length));
}

function startGame(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.players.length !== 4) { room.message='4人そろうと開始できます。足りない席はCPUを追加してください。'; broadcast(room); return; }
  clearAllProgressTimers(room);
  room.phase='playing'; room.round=1; room.lead=Math.floor(Math.random()*4); room.current=room.lead; room.trick=[]; room.leadSuit=null; room.pendingPick=null; room.trickReview=null; room.stock=[];
  for(const p of room.players){ p.hand=[]; p.scorePile=[]; p.pairs=[]; p.out=false; p.final=null; }
  dealInitial(room);
  room.message=`第1ラウンド開始。${room.players[room.current].name} からリード。`;
  log(room, 'ぶひぶひ収穫祭スタート！通常カードを1枚抜き、全員13枚で開始します。');
  broadcast(room);
}
function dealInitial(room){
  let deck = makeDeck();
  const normals = deck.map((c,i)=>c.joker?-1:i).filter(i=>i>=0);
  const idx = normals[Math.floor(Math.random()*normals.length)];
  room.removedCard = deck.splice(idx,1)[0];
  shuffle(deck);
  for(let i=0;i<13;i++) for(let p=0;p<4;p++) room.players[p].hand.push(deck.pop());
  room.stock = deck;
  room.players.forEach(p=>sortHand(p.hand));
  log(room, `均一配札のため ${cardText(room.removedCard)} を箱に戻しました。`);
}
function playableIds(room, pid){
  const p = room.players[pid]; if(!p) return new Set();
  if(room.phase !== 'playing' || room.pendingPick || room.trickReview || room.current !== pid) return new Set();
  const nonJoker = p.hand.filter(c=>!c.joker);
  if(!room.leadSuit) return new Set(nonJoker.map(c=>c.id));
  const follow = p.hand.filter(c=>!c.joker && c.suit===room.leadSuit);
  return new Set((follow.length ? follow : nonJoker).map(c=>c.id));
}
function playCard(room, playerId, cardId){
  const pid = room.players.findIndex(p=>p.id===playerId);
  const allowed = playableIds(room, pid);
  if(!allowed.has(cardId)) { room.message='そのカードは出せません。マストフォロー、またはババブタ不可を確認！'; broadcast(room); return; }
  const p = room.players[pid]; const idx = p.hand.findIndex(c=>c.id===cardId); const card = p.hand.splice(idx,1)[0];
  if(!room.leadSuit) room.leadSuit = card.suit;
  room.trick.push({pid, card, order:room.trick.length});
  room.message = `${p.name} が ${cardText(card)} を出しました。`;
  log(room, room.message);
  if(room.trick.length===4) resolveTrick(room); else room.current=(pid+1)%4;
  broadcast(room);
}
function resolveTrick(room){
  const leadSuit = room.leadSuit;
  const winner = room.trick.filter(x=>x.card.suit===leadSuit).sort((a,b)=>b.card.val-a.card.val)[0];
  let weakest = room.trick[0];
  for(const x of room.trick){ if(x.card.val < weakest.card.val) weakest=x; else if(x.card.val===weakest.card.val && x.order > weakest.order) weakest=x; }
  const wp = room.players[winner.pid], lp = room.players[weakest.pid];

  // トリックの最終盤面を見せるため、ここではまだピック画面に遷移しない。
  const reviewUntil = Date.now() + 5000;
  room.current = null;
  room.trickReview = {winnerPid:winner.pid, weakestPid:weakest.pid, until:reviewUntil};
  room.lastTrick = {
    winnerPid:winner.pid,
    weakestPid:weakest.pid,
    winnerName:wp.name,
    weakestName:lp.name,
    winnerCard:cardText(winner.card),
    weakestCard:cardText(weakest.card),
    expiresAt:reviewUntil + 5000
  };

  if(wp.cpu) say(room, winner.pid, sample(['よし、ごちそう山ゲットだブヒ！','勝ったけど、このあとが怖いブヒ…','取った！でもピックが本番ブヒ。']));
  if(lp.cpu && lp.hand.length>0) say(room, weakest.pid, sample(['えっ、最弱！？やめてブヒ〜！','うわっ、きついな〜。袋を見ないでブヒ！','最弱になったブヒ…嫌な予感しかしないブヒ。']));
  wp.scorePile.push(...room.trick.map(x=>x.card));
  log(room, `👑 ${wp.name} が勝利。場の4枚をごちそう山へ。`);
  log(room, `💀 最弱は ${lp.name}（${cardText(weakest.card)}）。`);
  room.message = `トリック終了！ 👑勝者は ${wp.name}、💀最弱は ${lp.name}。5秒後にババ抜きピックへ進みます。`;

  const reviewToken = reviewUntil;
  ensureReviewToPick(room, reviewToken, winner.pid, weakest.pid);
}
function doPick(room, playerId, targetIndex){
  const pp = room.pendingPick; if(!pp || pp.result) return;
  const chooserPid = room.players.findIndex(p=>p.id===playerId);
  if(chooserPid !== pp.winnerPid) return;
  if(Date.now() < pp.readyAt) return;
  const wp = room.players[pp.winnerPid], lp = room.players[pp.weakestPid];
  if(targetIndex < 0 || targetIndex >= lp.hand.length) targetIndex = Math.floor(Math.random()*lp.hand.length);
  const drawn = lp.hand.splice(targetIndex,1)[0];
  let paired = null;
  if(!drawn.joker){
    const pi = wp.hand.findIndex(c=>!c.joker && c.rank===drawn.rank);
    if(pi>=0){ paired = [drawn, wp.hand.splice(pi,1)[0]]; wp.pairs.push(...paired); }
  }
  if(!paired) wp.hand.push(drawn);
  sortHand(wp.hand); sortHand(lp.hand);
  const resultText = drawn.joker ? `${wp.name} はババブタを引いた！` : paired ? `${wp.name} は ${drawn.rank} のおそろいペアを浄化！` : `${wp.name} は ${cardText(drawn)} を手札に加えた。`;
  pp.result = {drawn, paired: !!paired, text: resultText};
  pp.resultAt = Date.now();
  clearCpuPickTimer(room);
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  log(room, `🐽 ${resultText}`);
  if(wp.cpu) say(room, pp.winnerPid, resultLine(drawn, !!paired));
  else { const cpu = room.players.find((p,i)=>p.cpu && i!==pp.winnerPid); if(cpu){ const ci=room.players.indexOf(cpu); say(room, ci, resultLine(drawn, !!paired)); } }
  room.message = resultText;
  broadcast(room);
  ensurePickFinish(room, pp, pp.winnerPid, 2600);
}
function finishAfterPick(room, winnerPid){
  clearPickFinishTimer(room);
  clearCpuPickTimer(room);
  if(room.cpuPickFailSafeTimer){ clearTimeout(room.cpuPickFailSafeTimer); room.cpuPickFailSafeTimer=null; }
  if(!room.pendingPick && !room.trick.length) return;
  room.pendingPick=null;
  if(checkRoundEnd(room)) { broadcast(room); return; }
  room.trick=[]; room.leadSuit=null; room.lead=winnerPid; room.current=winnerPid;
  room.message = `${room.players[winnerPid].name} が次のリードです。`;
  broadcast(room);
}
function checkRoundEnd(room){
  const outPid = room.players.findIndex(p=>p.hand.length===0 || (p.hand.length===1 && p.hand[0].joker));
  if(outPid<0) return false;
  const out = room.players[outPid];
  const onlyJoker = out.hand.length===1 && out.hand[0].joker;
  if(room.round===1){
    room.round=2; room.trick=[]; room.leadSuit=null; room.lead=outPid; room.current=outPid;
    // 13枚まで補充。足りない場合は新しい通常山札を追加する簡易処理。
    let refill = makeDeck().filter(c=>!c.joker); shuffle(refill);
    for(const p of room.players){ while(p.hand.length<13){ p.hand.push((room.stock.length?room.stock:refill).pop()); } sortHand(p.hand); }
    room.message = onlyJoker
      ? `${out.name} の袋にババブタ1枚だけが残りました！第1ラウンド終了。残り手札を持ち越して13枚まで補充します。`
      : `${out.name} が上がり！第2ラウンドへ。残り手札を持ち越して13枚まで補充しました。`;
    if(out.cpu) say(room, outPid, sample(['上がりブヒ！後半もこの調子でいくブヒ！','まずは抜けたブヒ！でも後半があるブヒ。']));
    log(room, room.message);
  } else {
    room.phase='finished';
    room.message = onlyJoker
      ? `${out.name} の袋にババブタ1枚だけが残りました！ゲーム終了。`
      : `${out.name} が上がり！ゲーム終了。`;
    if(out.cpu) say(room, outPid, onlyJoker ? sample(['ババブタだけ残ったブヒ…終わったブヒ…','袋の中がババブタだけブヒ！？']) : sample(['上がり！ごちそう山を数えるブヒ！','決着ブヒ！点数計算だブヒ！']));
    log(room, room.message); score(room);
  }
  return true;
}
function score(room){
  for(const p of room.players){
    const pile = p.scorePile.length;
    const normalHand = p.hand.filter(c=>!c.joker).length;
    const madPig = [...p.hand, ...p.scorePile].filter(c=>!c.joker && c.suit==='♠' && c.rank==='Q').length;
    const joker = p.hand.some(c=>c.joker) ? 1 : 0;
    const total = pile - normalHand*3 - madPig*13 - joker*20;
    p.final = {pile, normalHand, madPig, joker, total};
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg; try { msg=JSON.parse(raw); } catch(e){ return; }
    if(msg.type==='create') return createRoom(ws, msg.name);
    if(msg.type==='join') return joinRoom(ws, msg.code, msg.name);
    const room = roomByWs(ws); if(!room) return;
    if(msg.type==='start') startGame(room, ws.playerId);
    if(msg.type==='addCpu') addCpu(room, ws.playerId);
    if(msg.type==='removeCpu') removeCpu(room, ws.playerId);
    if(msg.type==='play') playCard(room, ws.playerId, msg.cardId);
    if(msg.type==='pick') doPick(room, ws.playerId, Number(msg.index));
  });
  ws.on('close', () => {
    const room = roomByWs(ws); if(!room) return;
    const p = room.players.find(x=>x.id===ws.playerId); if(p) { p.ws = null; log(room, `${p.name} が切断しました。`); broadcast(room); }
    if(room.players.every(p=>!p.ws || p.ws.readyState!==WebSocket.OPEN)) setTimeout(()=>{
      const r = rooms.get(room.code); if(r && r.players.every(p=>!p.ws || p.ws.readyState!==WebSocket.OPEN)) rooms.delete(room.code);
    }, 10*60*1000);
  });
});

server.listen(PORT, () => console.log(`ピピとりオンライン server listening on http://localhost:${PORT}`));
