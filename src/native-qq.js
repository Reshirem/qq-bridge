import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

// Every request belongs to one connection. Never resubmit an interrupted send.
function rpcStream(output, input, notification) {
  const pending = new Map();
  const lines = createInterface({ input });
  let next = 0, closed = false;
  lines.on('line', line => {
    let packet;
    try { packet = JSON.parse(line); } catch { return; }
    const request = pending.get(packet.id);
    if (!request) { notification(packet); return; }
    pending.delete(packet.id);
    clearTimeout(request.timer);
    if (packet.error) request.reject(Error(packet.error));
    else request.resolve(packet.data);
  });
  function close() {
    closed = true;
    for (const req of pending.values()) {
      clearTimeout(req.timer); req.reject(Error('QQ 通道已断开'));
    }
    pending.clear();
    lines.close();
  }
  input.once('close', close);
  output.on('error', close);
  return (action, params = {}) => new Promise((resolve, reject) => {
    if (closed || !output.writable) return reject(Error('QQ 通道未连接'));
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id); reject(Error('QQ 请求超时，发送操作的投递结果未知'));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    output.write(JSON.stringify({ id, action, params }) + '\n');
  });
}

export class NativeQQ extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.pipe = '\\\\.\\pipe\\qq-bridge-' + randomUUID();
    this.token = randomUUID();
    this.health = { mode: 'native', connected: false, readerReady: false, hint: '等待桌面 QQ 登录' };
  }
  onPrivateMessage(fn) { this.on('private', fn); }
  onGroupMessage(fn) { this.on('group', fn); }
  onNotice() {} // Native message callbacks are registered inside QQ.
  async connect() {
    this.server = createServer(socket => this.accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.pipe, resolve);
    });
    this.attach();
  }
  python(env, script, args = []) {
    return spawn(path.join(this.root, 'state', env, 'venv/Scripts/python.exe'),
      ['-B', '-u', path.join(this.root, 'scripts', script), ...args], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
  }
  attach() {
    if (this.closed || this.socket || this.loader) return;
    const child = this.python('ntqq-probe', 'ntqq-probe/attach_runtime.py');
    this.loader = child;
    let last = '';
    child.stdin.on('error', () => {});
    child.stderr.on('data', data => { last = (last + data).slice(-700); });
    child.on('error', e => { last = e.message; });
    child.once('close', () => {
      this.loader = null;
      if (!this.socket && !this.closed) {
        this.health.hint = last.trim().split('\n').at(-1) || '等待桌面 QQ 连接';
        this.retry();
      }
    });
    child.stdin.end(JSON.stringify({ pipe: this.pipe, token: this.token }));
  }
  retry() {
    if (!this.closed && !this.retryTimer) this.retryTimer = setTimeout(() => {
      this.retryTimer = null; this.attach();
    }, 5000);
  }
  startReader(hello) {
    const child = this.python('ntqq-reader', 'ntqq_reader_service.py', [hello.account, String(hello.pid), hello.uid]);
    this.reader = child;
    let last = '';
    child.stderr.on('data', b => { last = (last + b).slice(-700); });
    child.on('error', e => { last = e.message; });
    const call = rpcStream(child.stdin, child.stdout, packet => {
      if (packet.ready && this.reader === child) {
        this.read = call; this.health.readerReady = true; this.health.readerError = '';
        this.emit('reader-ready');
      }
    });
    child.once('close', () => {
      if (this.reader !== child) return;
      this.read = null; this.reader = null; this.health.readerReady = false;
      this.health.readerError = last.trim().split('\n').at(-1) || '只读连接已结束';
      if (!this.closed && this.socket) this.readerRetry = setTimeout(() => this.startReader(hello), 30000);
    });
  }
  accept(socket) {
    const timeout = setTimeout(() => socket.destroy(), 3000);
    socket.on('error', () => socket.destroy());
    const call = rpcStream(socket, socket, packet => {
      if (socket !== this.socket) {
        if (this.closed || this.socket || packet.hello !== this.token || !/^[1-9]\d+$/.test(packet.account) || !packet.uid) return socket.destroy();
        clearTimeout(timeout);
        this.socket = socket; this.call = call;
        this.account = packet.account;
        Object.assign(this.health, {connected: true, accountOnline: true, hint: ''});
        this.startReader(packet);
        this.emit('open');
      } else if (packet.event) {
        const event = packet.event;
        if (String(event.self_id) !== this.account || !['private','group'].includes(event.message_type)) return;
        this.health.lastPacketAt = Date.now();
        this.emit(event.message_type, event);
      }
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      if (socket !== this.socket) return;
      this.socket = null; this.call = null;
      clearTimeout(this.readerRetry); this.reader?.kill(); this.reader = null; this.read = null;
      Object.assign(this.health,{connected:false, readerReady:false, accountOnline:false, hint:'等待重新连接桌面 QQ'});
      this.emit('close'); this.retry();
    });
  }
  close() {
    this.closed = true; clearTimeout(this.retryTimer); clearTimeout(this.readerRetry);
    this.loader?.kill(); this.reader?.kill(); this.socket?.destroy(); this.server?.close();
  }
  async uid(uin) {
    const value = String(uin);
    const uid = await this.read?.('uid', {uin:value}) || await this.call('resolveUid', {uin:value});
    if (!uid) throw Error('QQ 无法解析此账号的 NT UID');
    return uid;
  }
  async peer(kind, id) { return {chatType: kind === 'group' ? 2 : 1, peerUid: kind === 'group' ? String(id) : await this.uid(id)}; }
  async raw(action, p = {}) {
    if (!this.call) throw Error(this.health.hint || 'QQ 独立通道未连接');
    if (action === 'get_status') return {online:true, good:true};
    if (['get_group_list','get_friend_list'].includes(action)) {
      try { return await this.call(action,p); } catch (error) { if (!this.read) throw error; }
      return this.read(action,p);
    }
    if (action === 'get_image') {
      if (!this.read) throw Error('QQ 媒体库尚未连接');
      return {file:await this.read('media', {md5:p.file})};
    }
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
      const kind = action === 'get_group_msg_history' ? 'group' : 'private';
      const id = p.group_id ?? p.user_id;
      const query = {kind,peer:String(id),count:p.count,anchor:p.message_id,older:p.reverse_order !== false};
      if (this.read) {
        const messages = await this.read('history',query);
        if (messages.length || !query.anchor) return {messages};
        // A live reminder can arrive just before QQ commits the row to SQLite.
        if (query.count === 1) return {messages:await this.call('history',{
          peer:await this.peer(kind,id), ids:[String(query.anchor)]})};
      }
      return {messages:await this.call('history',{...query,peer:await this.peer(kind,id)})};
    }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      const peer = await this.peer(action === 'send_group_msg' ? 'group' : 'private',p.group_id ?? p.user_id);
      const message = [];
      for (const seg of p.message) {
        message.push(seg.type === 'at' ? {...seg,data:{...seg.data,uid:await this.uid(seg.data.qq)}} : seg);
      }
      return this.call('send',{peer,message});
    }
    return this.call(action,p);
  }
  async request(action, params) { return {status:'ok', retcode:0, data:await this.raw(action,params)}; }
  getLoginInfo() { return this.raw('get_login_info'); }
  getGroupMemberList(id) { return this.raw('get_group_member_list',{group_id:id}); }
  async getGroupMemberInfo(group, user) { return (await this.getGroupMemberList(group)).find(r => r.user_id === String(user)); }
  getImage(params) { return this.raw('get_image',params); }
  sendPrivateMessage(id, message) { return this.raw('send_private_msg',{user_id:id,message:[message].flat()}); }
  sendGroupMessage(id, message) { return this.raw('send_group_msg',{group_id:id,message:[message].flat()}); }
}
