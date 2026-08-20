const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

const suits = [['♠','black'],['♥','red'],['♦','red'],['♣','black']];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const value = r => r==='A' ? 14 : r==='K' ? 13 : r==='Q' ? 12 : r==='J' ? 11 : Number(r);
const makeDeck = () => {
  const d=[];
  for(const [s,c] of suits) for(const r of ranks) d.push({rank:r,suit:s,color:c,value:value(r)});
  d.push({rank:'JOKER',suit:'★',color:'joker',value:0,joker:true});
  return d;
};
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function newCode(){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do{c=Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('');}while(rooms.has(c)); return c; }
const rooms = new Map();
function getPlayer(room,id){return room.players.find(p=>p.id===id);}
function roomFor(socket){return rooms.get(socket.data.room);}
function hasRank(cards,r){return cards.some(c=>c.rank===r);}
function points(cards){return cards.reduce((n,c)=>n+(c.joker?0:c.value),0);}

// Rules: King beats everything except Ace. Ace beats King but loses to everything else.
// If both sides contain both K and A, the special cards cancel and normal totals decide.
function compareCards(a,b){
  const ak=hasRank(a,'K'), aa=hasRank(a,'A');
  const bk=hasRank(b,'K'), ba=hasRank(b,'A');
  // An Ace beats a King. A King beats everything else. An Ace loses to everything else.
  if(ak && ba && !(aa && bk)) return -1;
  if(bk && aa && !(ba && ak)) return 1;
  if(ak && !ba) return 1;
  if(bk && !aa) return -1;
  if(aa && !bk) return -1;
  if(ba && !ak) return 1;
  const x=points(a), y=points(b);
  return x>y?1:x<y?-1:0;
}
function makeRoom(code, socketId){
  return {code,phase:'waiting',players:[{id:socketId,number:1,hand:[],ready:false,connected:true}],
    platoons:[[[],[],[],[],[]],[[],[],[],[],[]]],
    battle:{turn:1,selection:null,revealed:false,results:[],score:[0,0],last:null},winner:null};
}
function publicState(room, socketId){
  const me=getPlayer(room,socketId);
  const reveal = room.phase==='finished' || (room.phase==='battle' && room.battle.revealed);
  const myIndex = me ? me.number-1 : -1;
  const platoons = room.platoons.map((side,si)=>side.map(cards=>{
    const visible = si===myIndex || reveal;
    return visible ? cards : cards.map(()=>({hidden:true}));
  }));
  return {code:room.code,phase:room.phase,playerNumber:me?.number||null,
    players:room.players.map(p=>({number:p.number,connected:p.connected,ready:p.ready})),
    hand:me?.hand||[], opponentHandCount:room.players.find(p=>p.id!==socketId)?.hand.length||0,
    platoons,battle:{...room.battle},winner:room.winner};
}
function broadcast(room){for(const p of room.players) if(p.connected) io.to(p.id).emit('state',publicState(room,p.id));}

io.on('connection', socket=>{
  socket.on('createRoom',()=>{
    const code=newCode(), room=makeRoom(code,socket.id);
    rooms.set(code,room); socket.data.room=code; socket.join(code); socket.emit('roomCreated',code); broadcast(room);
  });
  socket.on('joinRoom',raw=>{
    const code=String(raw||'').trim().toUpperCase(), room=rooms.get(code);
    if(!room) return socket.emit('errorMessage','Huonetta ei löytynyt.');
    if(room.players.length>=2) return socket.emit('errorMessage','Huone on jo täynnä.');
    if(room.phase!=='waiting') return socket.emit('errorMessage','Peli on jo alkanut.');
    room.players.push({id:socket.id,number:2,hand:[],ready:false,connected:true});
    room.phase='ready'; socket.data.room=code; socket.join(code); broadcast(room);
  });
  socket.on('startGame',()=>{
    const room=roomFor(socket); if(!room||room.players.length!==2||room.phase!=='ready')return;
    const d=shuffle(makeDeck()); room.players[0].hand=d.slice(0,10); room.players[1].hand=d.slice(10,20);
    room.platoons=[[[],[],[],[],[]],[[],[],[],[],[]]]; room.players.forEach(p=>p.ready=false);
    room.phase='arrange'; room.battle={turn:1,selection:null,revealed:false,results:[],score:[0,0],last:null}; room.winner=null; broadcast(room);
  });
  socket.on('placeCard',({handIndex,platoon})=>{
    const room=roomFor(socket), p=room&&getPlayer(room,socket.id);
    if(!room||!p||room.phase!=='arrange'||p.ready)return;
    if(!Number.isInteger(handIndex)||!Number.isInteger(platoon)||platoon<0||platoon>4)return;
    const card=p.hand.splice(handIndex,1)[0]; if(!card)return;
    room.platoons[p.number-1][platoon].push(card); broadcast(room);
  });
  socket.on('ready',()=>{
    const room=roomFor(socket), p=room&&getPlayer(room,socket.id);
    if(!room||!p||room.phase!=='arrange'||p.hand.length!==0)return;
    p.ready=true; if(room.players.every(x=>x.ready)) room.phase='battle'; broadcast(room);
  });
  socket.on('chooseBattle',({own,enemy})=>{
    const room=roomFor(socket), p=room&&getPlayer(room,socket.id);
    if(!room||!p||room.phase!=='battle'||room.battle.revealed||room.battle.turn!==p.number)return;
    if(!Number.isInteger(own)||!Number.isInteger(enemy)||own<0||own>4||enemy<0||enemy>4)return;
    room.battle.selection = p.number===1 ? {p1:own,p2:enemy} : {p1:enemy,p2:own};
    broadcast(room);
  });
  socket.on('revealBattle',()=>{
    const room=roomFor(socket), p=room&&getPlayer(room,socket.id);
    if(!room||!p||room.phase!=='battle'||room.battle.revealed||room.battle.turn!==p.number||!room.battle.selection)return;
    const s=room.battle.selection;
    let a=[...room.platoons[0][s.p1]], b=[...room.platoons[1][s.p2]];
    const jokerA=a.some(c=>c.joker), jokerB=b.some(c=>c.joker);
    if(jokerA||jokerB){[a,b]=[b,a]; room.battle.jokerSwap=true;} else room.battle.jokerSwap=false;
    const cmp=compareCards(a,b);
    const winner=cmp>0?1:cmp<0?2:0;
    if(winner) room.battle.score[winner-1]++;
    room.battle.results.push({p1:s.p1,p2:s.p2,winner});
    room.battle.last={p1:s.p1,p2:s.p2,p1Cards:a,p2Cards:b,p1Points:points(a),p2Points:points(b),comparison:cmp};
    room.battle.revealed=true; broadcast(room);
  });
  socket.on('nextTurn',()=>{
    const room=roomFor(socket), p=room&&getPlayer(room,socket.id);
    if(!room||!p||room.phase!=='battle'||!room.battle.revealed||room.battle.turn!==p.number)return;
    if(room.battle.results.length>=5){room.phase='finished'; const [a,b]=room.battle.score; room.winner=a>b?1:b>a?2:0; broadcast(room); return;}
    room.battle.turn=p.number===1?2:1; room.battle.selection=null; room.battle.revealed=false; room.battle.jokerSwap=false; room.battle.last=null; broadcast(room);
  });
  socket.on('disconnect',()=>{
    const room=roomFor(socket); if(!room)return; const p=getPlayer(room,socket.id); if(p)p.connected=false; broadcast(room);
    setTimeout(()=>{const r=rooms.get(room.code); if(r&&r.players.every(x=>!x.connected))rooms.delete(room.code);},10*60*1000);
  });
});
server.listen(PORT,()=>console.log(`Korttikärhämä listening on ${PORT}`));
