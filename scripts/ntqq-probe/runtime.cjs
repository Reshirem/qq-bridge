// Loaded inside the logged-in QQ process. Closing the bridge pipe removes the listener.
module.exports = function startChannel(receiver, endpoint) {
  const load = name => process.getBuiltinModule(name);
  const fs = load('fs'), path = load('path'), crypto = load('crypto'), os = load('os');
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
  async function message(row) {
    const group = row.chatType === 2;
    const msg = {
      self_id: account, user_id: String(row.senderUin), message_id: String(row.msgId),
      time: Number(row.msgTime), message_type: group ? 'group' : 'private',
      sender: { user_id: String(row.senderUin), nickname: row.sendNickName || row.sendMemberName || String(row.senderUin) },
      ...(group ? { group_id: number(row.peerUin) || number(row.peerUid) } : {}),
      message: [],
    };
    // NTQQ JSON gray-tip business 1061 is the QQ poke feature. Display text is
    // customizable and must never be used as an event or recipient classifier.
    const gray = (row.elements || []).find(e => e.grayTipElement)?.grayTipElement;
    if (gray?.subElementType === 17 && String(gray.jsonGrayTipElement?.busiId) === '1061') {
      let body;
      try { body = JSON.parse(gray.jsonGrayTipElement.jsonStr); } catch { return msg; }
      const people = Array.isArray(body?.items) ? body.items.filter(item => typeof item?.uid === 'string' && item.uid) : [];
      if (people.length !== 2) return msg;
      const ids = people.map(item => item.uid);
      const unresolved = ids.filter(uid => uid !== self.uid && !number(uid));
      const converted = unresolved.length ? await receiver.getUixConvertService?.().getUin(unresolved) : null;
      const [actor, target] = ids.map(uid => uid === self.uid ? account : number(uid) || number(converted?.uinInfo?.get(uid)));
      if (!actor || !target) return msg;
      const peer = group ? msg.group_id : number(row.peerUin) || (actor === account ? target : actor);
      if (!peer) return msg;
      const text = `[QQ 戳一戳事件] QQ ${actor} 对 QQ ${target} 使用了“戳一戳”功能。`;
      return { ...msg, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
        user_id: actor, sender_id: actor, target_id: target, ...(!group ? {peer_id: peer} : {}),
        sender: {user_id: actor, nickname: actor},
        poke: {targetId: target, targetIsSelf: target === account, groupId: group ? peer : null},
        message: [{type: 'text', data: {text}}] };
    }
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
    async onRecvMsg(rows) {
      if (String(globalThis.authData?.uin) !== account) return socket.destroy();
      for (const r of rows || []) {
        if (![1, 2].includes(r.chatType)) continue;
        try {
          const event = await message(r);
          if (event.message_type === 'group' && !event.group_id) continue;
          if (event.post_type === 'notice') {
            if (event.sender_id === account) continue;
          } else if ((r.elements || []).some(e => e.grayTipElement) || r.senderUid === self.uid || !number(r.senderUin)) continue;
          if (String(globalThis.authData?.uin) !== account) return socket.destroy();
          send({ event, peerUid: r.peerUid });
        } catch (error) { send({warning: 'QQ 事件解析失败：' + String(error.message || error)}); }
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
  async function marketResources(packId, faceIds) {
    const response = checked(await svc.getMarketEmoticonEncryptKeys(Number(packId), faceIds));
    if (!(response.encryptKeyMap instanceof Map)) throw Error('QQ 未返回商城表情发送资料');
    const resources = new Map();
    for (const [id, value] of response.encryptKeyMap) {
      if (typeof value === 'string' && value.length) resources.set(String(id).toLowerCase(), value);
    }
    return resources;
  }
  async function fetchMessageImage(p) {
    const peer = p.peer;
    const messageId = String(p.messageId ?? '');
    if (!peer || ![1, 2].includes(Number(peer.chatType)) || !peer.peerUid ||
        !/^-?[1-9]\d{0,19}$/.test(messageId)) throw Error('QQ 图片定位信息无效');
    const digest = String(p.md5 ?? '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(digest)) throw Error('QQ 图片标识无效');
    const row = await original(peer, messageId);
    const element = (row.elements || []).find(item => item.picElement &&
      String(item.picElement.md5HexStr).toLowerCase() === digest);
    if (!element?.elementId) throw Error('QQ 原消息中找不到对应的图片元素');
    if (typeof svc.getRichMediaElement !== 'function') throw Error('当前 QQ 不支持按原消息下载图片');
    const root = path.join(os.homedir(), 'Documents', 'Tencent Files', account, 'nt_qq', 'nt_data');
    const target = element.picElement.sourcePath;
    const relative = typeof target === 'string' && path.isAbsolute(target) ? path.relative(root, target) : '..';
    const sticker = Number(element.picElement.picSubType) === 1;
    if (!sticker && (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) {
      throw Error('QQ 返回的图片缓存位置无效');
    }
    const result = await svc.getRichMediaElement({
      downSourceType: 1,
      msgId: String(row.msgId), peerUid: String(peer.peerUid), chatType: Number(peer.chatType),
      elementId: String(element.elementId), downloadType: 1,
      // Ordinary images need QQ's original destination; stickers choose their own cache.
      ...(sticker ? {} : {thumbSize: 0, filePath: target}),
    });
    if (result?.result != null) checked(result);
    return {requested: true};
  }

  async function sendMessage(p) {
    const elements = [];
    let stickerFormat;
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
        } else if (seg.type === 'mface') {
          const resources = await marketResources(d.emoji_package_id, [d.emoji_id]);
          const key = resources.get(d.emoji_id);
          // No message has been submitted yet. The bridge can use the local picture in this case.
          if (!key) return {marketResourceMissing: true};
          elements.push({elementType: 11, elementId: '', marketFaceElement: {
            emojiPackageId: Number(d.emoji_package_id), emojiId: d.emoji_id, key, faceName: d.summary,
          }});
          stickerFormat = 'marketFace';
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
          const md5HexStr = crypto.createHash('md5').update(bytes).digest('hex');
          const fileName = md5HexStr + '.' + ext;
          const picSubType = 1;
          const sourcePath = svc.getRichMediaFilePathForGuild({
            elementType: 2, elementSubType: picSubType, fileName, md5HexStr,
            downloadType: 1, thumbSize: 0, needCreate: true, file_uuid: '',
          });
          if (!sourcePath || !path.isAbsolute(sourcePath)) throw Error('QQ 未返回表情原图保存位置');
          // QQ can still need the original after it reports the send result.
          if (!fs.existsSync(sourcePath) || !fs.readFileSync(sourcePath).equals(bytes)) {
            fs.mkdirSync(path.dirname(sourcePath), {recursive: true});
            const part = sourcePath + '.' + crypto.randomUUID() + '.tmp';
            try {
              fs.writeFileSync(part, bytes);
              fs.renameSync(part, sourcePath);
            } finally { fs.rmSync(part, {force: true}); }
          }
          elements.push({elementType: 2, elementId: '', picElement: {sourcePath, fileName, fileSize: String(bytes.length),
            picType: gif ? 2000 : png ? 1001 : webp ? 1002 : 1000, picSubType, picWidth: size.width, picHeight: size.height,
            md5HexStr, original: true, thumbPath: new Map(), summary: d.summary || '[表情]' }});
        } else throw Error('QQ 直连未支持此发送元素');
      }
      if (socket.destroyed || String(globalThis.authData?.uin) !== account) throw Error('QQ 连接已关闭');
      const delivered = new Promise((resolve, reject) => {
        slides.set(tag, {peer: p.peer, resolve, reject});
        timer = setTimeout(() => reject(Error('QQ 发送回执超时，投递结果未知')), 12000);
      });
      const [, receipt] = await Promise.all([svc.sendMsg('0', {...p.peer, guildId: tag}, elements, new Map()).then(checked), delivered]);
      return stickerFormat ? {...receipt, stickerFormat} : receipt;
    } finally {
      slides.delete(tag); clearTimeout(timer);
    }
  }
  async function perform(action, p) {
    if (String(globalThis.authData?.uin) !== account) throw Error('QQ 登录账号已切换');
    if (action === 'get_login_info') return {user_id: account, nickname: self.nickName || self.nickname || ''};
    if (action === 'poke') {
      const {peer, targetUin, aioUin} = p;
      if (!peer || ![1, 2].includes(peer.chatType) || typeof peer.peerUid !== 'string' || !peer.peerUid
        || ![targetUin, aioUin].every(id => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 9223372036854775807n)
        || (peer.chatType === 2 ? peer.peerUid !== aioUin : targetUin !== aioUin)) {
        throw Error('QQ 戳一戳目标与会话不匹配');
      }
      if (typeof svc.sendNudge !== 'function') throw Error('当前 QQ 不支持原生戳一戳');
      if (socket.destroyed) throw Error('QQ 连接已关闭，未发送戳一戳');
      // QQ takes the native contact, target QQ number, and conversation QQ
      // number. Both numbers are decimal strings in its N-API binding.
      checked(await svc.sendNudge(peer, targetUin, aioUin));
      return {accepted: true};
    }
    if (action === 'market_pack_availability') {
      const resources = await marketResources(p.packId, p.faceIds);
      return {available: p.faceIds.filter(id => resources.has(id)).length, total: p.faceIds.length};
    }
    if (action === 'history') {
      const res = p.ids ? await svc.getMsgsByMsgId(p.peer,p.ids)
        : await svc.getMsgsIncludeSelf(p.peer, p.anchor || '0', p.count, p.older);
      const rows = checked(res).msgList.filter(r => r.chatType === p.peer.chatType && r.peerUid === p.peer.peerUid);
      return Promise.all(rows.map(message));
    }
    if (action === 'fetch_message_image') return fetchMessageImage(p);
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
