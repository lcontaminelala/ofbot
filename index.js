require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron   = require("node-cron");
const axios  = require("axios");
const redis  = require("redis");

const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.on("error", (err) => console.error("❌ Redis error:", err));
redisClient.connect().then(() => console.log("✅ Redis connecté."));

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID      = process.env.DISCORD_CHANNEL_ID;
const OWNER_ID        = "1258841903575597117";

const SEARCH_QUERIES = [
  "openfront",
  "openfront.io",
  "openfront io gameplay",
  "openfront io tuto",
  "openfront io live",
  "openfront io fr",
  "openfront stratégie",
  "openfront jeu",
];

const TITLE_BLACKLIST = [
  "no commentary", "no comment", "sans commentaire", "muted", "silent", "music only",
];

const MIN_VIEWS       = 500;
const MIN_SUBSCRIBERS = 10_000;
const VIDEOS_PER_DAY  = 5;
const INTERVAL_HOURS  = Math.floor(24 / VIDEOS_PER_DAY);

const REDIS_POSTED_KEY = "openfront:posted_ids";
const REDIS_QUEUE_KEY  = "openfront:video_queue";

// ─── État interne ──────────────────────────────────────────────────────────────
async function loadPostedIds() {
  try {
    const data = await redisClient.get(REDIS_POSTED_KEY);
    const ids = data ? JSON.parse(data) : [];
    console.log(`📂 ${ids.length} vidéos déjà postées chargées depuis Redis.`);
    return new Set(ids);
  } catch { return new Set(); }
}

async function savePostedIds(set) {
  try { await redisClient.set(REDIS_POSTED_KEY, JSON.stringify([...set])); } catch {}
}

async function loadQueue() {
  try {
    const data = await redisClient.get(REDIS_QUEUE_KEY);
    const q = data ? JSON.parse(data) : [];
    console.log(`📂 ${q.length} vidéos en file chargées depuis Redis.`);
    return q;
  } catch { return []; }
}

async function saveQueue() {
  try { await redisClient.set(REDIS_QUEUE_KEY, JSON.stringify(videoQueue)); } catch {}
}

let postedVideoIds = new Set();
let videoQueue     = [];
let postsToday     = 0;
let lastResetDate  = new Date().toDateString();

// ─── Client Discord ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  postedVideoIds = await loadPostedIds();
  videoQueue     = await loadQueue();
  if (videoQueue.length === 0) fetchAndQueueVideos();
  else console.log(`✅ File déjà chargée (${videoQueue.length} vidéos), pas de fetch API.`);

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
  } catch { return 0; }
}

// ─── Détection langue ─────────────────────────────────────────────────────────
const FOREIGN_WORDS = [
  " the ", " is ", " my ", " how ", " best ", " with ", " this ", " new ",
  " you ", " are ", " was ", " for ", " but ", " and ", " from ", " can ",
  " win ", " got ", " just ", " all ", " its ", " will ", " your ", " everything ",
  "let's", "i played", "i tried", "i built", "i fought", "i survived",
  " ich ", " die ", " der ", " das ", " und ", " mit ", " von ", " auf ",
  " ein ", " ist ", " hab ", " mein ", " beim ", " trying ", " out ",
  " con ", " del ", " los ", " las ", " una ", " todo ", " este ", " esta ",
];

function looksNonFrench(title) {
  const t = " " + title.toLowerCase() + " ";
  if (/[\u3000-\u9fff\u0400-\u04ff]/.test(title)) return true;
  return FOREIGN_WORDS.some((w) => t.includes(w));
}

// ─── Fetch ────────────────────────────────────────────────────────────────────
async function fetchAndQueueVideos() {
  const fetched     = [];
  const seenInFetch = new Set();

  for (const query of SEARCH_QUERIES) {
    try {
      console.log(`🔍 Recherche : "${query}"`);
      const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          key: YOUTUBE_API_KEY, q: query, part: "snippet",
          type: "video", order: "viewCount", videoDuration: "medium", maxResults: 15,
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
        const views       = parseInt(item.statistics.viewCount || "0", 10);
        const duration    = parseDuration(item.contentDetails?.duration);
        const channelId   = item.snippet.channelId;

        if (!(title + " " + description).toLowerCase().includes("openfront")) {
          console.log(`  ✗ [openfront absent] ${title}`); continue;
        }
        if (!isTitleOk(title)) {
          console.log(`  ✗ [blacklist titre] ${title}`); continue;
        }
        if (duration < 120) {
          console.log(`  ✗ [trop court: ${duration}s] ${title}`); continue;
        }

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
  const newVideos   = fetched.filter((v) => !existingIds.has(v.id)).sort((a, b) => b.views - a.views);
  videoQueue.push(...newVideos);
  saveQueue();
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
  saveQueue();

  if (postedVideoIds.has(video.id)) {
    console.log(`⏭️  Déjà postée, on passe : ${video.title}`);
    return postNextVideo();
  }

  if (looksNonFrench(video.title)) {
    console.log(`⏭️  Titre non-FR détecté, on passe : ${video.title}`);
    postedVideoIds.add(video.id);
    savePostedIds(postedVideoIds);
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
    .setDescription(`📺 **${video.channel}**\n👁️ ${video.views.toLocaleString("fr-FR")} vues  •  ⏱️ ${formatDuration(video.duration)}`)
    .setImage(video.thumbnail)
    .setFooter({ text: "Openfront.io • Vidéo FR" })
    .setTimestamp(new Date(video.publishedAt));

  await channel.send({ embeds: [embed] });
  postsToday++;
  console.log(`✅ Postée (${postsToday}/${VIDEOS_PER_DAY}) : ${video.title}`);
}

// ─── Commande !poste ──────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.author.id !== OWNER_ID) return;
  if (message.content.trim() !== "!poste") return;

  await message.reply("📤 Recherche d'une vidéo...");
  resetDailyCounterIfNeeded();
  postsToday = Math.max(0, postsToday - 1);
  await postNextVideo();
});

// ─── Lancement ────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);
