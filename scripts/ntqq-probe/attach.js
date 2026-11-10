// Frida bootstrap. Borrow a handle only during an actual wrapper.node N-API call.
let wrapperCalls = 0;
let receivers = 0;
// On an idle desktop QQ there may be no N-API calls at all. Run the existing
// read-only renderer request once on Electron's own main Node loop. Use public
// exported functions, never retain a V8 handle outside its originating scope.
function requestIdleService(qq, source, alreadyRequested, markRequested) {
  const bind = (name, args, returns = 'pointer') =>
    new NativeFunction(qq.getExportByName(name), returns, args, { traps: 'none' });
  const defaultLoop = bind('uv_default_loop', [])();
  const isolate = bind('?TryGetCurrent@Isolate@v8@@SAPEAV12@XZ', []);
  const open = bind('??0HandleScope@v8@@QEAA@PEAVIsolate@1@@Z', ['pointer', 'pointer'], 'void');
  const close = bind('??1HandleScope@v8@@QEAA@XZ', ['pointer'], 'void');
  const context = bind('?GetCurrentContext@Isolate@v8@@QEAA?AV?$Local@VContext@v8@@@2@XZ', ['pointer', 'pointer']);
  const environment = bind('?GetCurrentEnvironment@node@@YAPEAVEnvironment@1@V?$Local@VContext@v8@@@v8@@@Z', ['pointer']);
  const string = bind('?NewFromUtf8@String@v8@@SA?AV?$MaybeLocal@VString@v8@@@2@PEAVIsolate@2@PEBDW4NewStringType@2@H@Z',
    ['pointer', 'pointer', 'pointer', 'int', 'int']);
  const compile = bind('?Compile@Script@v8@@SA?AV?$MaybeLocal@VScript@v8@@@2@V?$Local@VContext@v8@@@2@V?$Local@VString@v8@@@2@PEAVScriptOrigin@2@@Z',
    ['pointer', 'pointer', 'pointer', 'pointer']);
  const run = bind('?Run@Script@v8@@QEAA?AV?$MaybeLocal@VValue@v8@@@2@V?$Local@VContext@v8@@@2@@Z',
    ['pointer', 'pointer', 'pointer']);
  const program = Memory.allocUtf8String('try { (' + source + ')(globalThis); } catch {}');
  const loopHook = Interceptor.attach(qq.getExportByName('uv_run'), {
    onEnter(args) {
      if (alreadyRequested() || !defaultLoop.equals(args[0])) return;
      const current = isolate();
      if (current.isNull()) return;
      const scope = Memory.alloc(128), slot = Memory.alloc(Process.pointerSize);
      open(scope, current);
      try {
        context(current, slot);
        const ctx = slot.readPointer();
        if (ctx.isNull() || environment(ctx).isNull()) return;
        markRequested();
        string(slot, current, program, 0, -1);
        const code = slot.readPointer();
        if (code.isNull()) return;
        compile(slot, ctx, code, ptr(0));
        const script = slot.readPointer();
        if (!script.isNull()) run(script, slot, ctx);
      } finally {
        close(scope);
        if (alreadyRequested()) setImmediate(() => loopHook.detach());
      }
    },
  });
}
rpc.exports = {
  counts() { return { wrapperCalls, receivers }; },
  start(source, byteLength) {
    const qq = Process.getModuleByName('QQNT.dll');
    const wrapper = Process.getModuleByName('wrapper.node');
    const end = wrapper.base.add(wrapper.size);
    const nil = ptr(0);
    const native = (name, args) => new NativeFunction(qq.getExportByName(name), 'int', args, { traps: 'none' });
    const has = native('napi_has_named_property', ['pointer', 'pointer', 'pointer', 'pointer']);
    const pending = native('napi_is_exception_pending', ['pointer', 'pointer']);
    const clear = native('napi_get_and_clear_last_exception', ['pointer', 'pointer']);
    const string = native('napi_create_string_utf8', ['pointer', 'pointer', 'size_t', 'pointer']);
    const evaluate = native('napi_run_script', ['pointer', 'pointer', 'pointer']);
    const call = native('napi_call_function', ['pointer', 'pointer', 'pointer', 'size_t', 'pointer', 'pointer']);
    const text = Memory.allocUtf8String(source);
    const methods = ['fetchFavEmojiList', 'getMsgService'].map(name => Memory.allocUtf8String(name));
    let used = false;
    let requested = false;
    const hook = Interceptor.attach(qq.getExportByName('napi_get_cb_info'), {
      onEnter(args) {
        if (used || this.returnAddress.compare(wrapper.base) < 0 || this.returnAddress.compare(end) >= 0) return;
        wrapperCalls++;
        this.env = args[0];
        this.receiver = args[4];
      },
      onLeave(result) {
        if (used || !this.env || this.receiver.isNull() || result.toInt32() !== 0) return;
        const receiver = this.receiver.readPointer();
        if (receiver.isNull()) return;
        receivers++;
        const flag = Memory.alloc(1);
        if (pending(this.env, flag) || flag.readU8()) return;
        const slot = Memory.alloc(Process.pointerSize);
        const ok = status => {
          if (status === 0) return;
          if (pending(this.env, flag) === 0 && flag.readU8()) clear(this.env, slot);
          throw new Error('N-API status ' + status);
        };
        try {
          const service = methods.some(name => {
            ok(has(this.env, receiver, name, flag));
            return flag.readU8() !== 0;
          });
          if (!service && requested) return;
          requested = true;
          used = service;
          ok(string(this.env, text, byteLength, slot));
          ok(evaluate(this.env, slot.readPointer(), slot));
          ok(call(this.env, receiver, slot.readPointer(), 1, this.receiver, nil));
          if (service) send({ stage: 'attached' });
        } catch (error) {
          used = true;
          send({ stage: 'failed', reason: String(error.message) });
        } finally {
          if (used) setImmediate(() => hook.detach());
        }
      },
    });
    // Other QQ builds can still attach on their next ordinary wrapper call
    // if Electron does not export the optional idle bootstrap entry points.
    try { requestIdleService(qq, source, () => requested, () => { requested = true; }); } catch {}
    return wrapper.path;
  },
};
