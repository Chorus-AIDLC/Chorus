// Process-local capabilities: never serialized into execution snapshots.
const hooks = new WeakMap();

export function registerProcessStopHook(child, hook) {
  hooks.set(child, hook);
  return () => {
    if (hooks.get(child) === hook) hooks.delete(child);
  };
}

export function getProcessStopHook(child) {
  return child && hooks.get(child);
}
