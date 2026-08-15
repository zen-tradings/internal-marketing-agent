let activeConfig;
let activeResourceGovernor;

export function installRuntimeConfig(config) {
  activeConfig = config;
  return config;
}

export function runtimeConfig() {
  return activeConfig;
}

export function installResourceGovernor(governor) {
  activeResourceGovernor = governor;
  return governor;
}

export function resourceGovernor() {
  return activeResourceGovernor;
}

export function withRuntimeResource(name, fn, signal) {
  return activeResourceGovernor ? activeResourceGovernor.run(name, fn, signal) : fn();
}

export function acquireRuntimeResource(name, signal) {
  return activeResourceGovernor ? activeResourceGovernor.acquire(name, signal) : Promise.resolve(() => {});
}

export function runtimeFetch(fetchFn = globalThis.fetch) {
  if (!activeResourceGovernor || fetchFn !== globalThis.fetch) return fetchFn;
  return activeResourceGovernor.fetch;
}
