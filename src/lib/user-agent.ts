/** Derive a short device label from User-Agent (mobile clients often send this). */
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  const ua = (userAgent ?? "").trim();
  if (!ua) return "Unknown device";

  const lower = ua.toLowerCase();
  if (/iphone|ipad|ipod/.test(lower)) {
    const model = ua.match(/iPhone|iPad|iPod[^;)]*/i)?.[0];
    return model ?? "Apple device";
  }
  if (/android/.test(lower)) {
    const model = ua.match(/;\s*([^;)]+)\s+Build\//)?.[1]?.trim();
    return model ? `Android · ${model}` : "Android device";
  }
  if (/windows/.test(lower)) return "Windows";
  if (/macintosh|mac os x/.test(lower)) return "Mac";
  if (/linux/.test(lower)) return "Linux";

  if (ua.length <= 48) return ua;
  return `${ua.slice(0, 45)}…`;
}
