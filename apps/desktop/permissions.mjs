// The one browser permission the page gets: the microphone, for voice input. What it hears is recognised inside
// this process and never leaves the PC. Everything else (camera, screen, location, notifications ...) stays refused,
// and so does the microphone for any page that is not our own local UI.

/** @param {Electron.Session} session  @param {string} origin  the origin of our own UI, e.g. http://127.0.0.1:4780 */
export function allowMicrophoneOnly(session, origin) {
  const ours = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  session.setPermissionRequestHandler((wc, permission, allow, details) =>
    allow(permission === 'media' && ours(details?.requestingUrl ?? wc?.getURL() ?? '') && (details?.mediaTypes ?? []).length > 0 && details.mediaTypes.every((t) => t === 'audio')));
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    permission === 'media' && ours(requestingOrigin) && details?.mediaType === 'audio');
}
