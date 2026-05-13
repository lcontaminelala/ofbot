require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");
const axios = require("axios");

// ─── Config ───────────────────────────────────────────────────────────────────
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;
const YOUTUBE_API_KEY  = process.env.YOUTUBE_API_KEY;
const CHANNEL_ID       = process.env.DISCORD_CHANNEL_ID;

// Mots-clés de recherche YouTube (tous FR + openfront)
const SEARCH_QUERIES = [
  "openfront.io",
  "openfront io gameplay",
  "openfront io tuto",
  "openfront io live",
];

// Vues minimum pour qu'une vidéo soit postée
const MIN_VIEWS = 500;

// Nombre max de vidéos postées par jour
const VIDEOS_PER_DAY = 5;
// Intervalle entre chaque post (en heures) — 24h / 5 = ~4h48 → on arrondit à 5h
const INTERVAL_HOURS = Math.floor(24 / VIDEOS_PER_DAY);

// ─── État interne ──────────────────────────────────────────────────────────────
// Stocke les IDs déjà postés (évite les doublons sur la durée de vie du process)
const postedVideoIds = new Set();
// File d'attente des vidéos récupérées
let videoQueue = [];
// Compteur de posts aujourd'hui
let postsToday = 0;
// Reset du compteur à minuit
let lastResetDate = new Date().toDateString();

// ─── Client Discord ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
  console.log(`✅ Bot connecté : ${client.user.tag}`);
  console.log(`📺 Salon cible  : ${CHANNEL_ID}`);
  console.log(`⏰ Intervalle   : toutes les ${INTERVAL_HOURS}h (${VIDEOS_PER_DAY}/jour)`);

  // 1er fetch immédiat au démarrage
  fetchAndQueueVideos();

  // Fetch de nouvelles vidéos toutes les 6h pour alimenter la file
  cron.schedule("0 */6 * * *", () => {
    console.log("🔄 Rafraîchissement de la file de vidéos...");
    fetchAndQueueVideos();
  });

  // Post d'une vidéo toutes les INTERVAL_HOURS heures
  const cronExpression = `0 */${INTERVAL_HOURS} * * *`;
  cron.schedule(cronExpression, () => {
    resetDailyCounterIfNeeded();
    if (postsToday < VIDEOS_PER_DAY) {
      postNextVideo();
    } else {
      console.log(`⏸️  Limite journalière atteinte (${VIDEOS_PER_DAY} vidéos). Reprise demain.`);
    }
  });

  // Post immédiat 30s après le démarrage (laisse le temps au fetch)
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
 * Interroge l'API YouTube pour chaque requête et remplit videoQueue
 * en filtrant : langue FR, moins de 24h, pas déjà postés.
 */
async function fetchAndQueueVideos() {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const fetched = [];

  for (const query of SEARCH_QUERIES) {
    try {
      const res = await axios.get("https://www.googleapis.com/youtube/v3/search", {
        params: {
          key:              YOUTUBE_API_KEY,
          q:                query,
          part:             "snippet",
          type:             "video",
          order:            "viewCount",       // les plus vues en premier
          publishedAfter:   yesterday,
          relevanceLanguage: "fr",
          maxResults:       10,
        },
      });

      // Récupère les IDs valides non encore postés
      const ids = res.data.items
        .map((i) => i.id.videoId)
        .filter((id) => id && !postedVideoIds.has(id))
        .join(",");

      if (!ids) continue;

      // 2e appel pour avoir les stats (vues) et la langue
      const details = await axios.get("https://www.googleapis.com/youtube/v3/videos", {
        params: { key: YOUTUBE_API_KEY, id: ids, part: "snippet,statistics" },
      });

      for (const item of details.data.items) {
        const id    = item.id;
        const title = item.snippet.title;
        const views = parseInt(item.statistics.viewCount || "0", 10);
        const lang  = item.snippet.defaultAudioLanguage || item.snippet.defaultLanguage || "";

        // Filtre 1 : "openfront" doit être dans le TITRE
        if (!title.toLowerCase().includes("openfront")) continue;
        // Filtre 2 : minimum de vues
        if (views < MIN_VIEWS) continue;
        // Filtre 3 : langue française ou non définie
        if (lang && !lang.startsWith("fr")) continue;

        if (postedVideoIds.has(id)) continue;

        fetched.push({
          id,
          title,
          channel:     item.snippet.channelTitle,
          thumbnail:   item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
          publishedAt: item.snippet.publishedAt,
          views,
          url:         `https://www.youtube.com/watch?v=${id}`,
        });
      }
    } catch (err) {
      console.error(`❌ Erreur fetch YouTube (query: "${query}") :`, err.response?.data || err.message);
    }
  }

  // Déduplique et trie par date (plus récente en premier)
  const seen = new Set(videoQueue.map((v) => v.id));
  const newVideos = fetched
    .filter((v) => !seen.has(v.id))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  videoQueue.push(...newVideos);
  console.log(`📥 ${newVideos.length} nouvelles vidéos ajoutées à la file (total : ${videoQueue.length})`);
}

/**
 * Prend la prochaine vidéo de la file et la poste dans le salon Discord.
 */
async function postNextVideo() {
  if (videoQueue.length === 0) {
    console.log("⚠️  File vide — on refetch...");
    await fetchAndQueueVideos();
  }

  if (videoQueue.length === 0) {
    console.log("😶 Aucune vidéo disponible pour l'instant.");
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
    .setDescription(`📺 **${video.channel}**\n👁️ ${video.views.toLocaleString("fr-FR")} vues`)
    .setImage(video.thumbnail)
    .setFooter({ text: "Openfront.io • Vidéo FR" })
    .setTimestamp(new Date(video.publishedAt));

  await channel.send({ embeds: [embed] });
  postsToday++;
  console.log(`✅ Vidéo postée (${postsToday}/${VIDEOS_PER_DAY} aujourd'hui) : ${video.title}`);
}

// ─── Lancement ─────────────────────────────────────────────────────────────────
client.login(DISCORD_TOKEN);

