export const RESPONSE_USAGE = Symbol('zen.responseUsage');

export function observeResponseUsage(response, observer) {
  if (!observer) return response;
  Object.defineProperty(response, RESPONSE_USAGE, { value: observer, configurable: true });
  for (const method of ['json', 'text']) {
    if (typeof response[method] !== 'function') continue;
    const consume = response[method].bind(response);
    response[method] = async (...args) => {
      let result;
      try { result = await consume(...args); }
      catch (error) { try { observer.failed(); } catch {} throw error; }
      try {
        observer.completed(method === 'json' ? result : JSON.parse(result));
      } catch { try { observer.unknown(); } catch {} }
      return result;
    };
  }
  return response;
}
