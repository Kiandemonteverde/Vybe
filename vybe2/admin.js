const cfg = window.VYBE_CONFIG || {};
const $ = id => document.getElementById(id);

const ready = Boolean(
  window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.includes("YOUR-PROJECT")
);
const db = ready ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

const MAX_AUDIO = 50 * 1024 * 1024;
const MAX_COVER = 5 * 1024 * 1024;
const COVER_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

let adminSongs = [];
let adminPlaylists = [];
let playlistsAvailable = true; // false until supabase/accounts-and-playlists.sql has been run
let filter = "all";
let songSearch = "";
let shownSongs = [];
let editingSong = null;
let toastTimer;

/* ---------- Small helpers ---------- */

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2800);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const clean = value => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

function coverUrl(path) {
  return path ? db.storage.from("covers").getPublicUrl(path).data.publicUrl : "";
}

function validateAudio(file) {
  if (!/\.mp3$/i.test(file.name)) return "Audio must be an MP3 file.";
  if (file.size > MAX_AUDIO) return "The MP3 is larger than 50 MB.";
  return "";
}

function validateCover(file) {
  if (!COVER_TYPES[file.type]) return "Cover must be a JPG, PNG or WebP image.";
  if (file.size > MAX_COVER) return "The cover image is larger than 5 MB.";
  return "";
}

function readDuration(file) {
  return new Promise(resolve => {
    const probe = new Audio();
    const url = URL.createObjectURL(file);
    const finish = value => { URL.revokeObjectURL(url); resolve(value); };
    probe.preload = "metadata";
    probe.onloadedmetadata = () => finish(Number.isFinite(probe.duration) ? Math.round(probe.duration) : null);
    probe.onerror = () => finish(null);
    probe.src = url;
  });
}

const stamp = () => Date.now().toString(36);
const removeFiles = (bucket, paths) => paths.length ? db.storage.from(bucket).remove(paths) : Promise.resolve();

/* ---------- Screens & authentication ---------- */

function showLogin(message = "") {
  // Nothing from the dashboard stays in the page once it's locked.
  closePreview();
  document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
  adminSongs = [];
  adminPlaylists = [];
  shownSongs = [];
  ["admin-songs", "admin-playlists", "admin-community", "admin-photos", "admin-email"].forEach(id => { $(id).textContent = ""; });
  $("dashboard").hidden = true;
  $("login-screen").hidden = false;
  $("login-error").textContent = message;
}

function showDashboard(user) {
  $("login-screen").hidden = true;
  $("dashboard").hidden = false;
  $("admin-email").textContent = user.email || "";
}

async function enterIfAdmin(user) {
  // Policy "admins can read own row" only returns a row for real admins.
  // Listeners stay logged in to the player; they just can't get past this screen.
  const { data, error } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (error || !data) {
    showLogin("This account is not authorized to manage VYBE.");
    return;
  }
  showDashboard(user);
  await Promise.all([loadAdminSongs(), loadAdminPlaylists(), loadCommunity(), loadProfilePhotos()]);
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("login-submit");
  button.disabled = true;
  $("login-error").textContent = "";
  const { data, error } = await db.auth.signInWithPassword({
    email: $("login-email").value.trim(),
    password: $("login-password").value
  });
  if (error || !data.user) {
    // Same message for every failure, so it never reveals which part was wrong.
    $("login-error").textContent = "Incorrect email or password.";
  } else {
    $("login-password").value = "";
    await enterIfAdmin(data.user);
  }
  button.disabled = false;
});

$("signout-btn").addEventListener("click", async () => {
  closePreview();
  const { error } = await db.auth.signOut();
  // Supabase keeps the session if its server can't be reached (for example offline),
  // but this device must still end up logged out, so forget the saved login here.
  if (error) localStorage.removeItem(`sb-${new URL(cfg.SUPABASE_URL).hostname.split(".")[0]}-auth-token`);
  showLogin();
});

/* ---------- Loading & rendering ---------- */

async function loadAdminSongs() {
  const { data, error } = await db.from("songs").select("*").order("created_at", { ascending: false });
  if (error) {
    toast("Couldn't load songs. Check your connection and refresh.");
    return;
  }
  adminSongs = data;
  renderAdminSongs();
}

function renderAdminSongs() {
  const published = adminSongs.filter(song => song.published).length;
  $("stat-total").textContent = adminSongs.length;
  $("stat-published").textContent = published;
  $("stat-drafts").textContent = adminSongs.length - published;
  const drafts = adminSongs.length - published;
  $("publish-all").hidden = drafts === 0;
  $("publish-all").textContent = drafts === 1 ? "Publish 1 draft" : `Publish all ${drafts} drafts`;

  const list = $("admin-songs");
  list.innerHTML = "";
  const term = songSearch.trim().toLowerCase();
  const shown = adminSongs.filter(song =>
    (filter === "all" || (filter === "published" ? song.published : !song.published)) &&
    (!term || [song.title, song.artist, song.album, song.genre].some(field => (field || "").toLowerCase().includes(term))));

  // Only offered while searching, so it can't change the whole library by accident.
  shownSongs = term ? shown : [];
  $("set-genre-shown").hidden = shownSongs.length === 0;
  $("set-genre-shown").textContent = shown.length === 1 ? "Set genre for this song" : `Set genre for these ${shown.length} songs`;

  if (!shown.length) {
    list.appendChild(el("p", "muted",
      adminSongs.length ? "No songs in this view." : "No songs yet. Upload your first MP3 above."));
    return;
  }

  shown.forEach(song => {
    const row = el("div", "admin-row");

    const art = el("div", "song-art");
    const url = coverUrl(song.cover_path);
    if (url) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = url;
      art.appendChild(img);
    } else {
      art.textContent = "♫";
    }

    const info = el("div", "admin-info");
    info.appendChild(el("h4", "", song.title));
    const meta = [song.artist, song.album, song.genre].filter(Boolean).join(" · ");
    info.appendChild(el("p", "muted", meta));

    const badge = el("span", song.published ? "badge live" : "badge draft", song.published ? "Published" : "Draft");

    const actions = el("div", "admin-actions");
    const previewBtn = el("button", "btn ghost small", "▶ Preview");
    previewBtn.addEventListener("click", () => previewSong(song));
    const publishBtn = el("button", song.published ? "btn ghost small" : "btn primary small", song.published ? "Unpublish" : "Publish");
    publishBtn.addEventListener("click", () => setPublished(song, !song.published, publishBtn));
    const editBtn = el("button", "btn ghost small", "Edit");
    editBtn.addEventListener("click", () => openEdit(song));
    const deleteBtn = el("button", "btn danger small", "Delete");
    deleteBtn.addEventListener("click", () => deleteSong(song, deleteBtn));
    actions.append(previewBtn, publishBtn, editBtn, deleteBtn);

    row.append(art, info, badge, actions);
    list.appendChild(row);
  });
}

document.querySelectorAll(".tab[data-filter]").forEach(tab => {
  tab.addEventListener("click", () => {
    filter = tab.dataset.filter;
    document.querySelectorAll(".tab[data-filter]").forEach(item => item.classList.toggle("active", item === tab));
    renderAdminSongs();
  });
});

$("set-genre-shown").addEventListener("click", async event => {
  const count = shownSongs.length;
  if (!count) return;
  const answer = prompt(`Genre for ${count === 1 ? "this song" : `these ${count} songs`}?\n\nThis replaces any genre they have now.`, "OPM");
  if (answer === null) return;
  const genre = clean(answer);
  if (!genre) return toast("Enter a genre.");
  const button = event.currentTarget;
  button.disabled = true;
  let updated = 0;
  for (let at = 0; at < count; at += 100) {
    const ids = shownSongs.slice(at, at + 100).map(song => song.id);
    const { data, error } = await db.from("songs").update({ genre: genre.slice(0, 100) }).in("id", ids).select("id");
    if (error || !data) {
      toast(`Updated ${updated} of ${count}, then something went wrong. Please try again.`);
      button.disabled = false;
      await loadAdminSongs();
      return;
    }
    updated += data.length;
  }
  button.disabled = false;
  toast(`Set ${updated === 1 ? "1 song" : `${updated} songs`} to ${genre}.`);
  await loadAdminSongs();
});

$("song-search").addEventListener("input", event => {
  songSearch = event.target.value;
  renderAdminSongs();
});

/* ---------- Playlists: list ---------- */

async function loadAdminPlaylists() {
  const { data, error } = await db
    .from("playlists")
    .select("id,name,description,cover_path,published,created_at,playlist_songs(song_id,position)")
    .eq("is_official", true)
    .order("created_at", { ascending: false });
  playlistsAvailable = !error;
  adminPlaylists = error ? [] : data.map(row => ({
    ...row,
    tracks: row.playlist_songs.slice().sort((a, b) => a.position - b.position).map(track => track.song_id)
  }));
  renderAdminPlaylists();
}

function renderAdminPlaylists() {
  $("stat-playlists").textContent = adminPlaylists.length;
  renderPlaylistOptions();

  const list = $("admin-playlists");
  list.innerHTML = "";
  if (!playlistsAvailable) {
    list.appendChild(el("p", "form-error", "Playlists aren't switched on yet. Run supabase/accounts-and-playlists.sql in the Supabase SQL Editor, then refresh."));
    return;
  }
  if (!adminPlaylists.length) {
    list.appendChild(el("p", "muted", "No playlists yet. Switch the upload above to Playlist to add your first one."));
    return;
  }

  adminPlaylists.forEach(playlist => {
    const row = el("div", "admin-row");

    const art = el("div", "song-art");
    const url = coverUrl(playlist.cover_path);
    if (url) {
      const img = el("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = url;
      art.appendChild(img);
    } else {
      art.textContent = "♫";
    }

    const info = el("div", "admin-info");
    info.appendChild(el("h4", "", playlist.name));
    info.appendChild(el("p", "muted", playlist.tracks.length === 1 ? "1 song" : `${playlist.tracks.length} songs`));

    const badge = el("span", playlist.published ? "badge live" : "badge draft", playlist.published ? "Published" : "Draft");

    const actions = el("div", "admin-actions");
    const publishBtn = el("button", playlist.published ? "btn ghost small" : "btn primary small", playlist.published ? "Unpublish" : "Publish");
    publishBtn.addEventListener("click", () => setPlaylistPublished(playlist, !playlist.published, publishBtn));
    const editBtn = el("button", "btn ghost small", "Edit");
    editBtn.addEventListener("click", () => openPlaylistEditor(playlist));
    const deleteBtn = el("button", "btn danger small", "Delete");
    deleteBtn.addEventListener("click", () => deletePlaylist(playlist, deleteBtn));
    actions.append(publishBtn, editBtn, deleteBtn);

    row.append(art, info, badge, actions);
    list.appendChild(row);
  });
}

// Publishing a playlist also publishes its draft songs, otherwise it would look empty.
async function setPlaylistPublished(playlist, value, button) {
  const drafts = adminSongs.filter(song => !song.published && playlist.tracks.includes(song.id));
  if (value && drafts.length && !confirm(`Publish "${playlist.name}"? This also publishes its ${drafts.length === 1 ? "draft song" : `${drafts.length} draft songs`}, so everyone can hear them.`)) return;
  button.disabled = true;
  if (value && drafts.length) {
    const { error } = await db.from("songs").update({ published: true }).in("id", drafts.map(song => song.id));
    if (error) {
      button.disabled = false;
      return toast("Couldn't publish the songs in this playlist.");
    }
  }
  const { data, error } = await db.from("playlists").update({ published: value }).eq("id", playlist.id).select("id");
  button.disabled = false;
  if (error || !data || !data.length) return toast(value ? "Couldn't publish this playlist." : "Couldn't unpublish this playlist.");
  toast(value ? "Playlist published." : "Playlist unpublished. Its songs stay in your library.");
  await Promise.all([loadAdminSongs(), loadAdminPlaylists()]);
}

async function deletePlaylist(playlist, button) {
  if (!confirm(`Delete the playlist "${playlist.name}"?\n\nIts songs stay in your library.`)) return;
  button.disabled = true;
  const { data, error } = await db.from("playlists").delete().eq("id", playlist.id).select("id");
  if (error || !data || !data.length) {
    button.disabled = false;
    return toast("Couldn't delete this playlist.");
  }
  if (playlist.cover_path) await removeFiles("covers", [playlist.cover_path]);
  toast("Playlist deleted.");
  await loadAdminPlaylists();
}

/* ---------- Community playlists ---------- */

async function loadCommunity() {
  const list = $("admin-community");
  const { data, error } = await db
    .from("playlists")
    .select("id,name,owner_id,updated_at,playlist_songs(song_id)")
    .eq("is_public", true)
    .order("updated_at", { ascending: false })
    .limit(100);
  list.innerHTML = "";
  if (error) {
    list.appendChild(el("p", "form-error", "Community playlists aren't switched on yet. Run supabase/public-playlists-and-profiles.sql in the Supabase SQL Editor, then refresh."));
    return;
  }
  if (!data.length) {
    list.appendChild(el("p", "muted", "No listener has made a playlist public yet."));
    return;
  }

  const ownerIds = [...new Set(data.map(row => row.owner_id))];
  const profiles = await db.from("profiles").select("id,display_name").in("id", ownerIds);
  const names = new Map((profiles.data || []).map(row => [row.id, row.display_name]));

  data.forEach(playlist => {
    const row = el("div", "admin-row community-row");
    const art = el("div", "song-art", "♫");
    const info = el("div", "admin-info");
    info.appendChild(el("h4", "", playlist.name));
    const count = playlist.playlist_songs.length;
    info.appendChild(el("p", "muted", `By ${names.get(playlist.owner_id) || "Listener"} · ${count === 1 ? "1 song" : `${count} songs`}`));

    const actions = el("div", "admin-actions");
    const hideBtn = el("button", "btn danger small", "Hide");
    hideBtn.addEventListener("click", () => hideCommunityPlaylist(playlist, hideBtn));
    const resetBtn = el("button", "btn ghost small", "Reset name");
    resetBtn.addEventListener("click", () => resetListenerName(playlist.owner_id, names.get(playlist.owner_id), resetBtn));
    actions.append(resetBtn, hideBtn);

    row.append(art, info, actions);
    list.appendChild(row);
  });
}

async function hideCommunityPlaylist(playlist, button) {
  if (!confirm(`Hide "${playlist.name}"?\n\nIt becomes private again. The listener keeps it, but others can no longer see it.`)) return;
  button.disabled = true;
  const { data, error } = await db.rpc("hide_public_playlist", { target: playlist.id });
  button.disabled = false;
  if (error || !data) return toast("Couldn't hide this playlist.");
  toast("Playlist hidden.");
  await loadCommunity();
}

async function resetListenerName(ownerId, name, button) {
  if (!confirm(`Reset "${name || "this name"}" to "Listener"?`)) return;
  button.disabled = true;
  const { data, error } = await db.rpc("reset_profile_name", { target: ownerId });
  button.disabled = false;
  if (error || !data) return toast("Couldn't reset this name.");
  toast("Name reset.");
  await Promise.all([loadCommunity(), loadProfilePhotos()]);
}

/* ---------- Profile photos ---------- */

async function loadProfilePhotos() {
  const list = $("admin-photos");
  const { data, error } = await db
    .from("profiles")
    .select("id,display_name,avatar_path,created_at")
    .not("avatar_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  list.innerHTML = "";
  if (error) {
    list.appendChild(el("p", "form-error", "Profile photos aren't switched on yet. Run supabase/follows-and-photos.sql in the Supabase SQL Editor, then refresh."));
    return;
  }
  if (!data.length) {
    list.appendChild(el("p", "muted", "No listener has added a photo yet."));
    return;
  }

  data.forEach(profile => {
    const row = el("div", "admin-row community-row");
    const art = el("div", "song-art person-photo");
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = db.storage.from("avatars").getPublicUrl(profile.avatar_path).data.publicUrl;
    art.appendChild(img);
    const info = el("div", "admin-info");
    info.appendChild(el("h4", "", profile.display_name));

    const actions = el("div", "admin-actions");
    const resetBtn = el("button", "btn ghost small", "Reset name");
    resetBtn.addEventListener("click", () => resetListenerName(profile.id, profile.display_name, resetBtn));
    const removeBtn = el("button", "btn danger small", "Remove photo");
    removeBtn.addEventListener("click", () => removeListenerPhoto(profile, removeBtn));
    actions.append(resetBtn, removeBtn);

    row.append(art, info, actions);
    list.appendChild(row);
  });
}

async function removeListenerPhoto(profile, button) {
  if (!confirm(`Remove the photo of "${profile.display_name}"?`)) return;
  button.disabled = true;
  const { data, error } = await db.rpc("remove_profile_photo", { target: profile.id });
  button.disabled = false;
  if (error || !data) return toast("Couldn't remove this photo.");
  await removeFiles("avatars", [profile.avatar_path]);
  toast("Photo removed.");
  await loadProfilePhotos();
}

/* ---------- Playlists: edit ---------- */

let editingPlaylist = null;
let editorTracks = [];

function openPlaylistEditor(playlist) {
  editingPlaylist = playlist;
  editorTracks = [...playlist.tracks];
  $("pl-name").value = playlist.name;
  $("pl-desc").value = playlist.description || "";
  $("pl-cover").value = "";
  $("pl-remove-cover").checked = false;
  $("pl-remove-cover").disabled = !playlist.cover_path;
  $("pl-error").textContent = "";
  renderEditorTracks();
  $("pl-dialog").showModal();
}

function renderEditorTracks() {
  const box = $("pl-tracks");
  box.innerHTML = "";
  if (!editorTracks.length) box.appendChild(el("p", "muted", "No songs in this playlist."));

  editorTracks.forEach((id, index) => {
    const song = adminSongs.find(item => item.id === id);
    const row = el("div", "pl-track");
    row.appendChild(el("span", "", song ? `${song.title} · ${song.artist}` : "Unknown song"));
    const addControl = (label, text, disabled, action) => {
      const button = el("button", "", text);
      button.type = "button";
      button.disabled = disabled;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", action);
      row.appendChild(button);
    };
    const move = step => () => {
      [editorTracks[index], editorTracks[index + step]] = [editorTracks[index + step], editorTracks[index]];
      renderEditorTracks();
    };
    addControl("Move up", "↑", index === 0, move(-1));
    addControl("Move down", "↓", index === editorTracks.length - 1, move(1));
    addControl("Remove from playlist", "✕", false, () => {
      editorTracks.splice(index, 1);
      renderEditorTracks();
    });
    box.appendChild(row);
  });

  const select = $("pl-add-song");
  select.innerHTML = "";
  const available = adminSongs.filter(song => !editorTracks.includes(song.id));
  available.forEach(song => {
    const option = el("option", "", `${song.title} · ${song.artist}${song.published ? "" : " (draft)"}`);
    option.value = song.id;
    select.appendChild(option);
  });
  select.disabled = !available.length;
  $("pl-add-btn").disabled = !available.length;
}

$("pl-add-btn").addEventListener("click", () => {
  if (!$("pl-add-song").value) return;
  editorTracks.push($("pl-add-song").value);
  renderEditorTracks();
});
$("pl-cancel").addEventListener("click", () => $("pl-dialog").close());

$("pl-form").addEventListener("submit", async event => {
  event.preventDefault();
  const playlist = editingPlaylist;
  if (!playlist) return;

  const newCover = $("pl-cover").files[0];
  const problem = newCover && validateCover(newCover);
  if (problem) {
    $("pl-error").textContent = problem;
    return;
  }

  const submit = $("pl-submit");
  submit.disabled = true;
  $("pl-error").textContent = "";
  let uploadedCover = null;
  let obsoleteCover = null;
  const changes = { name: $("pl-name").value.trim(), description: clean($("pl-desc").value) };

  try {
    if (newCover) {
      uploadedCover = await uploadPlaylistCover(playlist.id, newCover);
      obsoleteCover = playlist.cover_path;
      changes.cover_path = uploadedCover;
    } else if ($("pl-remove-cover").checked && playlist.cover_path) {
      obsoleteCover = playlist.cover_path;
      changes.cover_path = null;
    }

    const { data, error } = await db.from("playlists").update(changes).eq("id", playlist.id).select("id");
    if (error || !data || !data.length) throw error || new Error("Update was not allowed.");
    uploadedCover = null; // the row now points at it, so it must not be rolled back

    const removed = playlist.tracks.filter(id => !editorTracks.includes(id));
    if (removed.length) {
      const result = await db.from("playlist_songs").delete().eq("playlist_id", playlist.id).in("song_id", removed);
      if (result.error) throw result.error;
    }
    if (editorTracks.length) {
      const rows = editorTracks.map((id, position) => ({ playlist_id: playlist.id, song_id: id, position }));
      const result = await db.from("playlist_songs").upsert(rows, { onConflict: "playlist_id,song_id" });
      if (result.error) throw result.error;
    }

    if (obsoleteCover) await removeFiles("covers", [obsoleteCover]);
    $("pl-dialog").close();
    toast("Playlist saved.");
    await loadAdminPlaylists();
  } catch (error) {
    console.error(error);
    if (uploadedCover) await removeFiles("covers", [uploadedCover]);
    $("pl-error").textContent = `Couldn't save the playlist: ${error.message || "please try again."}`;
    await loadAdminPlaylists();
  } finally {
    submit.disabled = false;
  }
});

async function uploadPlaylistCover(playlistId, file) {
  const path = `playlist-${playlistId}-${stamp()}.${COVER_TYPES[file.type]}`;
  const { error } = await db.storage.from("covers").upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

/* ---------- Reading MP3 tags ---------- */

const MAX_TAG_BYTES = 8 * 1024 * 1024;
const syncsafe = (bytes, at) => (bytes[at] << 21) | (bytes[at + 1] << 14) | (bytes[at + 2] << 7) | bytes[at + 3];

function decodeTagText(bytes, encoding) {
  let label = ["windows-1252", "utf-16le", "utf-16be", "utf-8"][encoding] || "utf-8";
  if (encoding === 1 && bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  return new TextDecoder(label).decode(bytes).replace(/^\ufeff/, "").replace(/\0+$/, "").replace(/\0/g, ", ").trim();
}

function readPictureFrame(body) {
  const encoding = body[0];
  let at = body.indexOf(0, 1);
  if (at < 0) return null;
  const type = decodeTagText(body.subarray(1, at), 0).toLowerCase();
  at += 2; // skip the end of the MIME type and the picture type byte
  const wide = encoding === 1 || encoding === 2;
  while (at < body.length) { // skip the description
    if (!wide && body[at] === 0) { at += 1; break; }
    if (wide && body[at] === 0 && body[at + 1] === 0) { at += 2; break; }
    at += wide ? 2 : 1;
  }
  const mime = type === "image/jpg" ? "image/jpeg" : type;
  if (!COVER_TYPES[mime] || at >= body.length || body.length - at > MAX_COVER) return null;
  return new File([body.subarray(at)], `cover.${COVER_TYPES[mime]}`, { type: mime });
}

// Reads title, artist, album, genre, track number and artwork from an ID3v2.3/2.4 tag.
// Any file it can't understand just falls back to its file name.
async function readTags(file) {
  const tags = {};
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
    const version = head[3];
    if (!isId3 || version < 3 || version > 4 || head[5] & 0x80) return tags;

    const size = Math.min(syncsafe(head, 6), MAX_TAG_BYTES);
    const bytes = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
    const view = new DataView(bytes.buffer);
    let at = 0;
    if (head[5] & 0x40) at = version === 4 ? syncsafe(bytes, 0) : view.getUint32(0) + 4;

    const textFrames = { TIT2: "title", TPE1: "artist", TALB: "album", TCON: "genre", TRCK: "track" };
    while (at + 10 <= bytes.length && bytes[at] !== 0) {
      const id = String.fromCharCode(...bytes.subarray(at, at + 4));
      const frameSize = version === 4 ? syncsafe(bytes, at + 4) : view.getUint32(at + 4);
      if (frameSize <= 0 || at + 10 + frameSize > bytes.length) break;
      const body = bytes.subarray(at + 10, at + 10 + frameSize);
      if (bytes[at + 9] === 0) { // compressed or encrypted frames are skipped
        if (textFrames[id]) tags[textFrames[id]] = decodeTagText(body.subarray(1), body[0]);
        if (id === "APIC" && !tags.picture) tags.picture = readPictureFrame(body);
      }
      at += 10 + frameSize;
    }
  } catch (error) {
    console.warn("Couldn't read tags from", file.name, error);
  }
  if (tags.genre && /^\(?\d+\)?$/.test(tags.genre)) delete tags.genre; // old numeric genre codes
  if (tags.track) tags.track = parseInt(tags.track, 10) || undefined;
  return tags;
}

/* ---------- Upload (songs or a whole playlist) ---------- */

const CONCURRENCY = 3; // how many files upload at the same time
let queue = [];        // { file, title, artist, album, genre, track, picture, songId, state, error, statusEl, artistInput }
let uploading = false;
let uploadMode = "songs";

const UPLOAD_HELP = {
  songs: "Choose one song or many. Songs are saved as drafts unless you tick “Publish as soon as uploaded”.",
  playlist: "Choose a folder or a set of MP3s and they upload together as one playlist, in the order shown. Use the arrows to change the order."
};

function setUploadMode(mode) {
  uploadMode = mode;
  document.querySelectorAll(".tab[data-mode]").forEach(tab => {
    const active = tab.dataset.mode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-pressed", String(active));
  });
  $("upload-help").textContent = UPLOAD_HELP[mode];
  $("playlist-fields").hidden = mode !== "playlist";
  $("up-publish-text").textContent = mode === "playlist"
    ? "Publish the playlist and its songs as soon as they're uploaded"
    : "Publish as soon as uploaded";
  renderQueue();
}

document.querySelectorAll(".tab[data-mode]").forEach(tab => {
  tab.addEventListener("click", () => { if (!uploading) setUploadMode(tab.dataset.mode); });
});

function renderPlaylistOptions() {
  const select = $("up-playlist");
  const selected = select.value;
  select.innerHTML = "";
  const fresh = el("option", "", "A new playlist");
  fresh.value = "new";
  select.appendChild(fresh);
  adminPlaylists.forEach(playlist => {
    const option = el("option", "", playlist.name);
    option.value = playlist.id;
    select.appendChild(option);
  });
  select.value = adminPlaylists.some(playlist => playlist.id === selected) ? selected : "new";
  updatePlaylistFields();
}

function updatePlaylistFields() {
  const isNew = $("up-playlist").value === "new";
  $("up-pl-name-field").hidden = !isNew;
  $("up-pl-desc-field").hidden = !isNew;
}
$("up-playlist").addEventListener("change", updatePlaylistFields);

// "03 - Artist - Song_Name.mp3" → { artist: "Artist", title: "Song Name" }
function guessFromFilename(name) {
  let base = name.replace(/\.mp3$/i, "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  base = base.replace(/^\d{1,3}\s*[-.)]\s+/, ""); // leading track number such as "03 - " or "03. "
  const match = base.match(/^(.+?)\s+-\s+(.+)$/);
  const artist = match ? match[1].trim() : "";
  const title = match ? match[2].trim() : base;
  return { artist: artist.slice(0, 200), title: title.slice(0, 200) };
}

const naturalOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// New files join the end of the list, sorted by track number, then by file name.
async function addFiles(files) {
  const mp3s = files.filter(file => /\.mp3$/i.test(file.name) || file.type === "audio/mpeg");
  const skipped = files.length - mp3s.length;
  const fresh = mp3s.filter(file => !queue.some(item => item.file.name === file.name && item.file.size === file.size));
  if (!mp3s.length) {
    if (skipped) toast("No MP3 files found there.");
    return;
  }

  $("upload-status").textContent = `Reading ${fresh.length === 1 ? "1 file" : `${fresh.length} files`}…`;
  const items = await Promise.all(fresh.map(async file => {
    const error = validateAudio(file);
    const tags = error ? {} : await readTags(file);
    const guess = guessFromFilename(file.name);
    return {
      file,
      title: (tags.title || guess.title).slice(0, 200),
      artist: (tags.artist || guess.artist).slice(0, 200),
      album: tags.album ? tags.album.slice(0, 200) : null,
      genre: tags.genre ? tags.genre.slice(0, 100) : null,
      track: tags.track,
      picture: tags.picture || null,
      state: error ? "invalid" : "queued",
      error
    };
  }));
  $("upload-status").textContent = "";

  items.sort((a, b) => (a.track ?? Infinity) - (b.track ?? Infinity) || naturalOrder.compare(a.file.name, b.file.name));
  queue.push(...items);
  renderQueue();
  if (skipped) toast(`Skipped ${skipped === 1 ? "1 file" : `${skipped} files`} that ${skipped === 1 ? "isn't an MP3" : "aren't MP3s"}.`);
}

/* Dragging in files or folders */

function readDirectory(entry) {
  const reader = entry.createReader();
  return new Promise((resolve, reject) => {
    const all = [];
    const readBatch = () => reader.readEntries(batch => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

async function filesFromEntry(entry) {
  if (entry.isFile) return [await new Promise((resolve, reject) => entry.file(resolve, reject))];
  const children = await readDirectory(entry);
  return (await Promise.all(children.map(filesFromEntry))).flat();
}

const dropZone = $("drop-zone");
["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => {
  event.preventDefault();
  dropZone.classList.add("over");
}));
dropZone.addEventListener("dragleave", event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("over");
});
dropZone.addEventListener("drop", async event => {
  event.preventDefault();
  dropZone.classList.remove("over");
  if (uploading) return;
  const entries = Array.from(event.dataTransfer.items || [])
    .map(item => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null));
  const droppedFiles = Array.from(event.dataTransfer.files);
  try {
    const files = entries.length && entries.every(Boolean)
      ? (await Promise.all(entries.map(filesFromEntry))).flat()
      : droppedFiles;
    const folder = entries.find(entry => entry && entry.isDirectory);
    if (folder && !$("up-pl-name").value.trim()) $("up-pl-name").value = folder.name.slice(0, 100);
    await addFiles(files);
  } catch (error) {
    console.error(error);
    toast("Couldn't read those files. Try Choose files instead.");
  }
});

function paintStatus(item) {
  if (!item.statusEl) return;
  const text = {
    queued: "Ready",
    invalid: item.error,
    uploading: "Uploading…",
    done: "✓ Uploaded",
    failed: item.error ? `Failed: ${item.error}` : "Failed"
  }[item.state];
  item.statusEl.textContent = text;
  item.statusEl.className = `queue-status ${item.state}`;
}

function uploadableItems() {
  return queue.filter(item => item.state === "queued" || item.state === "failed");
}

function updateUploadControls() {
  const count = uploadableItems().length;
  $("upload-submit").disabled = uploading || count === 0;
  if (uploadMode === "playlist") {
    $("upload-submit").textContent = count === 1 ? "Upload playlist (1 song)" : `Upload playlist (${count} songs)`;
  } else {
    $("upload-submit").textContent = count > 1 ? `Upload ${count} songs` : "Upload song";
  }
  $("queue-clear").hidden = uploading || queue.length === 0;
  $("up-audio").disabled = uploading;
  $("up-folder").disabled = uploading;
}

function renderQueue() {
  const box = $("queue");
  const ordered = uploadMode === "playlist";
  box.innerHTML = "";
  box.hidden = queue.length === 0;
  box.classList.toggle("ordered", ordered);

  queue.forEach((item, index) => {
    const row = el("div", "queue-row");

    if (ordered) {
      const order = el("div", "queue-order");
      [["↑", "Move up", -1], ["↓", "Move down", 1]].forEach(([text, label, step]) => {
        const button = el("button", "", text);
        button.type = "button";
        button.title = label;
        button.setAttribute("aria-label", `${label}: ${item.file.name}`);
        button.disabled = uploading || !queue[index + step];
        button.addEventListener("click", () => {
          [queue[index], queue[index + step]] = [queue[index + step], queue[index]];
          renderQueue();
        });
        order.appendChild(button);
      });
      row.appendChild(order);
    }

    const file = el("span", "queue-file", item.file.name);
    file.title = item.file.name;

    const title = el("input");
    title.type = "text";
    title.maxLength = 200;
    title.value = item.title;
    title.placeholder = "Title";
    title.setAttribute("aria-label", `Title for ${item.file.name}`);
    title.addEventListener("input", () => { item.title = title.value; });

    const artist = el("input");
    artist.type = "text";
    artist.maxLength = 200;
    artist.value = item.artist;
    artist.placeholder = $("up-artist").value.trim() || "Artist";
    artist.setAttribute("aria-label", `Artist for ${item.file.name}`);
    artist.addEventListener("input", () => { item.artist = artist.value; });
    item.artistInput = artist;

    const status = el("span");
    item.statusEl = status;
    paintStatus(item);

    const remove = el("button", "btn ghost small", "✕");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${item.file.name}`);
    remove.addEventListener("click", () => {
      queue = queue.filter(entry => entry !== item);
      renderQueue();
    });

    row.append(file, title, artist, status, remove);
    box.appendChild(row);
  });

  updateUploadControls();
}

// Typing a shared artist updates the placeholder on every row that has none of its own.
$("up-artist").addEventListener("input", () => {
  const shared = $("up-artist").value.trim() || "Artist";
  queue.forEach(item => { if (item.artistInput) item.artistInput.placeholder = shared; });
});

$("up-audio").addEventListener("change", async event => {
  const files = Array.from(event.target.files);
  event.target.value = ""; // lets you pick more files, or the same ones again, later
  await addFiles(files);
});

$("up-folder").addEventListener("change", async event => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  // A chosen folder's name is a good starting point for the playlist name.
  const folderName = files.length ? (files[0].webkitRelativePath || "").split("/")[0] : "";
  if (folderName && !$("up-pl-name").value.trim()) $("up-pl-name").value = folderName.slice(0, 100);
  await addFiles(files);
});

$("queue-clear").addEventListener("click", () => {
  queue = [];
  renderQueue();
});

window.addEventListener("beforeunload", event => {
  if (uploading) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Upload one song: files first, then the database row; roll back files if the row fails.
// Each song gets its own copy of the cover, so deleting one song never breaks another.
async function uploadOne(item, shared) {
  const id = crypto.randomUUID();
  const audioPath = `${id}.mp3`;
  const coverFile = shared.coverFile || item.picture;
  const coverPath = coverFile ? `${id}-${stamp()}.${COVER_TYPES[coverFile.type]}` : null;

  const duration = await readDuration(item.file);

  const audioUp = await db.storage.from("audio").upload(audioPath, item.file, { contentType: "audio/mpeg", upsert: false });
  if (audioUp.error) throw audioUp.error;

  if (coverFile) {
    const coverUp = await db.storage.from("covers").upload(coverPath, coverFile, { contentType: coverFile.type, upsert: false });
    if (coverUp.error) {
      await removeFiles("audio", [audioPath]);
      throw coverUp.error;
    }
  }

  const { error } = await db.from("songs").insert({
    id,
    title: item.title.trim(),
    artist: item.artist.trim() || shared.artist,
    album: shared.album || item.album,
    genre: shared.genre || item.genre,
    audio_path: audioPath,
    cover_path: coverPath,
    duration_seconds: duration,
    published: shared.publish
  });
  if (error) {
    await removeFiles("audio", [audioPath]);
    await removeFiles("covers", coverPath ? [coverPath] : []);
    throw error;
  }
  return id;
}

// Finds or creates the playlist for this upload and returns where its new songs start.
async function preparePlaylist(todo, shared) {
  const chosen = $("up-playlist").value;
  if (chosen !== "new") {
    const existing = adminPlaylists.find(playlist => playlist.id === chosen);
    const { data, error } = await db.from("playlist_songs").select("position")
      .eq("playlist_id", chosen).order("position", { ascending: false }).limit(1);
    if (error) throw error;
    return { id: chosen, name: existing ? existing.name : "playlist", created: false, start: data.length ? data[0].position + 1 : 0 };
  }

  const id = crypto.randomUUID();
  const name = $("up-pl-name").value.trim();
  const withArt = todo.find(item => item.picture);
  const coverFile = shared.coverFile || (withArt && withArt.picture);
  const coverPath = coverFile ? await uploadPlaylistCover(id, coverFile) : null;
  const { error } = await db.from("playlists").insert({
    id,
    name,
    description: clean($("up-pl-desc").value),
    cover_path: coverPath,
    is_official: true,
    published: shared.publish
  });
  if (error) {
    if (coverPath) await removeFiles("covers", [coverPath]);
    throw error;
  }
  return { id, name, created: true, start: 0 };
}

$("upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (uploading) return;

  const coverFile = $("up-cover").files[0];
  const coverProblem = coverFile && validateCover(coverFile);
  if (coverProblem) return toast(coverProblem);

  const sharedArtist = $("up-artist").value.trim();
  const todo = uploadableItems();
  if (!todo.length) return toast("Choose at least one valid MP3 file.");

  // Check every song before uploading anything.
  const incomplete = todo.filter(item => !item.title.trim() || !(item.artist.trim() || sharedArtist));
  if (incomplete.length) {
    incomplete.forEach(item => {
      item.state = "failed";
      item.error = item.title.trim() ? "add an artist" : "add a title";
      paintStatus(item);
    });
    return toast("Some songs still need a title or an artist.");
  }

  const asPlaylist = uploadMode === "playlist";
  if (asPlaylist && !playlistsAvailable) return toast("Run supabase/accounts-and-playlists.sql in Supabase first, then refresh.");
  if (asPlaylist && $("up-playlist").value === "new" && !$("up-pl-name").value.trim()) {
    $("up-pl-name").focus();
    return toast("Give the playlist a name.");
  }

  const shared = {
    artist: sharedArtist,
    album: clean($("up-album").value),
    genre: clean($("up-genre").value),
    coverFile,
    publish: $("up-publish").checked
  };

  uploading = true;
  renderQueue();
  const status = $("upload-status");

  let playlist = null;
  if (asPlaylist) {
    try {
      playlist = await preparePlaylist(todo, shared);
    } catch (error) {
      console.error(error);
      uploading = false;
      renderQueue();
      return toast(`Couldn't create the playlist: ${error.message || "please try again."}`);
    }
    // A retry keeps each song's original place, so failures don't jump to the end.
    let nextPosition = playlist.start;
    todo.forEach(item => {
      if (item.playlistId === playlist.id) return;
      item.playlistId = playlist.id;
      item.position = nextPosition++;
    });
  }

  let finished = 0;
  let failures = 0;
  let next = 0;
  status.textContent = `Uploading 0 of ${todo.length}…`;

  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++];
      item.state = "uploading";
      paintStatus(item);
      try {
        // songId survives a failed attempt, so a retry never uploads the same song twice.
        if (!item.songId) item.songId = await uploadOne(item, shared);
        if (playlist) {
          const { error } = await db.from("playlist_songs").upsert(
            { playlist_id: playlist.id, song_id: item.songId, position: item.position },
            { onConflict: "playlist_id,song_id" }
          );
          if (error) throw error;
        }
        item.state = "done";
      } catch (error) {
        console.error(error);
        item.state = "failed";
        item.error = error.message || "please try again";
        failures++;
      }
      paintStatus(item);
      finished++;
      status.textContent = `Uploading ${finished} of ${todo.length}…`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  uploading = false;
  status.textContent = "";
  const succeeded = todo.length - failures;
  queue = queue.filter(item => item.state !== "done");
  if (!failures) $("upload-form").reset();
  renderQueue();

  const where = shared.publish ? "and published" : "as drafts";
  if (failures) {
    toast(`${succeeded} uploaded ${where}, ${failures} failed. Fix the ones marked Failed, then upload again.`);
  } else if (playlist) {
    toast(`${playlist.created ? "Created" : "Updated"} “${playlist.name}” with ${succeeded === 1 ? "1 new song" : `${succeeded} new songs`}.`);
  } else {
    toast(succeeded === 1
      ? `Song uploaded ${where}.`
      : `${succeeded} songs uploaded ${where}.`);
  }
  await Promise.all([loadAdminSongs(), loadAdminPlaylists()]);
  // After a partial failure, a retry adds the remaining songs to this same playlist.
  if (failures && playlist) {
    $("up-playlist").value = playlist.id;
    updatePlaylistFields();
  }
});

/* ---------- Publish / unpublish ---------- */

async function setPublished(song, value, button) {
  button.disabled = true;
  // .select() lets us detect a silently-blocked update (0 rows) as well as errors.
  const { data, error } = await db.from("songs").update({ published: value }).eq("id", song.id).select("id");
  button.disabled = false;
  if (error || !data || !data.length) {
    toast(value ? "Couldn't publish this song." : "Couldn't unpublish this song.");
    return;
  }
  toast(value ? "Published. It's now live for everyone." : "Unpublished. Visitors can no longer see it.");
  await loadAdminSongs();
}

$("publish-all").addEventListener("click", async event => {
  const drafts = adminSongs.filter(song => !song.published).length;
  if (!drafts) return;
  if (!confirm(`Publish ${drafts === 1 ? "this draft" : `all ${drafts} drafts`}? ${drafts === 1 ? "It" : "They"} will be visible to everyone.`)) return;
  const button = event.currentTarget;
  button.disabled = true;
  const { data, error } = await db.from("songs").update({ published: true }).eq("published", false).select("id");
  button.disabled = false;
  if (error || !data) return toast("Couldn't publish the drafts.");
  toast(data.length === 1 ? "Published 1 song." : `Published ${data.length} songs.`);
  await loadAdminSongs();
});

/* ---------- Preview (works for drafts too) ---------- */

async function previewSong(song) {
  const { data, error } = await db.storage.from("audio").createSignedUrl(song.audio_path, 3600);
  if (error || !data) return toast("Couldn't load a preview.");
  $("preview-title").textContent = `Previewing: ${song.title}`;
  $("preview-bar").hidden = false;
  const player = $("preview-audio");
  player.src = data.signedUrl;
  player.play().catch(() => {});
}

function closePreview() {
  const player = $("preview-audio");
  player.pause();
  player.removeAttribute("src");
  $("preview-bar").hidden = true;
}
$("preview-close").addEventListener("click", closePreview);

/* ---------- Edit ---------- */

function openEdit(song) {
  editingSong = song;
  $("ed-title").value = song.title;
  $("ed-artist").value = song.artist;
  $("ed-album").value = song.album || "";
  $("ed-genre").value = song.genre || "";
  $("ed-cover").value = "";
  $("ed-audio").value = "";
  $("ed-remove-cover").checked = false;
  $("ed-remove-cover").disabled = !song.cover_path;
  $("edit-error").textContent = "";
  $("edit-dialog").showModal();
}
$("edit-cancel").addEventListener("click", () => $("edit-dialog").close());

$("edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  const song = editingSong;
  if (!song) return;

  const newCover = $("ed-cover").files[0];
  const newAudio = $("ed-audio").files[0];
  const problem = (newCover && validateCover(newCover)) || (newAudio && validateAudio(newAudio));
  if (problem) {
    $("edit-error").textContent = problem;
    return;
  }

  const submit = $("edit-submit");
  submit.disabled = true;
  $("edit-error").textContent = "";

  const uploaded = []; // [bucket, path] pairs to roll back if the update fails
  const obsolete = []; // [bucket, path] pairs to delete after the update succeeds
  const changes = {
    title: $("ed-title").value.trim(),
    artist: $("ed-artist").value.trim(),
    album: clean($("ed-album").value),
    genre: clean($("ed-genre").value)
  };

  try {
    if (newCover) {
      const path = `${song.id}-${stamp()}.${COVER_TYPES[newCover.type]}`;
      const { error } = await db.storage.from("covers").upload(path, newCover, { contentType: newCover.type, upsert: false });
      if (error) throw error;
      uploaded.push(["covers", path]);
      if (song.cover_path) obsolete.push(["covers", song.cover_path]);
      changes.cover_path = path;
    } else if ($("ed-remove-cover").checked && song.cover_path) {
      obsolete.push(["covers", song.cover_path]);
      changes.cover_path = null;
    }

    if (newAudio) {
      const path = `${song.id}-${stamp()}.mp3`;
      const { error } = await db.storage.from("audio").upload(path, newAudio, { contentType: "audio/mpeg", upsert: false });
      if (error) throw error;
      uploaded.push(["audio", path]);
      obsolete.push(["audio", song.audio_path]);
      changes.audio_path = path;
      changes.duration_seconds = await readDuration(newAudio);
    }

    const { data, error } = await db.from("songs").update(changes).eq("id", song.id).select("id");
    if (error || !data || !data.length) throw error || new Error("Update was not allowed.");

    await Promise.all(obsolete.map(([bucket, path]) => removeFiles(bucket, [path])));
    $("edit-dialog").close();
    toast("Changes saved.");
    await loadAdminSongs();
  } catch (error) {
    console.error(error);
    await Promise.all(uploaded.map(([bucket, path]) => removeFiles(bucket, [path])));
    $("edit-error").textContent = `Couldn't save changes: ${error.message || "please try again."}`;
  } finally {
    submit.disabled = false;
  }
});

/* ---------- Delete ---------- */

async function deleteSong(song, button) {
  if (!confirm(`Delete "${song.title}" permanently?\n\nThis removes the song and its files and can't be undone.`)) return;
  button.disabled = true;
  // Delete the row first so the song disappears for visitors immediately.
  const { data, error } = await db.from("songs").delete().eq("id", song.id).select("id");
  if (error || !data || !data.length) {
    button.disabled = false;
    toast("Couldn't delete this song.");
    return;
  }
  const results = await Promise.all([
    removeFiles("audio", [song.audio_path]),
    removeFiles("covers", song.cover_path ? [song.cover_path] : [])
  ]);
  const leftovers = results.some(result => result && result.error);
  toast(leftovers ? "Song deleted, but some files couldn't be removed from storage." : "Song deleted.");
  await Promise.all([loadAdminSongs(), loadAdminPlaylists()]);
}

/* ---------- Start up ---------- */

async function boot() {
  setUploadMode("songs");
  if (!db) {
    showLogin("Backend not configured. Add your Supabase URL and anon key to config.js.");
    $("login-submit").disabled = true;
    return;
  }
  // Only react to sign-out here; never await Supabase calls inside this callback.
  db.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") showLogin();
  });
  const { data } = await db.auth.getSession();
  if (data.session) await enterIfAdmin(data.session.user);
  else showLogin();
}
boot();

// The browser's Back and Forward buttons can restore a frozen copy of this page from
// before a log out, without running any code. Hide the dashboard on the way out, then
// check who is really logged in before showing it again.
window.addEventListener("pagehide", event => {
  if (event.persisted) $("dashboard").hidden = true;
});
window.addEventListener("pageshow", async event => {
  if (!event.persisted || !db) return;
  const { data } = await db.auth.getSession();
  if (data.session) await enterIfAdmin(data.session.user);
  else showLogin();
});
// Coming back to this tab after logging out in another one locks the dashboard too.
document.addEventListener("visibilitychange", async () => {
  if (document.hidden || !db || $("dashboard").hidden) return;
  const { data } = await db.auth.getSession();
  if (!data.session) showLogin();
});
