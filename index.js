require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron  = require("node-cron");
const axios = require("axios");
const fs    = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID      = process.env.DISCORD_CHANNEL_ID;

const SEARCH_QUERIES = [
  "openfront.io gameplay fr",
  "openfront io fr",
  "openfront io tuto français",
  "openfront io live français",
  "openfront jeu français",
];

// Mots-clés interdits dans le titre
const TITLE_BLACKLIST = [
  "no commentary",
  "no comment",
  "sans commentaire",
  "muted",
  "silent",
  "music only",
];

const MIN_VIEWS       = 500;
const MIN_SUBSCRIBERS = 10_000;
const VIDEOS_PER_DAY  = 5;
const INTERVAL_HOURS  = Math.floor(24 / VIDEOS_PER_DAY);

// Fichier pour persister les IDs déjà postés entre les redémarrages
const POSTED_IDS_FILE = "./posted_ids.json";

// ─── État interne ──────────────────────────────────────────────────────────────
function loadPostedIds() {
  try {
    if (fs.existsSync(POSTED_IDS_FILE)) {
      const data = JSON.parse(fs.readFileSync(POSTED_IDS_FILE, "utf8"));
      return new Set(data);
    }
  } catch {}
  return new Set();
}

function savePostedIds(set) {
  try {
    fs.writeFileSync(POSTED_IDS_FILE, JSON.stringify([...set]));
  } catch (e) {
    console.error("❌ Impossible de sauvegarder posted_ids :", e.message);
  }
}

const postedVideoIds = loadPostedIds();
console.log(`📂 ${postedVideoIds.size} vidéos déjà postées chargées.`);

let videoQueue    = [];
let postsToday    = 0;
let lastResetDate = new Date().toDateString();

// ─── Client Discord ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  fetchAndQueueVideos();

  cron.schedule("0 */12 * * *", () => {
    console.log("🔄 Refresh de la file...");
    fetchAndQueueVideos();
  });

  cron.schedule(`0 */${INTERVAL_HOURS} * * *`, () => {
    resetDailyCounterIfNeeded();
    if (postsToday < VIDEOS_PER_DAY) postNextVideo();
    else console.log(`⏸️  Limite journalière atteinte.`);
  });

  setTimeout(() => {
    resetDailyCounterIfNeeded();
    postNextVideo();
  }, 30_000);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resetDailyCounterIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    postsToday = 0;
    lastResetDate = today;
    console.log("🗓️  Nouveau jour — compteur réinitialisé.");
  }
}

function parseDuration(iso) {
  const m = (iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isTitleOk(title) {
  const lower = title.toLowerCase();
  return !TITLE_BLACKLIST.some((kw) => lower.includes(kw));
}

async function getSubscriberCount(channelId) {
  try {
    const res = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: { key: YOUTUBE_API_KEY, id: channelId, part: "statistics" },
    });
    return parseInt(res.data.items?.[0]?.statistics?.subscriberCount || "0", 10);
  } catch {
    return 0;
  }
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAndQueueVideos() {
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fetched  = [];
  const seenInFetch = new Set(); // évite les doublons entre requêtes

  for (const query of SEARCH_QUERIES) {
    try {
      console.log(`🔍 Recherche : "${query}"`);
      const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          key:               YOUTUBE_API_KEY,
          q:                 query,
          part:              "snippet",
          type:              "video",
          order:             "viewCount",
          publishedAfter:    lastWeek,
          relevanceLanguage: "fr",
          videoDuration:     "medium",
          maxResults:        15,
        },
      });

      const ids = res.data.items
        .map((i) => i.id.videoId)
        .filter((id) => id && !postedVideoIds.has(id) && !seenInFetch.has(id));

      if (!ids.length) { console.log("  → Aucun ID nouveau."); continue; }
      ids.forEach((id) => seenInFetch.add(id));

      const details = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: { key: YOUTUBE_API_KEY, id: ids.join(","), part: "snippet,statistics,contentDetails" },
      });

      for (const item of details.data.items) {
        const id          = item.id;
        const title       = item.snippet.title;
        const description = item.snippet.description || "";
        const views       = parseInt(item.statistics.viewCount  || "0", 10);
        const lang        = item.snippet.defaultAudioLanguage || item.snippet.defaultLanguage || "";
        const duration    = parseDuration(item.contentDetails?.duration);
        const channelId   = item.snippet.channelId;

        // ── Filtres ──────────────────────────────────────────────────────────

        // 1. "openfront" dans le titre ou la description
        if (!(title + " " + description).toLowerCase().includes("openfront")) {
          console.log(`  ✗ [openfront absent] ${title}`); continue;
        }

        // 2. Titre sans mots interdits (no commentary, etc.)
        if (!isTitleOk(title)) {
          console.log(`  ✗ [blacklist titre] ${title}`); continue;
        }

        // 3. Langue FR — rejette si langue définie non-FR
        if (lang && !lang.startsWith("fr")) {
          console.log(`  ✗ [langue: ${lang}] ${title}`); continue;
        }
        // 3b. Si langue non renseignée, détection anglais par le titre
        const ENGLISH_KW = [
          " the ", " is ", " my ", " how ", " best ", " with ", " this ",
          " new ", " you ", " are ", " was ", " for ", " but ", " and ",
          "let's play", "let me", "i played", "i tried", "i built",
        ];
        if (!lang && ENGLISH_KW.some((kw) => title.toLowerCase().includes(kw))) {
          console.log(`  ✗ [titre anglais] ${title}`); continue;
        }

        // 4. Minimum 2 minutes (élimine les Shorts et les non-parlants courts)
        if (duration < 120) {
          console.log(`  ✗ [trop court: ${duration}s] ${title}`); continue;
        }

        // 5. 500+ vues OU 10 000+ abonnés
        let pass = views >= MIN_VIEWS;
        if (!pass) {
          const subs = await getSubscriberCount(channelId);
          console.log(`  ℹ️  ${title} → ${views} vues, ${subs} abonnés`);
          pass = subs >= MIN_SUBSCRIBERS;
        }
        if (!pass) {
          console.log(`  ✗ [pas assez populaire] ${title} (${views} vues)`); continue;
        }

        console.log(`  ✅ Acceptée : ${title} (${views} vues)`);
        fetched.push({
          id, title,
          channel:     item.snippet.channelTitle,
          thumbnail:   item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
          publishedAt: item.snippet.publishedAt,
          views, duration,
          url: `https://www.youtube.com/watch?v=${id}`,
        });
      }
    } catch (err) {
      console.error(`❌ Erreur fetch "${query}" :`, err.response?.data || err.message);
    }
  }

  const existingIds = new Set(videoQueue.map((v) => v.id));
  const newVideos   = fetched
    .filter((v) => !existingIds.has(v.id))
    .sort((a, b) => b.views - a.views);

  videoQueue.push(...newVideos);
  console.log(`📥 ${newVideos.length} nouvelles vidéos en file (total : ${videoQueue.length})`);
}

// ─── Post ─────────────────────────────────────────────────────────────────────

async function postNextVideo() {
  if (!videoQueue.length) {
    console.log("⚠️  File vide — refetch...");
    await fetchAndQueueVideos();
  }
  if (!videoQueue.length) {
    console.log("😶 Aucune vidéo disponible après refetch.");
    return;
  }

  const video = videoQueue.shift();

  // Sécurité : ne jamais poster deux fois le même ID
  if (postedVideoIds.has(video.id)) {
    console.log(`⏭️  Déjà postée, on passe : ${video.title}`);
    return postNextVideo();
  }

  postedVideoIds.add(video.id);
  savePostedIds(postedVideoIds);

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) { console.error("❌ Salon introuvable."); return; }

  const embed = new EmbedBuilder()
    .setColor(0x1a73e8)
    .setTitle(video.title)
    .setURL(video.url)
    .setDescription(
      `📺 **${video.channel}**\n` +
      `👁️ ${video.views.toLocaleString("fr-FR")} vues  •  ⏱️ ${formatDuration(video.duration)}`
    )
    .setImage(video.thumbnail)
    .setFooter({ text: "Openfront.io • Vidéo FR" })
    .setTimestamp(new Date(video.publishedAt));

  await channel.send({ embeds: [embed] });
  postsToday++;
  console.log(`✅ Postée (${postsToday}/${VIDEOS_PER_DAY}) : ${video.title}`);
}

// ─── Lancement ────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);

