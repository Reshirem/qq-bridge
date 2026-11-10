// Loaded inside the logged-in QQ process. Closing the bridge pipe removes the listener.
module.exports = function startChannel(receiver, endpoint) {
  const load = name => process.getBuiltinModule(name);
  const fs = load('fs'), path = load('path'), crypto = load('crypto');
  const svc = typeof receiver.getMsgService === 'function' ? receiver.getMsgService() : receiver;
  const self = globalThis.authData;
  if (!self?.uid || !self?.uin) return;
  const account = String(self.uin);
  const socket = load('net').createConnection(endpoint.pipe);
  const send = packet => { if (!socket.destroyed) socket.write(JSON.stringify(packet) + '\n'); };
  const slides = new Map(); // Only in-flight send receipts.
  let listenerId;
  const number = value => /^[1-9]\d*$/.test(String(value)) ? String(value) : '';
  function checked(response) {
    if (response?.result !== 0) throw Error(response?.errMsg || 'QQ 调用失败 ' + String(response?.result));
    return response;
  }
  function message(row) {
    const group = row.chatType === 2;
    const msg = {
      self_id: account, user_id: String(row.senderUin), message_id: String(row.msgId),
      time: Number(row.msgTime), message_type: group ? 'group' : 'private',
      sender: { user_id: String(row.senderUin), nickname: row.sendNickName || row.sendMemberName || String(row.senderUin) },
      ...(group ? { group_id: number(row.peerUin) || number(row.peerUid) } : {}),
      message: [],
    };
    for (const element of row.elements || []) {
      const t = element.textElement, q = element.replyElement, pic = element.picElement;
      let type, data;
      if (t && t.atType) {
        type = 'at'; data = { qq: t.atType === 1 ? 'all' : t.atNtUid === self.uid ? account : number(t.atUid) || t.atNtUid,
          name: String(t.content || '').replace(/^@/, '') };
      } else if (t) { type = 'text'; data = { text: t.content }; }
      else if (q) { type = 'reply'; data = { id: number(q.sourceMsgIdInRecords) || q.replayMsgId, nativeSelf: q.senderUidStr === self.uid }; }
      else if (pic) { type = 'image'; data = { file: pic.md5HexStr, sub_type: pic.picSubType, summary: pic.summary }; }
      else if (element.faceElement) { type = 'face'; data = { id: element.faceElement.faceIndex }; }
      else if (element.marketFaceElement) { const f = element.marketFaceElement; type = 'mface'; data = { emoji_id: f.emojiId, emoji_package_id: f.emojiPackageId, summary: f.faceName }; }
      else if (element.videoElement) { type = 'video'; data = {}; }
      else if (element.fileElement) { type = 'file'; data = { name: element.fileElement.fileName }; }
      else { type = '其他消息'; data = {}; }
      msg.message.push({ type, data });
    }
    return msg;
  }
  const listener = new Proxy({
    onRecvMsg(rows) {
      if (String(globalThis.authData?.uin) !== account) return socket.destroy();
      for (const r of rows || []) {
        if (![1, 2].includes(r.chatType) || r.senderUid === self.uid || !number(r.senderUin)) continue;
        const event = message(r);
        if (event.message_type === 'group' && !event.group_id) continue;
        send({ event, peerUid: r.peerUid });
      }
    },
    onMsgInfoListUpdate(rows) {
      for (const row of rows || []) {
        const receipt = slides.get(String(row.guildId)) || slides.get(String(row.msgId));
        if (!receipt || row.peerUid !== receipt.peer.peerUid || row.chatType !== receipt.peer.chatType || String(row.senderUin) !== account) continue;
        if (row.sendStatus === 0) receipt.reject(Error('QQ 报告发送失败'));
        if (row.sendStatus === 2 && number(row.msgSeq)) receipt.resolve({ message_id: String(row.msgId) });
      }
    },
  }, { get: (obj, prop) => prop in obj ? obj[prop] : typeof prop === 'string' && prop.startsWith('on') ? () => {} : undefined });
  async function original(peer, id) {
    const rows = checked(await svc.getMsgsByMsgId(peer, [String(id)])).msgList;
    const row = rows.find(r => r.chatType === peer.chatType && r.peerUid === peer.peerUid && String(r.msgId) === String(id));
    if (!row) throw Error('QQ 当前会话中找不到此消息');
    return row;
  }
  async function sendMessage(p) {
    const elements = [];
    let temp;
    const tag = String(svc.generateMsgUniqueId(p.peer.chatType, String(Date.now())));
    if (!number(tag)) throw Error('QQ 未生成发送标识');
    let timer;
    try {
      for (const seg of p.message) {
        const d = seg.data;
        if (seg.type === 'text' || seg.type === 'at') {
          const at = seg.type === 'at';
          elements.push({ elementType: 1, elementId: '', textElement: { content: at ? '@' + d.qq : d.text, atType: at ? 2 : 0,
            atUid: at ? String(d.qq) : '', atNtUid: at ? d.uid : '', atTinyId: '' } });
        } else if (seg.type === 'reply') {
          const row = await original(p.peer, d.id);
          elements.push({ elementType: 7, elementId: '', replyElement: { replayMsgSeq: String(row.msgSeq),
            replayMsgId: String(row.msgId), senderUin: String(row.senderUin), senderUidStr: row.senderUid,
            replyMsgTime: String(row.msgTime), sourceMsgIdInRecords: String(row.msgId) } });
        } else if (seg.type === 'image') {
          if (!String(d.file).startsWith('base64://')) throw Error('QQ 图片需要原始字节');
          const bytes = Buffer.from(d.file.slice(9), 'base64');
          const gif = /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6));
          const png = bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47;
          const webp = bytes.toString('ascii',8,12) === 'WEBP';
          const ext = gif ? 'gif' : png ? 'png' : webp ? 'webp' : 'jpg';
          const size = gif ? {width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8)}
            : process.mainModule.require('electron').nativeImage.createFromBuffer(bytes).getSize();
          if (!size.width || !size.height) throw Error('QQ 无法识别这张图片');
          temp = fs.mkdtempSync(path.join(load('os').tmpdir(), 'qq-bridge-image-'));
          const sourcePath = path.join(temp, 'image.' + ext);
          fs.writeFileSync(sourcePath, bytes);
          elements.push({elementType: 2, elementId: '', picElement: {sourcePath, fileName: path.basename(sourcePath), fileSize: String(bytes.length),
            picType: gif ? 2000 : png ? 1001 : webp ? 1002 : 1000, picSubType: 1, picWidth: size.width, picHeight: size.height,
            md5HexStr: crypto.createHash('md5').update(bytes).digest('hex'), original: true, thumbPath: new Map(), summary: '[表情]' }});
        } else throw Error('QQ 直连未支持此发送元素');
      }
      if (socket.destroyed || String(globalThis.authData?.uin) !== account) throw Error('QQ 连接已关闭');
      const delivered = new Promise((resolve, reject) => {
        slides.set(tag, {peer: p.peer, resolve, reject});
        timer = setTimeout(() => reject(Error('QQ 发送回执超时，投递结果未知')), 12000);
      });
      const [, receipt] = await Promise.all([svc.sendMsg('0', {...p.peer, guildId: tag}, elements, new Map()).then(checked), delivered]);
      return receipt;
    } finally {
      slides.delete(tag); clearTimeout(timer);
      if (temp) fs.rmSync(temp, {recursive: true, force: true});
    }
  }
  async function perform(action, p) {
    if (String(globalThis.authData?.uin) !== account) throw Error('QQ 登录账号已切换');
    if (action === 'get_login_info') return {user_id: account, nickname: self.nickName || self.nickname || ''};
    if (action === 'history') {
      const res = p.ids ? await svc.getMsgsByMsgId(p.peer,p.ids)
        : await svc.getMsgsIncludeSelf(p.peer, p.anchor || '0', p.count, p.older);
      const rows = checked(res).msgList.filter(r => r.chatType === p.peer.chatType && r.peerUid === p.peer.peerUid);
      return rows.map(message);
    }
    if (action === 'resolveUid') {
      const map = await receiver.getUixConvertService?.().getUid([p.uin]);
      return map?.uidInfo?.get(p.uin) || '';
    }
    if (action === 'send') return sendMessage(p);
    if (action === 'get_friend_list' && receiver.getBuddyService) {
      const directory = await receiver.getBuddyService().getBuddyListV2('0',true,0);
      const uids = directory.data.flatMap(category => category.buddyUids);
      if (!uids.length) return [];
      const profiles = await receiver.getProfileService().getCoreAndBaseInfo('nodeStore',uids);
      return Array.from(profiles.values(), m => ({user_id:String(m.uin), nickname:m.nick || '', remark:m.remark || ''}));
    }
    if (action === 'get_group_list' && receiver.getGroupService) {
      const groups = receiver.getGroupService();
      let timer, listener;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error('QQ 群列表查询超时')), 5000);
          listener = groups.addKernelGroupListener(new Proxy({onGroupListUpdate(...args) {
            const rows = args.find(Array.isArray);
            if (rows) resolve(rows.map(g => ({group_id:String(g.groupCode),group_name:g.groupName})));
          }}, {get:(target,key) => key in target ? target[key] : () => {}}));
          Promise.resolve(groups.getGroupList(false)).catch(reject);
        });
      } finally {
        clearTimeout(timer);
        if (listener != null) groups.removeKernelGroupListener(String(listener));
      }
    }
    if (action === 'get_group_member_list') {
      if (!receiver.getGroupService) throw Error('当前 QQ 未提供群成员服务');
      const response = await receiver.getGroupService().getAllMemberList(String(p.group_id), false);
      if (response.errCode || !response.result?.finish || !(response.result.infos instanceof Map)) {
        throw Error('QQ 未返回完整的群成员名单');
      }
      return [...response.result.infos.values()].filter(m => number(m.uin)).map(m =>
        ({user_id:String(m.uin), nickname:m.nick || m.nickname || '', card:m.cardName || ''}));
    }
    if (action === 'add_custom_face') {
      if (!String(p.file).startsWith('base64://')) throw Error('QQ 收藏需要图片原始字节');
      const data = Buffer.from(p.file.slice(9),'base64');
      const md5 = crypto.createHash('md5').update(data).digest('hex');
      const folder = fs.mkdtempSync(path.join(load('os').tmpdir(),'qq-bridge-favorite-'));
      try {
        const filename = md5 + (/^GIF8/.test(data.toString('ascii',0,4)) ? '.gif' : data[0] === 0x89 ? '.png' : '.jpg');
        const file = path.join(folder,filename);
        fs.writeFileSync(file,data);
        const added = await svc.addFavEmoji({emojiPath:file,fileSize:String(data.length),fileName:filename,md5,isOrigin:true,isMarkFace:false});
        if (added?.result != null) checked(added);
        const rows = checked(await svc.fetchFavEmojiList('',500,true,true)).emojiInfoList;
        const entry = rows.find(row => String(row.md5).toLowerCase() === md5);
        if (!entry) throw Error('QQ 未确认收藏结果，请刷新收藏后核对');
        return {emoji_id:entry.resId || String(entry.emoId)};
      } finally { fs.rmSync(folder,{recursive:true,force:true}); }
    }
    if (action === 'fetch_custom_face_detail' || action === 'modify_custom_face' || action === 'favorite_image') {
      const rows = checked(await svc.fetchFavEmojiList('', p.count || 500, true, true)).emojiInfoList;
      if (action === 'fetch_custom_face_detail') return rows.map(f => ({emoji_id: f.resId || String(f.emoId), resId: f.resId, md5: f.md5, url: f.url, desc: f.desc}));
      const f = rows.find(f => (f.resId || String(f.emoId)) === p.emoji_id);
      if (!f) throw Error('当前 QQ 收藏中找不到该表情');
      if (action === 'modify_custom_face') return checked(await svc.modifyFavEmojiDesc([{emojiId:f.emoId,resId:f.resId,md5:f.md5,desc:p.desc}]));
      for (const file of [f.emoOriginalPath,f.emoPath]) {
        if (!file || !fs.existsSync(file) || fs.statSync(file).size > p.maxBytes) continue;
        const data = fs.readFileSync(file);
        if (crypto.createHash('md5').update(data).digest('hex') === String(f.md5).toLowerCase()) return data.toString('base64');
      }
      throw Error('QQ 收藏原件尚未下载');
    }
    throw Error('QQ 独立通道尚不支持 ' + action);
  }
  socket.once('connect', () => {
    try {
      listenerId = svc.addKernelMsgListener(listener);
      send({ hello: endpoint.token, account, uid: self.uid, pid: process.pid });
    } catch { socket.destroy(); }
  });
  load('readline').createInterface({input:socket}).on('line', async line => {
    let r;
    try { r = JSON.parse(line); send({ id:r.id, data:await perform(r.action,r.params) }); }
    catch (e) { if(r) send({id:r.id,error:String(e.message || e)}); }
  });
  const identityTimer = setInterval(() => { if (String(globalThis.authData?.uin) !== account) socket.destroy(); }, 1000);
  identityTimer.unref();
  socket.on('error', () => socket.destroy());
  socket.once('close', () => {
    clearInterval(identityTimer);
    if (listenerId != null) svc.removeKernelMsgListener(String(listenerId));
    for (const receipt of slides.values()) receipt.reject(Error('QQ 通道已断开，投递结果未知'));
  });
};
