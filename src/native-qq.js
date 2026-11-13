import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';

function imageQuality(value) {
  if (value !== undefined && value !== 'preview' && value !== 'original') {
    throw Error('图片 quality 必须是 preview 或 original');
  }
  return value;
}

function imageMaxBytes(value, quality) {
  const maximum = (quality === undefined ? 20 : 32) * 1024 * 1024;
  if (value === undefined) return quality === undefined ? undefined : (quality === 'original' ? 32 : 8) * 1024 * 1024;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw Error(`图片 maxBytes 必须是 1 至 ${maximum} 之间的整数`);
  }
  return value;
}

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
  return (action, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
    if (closed || !output.writable) return reject(Error('QQ 通道未连接'));
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id); reject(Error('QQ 请求超时，操作结果未知'));
    }, timeoutMs);
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
    this.imageRequests = new Map();
    this.forwardRequests = new Map();
    this.health = { mode: 'native', connected: false, readerReady: false, hint: '等待桌面 QQ 登录' };
  }
  onPrivateMessage(fn) { this.on('private', fn); }
  onGroupMessage(fn) { this.on('group', fn); }
  onNotice(type, fn) { this.on('notice:' + type, fn); }
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
        if (event.post_type === 'notice') this.emit('notice:' + event.notice_type, event);
        else this.emit(event.message_type, event);
      } else if (packet.warning) {
        this.health.eventError = String(packet.warning).slice(0, 500);
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
    if (action === 'get_forward_msg') return this.getForwardMessage(p);
    if (action === 'group_poke' || action === 'send_poke') {
      const group = action === 'group_poke';
      const targetUin = String(p.user_id ?? '');
      const aioUin = group ? String(p.group_id ?? '') : targetUin;
      if (![targetUin, aioUin].every(id => /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 9223372036854775807n)) {
        throw Error('QQ 戳一戳目标或会话编号无效');
      }
      const call = this.call, account = this.account;
      const peer = await this.peer(group ? 'group' : 'private', aioUin);
      if (this.call !== call || this.account !== account) throw Error('QQ 连接或登录账号已切换，未发送戳一戳');
      return call('poke', {peer, targetUin, aioUin});
    }
    if (['get_group_list','get_friend_list'].includes(action)) {
      try { return await this.call(action,p); } catch (error) { if (!this.read) throw error; }
      return this.read(action,p);
    }
    if (action === 'get_image') {
      const quality = imageQuality(p.quality);
      const maxBytes = imageMaxBytes(p.maxBytes, quality);
      const sizeLimit = {...(maxBytes === undefined ? {} : {maxBytes}), ...(quality ? {quality} : {})};
      if (!this.read) throw Error('QQ 媒体库尚未连接');
      const {read, call, account} = this;
      const checkConnection = () => {
        if (this.closed || this.read !== read || this.call !== call || this.account !== account) {
          throw Error('QQ 图片读取期间账号或连接已改变，请重新读取');
        }
      };
      const md5 = String(p.file ?? '').toLowerCase();
      const emojiId = String(p.emojiId ?? '').toLowerCase();
      const packageId = String(p.emojiPackageId ?? '');
      const hasMd5 = /^[a-f0-9]{32}$/.test(md5);
      const marketFace = /^[a-f0-9]{16,64}$/.test(emojiId) && /^[1-9]\d{0,18}$/.test(packageId);
      if (!hasMd5 && !marketFace) {
        if (quality) throw Error('QQ 图片标识无效');
        return {file:null};
      }
      if (quality === 'original' && !hasMd5) throw Error('QQ 商城表情暂不支持读取原图');
      const key = String(p.key ?? '').trim();
      const messageId = String(p.messageId ?? '').trim();
      const source = /^(group|private):([1-9]\d{0,18})$/.exec(key);
      const hasLocator = !!source && /^-?[1-9]\d{0,19}$/.test(messageId);
      const imageResult = value => {
        if (quality === undefined) return {file:value};
        // Explicit quality cannot silently accept an older path-only reader or
        // call an unverified thumbnail an original. Restart the reader instead.
        if (!value || typeof value !== 'object' || !['preview','original'].includes(value.representation)
          || typeof value.originalAvailable !== 'boolean' || (value.file != null && typeof value.file !== 'string')) {
          throw Error('QQ 媒体读取器未返回有效画质信息，请重新连接');
        }
        if (quality === 'original' && value.file && (value.representation !== 'original' || !value.originalAvailable)) {
          throw Error('QQ 尚未取得经过校验的原图，未使用预览代替');
        }
        const dimension = number => Number.isInteger(number) && number > 0 && number <= 0xffffffff ? number : null;
        const reason = ['not_cached','invalid_cache','source_too_large','unsupported'].includes(value.originalUnavailableReason)
          ? value.originalUnavailableReason : null;
        return {
          file:value.file || null, representation:value.representation,
          width:dimension(value.width), height:dimension(value.height),
          originalWidth:dimension(value.originalWidth), originalHeight:dimension(value.originalHeight),
          originalAvailable:value.originalAvailable,
          originalUnavailableReason:reason,
          canFetchOriginal:hasMd5 && !['source_too_large','unsupported'].includes(reason) && (value.originalAvailable || hasLocator),
        };
      };
      let forwardPeer;
      if (p.forwardId) {
        const match = /^(group|private):([1-9]\d{0,18})$/.exec(String(p.key ?? ''));
        if (!match) throw Error('QQ 转发图片来源无效');
        forwardPeer = await this.peer(match[1], match[2]);
        checkConnection();
        // Validate the node before even returning a local cache hit. A media hash
        // supplied by a caller is not evidence that it belongs to this source.
        await call('check_forward_image', {
          peer:forwardPeer, forwardId:p.forwardId, messageId:String(p.messageId ?? ''),
          md5:hasMd5 ? md5 : '', emojiId, emojiPackageId:packageId,
        });
        checkConnection();
      }
      const image = {...(hasMd5 ? {type:'image', md5} : {type:'marketFace', emojiId, packageId}), ...sizeLimit};
      let result = imageResult(await read('media', image));
      checkConnection();
      if (!result.file && hasMd5 && marketFace && quality !== 'original') {
        if (p.forwardId) {
          // A secondary identity needs its own source check. Validating the
          // ordinary image does not authorize an arbitrary market preview.
          await call('check_forward_image', {
            peer:forwardPeer, forwardId:p.forwardId, messageId:String(p.messageId ?? ''),
            md5:'', emojiId, emojiPackageId:packageId,
          });
          checkConnection();
        }
        result = imageResult(await read('media', {type:'marketFace', emojiId, packageId, ...sizeLimit}));
      }
      checkConnection();
      if (result.file) return result;
      // Forward callers cannot supply an arbitrary fallback URL. Only expose
      // the fixed QQ CDN resource after checking this node's exact identity.
      if (!hasMd5) return p.forwardId && marketFace
        ? {...result, url:`https://gxh.vip.qq.com/club/item/parcel/item/${emojiId.slice(0,2)}/${emojiId}/raw300.gif`}
        : result;

      if (!hasLocator) return result;
      const peer = forwardPeer || await this.peer(source[1], source[2]);
      checkConnection();
      await call('fetch_message_image', {
        peer, messageId,
        md5, ...(p.forwardId ? {forwardId:p.forwardId} : {}),
      }, 30000);
      const deadline = Date.now() + 12000;
      do {
        checkConnection();
        result = imageResult(await read('media', image));
        checkConnection();
        if (result.file) return result;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (!this.closed && this.read && Date.now() < deadline);
      throw Error(quality === 'original' ? 'QQ 未能在规定时间内完成原图缓存，未使用预览代替' : 'QQ 未能在规定时间内完成图片缓存');
    }
    if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
      const kind = action === 'get_group_msg_history' ? 'group' : 'private';
      const id = p.group_id ?? p.user_id;
      const query = {kind,peer:String(id),count:p.count,anchor:p.message_id,older:p.reverse_order !== false};
      if (this.read) {
        const messages = await this.read('history',query);
        // The read-only DB decoder leaves gray tips as notices. Ask QQ for their
        // structured event metadata; ordinary history still comes from SQLite.
        const noticeIds = messages.filter(row => row.message?.some(s => s.type === 'notice')).map(row => String(row.message_id));
        if (noticeIds.length) {
          const notices = await this.call('history',{peer:await this.peer(kind,id), ids:noticeIds});
          for (let i = 0; i < messages.length; i++) {
            const resolved = notices.find(row => String(row.message_id) === String(messages[i].message_id));
            if (resolved?.notice_type === 'notify' && resolved.sub_type === 'poke') messages[i] = resolved;
          }
        }
        if (messages.length || !query.anchor) return {messages};
        // A live reminder can arrive just before QQ commits the row to SQLite.
        if (query.count === 1) return {messages:await this.call('history',{
          peer:await this.peer(kind,id), ids:[String(query.anchor)]})};
      }
      return {messages:await this.call('history',{...query,peer:await this.peer(kind,id)})};
    }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      const call = this.call;
      const peer = await this.peer(action === 'send_group_msg' ? 'group' : 'private',p.group_id ?? p.user_id);
      const message = [];
      for (const seg of p.message) {
        message.push(seg.type === 'at' ? {...seg,data:{...seg.data,uid:await this.uid(seg.data.qq)}} : seg);
      }
      return call('send',{peer,message});
    }
    return this.call(action,p);
  }
  async request(action, params) { return {status:'ok', retcode:0, data:await this.raw(action,params)}; }
  getLoginInfo() { return this.raw('get_login_info'); }
  getGroupMemberList(id) { return this.raw('get_group_member_list',{group_id:id}); }
  async getGroupMemberInfo(group, user) { return (await this.getGroupMemberList(group)).find(r => r.user_id === String(user)); }
  getForwardMessage(params = {}) {
    const key = String(params.key ?? ''), id = String(params.id ?? '');
    const source = /^(group|private):([1-9]\d{0,18})$/.exec(key);
    if (!source || !/^native:-?[1-9]\d{0,19}(?::-?[1-9]\d{0,19})?$/.test(id)) {
      return Promise.reject(Error('QQ 转发定位无效，请使用当前来源消息中的 forwardIds'));
    }
    const cacheKey = JSON.stringify([this.account, key, id]);
    const previous = this.forwardRequests.get(cacheKey);
    if (previous && previous.call === this.call) return previous.promise;
    const call = this.call, account = this.account;
    const request = {call, promise:(async () => {
      const peer = await this.peer(source[1], source[2]);
      const check = () => {
        if (this.closed || this.call !== call || this.account !== account) {
          throw Error('QQ 转发读取期间账号或连接已改变，请重新读取');
        }
      };
      check();
      const result = await call('get_forward_msg', {peer, id}, 60000);
      check();
      return result;
    })()};
    this.forwardRequests.set(cacheKey, request);
    const clear = () => { if (this.forwardRequests.get(cacheKey) === request) this.forwardRequests.delete(cacheKey); };
    void request.promise.then(clear, clear);
    return request.promise;
  }
  getImage(params = {}) {
    let maxBytes, quality;
    try { quality = imageQuality(params.quality); maxBytes = imageMaxBytes(params.maxBytes, quality); }
    catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([this.account, String(params.file ?? '').toLowerCase(),
      params.key, params.messageId, params.emojiId, params.emojiPackageId, params.forwardId, quality, maxBytes]);
    const previous = this.imageRequests.get(key);
    if (previous && previous.read === this.read && previous.call === this.call) return previous.promise;
    const request = {read:this.read, call:this.call, promise:this.raw('get_image',params)};
    this.imageRequests.set(key, request);
    const clear = () => { if (this.imageRequests.get(key) === request) this.imageRequests.delete(key); };
    // Prefetch and a simultaneous role read share one download; failures remain retryable.
    void request.promise.then(clear, clear);
    return request.promise;
  }
  sendPrivateMessage(id, message) { return this.raw('send_private_msg',{user_id:id,message:[message].flat()}); }
  sendGroupMessage(id, message) { return this.raw('send_group_msg',{group_id:id,message:[message].flat()}); }
}
