// Подменяет supabase-js в браузере во время тестов.
// Все вызовы уходят в тестовый процесс через window.__sb (exposeBinding),
// где их обрабатывает FakeBackend — общий для всех вкладок-игроков.
(() => {
  const call = (op, args) => window.__sb(op, args);
  const subs = new Set();

  window.__rtPush = (code, data) => {
    for (const ch of subs) {
      if (ch.name !== 'room:' + code) continue;
      for (const h of ch.handlers) h.cb({ new: { code, data } });
    }
  };

  function createClient() {
    return {
      from(table) {
        const filters = {};
        const b = {
          upsert: row => call('upsert', { table, row }),
          select() { return b; },
          eq(col, val) { filters[col] = val; return b; },
          maybeSingle: () => call('select', { table, filters }),
        };
        return b;
      },
      rpc: (name, args) => call('rpc', { name, args }),
      channel(name) {
        const ch = {
          name, handlers: [],
          on(type, filter, cb) { ch.handlers.push({ filter, cb }); return ch; },
          subscribe() { subs.add(ch); call('subscribe', { name }); return ch; },
        };
        return ch;
      },
      removeChannel(ch) { subs.delete(ch); },
    };
  }

  window.supabase = { createClient };
})();
