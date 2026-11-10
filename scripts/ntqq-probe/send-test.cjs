// Called only for the operator's explicit send-test command.
module.exports = function sendTest(receiver, directory, options) {
  const load = name => process.getBuiltinModule(name);
  const fs = load('fs');
  const path = load('path');
  const crypto = load('crypto');
  const peer = { chatType: 1, peerUid: options.uid };
  const state = { action: options.action, target: options.uin, status: 'checking' };
  const receiptFile = path.join(options.journal, options.action + '.receipt.json');
  const output = path.join(directory, 'result.json');
  let service, listenerId, tag;
  let closed = false;
  function finish(status, error) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (listenerId != null) {
      try { service.removeKernelMsgListener(String(listenerId)); } catch { state.cleanupError = true; }
    }
    state.status = status;
    if (error) state.error = String(error.message || error).slice(0, 240);
    state.done = true;
    try {
      if (state.attempted) fs.writeFileSync(receiptFile, JSON.stringify(state), { flush: true });
      fs.writeFileSync(output + '.tmp', JSON.stringify(state));
      fs.renameSync(output + '.tmp', output);
    } catch { /* The durable attempt marker still prevents a second submission. */ }
  }
  const timer = setTimeout(() => finish(state.attempted ? 'unknown' : 'failed', 'timed out'), 35000);
  timer.unref?.();
  function confirmed() {
    if (state.submission === 0 && state.sendStatus === 2 &&
        /^-?[1-9]\d*$/.test(state.msgId) && /^[1-9]\d*$/.test(state.msgSeq)) {
      finish('confirmed');
    }
  }
  function onMsgInfoListUpdate(rows) {
    if (closed || !tag || !Array.isArray(rows)) return;
    for (const row of rows) {
      if (Number(row.chatType) !== 1 || row.peerUid !== peer.peerUid ||
          String(row.senderUin) !== state.account ||
          (String(row.guildId) !== tag && String(row.msgId) !== tag)) continue;
      state.msgId = String(row.msgId);
      state.msgSeq = String(row.msgSeq ?? '');
      state.sendStatus = row.sendStatus;
      if (row.sendStatus === 0) return finish('failed', 'QQ reported send failure');
      confirmed();
    }
  }
  async function favorite() {
    const page = await service.fetchFavEmojiList('', 20, true, false);
    if (page?.result !== 0 || !Array.isArray(page.emojiInfoList)) throw Error('failed to read QQ favorites');
    state.favorites = [];
    for (const item of page.emojiInfoList) {
      const md5 = String(item.md5).toLowerCase();
      state.favorites.push(md5);
      if (!/^[a-f0-9]{32}$/.test(md5)) continue;
      for (const file of [options.original, item.emoOriginalPath, item.emoPath, item.thumbPath]) {
        if (!file || !path.isAbsolute(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
        const data = fs.readFileSync(file);
        if (data.length < 12 || crypto.createHash('md5').update(data).digest('hex') !== md5) continue;
        let picType, size;
        if (/^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) {
          picType = 2000;
          size = { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
        } else {
          if (data.readUInt32BE(0) === 0x89504e47) picType = 1001;
          else if (data.readUInt16BE(0) === 0xffd8) picType = 1000;
          else if (data.toString('ascii', 8, 12) === 'WEBP') picType = 1002;
          else continue;
          size = process.mainModule.require('electron').nativeImage.createFromBuffer(data).getSize();
        }
        if (!size.width || !size.height) continue;
        state.sticker = { md5, bytes: data.length, ...size, picType };
        return { elementType: 2, elementId: '', picElement: {
          picType, picSubType: 1, sourcePath: file, fileName: path.basename(file),
          fileSize: String(data.length), md5HexStr: md5, picWidth: size.width, picHeight: size.height,
          original: true, thumbPath: new Map(), summary: '[动画表情]',
        } };
      }
    }
    return null;
  }
  setImmediate(async () => {
    try {
      service = typeof receiver.fetchFavEmojiList === 'function' ? receiver : receiver.getMsgService();
      state.account = String(globalThis.authData?.uin || '');
      if (!/^[1-9]\d+$/.test(state.account) || (options.owner && options.owner !== state.account)) throw Error('login mismatch');
      const sample = await service.getMsgsByMsgId(peer, [options.sampleId]);
      const verified = sample?.result === 0 && sample.msgList?.some(row =>
        String(row.msgId) === options.sampleId && Number(row.chatType) === 1 && row.peerUid === options.uid &&
        (String(row.peerUin) === options.uin || (row.senderUid === options.uid && String(row.senderUin) === options.uin)));
      if (!verified) throw Error('QQ could not verify target number and UID from the private sample');
      state.targetVerified = true;
      let element;
      if (options.action === 'text') {
        element = { elementType: 1, elementId: '', textElement: {
          content: 'qq-bridge 直连测试：这是一条文字消息，无需回复。', atType: 0, atUid: '', atTinyId: '', atNtUid: '',
        } };
      } else {
        element = await favorite();
      }
      if (closed) return;
      if (options.action === 'check') return finish('ready');
      if (!element) throw Error('no matching original for the current QQ favorites');
      // Private chat has no guild. QQ echoes this per-send correlation value on status events.
      tag = String(service.generateMsgUniqueId(1, String(Date.now())));
      if (!/^[1-9]\d*$/.test(tag)) throw Error('could not generate correlation ID');
      const listener = new Proxy({ onMsgInfoListUpdate }, {
        get(target, key) {
          if (key in target) return target[key];
          if (typeof key === 'string' && key.startsWith('on')) return () => {};
        },
      });
      listenerId = service.addKernelMsgListener(listener);
      if (typeof listenerId !== 'number' && typeof listenerId !== 'string') throw Error('could not install receipt listener');
      if (!fs.existsSync(directory) || String(globalThis.authData?.uin) !== state.account) throw Error('session ended');
      fs.writeFileSync(path.join(options.journal, options.action + '.attempt.json'),
        JSON.stringify({ account: state.account, target: options.uin, uid: options.uid, tag,
          at: new Date().toISOString(), action: options.action, md5: state.sticker?.md5 }), { flag: 'wx', flush: true });
      state.attempted = true;
      state.tag = tag;
      const reply = await service.sendMsg('0', { ...peer, guildId: tag }, [element], new Map());
      if (closed) return;
      state.submission = reply?.result;
      if (Number.isInteger(state.submission) && state.submission !== 0) return finish('rejected', 'QQ rejected submission');
      confirmed();
    } catch (error) { finish(state.attempted ? 'unknown' : 'failed', error); }
  });
};
