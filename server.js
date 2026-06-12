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
      id:p.id, name:p.name, seat:i, connected:p.ws && p.ws.readyState===WebSocket.OPEN,
      handCount:p.hand.length,
      hand: p.id===viewerId || room.phase==='finished' ? p.hand : null,
      scorePileCount:p.scorePile.length,
      pairsCount:p.pairs.length,
      out:p.out || false,
      final:p.final || null,
    })),
    log: room.log,
  };
}
function send(ws, type, payload){ if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type, ...payload})); }
function broadcast(room){ for(const p of room.players) if(p.ws) send(p.ws,'state',{state: publicState(room,p.id)}); }
function roomByWs(ws){ return rooms.get(ws.roomCode); }
function createRoom(ws, name){
  const c = code();
  const id = uid();
  const room = {code:c, hostId:id, players:[], phase:'lobby', round:1, lead:0, current:0, leadSuit:null, trick:[], stock:[], log:[], message:'4人そろったら開始できます。', pendingPick:null};
  const player = {id, name: cleanName(name), ws, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player); rooms.set(c, room); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が部屋を作りました。`); send(ws,'created',{code:c, playerId:id}); broadcast(room);
}
function cleanName(n){ return String(n || '').trim().slice(0,12) || '子ブタ'; }
function joinRoom(ws, c, name){
  c = String(c||'').toUpperCase().trim(); const room = rooms.get(c);
  if(!room) return send(ws,'errorMsg',{message:'部屋が見つかりません。'});
  if(room.phase !== 'lobby') return send(ws,'errorMsg',{message:'この部屋はすでに開始済みです。'});
  if(room.players.length >= 4) return send(ws,'errorMsg',{message:'この部屋は満員です。'});
  const id = uid(); const player = {id, name:cleanName(name), ws, hand:[], scorePile:[], pairs:[], out:false};
  room.players.push(player); ws.roomCode=c; ws.playerId=id;
  log(room, `${player.name} が参加しました。`); send(ws,'joined',{code:c, playerId:id}); broadcast(room);
}
function startGame(room, requesterId){
  if(room.hostId !== requesterId) return;
  if(room.players.length !== 4) { room.message='4人そろうと開始できます。'; broadcast(room); return; }
  room.phase='playing'; room.round=1; room.lead=Math.floor(Math.random()*4); room.current=room.lead; room.trick=[]; room.leadSuit=null; room.pendingPick=null; room.stock=[];
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
  if(room.phase !== 'playing' || room.pendingPick || room.current !== pid) return new Set();
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
  wp.scorePile.push(...room.trick.map(x=>x.card));
  log(room, `👑 ${wp.name} が勝利。場の4枚をごちそう山へ。`);
  log(room, `💀 最弱は ${lp.name}（${cardText(weakest.card)}）。`);
  if(lp.hand.length>0){
    const readyAt = Date.now() + 1800;
    room.pendingPick = {winnerPid:winner.pid, weakestPid:weakest.pid, readyAt, result:null};
    room.message = `🐽 ババ抜きピック！ ${wp.name} が ${lp.name} の袋から1枚選びます。`;
    setTimeout(()=>broadcast(room), 1850);
  } else finishAfterPick(room, winner.pid);
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
  log(room, `🐽 ${resultText}`);
  room.message = resultText;
  broadcast(room);
  setTimeout(()=>{ if(room.pendingPick===pp) finishAfterPick(room, pp.winnerPid); }, 2600);
}
function finishAfterPick(room, winnerPid){
  room.pendingPick=null;
  if(checkRoundEnd(room)) { broadcast(room); return; }
  room.trick=[]; room.leadSuit=null; room.lead=winnerPid; room.current=winnerPid;
  room.message = `${room.players[winnerPid].name} が次のリードです。`;
  broadcast(room);
}
function checkRoundEnd(room){
  const outPid = room.players.findIndex(p=>p.hand.length===0);
  if(outPid<0) return false;
  const out = room.players[outPid];
  if(room.round===1){
    room.round=2; room.trick=[]; room.leadSuit=null; room.lead=outPid; room.current=outPid;
    // 13枚まで補充。足りない場合は新しい通常山札を追加する簡易処理。
    let refill = makeDeck().filter(c=>!c.joker); shuffle(refill);
    for(const p of room.players){ while(p.hand.length<13){ p.hand.push((room.stock.length?room.stock:refill).pop()); } sortHand(p.hand); }
    room.message=`${out.name} が上がり！第2ラウンドへ。残り手札を持ち越して13枚まで補充しました。`;
    log(room, room.message);
  } else {
    room.phase='finished'; room.message=`${out.name} が上がり！ゲーム終了。`; log(room, room.message); score(room);
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
