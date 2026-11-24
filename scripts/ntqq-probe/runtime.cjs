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
  const mediaDownloads = new Map(); // Only in-flight forward-media completions.
  const mediaKey = (msgId, elementId) => JSON.stringify([String(msgId), String(elementId)]);
  // Source-scoped capabilities for nodes actually returned by this QQ connection.
  // Bodies remain in QQ; these bounded entries only serve subsequent nested/media reads.
  const forwards = new Map();
  let forwardRows = 0;
  const TEMP_C2C_TYPES = new Set([100, 101, 102, 103, 104, 105, 106, 107, 108, 111, 113, 114, 115, 116, 117, 118, 119]);
  const isPrivateChat = t => t === 1 || TEMP_C2C_TYPES.has(Number(t)) || (Number.isInteger(t) && t !== 2 && Boolean(svc.IsC2CStyleChatType?.(t)));
  const isSupportedChat = t => t === 2 || isPrivateChat(t);
  const sameChatKind = (a, b) => a === b || (isPrivateChat(a) && isPrivateChat(b));
  const privateChatTypes = new Map();
  const messageId = value => typeof value === 'string' && /^-?[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
  const forwardKey = (peer, id) => JSON.stringify([peer.chatType === 2 ? 2 : 1, peer.peerUid, id]);
  const sameAccount = () => {
    if (socket.destroyed || String(globalThis.authData?.uin) !== account) throw Error('QQ 连接或登录账号已改变');
  };
  const rememberForward = (peer, id, entry) => {
    const key = forwardKey(peer, id);
    forwardRows -= forwards.get(key)?.rows.size || 0;
    forwards.delete(key); forwards.set(key, entry);
    forwardRows += entry.rows.size;
    // A root plus five bounded previews can return 606 nested references and
    // 600 rows. Keep that complete tool result usable while bounding both costs.
    while (forwards.size > 1000 || forwardRows > 1000) {
      const oldest = forwards.keys().next().value;
      forwardRows -= forwards.get(oldest).rows.size;
      forwards.delete(oldest);
    }
  };
  let listenerId;
  let buddyListenerId;
  const buddySvc = typeof receiver.getBuddyService === 'function' ? receiver.getBuddyService() : null;
  const buddyReqsByUid = new Map();
  const emittedBuddyReqFlags = new Set();
  const buddyReqWaiters = new Set();
  let pullingBuddyReqs = 0;
  let buddyReqSyncChain = Promise.resolve();
  const number = value => /^[1-9]\d*$/.test(String(value)) ? String(value) : '';
  function checked(response) {
    if (response?.result !== 0) throw Error(response?.errMsg || 'QQ 调用失败 ' + String(response?.result));
    return response;
  }
  function rememberBuddyReq(uid, entry) {
    buddyReqsByUid.delete(uid);
    buddyReqsByUid.set(uid, entry);
    while (buddyReqsByUid.size > 200) {
      buddyReqsByUid.delete(buddyReqsByUid.keys().next().value);
    }
  }
  function rememberEmittedBuddyReq(flag) {
    emittedBuddyReqFlags.add(flag);
    while (emittedBuddyReqFlags.size > 500) {
      emittedBuddyReqFlags.delete(emittedBuddyReqFlags.values().next().value);
    }
  }
  async function resolveBuddyProfiles(uids) {
    const out = new Map();
    const list = [...new Set(uids.filter(uid => typeof uid === 'string' && uid))];
    if (!list.length) return out;
    try {
      const converted = await receiver.getUixConvertService?.().getUin(list);
      if (converted?.uinInfo instanceof Map) {
        for (const uid of list) {
          const uin = number(converted.uinInfo.get(uid));
          if (uin) out.set(uid, { uin, nick: '' });
        }
      }
    } catch {}
    const unresolved = list.filter(uid => !out.get(uid)?.uin);
    if (unresolved.length && typeof receiver.getProfileService === 'function') {
      try {
        const profiles = await receiver.getProfileService().getCoreAndBaseInfo?.('nodeStore', unresolved);
        if (profiles instanceof Map) {
          for (const [uid, info] of profiles.entries()) {
            const uin = number(info?.uin) || out.get(uid)?.uin || '';
            const nick = String(info?.nick || info?.remark || out.get(uid)?.nick || '');
            if (uin || nick) out.set(uid, { uin, nick });
          }
        }
      } catch {}
    }
    return out;
  }
  async function ingestBuddyReqs(rows, { isDoubt = false, emitEvents = false } = {}) {
    const valid = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const uid = isDoubt ? r?.uid : r?.friendUid;
      if (typeof uid !== 'string' || !uid) continue;
      if (!isDoubt && (r.isDecide || r.isInitiator || r.isAgreed)) {
        buddyReqsByUid.delete(uid);
        continue;
      }
      valid.push({ row: r, uid });
    }
    if (!valid.length) return;
    const profiles = await resolveBuddyProfiles(valid.map(item => item.uid));
    if (socket.destroyed || String(globalThis.authData?.uin) !== account) return;
    for (const { row: r, uid } of valid) {
      const prof = profiles.get(uid) || { uin: '', nick: '' };
      const uin = number(r.friendUin ?? r.uin) || prof.uin || '';
      const rawReqTime = r.reqTime ?? '0';
      const reqTimeStr = String(rawReqTime).trim() || '0';
      const rawNum = Number(reqTimeStr);
      const timeSec = Number.isFinite(rawNum) && rawNum > 1e12
        ? Math.floor(rawNum / 1000)
        : (Number.isFinite(rawNum) && rawNum > 0 ? Math.floor(rawNum) : Math.floor(Date.now() / 1000));
      const flag = `${isDoubt ? 'native-doubt' : 'native'}:${uid}:${reqTimeStr}`;
      const nickname = String((isDoubt ? r.nick : r.friendNick) || prof.nick || '');
      const comment = String((isDoubt ? (r.msg || r.reason) : r.extWords) || '');
      const groupCode = number(r.groupCode) || '';
      const entry = {
        flag,
        friendUid: uid,
        rawReqTime,
        user_id: uin,
        nickname,
        comment,
        group_id: groupCode || null,
        is_doubt: Boolean(isDoubt || r.isDoubt),
        time: timeSec,
      };
      rememberBuddyReq(uid, entry);
      if (emitEvents && uin && !emittedBuddyReqFlags.has(flag)) {
        rememberEmittedBuddyReq(flag);
        send({
          event: {
            self_id: account,
            post_type: 'request',
            request_type: 'friend',
            user_id: uin,
            nickname,
            comment,
            flag,
            time: timeSec,
            ...(groupCode ? { group_id: groupCode } : {}),
            ...(entry.is_doubt ? { is_doubt: true } : {}),
          }
        });
      }
    }
  }
  function queueBuddyReqUpdate(rows, isDoubt) {
    const emitEvents = pullingBuddyReqs === 0;
    const kind = isDoubt ? 'doubt' : 'buddy';
    buddyReqSyncChain = buddyReqSyncChain
      .then(() => ingestBuddyReqs(rows, { isDoubt, emitEvents }))
      .catch(() => {})
      .finally(() => {
        for (const waiter of [...buddyReqWaiters]) {
          waiter(kind);
        }
      });
  }
  async function message(row, context = null) {
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
      else if (element.multiForwardMsgElement) {
        type = 'forward';
        data = {id: context ? `native:${context.rootId}:${row.msgId}` : `native:${row.msgId}`};
      }
      else if (element.videoElement) { type = 'video'; data = {}; }
      else if (element.fileElement) { type = 'file'; data = { name: element.fileElement.fileName }; }
      else { type = '其他消息'; data = {}; }
      if (context && (type === 'image' || type === 'mface')) {
        data.nativeForwardId = context.id;
        data.nativeMessageId = String(row.msgId);
      }
      msg.message.push({ type, data });
    }
    return msg;
  }
  const listener = new Proxy({
    async onRecvMsg(rows) {
      if (String(globalThis.authData?.uin) !== account) return socket.destroy();
      for (const r of rows || []) {
        if (!isSupportedChat(r.chatType)) continue;
        if (isPrivateChat(r.chatType) && r.peerUid) privateChatTypes.set(r.peerUid, Number(r.chatType));
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
        let receipt = slides.get(String(row.guildId)) || slides.get(String(row.msgId));
        if (!receipt && String(row.senderUin) === account) {
          const matches = [...slides.values()].filter(c => c.peer.peerUid === row.peerUid && sameChatKind(row.chatType, c.peer.chatType));
          if (matches.length === 1) receipt = matches[0];
        }
        if (!receipt || row.peerUid !== receipt.peer.peerUid || !sameChatKind(row.chatType, receipt.peer.chatType) || String(row.senderUin) !== account) continue;
        if (row.sendStatus === 0) receipt.reject(Error('QQ 报告发送失败'));
        if (row.sendStatus === 2 && (number(row.msgSeq) || (row.chatType !== 1 && row.chatType !== 2 && number(row.clientSeq)))) {
          receipt.resolve({ message_id: String(row.msgId) });
        }
      }
    },
    onRichMediaDownloadComplete(info) {
      if (String(globalThis.authData?.uin) !== account) return socket.destroy();
      if (!info?.msgId || !info.msgElementId) return;
      mediaDownloads.get(mediaKey(info.msgId, info.msgElementId))?.finish(info);
    },
  }, { get: (obj, prop) => prop in obj ? obj[prop] : typeof prop === 'string' && prop.startsWith('on') ? () => {} : undefined });
  const buddyListener = new Proxy({
    onBuddyReqChange(data) {
      if (String(globalThis.authData?.uin) !== account) return socket.destroy();
      queueBuddyReqUpdate(data?.buddyReqs, false);
    },
    onDoubtBuddyReqChange(data) {
      if (String(globalThis.authData?.uin) !== account) return socket.destroy();
      queueBuddyReqUpdate(data?.doubtList, true);
    },
  }, { get: (obj, prop) => prop in obj ? obj[prop] : typeof prop === 'string' && prop.startsWith('on') ? () => {} : undefined });
  async function findSharedGroupForUid(uid) {
    if (typeof receiver.getGroupService !== 'function') return null;
    try {
      const groups = await perform('get_group_list', {});
      for (const g of groups || []) {
        const res = await receiver.getGroupService().getAllMemberList(String(g.group_id), false).catch(() => null);
        const member = res?.result?.infos instanceof Map ? res.result.infos.get(uid) : null;
        if (member) {
          return { groupCode: String(g.group_id), nick: String(member.cardName || member.nick || g.group_name || '') };
        }
      }
    } catch {}
    return null;
  }
  async function resolvePrivatePeer(peer, { prepareForSend = false } = {}) {
    if (!peer || peer.chatType === 2 || typeof peer.peerUid !== 'string' || !peer.peerUid) return peer;
    const uid = peer.peerUid;
    const buddySvc = typeof receiver.getBuddyService === 'function' ? receiver.getBuddyService() : null;
    if (!buddySvc || typeof buddySvc.isBuddy !== 'function') return peer;
    const isBuddy = await buddySvc.isBuddy(uid);
    if (isBuddy) {
      privateChatTypes.set(uid, 1);
      return { chatType: 1, peerUid: uid };
    }
    let chatType = privateChatTypes.get(uid) || (peer.chatType !== 1 ? Number(peer.chatType) : 0);
    let groupCode = peer.groupCode ? String(peer.groupCode) : '';
    let fromNick = '';
    let sig = new Uint8Array(0);
    if (typeof svc.getTempChatInfo === 'function') {
      const info = await svc.getTempChatInfo(chatType || 100, uid).catch(() => null);
      if (info?.result === 0 && info.tmpChatInfo?.peerUid === uid) {
        chatType = Number(info.tmpChatInfo.chatType) || chatType || 100;
        if (info.tmpChatInfo.groupCode) groupCode = String(info.tmpChatInfo.groupCode);
        if (info.tmpChatInfo.fromNick) fromNick = String(info.tmpChatInfo.fromNick);
        if (info.tmpChatInfo.sig) sig = info.tmpChatInfo.sig;
      }
    }
    if ((!chatType || (prepareForSend && !groupCode)) && typeof svc.getMsgsIncludeSelf === 'function') {
      const recent = await svc.getMsgsIncludeSelf({ chatType: chatType || 1, peerUid: uid }, '0', 5, true).catch(() => null);
      for (const r of recent?.msgList || []) {
        if (!chatType && isPrivateChat(r.chatType) && r.chatType !== 1) chatType = Number(r.chatType);
        if (!groupCode) {
          const tip = (r.elements || []).find(e => e.grayTipElement?.aioOpGrayTipElement)?.grayTipElement?.aioOpGrayTipElement;
          if (tip?.fromGrpCodeOfTmpChat) groupCode = String(tip.fromGrpCodeOfTmpChat);
        }
      }
    }
    if (prepareForSend && !groupCode) {
      const shared = await findSharedGroupForUid(uid);
      if (shared) {
        groupCode = shared.groupCode;
        if (!fromNick) fromNick = shared.nick;
      }
    }
    chatType = chatType || 100;
    privateChatTypes.set(uid, chatType);
    if (prepareForSend && typeof svc.prepareTempChat === 'function' && (groupCode || sig?.length || Object.keys(sig || {}).length)) {
      const sigBytes = sig instanceof Uint8Array ? sig
        : (sig && typeof sig === 'object' ? Uint8Array.from(Object.values(sig)) : new Uint8Array(0));
      await svc.prepareTempChat({
        chatType,
        peerUid: uid,
        peerNickname: fromNick,
        fromGroupCode: String(groupCode || ''),
        sig: sigBytes,
        selfPhone: '',
        selfUid: self.uid,
        gameSession: {
          appId: '', fromRoleId: '', fromOpenId: '', toRoleId: '', toOpenId: '',
          fromTinyId: '0', toTinyId: '0', pushWindowFlag: 0, nickName: '', redpointSwitch: 0, sayHiType: 0
        }
      }).catch(() => {});
    }
    return { chatType, peerUid: uid };
  }
  async function original(peer, id) {
    const resolvedPeer = await resolvePrivatePeer(peer);
    const rows = checked(await svc.getMsgsByMsgId(resolvedPeer, [String(id)])).msgList;
    const row = rows.find(r => sameChatKind(r.chatType, resolvedPeer.chatType) && r.peerUid === resolvedPeer.peerUid && String(r.msgId) === String(id));
    if (!row) throw Error('QQ 当前会话中找不到此消息');
    return row;
  }
  function forwardReference(peer, id) {
    const parts = String(id ?? '').split(':');
    if (!peer || !isSupportedChat(peer.chatType) || typeof peer.peerUid !== 'string' || !peer.peerUid ||
      parts[0] !== 'native' || ![2,3].includes(parts.length) || !parts.slice(1).every(messageId)) {
      throw Error('QQ 转发定位无效');
    }
    return {rootId:parts[1], parentId:parts[2] || parts[1]};
  }
  async function getForwardMessage(p) {
    const {peer, id} = p;
    const {rootId, parentId} = forwardReference(peer, id);
    const known = forwards.get(forwardKey(peer, id));
    if (parentId !== rootId && !known) throw Error('QQ 嵌套转发未在此来源读取过，请先读取上层转发');
    const root = await original(peer, rootId);
    sameAccount();
    if (!(root.elements || []).some(e => e.multiForwardMsgElement)) throw Error('QQ 此消息不是合并转发');
    if (typeof svc.getMultiMsg !== 'function') throw Error('当前 QQ 未提供合并转发读取接口');
    // QQ resolves the resource on demand, including downloading an uncached
    // forward. The first root is always the real message in the verified source.
    const result = checked(await svc.getMultiMsg(peer, rootId, parentId));
    sameAccount();
    if (!Array.isArray(result.msgList) || !result.msgList.length) {
      throw Error('QQ 未返回转发内容，资源可能尚未下载或已失效，请稍后重试');
    }
    const rows = result.msgList.slice(0,100).filter(row => messageId(String(row?.msgId ?? '')));
    if (!rows.length) throw Error('QQ 返回的转发节点无效');
    const entry = {rootId, parentId, rows:new Map(rows.map(row => [String(row.msgId), {
      msgId:String(row.msgId),
      elements:(row.elements || []).filter(e => e.picElement || e.marketFaceElement).slice(0,100).map(e => ({
        elementId:e.elementId,
        ...(e.picElement ? {picElement:{md5HexStr:e.picElement.md5HexStr, picSubType:e.picElement.picSubType,
          sourcePath:e.picElement.sourcePath, fileSize:e.picElement.fileSize,
          thumbPath:new Map([[0, e.picElement.thumbPath instanceof Map ? e.picElement.thumbPath.get(0) : undefined]])}} : {}),
        ...(e.marketFaceElement ? {marketFaceElement:{emojiId:e.marketFaceElement.emojiId,
          emojiPackageId:e.marketFaceElement.emojiPackageId}} : {}),
      })),
    }]))};
    const messages = [];
    for (const row of rows) {
      if ((row.elements || []).some(e => e.multiForwardMsgElement)) {
        const nestedId = `native:${rootId}:${row.msgId}`;
        if (String(row.msgId) !== rootId && nestedId !== id) {
          const existing = forwards.get(forwardKey(peer, nestedId));
          rememberForward(peer, nestedId, existing || {rootId, parentId:String(row.msgId), rows:new Map()});
        }
      }
      messages.push(await message(row, {id,rootId}));
    }
    sameAccount();
    // Keep the currently returned page even when it contained many nested IDs.
    rememberForward(peer, id, entry);
    return {messages, total:result.msgList.length, truncated:result.msgList.length > rows.length};
  }
  function forwardImage(p) {
    forwardReference(p.peer, p.forwardId);
    const entry = forwards.get(forwardKey(p.peer, p.forwardId));
    const row = entry?.rows.get(String(p.messageId ?? ''));
    if (!row) throw Error('QQ 转发图片尚未在此来源读取，请先重新读取该转发');
    const digest = String(p.md5 ?? '').toLowerCase();
    const emojiId = String(p.emojiId ?? '').toLowerCase(), packageId = String(p.emojiPackageId ?? '');
    const hasDigest = /^[a-f0-9]{32}$/.test(digest);
    // Match the exact identity that NativeQQ will look up first. A known market
    // face must never authorize an unrelated supplied ordinary-image digest.
    const element = (row.elements || []).find(item => hasDigest
      ? item.picElement && String(item.picElement.md5HexStr).toLowerCase() === digest
      : (item.marketFaceElement && /^[a-f0-9]{16,64}$/.test(emojiId) &&
        String(item.marketFaceElement.emojiId).toLowerCase() === emojiId &&
        String(item.marketFaceElement.emojiPackageId) === packageId));
    if (!element) throw Error('QQ 此转发节点中找不到对应的图片');
    return {row, element, rootId:entry.rootId};
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
  async function fetchForwardImage(peer, rootId, element) {
    if (typeof svc.downloadRichMedia !== 'function') throw Error('当前 QQ 不支持下载合并转发内图片');
    const key = mediaKey(rootId, element.elementId);
    const previous = mediaDownloads.get(key);
    if (previous) return previous.promise;
    let finish;
    const complete = new Promise(resolve => { finish = resolve; });
    const entry = {finish, promise:null};
    mediaDownloads.set(key, entry);
    // Some QQ versions do not emit a completion here. The caller must still
    // verify the real, validated cache file after this bounded notification wait.
    const timer = setTimeout(() => finish(null), 12000);
    entry.promise = (async () => {
      try {
        // Desktop QQ addresses a forwarded image by the outer source message
        // and the inner picture element, including pictures in nested forwards.
        // The synthetic inner message ID cannot identify this download.
        const result = await svc.downloadRichMedia({
          fileModelId:'0', downSourceType:0, triggerType:0,
          msgId:rootId, chatType:peer.chatType, peerUid:peer.peerUid,
          elementId:element.elementId, thumbSize:0, downloadType:1,
          filePath:Number(element.picElement.picSubType) === 1 ? '' : element.picElement.sourcePath,
        });
        if (result?.result != null) checked(result);
        const info = await complete;
        sameAccount();
        if (info?.error) throw Error(info.error);
        const failed = code => code != null && code !== '' && String(code) !== '0';
        if (info && (failed(info.fileErrCode) || failed(info.fileSrvErrCode))) {
          const codes = [failed(info.fileErrCode) && `QQ ${info.fileErrCode}`,
            failed(info.fileSrvErrCode) && `服务端 ${info.fileSrvErrCode}`].filter(Boolean).join('，');
          throw Error(`QQ 转发图片下载失败（${codes}）${info.fileErrMsg ? '：' + String(info.fileErrMsg).slice(0,300) : ''}`);
        }
        return {requested:true};
      } finally {
        clearTimeout(timer);
        if (mediaDownloads.get(key) === entry) mediaDownloads.delete(key);
      }
    })();
    return entry.promise;
  }
  function ordinarySourcePreview(pic, root, digest) {
    const {sourcePath, picWidth:width, picHeight:height} = pic;
    if (![0, '0'].includes(pic.picSubType) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width > 32768 || height > 32768 || width * height > 64_000_000 ||
        typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return null;
    const relative = path.relative(root, sourcePath).split(path.sep).join('/');
    if (!new RegExp(`^Pic/[0-9]{4}-(?:0[1-9]|1[0-2])/Ori/${digest}\\.[a-z0-9]+$`, 'i').test(relative)) return null;
    let real;
    try {
      real = fs.realpathSync(sourcePath);
      if (path.relative(sourcePath, real) === '' && fs.statSync(real).isFile()) {
        return {path:real, width, height};
      }
    } catch (error) {
      // QQ writes some files after acknowledging the download. The reader
      // repeats the realpath and file checks on each poll before opening one.
      if (real === undefined && error.code === 'ENOENT') return {path:sourcePath, width, height};
    }
    return null;
  }
  async function fetchMessageImage(p) {
    if (p.quality !== undefined && !['preview','original'].includes(p.quality)) throw Error('图片 quality 必须是 preview 或 original');
    const peer = p.peer;
    const messageId = String(p.messageId ?? '');
    if (!peer || !isSupportedChat(Number(peer.chatType)) || !peer.peerUid ||
        !/^-?[1-9]\d{0,19}$/.test(messageId)) throw Error('QQ 图片定位信息无效');
    const digest = String(p.md5 ?? '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(digest)) throw Error('QQ 图片标识无效');
    const verified = p.forwardId ? forwardImage(p) : null;
    const row = verified?.row || await original(peer, messageId);
    const element = verified?.element || (row.elements || []).find(item => item.picElement &&
      String(item.picElement.md5HexStr).toLowerCase() === digest);
    sameAccount();
    if (!element?.elementId) throw Error('QQ 原消息中找不到对应的图片元素');
    const root = path.join(os.homedir(), 'Documents', 'Tencent Files', account, 'nt_qq', 'nt_data');
    const target = element.picElement.sourcePath;
    const relative = typeof target === 'string' && path.isAbsolute(target) ? path.relative(root, target) : '..';
    const sticker = Number(element.picElement.picSubType) === 1;
    // QQ can store a converted JPEG in Ori under the source PNG's digest.
    // Prefer the exact native element's thumbnail mapping when available.
    let verifiedPreviewPath;
    if (p.quality !== 'original') {
      const thumbnail = element.picElement.thumbPath instanceof Map ? element.picElement.thumbPath.get(0) : null;
      const validPreviewPath = value => {
        if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
        const rel = path.relative(root, value).split(path.sep).join('/');
        return new RegExp(`^(?:Pic|Emoji/emoji-recv)/[0-9]{4}-[0-9]{2}/(?:Ori|Thumb)/${digest}(?:_[0-9]+)?\\.[a-z0-9]+$`, 'i').test(rel);
      };
      if (validPreviewPath(thumbnail)) {
        try {
          const real = fs.realpathSync(thumbnail);
          if (validPreviewPath(real) && fs.statSync(real).isFile()) {
            sameAccount();
            return {requested:false, verifiedPreviewPath:real};
          }
        } catch (error) {
          // QQ may populate this exact native destination asynchronously. The
          // reader repeats realpath, identity, byte and pixel checks on use.
          if (error.code === 'ENOENT') verifiedPreviewPath = thumbnail;
        }
      }
    }
    if (!sticker && (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) {
      throw Error('QQ 返回的图片缓存位置无效');
    }
    if (verified) {
      const result = await fetchForwardImage(peer, verified.rootId, element);
      return {...result, ...(verifiedPreviewPath ? {verifiedPreviewPath} : {})};
    }
    if (typeof svc.getRichMediaElement !== 'function') throw Error('当前 QQ 不支持按原消息下载图片');
    const result = await svc.getRichMediaElement({
      downSourceType: 1,
      msgId: String(row.msgId),
      peerUid: String(peer.peerUid), chatType: Number(row.chatType || peer.chatType),
      elementId: String(element.elementId), downloadType: 1,
      // Ordinary images need QQ's original destination; stickers choose their own cache.
      ...(sticker ? {} : {thumbSize: 0, filePath: target}),
    });
    if (result?.result != null) checked(result);
    sameAccount();
    // Submit the normal download even when QQ has a converted source candidate.
    // The reader validates its decoded dimensions before accepting a preview.
    const verifiedSourcePreview = p.quality !== 'original' && ordinarySourcePreview(element.picElement, root, digest);
    return {requested:true, ...(verifiedPreviewPath ? {verifiedPreviewPath} : {}),
      ...(verifiedSourcePreview ? {verifiedSourcePreview} : {})};
  }

  async function sendMessage(p) {
    const peer = await resolvePrivatePeer(p.peer, { prepareForSend: true });
    const elements = [];
    let stickerFormat;
    const tag = String(svc.generateMsgUniqueId(peer.chatType, String(Date.now())));
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
          const row = await original(peer, d.id);
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
        slides.set(tag, {peer, resolve, reject});
        timer = setTimeout(() => reject(Error('QQ 发送回执超时，投递结果未知')), 12000);
      });
      const [, receipt] = await Promise.all([svc.sendMsg('0', {...peer, guildId: tag}, elements, new Map()).then(checked), delivered]);
      return stickerFormat ? {...receipt, stickerFormat} : receipt;
    } finally {
      slides.delete(tag); clearTimeout(timer);
    }
  }
  async function perform(action, p) {
    if (String(globalThis.authData?.uin) !== account) throw Error('QQ 登录账号已切换');
    if (action === 'get_login_info') return {user_id: account, nickname: self.nickName || self.nickname || ''};
    if (action === 'get_forward_msg') return getForwardMessage(p);
    if (action === 'check_forward_image') { forwardImage(p); return {verified:true}; }
    if (action === 'poke') {
      const {peer, targetUin, aioUin} = p;
      if (!peer || !isSupportedChat(peer.chatType) || typeof peer.peerUid !== 'string' || !peer.peerUid
        || ![targetUin, aioUin].every(id => typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 9223372036854775807n)
        || (peer.chatType === 2 ? peer.peerUid !== aioUin : targetUin !== aioUin)) {
        throw Error('QQ 戳一戳目标与会话不匹配');
      }
      if (typeof svc.sendNudge !== 'function') throw Error('当前 QQ 不支持原生戳一戳');
      if (socket.destroyed) throw Error('QQ 连接已关闭，未发送戳一戳');
      const resolvedPeer = await resolvePrivatePeer(peer);
      if (socket.destroyed || String(globalThis.authData?.uin) !== account) throw Error('QQ 连接已关闭，未发送戳一戳');
      // QQ takes the native contact, target QQ number, and conversation QQ
      // number. Both numbers are decimal strings in its N-API binding.
      checked(await svc.sendNudge(resolvedPeer, targetUin, aioUin));
      return {accepted: true};
    }
    if (action === 'market_pack_availability') {
      const resources = await marketResources(p.packId, p.faceIds);
      return {available: p.faceIds.filter(id => resources.has(id)).length, total: p.faceIds.length};
    }
    if (action === 'history') {
      const peer = await resolvePrivatePeer(p.peer);
      const res = p.ids ? await svc.getMsgsByMsgId(peer,p.ids)
        : await svc.getMsgsIncludeSelf(peer, p.anchor || '0', p.count, p.older);
      const rows = checked(res).msgList.filter(r => sameChatKind(r.chatType, peer.chatType) && r.peerUid === peer.peerUid);
      return Promise.all(rows.map(message));
    }
    if (action === 'fetch_message_image') return fetchMessageImage(p);
    if (action === 'resolveUid') {
      const map = await receiver.getUixConvertService?.().getUid([p.uin]);
      const uid = map?.uidInfo?.get(p.uin) || '';
      if (uid) return uid;
      if (typeof receiver.getGroupService === 'function') {
        const groups = await perform('get_group_list', {}).catch(() => []);
        for (const g of groups || []) {
          const res = await receiver.getGroupService().getAllMemberList(String(g.group_id), false).catch(() => null);
          if (res?.result?.infos instanceof Map) {
            for (const m of res.result.infos.values()) {
              if (String(m.uin) === String(p.uin) && m.uid) return m.uid;
            }
          }
        }
      }
      return '';
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
    if (action === 'get_friend_requests') {
      if (!buddySvc || typeof buddySvc.getBuddyReq !== 'function') throw Error('当前 QQ 未提供好友申请查询接口');
      pullingBuddyReqs += 1;
      let timer;
      let graceTimer;
      let waiter;
      try {
        let gotBuddy = false;
        let gotDoubt = typeof buddySvc.getDoubtBuddyReq !== 'function';
        const waitForChange = new Promise((resolve) => {
          const finish = () => {
            if (waiter) buddyReqWaiters.delete(waiter);
            clearTimeout(graceTimer);
            resolve();
          };
          waiter = (kind) => {
            if (kind === 'buddy') gotBuddy = true;
            if (kind === 'doubt') gotDoubt = true;
            if (gotBuddy && gotDoubt) finish();
            else if (!graceTimer) graceTimer = setTimeout(finish, 250);
          };
          buddyReqWaiters.add(waiter);
          timer = setTimeout(finish, 1000);
        });
        checked(await buddySvc.getBuddyReq());
        if (typeof buddySvc.getDoubtBuddyReq === 'function') {
          await buddySvc.getDoubtBuddyReq('', 50, '').catch(() => {});
        }
        await waitForChange;
        await buddyReqSyncChain;
        sameAccount();
        return [...buddyReqsByUid.values()].filter(item => item.user_id && item.flag).map(item => ({
          flag: item.flag,
          user_id: item.user_id,
          nickname: item.nickname,
          comment: item.comment,
          ...(item.group_id ? { group_id: item.group_id } : {}),
          ...(item.is_doubt ? { is_doubt: true } : {}),
          time: item.time,
        }));
      } finally {
        if (waiter) buddyReqWaiters.delete(waiter);
        clearTimeout(graceTimer);
        clearTimeout(timer);
        pullingBuddyReqs = Math.max(0, pullingBuddyReqs - 1);
      }
    }
    if (action === 'set_friend_add_request') {
      if (!buddySvc) throw Error('当前 QQ 未提供好友申请处理接口');
      const approve = Boolean(p.approve);
      const rawFlag = String(p.flag ?? '').trim();
      const targetUserId = number(p.user_id);
      let entry = null;
      const flagMatch = /^native(-doubt)?:([^:]+):(.+)$/.exec(rawFlag);
      if (flagMatch) {
        const uidFromFlag = flagMatch[2];
        const cached = buddyReqsByUid.get(uidFromFlag);
        entry = cached && cached.flag === rawFlag ? cached : {
          flag: rawFlag,
          friendUid: uidFromFlag,
          rawReqTime: flagMatch[3],
          user_id: cached?.user_id || targetUserId || '',
          group_id: cached?.group_id || null,
          is_doubt: flagMatch[1] === '-doubt',
        };
      } else if (targetUserId) {
        entry = [...buddyReqsByUid.values()].find(item => item.user_id === targetUserId) || null;
        if (!entry) {
          await perform('get_friend_requests', {});
          entry = [...buddyReqsByUid.values()].find(item => item.user_id === targetUserId) || null;
        }
      }
      if (!entry?.friendUid) throw Error('QQ 找不到对应的待处理好友申请');
      sameAccount();
      const remark = approve && p.remark ? String(p.remark).trim() : '';
      if (entry.is_doubt) {
        if (approve) {
          if (typeof buddySvc.approvalDoubtBuddyReq !== 'function') throw Error('当前 QQ 不支持同意疑问好友申请');
          checked(await buddySvc.approvalDoubtBuddyReq(entry.friendUid, entry.group_id ? String(entry.group_id) : undefined, remark || undefined));
        } else if (typeof buddySvc.delDoubtBuddyReq === 'function') {
          checked(await buddySvc.delDoubtBuddyReq(entry.friendUid));
        } else {
          throw Error('当前 QQ 不支持拒绝疑问好友申请');
        }
      } else {
        if (typeof buddySvc.approvalFriendRequest !== 'function') throw Error('当前 QQ 不支持处理好友申请');
        checked(await buddySvc.approvalFriendRequest({
          friendUid: entry.friendUid,
          accept: approve,
          refuseMsg: approve ? '' : String(p.reason ?? ''),
          reqTime: String(entry.rawReqTime ?? '0'),
        }));
      }
      sameAccount();
      if (approve) {
        privateChatTypes.set(entry.friendUid, 1);
        if (remark && typeof buddySvc.setBuddyRemark === 'function') {
          await buddySvc.setBuddyRemark({ uid: entry.friendUid, remark }).then(res => { if (res?.result != null) checked(res); });
        }
      }
      buddyReqsByUid.delete(entry.friendUid);
      return {
        flag: entry.flag,
        user_id: entry.user_id || targetUserId || '',
        approve,
        ...(remark ? { remark } : {}),
      };
    }
    if (action === 'set_friend_remark') {
      if (!buddySvc || typeof buddySvc.setBuddyRemark !== 'function') throw Error('当前 QQ 不支持设置好友备注');
      const uin = number(p.user_id);
      if (!uin) throw Error('QQ 号无效');
      const uid = await perform('resolveUid', { uin });
      if (!uid) throw Error('QQ 无法解析此账号的 NT UID');
      sameAccount();
      checked(await buddySvc.setBuddyRemark({ uid, remark: String(p.remark ?? '') }));
      return { user_id: uin, remark: String(p.remark ?? '') };
    }
    throw Error('QQ 独立通道尚不支持 ' + action);
  }
  socket.once('connect', () => {
    try {
      listenerId = svc.addKernelMsgListener(listener);
      try {
        if (typeof buddySvc?.addKernelBuddyListener === 'function') {
          buddyListenerId = buddySvc.addKernelBuddyListener(buddyListener);
        }
      } catch {}
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
    if (buddyListenerId != null && typeof buddySvc?.removeKernelBuddyListener === 'function') {
      try { buddySvc.removeKernelBuddyListener(String(buddyListenerId)); } catch {}
    }
    for (const receipt of slides.values()) receipt.reject(Error('QQ 通道已断开，投递结果未知'));
    for (const download of mediaDownloads.values()) download.finish({error:'QQ 通道已断开，图片下载结果未知'});
    mediaDownloads.clear();
  });
};
