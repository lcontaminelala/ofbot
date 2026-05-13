require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");
const axios = require("axios");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID      = process.env.DISCORD_CHANNEL_ID;

const SEARCH_QUERIES = [
  "openfront.io",
  "openfront io gameplay",
  "openfront io tuto",
  "openfront io live",
  "openfront jeu",
];

const MIN_VIEWS       = 500;    // vues minimum
const MIN_SUBSCRIBERS = 10000;  // OU abonnés minimum (chaîne connue)
const VIDEOS_PER_DAY  = 5;
const INTERVAL_HOURS  = Math.floor(24 / VIDEOS_PER_DAY);

// ─── État interne ──────────────────────────────────────────────────────────────
const postedVideoIds = new Set();
let videoQueue    = [];
let postsToday    = 0;
let lastResetDate = new Date().toDateString();

// ─── Client Discord ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log(`📺 Salon cible  : ${CHANNEL_ID}`);
  console.log(`⏰ Intervalle   : toutes les ${INTERVAL_HOURS}h (${VIDEOS_PER_DAY}/jour)`);

  fetchAndQueueVideos();

  // Refresh de la file toutes les 12h
  cron.schedule("0 */12 * * *", () => {
    console.log("🔄 Rafraîchissement de la file de vidéos...");
    fetchAndQueueVideos();
  });

  // Post toutes les INTERVAL_HOURS heures
  cron.schedule(`0 */${INTERVAL_HOURS} * * *`, () => {
    resetDailyCounterIfNeeded();
    if (postsToday < VIDEOS_PER_DAY) {
      postNextVideo();
    } else {
      console.log(`⏸️  Limite journalière atteinte (${VIDEOS_PER_DAY}). Reprise demain.`);
    }
  });

  // Post immédiat 30s après démarrage
  setTimeout(() => {
    resetDailyCounterIfNeeded();
    postNextVideo();
  }, 30_000);
});

// ─── Fonctions ─────────────────────────────────────────────────────────────────

function resetDailyCounterIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    postsToday = 0;
    lastResetDate = today;
    console.log("🗓️  Nouveau jour — compteur réinitialisé.");
  }
}

/**
 * Parse une durée ISO 8601 (PT4M13S) en secondes.
 */
function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

/**
 * Récupère le nombre d'abonnés d'une chaîne via son channelId.
 */
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

async function fetchAndQueueVideos() {
  // Dernière semaine
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fetched = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          key:               YOUTUBE_API_KEY,
          q:                 query,
          part:              "snippet",
          type:              "video",
          order:             "viewCount",
          publishedAfter:    lastWeek,
          relevanceLanguage: "fr",
          videoDuration:     "medium", // exclut les Shorts (< 4 min) et > 20 min
          maxResults:        15,
        },
      });

      const ids = res.data.items
        .map((i) => i.id.videoId)
        .filter((id) => id && !postedVideoIds.has(id))
        .join(",");

      if (!ids) continue;

      // Détails : snippet + statistics + contentDetails (pour la durée)
      const details = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: { key: YOUTUBE_API_KEY, id: ids, part: "snippet,statistics,contentDetails" },
      });

      for (const item of details.data.items) {
        const id          = item.id;
        const title       = item.snippet.title;
        const description = item.snippet.description || "";
        const views       = parseInt(item.statistics.viewCount || "0", 10);
        const lang        = item.snippet.defaultAudioLanguage || item.snippet.defaultLanguage || "";
        const duration    = parseDuration(item.contentDetails.duration || "");
        const channelId   = item.snippet.channelId;

        if (postedVideoIds.has(id)) continue;

        // Filtre 1 : "openfront" dans le TITRE ou la DESCRIPTION
        const text = (title + " " + description).toLowerCase();
        if (!text.includes("openfront")) continue;

        // Filtre 2 : langue française ou non définie
        if (lang && !lang.startsWith("fr")) continue;

        // Filtre 3 : pas un Short, minimum 2 minutes
        if (duration < 120) continue;

        // Filtre 4 : 500+ vues OU chaîne avec 10 000+ abonnés
        let pass = views >= MIN_VIEWS;
        if (!pass) {
          const subs = await getSubscriberCount(channelId);
          pass = subs >= MIN_SUBSCRIBERS;
          if (pass) console.log(`✅ Chaîne connue (${subs} abonnés) : ${item.snippet.channelTitle}`);
        }
        if (!pass) continue;

        fetched.push({
          id,
          title,
          channel:     item.snippet.channelTitle,
          thumbnail:   item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
          publishedAt: item.snippet.publishedAt,
          views,
          duration,
          url:         `https://www.youtube.com/watch?v=${id}`,
        });
      }
    } catch (err) {
      console.error(`❌ Erreur fetch (query: "${query}") :`, err.response?.data || err.message);
    }
  }

  const seen = new Set(videoQueue.map((v) => v.id));
  const newVideos = fetched
    .filter((v) => !seen.has(v.id))
    .sort((a, b) => b.views - a.views); // les plus vues en tête de file

  videoQueue.push(...newVideos);
  console.log(`📥 ${newVideos.length} nouvelles vidéos ajoutées (total : ${videoQueue.length})`);
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function postNextVideo() {
  if (videoQueue.length === 0) {
    console.log("⚠️  File vide — refetch...");
    await fetchAndQueueVideos();
  }

  if (videoQueue.length === 0) {
    console.log("😶 Aucune vidéo disponible.");
    return;
  }

  const video = videoQueue.shift();
  postedVideoIds.add(video.id);

  const channel = await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!channel) {
    console.error("❌ Salon introuvable. Vérifie DISCORD_CHANNEL_ID.");
    return;
  }

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
  console.log(`✅ Postée (${postsToday}/${VIDEOS_PER_DAY}) : ${video.title} — ${video.views} vues`);
}

// ─── Lancement ─────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);

