let activeConfig;

export function installRuntimeConfig(config) {
  activeConfig = config;
  return config;
}

export function runtimeConfig() {
  return activeConfig;
}
