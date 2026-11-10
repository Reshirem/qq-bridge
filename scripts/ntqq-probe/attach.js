// Frida bootstrap. Borrow a handle only during an actual wrapper.node N-API call.
let wrapperCalls = 0;
let receivers = 0;
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
    return wrapper.path;
  },
};
