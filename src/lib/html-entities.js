export function decodeBasicHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&(?:amp|#0*38|#x0*26);/gi, '&')
    .replace(/&(?:lt|#0*60|#x0*3c);/gi, '<')
    .replace(/&(?:gt|#0*62|#x0*3e);/gi, '>');
}
