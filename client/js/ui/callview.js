import { h, toast } from '../util.js';
import { icon } from './icons.js';
import { avatar, badge } from './common.js';
import { profileDialog, editNodeDialog } from './dialogs.js';
import { errorText } from './errors.js';

export function createCallView(ctx) {
  const { data, calls } = ctx;
  let roomId = null;
  const videos = new Map(); // sid → <video>

  const title = h('div', { class: 'room-title' });
  const header = h('header', { class: 'room-head' },
    h('button', { class: 'icon-btn mobile-only', 'aria-label': '메뉴 열기', onclick: () => ctx.openDrawer() }, icon('menu')),
    title,
    h('div', { class: 'room-actions' },
      h('button', { class: 'icon-btn', title: '멤버', 'aria-label': '멤버 목록', onclick: () => ctx.togglePanel('members') }, icon('users'))));
  const stage = h('div', { class: 'call-stage' });
  const controls = h('div', { class: 'call-controls' });
  const el = h('section', { class: 'call-view', 'aria-label': '통화' }, header, stage, controls);

  function videoFor(sid, stream, mirror) {
    let v = videos.get(sid);
    if (!v) {
      v = h('video', { autoplay: true, playsinline: true, muted: true });
      v.muted = true;
      videos.set(sid, v);
    }
    if (v.srcObject !== stream) v.srcObject = stream;
    v.classList.toggle('mirror', !!mirror);
    v.play?.().catch(() => {});
    return v;
  }

  function tile(p) {
    const u = data.user(p.userId) || { id: p.userId, nickname: '…', provider: 'guest' };
    const isMe = p.sid === calls.sid;
    const stream = isMe ? calls.local : calls.peers.get(p.sid)?.stream;
    const hasVideo = !!p.state?.video && stream?.getVideoTracks().some((t) => t.readyState === 'live' && !t.muted);
    const peer = calls.peers.get(p.sid);
    const connecting = !isMe && peer && !['connected', 'completed'].includes(peer.pc.connectionState) && peer.pc.connectionState !== 'new';
    return h('div', { class: `tile${calls.speaking.has(p.sid) ? ' speaking' : ''}${hasVideo ? ' has-video' : ''}${p.state?.screen ? ' screen' : ''}`, dataset: { sid: p.sid } },
      hasVideo ? videoFor(p.sid, stream, isMe && !p.state?.screen) : h('div', { class: 'tile-avatar' }, avatar(u, 84)),
      h('div', { class: 'tile-label' },
        h('span', { class: 'ellipsis' }, u.nickname, isMe ? ' (나)' : ''), badge(u.provider),
        p.state?.muted ? icon('micOff', 14) : null,
        p.state?.deaf ? icon('headphonesOff', 14) : null,
        p.state?.screen ? icon('screen', 14) : null,
        connecting ? h('span', { class: 'muted small' }, ' 연결 중…') : null),
      h('button', { class: 'tile-hit', 'aria-label': `${u.nickname} 프로필`, onclick: () => profileDialog(ctx, p.userId) }));
  }

  function render() {
    if (!roomId) return;
    const room = data.nodes.get(roomId);
    if (!room) return;
    title.replaceChildren(icon('voice', 22, 'dim'), h('div', { class: 'room-title-text' }, h('h2', { class: 'ellipsis' }, room.name), room.topic ? h('span', { class: 'room-topic ellipsis' }, room.topic) : null));
    title.onclick = data.can('manageNodes') ? () => editNodeDialog(ctx, room) : null;
    title.classList.toggle('clickable', data.can('manageNodes'));
    const joinedHere = calls.roomId === roomId;
    const list = data.calls[roomId] || [];

    if (!joinedHere) {
      for (const v of videos.values()) v.srcObject = null;
      videos.clear();
      const reason = !data.can('joinCall') ? '게스트는 통화에 참여할 수 없습니다. Google 또는 Apple로 로그인해 주세요.'
        : !data.isOnline ? '통화는 서버에 연결되어 있을 때만 사용할 수 있습니다.' : null;
      stage.replaceChildren(h('div', { class: 'call-lobby' },
        h('div', { class: 'lobby-icon' }, icon('voice', 42)),
        h('h2', {}, room.name),
        h('p', { class: 'muted' }, list.length ? `${list.length}명이 통화 중입니다.` : '아직 아무도 없습니다.'),
        list.length ? h('div', { class: 'lobby-people' }, list.map((p) => {
          const u = data.user(p.userId) || { id: p.userId, nickname: '…' };
          return h('div', { class: 'lobby-person', title: u.nickname }, avatar(u, 48), h('span', { class: 'ellipsis small' }, u.nickname));
        })) : null,
        h('button', {
          class: 'btn primary big', disabled: !!reason,
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await calls.join(roomId); } catch (er) { toast(errorText(er), 'error'); render(); }
          },
        }, icon('phone', 18), calls.active ? ' 이 통화방으로 이동' : ' 통화 참여'),
        reason ? h('p', { class: 'notice warn' }, icon('lock', 14), ' ', reason) : null,
        h('p', { class: 'muted small' }, '음성 · 영상 · 화면 공유를 지원합니다. 참여 시 마이크 권한을 요청합니다.')));
      controls.hidden = true;
      return;
    }

    const used = new Set(list.map((p) => p.sid));
    for (const [sid, v] of videos) if (!used.has(sid)) { v.srcObject = null; videos.delete(sid); }
    stage.replaceChildren(h('div', { class: `tiles n${Math.min(list.length, 9)}` }, list.map(tile)));
    controls.hidden = false;
    const s = calls.state;
    const btn = (ic, label, on, fn, cls = '') => h('button', { class: `call-btn${on ? ' on' : ''} ${cls}`, title: label, 'aria-label': label, 'aria-pressed': String(!!on), onclick: fn }, icon(ic, 22));
    controls.replaceChildren(
      btn(s.muted ? 'micOff' : 'mic', s.muted ? '음소거 해제' : '음소거', s.muted, () => calls.toggleMute(), s.muted ? 'warn' : ''),
      btn(s.deaf ? 'headphonesOff' : 'headphones', s.deaf ? '소리 켜기' : '소리 끄기', s.deaf, () => calls.toggleDeaf(), s.deaf ? 'warn' : ''),
      btn(s.video && !s.screen ? 'video' : 'videoOff', s.video && !s.screen ? '카메라 끄기' : '카메라 켜기', s.video && !s.screen, () => calls.toggleCamera()),
      calls.canScreenShare ? btn('screen', s.screen ? '화면 공유 중지' : '화면 공유', s.screen, () => calls.toggleScreen()) : null,
      btn('phoneOff', '통화 나가기', false, () => calls.leave(), 'danger'),
    );
  }

  calls.on('update', render);
  calls.on('speaking', () => stage.querySelectorAll('.tile').forEach((t) => t.classList.toggle('speaking', calls.speaking.has(t.dataset.sid))));
  calls.on('autoplay-blocked', () => toast('브라우저가 소리 재생을 막았습니다. 화면을 한 번 눌러 주세요.', 'warn'));
  data.on('calls', render);
  data.on('users', render);
  data.on('nodes', render);
  data.on('status', render);
  document.addEventListener('click', () => { if (calls.active) calls.playAll(); }, { passive: true });

  return {
    el,
    open(id) { roomId = id; render(); },
    get roomId() { return roomId; },
  };
}
