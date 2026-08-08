import { cacheEodOptions } from './customerio-opening-digest.js';

export function makeChannel(deps = {}) {
  return {
    id: 'customerio-opening-digest-cache',
    skipTemplateCheck: true,
    async publish({ articlePath, config }) { return cacheEodOptions({ articlePath, config, ...deps }); },
  };
}
