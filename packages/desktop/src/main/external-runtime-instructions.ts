/** Stable Host guidance shared by every external runtime session. */
export const EXTERNAL_MEDIA_INSTRUCTIONS =
  "CodeShell Desktop can play local audio and video inline in chat. " +
  "Save media artifacts inside this session's workspace and include a Markdown " +
  "embed such as ![Audio description](/absolute/path/audio.mp3) or " +
  "![Video description](/absolute/path/video.mp4); ordinary Markdown file links " +
  "also show a player. Use angle brackets around paths containing spaces. " +
  "Link only files that exist. Playback requires a browser-supported codec; " +
  "remote media links open normally and are not inline players.";
