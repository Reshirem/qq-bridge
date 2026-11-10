// Runs in the QQ main process. Keep the entry self-contained for the N-API loader.
module.exports = function observe(receiver, directory, seconds) {
  const load = name => typeof process.getBuiltinModule === 'function'
    ? process.getBuiltinModule(name) : process.mainModule.require(name);
  const fs = load('fs');
  const path = load('path');
  if (typeof receiver.fetchFavEmojiList !== 'function' && typeof receiver.getMsgService !== 'function') {
    setImmediate(() => {
      // An idle client may only be calling its miscellaneous service. Ask its
      // own chat window for its first page so the message service is exercised.
      const diagnostic = path.join(directory, 'lookup.json');
      let status = 'main chat window unavailable';
      try {
        const { ipcMain, webContents } = process.mainModule.require('electron');
        const view = webContents.getAllWebContents().find(w => {
          const url = new URL(w.getURL() || 'about:blank');
          return url.protocol === 'app:' && url.hash.split('?')[0] === '#/main/message';
        });
        if (view && fs.existsSync(directory)) {
          const id = view.id;
          const meta = { peerId: id, callbackId: load('crypto').randomUUID(), type: 'request', eventName: 'ntApi' };
          const request = { cmdName: 'nodeIKernelMsgService/fetchFavEmojiList', cmdType: 'invoke', payload: ['', 20, true, true] };
          const channel = `RM_IPCFROM_RENDERER${id}`;
          const event = { sender: view, senderFrame: view.mainFrame, reply: (...args) => view.send(...args) };
          status = ipcMain.emit(channel, event, meta, request) ? 'requested' : 'no IPC handler';
        }
      } catch {
        status = 'renderer call failed';
      }
      if (fs.existsSync(directory)) {
        try { fs.writeFileSync(diagnostic, JSON.stringify(status)); } catch {}
      }
    });
    return;
  }
  const output = path.join(directory, 'result.json');
  const state = { pid: process.pid, received: 0, incoming: 0, favorites: { status: 'pending' }, listener: 'pending' };
  const publish = () => {
    try {
      fs.writeFileSync(output + '.tmp', JSON.stringify(state));
      fs.renameSync(output + '.tmp', output);
    } catch {
      // The CLI may already have closed its temporary directory.
    }
  };
  function onRecvMsg(messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    state.received += messages.length;
    for (const message of messages) {
      const self = globalThis.authData;
      const sender = String(message?.senderUin || '');
      const identified = self?.uin && /^[1-9]\d+$/.test(sender);
      const incoming = identified ? sender !== String(self.uin) :
        Boolean(self?.uid && message?.senderUid && self.uid !== message.senderUid);
      if (incoming) {
        state.incoming++;
        state.lastChatType = Number(message.chatType) || null;
      }
    }
  }
  // QQ also dispatches unrelated notifications to the same listener object.
  const listener = new Proxy({ onRecvMsg }, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && /^on[A-Z]/.test(key)) return () => {};
    },
  });
  let service;
  let id;
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    if (id != null) {
      try {
        service.removeKernelMsgListener(String(id));
        state.listener = 'removed';
      } catch {
        state.listener = 'remove_failed';
      }
    }
    state.done = true;
    if (fs.existsSync(directory)) publish();
  }
  const end = Date.now() + seconds * 1000;
  const timer = setInterval(() => {
    if (Date.now() >= end || !fs.existsSync(directory) ||
        (state.incoming && state.favorites.status === 'ok')) return finish();
  }, 500);
  timer.unref?.();
  // Allow the observed QQ native call to return before using its receiver.
  setImmediate(() => {
    if (finished) return;
    try {
      service = typeof receiver.fetchFavEmojiList === 'function' ? receiver : receiver.getMsgService();
      if (!service || typeof service.removeKernelMsgListener !== 'function') throw Error();
      id = service.addKernelMsgListener(listener);
      if (typeof id !== 'string' && typeof id !== 'number') throw Error();
      state.listener = 'registered';
      state.startedAt = new Date().toISOString();
    } catch {
      state.listener = 'unavailable';
      finish();
      return;
    }
    const uin = String(globalThis.authData?.uin ?? '');
    if (/^[1-9]\d{4,}$/.test(uin)) state.account = uin;
    publish();
    Promise.resolve().then(() => service.fetchFavEmojiList('', 20, true, false)).then(reply => {
      if (finished) return;
      if (reply?.result !== 0 || !Array.isArray(reply.emojiInfoList)) {
        state.favorites = { status: 'invalid_reply', code: Number.isInteger(reply?.result) ? reply.result : null };
        return;
      }
      state.favorites = { status: 'ok', items: reply.emojiInfoList.slice(0, 20).map(item => ({
        emojiId: String(item?.emoId ?? ''), resourceId: String(item?.resId ?? ''),
        md5: String(item?.md5 ?? ''),
      })) };
    }).catch(() => { if (!finished) state.favorites = { status: 'failed' }; })
      .finally(() => { if (!finished) publish(); });
  });
};
