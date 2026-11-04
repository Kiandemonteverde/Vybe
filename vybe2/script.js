const cfg = window.VYBE_CONFIG || {};
const backendReady = Boolean(
  window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes("YOUR-PROJECT")
);
const db = backendReady ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const $ = id => document.getElementById(id);

const audio = $("audio-player");
const playerTitle = $("player-title");
const playerArtist = $("player-artist");
const playerCover = $("player-cover");
const playBtn = $("play-btn");
const progress = $("progress");
const currentTime = $("current-time");
const duration = $("duration");
const volume = $("volume");
const likeCurrent = $("like-current");
const toast = $("toast");

const SIGNED_URL_SECONDS = 60 * 60 * 3;
const MIN_PASSWORD = 8;

let songs = [];
let songsById = new Map();
let songsSnapshot = "";
let loaded = false;
let loadError = "";

let queue = [];            // song ids in play order for whatever is playing now
let currentSongId = null;
let shuffleHistory = [];
let playToken = 0;
let retriedSongId = null;
let isShuffle = readLocal("vybeShuffle", false);
let isRepeat = readLocal("vybeRepeat", false);

let user = null;
let isAdmin = false;
let accountToken = 0;
let pendingAction = null;
let liked = [];
let myPlaylists = [];       // { id, name, tracks: [{ songId, position }] }
let featuredPlaylists = []; // the same, plus description and coverUrl
let communityPlaylists = []; // listeners' public playlists
const viewedPlaylists = new Map(); // public playlists reached through a link or a profile
let myProfileName = "";
let myAvatarPath = "";
let myFollowing = new Set(); // ids of the people this account follows
let activePlaylistId = null;
let activeProfile = null;

let likeStats = new Map(); // song id → { total, recent }
let activeChartId = null;

let viewHistory = [{ view: "home", playlistId: null, profileId: null, chartId: null }];
let historyPosition = 0;
let toastTimer;

function readLocal(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : JSON.parse(stored);
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage unavailable: preferences just won't be remembered */ }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(name, label, onClick, className = "") {
  const button = el("button", className);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(icon(name));
  button.addEventListener("click", onClick);
  return button;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/* ---------- Loading the public library ---------- */

async function loadSongs({ silent = false } = {}) {
  if (!db) {
    loadError = "VYBE isn't connected to its music library yet.";
    loaded = true;
    renderAll();
    return;
  }

  const { data, error } = await db
    .from("songs")
    .select("id,title,artist,album,genre,audio_path,cover_path,duration_seconds,published_at")
    .eq("published", true)
    .order("published_at", { ascending: false });

  if (error) {
    // Keep showing what we already have if a background refresh fails.
    if (!silent || !loaded) {
      loadError = navigator.onLine
        ? "Couldn't load the music library. Try again in a moment."
        : "You're offline. Reconnect to browse the music library.";
      loaded = true;
      renderAll();
    }
    return;
  }

  const snapshot = JSON.stringify(data);
  if (loaded && !loadError && snapshot === songsSnapshot) return; // nothing changed, keep the page as it is
  songsSnapshot = snapshot;

  songs = data.map(row => ({
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album || "",
    genre: row.genre || "",
    durationSeconds: row.duration_seconds,
    audioPath: row.audio_path,
    coverUrl: coverUrl(row.cover_path)
  }));
  songsById = new Map(songs.map(song => [song.id, song]));
  loaded = true;
  loadError = "";
  renderAll();
}

function coverUrl(path) {
  return path ? db.storage.from("covers").getPublicUrl(path).data.publicUrl : "";
}

function toTracks(rows) {
  return (rows || [])
    .map(row => ({ songId: row.song_id, position: row.position }))
    .sort((a, b) => a.position - b.position || a.songId.localeCompare(b.songId));
}

function toPlaylist(row, ownerName = "Listener") {
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    coverUrl: row.is_official ? coverUrl(row.cover_path) : "",
    official: Boolean(row.is_official),
    ownerId: row.owner_id,
    ownerName,
    isPublic: Boolean(row.is_public),
    sourceId: row.source_playlist_id || null,
    tracks: toTracks(row.playlist_songs)
  };
}

const PLAYLIST_COLUMNS = "*,playlist_songs(song_id,position)";

async function loadProfileNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await db.from("profiles").select("id,display_name").in("id", unique);
  return new Map(error ? [] : data.map(row => [row.id, row.display_name]));
}

// Official playlists anyone can see. Fails quietly until the database script has been run.
async function loadFeaturedPlaylists() {
  if (!db) return;
  const { data, error } = await db
    .from("playlists")
    .select(PLAYLIST_COLUMNS)
    .eq("is_official", true)
    .eq("published", true)
    .order("created_at", { ascending: false });
  if (error) return;
  featuredPlaylists = data.map(row => toPlaylist(row));
  renderAll();
}

async function loadCommunityPlaylists() {
  if (!db) return;
  const { data, error } = await db
    .from("playlists")
    .select(PLAYLIST_COLUMNS)
    .eq("is_public", true)
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return;
  const names = await loadProfileNames(data.map(row => row.owner_id));
  communityPlaylists = data.map(row => toPlaylist(row, names.get(row.owner_id)));
  renderAll();
}

/* ---------- Rendering ---------- */

function emptyText(custom) {
  if (loadError) return loadError;
  if (!loaded) return "Loading music…";
  return custom || "No songs here yet.";
}

function setCover(element, url) {
  element.textContent = "";
  if (!url) {
    element.textContent = "♫";
    return;
  }
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = url;
  img.addEventListener("error", () => { element.textContent = "♫"; });
  element.appendChild(img);
}

function songSubtitle(song) {
  return song.album ? `${song.artist} · ${song.album}` : song.artist;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function renderSongList(container, list, emptyMessage, { queueIds, playlist } = {}) {
  container.innerHTML = "";

  if (!list.length) {
    container.appendChild(el("p", "muted empty-state", emptyText(emptyMessage)));
    return;
  }

  const order = queueIds || list.map(song => song.id);
  const editable = Boolean(playlist && isMine(playlist));

  list.forEach((song, index) => {
    const row = el("div", "song-row");
    row.dataset.songId = song.id;
    row.classList.toggle("is-current", song.id === currentSongId);
    row.addEventListener("click", event => {
      if (!event.target.closest("button")) playFrom(order, song.id);
    });

    const play = el("button", "song-play");
    play.type = "button";
    play.title = `Play ${song.title}`;
    play.setAttribute("aria-label", `Play ${song.title}`);
    const art = el("div", "song-art");
    setCover(art, song.coverUrl);
    const overlay = el("span", "song-play-icon");
    overlay.appendChild(icon("play"));
    play.append(art, overlay);
    play.addEventListener("click", () => playFrom(order, song.id));

    const details = el("div", "song-details");
    details.append(el("h4", "", song.title), el("p", "", songSubtitle(song)));

    const time = el("span", "song-time", song.durationSeconds ? formatTime(song.durationSeconds) : "");

    const actions = el("div", "song-actions");
    const isLiked = liked.includes(song.id);
    const likeButton = iconButton("heart", isLiked ? "Remove from Liked Songs" : "Add to Liked Songs",
      () => toggleLike(song.id), isLiked ? "liked" : "");
    actions.appendChild(likeButton);

    if (editable) {
      const up = iconButton("up", "Move up", () => moveTrack(playlist, list, index, -1));
      up.disabled = index === 0;
      const down = iconButton("down", "Move down", () => moveTrack(playlist, list, index, 1));
      down.disabled = index === list.length - 1;
      actions.append(up, down, iconButton("close", "Remove from this playlist", () => removeTrack(playlist, song)));
    } else {
      actions.appendChild(iconButton("plus", "Add to playlist", () => openAddDialog(song)));
    }

    row.append(play, details, time, actions);
    container.appendChild(row);
  });
}

function playlistSongs(playlist) {
  return playlist.tracks.map(track => songsById.get(track.songId)).filter(Boolean);
}

function playlistCover(playlist) {
  if (playlist.coverUrl) return playlist.coverUrl;
  // A saved copy keeps the picture of the playlist it came from, while that's still visible.
  const source = playlist.sourceId && findPlaylist(playlist.sourceId);
  if (source && source.coverUrl) return source.coverUrl;
  const withArt = playlistSongs(playlist).find(song => song.coverUrl);
  return withArt ? withArt.coverUrl : "";
}

function isMine(playlist) {
  return Boolean(user) && playlist.ownerId === user.id;
}

function playlistCardNote(playlist) {
  const count = plural(playlistSongs(playlist).length, "song");
  if (playlist.official) return count;
  if (isMine(playlist)) return `${playlist.isPublic ? "Public" : "Private"} · ${count}`;
  return `By ${playlist.ownerName} · ${count}`;
}

function renderPlaylistGrid(container, list, emptyMessage) {
  container.innerHTML = "";
  if (!list.length) {
    container.appendChild(el("p", "muted empty-state", emptyMessage));
    return;
  }
  list.forEach(playlist => {
    const card = el("button", "playlist-card");
    card.type = "button";
    const art = el("div", "playlist-card-art");
    setCover(art, playlistCover(playlist));
    card.append(art, el("b", "", playlist.name), el("small", "", playlistCardNote(playlist)));
    card.addEventListener("click", () => openPlaylist(playlist.id));
    container.appendChild(card);
  });
}

function renderSidebarPlaylists() {
  const list = $("playlist-list");
  list.innerHTML = "";
  if (!user) {
    list.appendChild(el("p", "muted", "Log in to create playlists."));
    return;
  }
  if (!myPlaylists.length) {
    list.appendChild(el("p", "muted", "No playlists yet."));
    return;
  }
  myPlaylists.forEach(playlist => {
    const button = el("button", "playlist-link");
    const art = el("div", "playlist-link-art");
    setCover(art, playlistCover(playlist));
    const text = el("span", "playlist-link-text");
    text.append(el("b", "", playlist.name), el("small", "", plural(playlistSongs(playlist).length, "song")));
    button.append(art, text);
    button.title = playlist.name;
    button.classList.toggle("active", playlist.id === activePlaylistId && $("playlist-view").classList.contains("active"));
    button.addEventListener("click", () => openPlaylist(playlist.id));
    list.appendChild(button);
  });
}

function renderPlaylists() {
  renderSidebarPlaylists();
  const empty = user ? "You haven't made a playlist yet." : "Log in to create your own playlists.";
  renderPlaylistGrid($("library-playlists"), myPlaylists, empty);
  renderPlaylistGrid($("playlists-page-list"), myPlaylists, empty);
  $("featured-section").hidden = featuredPlaylists.length === 0;
  renderPlaylistGrid($("featured-playlists"), featuredPlaylists, "");
  // Other people's playlists with something to play. Your own live in your library.
  const community = communityPlaylists
    .filter(playlist => !isMine(playlist) && playlistSongs(playlist).length)
    .slice(0, 12);
  $("community-section").hidden = community.length === 0;
  renderPlaylistGrid($("community-playlists"), community, "");
}

function renderAll() {
  const likedSongs = liked.map(id => songsById.get(id)).filter(Boolean);
  const allIds = songs.map(song => song.id);
  renderSongList($("home-songs"), songs.slice(0, 8), "No songs have been published yet. Check back soon.", { queueIds: allIds });
  renderSongList($("library-songs"), songs, "No songs have been published yet. Check back soon.");
  renderSongList($("liked-songs"), likedSongs, user ? "Tap the heart on a song and it will show up here." : "Log in, then tap the heart on a song to save it here.");
  renderSearchResults();
  renderActivePlaylist();
  renderActiveChart();
  $("song-count").textContent = plural(songs.length, "song");
  $("liked-count").textContent = plural(likedSongs.length, "song");
  $("liked-play").disabled = likedSongs.length === 0;
  renderPlaylists();
  updateLikeButton();
}

function markCurrentRows() {
  document.querySelectorAll(".song-row").forEach(row => {
    row.classList.toggle("is-current", row.dataset.songId === currentSongId);
  });
}

/* ---------- Playback ---------- */

async function getSignedUrl(song) {
  // Postgres only issues a URL if this song is currently published.
  const { data, error } = await db.storage.from("audio").createSignedUrl(song.audioPath, SIGNED_URL_SECONDS);
  return error || !data ? null : data.signedUrl;
}

function playFrom(ids, songId) {
  queue = ids;
  shuffleHistory = [];
  playSong(songId);
}

async function playSong(songId) {
  const song = songsById.get(songId);
  if (!song || !db) return;
  // Ask every time: a saved login may still be loading, or may have ended in another tab.
  const { data } = await db.auth.getSession();
  if (!data.session) {
    if (user) await applyAuthChange("SIGNED_OUT", null);
    requireAccount("You must log in first to play music. New here? You can sign up for free.", () => playSong(songId));
    return;
  }
  const token = ++playToken;
  currentSongId = song.id;
  retriedSongId = null;

  playerTitle.textContent = song.title;
  playerArtist.textContent = song.artist;
  setCover(playerCover, song.coverUrl);
  document.title = `${song.title} · VYBE`;
  markCurrentRows();
  updateLikeButton();
  updateMediaSession(song);

  const url = await getSignedUrl(song);
  if (token !== playToken) return; // the listener already skipped to another song
  if (!url) {
    showToast("This song is no longer available.");
    loadSongs({ silent: true });
    return;
  }

  audio.src = url;
  audio.volume = Number(volume.value);
  try {
    await audio.play();
  } catch (error) {
    if (error.name !== "AbortError") showToast("Could not play this audio file.");
  }
}

// Signed links expire. If playback fails mid-song, fetch a fresh link once and resume.
audio.addEventListener("error", async () => {
  const song = songsById.get(currentSongId);
  if (!song || !audio.getAttribute("src") || retriedSongId === song.id) return;
  retriedSongId = song.id;
  const resumeAt = audio.currentTime;
  const url = await getSignedUrl(song);
  if (!url || song.id !== currentSongId) {
    showToast("Playback stopped. Please try again.");
    return;
  }
  audio.src = url;
  audio.addEventListener("loadedmetadata", () => { audio.currentTime = resumeAt; }, { once: true });
  audio.play().catch(() => {});
});

// Logging out ends playback, so music never keeps going without an account.
function stopPlayback() {
  playToken++;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  currentSongId = null;
  queue = [];
  shuffleHistory = [];
  playerTitle.textContent = "No song playing";
  setCover(playerCover, "");
  progress.value = 0;
  paintRange(progress);
  currentTime.textContent = "0:00";
  duration.textContent = "0:00";
  document.title = "VYBE — Music for Every Mood";
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  setPlayIcon("play", "Play");
  markCurrentRows();
  updateLikeButton();
}

function togglePlay() {
  if (!audio.getAttribute("src")) {
    if (songs.length) playFrom(songs.map(song => song.id), currentSongId || songs[0].id);
    else showToast("No songs available yet.");
    return;
  }
  if (audio.paused) {
    audio.play().catch(error => {
      if (error.name !== "AbortError") showToast("Playback could not start.");
    });
  } else {
    audio.pause();
  }
}
playBtn.addEventListener("click", togglePlay);

function setPlayIcon(name, label) {
  playBtn.replaceChildren(icon(name));
  playBtn.title = label;
  playBtn.setAttribute("aria-label", label);
}
audio.addEventListener("play", () => setPlayIcon("pause", "Pause"));
audio.addEventListener("pause", () => setPlayIcon("play", "Play"));

// Songs can be unpublished while they wait in the queue, so only count ones still available.
function playableQueue() {
  const available = queue.filter(id => songsById.has(id));
  return available.length ? available : songs.map(song => song.id);
}

function nextSong() {
  const list = playableQueue();
  if (!list.length) return;
  if (isShuffle && list.length > 1) {
    const others = list.filter(id => id !== currentSongId);
    if (currentSongId) shuffleHistory.push(currentSongId);
    playSong(others[Math.floor(Math.random() * others.length)]);
  } else {
    playSong(list[(list.indexOf(currentSongId) + 1) % list.length]);
  }
}

function previousSong() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (isShuffle && shuffleHistory.length) { playSong(shuffleHistory.pop()); return; }
  const list = playableQueue();
  if (!list.length) return;
  const index = list.indexOf(currentSongId);
  playSong(index < 0 ? list[0] : list[(index - 1 + list.length) % list.length]);
}

$("next-btn").addEventListener("click", nextSong);
$("previous-btn").addEventListener("click", previousSong);

function paintModes() {
  const shuffle = $("shuffle-btn");
  shuffle.classList.toggle("selected", isShuffle);
  shuffle.setAttribute("aria-pressed", String(isShuffle));
  const repeat = $("repeat-btn");
  repeat.classList.toggle("selected", isRepeat);
  repeat.setAttribute("aria-pressed", String(isRepeat));
  audio.loop = isRepeat;
}

$("shuffle-btn").addEventListener("click", () => {
  isShuffle = !isShuffle;
  writeLocal("vybeShuffle", isShuffle);
  paintModes();
  showToast(isShuffle ? "Shuffle on" : "Shuffle off");
});

$("repeat-btn").addEventListener("click", () => {
  isRepeat = !isRepeat;
  writeLocal("vybeRepeat", isRepeat);
  paintModes();
  showToast(isRepeat ? "Repeat on" : "Repeat off");
});

audio.addEventListener("ended", () => {
  if (!isRepeat) nextSong();
});

function paintRange(range) {
  const span = Number(range.max) - Number(range.min);
  range.style.setProperty("--fill", `${((Number(range.value) - Number(range.min)) / span) * 100}%`);
}

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  progress.value = (audio.currentTime / audio.duration) * 100;
  paintRange(progress);
  currentTime.textContent = formatTime(audio.currentTime);
  duration.textContent = formatTime(audio.duration);
});
audio.addEventListener("loadedmetadata", () => {
  duration.textContent = formatTime(audio.duration);
});
progress.addEventListener("input", () => {
  paintRange(progress);
  if (audio.duration) audio.currentTime = (Number(progress.value) / 100) * audio.duration;
});
volume.addEventListener("input", () => {
  audio.volume = Number(volume.value);
  paintRange(volume);
  writeLocal("vybeVolume", Number(volume.value));
});

// Space toggles playback unless the listener is typing or using a control.
document.addEventListener("keydown", event => {
  if (event.code !== "Space" || event.repeat) return;
  if (event.target.closest("input, textarea, select, button, a, dialog")) return;
  event.preventDefault();
  togglePlay();
});

// Lock-screen / headphone / notification controls.
function updateMediaSession(song) {
  if (!("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artist,
    album: song.album,
    artwork: song.coverUrl ? [{ src: song.coverUrl }] : []
  });
}
if ("mediaSession" in navigator) {
  const handlers = {
    play: () => audio.play().catch(() => {}),
    pause: () => audio.pause(),
    previoustrack: previousSong,
    nexttrack: nextSong
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
  });
}

/* ---------- Accounts ---------- */

let authMode = "login";

const AUTH_MODES = {
  login: { title: "Log in to VYBE", submit: "Log in", switchText: "New to VYBE?", switchAction: "Create an account" },
  signup: { title: "Create your account", submit: "Sign up", switchText: "Already have an account?", switchAction: "Log in" },
  reset: { title: "Reset your password", submit: "Send reset link", switchText: "Remembered it?", switchAction: "Log in" }
};

function setAuthMode(mode) {
  authMode = mode;
  const text = AUTH_MODES[mode];
  $("auth-title").textContent = text.title;
  $("auth-submit").textContent = text.submit;
  $("auth-switch-text").textContent = text.switchText;
  $("auth-switch").textContent = text.switchAction;
  $("auth-name-field").hidden = mode !== "signup";
  $("auth-password-field").hidden = mode === "reset";
  $("auth-forgot").hidden = mode !== "login";
  $("auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("auth-error").textContent = "";
  $("auth-success").textContent = "";
}

function openAuth(mode = "login", reason = "") {
  if (!db) return showToast("VYBE isn't connected to its backend yet.");
  setAuthMode(mode);
  $("auth-reason").textContent = reason;
  $("auth-reason").hidden = !reason;
  if (!$("auth-dialog").open) $("auth-dialog").showModal();
  $("auth-email").focus();
}

// Runs the action now if signed in, otherwise straight after a successful log in.
function requireAccount(reason, action) {
  if (user) return action();
  pendingAction = action;
  openAuth("login", reason);
}

$("login-btn").addEventListener("click", () => { pendingAction = null; openAuth("login"); });
$("signup-btn").addEventListener("click", () => { pendingAction = null; openAuth("signup"); });
$("auth-forgot").addEventListener("click", () => setAuthMode("reset"));
$("auth-switch").addEventListener("click", () => setAuthMode(authMode === "login" ? "signup" : "login"));

function authErrorMessage(error) {
  const code = error.code || "";
  if (error.status === 429 || code.includes("rate_limit")) return "Too many attempts. Please wait a few minutes and try again.";
  if (code === "email_not_confirmed" || /not confirmed/i.test(error.message)) return "Please confirm your email first. Check your inbox for the link.";
  if (authMode === "login") return "Incorrect email or password.";
  return error.message || "Something went wrong. Please try again.";
}

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const name = $("auth-name").value.trim();
  const errorNode = $("auth-error");
  const successNode = $("auth-success");
  errorNode.textContent = "";
  successNode.textContent = "";

  if (!/^\S+@\S+\.\S+$/.test(email)) { errorNode.textContent = "Enter a valid email address."; return; }
  if (authMode === "signup" && !name) { errorNode.textContent = "Enter your name."; return; }
  if (authMode === "signup" && password.length < MIN_PASSWORD) { errorNode.textContent = `Use at least ${MIN_PASSWORD} characters for your password.`; return; }
  if (authMode === "login" && !password) { errorNode.textContent = "Enter your password."; return; }

  const redirectTo = location.origin + location.pathname;
  const submit = $("auth-submit");
  submit.disabled = true;

  if (authMode === "login") {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
      errorNode.textContent = authErrorMessage(error);
    } else {
      $("auth-password").value = "";
      $("auth-dialog").close();
    }
  } else if (authMode === "signup") {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { display_name: name }, emailRedirectTo: redirectTo }
    });
    if (error) {
      errorNode.textContent = authErrorMessage(error);
    } else if (data.session) {
      $("auth-password").value = "";
      $("auth-dialog").close();
      showToast("Welcome to VYBE!");
    } else {
      $("auth-password").value = "";
      successNode.textContent = `Almost there. We sent a confirmation link to ${email}. Open it to finish signing up.`;
    }
  } else {
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) errorNode.textContent = authErrorMessage(error);
    else successNode.textContent = `If an account exists for ${email}, a reset link is on its way.`;
  }
  submit.disabled = false;
});

$("password-form").addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("new-password").value;
  if (password.length < MIN_PASSWORD) {
    $("password-error").textContent = `Use at least ${MIN_PASSWORD} characters for your password.`;
    return;
  }
  const submit = $("password-submit");
  submit.disabled = true;
  const { error } = await db.auth.updateUser({ password });
  submit.disabled = false;
  if (error) {
    $("password-error").textContent = error.message || "Couldn't save your password. Please try again.";
    return;
  }
  $("new-password").value = "";
  $("password-error").textContent = "";
  $("password-dialog").close();
  showToast("Password updated.");
});

function avatarUrl(path) {
  return path ? db.storage.from("avatars").getPublicUrl(path).data.publicUrl : "";
}

// Shows a person's photo, or the first letter of their name if they don't have one.
function setAvatar(element, path, name) {
  const initial = name.charAt(0).toUpperCase();
  element.textContent = initial;
  const url = avatarUrl(path);
  if (!url) return;
  const img = document.createElement("img");
  img.alt = "";
  img.src = url;
  img.addEventListener("error", () => { element.textContent = initial; });
  element.replaceChildren(img);
}

function displayName() {
  if (!user) return "";
  const meta = user.user_metadata || {};
  return myProfileName || meta.display_name || (user.email || "").split("@")[0] || "Listener";
}

function renderAccount() {
  $("guest-actions").hidden = Boolean(user);
  $("profile-btn").hidden = !user;
  $("admin-link").hidden = !isAdmin;
  if (!currentSongId) playerArtist.textContent = user ? "Pick a song to get started" : "Log in first to play music";
  $("sidebar-note").textContent = user
    ? "Your likes and playlists are saved to your account."
    : "Log in to save likes and playlists to your account.";
  if (user) {
    const name = displayName();
    if (activeProfile && activeProfile.id === user.id) renderProfile();
    setAvatar($("profile-btn"), myAvatarPath, name);
    $("profile-btn").title = name;
    $("profile-btn").setAttribute("aria-label", `Account menu for ${name}`);
    $("account-name").textContent = name;
    $("account-email").textContent = user.email || "";
  } else {
    closeAccountMenu();
  }
}

function closeAccountMenu() {
  $("account-menu").hidden = true;
  $("profile-btn").setAttribute("aria-expanded", "false");
}

$("profile-btn").addEventListener("click", () => {
  const opening = $("account-menu").hidden;
  $("account-menu").hidden = !opening;
  $("profile-btn").setAttribute("aria-expanded", String(opening));
});
document.addEventListener("click", event => {
  if (!event.target.closest("#account")) closeAccountMenu();
});

$("signout-btn").addEventListener("click", async () => {
  closeAccountMenu();
  const { error } = await db.auth.signOut();
  if (!error) return;
  // Supabase keeps the session if its server can't be reached (for example offline),
  // but this device must still end up logged out, so forget the saved login here.
  localStorage.removeItem(`sb-${new URL(cfg.SUPABASE_URL).hostname.split(".")[0]}-auth-token`);
  await applyAuthChange("SIGNED_OUT", null);
});

async function loadAccountData() {
  const token = ++accountToken;
  const userId = user.id;
  const [playlistsResult, likesResult, adminResult, profileResult, followingResult] = await Promise.all([
    db.from("playlists").select(PLAYLIST_COLUMNS)
      .eq("owner_id", userId).eq("is_official", false).order("created_at"),
    db.from("liked_songs").select("song_id,created_at").eq("user_id", userId).order("created_at", { ascending: false }),
    db.from("admins").select("user_id").eq("user_id", userId).maybeSingle(),
    db.from("profiles").select("*").eq("id", userId).maybeSingle(),
    db.from("follows").select("following_id").eq("follower_id", userId)
  ]);
  if (token !== accountToken) return false; // signed out or switched account while this was loading

  isAdmin = Boolean(adminResult.data);
  myProfileName = profileResult.data ? profileResult.data.display_name : "";
  myAvatarPath = profileResult.data ? profileResult.data.avatar_path || "" : "";
  myFollowing = new Set((followingResult.data || []).map(row => row.following_id));
  if (playlistsResult.error || likesResult.error) {
    console.error(playlistsResult.error || likesResult.error);
    showToast("Couldn't load your playlists and likes. Please refresh and try again.");
    renderAccount();
    renderAll();
    return false;
  }
  myPlaylists = playlistsResult.data.map(row => toPlaylist(row, displayName()));
  liked = likesResult.data.map(row => row.song_id);
  renderAccount();
  renderAll();
  renderProfile(); // a profile opened by link may have drawn before this account's follows loaded
  return true;
}

// Before accounts existed, likes and playlists were kept in this browser. Move them
// into the account the first time someone signs in, removing each part once it's saved.
async function importDeviceLibrary() {
  if (!loaded || loadError || !songs.length) return;
  const deviceLikes = readLocal("vybeLiked", []);
  let devicePlaylists = readLocal("vybePlaylists", []);
  if (!Array.isArray(deviceLikes) || !Array.isArray(devicePlaylists)) return;
  if (!deviceLikes.length && !devicePlaylists.length) return;

  const likeRows = deviceLikes.filter(id => songsById.has(id)).map(id => ({ user_id: user.id, song_id: id }));
  if (likeRows.length) {
    const { error } = await db.from("liked_songs").upsert(likeRows, { ignoreDuplicates: true });
    if (error) return;
  }
  writeLocal("vybeLiked", undefined);

  for (const local of [...devicePlaylists]) {
    const { data, error } = await db.from("playlists")
      .insert({ name: String(local.name || "My playlist").slice(0, 100), owner_id: user.id })
      .select("id").single();
    if (error) return;
    const rows = (local.songIds || []).filter(id => songsById.has(id))
      .map((id, position) => ({ playlist_id: data.id, song_id: id, position }));
    if (rows.length) {
      const result = await db.from("playlist_songs").insert(rows);
      if (result.error) return;
    }
    devicePlaylists = devicePlaylists.filter(item => item !== local);
    writeLocal("vybePlaylists", devicePlaylists.length ? devicePlaylists : undefined);
  }

  await loadAccountData();
  showToast("Your saved likes and playlists were added to your account.");
}

async function applyAuthChange(event, nextUser) {
  if (event === "PASSWORD_RECOVERY") $("password-dialog").showModal();

  const sameUser = (user && user.id) === (nextUser && nextUser.id);
  user = nextUser;
  if (sameUser) {
    renderAccount(); // token refresh or a new tab focus: nothing else changed
    return;
  }
  viewedPlaylists.clear(); // what one account could open mustn't carry over to the next

  if (!user) {
    accountToken++;
    isAdmin = false;
    myProfileName = "";
    myAvatarPath = "";
    myFollowing = new Set();
    liked = [];
    myPlaylists = [];
    pendingAction = null;
    document.querySelectorAll("dialog[open]").forEach(dialog => {
      if (dialog.id !== "auth-dialog") dialog.close();
    });
    renderProfile();
    stopPlayback();
    if ($("playlist-view").classList.contains("active") && !findPlaylist(activePlaylistId)) showView("home");
    renderAccount();
    renderAll();
    return;
  }

  renderAccount();
  const ok = await loadAccountData();
  if (!ok) return;
  await songsReady;
  await importDeviceLibrary();
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    action();
  }
}

/* ---------- Likes ---------- */

async function setLike(id, shouldLike) {
  const previous = liked;
  liked = shouldLike ? [id, ...liked] : liked.filter(item => item !== id);
  renderAll();
  const { error } = shouldLike
    ? await db.from("liked_songs").upsert({ user_id: user.id, song_id: id }, { ignoreDuplicates: true })
    : await db.from("liked_songs").delete().eq("user_id", user.id).eq("song_id", id);
  if (error) {
    liked = previous;
    renderAll();
    showToast("Couldn't save that. Please try again.");
    return;
  }
  showToast(shouldLike ? "Added to Liked Songs" : "Removed from Liked Songs");
}

function toggleLike(id) {
  requireAccount("Log in to save songs you like.", () => {
    if (user) setLike(id, !liked.includes(id));
  });
}

function updateLikeButton() {
  const isLiked = Boolean(currentSongId) && liked.includes(currentSongId);
  likeCurrent.classList.toggle("liked", isLiked);
  likeCurrent.setAttribute("aria-pressed", String(isLiked));
}
likeCurrent.addEventListener("click", () => {
  if (currentSongId) toggleLike(currentSongId);
});

$("liked-play").addEventListener("click", () => {
  const ids = liked.filter(id => songsById.has(id));
  if (ids.length) playFrom(ids, ids[0]);
});

/* ---------- Search ---------- */

function renderSearchResults() {
  const raw = $("page-search").value;
  const term = raw.trim().toLowerCase();
  const results = term
    ? songs.filter(song =>
        [song.title, song.artist, song.album, song.genre].some(field => field.toLowerCase().includes(term)))
    : songs;
  renderSearchPlaylists(term);
  renderSongList(
    $("search-results"),
    results,
    term ? `No songs match "${raw.trim()}".` : "No songs have been published yet. Check back soon."
  );
}

function renderSearchPlaylists(term) {
  const matches = term
    ? [...featuredPlaylists, ...communityPlaylists].filter(playlist =>
        [playlist.name, playlist.official ? "" : playlist.ownerName].some(field => field.toLowerCase().includes(term)))
    : [];
  $("search-playlists-section").hidden = matches.length === 0;
  renderPlaylistGrid($("search-playlists"), matches.slice(0, 12), "");
}

function runSearch(query) {
  $("global-search").value = query;
  $("page-search").value = query;
  showView("search");
  renderSearchResults();
  searchPeople(query);
}

$("global-search").addEventListener("input", event => {
  runSearch(event.target.value);
});
$("page-search").addEventListener("input", event => {
  $("global-search").value = event.target.value;
  renderSearchResults();
  searchPeople(event.target.value);
});

/* ---------- Navigation ---------- */

function showView(view, { addToHistory = true, playlistId = null, profileId = null, chartId = null } = {}) {
  const target = $(`${view}-view`);
  if (!target) return;
  document.querySelectorAll(".page").forEach(page => page.classList.remove("active"));
  target.classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  $("main-content").scrollTop = 0;
  const current = viewHistory[historyPosition];
  if (addToHistory && (current.view !== view || current.playlistId !== playlistId || current.profileId !== profileId || current.chartId !== chartId)) {
    viewHistory = viewHistory.slice(0, historyPosition + 1);
    viewHistory.push({ view, playlistId, profileId, chartId });
    historyPosition = viewHistory.length - 1;
  }
  renderSidebarPlaylists();
}

function goToHistoryEntry() {
  const entry = viewHistory[historyPosition];
  if (entry.view === "profile") return openProfile(entry.profileId, { addToHistory: false });
  if (entry.view === "chart") return openChart(entry.chartId, { addToHistory: false });
  if (entry.view === "playlist") {
    if (!findPlaylist(entry.playlistId)) return showView("home", { addToHistory: false });
    activePlaylistId = entry.playlistId;
    renderActivePlaylist();
  }
  showView(entry.view, { addToHistory: false, playlistId: entry.playlistId });
}

document.querySelectorAll(".nav-btn").forEach(button => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
$("back-btn").addEventListener("click", () => {
  if (historyPosition > 0) { historyPosition--; goToHistoryEntry(); }
});
$("forward-btn").addEventListener("click", () => {
  if (historyPosition < viewHistory.length - 1) { historyPosition++; goToHistoryEntry(); }
});
$("logo-link").addEventListener("click", event => {
  event.preventDefault();
  showView("home");
});

$("browse-btn").addEventListener("click", () => showView("library"));

/* ---------- Trending now, Best OPM and Most liked ---------- */

const CHARTS = {
  trending: {
    title: "Trending now",
    note: "The most liked songs this week, then the newest.",
    empty: "No songs have been published yet. Check back soon."
  },
  opm: {
    title: "Best OPM",
    note: "Original Pilipino Music, most liked first.",
    empty: "No OPM songs yet. Check back soon."
  },
  liked: {
    title: "Most liked",
    note: "The songs with the most hearts on VYBE.",
    empty: "No song has been liked yet. Tap a heart to get things started."
  }
};

const totalLikes = song => (likeStats.get(song.id) || { total: 0 }).total;
const recentLikes = song => (likeStats.get(song.id) || { recent: 0 }).recent;

// The library is newest first and sort keeps that order for ties, so newer songs win them.
function chartSongs(id) {
  if (id === "trending") {
    return [...songs].sort((a, b) => recentLikes(b) - recentLikes(a) || totalLikes(b) - totalLikes(a)).slice(0, 30);
  }
  if (id === "opm") {
    return songs.filter(song => /\bopm\b/i.test(song.genre)).sort((a, b) => totalLikes(b) - totalLikes(a)).slice(0, 50);
  }
  return songs.filter(song => totalLikes(song) > 0).sort((a, b) => totalLikes(b) - totalLikes(a)).slice(0, 50);
}

function renderActiveChart() {
  const chart = CHARTS[activeChartId];
  if (!chart) return;
  const list = chartSongs(activeChartId);
  $("chart-hero").className = `collection-hero chart-${activeChartId}`;
  $("chart-title").textContent = chart.title;
  $("chart-note").textContent = chart.note;
  $("chart-play").disabled = list.length === 0;
  renderSongList($("chart-songs"), list, chart.empty);
}

async function loadLikeStats() {
  if (!db) return;
  const { data, error } = await db.rpc("song_like_stats");
  if (error) return; // charts still work without counts until the database script has been run
  likeStats = new Map(data.map(row => [row.song_id, { total: Number(row.total_likes), recent: Number(row.recent_likes) }]));
}

async function openChart(id, { addToHistory = true } = {}) {
  activeChartId = id;
  renderActiveChart();
  showView("chart", { addToHistory, chartId: id });
  await loadLikeStats();
  if (activeChartId === id) renderActiveChart();
}

document.querySelectorAll(".featured-card").forEach(card => {
  card.addEventListener("click", () => openChart(card.dataset.chart));
});

$("chart-play").addEventListener("click", () => {
  const ids = chartSongs(activeChartId).map(song => song.id);
  if (ids.length) playFrom(ids, ids[0]);
});

/* ---------- Playlists ---------- */

function findPlaylist(id) {
  return myPlaylists.find(item => item.id === id)
    || featuredPlaylists.find(item => item.id === id)
    || communityPlaylists.find(item => item.id === id)
    || viewedPlaylists.get(id);
}

function openPlaylist(id) {
  activePlaylistId = id;
  renderActivePlaylist();
  showView("playlist", { playlistId: id });
}

function renderActivePlaylist() {
  const playlist = findPlaylist(activePlaylistId);
  if (!playlist) return;
  const list = playlistSongs(playlist);
  const seconds = list.reduce((total, song) => total + (song.durationSeconds || 0), 0);
  const minutes = Math.round(seconds / 60);

  const mine = isMine(playlist);
  $("playlist-kind").textContent = playlist.official ? "VYBE PLAYLIST"
    : playlist.isPublic ? "PUBLIC PLAYLIST" : "PRIVATE PLAYLIST";
  $("playlist-title").textContent = playlist.name;
  $("playlist-description").textContent = playlist.description || "";
  $("playlist-description").hidden = !playlist.description;
  $("playlist-meta").textContent = plural(list.length, "song") + (minutes ? ` · ${minutes} min` : "");
  setCover($("playlist-art"), playlistCover(playlist));
  $("playlist-play").disabled = list.length === 0;
  $("playlist-shuffle").disabled = list.length === 0;
  $("playlist-rename").hidden = !mine;
  $("playlist-delete").hidden = !mine;
  $("playlist-visibility").hidden = !mine;
  $("playlist-visibility").textContent = playlist.isPublic ? "Make private" : "Make public";
  $("playlist-share").hidden = !(playlist.official || playlist.isPublic);
  $("playlist-save").hidden = mine;
  $("playlist-save").disabled = !mine && !findMyCopy(playlist) && list.length === 0;
  $("playlist-save-text").textContent = findMyCopy(playlist) ? "Open your copy" : "Save to my playlists";
  const showOwner = !playlist.official && playlist.isPublic;
  $("playlist-owner").hidden = !showOwner;
  $("playlist-owner").textContent = mine ? "Shown on your profile" : `By ${playlist.ownerName}`;
  renderSongList($("playlist-songs"), list, !mine
    ? "This playlist doesn't have any songs right now."
    : "Use + on any song to add it here.", { playlist });
}

$("playlist-play").addEventListener("click", () => {
  const playlist = findPlaylist(activePlaylistId);
  const ids = playlist ? playlistSongs(playlist).map(song => song.id) : [];
  if (ids.length) playFrom(ids, ids[0]);
});

$("playlist-shuffle").addEventListener("click", () => {
  const playlist = findPlaylist(activePlaylistId);
  const ids = playlist ? playlistSongs(playlist).map(song => song.id) : [];
  if (!ids.length) return;
  if (!isShuffle) {
    isShuffle = true;
    writeLocal("vybeShuffle", true);
    paintModes();
  }
  playFrom(ids, ids[Math.floor(Math.random() * ids.length)]);
});

function findMyCopy(playlist) {
  return myPlaylists.find(item => item.sourceId === playlist.id);
}

// Saves an independent copy: later changes to either playlist don't affect the other.
async function savePlaylistCopy(source) {
  const copy = findMyCopy(source);
  if (copy) return openPlaylist(copy.id);
  if (isMine(source)) return openPlaylist(source.id);

  const button = $("playlist-save");
  button.disabled = true;
  const { data, error } = await db.from("playlists")
    .insert({ name: source.name, owner_id: user.id, source_playlist_id: source.id })
    .select("*").single();
  if (error) {
    button.disabled = false;
    return showToast("Couldn't save this playlist. Please try again.");
  }
  const rows = playlistSongs(source).map((song, position) => ({ playlist_id: data.id, song_id: song.id, position }));
  const result = rows.length ? await db.from("playlist_songs").insert(rows) : { error: null };
  button.disabled = false;
  if (result.error) {
    await db.from("playlists").delete().eq("id", data.id); // don't leave an empty copy behind
    return showToast("Couldn't save this playlist. Please try again.");
  }
  const playlist = toPlaylist(data, displayName());
  playlist.tracks = rows.map(row => ({ songId: row.song_id, position: row.position }));
  myPlaylists.push(playlist);
  renderAll();
  openPlaylist(playlist.id);
  showToast("Saved to your playlists. You can change your copy however you like.");
}

$("playlist-save").addEventListener("click", () => {
  const playlist = findPlaylist(activePlaylistId);
  if (playlist) requireAccount("Log in to save this playlist to your account.", () => savePlaylistCopy(playlist));
});

$("playlist-visibility").addEventListener("click", async event => {
  const playlist = findPlaylist(activePlaylistId);
  if (!playlist || !isMine(playlist)) return;
  const value = !playlist.isPublic;
  if (value && !confirm(`Make "${playlist.name}" public?\n\nAnyone can see it on your profile, along with your name "${displayName()}".`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  const { data, error } = await db.from("playlists").update({ is_public: value }).eq("id", playlist.id).select("id");
  button.disabled = false;
  if (error || !data || !data.length) return showToast("Couldn't change this playlist. Please try again.");
  playlist.isPublic = value;
  renderAll();
  loadCommunityPlaylists();
  showToast(value ? "Playlist is now public." : "Playlist is now private.");
});

$("playlist-owner").addEventListener("click", () => {
  const playlist = findPlaylist(activePlaylistId);
  if (playlist && playlist.ownerId) openProfile(playlist.ownerId);
});

async function copyShareLink(path) {
  const link = `${location.origin}${location.pathname}#/${path}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copied.");
  } catch {
    prompt("Copy this link:", link);
  }
}

$("playlist-share").addEventListener("click", () => {
  if (activePlaylistId) copyShareLink(`playlist/${activePlaylistId}`);
});

/* ---------- Profiles ---------- */

function renderPeopleGrid(container, people, emptyMessage) {
  container.innerHTML = "";
  if (!people.length) {
    container.appendChild(el("p", "muted empty-state", emptyMessage));
    return;
  }
  people.forEach(person => {
    const card = el("button", "person-card");
    card.type = "button";
    const avatar = el("div", "person-avatar");
    setAvatar(avatar, person.avatarPath, person.name);
    card.append(avatar, el("b", "", person.name), el("small", "", "Profile"));
    card.addEventListener("click", () => openProfile(person.id));
    container.appendChild(card);
  });
}

function renderProfile() {
  if (!activeProfile) return;
  const mine = Boolean(user) && activeProfile.id === user.id;
  const name = mine ? displayName() : activeProfile.name;
  const avatarPath = mine ? myAvatarPath : activeProfile.avatarPath;
  const following = myFollowing.has(activeProfile.id);

  setAvatar($("profile-avatar"), avatarPath, name);
  $("profile-name").textContent = name;
  $("profile-meta").textContent = [
    plural(activeProfile.playlists.length, "public playlist"),
    plural(activeProfile.followerCount, "follower"),
    `${activeProfile.followingCount} following`
  ].join(" · ");

  $("avatar-edit").hidden = !mine;
  $("profile-edit").hidden = !mine;
  $("profile-remove-photo").hidden = !(mine && avatarPath);
  $("profile-follow").hidden = mine;
  $("profile-follow").textContent = following ? "Following" : "Follow";
  $("profile-follow").className = following ? "pill-btn" : "welcome-button";
  $("profile-follow").title = following ? `Unfollow ${name}` : `Follow ${name}`;
  $("profile-follow").setAttribute("aria-pressed", String(following));
  $("profile-share").hidden = false;

  renderPlaylistGrid($("profile-playlists"), activeProfile.playlists, mine
    ? "Nothing here yet. Open one of your playlists and choose Make public to show it here."
    : "No public playlists right now.");
  $("profile-followers-heading").textContent = `Followers (${activeProfile.followerCount})`;
  renderPeopleGrid($("profile-followers"), activeProfile.followers, "No followers yet.");
  $("profile-following-heading").textContent = `Following (${activeProfile.followingCount})`;
  renderPeopleGrid($("profile-following"), activeProfile.following, "Not following anyone yet.");
}

async function loadPeople(ids) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const { data, error } = await db.from("profiles").select("*").in("id", unique);
  return new Map((error ? [] : data).map(row => [row.id, toPerson(row)]));
}

function toPerson(row) {
  return { id: row.id, name: row.display_name, avatarPath: row.avatar_path || "" };
}

async function openProfile(id, { addToHistory = true } = {}) {
  const newestFirst = { ascending: false };
  const [profileResult, playlistsResult, followersResult, followingResult] = await Promise.all([
    db.from("profiles").select("*").eq("id", id).maybeSingle(),
    db.from("playlists").select(PLAYLIST_COLUMNS).eq("owner_id", id).eq("is_public", true)
      .order("updated_at", newestFirst),
    db.from("follows").select("follower_id,created_at", { count: "exact" }).eq("following_id", id)
      .order("created_at", newestFirst).limit(30),
    db.from("follows").select("following_id,created_at", { count: "exact" }).eq("follower_id", id)
      .order("created_at", newestFirst).limit(30)
  ]);
  if (playlistsResult.error || profileResult.error || !profileResult.data) {
    showToast("This profile isn't available.");
    return;
  }
  const followerIds = (followersResult.data || []).map(row => row.follower_id);
  const followingIds = (followingResult.data || []).map(row => row.following_id);
  const people = await loadPeople([...followerIds, ...followingIds]);
  const known = ids => ids.map(item => people.get(item)).filter(Boolean);

  const name = profileResult.data.display_name;
  const playlists = playlistsResult.data.map(row => toPlaylist(row, name));
  playlists.forEach(playlist => viewedPlaylists.set(playlist.id, playlist));
  activeProfile = {
    id,
    name,
    avatarPath: profileResult.data.avatar_path || "",
    playlists,
    followerCount: followersResult.count || 0,
    followingCount: followingResult.count || 0,
    followers: known(followerIds),
    following: known(followingIds)
  };
  renderProfile();
  showView("profile", { addToHistory, profileId: id });
}

/* Following */

async function setFollowing(target, shouldFollow) {
  const button = $("profile-follow");
  button.disabled = true;
  const { error } = shouldFollow
    ? await db.from("follows").upsert({ follower_id: user.id, following_id: target }, { ignoreDuplicates: true })
    : await db.from("follows").delete().eq("follower_id", user.id).eq("following_id", target);
  button.disabled = false;
  if (error) return showToast("Couldn't update that. Please try again.");

  if (shouldFollow) myFollowing.add(target);
  else myFollowing.delete(target);

  // The list only changes if the person on screen is still the one just followed.
  if (activeProfile && activeProfile.id === target) {
    activeProfile.followerCount = Math.max(0, activeProfile.followerCount + (shouldFollow ? 1 : -1));
    activeProfile.followers = activeProfile.followers.filter(person => person.id !== user.id);
    if (shouldFollow) activeProfile.followers.unshift({ id: user.id, name: displayName(), avatarPath: myAvatarPath });
    renderProfile();
  }
}

$("profile-follow").addEventListener("click", () => {
  if (!activeProfile) return;
  const target = activeProfile.id;
  requireAccount("Log in to follow people.", () => {
    if (user.id !== target) setFollowing(target, !myFollowing.has(target));
  });
});

/* Profile photo */

const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_AVATAR_SOURCE = 10 * 1024 * 1024;
const AVATAR_SIZE = 400;

// Crops to a centred square and re-encodes, which also strips location data from phone photos.
async function makeAvatarImage(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  canvas.getContext("2d").drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("Couldn't read the image."))), "image/jpeg", 0.85);
  });
}

$("avatar-input").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = ""; // lets you pick the same file again later
  if (!file || !user) return;
  if (!AVATAR_TYPES.includes(file.type)) return showToast("Choose a JPG, PNG or WebP image.");
  if (file.size > MAX_AVATAR_SOURCE) return showToast("That image is larger than 10 MB.");

  const label = $("avatar-edit");
  label.classList.add("busy");
  const previous = myAvatarPath;
  const path = `${user.id}/${Date.now().toString(36)}.jpg`;
  try {
    const blob = await makeAvatarImage(file);
    const upload = await db.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (upload.error) throw upload.error;
    const { data, error } = await db.from("profiles").update({ avatar_path: path }).eq("id", user.id).select("id");
    if (error || !data || !data.length) {
      await db.storage.from("avatars").remove([path]);
      throw error || new Error("Update was not allowed.");
    }
    myAvatarPath = path;
    if (previous) await db.storage.from("avatars").remove([previous]);
    renderAccount();
    renderProfile();
    showToast("Photo updated.");
  } catch (error) {
    console.error(error);
    showToast("Couldn't update your photo. Please try again.");
  } finally {
    label.classList.remove("busy");
  }
});

$("profile-remove-photo").addEventListener("click", async () => {
  if (!user || !myAvatarPath) return;
  if (!confirm("Remove your profile photo?")) return;
  const previous = myAvatarPath;
  const { data, error } = await db.from("profiles").update({ avatar_path: null }).eq("id", user.id).select("id");
  if (error || !data || !data.length) return showToast("Couldn't remove your photo. Please try again.");
  myAvatarPath = "";
  await db.storage.from("avatars").remove([previous]);
  renderAccount();
  renderProfile();
  showToast("Photo removed.");
});

/* Finding people */

let peopleSearchTimer;
let peopleSearchToken = 0;

function searchPeople(raw) {
  clearTimeout(peopleSearchTimer);
  const token = ++peopleSearchToken;
  const term = raw.trim();
  if (term.length < 2 || !db) {
    $("search-people-section").hidden = true;
    return;
  }
  peopleSearchTimer = setTimeout(async () => {
    const pattern = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
    const { data, error } = await db.from("profiles").select("*").ilike("display_name", pattern).limit(12);
    if (token !== peopleSearchToken) return; // a newer search has started
    const people = error ? [] : data.map(toPerson);
    $("search-people-section").hidden = people.length === 0;
    renderPeopleGrid($("search-people"), people, "");
  }, 250);
}

$("my-profile-btn").addEventListener("click", () => {
  closeAccountMenu();
  if (user) openProfile(user.id);
});

$("profile-share").addEventListener("click", () => {
  if (activeProfile) copyShareLink(`profile/${activeProfile.id}`);
});

$("profile-edit").addEventListener("click", () => {
  $("profile-name-input").value = displayName();
  $("name-error").textContent = "";
  $("name-dialog").showModal();
  $("profile-name-input").focus();
});

$("name-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("profile-name-input").value.trim();
  if (!name) {
    $("name-error").textContent = "Enter a name.";
    return;
  }
  const submit = $("name-submit");
  submit.disabled = true;
  const { data, error } = await db.from("profiles").update({ display_name: name }).eq("id", user.id).select("id");
  submit.disabled = false;
  if (error || !data || !data.length) {
    $("name-error").textContent = "Couldn't save your name. Please try again.";
    return;
  }
  myProfileName = name;
  myPlaylists.forEach(playlist => { playlist.ownerName = name; });
  $("name-dialog").close();
  renderAccount();
  renderAll();
  loadCommunityPlaylists();
  showToast("Name updated.");
});

/* Links shared by other people: #/playlist/<id> and #/profile/<id> */

async function openSharedLink() {
  const match = location.hash.match(/^#\/(playlist|profile)\/([0-9a-f-]{36})$/i);
  if (!match || !db) return;
  await songsReady;
  const [, kind, id] = match;
  if (kind === "profile") return openProfile(id);
  // Always ask the database: the owner may have made it private since it was last seen.
  const { data, error } = await db.from("playlists").select(PLAYLIST_COLUMNS).eq("id", id).maybeSingle();
  if (error || !data) {
    viewedPlaylists.delete(id);
    communityPlaylists = communityPlaylists.filter(item => item.id !== id);
    renderAll();
    return showToast("This playlist is private or no longer available.");
  }
  const names = await loadProfileNames([data.owner_id]);
  viewedPlaylists.set(id, toPlaylist(data, names.get(data.owner_id)));
  openPlaylist(id);
}
window.addEventListener("hashchange", openSharedLink);

let playlistDialogMode = null; // { rename: playlist } or { addSong: song }

function openPlaylistDialog(mode = {}) {
  playlistDialogMode = mode;
  $("playlist-dialog-title").textContent = mode.rename ? "Rename playlist" : "New playlist";
  $("playlist-submit").textContent = mode.rename ? "Save" : "Create";
  $("playlist-name").value = mode.rename ? mode.rename.name : "";
  $("playlist-public").checked = false;
  $("playlist-public-field").hidden = Boolean(mode.rename);
  $("playlist-error").textContent = "";
  $("playlist-dialog").showModal();
  $("playlist-name").focus();
}

function startNewPlaylist() {
  requireAccount("Log in to create playlists.", () => openPlaylistDialog());
}
["create-playlist", "create-playlist-mobile", "create-playlist-library"].forEach(id => {
  $(id).addEventListener("click", startNewPlaylist);
});

$("playlist-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = $("playlist-name").value.trim();
  if (!name) {
    $("playlist-error").textContent = "Give your playlist a name.";
    return;
  }
  const submit = $("playlist-submit");
  submit.disabled = true;
  const mode = playlistDialogMode || {};

  if (mode.rename) {
    const { data, error } = await db.from("playlists").update({ name }).eq("id", mode.rename.id).select("id");
    submit.disabled = false;
    if (error || !data || !data.length) {
      $("playlist-error").textContent = "Couldn't rename this playlist. Please try again.";
      return;
    }
    mode.rename.name = name;
    $("playlist-dialog").close();
    renderAll();
    showToast("Playlist renamed.");
    return;
  }

  const row = { name, owner_id: user.id };
  if ($("playlist-public").checked) row.is_public = true;
  const { data, error } = await db.from("playlists").insert(row).select("*").single();
  submit.disabled = false;
  if (error) {
    $("playlist-error").textContent = "Couldn't create this playlist. Please try again.";
    return;
  }
  const playlist = toPlaylist(data, displayName());
  myPlaylists.push(playlist);
  if (playlist.isPublic) loadCommunityPlaylists();
  $("playlist-dialog").close();
  if (mode.addSong) {
    await addTrack(playlist, mode.addSong);
    renderAll();
  } else {
    renderAll();
    openPlaylist(playlist.id);
    showToast("Playlist created.");
  }
});

$("playlist-rename").addEventListener("click", () => {
  const playlist = findPlaylist(activePlaylistId);
  if (playlist && isMine(playlist)) openPlaylistDialog({ rename: playlist });
});

$("playlist-delete").addEventListener("click", async () => {
  const playlist = findPlaylist(activePlaylistId);
  if (!playlist || !isMine(playlist)) return;
  if (!confirm(`Delete "${playlist.name}"? The songs themselves stay on VYBE.${playlist.isPublic ? " It will also disappear from your profile." : ""}`)) return;
  const { data, error } = await db.from("playlists").delete().eq("id", playlist.id).select("id");
  if (error || !data || !data.length) return showToast("Couldn't delete this playlist.");
  myPlaylists = myPlaylists.filter(item => item !== playlist);
  communityPlaylists = communityPlaylists.filter(item => item.id !== playlist.id);
  viewedPlaylists.delete(playlist.id);
  activePlaylistId = null;
  viewHistory = viewHistory.filter(entry => entry.playlistId !== playlist.id);
  historyPosition = Math.max(0, Math.min(historyPosition, viewHistory.length - 1));
  showView("library");
  renderAll();
  showToast("Playlist deleted.");
});

async function addTrack(playlist, song) {
  if (playlist.tracks.some(track => track.songId === song.id)) {
    showToast(`Already in ${playlist.name}`);
    return;
  }
  const position = playlist.tracks.reduce((highest, track) => Math.max(highest, track.position + 1), 0);
  const { error } = await db.from("playlist_songs").insert({ playlist_id: playlist.id, song_id: song.id, position });
  if (error) {
    showToast("Couldn't add this song. Please try again.");
    return;
  }
  playlist.tracks.push({ songId: song.id, position });
  showToast(`Added to ${playlist.name}`);
}

async function removeTrack(playlist, song) {
  const { error } = await db.from("playlist_songs").delete().eq("playlist_id", playlist.id).eq("song_id", song.id);
  if (error) return showToast("Couldn't remove this song. Please try again.");
  playlist.tracks = playlist.tracks.filter(track => track.songId !== song.id);
  renderAll();
  showToast("Removed from playlist.");
}

// Swaps a song with its neighbour by trading their stored positions.
async function moveTrack(playlist, list, index, step) {
  const other = list[index + step];
  if (!other) return;
  const first = playlist.tracks.find(track => track.songId === list[index].id);
  const second = playlist.tracks.find(track => track.songId === other.id);
  const results = await Promise.all([
    db.from("playlist_songs").update({ position: second.position }).eq("playlist_id", playlist.id).eq("song_id", first.songId),
    db.from("playlist_songs").update({ position: first.position }).eq("playlist_id", playlist.id).eq("song_id", second.songId)
  ]);
  if (results.some(result => result.error)) return showToast("Couldn't move this song. Please try again.");
  [first.position, second.position] = [second.position, first.position];
  playlist.tracks.sort((a, b) => a.position - b.position);
  renderAll();
}

let songToAdd = null;

function openAddDialog(song) {
  requireAccount("Log in to add songs to your playlists.", () => {
    songToAdd = song;
    $("add-song-name").textContent = song.title;
    const box = $("add-options");
    box.innerHTML = "";
    if (!myPlaylists.length) box.appendChild(el("p", "muted", "You don't have any playlists yet."));
    myPlaylists.forEach(playlist => {
      const has = playlist.tracks.some(track => track.songId === song.id);
      const option = el("button", "add-option");
      option.type = "button";
      option.disabled = has;
      option.append(el("b", "", playlist.name), el("small", "", has ? "Already added" : plural(playlistSongs(playlist).length, "song")));
      option.addEventListener("click", async () => {
        option.disabled = true;
        await addTrack(playlist, song);
        $("add-dialog").close();
        renderAll();
      });
      box.appendChild(option);
    });
    $("add-dialog").showModal();
  });
}

$("add-new-playlist").addEventListener("click", () => {
  $("add-dialog").close();
  openPlaylistDialog({ addSong: songToAdd });
});

/* ---------- Dialogs ---------- */

document.querySelectorAll("dialog").forEach(dialog => {
  dialog.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => dialog.close());
  });
  // Clicking the dimmed area closes the dialog, except the one that must be finished.
  if (dialog.id === "password-dialog") return;
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close();
  });
});
// Closing without logging in forgets what was waiting. A successful log in also closes
// this dialog, so check the saved login rather than whether the page has caught up yet.
$("auth-dialog").addEventListener("close", async () => {
  const { data } = await db.auth.getSession();
  if (!data.session) pendingAction = null;
});

/* ---------- Start up ---------- */

volume.value = Math.min(1, Math.max(0, Number(readLocal("vybeVolume", 0.7)) || 0));
audio.volume = Number(volume.value);
paintRange(volume);
paintRange(progress);
paintModes();
renderAccount();
renderAll();
const songsReady = loadSongs();
loadFeaturedPlaylists();
loadCommunityPlaylists();
openSharedLink();

if (db) {
  // Supabase holds a lock during this callback, so database calls must run after it returns.
  db.auth.onAuthStateChange((event, session) => {
    setTimeout(() => applyAuthChange(event, session ? session.user : null), 0);
  });
}

// The browser's Back and Forward buttons can restore a frozen copy of this page from
// before a log out, without running any code. Hide it on the way out, then check who
// is really logged in before showing it again.
window.addEventListener("pagehide", event => {
  if (event.persisted) document.body.style.visibility = "hidden";
});
async function recheckSession() {
  if (!db) return;
  const { data } = await db.auth.getSession();
  await applyAuthChange("SESSION_CHECK", data.session ? data.session.user : null);
}
window.addEventListener("pageshow", async event => {
  if (!event.persisted) return;
  try {
    await recheckSession();
  } finally {
    document.body.style.visibility = "";
  }
});

// Pick up newly published / unpublished songs without a manual reload.
function refreshLibrary() {
  loadSongs({ silent: true });
  loadFeaturedPlaylists();
  loadCommunityPlaylists();
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  recheckSession(); // may have logged out in another tab
  refreshLibrary();
});
window.addEventListener("online", refreshLibrary);
setInterval(() => { if (!document.hidden) refreshLibrary(); }, 120000);

/* ---------- Space for the host's badge ---------- */

// Netlify's free plan pins a badge over the bottom-right corner. The layout only makes
// room for it while it's on the page, so nothing changes on a host without one.
function watchHostBadge() {
  const update = () => {
    document.body.classList.toggle("has-host-badge", Boolean($("nl-badge-frame")));
  };
  update();
  new MutationObserver(update).observe(document.body, { childList: true });
}
watchHostBadge();

/* ---------- Install button ---------- */

const installBtn = $("install-btn");
let installPrompt = null;

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener("appinstalled", () => { installBtn.hidden = true; });

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .catch(error => console.error("Service worker registration failed:", error));
  });
}
