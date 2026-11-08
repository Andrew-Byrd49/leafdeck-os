import { esc } from './util.js';

const P = {
  // Image Editor's tools.
  'ie-move': '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  'ie-sel-rect': '<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 3"/>',
  'ie-sel-ellipse': '<ellipse cx="12" cy="12" rx="9" ry="7.5" stroke-dasharray="3 3"/>',
  'ie-lasso': '<path d="M6.5 16.5C4.4 15.1 3 13.1 3 10.8 3 6.5 7 3.5 12 3.5s9 3 9 7.3-4 7.2-9 7.2c-1 0-2-.1-2.9-.4"/><circle cx="7.5" cy="17" r="2"/><path d="M7 19c0 1 .3 1.7 1 2.5"/>',
  'ie-wand': '<path d="M4 20L15 9"/><path d="M15 9l-1.5-1.5M15 9l1.5 1.5"/><path d="M18 3v3M16.5 4.5h3M20 11v2M19 12h2M10 3v2M9 4h2"/>',
  'ie-brush': '<path d="M20.5 3.5c-3.5 1.7-8.2 5.8-10.6 9l2.6 2.6c3.2-2.4 7.3-7.1 9-10.6.3-.7-.3-1.3-1-1z"/><path d="M9.2 13.8c-2 0-3.7 1.3-4 3.3-.2 1.3-.8 2.2-2.2 2.9 2.6 1 7 .7 8.6-2.2.6-1.2.4-2.4-.2-3.2"/>',
  'ie-pencil': '<path d="M4 20l1-4.5L16.5 4a2 2 0 0 1 2.9 0l.6.6a2 2 0 0 1 0 2.9L8.5 19 4 20z"/><path d="M14.5 6l3.5 3.5"/>',
  'ie-eraser': '<path d="M8.5 20L3.7 15.2a2 2 0 0 1 0-2.8l8.7-8.7a2 2 0 0 1 2.8 0l5.1 5.1a2 2 0 0 1 0 2.8L12 20H8.5z"/><path d="M8 8.5l7.5 7.5M8.5 20H21"/>',
  'ie-bucket': '<path d="M11 3.5L3.5 11a1.5 1.5 0 0 0 0 2.1l6.9 6.9a1.5 1.5 0 0 0 2.1 0L20 12.5 11 3.5z"/><path d="M3.5 12.5h16"/><path d="M21 16c.8 1.2 1.3 2 1.3 2.8a1.3 1.3 0 0 1-2.6 0c0-.8.5-1.6 1.3-2.8z"/>',
  'ie-gradient': '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M8 4.5v15M12 4.5v15" opacity=".75"/><path d="M15.5 4.5v15" opacity=".4"/>',
  'ie-line': '<path d="M5 19L19 5"/>',
  'ie-rect': '<rect x="4" y="5.5" width="16" height="13" rx="1"/>',
  'ie-ellipse': '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  'ie-text': '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  'ie-hand': '<path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v6.5"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a6.5 6.5 0 0 1-6.5 6.5h-1a6.5 6.5 0 0 1-5.1-2.5L4 14.5a1.5 1.5 0 0 1 2.3-1.9L8 14"/>',
  'ie-swap': '<path d="M5 9a4 4 0 0 1 4-4h7"/><path d="M13 2l3 3-3 3"/><path d="M19 15a4 4 0 0 1-4 4H8"/><path d="M11 22l-3-3 3-3"/>',
  'ie-undo': '<path d="M8 5L3.5 9.5 8 14"/><path d="M4 9.5h10a6 6 0 0 1 0 12h-3"/>',
  'ie-redo': '<path d="M16 5l4.5 4.5L16 14"/><path d="M20 9.5H10a6 6 0 0 0 0 12h3"/>',
  'ie-merge': '<path d="M4 5h16M12 8v9M8 13.5l4 4 4-4M4 20.5h16"/>',
  'ie-minus': '<path d="M5 12h14"/>',
  'flame-plus': '<path transform="translate(-1.6 3.2) scale(.82)" d="M12 2.2c.7 3.3 2.7 5 4.4 7 1.6 1.9 2.8 3.9 2.8 6.2 0 4-3.2 6.6-7.2 6.6s-7.2-2.6-7.2-6.6c0-2.5 1.2-4.4 2.7-5.9.2 1.5.9 2.8 2.1 3.4-.5-3.9 1-7.4 2.4-10.7z"/><path transform="translate(-1.6 3.2) scale(.82)" d="M12 13.2c.3 1.4 1.2 2.2 1.9 3 .6.7 1 1.4 1 2.3 0 1.6-1.3 2.6-2.9 2.6s-2.9-1-2.9-2.6c0-1.2.6-2.1 1.4-2.8 0 .8.3 1.3.8 1.5.1-1.5.3-2.8.7-4z"/><path d="M19 2.5v7M15.5 6h7"/>',
  eyedropper: '<path d="M2 22l1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="M15 6l3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4z"/>',
  pen: '<path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>',
  leaf: '<g transform="translate(-1.01 -2.35) scale(0.4472)" fill="currentColor" stroke="none"><path d="M 32.695312 15.632812 C 22.328125 25.605469 32.21875 34.347656 34.8125 39.320312 C 34.8125 39.320312 33.445312 31.566406 36.8125 23.707031 C 37.730469 21.554688 39.007812 19.394531 40.761719 17.382812 C 40.761719 17.382812 38.675781 19.949219 37.335938 25.449219 C 36.507812 28.851562 35.960938 33.371094 36.371094 39.109375 C 39.414062 34.273438 45.332031 33.300781 44.714844 22.109375 C 44.304688 14.660156 47.925781 9.730469 47.925781 9.730469 C 39.058594 10.050781 33.582031 14.777344 32.695312 15.632812"/><path d="M 11.84375 34.585938 C 17.171875 45.574219 26.828125 39.886719 31.523438 39.097656 C 31.523438 39.097656 24.90625 38.164062 19.441406 33.382812 C 17.949219 32.074219 16.539062 30.476562 15.375 28.53125 C 15.375 28.53125 16.898438 30.890625 20.988281 33.417969 C 23.515625 34.980469 27.023438 36.605469 31.765625 37.78125 C 28.660156 34.058594 29.425781 29.023438 20.230469 26.582031 C 14.105469 24.953125 11.078125 20.738281 11.078125 20.738281 C 9.007812 27.980469 11.386719 33.644531 11.84375 34.585938"/><path d="M 22.261719 54.1875 C 32.449219 56.148438 33.488281 46.683594 35.339844 43.089844 C 35.339844 43.089844 31.339844 47.117188 25.308594 48.402344 C 23.65625 48.753906 21.855469 48.902344 19.941406 48.703125 C 19.941406 48.703125 22.320312 48.867188 26.117188 47.371094 C 28.464844 46.445312 31.355469 44.882812 34.566406 42.257812 C 30.453125 42.476562 27.417969 39.394531 21.082031 44.410156 C 16.863281 47.75 12.453125 47.664062 12.453125 47.664062 C 16.328125 52.757812 21.394531 54.019531 22.261719 54.1875"/></g>', // the Leafdeck leaf (public/img/leafdeck-icon.svg), filled
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/><path d="M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 13.8c2.1.8 3.5 3 3.5 5.7"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  kanban: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 12.5l3 3 5-6.5"/>',
  tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  bolt: '<path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12l1-8z"/>',
  tag: '<path d="M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8-8.5 8.5-8.5-8.5z"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  eject: '<path d="M12 5l7 9H5z"/><path d="M5 19h14"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  up: '<path d="M6 14.5l6-6 6 6"/>',
  send: '<path d="M21 3L10.5 13.5"/><path d="M21 3l-6.5 18-4-7.5-7.5-4z"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  note: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  chart: '<path d="M3 21h18"/><rect x="5" y="11" width="3" height="7" rx=".5"/><rect x="10.5" y="5" width="3" height="13" rx=".5"/><rect x="16" y="13" width="3" height="5" rx=".5"/>',
  heart: '<path d="M12 20s-7-4.4-9.2-9C1.4 7.6 3.6 4 7 4c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.4 0 5.6 3.6 4.2 7-2.2 4.6-9.2 9-9.2 9z"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  code: '<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  cloud: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 17.9 9.6 4 4 0 0 1 17.5 18.5H7z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 9l3 3-3 3M12.5 15h4.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r=".6"/><circle cx="4.5" cy="12" r=".6"/><circle cx="4.5" cy="18" r=".6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M4 4h16"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
  claude: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.3 4.3M14.1 14.1l4.3 4.3M18.4 5.6l-4.3 4.3M9.9 14.1l-4.3 4.3"/>',
  pin: '<path d="M9 4h6l-1 6 4 3H6l4-3-1-6zM12 13v8"/>',
  dots: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  flag: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  bookmark: '<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4.2-6.5 4.2v-16a1 1 0 0 1 1-1z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.9 12.1L20 3M16 7l3 3M14 9l2 2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  place: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  pause: '<path d="M8 5.5v13M16 5.5v13"/>',
  layout: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M11 10v9.5"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  // Leafdeck OS: system status and power
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.6 16a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.3" r="1" fill="currentColor"/>',
  'wifi-off': '<path d="M2.5 9a14 14 0 0 1 6-3.2M21.5 9a14 14 0 0 0-8.3-3.7M5.5 12.5a9.5 9.5 0 0 1 3.1-2M18.5 12.5a9.5 9.5 0 0 0-2.4-1.7M8.6 16a5 5 0 0 1 6.8 0"/><circle cx="12" cy="19.3" r="1" fill="currentColor"/><path d="M3 3l18 18"/>',
  ethernet: '<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M8 9V5h8v4M8 14v2M12 14v2M16 14v2"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  'volume-x': '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M21.5 10.5v3"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  logout: '<path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M15 8l4 4-4 4M19 12H9.5"/>',
  bag: '<path d="M5 8.5h14l-1.2 11.5H6.2z"/><path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/>',
  headphones: '<path d="M4 15.5V12a8 8 0 0 1 16 0v3.5"/><rect x="3.5" y="14" width="4.5" height="6.5" rx="1.8"/><rect x="16" y="14" width="4.5" height="6.5" rx="1.8"/>',
  airplay: '<path d="M6.5 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1.5"/><path d="M12 15l5 6H7z"/>',
  bluetooth: '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/>',
  'bluetooth-off': '<path d="M7 7.5l10 9-5 4.5V3l5 4.5-10 9"/><path d="M3 3l18 18"/>',
  'restart-other': '<rect x="3.5" y="4" width="17" height="12" rx="2"/><path d="M8.5 20h7M12 16v4M9.5 10h5M12.5 8l2 2-2 2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>',
  display: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8.5 20.5h7M12 17v3.5"/>',
  mouse: '<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6.5v3.5"/>',
  'split-row': '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M12 4.5v15"/>',
  'split-col': '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 12h18"/>',
  'new-window': '<rect x="3" y="4.5" width="15" height="12.5" rx="2.5"/><path d="M3 8.5h15M19.5 16.5v5M17 19h5"/>',
  branch: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 3v12.5M18 8.5a9 9 0 0 1-9 9"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9 4.5v15"/>',
  panel: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M15 4.5v15"/>',
  'text-file': '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15.5l-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5.5 19.8"/>',
  crop: '<path d="M6 2.5V16a2 2 0 0 0 2 2h13.5"/><path d="M2.5 6H16a2 2 0 0 1 2 2v13.5"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9"/><path d="M10 19a2 2 0 0 0 4 0"/>',
};

export const ICONS = Object.keys(P);

// The Burner flame: filled and colored, with two layers that flicker (CSS: .ic-flame).
const FLAME =
  '<path class="fl-o" fill="#ff7a29" stroke="none" d="M12 2.2c.7 3.3 2.7 5 4.4 7 1.6 1.9 2.8 3.9 2.8 6.2 0 4-3.2 6.6-7.2 6.6s-7.2-2.6-7.2-6.6c0-2.5 1.2-4.4 2.7-5.9.2 1.5.9 2.8 2.1 3.4-.5-3.9 1-7.4 2.4-10.7z"/>' +
  '<path class="fl-i" fill="#ffd34d" stroke="none" d="M12 11.2c.4 1.8 1.5 2.7 2.4 3.7.8.9 1.3 1.9 1.3 3 0 2-1.6 3.5-3.7 3.5s-3.7-1.5-3.7-3.5c0-1.7.9-2.9 2.1-3.8-.1 1 .3 1.8 1 2.1.1-2 .2-3.4.6-5z"/>';
export const flameIcon = (size = 16) =>
  `<svg class="ic ic-flame" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${FLAME}</svg>`;

export const icon = (name, size = 16, sw = 1.9) =>
  name === 'flame' ? flameIcon(size) :
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.sparkle}</svg>`;

export const PALETTE = {
  green: ['#5ee08f', '#169a55'],
  teal: ['#4fe0d2', '#0f8a8a'],
  blue: ['#6cb6ff', '#2560e0'],
  indigo: ['#9c8cff', '#4a3bd6'],
  purple: ['#d38bff', '#8a2bd1'],
  pink: ['#ff8fc0', '#d6336c'],
  red: ['#ff8a80', '#d93025'],
  orange: ['#ffbf69', '#e8590c'],
  yellow: ['#ffe28a', '#e0a400'],
  gray: ['#b8bcc6', '#5b616e'],
  graphite: ['#5d6370', '#23262d'],
};

export const colorPair = (c) => PALETTE[c] || (Array.isArray(c) ? c : PALETTE.gray);

/**
 * App icon.
 * - Built-in apps: frosted-glass tile matching the desktop widgets, with a white line glyph.
 * - `app.logo`: brand logo on a white tile, falling back to a colored letter tile if it fails to load.
 * - `app.glyph` (connections without a logo): colored gradient tile with a letter/emoji.
 */
export function appIcon(app) {
  const [a, b] = colorPair(app.color);
  const vars = `--c1:${a};--c2:${b}`;
  const letter = `<span class="glyph-letter">${esc(app.glyph || (app.name || '?')[0])}</span>`;
  if (app.logo) {
    // logoFull: a webclip (apple-touch-icon) is already a finished square icon, so it fills the tile.
    return `<span class="app-icon"><span class="ai-face ai-logo${app.logoFull ? ' ai-clip' : ''}" style="${vars}"><img src="${esc(app.logo)}" alt="" decoding="async" referrerpolicy="no-referrer" draggable="false">${letter}</span></span>`;
  }
  if (app.glyph) return `<span class="app-icon"><span class="ai-face" style="${vars}">${letter}</span></span>`;
  return `<span class="app-icon is-glass"><span class="ai-face ai-glass">${icon(app.icon, 24, 1.85)}</span></span>`;
}
