// 통화방: WebRTC 메시(mesh) 연결. 시그널링은 Socket.IO 서버를 통해 이루어집니다.
// "perfect negotiation" 패턴을 사용해 카메라/화면 공유 추가 시 재협상을 처리합니다.
import { config } from './config.js';
import { Emitter, toast } from './util.js';

export class CallManager extends Emitter {
  constructor(data) {
    super();
    this.data = data;
    this.roomId = null;
    this.sid = null;
    this.peers = new Map(); // sid → {pc, polite, makingOffer, ignoreOffer, stream, audioEl, userId, speaking}
    this.local = null; // MediaStream (오디오 + 선택적 비디오)
    this.videoTrack = null;
    this.state = { muted: false, deaf: false, video: false, screen: false };
    this.speaking = new Set();
    this.joinedAt = 0;
    this.volumes = new Map(); // userId → 0~1
    this.sinkId = '';
    this.micId = '';
    this.camId = '';
    this.ptt = false; // 눌러서 말하기
    this.pttDown = false;
    data.on('call:signal', (e) => this.#onSignal(e));
    data.on('calls', (roomId) => { if (!roomId || roomId === this.roomId) this.#syncPeers(); });
    data.on('disconnected', () => { if (this.roomId) this.leave(true); });
    data.on('nodesRemoved', (ids) => { if (ids.includes(this.roomId)) this.leave(true); });
  }

  get active() { return !!this.roomId; }
  get canScreenShare() { return !!navigator.mediaDevices?.getDisplayMedia; }

  async join(roomId) {
    if (!this.data.can('joinCall')) throw new Error('로그인한 사용자만 통화에 참여할 수 있습니다.');
    if (!this.data.isOnline) throw new Error('통화는 서버에 연결되어 있을 때만 사용할 수 있습니다.');
    if (this.roomId === roomId) return;
    if (this.roomId) await this.leave();
    this.local = new MediaStream();
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: this.#audioConstraints() });
      mic.getAudioTracks().forEach((t) => this.local.addTrack(t));
    } catch {
      toast('마이크를 사용할 수 없어 듣기 전용으로 참여합니다.', 'warn');
      this.state.muted = true;
    }
    this.#ensureAudioCtx();
    this.#watchLevel('local', this.local);
    const res = await this.data.request('call:join', { roomId, state: this.state });
    this.roomId = roomId;
    this.sid = res.sid;
    this.joinedAt = Date.now();
    this.#applyMicGate();
    for (const p of res.peers) this.#peer(p.sid, p.userId);
    this.emit('update');
  }

  #audioConstraints() {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(this.micId ? { deviceId: { exact: this.micId } } : {}) };
  }

  /** 마이크 켜짐 여부 = 음소거 아님 && (눌러서 말하기가 꺼져 있거나, 누르고 있음) */
  #applyMicGate() {
    const on = !this.state.muted && (!this.ptt || this.pttDown);
    this.local?.getAudioTracks().forEach((t) => { t.enabled = on; });
  }

  setPtt(on) {
    this.ptt = !!on;
    this.pttDown = false;
    this.#applyMicGate();
    this.emit('update');
  }

  setTalking(down) {
    if (!this.ptt || this.pttDown === down) return;
    this.pttDown = down;
    this.#applyMicGate();
    this.emit('ptt', down);
  }

  get micLive() {
    return !!this.local?.getAudioTracks().some((t) => t.enabled);
  }

  setVolume(userId, v) {
    this.volumes.set(userId, v);
    for (const p of this.peers.values()) if (p.userId === userId && p.audioEl) p.audioEl.volume = v;
  }

  async devices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      return {
        mics: list.filter((d) => d.kind === 'audioinput'),
        speakers: list.filter((d) => d.kind === 'audiooutput'),
        cams: list.filter((d) => d.kind === 'videoinput'),
      };
    } catch {
      return { mics: [], speakers: [], cams: [] };
    }
  }

  async setMic(deviceId) {
    this.micId = deviceId;
    if (!this.local) return;
    const s = await navigator.mediaDevices.getUserMedia({ audio: this.#audioConstraints() });
    const track = s.getAudioTracks()[0];
    const old = this.local.getAudioTracks()[0];
    if (old) { this.local.removeTrack(old); old.stop(); }
    this.local.addTrack(track);
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((x) => x.track?.kind === 'audio' || x.track === old);
      if (sender) await sender.replaceTrack(track); else p.pc.addTrack(track, this.local);
    }
    this.state.muted = false;
    this.#applyMicGate();
    this.#watchLevel('local', this.local);
    this.#pushState();
  }

  async setSpeaker(deviceId) {
    this.sinkId = deviceId;
    for (const p of this.peers.values()) await p.audioEl?.setSinkId?.(deviceId).catch(() => {});
  }

  async setCamera(deviceId) {
    this.camId = deviceId;
    if (this.state.video && !this.state.screen) {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      await this.#setVideo(s.getVideoTracks()[0], false);
    }
  }

  async leave(silent = false) {
    if (!this.roomId) return;
    const roomId = this.roomId;
    this.roomId = null;
    for (const sid of [...this.peers.keys()]) this.#closePeer(sid);
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.videoTrack = null;
    this.state = { muted: false, deaf: false, video: false, screen: false };
    this.speaking.clear();
    this.joinedAt = 0;
    this.#stopLevel('local');
    if (!silent) this.data.request('call:leave', { roomId }).catch(() => {});
    this.emit('update');
  }

  toggleMute() {
    const tracks = this.local?.getAudioTracks() || [];
    if (!tracks.length) return toast('마이크가 연결되어 있지 않습니다.', 'warn');
    this.state.muted = !this.state.muted;
    this.#applyMicGate();
    this.#pushState();
  }

  toggleDeaf() {
    this.state.deaf = !this.state.deaf;
    for (const p of this.peers.values()) if (p.audioEl) p.audioEl.muted = this.state.deaf;
    this.#pushState();
  }

  async toggleCamera() {
    if (this.state.video && !this.state.screen) return this.#stopVideo();
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(this.camId ? { deviceId: { exact: this.camId } } : { facingMode: 'user' }) } });
      await this.#setVideo(s.getVideoTracks()[0], false);
    } catch {
      toast('카메라를 사용할 수 없습니다.', 'error');
    }
  }

  async toggleScreen() {
    if (this.state.screen) return this.#stopVideo();
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = s.getVideoTracks()[0];
      track.addEventListener('ended', () => { if (this.videoTrack === track) this.#stopVideo(); });
      await this.#setVideo(track, true);
    } catch { /* 사용자가 취소 */ }
  }

  async #setVideo(track, screen) {
    const old = this.videoTrack;
    if (old) { this.local.removeTrack(old); old.stop(); }
    this.videoTrack = track;
    this.local.addTrack(track);
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track?.kind === 'video' || (s.track === null && s._video));
      if (sender) await sender.replaceTrack(track);
      else {
        const sd = p.pc.addTrack(track, this.local);
        sd._video = true;
      }
    }
    this.state.video = true;
    this.state.screen = screen;
    this.#pushState();
  }

  async #stopVideo() {
    const t = this.videoTrack;
    if (t) { this.local?.removeTrack(t); t.stop(); }
    this.videoTrack = null;
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track === t);
      if (sender) { sender._video = true; await sender.replaceTrack(null); }
    }
    this.state.video = false;
    this.state.screen = false;
    this.#pushState();
  }

  #pushState() {
    if (this.roomId) this.data.request('call:state', { state: this.state }).catch(() => {});
    this.emit('update');
  }

  /** 서버의 참여자 목록에서 사라진 피어 정리 */
  #syncPeers() {
    if (!this.roomId) return;
    const list = this.data.calls[this.roomId] || [];
    if (!list.some((p) => p.sid === this.sid)) {
      // 서버에서 내가 빠짐 (방 삭제 등)
      this.leave(true);
      return;
    }
    const sids = new Set(list.map((p) => p.sid));
    for (const sid of [...this.peers.keys()]) if (!sids.has(sid)) this.#closePeer(sid);
    this.emit('update');
  }

  participants() {
    return this.roomId ? this.data.calls[this.roomId] || [] : [];
  }

  #peer(sid, userId) {
    if (this.peers.has(sid)) return this.peers.get(sid);
    const pc = new RTCPeerConnection({ iceServers: config.iceServers });
    const p = { pc, userId, polite: this.sid > sid, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), audioEl: null };
    this.peers.set(sid, p);
    for (const t of this.local?.getTracks() || []) {
      const s = pc.addTrack(t, this.local);
      if (t.kind === 'video') s._video = true;
    }
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.#signal(sid, { description: pc.localDescription });
      } catch (e) {
        console.warn('[call] offer 실패', e);
      } finally {
        p.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => candidate && this.#signal(sid, { candidate });
    pc.ontrack = ({ track, streams }) => {
      const src = streams[0];
      if (src) p.stream = src;
      else p.stream.addTrack(track);
      if (track.kind === 'audio') {
        if (!p.audioEl) {
          p.audioEl = new Audio();
          p.audioEl.autoplay = true;
          p.audioEl.playsInline = true;
        }
        p.audioEl.srcObject = p.stream;
        p.audioEl.muted = this.state.deaf;
        p.audioEl.volume = this.volumes.get(p.userId) ?? 1;
        if (this.sinkId) p.audioEl.setSinkId?.(this.sinkId).catch(() => {});
        p.audioEl.play().catch(() => this.emit('autoplay-blocked'));
        this.#watchLevel(sid, p.stream);
      }
      track.addEventListener('unmute', () => this.emit('update'));
      track.addEventListener('mute', () => this.emit('update'));
      track.addEventListener('ended', () => this.emit('update'));
      this.emit('update');
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce?.();
      this.emit('update');
    };
    return p;
  }

  #closePeer(sid) {
    const p = this.peers.get(sid);
    if (!p) return;
    try { p.pc.close(); } catch { /* noop */ }
    if (p.audioEl) { p.audioEl.srcObject = null; }
    this.#stopLevel(sid);
    this.speaking.delete(sid);
    this.peers.delete(sid);
  }

  #signal(to, data) {
    this.data.request('call:signal', { to, data: JSON.parse(JSON.stringify(data)) }).catch(() => {});
  }

  async #onSignal({ from, userId, data }) {
    if (!this.roomId) return;
    const p = this.#peer(from, userId);
    const { pc } = p;
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === 'offer') {
          await pc.setLocalDescription();
          this.#signal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!p.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.warn('[call] 시그널 처리 실패', e);
    }
  }

  playAll() {
    for (const p of this.peers.values()) p.audioEl?.play().catch(() => {});
  }

  // ── 말하는 중 표시 ──
  #ensureAudioCtx() {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume?.();
    } catch {
      this.ctx = null;
    }
    this.levels = this.levels || new Map();
  }

  #watchLevel(key, stream) {
    if (!this.ctx || !stream.getAudioTracks().length) return;
    this.#stopLevel(key);
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const timer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) ** 2;
        const rms = Math.sqrt(sum / buf.length);
        const muted = key === 'local' && !this.micLive;
        const on = rms > 6 && !muted;
        const id = key === 'local' ? this.sid : key;
        if (on !== this.speaking.has(id)) {
          if (on) this.speaking.add(id); else this.speaking.delete(id);
          this.emit('speaking');
        }
      }, 150);
      this.levels.set(key, { src, timer });
    } catch { /* noop */ }
  }

  #stopLevel(key) {
    const l = this.levels?.get(key);
    if (!l) return;
    clearInterval(l.timer);
    try { l.src.disconnect(); } catch { /* noop */ }
    this.levels.delete(key);
  }
}
